// Piezas compartidas de las pantallas del CRM: configuracion, subnavegacion,
// etiquetas y los formularios de empresa, contacto, negocio y actividad.
import { api } from '../api.js';
import { money, esc, fmtDMY } from '../format.js';
import { abrirModal, abrirFormulario, campoHtml, valoresForm } from '../modal.js';

let configCache = null;
export async function configCrm() {
  if (!configCache) configCache = await api.get('/api/crm/config');
  return configCache;
}

let empresasCache = null;
export async function empresasMin(refrescar = false) {
  if (!empresasCache || refrescar) empresasCache = await api.get('/api/crm/empresas?min=1');
  return empresasCache;
}
export function olvidarEmpresas() { empresasCache = null; }

export function subnavCrm(activo) {
  const items = [['tablero', '#/crm', 'Tablero'], ['negocios', '#/crm/negocios', 'Negocios'], ['empresas', '#/crm/empresas', 'Empresas'],
    ['contactos', '#/crm/contactos', 'Contactos'], ['agenda', '#/crm/agenda', 'Agenda']];
  return `<nav class="subnav">${items.map(([k, href, l]) => `<a href="${href}" class="${k === activo ? 'active' : ''}">${l}</a>`).join('')}</nav>`;
}

export const COLOR_ETAPA = {
  Previsita: '#898781', 'Propuesta enviada': '#2a78d6', 'Propuesta aceptada': '#4a3aa7', 'OC recibida': '#eb6834',
  'Actividad ejecutada': '#eda100', 'Enviar factura': '#e87ba4', 'Cierre ganado': '#0ca30c', 'Cierre perdido': '#d03b3b',
};
export const ICONO_ACTIVIDAD = { Llamada: '📞', Visita: '🚗', Reunión: '👥', Correo: '✉️', WhatsApp: '💬', Tarea: '✔️', Nota: '📝' };

export function badgeEtapa(etapa) {
  const c = COLOR_ETAPA[etapa] || '#898781';
  return `<span class="badge-etapa" style="--c:${c}">${esc(etapa)}</span>`;
}
export function badgeTipoEmpresa(tipo) {
  return `<span class="badge tipo-${esc(tipo)}">${esc(tipo)}</span>`;
}

// $ 12,3 M para tarjetas y KPIs; el valor exacto va en el title.
export function millones(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e6) return `$ ${(n / 1e6).toLocaleString('es-CO', { maximumFractionDigits: 1 })} M`;
  return money(n);
}

export function fechaHora(fh) {
  if (!fh) return '—';
  const s = String(fh);
  return `${fmtDMY(s.slice(0, 10))}${s.length > 10 ? ' ' + s.slice(11, 16) : ''}`;
}

export function barraEtapas(etapaActual, { clickable = false } = {}) {
  const etapas = configCache ? configCache.etapas.map((e) => e.nombre) : Object.keys(COLOR_ETAPA);
  const idx = etapas.indexOf(etapaActual);
  return `<div class="barra-etapas">${etapas.map((e, i) => {
    const estado = e === etapaActual ? 'actual' : (etapaActual !== 'Cierre perdido' && i < idx && e !== 'Cierre perdido') ? 'hecha' : '';
    return `<button type="button" class="paso ${estado} ${e === 'Cierre perdido' ? 'perdido' : ''} ${e === 'Cierre ganado' ? 'ganado' : ''}" data-etapa="${esc(e)}" ${clickable ? '' : 'disabled'}>${esc(e)}</button>`;
  }).join('')}</div>`;
}

const opcionesUsuarios = (cfg) => cfg.usuarios.map((u) => [u.id, u.nombre]);

