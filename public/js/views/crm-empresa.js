import { api } from '../api.js';
import { money, fmtDMY, pct, esc, SEMAFORO_LABEL, SEMAFORO_CLASS } from '../format.js';
import { stillMounted } from '../guard.js';
import {
  subnavCrm, configCrm, badgeTipoEmpresa, badgeEtapa, millones, fechaHora, formEmpresa, formContacto, formNegocio,
  formActividad, filaActividad, conectarActividades, olvidarEmpresas, ICONO_ACTIVIDAD,
} from './crm-comun.js';

// Ficha 360 de una empresa: todo lo que PROENERGY sabe de ese cliente en un lugar.

let pestana = 'resumen';
let empresaActual = null;

const ICONO_LINEA = { actividad: '', etapa: '📈', cotizacion: '📄', factura: '💵', oc: '🧾', buzon: '📥', correo: '✉️' };
const outlook = (url) => (url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">Abrir en Outlook</a>` : '');

export async function renderCrmEmpresa(content, state, id) {
  const isAdmin = state.usuario.rol === 'admin';
  if (empresaActual !== id) { pestana = 'resumen'; empresaActual = id; }
  content.innerHTML = `${subnavCrm('empresas')}<div class="spinner-msg">Cargando empresa…</div>`;
  const [, f] = await Promise.all([configCrm(), api.get(`/api/crm/empresas/${id}/360`)]);
  if (!stillMounted(content)) return;
  const { empresa: e, kpis: k } = f;
  const recargar = () => renderCrmEmpresa(content, state, id);

  const pestanas = [
    ['resumen', 'Resumen'], ['contactos', `Contactos (${f.contactos.length})`], ['negocios', `Negocios (${f.negocios.length})`],
    ['linea', 'Línea de tiempo'], ['documentos', `Cotizaciones y facturas (${f.cotizaciones.length + f.facturas.length})`], ['correos', `Correos (${f.correos.length})`],
  ];

  content.innerHTML = `
    ${subnavCrm('empresas')}
    <div class="breadcrumb"><a href="#/crm/empresas">Empresas</a> / ${esc(e.nombre)}</div>
    ${!isAdmin ? '<div class="readonly-banner">Modo de solo lectura — Gerencia.</div>' : ''}
    <div class="toolbar">
      <div>
        <h1 class="mt-0">${esc(e.nombre)}</h1>
        ${badgeTipoEmpresa(e.tipo)}
        ${e.nit ? `<span class="pill">NIT ${esc(e.nit)}</span>` : ''}
        ${e.sector ? `<span class="pill">${esc(e.sector)}</span>` : ''}
        ${e.ciudad ? `<span class="pill">${esc(e.ciudad)}</span>` : ''}
        ${e.responsable_nombre ? `<span class="pill">Responsable: ${esc(e.responsable_nombre)}</span>` : ''}
      </div>
      ${isAdmin ? `<div class="btn-row">
        <button class="btn btn-secondary btn-sm" id="b-editar">Editar</button>
        <button class="btn btn-secondary btn-sm" id="b-contacto">+ Contacto</button>
        <button class="btn btn-secondary btn-sm" id="b-actividad">+ Actividad</button>
        <button class="btn btn-primary btn-sm" id="b-negocio">+ Negocio</button>
      </div>` : ''}
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="label">Facturado histórico</div><div class="value" title="${money(k.facturado)}">${millones(k.facturado)}</div><div class="sub">${k.n_facturas} factura(s) · 12 m: ${millones(k.facturado_12m)}</div></div>
      <div class="kpi ${k.cartera_vencida > 0.5 ? 'alerta' : ''}"><div class="label">Cartera</div><div class="value" title="${money(k.cartera)}">${millones(k.cartera)}</div><div class="sub">${k.cartera_vencida > 0.5 ? `${millones(k.cartera_vencida)} vencida` : 'sin cartera vencida'}</div></div>
      <div class="kpi"><div class="label">Pipeline abierto</div><div class="value" title="${money(k.pipeline_sin_iva)}">${millones(k.pipeline_sin_iva)}</div><div class="sub">${k.negocios_abiertos} negocio(s) · sin IVA</div></div>
      <div class="kpi"><div class="label">Cotizado</div><div class="value" title="${money(k.cotizado_con_iva)}">${millones(k.cotizado_con_iva)}</div><div class="sub">${k.n_cotizaciones} cotización(es) · con IVA</div></div>
      <div class="kpi"><div class="label">Tasa de cierre</div><div class="value">${k.tasa_cierre != null ? pct(k.tasa_cierre) : '—'}</div><div class="sub">${k.ganados} ganado(s) · ${k.perdidos} perdido(s)</div></div>
      <div class="kpi"><div class="label">Último contacto</div><div class="value" style="font-size:18px">${k.ultimo_contacto ? fmtDMY(k.ultimo_contacto) : '—'}</div><div class="sub">${k.ticket_promedio ? `ticket promedio ${millones(k.ticket_promedio)}` : ''}</div></div>
    </div>

    <div class="tabs">${pestanas.map(([p, l]) => `<button data-p="${p}" class="${pestana === p ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="emp-cuerpo"></div>`;

  content.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { pestana = b.dataset.p; pintar(); content.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b)); }));
  const cuerpo = document.getElementById('emp-cuerpo');
  const pintar = () => {
    if (pestana === 'resumen') pintarResumen(cuerpo, f, isAdmin, recargar);
    else if (pestana === 'contactos') pintarContactos(cuerpo, f, isAdmin, recargar);
    else if (pestana === 'negocios') pintarNegocios(cuerpo, f);
    else if (pestana === 'linea') pintarLinea(cuerpo, f, isAdmin, recargar);
    else if (pestana === 'documentos') pintarDocumentos(cuerpo, f);
    else pintarCorreos(cuerpo, f);
  };
  pintar();

  if (!isAdmin) return;
  document.getElementById('b-editar').addEventListener('click', async () => { if (await formEmpresa(e)) recargar(); });
  document.getElementById('b-contacto').addEventListener('click', async () => { if (await formContacto({ empresaId: e.id })) recargar(); });
  document.getElementById('b-actividad').addEventListener('click', async () => { if (await formActividad({ empresaId: e.id })) recargar(); });
  document.getElementById('b-negocio').addEventListener('click', async () => { const r = await formNegocio({ empresaId: e.id }); if (r && r.id) location.hash = `#/crm/negocios/${r.id}`; });
}

