import { api } from '../api.js';
import { money, num, fmtDMY, esc, todayInputVal } from '../format.js';
import { stillMounted } from '../guard.js';

const CAMPOS = [
  ['arriendo_taller', 'Arriendo del taller'], ['servicios_publicos', 'Servicios públicos'],
  ['internet_comunicaciones', 'Internet y comunicaciones'], ['nomina_administrativa', 'Nómina administrativa fija'],
  ['transporte_fijo', 'Transporte fijo'], ['depreciacion', 'Depreciación de maquinaria y equipos'],
  ['seguros_impuestos', 'Seguros e impuestos fijos'], ['otros', 'Otros'],
];

export async function renderParametros(content) {
  content.innerHTML = '<div class="spinner-msg">Cargando…</div>';
  const rows = await api.get('/api/parametros');
  if (!stillMounted(content)) return;
  paint(content, rows);
}

function paint(content, rows) {
  content.innerHTML = `
    <h1>Parámetros de gastos fijos</h1>
    <p class="muted">Se versionan por fecha de vigencia. Cada cotización conserva la tasa de costo fijo por hora vigente en el momento en que fue creada, aunque después se registre una nueva versión.</p>
    <div class="card">
      <h3>Historial de versiones</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Vigente desde</th>${CAMPOS.map(([, l]) => `<th class="num">${l}</th>`).join('')}<th class="num">Total mensual</th><th class="num">Horas product./mes</th><th class="num">Costo fijo/hora</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${fmtDMY(r.fecha_vigencia)}</td>
          ${CAMPOS.map(([k]) => `<td class="num">${money(r[k])}</td>`).join('')}
          <td class="num" style="font-weight:700">${money(r.total_mensual)}</td>
          <td class="num">${num(r.horas_productivas_mes)}</td>
          <td class="num" style="font-weight:700">${money(r.costo_fijo_hora)}</td>
        </tr>`).join('') || '<tr><td colspan="12" class="empty-state">Sin versiones registradas.</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="card" style="max-width:700px">
      <h3>Crear nueva versión</h3>
      <form id="form-param">
        <div class="field"><label>Vigente desde</label><input type="date" name="fecha_vigencia" value="${todayInputVal()}" required></div>
        <div class="form-row">
          ${CAMPOS.map(([k, l]) => `<div class="field"><label>${l}</label><input type="number" name="${k}" min="0" step="1000" value="0" required></div>`).join('')}
        </div>
        <div class="field"><label>Horas productivas facturables del mes</label><input type="number" name="horas_productivas_mes" min="1" step="1" value="500" required></div>
        <div id="msg"></div>
        <button class="btn btn-primary" type="submit">Guardar nueva versión</button>
      </form>
    </div>
  `;
  document.getElementById('form-param').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { fecha_vigencia: fd.get('fecha_vigencia'), horas_productivas_mes: Number(fd.get('horas_productivas_mes')) };
    CAMPOS.forEach(([k]) => { body[k] = Number(fd.get(k)) || 0; });
    try {
      await api.post('/api/parametros', body);
      const rows2 = await api.get('/api/parametros');
      paint(content, rows2);
    } catch (err) { document.getElementById('msg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  });
}
