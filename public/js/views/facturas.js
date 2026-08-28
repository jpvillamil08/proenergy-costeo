import { api } from '../api.js';
import { money, num, fmtDMY, esc, todayInputVal } from '../format.js';
import { lineChart, horizontalBarChart, PALETTE } from '../charts.js';
import { stillMounted } from '../guard.js';

// Rango por defecto: ultimo año.
function haceUnAnio() {
  const n = new Date();
  n.setFullYear(n.getFullYear() - 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

const filtros = { desde: haceUnAnio(), hasta: todayInputVal() };

export async function renderFacturas(content, state) {
  content.innerHTML = '<div class="spinner-msg">Cargando facturas…</div>';
  const isAdmin = state.usuario.rol === 'admin';
  const [estadoFacturas, facturas, listaFacturas] = await Promise.all([
    isAdmin ? api.get('/api/facturas/estado') : Promise.resolve({ configurada: true }),
    api.get(`/api/facturas/estadisticas?desde=${filtros.desde}&hasta=${filtros.hasta}`).catch(() => null),
    api.get(`/api/facturas?desde=${filtros.desde}&hasta=${filtros.hasta}`).catch(() => null),
  ]);
  if (!stillMounted(content)) return;
  paint(content, state, { estadoFacturas, facturas, listaFacturas });
}

function paint(content, state, data) {
  const isAdmin = state.usuario.rol === 'admin';
  const { estadoFacturas, facturas, listaFacturas } = data;

  content.innerHTML = `
    <div class="toolbar">
      <h1 class="mt-0">Facturas</h1>
      ${isAdmin ? `<div class="btn-row"><button class="btn btn-secondary btn-sm" id="btn-sincronizar-facturas">Sincronizar con Siigo</button></div>` : ''}
    </div>
    <div class="card">
      <div class="filters" id="filtros-facturas">
        <div class="field"><label>Desde</label><input type="date" id="f-desde" value="${filtros.desde}"></div>
        <div class="field"><label>Hasta</label><input type="date" id="f-hasta" value="${filtros.hasta}"></div>
      </div>
    </div>
    <div id="bloque-facturas"></div>
  `;

  document.getElementById('f-desde').addEventListener('change', (e) => { filtros.desde = e.target.value; renderFacturas(content, state); });
  document.getElementById('f-hasta').addEventListener('change', (e) => { filtros.hasta = e.target.value; renderFacturas(content, state); });

  paintFacturas(document.getElementById('bloque-facturas'), estadoFacturas, facturas, listaFacturas, isAdmin);

  if (isAdmin) {
    const btn = document.getElementById('btn-sincronizar-facturas');
    if (btn) {
      btn.addEventListener('click', async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Sincronizando…';
        try {
          const r = await api.post(`/api/facturas/sincronizar?desde=${filtros.desde}&hasta=${filtros.hasta}`);
          alert(`Listo: ${r.totalSincronizadas} factura(s) sincronizada(s) desde Siigo.`);
          renderFacturas(content, state);
        } catch (err) {
          e.target.disabled = false;
          e.target.textContent = 'Sincronizar con Siigo';
          alert('No se pudo sincronizar: ' + err.message);
        }
      });
    }
  }
}

function paintFacturas(el, estadoFacturas, facturas, listaFacturas, isAdmin) {
  if (isAdmin && estadoFacturas && !estadoFacturas.configurada) {
    el.innerHTML = `<div class="card"><div class="empty-state">La conexión con Siigo todavía no está configurada. En Railway, pestaña <strong>Variables</strong> del servicio, agrega SIIGO_USERNAME, SIIGO_ACCESS_KEY y SIIGO_PARTNER_ID.</div></div>`;
    return;
  }
  if (!facturas) {
    el.innerHTML = `<div class="card"><div class="empty-state">No se pudieron cargar las facturas.</div></div>`;
    return;
  }
  if (!facturas.cantidad) {
    el.innerHTML = `<div class="card"><div class="empty-state">Sin facturas sincronizadas en este rango de fechas todavía.${isAdmin ? ' Usa "Sincronizar con Siigo" arriba.' : ''}</div></div>`;
    return;
  }
  el.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="label">Total facturado</div><div class="value">${money(facturas.totalFacturado)}</div></div>
      <div class="kpi"><div class="label">Saldo pendiente</div><div class="value">${money(facturas.totalSaldo)}</div></div>
      <div class="kpi"><div class="label">Facturas (vigentes)</div><div class="value">${num(facturas.cantidad, 0)}</div></div>
      <div class="kpi"><div class="label">Facturas anuladas</div><div class="value">${num(facturas.cantidadAnuladas, 0)}</div></div>
    </div>
    <div class="grid-2">
      <div class="card"><div class="chart-title">Facturación mensual</div><div id="chart-facturas-mes"></div></div>
      <div class="card"><div class="chart-title">Top 10 clientes facturados</div><div id="chart-facturas-clientes"></div></div>
    </div>
    ${facturas.ultimaSincronizacion ? `<div class="field-help">Última sincronización: ${esc(facturas.ultimaSincronizacion)}</div>` : ''}
    <div class="section-title"><h2>Detalle de facturas</h2></div>
    ${paintTablaFacturas(listaFacturas)}
  `;
  lineChart(document.getElementById('chart-facturas-mes'), {
    categories: facturas.porMes.map((m) => m.mes),
    series: [{ name: 'Facturado', color: PALETTE[0], data: facturas.porMes.map((m) => m.total) }],
  });
  horizontalBarChart(document.getElementById('chart-facturas-clientes'), {
    data: facturas.topClientes.map((c) => ({ label: c.cliente, value: c.total })),
    color: PALETTE[2],
  });
}

function paintTablaFacturas(listaFacturas) {
  if (!listaFacturas || !listaFacturas.length) {
    return `<div class="card"><div class="empty-state">Sin facturas para listar en este rango de fechas.</div></div>`;
  }
  const badge = (estado) => {
    const cls = estado === 'Pagada' ? 'PAGADO' : estado === 'Anulada' ? 'VENCIDO' : 'Abonado';
    return `<span class="pago-badge pago-${cls}">${esc(estado)}</span>`;
  };
  return `
    <div class="table-wrap"><table>
      <thead><tr><th>Número</th><th>Cliente</th><th>Fecha</th><th class="num">Total</th><th class="num">Saldo</th><th>Estado</th></tr></thead>
      <tbody>${listaFacturas.map((f) => `<tr>
        <td>${esc(f.numero || '')}</td>
        <td>${esc(f.cliente || '')}</td>
        <td>${fmtDMY(f.fecha)}</td>
        <td class="num">${money(f.total)}</td>
        <td class="num">${money(f.saldo)}</td>
        <td>${badge(f.estado)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  `;
}
