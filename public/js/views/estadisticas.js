import { api } from '../api.js';
import { money, pct, num, fmtDMY, esc, todayInputVal } from '../format.js';
import { lineChart, horizontalBarChart, groupedBarChart, PALETTE } from '../charts.js';
import { stillMounted } from '../guard.js';

// Rango por defecto: ultimo año.
function haceUnAnio() {
  const n = new Date();
  n.setFullYear(n.getFullYear() - 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

const filtros = { desde: haceUnAnio(), hasta: todayInputVal() };

export async function renderEstadisticas(content, state) {
  content.innerHTML = '<div class="spinner-msg">Cargando estadísticas…</div>';
  const [estadoFacturas, facturas, cotizaciones] = await Promise.all([
    state.usuario.rol === 'admin' ? api.get('/api/facturas/estado') : Promise.resolve({ configurada: true }),
    api.get(`/api/facturas/estadisticas?desde=${filtros.desde}&hasta=${filtros.hasta}`).catch(() => null),
    api.get(`/api/cotizaciones/estadisticas?desde=${filtros.desde}&hasta=${filtros.hasta}`),
  ]);
  if (!stillMounted(content)) return;
  paint(content, state, { estadoFacturas, facturas, cotizaciones });
}

function paint(content, state, data) {
  const isAdmin = state.usuario.rol === 'admin';
  const { estadoFacturas, facturas, cotizaciones } = data;

  content.innerHTML = `
    <div class="toolbar"><h1 class="mt-0">Estadísticas</h1></div>
    <div class="card">
      <div class="filters" id="filtros-globales">
        <div class="field"><label>Desde</label><input type="date" id="f-desde" value="${filtros.desde}"></div>
        <div class="field"><label>Hasta</label><input type="date" id="f-hasta" value="${filtros.hasta}"></div>
      </div>
    </div>

    <div class="section-title"><h2>Facturación</h2>
      ${isAdmin ? `<div class="btn-row"><button class="btn btn-secondary btn-sm" id="btn-sincronizar-facturas">Sincronizar con Siigo</button></div>` : ''}
    </div>
    <div id="bloque-facturas"></div>

    <div class="section-title"><h2>Cotizaciones: creadas vs. aprobadas</h2></div>
    <div id="bloque-cotizaciones"></div>
  `;

  document.getElementById('f-desde').addEventListener('change', (e) => { filtros.desde = e.target.value; renderEstadisticas(content, state); });
  document.getElementById('f-hasta').addEventListener('change', (e) => { filtros.hasta = e.target.value; renderEstadisticas(content, state); });

  paintFacturas(document.getElementById('bloque-facturas'), estadoFacturas, facturas, isAdmin);
  if (isAdmin) {
    document.getElementById('btn-sincronizar-facturas').addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = 'Sincronizando…';
      try {
        const r = await api.post(`/api/facturas/sincronizar?desde=${filtros.desde}&hasta=${filtros.hasta}`);
        btn.disabled = false;
        btn.textContent = 'Sincronizar con Siigo';
        alert(`Listo: ${r.totalSincronizadas} factura(s) sincronizada(s) desde Siigo.`);
        renderEstadisticas(content, state);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Sincronizar con Siigo';
        alert('No se pudo sincronizar: ' + err.message);
      }
    });
  }

  paintCotizaciones(document.getElementById('bloque-cotizaciones'), cotizaciones);
}

function paintFacturas(el, estadoFacturas, facturas, isAdmin) {
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

function paintCotizaciones(el, c) {
  const conv = c.tasaConversionSobreDecididas === null ? '—' : pct(c.tasaConversionSobreDecididas);
  el.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="label">Cotizaciones creadas</div><div class="value">${num(c.total, 0)}</div></div>
      <div class="kpi"><div class="label">Aprobadas (Aprobada/Ejecutada/Cerrada)</div><div class="value">${num(c.aprobadas, 0)}</div></div>
      <div class="kpi"><div class="label">Tasa de conversión (sobre decididas)</div><div class="value">${conv}</div></div>
      <div class="kpi"><div class="label">Valor total cotizado</div><div class="value">${money(c.valorTotalCotizado)}</div></div>
      <div class="kpi"><div class="label">Valor aprobado</div><div class="value">${money(c.valorAprobado)}</div></div>
      <div class="kpi"><div class="label">Por estado</div><div class="sub">${Object.entries(c.porEstado).map(([e, n]) => `${e}: <strong>${n}</strong>`).join(' · ') || '—'}</div></div>
    </div>
    <div class="grid-2">
      <div class="card"><div class="chart-title">Creadas vs. aprobadas por mes</div><div id="chart-cot-mes"></div></div>
      <div class="card"><div class="chart-title">Cotizaciones por estado</div><div id="chart-cot-estado"></div></div>
    </div>
  `;
  lineChart(document.getElementById('chart-cot-mes'), {
    categories: c.porMes.map((m) => m.mes),
    series: [
      { name: 'Creadas', color: PALETTE[0], data: c.porMes.map((m) => m.creadas) },
      { name: 'Aprobadas', color: PALETTE[2], data: c.porMes.map((m) => m.aprobadas) },
    ],
    valueFmt: (v) => num(v, 0),
  });
  const estadosOrden = ['Borrador', 'Enviada', 'Aprobada', 'Rechazada', 'Ejecutada', 'Cerrada'];
  horizontalBarChart(document.getElementById('chart-cot-estado'), {
    data: estadosOrden.filter((e) => c.porEstado[e]).map((e, i) => ({ label: e, value: c.porEstado[e], color: PALETTE[i % PALETTE.length] })),
    color: PALETTE[1],
    valueFmt: (v) => num(v, 0),
  });
}
