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

  function paint() {
    const filtradas = rows.filter((r) => {
      if (estadoF && r.estado !== estadoF) return false;
      if (filtro && !(`${r.numero} ${r.cliente}`.toLowerCase().includes(filtro.toLowerCase()))) return false;
      return true;
    });
    content.innerHTML = `
      <div class="toolbar">
        <h1 class="mt-0">Cotizaciones</h1>
        ${isAdmin ? `<a href="#/cotizaciones/nueva" class="btn btn-primary">+ Nueva cotización</a>` : ''}
      </div>
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
  }
  paint();
}
