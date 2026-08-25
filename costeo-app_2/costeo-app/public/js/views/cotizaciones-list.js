import { api } from '../api.js';
import { money, pct, num, fmtDMY, esc, SEMAFORO_LABEL, SEMAFORO_CLASS } from '../format.js';
import { stillMounted } from '../guard.js';

export async function renderCotizacionesList(content, state) {
  content.innerHTML = '<div class="spinner-msg">Cargando cotizaciones…</div>';
  const rows = await api.get('/api/cotizaciones');
  if (!stillMounted(content)) return;
  const isAdmin = state.usuario.rol === 'admin';
  let filtro = '';
  let estadoF = '';
  let siigoAbierto = false;
  let siigoEstado = 'inicial'; // inicial | cargando | sin-configurar | listo | error

  async function toggleSiigo() {
    siigoAbierto = !siigoAbierto;
    if (siigoAbierto && siigoEstado === 'inicial') await cargarSiigo();
    else paint();
  }

  async function cargarSiigo() {
    siigoEstado = 'cargando';
    paint();
    try {
      const { configurada } = await api.get('/api/siigo/estado');
      if (!configurada) { siigoEstado = 'sin-configurar'; paint(); return; }
      const data = await api.get('/api/siigo/cotizaciones');
      siigoEstado = { tipo: 'listo', results: data.results };
      paint();
    } catch (e) {
      siigoEstado = { tipo: 'error', mensaje: e.message };
      paint();
    }
  }

  async function importar(siigoId, btn) {
    btn.disabled = true;
    btn.textContent = 'Importando…';
    try {
      const full = await api.post(`/api/siigo/importar/${encodeURIComponent(siigoId)}`);
      location.hash = `#/cotizaciones/${full.cot.id}`;
    } catch (e) {
      alert(`No se pudo importar: ${e.message}`);
      btn.disabled = false;
      btn.textContent = 'Importar';
    }
  }

  function panelSiigo() {
    if (!siigoAbierto) return '';
    let cuerpo = '<p class="muted">Cargando cotizaciones de Siigo…</p>';
    if (siigoEstado === 'sin-configurar') {
      cuerpo = `<p>La conexión con Siigo todavía no está configurada. En Railway, pestaña <strong>Variables</strong> del servicio, agrega <code>SIIGO_USERNAME</code>, <code>SIIGO_ACCESS_KEY</code> y <code>SIIGO_PARTNER_ID</code> con los datos de tu cuenta de Siigo.</p>`;
    } else if (siigoEstado && siigoEstado.tipo === 'error') {
      cuerpo = `<p class="error">No se pudo consultar Siigo: ${esc(siigoEstado.mensaje)}</p>`;
    } else if (siigoEstado && siigoEstado.tipo === 'listo') {
      const results = siigoEstado.results || [];
      cuerpo = `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Número</th><th>Cliente</th><th>Fecha</th><th class="num">Total</th><th></th></tr></thead>
            <tbody>${results.map((q) => `
              <tr>
                <td>${esc(q.numero)}</td><td>${esc(q.cliente)}</td><td>${fmtDMY(q.fecha)}</td>
                <td class="num">${money(q.total)}</td>
                <td>${q.yaImportada
                  ? '<span class="muted">Ya importada</span>'
                  : `<button class="btn btn-secondary btn-importar-siigo" data-siigo-id="${esc(q.id)}">Importar</button>`}</td>
              </tr>`).join('') || '<tr><td colspan="5" class="empty-state">No hay cotizaciones de Siigo en los últimos 90 días.</td></tr>'}
            </tbody>
          </table>
        </div>`;
    }
    return `<div class="card" style="margin-bottom:16px;"><h3 class="mt-0">Importar desde Siigo</h3>${cuerpo}</div>`;
  }

  function paint() {
    const filtradas = rows.filter((r) => {
      if (estadoF && r.estado !== estadoF) return false;
      if (filtro && !(`${r.numero} ${r.cliente}`.toLowerCase().includes(filtro.toLowerCase()))) return false;
      return true;
    });
    content.innerHTML = `
      <div class="toolbar">
        <h1 class="mt-0">Cotizaciones</h1>
        <div style="display:flex; gap:8px;">
          ${isAdmin ? `<button id="btn-siigo" class="btn btn-secondary">${siigoAbierto ? 'Ocultar Siigo' : 'Importar desde Siigo'}</button>` : ''}
          ${isAdmin ? `<a href="#/cotizaciones/nueva" class="btn btn-primary">+ Nueva cotización</a>` : ''}
        </div>
      </div>
      ${isAdmin ? panelSiigo() : ''}
      <div class="card">
        <div class="filters" style="margin-bottom:14px;">
          <div class="field"><label>Buscar</label><input id="f-buscar" placeholder="Número o cliente" value="${esc(filtro)}"></div>
          <div class="field"><label>Estado</label>
            <select id="f-estado"><option value="">Todos</option>${['Borrador', 'Enviada', 'Aprobada', 'Rechazada', 'Ejecutada', 'Cerrada'].map((e) => `<option ${estadoF === e ? 'selected' : ''}>${e}</option>`).join('')}</select>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Número</th><th>Cliente</th><th>Fecha</th><th>Estado</th><th class="num">Precio</th><th class="num">Utilidad</th><th class="num">Margen</th><th>Semáforo</th><th>Estado pago</th></tr></thead>
            <tbody>${filtradas.map((r) => `
              <tr class="clickable" data-id="${r.id}">
                <td>${esc(r.numero)}</td><td>${esc(r.cliente)}</td><td>${fmtDMY(r.fecha_cotizacion)}</td>
                <td><span class="badge estado-${r.estado}">${r.estado}</span></td>
                <td class="num">${money(r.precio_venta)}</td><td class="num">${money(r.utilidad)}</td><td class="num">${pct(r.margenPct)}</td>
                <td><span class="sem ${SEMAFORO_CLASS[r.semaforo]}">${SEMAFORO_LABEL[r.semaforo]}</span></td>
                <td><span class="pago-badge pago-${r.estadoPago.replace(' ', '.')}">${esc(r.estadoPago)}</span></td>
              </tr>`).join('') || '<tr><td colspan="9" class="empty-state">Sin resultados.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;
    content.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/cotizaciones/${tr.dataset.id}`; }));
    document.getElementById('f-buscar').addEventListener('input', (e) => { filtro = e.target.value; paint(); });
    document.getElementById('f-estado').addEventListener('change', (e) => { estadoF = e.target.value; paint(); });
    const btnSiigo = document.getElementById('btn-siigo');
    if (btnSiigo) btnSiigo.addEventListener('click', toggleSiigo);
    content.querySelectorAll('.btn-importar-siigo').forEach((btn) => {
      btn.addEventListener('click', () => importar(btn.dataset.siigoId, btn));
    });
  }
  paint();
}