// Campo de empresa con busqueda (datalist): el usuario escribe y elige.
function campoEmpresa(empresas, empresaId) {
  const actual = empresas.find((e) => e.id === Number(empresaId));
  return `<div class="field full"><label for="f-empresa_nombre">Empresa *</label>
    <input id="f-empresa_nombre" name="empresa_nombre" list="lista-empresas" value="${esc(actual ? actual.nombre : '')}" autocomplete="off" placeholder="Escriba para buscar…">
    <datalist id="lista-empresas">${empresas.map((e) => `<option value="${esc(e.nombre)}">${e.nit ? 'NIT ' + esc(e.nit) : ''}</option>`).join('')}</datalist>
    <input type="hidden" name="empresa_id" value="${actual ? actual.id : ''}"></div>`;
}
function resolverEmpresa(form, empresas) {
  const nombre = form.querySelector('[name=empresa_nombre]').value.trim();
  const e = empresas.find((x) => x.nombre === nombre);
  form.querySelector('[name=empresa_id]').value = e ? e.id : '';
  return e || null;
}

// ---------------------------------------------------------------- empresa
export async function formEmpresa(empresa = null) {
  const cfg = await configCrm();
  const e = empresa || {};
  return abrirFormulario({
    titulo: empresa ? `Editar ${empresa.nombre}` : 'Nueva empresa', ancho: 720,
    campos: [
      { name: 'nombre', label: 'Razón social o nombre', value: e.nombre, required: true, full: true },
      { name: 'nit', label: 'NIT', value: e.nit, help: 'Sin dígito de verificación' },
      { name: 'tipo', label: 'Tipo', type: 'select', value: empresa ? (e.tipo_manual ? e.tipo : 'auto') : '', vacio: false,
        options: [...(empresa ? [['auto', `Automático (hoy: ${e.tipo})`]] : [['', 'Automático según facturas']]), ...cfg.tiposEmpresa.map((t) => [t, t])] },
      { name: 'sector', label: 'Sector', type: 'select', value: e.sector, options: cfg.sectores },
      { name: 'ciudad', label: 'Ciudad', value: e.ciudad },
      { name: 'direccion', label: 'Dirección', value: e.direccion },
      { name: 'telefono', label: 'Teléfono', value: e.telefono },
      { name: 'web', label: 'Sitio web', value: e.web },
      { name: 'dominio_correo', label: 'Dominio de correo', value: e.dominio_correo, help: 'Ej. ruitoque.com: enlaza los correos de Outlook de esa empresa' },
      { name: 'origen', label: 'Origen', type: 'select', value: e.origen, options: cfg.origenes },
      { name: 'responsable_id', label: 'Responsable', type: 'select', value: e.responsable_id, options: opcionesUsuarios(cfg) },
      { name: 'notas', label: 'Notas', type: 'textarea', value: e.notas, full: true },
    ],
    alGuardar: async (v) => {
      if (!v.tipo) delete v.tipo;
      const r = empresa ? await api.put(`/api/crm/empresas/${empresa.id}`, v) : await api.post('/api/crm/empresas', v);
      olvidarEmpresas();
      return r;
    },
  });
}

// ---------------------------------------------------------------- contacto
export async function formContacto({ contacto = null, empresaId = null } = {}) {
  const [cfg, empresas] = await Promise.all([configCrm(), empresasMin()]);
  const c = contacto || {};
  return abrirModal({
    titulo: contacto ? `Editar ${contacto.nombre}` : 'Nuevo contacto', ancho: 680,
    cuerpo: `<div class="form-grid">
      ${campoEmpresa(empresas, c.empresa_id || empresaId)}
      ${[
        { name: 'nombre', label: 'Nombre', value: c.nombre, required: true },
        { name: 'cargo', label: 'Cargo', value: c.cargo },
        { name: 'rol', label: 'Rol en la compra', type: 'select', value: c.rol, options: cfg.rolesContacto },
        { name: 'email', label: 'Correo electrónico', type: 'email', value: c.email },
        { name: 'telefono', label: 'Teléfono', value: c.telefono },
        { name: 'celular', label: 'Celular / WhatsApp', value: c.celular },
        { name: 'es_principal', label: 'Contacto principal de la empresa', type: 'checkbox', value: c.es_principal },
        { name: 'notas', label: 'Notas', type: 'textarea', value: c.notas, full: true },
      ].map(campoHtml).join('')}</div>`,
    alGuardar: async (form) => {
      if (!resolverEmpresa(form, empresas)) throw new Error('Elija una empresa de la lista (si no existe, créela primero en Empresas).');
      const v = valoresForm(form);
      delete v.empresa_nombre;
      return contacto ? api.put(`/api/crm/contactos/${contacto.id}`, v) : api.post('/api/crm/contactos', v);
    },
  });
}

