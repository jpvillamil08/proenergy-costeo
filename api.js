import { api } from '../api.js';
import { esc, money } from '../format.js';
import { stillMounted } from '../guard.js';

let materiales = [], proveedores = [], filtro = '', editandoPreciosDe = null;

export async function renderMateriales(content) {
  content.innerHTML = '<div class="spinner-msg">Cargando…</div>';
  filtro = ''; editandoPreciosDe = null;
  await reload(content);
}

async function reload(content) {
  const [mats, provs] = await Promise.all([api.get('/api/materiales?todos=1'), api.get('/api/proveedores?todos=1')]);
  if (!stillMounted(content)) return;
  materiales = mats; proveedores = provs;
  paint(content);
}

function badgesPrecios(m) {
  if (!m.precios.length) return '<span class="muted">Sin precios</span>';
  return m.precios.map((p) => {
    const esMejor = p.proveedor_id === m.mejor_proveedor_id;
    const estilo = esMejor
      ? 'background:var(--good-bg); color:var(--good); font-weight:600;'
      : 'background:var(--page); color:var(--ink-2);';
    return `<span style="display:inline-block; padding:2px 8px; border-radius:20px; font-size:12px; margin:1px 3px 1px 0; ${estilo}">${esc(p.proveedor_nombre)}: ${money(p.precio_unitario)}</span>`;
  }).join('');
}

function panelPrecios(m) {
  if (!m) return '';
  return `
    <div class="card" id="panel-precios">
      <h3 class="mt-0">Precios por proveedor: ${esc(m.descripcion)}</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Proveedor</th><th class="num">Precio unitario</th><th class="num">Precio con IVA (19%)</th><th></th></tr></thead>
        <tbody>${m.precios.map((p) => `
          <tr>
            <td>${esc(p.proveedor_nombre)}${p.proveedor_id === m.mejor_proveedor_id ? ' <span style="color:var(--good); font-size:12px;">● más barato</span>' : ''}</td>
            <td class="num">${money(p.precio_unitario)}</td>
            <td class="num">${money(p.precio_con_iva)}</td>
            <td class="btn-row"><button class="btn btn-sm btn-danger act-borrar-precio" data-prov="${p.proveedor_id}">✕</button></td>
          </tr>`).join('') || '<tr><td colspan="4" class="empty-state">Sin precios registrados todavía.</td></tr>'}</tbody>
      </table></div>
      <form id="form-precio" class="form-row" style="margin-top:12px;">
        <div class="field"><label>Proveedor</label>
          <select name="proveedor_id" required>${proveedores.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Precio unitario (sin IVA)</label><input type="number" name="precio_unitario" min="0" step="1" required></div>
        <div class="field" style="align-self:end"><button class="btn btn-primary" type="submit">Guardar precio</button></div>
        <div class="field" style="align-self:end"><button class="btn btn-secondary" type="button" id="btn-cerrar-precios">Cerrar</button></div>
      </form>
    </div>`;
}

function paint(content) {
  const filtradas = materiales.filter((m) => !filtro || m.descripcion.toLowerCase().includes(filtro.toLowerCase()));
  const materialEditando = editandoPreciosDe ? materiales.find((m) => m.id === editandoPreciosDe) : null;
  content.innerHTML = `
    <div class="toolbar"><h1 class="mt-0">Catálogo de materiales</h1></div>
    <div class="card">
      <div class="field" style="max-width:320px; margin-bottom:12px;"><label>Buscar</label><input id="f-buscar" placeholder="Ej: conector, cable, breaker…" value="${esc(filtro)}"></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Descripción</th><th>Unidad</th><th>Precios por proveedor</th><th class="num">Mejor precio</th><th>Activo</th><th></th></tr></thead>
        <tbody>${filtradas.map((m) => `
          <tr data-id="${m.id}">
            <td>${esc(m.descripcion)}</td>
            <td>${esc(m.unidad)}</td>
            <td>${badgesPrecios(m)}</td>
            <td class="num">${m.mejor_precio !== null ? money(m.mejor_precio) : '—'}</td>
            <td>${m.activo ? 'Sí' : 'No'}</td>
            <td class="btn-row">
              <button class="btn btn-sm btn-secondary act-precios">Precios</button>
              <button class="btn btn-sm btn-danger act-del">${m.activo ? 'Desactivar' : ''}</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="6" class="empty-state">Sin materiales.</td></tr>'}</tbody>
      </table></div>
    </div>
    ${panelPrecios(materialEditando)}
    <div class="card" style="max-width:640px">
      <h3 class="mt-0">Agregar material nuevo</h3>
      <form id="form-mat">
        <div class="form-row">
          <div class="field"><label>Descripción</label><input name="descripcion" required></div>
          <div class="field"><label>Unidad</label><input name="unidad" value="UND"></div>
          <div class="field"><label>Categoría (opcional)</label><input name="categoria"></div>
        </div>
        <div id="msg"></div>
        <div class="btn-row"><button class="btn btn-primary" type="submit">Agregar</button></div>
      </form>
    </div>
  `;

  document.getElementById('f-buscar').addEventListener('input', (e) => { filtro = e.target.value; paint(content); });

  content.querySelectorAll('.act-precios').forEach((btn) => btn.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    editandoPreciosDe = Number(tr.dataset.id);
    paint(content);
    document.getElementById('panel-precios')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));

  content.querySelectorAll('.act-del').forEach((btn) => btn.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr');
    const m = materiales.find((x) => x.id === Number(tr.dataset.id));
    if (!m.activo) return;
    if (!confirm(`¿Desactivar "${m.descripcion}"?`)) return;
    await api.del(`/api/materiales/${m.id}`);
    await reload(content);
  }));

  const btnCerrar = document.getElementById('btn-cerrar-precios');
  if (btnCerrar) btnCerrar.addEventListener('click', () => { editandoPreciosDe = null; paint(content); });

  const formPrecio = document.getElementById('form-precio');
  if (formPrecio) formPrecio.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api.put(`/api/materiales/${editandoPreciosDe}/precios/${fd.get('proveedor_id')}`, { precio_unitario: Number(fd.get('precio_unitario')) });
    await reload(content);
  });

  content.querySelectorAll('.act-borrar-precio').forEach((btn) => btn.addEventListener('click', async (e) => {
    if (!confirm('¿Quitar el precio de este proveedor para este material?')) return;
    await api.del(`/api/materiales/${editandoPreciosDe}/precios/${e.target.dataset.prov}`);
    await reload(content);
  }));

  document.getElementById('form-mat').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.post('/api/materiales', { descripcion: fd.get('descripcion'), unidad: fd.get('unidad') || 'UND', categoria: fd.get('categoria') || null });
      await reload(content);
    } catch (err) { document.getElementById('msg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  });
}
