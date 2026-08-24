import { api } from '../api.js';
import { pct, fmtDMY, esc, todayInputVal } from '../format.js';
import { stillMounted } from '../guard.js';

const CAMPOS = [
  ['pct_utilidad_objetivo', '% Utilidad objetivo sobre el precio'],
  ['margen_minimo_aceptable', '% Margen mínimo aceptable'],
  ['pct_imprevistos', '% Imprevistos sobre costo directo'],
  ['pct_comision_ventas', '% Comisión de ventas'],
  ['pct_iva', '% IVA'],
  ['pct_retefuente', '% Retención en la fuente'],
  ['pct_ica', '% ICA'],
];

export async function renderPoliticas(content) {
  content.innerHTML = '<div class="spinner-msg">Cargando…</div>';
  const rows = await api.get('/api/politicas');
  if (!stillMounted(content)) return;
  paint(content, rows);
}

function paint(content, rows) {
  content.innerHTML = `
    <h1>Políticas comerciales</h1>
    <p class="muted">Se versionan por fecha de vigencia, igual que los gastos fijos, para que el histórico de cotizaciones no se distorsione.</p>
    <div class="card">
      <h3>Historial de versiones</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Vigente desde</th>${CAMPOS.map(([, l]) => `<th class="num">${l}</th>`).join('')}<th class="num">Días crédito estándar cliente</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${fmtDMY(r.fecha_vigencia)}</td>
          ${CAMPOS.map(([k]) => `<td class="num">${pct(r[k])}</td>`).join('')}
          <td class="num">${r.dias_credito_estandar_cliente}</td>
        </tr>`).join('') || '<tr><td colspan="9" class="empty-state">Sin versiones registradas.</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="card" style="max-width:700px">
      <h3>Crear nueva versión</h3>
      <form id="form-pol">
        <div class="field"><label>Vigente desde</label><input type="date" name="fecha_vigencia" value="${todayInputVal()}" required></div>
        <div class="form-row">
          ${CAMPOS.map(([k, l]) => `<div class="field"><label>${l}</label><input type="number" name="${k}" min="0" max="100" step="0.1" value="0" required></div>`).join('')}
          <div class="field"><label>Días de crédito estándar al cliente</label><input type="number" name="dias_credito_estandar_cliente" min="0" step="1" value="30" required></div>
        </div>
        <div id="msg"></div>
        <button class="btn btn-primary" type="submit">Guardar nueva versión</button>
      </form>
    </div>
  `;
  document.getElementById('form-pol').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { fecha_vigencia: fd.get('fecha_vigencia'), dias_credito_estandar_cliente: Number(fd.get('dias_credito_estandar_cliente')) };
    CAMPOS.forEach(([k]) => { body[k] = Number(fd.get(k)) / 100; });
    try {
      await api.post('/api/politicas', body);
      const rows2 = await api.get('/api/politicas');
      paint(content, rows2);
    } catch (err) { document.getElementById('msg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  });
}