// ---------------------------------------------------------------- negocio
export async function formNegocio({ negocio = null, empresaId = null, cotizacionNumero = null } = {}) {
  const [cfg, empresas] = await Promise.all([configCrm(), empresasMin()]);
  const n = negocio || {};
  const abiertas = cfg.etapas.filter((e) => e.abierta).map((e) => e.nombre);
  let contactos = [];
  const cargarContactos = async (form, eid, seleccionado) => {
    const sel = form.querySelector('[name=contacto_id]');
    contactos = eid ? await api.get(`/api/crm/contactos?empresa_id=${eid}`) : [];
    sel.innerHTML = `<option value="">—</option>${contactos.map((c) => `<option value="${c.id}" ${Number(seleccionado) === c.id ? 'selected' : ''}>${esc(c.nombre)}${c.cargo ? ' · ' + esc(c.cargo) : ''}</option>`).join('')}`;
  };
  return abrirModal({
    titulo: negocio ? `Editar negocio` : 'Nuevo negocio', ancho: 720,
    cuerpo: `<div class="form-grid">
      ${campoEmpresa(empresas, n.empresa_id || empresaId)}
      ${[
        { name: 'nombre', label: 'Nombre del negocio', value: n.nombre, required: true, full: true, attrs: 'placeholder="Ej. Suministro de medidores Ruitoque"' },
        { name: 'contacto_id', label: 'Contacto', type: 'select', value: n.contacto_id, options: [] },
        ...(negocio ? [] : [{ name: 'etapa', label: 'Etapa inicial', type: 'select', value: 'Previsita', vacio: false, options: abiertas }]),
        { name: 'valor_estimado', label: 'Valor estimado sin IVA', type: 'number', value: n.valor_estimado, attrs: n.valor_desde_cotizaciones ? 'disabled' : 'min="0" step="1000"',
          help: n.valor_desde_cotizaciones ? 'Sale de sus cotizaciones' : 'Mientras no tenga cotizaciones vinculadas' },
        { name: 'probabilidad', label: 'Probabilidad (%)', type: 'number', value: n.probabilidad != null ? Math.round(n.probabilidad * 100) : '', attrs: 'min="0" max="100"', help: 'Vacío = la de la etapa' },
        { name: 'fecha_cierre_esperada', label: 'Cierre esperado', type: 'date', value: n.fecha_cierre_esperada },
        { name: 'origen', label: 'Origen', type: 'select', value: n.origen, options: cfg.origenes },
        { name: 'responsable_id', label: 'Responsable', type: 'select', value: n.responsable_id, options: opcionesUsuarios(cfg) },
        ...(negocio ? [] : [{ name: 'cotizacion_numero', label: 'Cotización (opcional)', value: cotizacionNumero || '', attrs: 'placeholder="C-1-240"' }]),
        { name: 'descripcion', label: 'Descripción / alcance', type: 'textarea', value: n.descripcion, full: true },
      ].map(campoHtml).join('')}</div>`,
    alMontar: (form) => {
      const input = form.querySelector('[name=empresa_nombre]');
      const alCambiar = () => { const e = resolverEmpresa(form, empresas); cargarContactos(form, e && e.id, n.contacto_id); };
      input.addEventListener('change', alCambiar);
      if (n.empresa_id || empresaId) cargarContactos(form, n.empresa_id || empresaId, n.contacto_id);
    },
    alGuardar: async (form) => {
      if (!resolverEmpresa(form, empresas)) throw new Error('Elija una empresa de la lista (si no existe, créela primero en Empresas).');
      const v = valoresForm(form);
      delete v.empresa_nombre;
      if (n.valor_desde_cotizaciones) delete v.valor_estimado;
      return negocio ? api.put(`/api/crm/negocios/${negocio.id}`, v) : api.post('/api/crm/negocios', v);
    },
  });
}

