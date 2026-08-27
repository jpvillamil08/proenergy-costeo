import { api } from '../api.js';
import { esc } from '../format.js';
import { stillMounted } from '../guard.js';

export async function renderProveedores(content) {
  content.innerHTML = '<div class="spinner-msg">Cargando…</div>';
  const rows = await api.get('/api/proveedores?todos=1');
  if (!stillMounted(content)) return;
  paint(content, rows);
}

function paint(content, rows) {
  content.innerHTML = `
    <div class="toolbar"><h1 class="mt-0">Catálogo de proveedores</h1></div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Nombre</th><th>NIT</th><th class="num">Días crédito habituales</th><th>Contacto</th><th>Activo</th><th></th></tr></thead>
        <tbody>${rows.map((p) => `<tr data-id="${p.id}">
          <td>${esc(p.nombre)}</td><td>${esc(p.nit || '')}</td><td class="num">${p.dias_credito_habituales}</td><td>${esc(p.contacto || '')}</td><td>${p.activo ? 'Sí' : 'No'}</td>
          <td class="btn-row"><button class="btn btn-sm btn-secondary act-edit">Editar</button><button class="btn btn-sm btn-danger act-del">${p.activo ? 'Desactivar' : ''}</button></td>
        </tr>`).join('') || '<tr><td colspan="6" class="empty-state">Sin proveedores.</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="card" style="max-width:640px">
      <h3 id="form-title">Agregar proveedor</h3>
      <form id="form-prov">
        <input type="hidden" name="id">
        <div class="form-row">
          <div class="field"><label>Nombre</label><input name="nombre" required></div>
          <div class="field"><label>NIT</label><input name="nit"></div>
          <div class="field"><label>Días de crédito habituales</label><input type="number" name="dias_credito_habituales" min="0" step="1" value="0"></div>
          <div class="field"><label>Contacto</label><input name="contacto" placeholder="Nombre - teléfono"></div>
        </div>
        <div id="msg"></div>
        <div class="btn-row"><button class="btn btn-primary" type="submit">Guardar</button><button class="btn btn-secondary" type="button" id="btn-cancelar">Cancelar edición</button></div>
      </form>
    </div>
  `;
  content.querySelectorAll('.act-edit').forEach((btn) => btn.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    const p = rows.find((x) => String(x.id) === tr.dataset.id);
    const form = document.getElementById('form-prov');
    form.id.value = p.id; form.nombre.value = p.nombre; form.nit.value = p.nit || ''; form.dias_credito_habituales.value = p.dias_credito_habituales; form.contacto.value = p.contacto || '';
    document.getElementById('form-title').textContent = `Editar proveedor: ${p.nombre}`;
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }));
  content.querySelectorAll('.act-del').forEach((btn) => btn.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr');
    const p = rows.find((x) => String(x.id) === tr.dataset.id);
    if (!p.activo) return;
    if (!confirm(`¿Desactivar a ${p.nombre}?`)) return;
    await api.del(`/api/proveedores/${p.id}`);
    renderProveedores(content);
  }));
  document.getElementById('btn-cancelar').addEventListener('click', () => renderProveedores(content));
  document.getElementById('form-prov').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const id = fd.get('id');
    const body = { nombre: fd.get('nombre'), nit: fd.get('nit'), dias_credito_habituales: Number(fd.get('dias_credito_habituales')) || 0, contacto: fd.get('contacto'), activo: true };
    try {
      if (id) await api.put(`/api/proveedores/${id}`, body); else await api.post('/api/proveedores', body);
      renderProveedores(content);
    } catch (err) { document.getElementById('msg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  });
}
