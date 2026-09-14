import { api } from '../api.js';
import { money, fmtDMY, esc } from '../format.js';
import { stillMounted } from '../guard.js';
import { subnavCrm, configCrm, badgeTipoEmpresa, formEmpresa, descargar, olvidarEmpresas } from './crm-comun.js';
import { abrirModal } from '../modal.js';

// Empresas: listado con filtros, importar / exportar Excel y posibles duplicados.

const filtros = { texto: '', tipo: '', sector: '', ciudad: '', responsable_id: '', sin_actividad: '' };
let orden = { campo: 'facturado_12m', dir: -1 };

export async function renderCrmEmpresas(content, state) {
  const isAdmin = state.usuario.rol === 'admin';
  content.innerHTML = `${subnavCrm('empresas')}<div class="spinner-msg">Cargando empresas…</div>`;
  const qs = new URLSearchParams(Object.entries(filtros).filter(([, v]) => v)).toString();
  const [cfg, empresas] = await Promise.all([configCrm(), api.get(`/api/crm/empresas${qs ? '?' + qs : ''}`)]);
  if (!stillMounted(content)) return;
  const recargar = () => renderCrmEmpresas(content, state);

  content.innerHTML = `
    ${subnavCrm('empresas')}
    <div class="toolbar">
      <h1 class="mt-0">Empresas</h1>
      <div class="btn-row">
        <button class="btn btn-secondary btn-sm" id="b-exportar">Exportar Excel</button>
        ${isAdmin ? `<button class="btn btn-secondary btn-sm" id="b-importar">Importar</button>
          <button class="btn btn-secondary btn-sm" id="b-duplicados">Posibles duplicados</button>
          <button class="btn btn-primary btn-sm" id="b-nueva">+ Empresa</button>` : ''}
      </div>
    </div>
    <div class="card filtros-card"><div class="filters">
      <div class="field"><label>Buscar</label><input id="f-texto" value="${esc(filtros.texto)}" placeholder="Nombre, NIT o ciudad"></div>
      <div class="field"><label>Tipo</label><select id="f-tipo"><option value="">Todos</option>${cfg.tiposEmpresa.map((t) => `<option ${filtros.tipo === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label>Sector</label><select id="f-sector"><option value="">Todos</option>${cfg.sectores.map((t) => `<option ${filtros.sector === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div class="field"><label>Ciudad</label><input id="f-ciudad" value="${esc(filtros.ciudad)}"></div>
      <div class="field"><label>Responsable</label><select id="f-responsable_id"><option value="">Todos</option>${cfg.usuarios.map((u) => `<option value="${u.id}" ${String(filtros.responsable_id) === String(u.id) ? 'selected' : ''}>${esc(u.nombre)}</option>`).join('')}</select></div>
      <div class="field"><label>Sin contacto</label><select id="f-sin_actividad"><option value="">—</option>${[30, 60, 90, 180].map((d) => `<option value="${d}" ${String(filtros.sin_actividad) === String(d) ? 'selected' : ''}>Más de ${d} días</option>`).join('')}</select></div>
    </div></div>
    <div class="card" id="emp-tabla"></div>`;

  const pintarTabla = () => {
    const lista = [...empresas].sort((a, b) => {
      const va = a[orden.campo] ?? '';
      const vb = b[orden.campo] ?? '';
      return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * orden.dir;
    });
    const th = (campo, label, clase = '') => `<th class="sortable ${clase}" data-campo="${campo}">${label}${orden.campo === campo ? (orden.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    document.getElementById('emp-tabla').innerHTML = `
      <p class="muted small">${lista.length} empresa(s) · ${lista.filter((e) => e.tipo === 'Cliente').length} cliente(s) activos</p>
      ${lista.length ? `<div class="table-wrap"><table>
        <thead><tr>${th('nombre', 'Empresa')}${th('tipo', 'Tipo')}${th('sector', 'Sector')}${th('ciudad', 'Ciudad')}${th('negocios_abiertos', 'Negocios abiertos', 'num')}${th('n_cotizaciones', 'Cotizaciones', 'num')}${th('facturado_12m', 'Facturado 12 m', 'num')}${th('cartera', 'Cartera', 'num')}${th('ultima_factura', 'Última factura')}${th('ultimo_contacto', 'Último contacto')}${th('responsable_nombre', 'Responsable')}</tr></thead>
        <tbody>${lista.map((e) => `<tr class="clickable" data-id="${e.id}">
          <td><a href="#/crm/empresas/${e.id}">${esc(e.nombre)}</a>${e.nit ? `<div class="small muted">NIT ${esc(e.nit)}</div>` : ''}</td>
          <td>${badgeTipoEmpresa(e.tipo)}</td><td>${esc(e.sector || '')}</td><td>${esc(e.ciudad || '')}</td>
          <td class="num">${e.negocios_abiertos || ''}</td><td class="num">${e.n_cotizaciones || ''}</td>
          <td class="num">${e.facturado_12m ? money(e.facturado_12m) : ''}</td><td class="num">${e.cartera > 0.5 ? money(e.cartera) : ''}</td>
          <td>${e.ultima_factura ? fmtDMY(e.ultima_factura) : ''}</td>
          <td>${e.ultimo_contacto ? `${fmtDMY(e.ultimo_contacto)}<div class="small muted">hace ${e.dias_sin_contacto} d</div>` : '<span class="tenue">nunca</span>'}</td>
          <td>${esc(e.responsable_nombre || '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">No hay empresas con estos filtros.</div>'}`;
    content.querySelectorAll('th.sortable').forEach((h) => h.addEventListener('click', () => {
      orden = { campo: h.dataset.campo, dir: orden.campo === h.dataset.campo ? -orden.dir : (['nombre', 'tipo', 'sector', 'ciudad', 'responsable_nombre'].includes(h.dataset.campo) ? 1 : -1) };
      pintarTabla();
    }));
    content.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', (ev) => { if (ev.target.tagName !== 'A') location.hash = `#/crm/empresas/${tr.dataset.id}`; }));
  };
  pintarTabla();

  let temporizador = null;
  for (const clave of Object.keys(filtros)) {
    const el = document.getElementById(`f-${clave}`);
    if (!el) continue;
    const esTexto = el.tagName === 'INPUT';
    el.addEventListener(esTexto ? 'input' : 'change', () => {
      filtros[clave] = el.value;
      clearTimeout(temporizador);
      temporizador = setTimeout(async () => {
        await recargar();
        const nuevo = document.getElementById(`f-${clave}`);
        if (nuevo && esTexto) { nuevo.focus(); nuevo.setSelectionRange(nuevo.value.length, nuevo.value.length); }
      }, esTexto ? 350 : 0);
    });
  }

  document.getElementById('b-exportar').addEventListener('click', () => descargar('/api/crm/exportar.xlsx'));
  if (!isAdmin) return;
  document.getElementById('b-nueva').addEventListener('click', async () => { const r = await formEmpresa(); if (r && r.id) location.hash = `#/crm/empresas/${r.id}`; });
  document.getElementById('b-importar').addEventListener('click', () => importar(recargar));
  document.getElementById('b-duplicados').addEventListener('click', () => verDuplicados(recargar));
}

async function importar(recargar) {
  await abrirModal({
    titulo: 'Importar empresas o contactos', textoGuardar: 'Importar', ancho: 620,
    cuerpo: `
      <p class="muted">Suba un Excel (.xlsx) o CSV con encabezados en la primera fila. Las empresas se reconocen por NIT o por nombre, y los contactos por correo: si ya existen se actualizan (las celdas vacías no borran datos), si no, se crean.</p>
      <div class="form-grid">
        <div class="field"><label>Qué va a importar</label><select name="tipo"><option value="empresas">Empresas</option><option value="contactos">Contactos</option></select></div>
        <div class="field"><label>Plantilla</label><div class="btn-row"><button type="button" class="btn btn-secondary btn-sm" id="b-plantilla">Descargar plantilla</button></div></div>
        <div class="field full"><label>Archivo</label><input type="file" name="archivo" accept=".xlsx,.csv"></div>
      </div>
      <div id="imp-resultado"></div>`,
    alMontar: (form) => {
      form.querySelector('#b-plantilla').addEventListener('click', () => descargar(`/api/crm/plantilla.xlsx?tipo=${form.tipo.value}`));
    },
    alGuardar: async (form) => {
      const archivo = form.archivo.files[0];
      if (!archivo) throw new Error('Elija un archivo');
      const formato = archivo.name.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx';
      const res = await fetch(`/api/crm/importar?tipo=${form.tipo.value}&formato=${formato}`, { method: 'POST', credentials: 'same-origin', body: archivo });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      olvidarEmpresas();
      alert(`${data.filas} fila(s): ${data.creadas} creada(s), ${data.actualizadas} actualizada(s).${data.errores.length ? `\n\n${data.errores.length} con error:\n${data.errores.slice(0, 15).join('\n')}` : ''}`);
      recargar();
    },
  });
}

async function verDuplicados(recargar) {
  const pares = await api.get('/api/crm/duplicados');
  await abrirModal({
    titulo: 'Posibles duplicados', ancho: 860, soloLectura: true,
    cuerpo: pares.length ? `
      <p class="muted">La plataforma nunca une empresas sola por parecido. Revise cada par y, si son la misma, elija cuál conserva: la otra se fusiona (sus cotizaciones, facturas, contactos, negocios y correos pasan a la que queda).</p>
      <div class="table-wrap"><table class="compacta"><thead><tr><th>Motivo</th><th>Empresa A</th><th>Empresa B</th><th></th></tr></thead>
      <tbody>${pares.map((p, i) => `<tr data-i="${i}"><td class="small">${esc(p.motivo)}</td>
        <td><a href="#/crm/empresas/${p.a.id}" target="_blank">${esc(p.a.nombre)}</a><div class="small muted">${p.a.nit ? 'NIT ' + esc(p.a.nit) : 'sin NIT'} · ${esc(p.a.tipo)}</div></td>
        <td><a href="#/crm/empresas/${p.b.id}" target="_blank">${esc(p.b.nombre)}</a><div class="small muted">${p.b.nit ? 'NIT ' + esc(p.b.nit) : 'sin NIT'} · ${esc(p.b.tipo)}</div></td>
        <td style="white-space:nowrap"><button type="button" class="btn btn-secondary btn-sm" data-conservar="a">Conservar A</button> <button type="button" class="btn btn-secondary btn-sm" data-conservar="b">Conservar B</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty-state">No se encontraron posibles duplicados.</div>',
    alMontar: (form, cerrar) => {
      form.querySelectorAll('button[data-conservar]').forEach((b) => b.addEventListener('click', async () => {
        const p = pares[Number(b.closest('tr').dataset.i)];
        const [destino, origen] = b.dataset.conservar === 'a' ? [p.a, p.b] : [p.b, p.a];
        if (!confirm(`¿Fusionar "${origen.nombre}" dentro de "${destino.nombre}"? No se puede deshacer.`)) return;
        try {
          await api.post(`/api/crm/empresas/${destino.id}/fusionar`, { origen_id: origen.id });
          olvidarEmpresas();
          cerrar(true);
          recargar();
          verDuplicados(recargar);
        } catch (e) { alert(e.message); }
      }));
    },
  });
}