// Marca un negocio como ganado o perdido (pide motivo / fecha) o lo mueve de etapa.
export async function moverEtapa(negocio, etapa) {
  const cfg = await configCrm();
  if (etapa === 'Cierre perdido') {
    return abrirFormulario({
      titulo: `Perder: ${negocio.nombre}`, textoGuardar: 'Marcar como perdido',
      campos: [
        { name: 'motivo_perdida', label: 'Motivo', type: 'select', required: true, options: cfg.motivosPerdida, full: true },
        { name: 'fecha', label: 'Fecha de cierre', type: 'date', value: cfg.ahora.slice(0, 10) },
      ],
      alGuardar: (v) => api.put(`/api/crm/negocios/${negocio.id}/etapa`, { etapa, ...v }),
    });
  }
  if (etapa === 'Cierre ganado') {
    return abrirFormulario({
      titulo: `Ganar: ${negocio.nombre}`, textoGuardar: 'Marcar como ganado',
      intro: '<p class="muted">Si el negocio tiene una factura vinculada, la sincronización lo marca ganado sola con la fecha de la factura.</p>',
      campos: [{ name: 'fecha', label: 'Fecha de cierre', type: 'date', value: cfg.ahora.slice(0, 10) }],
      alGuardar: (v) => api.put(`/api/crm/negocios/${negocio.id}/etapa`, { etapa, ...v }),
    });
  }
  return api.put(`/api/crm/negocios/${negocio.id}/etapa`, { etapa });
}

