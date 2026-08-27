import { api } from '../api.js';
import { money, num, esc } from '../format.js';
import { stillMounted } from '../guard.js';

const CARGOS = ['Tecnico', 'Liniero', 'Coordinador operativo', 'Conductor', 'Otros'];

export async function renderTrabajadores(content) {
  content.innerHTML = '<div class="spinner-msg">Cargando…</div>';
  const rows = await api.get('/api/trabajadores?todos=1');
  if (!stillMounted(content)) return;
  paint(content, rows);
}

function paint(content, rows) {
  content.innerHTML = `
    <div class="toolbar"><h1 class="mt-0">Catálogo de trabajadores</h1></div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Nombre</th><th>Cargo</th><th>Tipo</th><th class="num">Tarifa/h</th><th class="num">Factor prestacional</th><th>IVA</th><th>Retención</th><th>Activo</th><th></th></tr></thead>
        <tbody>${rows.map((t) => `<tr data-id="${t.id}">
          <td>${esc(t.nombre)}</td><td>${t.cargo}</td><td>${t.tipo}</td><td class="num">${money(t.tarifa_hora)}</td>
          <td class="num">${t.tipo === 'Interno' ? num(t.factor_prestacional, 2) : '—'}</td>
          <td>${t.tipo === 'Externo' ? (t.factura_iva ? 'Sí' : 'No') : '—'}</td>
          <td>${t.tipo === 'Externo' ? (t.aplica_retencion ? 'Sí' : 'No') : '—'}</td>
          <td>${t.activo ? 'Sí' : 'No'}</td>
          <td class="btn-row"><button class="btn btn-sm btn-secondary act-edit">Editar</button><button class="btn btn-sm btn-danger act-del">${t.activo ? 'Desactivar' : ''}</button></td>
        </tr>`).join('') || '<tr><td colspan="9" class="empty-state">Sin trabajadores.</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="card" style="max-width:640px">
      <h3 id="form-title">Agregar trabajador</h3>
      <form id="form-trab">
        <input type="hidden" name="id">
        <div class="form-row">
          <div class="field"><label>Nombre</label><input name="nombre" required></div>
          <div class="field"><label>Cargo</label><select name="cargo">${CARGOS.map((c) => `<option>${c}</option>`).join('')}</select></div>
          <div class="field"><label>Tipo</label><select name="tipo" id="sel-tipo"><option>Interno</option><option>Externo</option></select></div>
          <div class="field"><label>Tarifa por hora</label><input type="number" name="tarifa_hora" min="0" step="100" value="0" required></div>
          <div class="field" id="campo-factor"><label>Factor prestacional</label><input type="number" name="factor_prestacional" min="1" step="0.01" value="1.52"></div>
          <div class="field" id="campo-iva"><label>¿Factura con IVA?</label><select name="factura_iva"><option value="0">No</option><option value="1">Sí</option></select></div>
          <div class="field" id="campo-ret"><label>¿Se le retiene?</label><select name="aplica_retencion"><option value="0">No</option><option value="1">Sí</option></select></div>
        </div>
        <div id="msg"></div>
        <div class="btn-row"><button class="btn btn-primary" type="submit">Guardar</button><button class="btn btn-secondary" type="button" id="btn-cancelar">Cancelar edición</button></div>
      </form>
    </div>
  `;
  function toggleCampos() {
    const tipo = document.getElementById('sel-tipo').value;
    document.getElementById('campo-factor').style.display = tipo === 'Interno' ? '' : 'none';
    document.getElementById('campo-iva').style.display = tipo === 'Externo' ? '' : 'none';
    document.getElementById('campo-ret').style.display = tipo === 'Externo' ? '' : 'none';
  }
  document.getElementById('sel-tipo').addEventListener('change', toggleCampos);
  toggleCampos();

  content.querySelectorAll('.act-edit').forEach((btn) => btn.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    const t = rows.find((x) => String(x.id) === tr.dataset.id);
    const form = document.getElementById('form-trab');
    form.id.value = t.id; form.nombre.value = t.nombre; form.cargo.value = t.cargo; form.tipo.value = t.tipo;
    form.tarifa_hora.value = t.tarifa_hora; form.factor_prestacional.value = t.factor_prestacional || 1.52;
    form.factura_iva.value = t.factura_iva ? '1' : '0'; form.aplica_retencion.value = t.aplica_retencion ? '1' : '0';
    document.getElementById('form-title').textContent = `Editar trabajador: ${t.nombre}`;
    toggleCampos();
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }));
  content.querySelectorAll('.act-del').forEach((btn) => btn.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr');
    const t = rows.find((x) => String(x.id) === tr.dataset.id);
    if (!t.activo) return;
    if (!confirm(`¿Desactivar a ${t.nombre}? Ya no aparecerá disponible para nuevas cotizaciones.`)) return;
    await api.del(`/api/trabajadores/${t.id}`);
    renderTrabajadores(content);
  }));
  document.getElementById('btn-cancelar').addEventListener('click', () => renderTrabajadores(content));
  document.getElementById('form-trab').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const id = fd.get('id');
    const body = {
      nombre: fd.get('nombre'), cargo: fd.get('cargo'), tipo: fd.get('tipo'), tarifa_hora: Number(fd.get('tarifa_hora')),
      factor_prestacional: Number(fd.get('factor_prestacional')) || 1, factura_iva: fd.get('factura_iva') === '1', aplica_retencion: fd.get('aplica_retencion') === '1',
      activo: true,
    };
    try {
      if (id) await api.put(`/api/trabajadores/${id}`, body); else await api.post('/api/trabajadores', body);
      renderTrabajadores(content);
    } catch (err) { document.getElementById('msg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  });
}
