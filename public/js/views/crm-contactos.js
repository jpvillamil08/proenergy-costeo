import { api } from '../api.js';
import { fmtDMY, esc } from '../format.js';
import { stillMounted } from '../guard.js';
import { subnavCrm, formContacto, formActividad, descargar } from './crm-comun.js';

// Contactos de todas las empresas, con busqueda.

let texto = '';

export async function renderCrmContactos(content, state) {
  const isAdmin = state.usuario.rol === 'admin';
  content.innerHTML = `${subnavCrm('contactos')}<div class="spinner-msg">Cargando contactos…</div>`;
  const contactos = await api.get('/api/crm/contactos');
  if (!stillMounted(content)) return;
  const recargar = () => renderCrmContactos(content, state);

  content.innerHTML = `
    ${subnavCrm('contactos')}
    <div class="toolbar">
      <h1 class="mt-0">Contactos</h1>
      <div class="btn-row">
        <button class="btn btn-secondary btn-sm" id="b-exportar">Exportar Excel</button>
        ${isAdmin ? '<button class="btn btn-primary btn-sm" id="b-nuevo">+ Contacto</button>' : ''}
      </div>
    </div>
    <div class="card filtros-card"><div class="filters"><div class="field" style="min-width:320px"><label>Buscar</label><input id="f-texto" value="${esc(texto)}" placeholder="Nombre, empresa, cargo o correo"></div></div></div>
    <div class="card" id="c-tabla"></div>`;

  const pintar = () => {
    const t = texto.trim().toLowerCase();
    const lista = contactos.filter((c) => !t || `${c.nombre} ${c.empresa_nombre} ${c.cargo || ''} ${c.email || ''} ${c.rol || ''}`.toLowerCase().includes(t));
    document.getElementById('c-tabla').innerHTML = `<p class="muted small">${lista.length} contacto(s)</p>
      ${lista.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Nombre</th><th>Empresa</th><th>Cargo</th><th>Rol</th><th>Correo</th><th>Teléfono</th><th>Celular</th><th>Último contacto</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
        <tbody>${lista.map((c) => `<tr>
          <td><strong>${esc(c.nombre)}</strong>${c.es_principal ? ' <span class="chip">principal</span>' : ''}</td>
          <td><a href="#/crm/empresas/${c.empresa_id}">${esc(c.empresa_nombre)}</a></td>
          <td>${esc(c.cargo || '')}</td><td>${esc(c.rol || '')}</td>
          <td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</td>
          <td>${esc(c.telefono || '')}</td><td>${esc(c.celular || '')}</td>
          <td>${c.ultimo_contacto ? fmtDMY(c.ultimo_contacto) : '<span class="tenue">—</span>'}</td>
          ${isAdmin ? `<td style="white-space:nowrap"><button class="btn btn-secondary btn-sm" data-act="${c.id}" title="Registrar llamada, visita o nota">+ Actividad</button> <button class="btn btn-secondary btn-sm" data-editar="${c.id}">Editar</button></td>` : ''}
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">No hay contactos. Créelos desde aquí, desde la ficha de cada empresa o importándolos en Empresas › Importar.</div>'}`;
    content.querySelectorAll('button[data-editar]').forEach((b) => b.addEventListener('click', async () => {
      if (await formContacto({ contacto: contactos.find((c) => c.id === Number(b.dataset.editar)) })) recargar();
    }));
    content.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const c = contactos.find((x) => x.id === Number(b.dataset.act));
      if (await formActividad({ empresaId: c.empresa_id, contactoId: c.id })) recargar();
    }));
  };
  pintar();
  document.getElementById('f-texto').addEventListener('input', (e) => { texto = e.target.value; pintar(); });
  document.getElementById('b-exportar').addEventListener('click', () => descargar('/api/crm/exportar.xlsx'));
  if (isAdmin) document.getElementById('b-nuevo').addEventListener('click', async () => { if (await formContacto()) recargar(); });
}