// ---------------------------------------------------------------- actividad
export async function formActividad({ actividad = null, empresaId = null, negocioId = null, contactoId = null, fecha = null, tipo = null } = {}) {
  const [cfg, empresas] = await Promise.all([configCrm(), empresasMin()]);
  const a = actividad || {};
  const hora = fecha && fecha.length > 10 ? fecha : `${fecha || cfg.ahora.slice(0, 10)}T09:00`;
  const empresaIni = a.empresa_id || empresaId;
  const cargarRelacionados = async (form, eid) => {
    const [contactos, negocios] = eid
      ? await Promise.all([api.get(`/api/crm/contactos?empresa_id=${eid}`), api.get(`/api/crm/negocios?empresa_id=${eid}`)])
      : [[], []];
    const selC = form.querySelector('[name=contacto_id]');
    const selN = form.querySelector('[name=negocio_id]');
    const cSel = selC.value || a.contacto_id || contactoId;
    const nSel = selN.value || a.negocio_id || negocioId;
    selC.innerHTML = `<option value="">—</option>${contactos.map((c) => `<option value="${c.id}" ${Number(cSel) === c.id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}`;
    selN.innerHTML = `<option value="">—</option>${negocios.filter((x) => x.abierto || x.id === Number(nSel)).map((x) => `<option value="${x.id}" ${Number(nSel) === x.id ? 'selected' : ''}>${esc(x.nombre)}</option>`).join('')}`;
  };
  return abrirModal({
    titulo: actividad ? `${a.tipo}: ${a.asunto}` : 'Nueva actividad', ancho: 720,
    cuerpo: `<div class="form-grid">
      ${[
        { name: 'tipo', label: 'Tipo', type: 'select', value: a.tipo || tipo || 'Llamada', vacio: false, options: cfg.tiposActividad },
        { name: 'asunto', label: 'Asunto', value: a.asunto, required: true, attrs: 'placeholder="Ej. Visita técnica a la subestación"' },
      ].map(campoHtml).join('')}
      ${campoEmpresa(empresas, empresaIni).replace('Empresa *', 'Empresa')}
      ${[
        { name: 'contacto_id', label: 'Contacto', type: 'select', options: [] },
        { name: 'negocio_id', label: 'Negocio', type: 'select', options: [] },
        { name: 'fecha_programada', label: 'Fecha y hora', type: 'datetime-local', value: a.fecha_programada || hora },
        { name: 'duracion_min', label: 'Duración (min)', type: 'number', value: a.duracion_min || 30, attrs: 'min="5" step="5"' },
        { name: 'responsable_id', label: 'Responsable', type: 'select', value: a.responsable_id, options: opcionesUsuarios(cfg), vacio: 'Yo' },
        { name: 'completada', label: 'Ya se realizó', type: 'checkbox', value: a.completada },
        { name: 'descripcion', label: 'Descripción', type: 'textarea', value: a.descripcion, full: true },
        { name: 'resultado', label: 'Resultado / acuerdos', type: 'textarea', value: a.resultado, full: true, attrs: 'placeholder="Qué se habló, qué se acordó, siguiente paso"' },
      ].map(campoHtml).join('')}
    </div>`,
    alMontar: (form) => {
      const input = form.querySelector('[name=empresa_nombre]');
      input.addEventListener('change', () => { const e = resolverEmpresa(form, empresas); cargarRelacionados(form, e && e.id); });
      cargarRelacionados(form, empresaIni);
      const tipoSel = form.querySelector('[name=tipo]');
      const ajustar = () => { form.querySelector('[name=fecha_programada]').closest('.field').style.opacity = tipoSel.value === 'Nota' ? 0.5 : 1; };
      tipoSel.addEventListener('change', ajustar);
      ajustar();
    },
    alGuardar: async (form) => {
      const nombreEmp = form.querySelector('[name=empresa_nombre]').value.trim();
      if (nombreEmp && !resolverEmpresa(form, empresas)) throw new Error('Elija una empresa de la lista o deje el campo vacío.');
      if (!nombreEmp) form.querySelector('[name=empresa_id]').value = '';
      const v = valoresForm(form);
      delete v.empresa_nombre;
      return actividad ? api.put(`/api/crm/actividades/${actividad.id}`, v) : api.post('/api/crm/actividades', v);
    },
  });
}

// Completar una actividad pendiente con su resultado (y opcionalmente agendar la siguiente).
export async function completarActividad(a) {
  const r = await abrirFormulario({
    titulo: `Completar: ${a.asunto}`, textoGuardar: 'Marcar como realizada',
    campos: [
      { name: 'resultado', label: 'Resultado / acuerdos', type: 'textarea', value: a.resultado, full: true, rows: 4 },
      { name: 'siguiente', label: 'Agendar un seguimiento después de guardar', type: 'checkbox', full: true },
    ],
    alGuardar: async (v) => {
      await api.put(`/api/crm/actividades/${a.id}`, { completada: true, resultado: v.resultado });
      return { siguiente: v.siguiente };
    },
  });
  if (r && r.siguiente) {
    await formActividad({ empresaId: a.empresa_id, negocioId: a.negocio_id, contactoId: a.contacto_id, tipo: 'Llamada' });
  }
  return r;
}

export function filaActividad(a, { isAdmin, mostrarEmpresa = true } = {}) {
  const estado = a.tipo === 'Nota' ? '' : a.completada ? '<span class="badge estado-Aprobada">Realizada</span>' : a.vencida ? '<span class="badge estado-Rechazada">Vencida</span>' : '<span class="badge estado-Enviada">Pendiente</span>';
  return `<div class="act-item ${a.vencida ? 'vencida' : ''} ${a.completada ? 'hecha' : ''}" data-act="${a.id}">
    <div class="act-icono">${ICONO_ACTIVIDAD[a.tipo] || '•'}</div>
    <div class="act-cuerpo">
      <div><strong>${esc(a.asunto)}</strong> ${estado}</div>
      <div class="muted small">${esc(a.tipo)} · ${fechaHora(a.fecha_programada || a.completada_en || a.creado_en)}
        ${mostrarEmpresa && a.empresa_nombre ? ` · <a href="#/crm/empresas/${a.empresa_id}">${esc(a.empresa_nombre)}</a>` : ''}
        ${a.contacto_nombre ? ` · ${esc(a.contacto_nombre)}` : ''}
        ${a.negocio_nombre ? ` · <a href="#/crm/negocios/${a.negocio_id}">${esc(a.negocio_nombre)}</a>` : ''}
        ${a.responsable_nombre ? ` · ${esc(a.responsable_nombre)}` : ''}</div>
      ${a.resultado ? `<div class="small">${esc(a.resultado)}</div>` : a.descripcion ? `<div class="small muted">${esc(a.descripcion)}</div>` : ''}
    </div>
    <div class="act-acciones btn-row">
      ${isAdmin && !a.completada && a.tipo !== 'Nota' ? `<button class="btn btn-secondary btn-sm" data-accion="completar">Completar</button>` : ''}
      ${a.tipo !== 'Nota' && a.fecha_programada ? `<a class="btn btn-secondary btn-sm" href="/api/crm/actividades/${a.id}/ics" title="Descarga un archivo que agrega la actividad a su calendario de Outlook">📅 Outlook</a>` : ''}
      ${isAdmin ? `<button class="btn btn-secondary btn-sm" data-accion="editar">Editar</button><button class="btn btn-secondary btn-sm" data-accion="eliminar" title="Eliminar">✕</button>` : ''}
    </div>
  </div>`;
}

// Conecta los botones de una lista de actividades pintada con filaActividad.
export function conectarActividades(el, actividades, recargar) {
  el.querySelectorAll('.act-item').forEach((item) => {
    const a = actividades.find((x) => x.id === Number(item.dataset.act));
    if (!a) return;
    item.querySelectorAll('button[data-accion]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const acc = b.dataset.accion;
        const r = acc === 'completar' ? await completarActividad(a) : acc === 'eliminar' ? await eliminarActividad(a) : await formActividad({ actividad: a });
        if (r) recargar();
      } catch (e) {
        alert(e.message);
      }
    }));
  });
}

export async function eliminarActividad(a) {
  if (!confirm(`¿Eliminar la actividad "${a.asunto}"?`)) return false;
  await api.del(`/api/crm/actividades/${a.id}`);
  return true;
}

// ---------------------------------------------------------------- conciliacion
// Cotizaciones con una posible factura del mismo cliente y valor. Se marcan de
// entrada solo las seguras (una sola candidata por el valor exacto); la persona
// revisa y confirma.
export async function conciliarFacturas({ isAdmin }) {
  const pares = await api.get('/api/crm/conciliacion');
  let hecho = null;
  await abrirModal({
    titulo: 'Conciliar cotizaciones con facturas', ancho: 1000, soloLectura: !isAdmin || !pares.length, textoGuardar: 'Vincular las seleccionadas',
    cuerpo: pares.length ? `
      <p class="muted">Facturas del mismo cliente, sin cotización vinculada, emitidas hasta 180 días después de la cotización y por el mismo valor (±0,5%).
        La plataforma no las vincula sola: marque las que correspondan. Al vincularlas, el negocio pasa a <strong>Cierre ganado</strong> con la fecha de la factura.</p>
      <div class="btn-row" style="margin-bottom:8px"><button type="button" class="btn btn-secondary btn-sm" id="c-seguras">Marcar solo las seguras</button><button type="button" class="btn btn-secondary btn-sm" id="c-ninguna">Desmarcar todas</button>
        <span class="muted small">${pares.filter((p) => p.unica && p.exacta).length} segura(s) de ${pares.length}</span></div>
      <div class="table-wrap" style="max-height:55vh;overflow:auto"><table class="compacta">
        <thead><tr>${isAdmin ? '<th></th>' : ''}<th>Cotización</th><th>Empresa</th><th>Fecha</th><th class="num">Valor</th><th>Factura</th><th>Fecha factura</th><th class="num">Diferencia</th><th></th></tr></thead>
        <tbody>${pares.map((p, i) => p.facturas.map((f, j) => `<tr>
          ${isAdmin ? `<td><input type="checkbox" name="par" value="${p.cotizacion.id}:${f.id}" data-i="${i}" ${j === 0 && p.unica && p.exacta ? 'checked' : ''} ${p.facturas.length > 1 ? `data-grupo="${i}"` : ''}></td>` : ''}
          <td>${j === 0 ? `<a href="#/cotizaciones/${p.cotizacion.id}" target="_blank">${esc(p.cotizacion.numero)}</a>` : ''}</td>
          <td class="small">${j === 0 ? esc(p.cotizacion.empresa_nombre) : ''}</td>
          <td>${j === 0 ? fmtDMY(p.cotizacion.fecha_cotizacion) : ''}</td>
          <td class="num">${j === 0 ? money(p.cotizacion.precio_venta) : ''}</td>
          <td>${esc(f.numero)}${f.titulo ? `<div class="small muted">${esc(f.titulo)}</div>` : ''}</td>
          <td>${fmtDMY(f.fecha)} <span class="muted small">(+${f.dias} d)</span></td>
          <td class="num">${f.diferencia ? money(f.diferencia) : '<span class="chip">exacta</span>'}</td>
          <td>${j === 0 ? (p.unica ? (p.exacta ? '<span class="chip" style="background:var(--good-bg);color:var(--good)">segura</span>' : '') : '<span class="chip ambar">varias candidatas</span>') : ''}</td>
        </tr>`).join('')).join('')}</tbody></table></div>`
      : '<div class="empty-state">No hay cotizaciones con posibles facturas por conciliar.</div>',
    alMontar: (form) => {
      const s = form.querySelector('#c-seguras');
      if (s) {
        s.addEventListener('click', () => form.querySelectorAll('input[name=par]').forEach((c) => { const p = pares[Number(c.dataset.i)]; c.checked = p.unica && p.exacta && !c.dataset.grupo; }));
        form.querySelector('#c-ninguna').addEventListener('click', () => form.querySelectorAll('input[name=par]').forEach((c) => { c.checked = false; }));
        // Una cotizacion solo puede quedar con una de sus facturas candidatas.
        form.querySelectorAll('input[data-grupo]').forEach((c) => c.addEventListener('change', () => {
          if (c.checked) form.querySelectorAll(`input[data-grupo="${c.dataset.grupo}"]`).forEach((o) => { if (o !== c) o.checked = false; });
        }));
      }
    },
    alGuardar: async (form) => {
      const sel = [...form.querySelectorAll('input[name=par]:checked')].map((c) => { const [cotizacion_id, factura_id] = c.value.split(':').map(Number); return { cotizacion_id, factura_id }; });
      const usadas = new Set();
      for (const p of sel) {
        if (usadas.has(p.factura_id)) throw new Error('Una misma factura quedó marcada para dos cotizaciones: deje solo una.');
        usadas.add(p.factura_id);
      }
      if (!sel.length) throw new Error('No marcó ninguna pareja.');
      hecho = await api.post('/api/crm/conciliacion', { pares: sel });
    },
  });
  if (hecho) alert(`${hecho.vinculadas} factura(s) vinculada(s); ${hecho.negociosAvanzados} negocio(s) cambiaron de etapa.${hecho.errores.length ? '\n\n' + hecho.errores.join('\n') : ''}`);
  return hecho;
}

// Descarga de archivos (Excel) desde la API usando la sesion.
export function descargar(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