function pintarResumen(el, f, isAdmin, recargar) {
  const e = f.empresa;
  const abiertos = f.negocios.filter((n) => n.abierto);
  const pendientes = f.actividades.filter((a) => !a.completada && a.tipo !== 'Nota').reverse();
  const recientes = f.actividades.filter((a) => a.completada || a.tipo === 'Nota').slice(0, 5);
  el.innerHTML = `
    <div class="grid-2">
      <div class="card"><h3>Datos de la empresa</h3>
        <dl class="datos">
          <dt>Dirección</dt><dd>${esc(e.direccion || '—')}</dd>
          <dt>Teléfono</dt><dd>${e.telefono ? `<a href="tel:${esc(e.telefono)}">${esc(e.telefono)}</a>` : '—'}</dd>
          <dt>Sitio web</dt><dd>${e.web ? `<a href="${esc(/^https?:/.test(e.web) ? e.web : 'https://' + e.web)}" target="_blank" rel="noopener">${esc(e.web)}</a>` : '—'}</dd>
          <dt>Dominio de correo</dt><dd>${esc(e.dominio_correo || '—')}</dd>
          <dt>Origen</dt><dd>${esc(e.origen || '—')}</dd>
          <dt>Cliente desde</dt><dd>${f.kpis.primera_factura ? fmtDMY(f.kpis.primera_factura) : '—'}</dd>
          <dt>Última factura</dt><dd>${f.kpis.ultima_factura ? fmtDMY(f.kpis.ultima_factura) : '—'}</dd>
          <dt>Notas</dt><dd class="pre">${esc(e.notas || '—')}</dd>
        </dl>
        ${isAdmin ? '<div class="btn-row"><button class="btn btn-danger btn-sm" id="b-eliminar-emp">Eliminar empresa</button></div>' : ''}
      </div>
      <div class="card"><h3>Contactos</h3>
        ${f.contactos.length ? f.contactos.slice(0, 6).map((c) => `<div class="contacto-mini"><strong>${esc(c.nombre)}</strong>${c.es_principal ? ' <span class="chip">principal</span>' : ''}
          <div class="small muted">${[c.cargo, c.rol].filter(Boolean).map(esc).join(' · ')}</div>
          <div class="small">${[c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '', c.celular ? `<a href="https://wa.me/57${esc(String(c.celular).replace(/\D/g, '').replace(/^57/, ''))}" target="_blank" rel="noopener">${esc(c.celular)}</a>` : '', c.telefono ? esc(c.telefono) : ''].filter(Boolean).join(' · ')}</div></div>`).join('')
          : '<div class="empty-state">Sin contactos registrados.</div>'}
      </div>
    </div>
    <div class="grid-2">
      <div class="card"><h3>Negocios abiertos</h3>
        ${abiertos.length ? `<div class="table-wrap"><table class="compacta"><thead><tr><th>Negocio</th><th>Etapa</th><th class="num">Sin IVA</th><th>Cierre esperado</th></tr></thead>
          <tbody>${abiertos.map((n) => `<tr><td><a href="#/crm/negocios/${n.id}">${esc(n.nombre)}</a></td><td>${badgeEtapa(n.etapa)}</td><td class="num">${money(n.valor_sin_iva)}</td><td>${n.fecha_cierre_esperada ? fmtDMY(n.fecha_cierre_esperada) : '<span class="tenue">—</span>'}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="empty-state">No hay negocios abiertos con esta empresa.</div>'}
      </div>
      <div class="card"><h3>Próximas actividades</h3><div id="emp-pend">
        ${pendientes.length ? pendientes.map((a) => filaActividad(a, { isAdmin, mostrarEmpresa: false })).join('') : '<div class="empty-state">Nada programado.</div>'}</div>
        <h3 style="margin-top:14px">Últimos contactos</h3><div id="emp-rec">
        ${recientes.length ? recientes.map((a) => filaActividad(a, { isAdmin, mostrarEmpresa: false })).join('') : '<div class="empty-state">Sin llamadas, visitas ni notas registradas.</div>'}</div>
      </div>
    </div>`;
  conectarActividades(el.querySelector('#emp-pend'), pendientes, recargar);
  conectarActividades(el.querySelector('#emp-rec'), recientes, recargar);
  const bEl = el.querySelector('#b-eliminar-emp');
  if (bEl) bEl.addEventListener('click', async () => {
    if (!confirm(`¿Eliminar ${e.nombre}? Solo es posible si no tiene cotizaciones, facturas, OC ni negocios.`)) return;
    try { await api.del(`/api/crm/empresas/${e.id}`); olvidarEmpresas(); location.hash = '#/crm/empresas'; } catch (err) { alert(err.message); }
  });
}

function pintarContactos(el, f, isAdmin, recargar) {
  el.innerHTML = `<div class="card">${f.contactos.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Nombre</th><th>Cargo</th><th>Rol</th><th>Correo</th><th>Teléfono</th><th>Celular</th><th>Notas</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
    <tbody>${f.contactos.map((c) => `<tr><td><strong>${esc(c.nombre)}</strong>${c.es_principal ? ' <span class="chip">principal</span>' : ''}</td><td>${esc(c.cargo || '')}</td><td>${esc(c.rol || '')}</td>
      <td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</td><td>${esc(c.telefono || '')}</td><td>${esc(c.celular || '')}</td><td class="small">${esc(c.notas || '')}</td>
      ${isAdmin ? `<td style="white-space:nowrap"><button class="btn btn-secondary btn-sm" data-editar="${c.id}">Editar</button> <button class="btn btn-secondary btn-sm" data-borrar="${c.id}">✕</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`
    : '<div class="empty-state">Sin contactos. Agregue a quien decide, al técnico y a compras: con su correo, la plataforma enlaza sola los correos de Outlook.</div>'}</div>`;
  el.querySelectorAll('button[data-editar]').forEach((b) => b.addEventListener('click', async () => {
    if (await formContacto({ contacto: f.contactos.find((c) => c.id === Number(b.dataset.editar)) })) recargar();
  }));
  el.querySelectorAll('button[data-borrar]').forEach((b) => b.addEventListener('click', async () => {
    const c = f.contactos.find((x) => x.id === Number(b.dataset.borrar));
    if (!confirm(`¿Quitar a ${c.nombre} de los contactos?`)) return;
    try { await api.del(`/api/crm/contactos/${c.id}`); recargar(); } catch (err) { alert(err.message); }
  }));
}

function pintarNegocios(el, f) {
  el.innerHTML = `<div class="card">${f.negocios.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Negocio</th><th>Etapa</th><th class="num">Valor sin IVA</th><th>Cotizaciones</th><th>Inicio</th><th>Cierre esperado</th><th>Cierre real</th></tr></thead>
    <tbody>${f.negocios.map((n) => `<tr><td><a href="#/crm/negocios/${n.id}">${esc(n.nombre)}</a></td><td>${badgeEtapa(n.etapa)}${n.etapa === 'Cierre perdido' && n.motivo_perdida ? `<div class="small muted">${esc(n.motivo_perdida)}</div>` : ''}</td>
      <td class="num">${money(n.valor_sin_iva)}</td><td>${n.cotizaciones.map((c) => `<a href="#/cotizaciones/${c.id}">${esc(c.numero)}</a>`).join(', ')}</td>
      <td>${fmtDMY(n.fecha_inicio)}</td><td>${n.fecha_cierre_esperada ? fmtDMY(n.fecha_cierre_esperada) : ''}</td><td>${n.fecha_cierre_real ? fmtDMY(n.fecha_cierre_real) : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty-state">Sin negocios con esta empresa.</div>'}</div>`;
}

function pintarLinea(el, f, isAdmin, recargar) {
  el.innerHTML = `
    ${isAdmin ? `<div class="card"><form id="f-nota" class="nota-rapida">
      <select name="tipo">${['Nota', 'Llamada', 'Visita', 'Reunión', 'WhatsApp', 'Correo'].map((t) => `<option>${t}</option>`).join('')}</select>
      <input name="asunto" placeholder="Registrar rápido: qué pasó con este cliente (queda como realizada hoy)">
      <button class="btn btn-primary btn-sm">Registrar</button></form></div>` : ''}
    <div class="card">${f.linea.length ? `<ul class="linea-tiempo">${f.linea.map((x) => `
      <li class="lt-${x.clase}">
        <div class="lt-fecha">${fechaHora(x.fecha)}</div>
        <div class="lt-cuerpo">
          <div>${x.clase === 'actividad' ? ICONO_ACTIVIDAD[x.tipo] || '' : ICONO_LINEA[x.clase]} ${x.enlace ? `<a href="${esc(x.enlace)}">${esc(x.titulo)}</a>` : `<strong>${esc(x.titulo)}</strong>`}
            ${x.estado ? `<span class="chip">${esc(x.estado)}</span>` : ''} ${x.valor ? `<span class="muted">${money(x.valor)}</span>` : ''}</div>
          ${x.detalle || x.web_link ? `<div class="small muted">${esc(x.detalle || '')}${outlook(x.web_link)}</div>` : ''}
        </div></li>`).join('')}</ul>` : '<div class="empty-state">Todavía no hay historia con esta empresa.</div>'}</div>`;
  const form = el.querySelector('#f-nota');
  if (form) form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const asunto = form.asunto.value.trim();
    if (!asunto) return;
    try {
      const cfg = await configCrm();
      await api.post('/api/crm/actividades', { tipo: form.tipo.value, asunto, empresa_id: f.empresa.id, completada: true, fecha_programada: cfg.ahora });
      recargar();
    } catch (err) { alert(err.message); }
  });
}

function pintarDocumentos(el, f) {
  el.innerHTML = `
    <div class="card"><h3>Cotizaciones</h3>${f.cotizaciones.length ? `<div class="table-wrap"><table class="compacta">
      <thead><tr><th>Número</th><th>Fecha</th><th>Actividad</th><th>Estado</th><th class="num">Con IVA</th><th>Semáforo</th><th>Pago</th><th>Negocio</th></tr></thead>
      <tbody>${f.cotizaciones.map((c) => `<tr><td><a href="#/cotizaciones/${c.id}">${esc(c.numero)}</a></td><td>${fmtDMY(c.fecha_cotizacion)}</td>
        <td class="small">${esc(c.titulo || (c.descripcion || '').slice(0, 80))}</td><td><span class="badge estado-${esc(c.estado)}">${esc(c.estado)}</span></td>
        <td class="num">${money(c.con)}</td><td><span class="sem ${SEMAFORO_CLASS[c.semaforo] || ''}">${SEMAFORO_LABEL[c.semaforo] || ''}</span></td>
        <td class="small">${esc(c.estadoPago || '')}</td><td>${c.negocio_id ? `<a href="#/crm/negocios/${c.negocio_id}">Ver</a>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">Sin cotizaciones.</div>'}</div>
    <div class="card"><h3>Facturas</h3>${f.facturas.length ? `<div class="table-wrap"><table class="compacta">
      <thead><tr><th>Número</th><th>Fecha</th><th>Vence</th><th>Actividad</th><th>Orden</th><th class="num">Total</th><th class="num">Saldo</th><th>Estado</th><th>Cotización</th></tr></thead>
      <tbody>${f.facturas.map((x) => `<tr style="${x.anulada ? 'opacity:.5' : ''}"><td>${esc(x.numero)}</td><td>${fmtDMY(x.fecha)}</td><td>${x.vencimiento ? fmtDMY(x.vencimiento) : ''}</td>
        <td class="small">${esc(x.titulo || '')}</td><td class="small">${esc(x.orden || '')}</td><td class="num">${money(x.total)}</td><td class="num">${x.saldo > 0.5 ? money(x.saldo) : ''}</td>
        <td>${esc(x.estado || '')}</td><td>${x.cotizacion_id ? `<a href="#/cotizaciones/${x.cotizacion_id}">${esc(x.cotizacion_numero)}</a>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">Sin facturas.</div>'}</div>
    <div class="grid-2">
      <div class="card"><h3>Órdenes de compra</h3>${f.ordenes.length ? `<div class="table-wrap"><table class="compacta"><thead><tr><th>OC</th><th>Fecha</th><th class="num">Valor</th><th>Cotización</th></tr></thead>
        <tbody>${f.ordenes.map((o) => `<tr><td>${esc(o.numero)}${o.web_link ? ` <a href="${esc(o.web_link)}" target="_blank" rel="noopener" class="small">Outlook</a>` : ''}</td><td>${fmtDMY(o.fecha)}</td><td class="num">${o.valor != null ? money(o.valor) : ''}</td><td>${o.cotizacion_numero ? `<a href="#/cotizaciones/${o.cotizacion_id}">${esc(o.cotizacion_numero)}</a>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">Sin órdenes de compra recibidas por correo.</div>'}</div>
      <div class="card"><h3>Solicitudes del buzón</h3>${f.buzon.length ? `<div class="table-wrap"><table class="compacta"><thead><tr><th>Tipo</th><th>Asunto</th><th>Recibido</th><th>Estado</th></tr></thead>
        <tbody>${f.buzon.map((b) => `<tr><td>${esc(b.tipo)}</td><td>${esc(b.asunto || '')}${b.web_link ? ` <a href="${esc(b.web_link)}" target="_blank" rel="noopener" class="small">Outlook</a>` : ''}</td><td>${fmtDMY(b.fecha_recibido)}</td><td>${esc(b.estado)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">Sin solicitudes recibidas.</div>'}</div>
    </div>`;
}

function pintarCorreos(el, f) {
  el.innerHTML = `<div class="card">
    <p class="muted small">Correos de Outlook que la plataforma ya leyó y enlazó con esta empresa: por el correo de sus contactos, por el dominio de la empresa o porque generaron una cotización, OC o solicitud. Solo lectura: la plataforma no envía correos.</p>
    ${f.correos.length ? `<div class="table-wrap"><table class="compacta"><thead><tr><th>Fecha</th><th></th><th>De / para</th><th>Asunto</th><th>Qué se hizo</th><th></th></tr></thead>
      <tbody>${f.correos.map((m) => `<tr><td style="white-space:nowrap">${m.fecha ? esc(new Date(m.fecha).toLocaleString('es-CO')) : ''}</td><td>${m.carpeta === 'sentitems' ? 'Enviado' : 'Recibido'}</td>
        <td class="small">${esc(m.carpeta === 'sentitems' ? m.destinatarios || '' : m.remitente || '')}${m.contacto_nombre ? `<div class="muted">${esc(m.contacto_nombre)}</div>` : ''}</td>
        <td>${esc(m.asunto || '')}${m.adjuntos ? `<div class="small muted">${esc(m.adjuntos)}</div>` : ''}</td><td class="small">${esc(m.accion || '')}</td>
        <td>${m.web_link ? `<a href="${esc(m.web_link)}" target="_blank" rel="noopener">Abrir</a>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty-state">No hay correos enlazados. Cuando el correo de Outlook esté conectado, aparecerán aquí los de los contactos y el dominio de esta empresa.</div>'}
  </div>`;
}
