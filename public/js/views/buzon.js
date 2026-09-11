import { api } from '../api.js';
import { money, fmtDMY, esc } from '../format.js';
import { stillMounted } from '../guard.js';

// Buzon: lo que llega por el correo de Outlook (lib/correo-sync.js).
//   Ofertas            solicitudes de clientes, invitaciones a licitar y
//                      cotizaciones de proveedores: Pendiente -> Cotizada -> Cumplida
//   Ordenes de compra  OC recibidas, con su cotizacion y la factura que las cobra
//   Registro           que se leyo y como lo clasifico la IA (solo admin)

let pestana = 'ofertas';
let filtroEstado = 'abiertas';

const TIPO_LABEL = {
  cotizacion_propia: 'Cotización propia', cotizacion_siigo: 'Cotización Siigo', solicitud_cliente: 'Solicitud de cliente',
  invitacion_licitar: 'Invitación a licitar', cotizacion_proveedor: 'Cotización de proveedor', orden_compra: 'Orden de compra', otro: 'Otro',
};
const ESTADO_CLASE = { Pendiente: 'estado-Enviada', Cotizada: 'estado-Ejecutada', Cumplida: 'estado-Aprobada', Descartada: 'estado-Borrador' };

const outlook = (url) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">Abrir en Outlook</a>` : '');

export async function renderBuzon(content, state) {
  content.innerHTML = '<div class="spinner-msg">Cargando buzón…</div>';
  const isAdmin = state.usuario.rol === 'admin';
  const [ofertas, ordenes, estado, registro] = await Promise.all([
    api.get('/api/buzon'),
    api.get('/api/ordenes-compra'),
    isAdmin ? api.get('/api/correo/estado').catch(() => null) : Promise.resolve(null),
    isAdmin && pestana === 'registro' ? api.get('/api/correo/mensajes?limite=300').catch(() => []) : Promise.resolve([]),
  ]);
  if (!stillMounted(content)) return;

  const abiertas = ofertas.filter((o) => ['Pendiente', 'Cotizada'].includes(o.estado));
  const pendientes = ofertas.filter((o) => o.estado === 'Pendiente');
  const vencidas = pendientes.filter((o) => o.vencida);
  const ocSinFactura = ordenes.filter((o) => !o.facturas.length);

  content.innerHTML = `
    <div class="toolbar">
      <h1 class="mt-0">Buzón</h1>
      ${isAdmin ? '<div class="btn-row"><button class="btn btn-secondary btn-sm" id="btn-leer-correo">Leer correo ahora</button></div>' : ''}
    </div>
    ${isAdmin ? avisoEstado(estado) : ''}
    <div class="kpi-grid">
      <div class="kpi"><div class="label">Ofertas pendientes</div><div class="value">${pendientes.length}</div></div>
      <div class="kpi ${vencidas.length ? 'alerta' : ''}"><div class="label">Con fecha límite vencida</div><div class="value">${vencidas.length}</div></div>
      <div class="kpi"><div class="label">Cotizadas sin cumplir</div><div class="value">${abiertas.length - pendientes.length}</div></div>
      <div class="kpi"><div class="label">OC sin factura</div><div class="value">${ocSinFactura.length}</div></div>
    </div>
    <div class="tabs">
      <button data-p="ofertas" class="${pestana === 'ofertas' ? 'active' : ''}">Ofertas (${abiertas.length} abiertas)</button>
      <button data-p="ordenes" class="${pestana === 'ordenes' ? 'active' : ''}">Órdenes de compra (${ordenes.length})</button>
      ${isAdmin ? `<button data-p="registro" class="${pestana === 'registro' ? 'active' : ''}">Registro del correo</button>` : ''}
    </div>
    <div id="buzon-cuerpo"></div>
  `;

  content.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { pestana = b.dataset.p; renderBuzon(content, state); }));
  const btnLeer = document.getElementById('btn-leer-correo');
  if (btnLeer) {
    btnLeer.addEventListener('click', async () => {
      btnLeer.disabled = true;
      btnLeer.textContent = 'Leyendo…';
      try {
        const r = await api.post('/api/correo/ejecutar');
        alert(r.omitida ? r.motivo : 'Lectura iniciada. En unos minutos aparecen los correos nuevos; recargue esta página.');
      } catch (e) {
        alert('No se pudo leer el correo: ' + e.message);
      }
      btnLeer.disabled = false;
      btnLeer.textContent = 'Leer correo ahora';
    });
  }

  const cuerpo = document.getElementById('buzon-cuerpo');
  if (pestana === 'ofertas') pintarOfertas(cuerpo, ofertas, isAdmin, () => renderBuzon(content, state));
  else if (pestana === 'ordenes') pintarOrdenes(cuerpo, ordenes, isAdmin, () => renderBuzon(content, state));
  else pintarRegistro(cuerpo, registro);
}

function avisoEstado(e) {
  if (!e) return '';
  if (!e.configurado) {
    return '<div class="card"><div class="empty-state">La lectura del correo todavía no está conectada. El administrador de Microsoft 365 debe registrar la aplicación y cargar en Railway MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET y CORREO_BUZONES (ver docs/conectar-outlook.md).</div></div>';
  }
  const partes = [`Buzones: ${esc((e.buzones || []).join(', '))}`];
  if (e.ejecutando) partes.push(`Leyendo ahora: ${esc(e.paso || '')}`);
  if (e.ultimaEjecucion) partes.push(`Última lectura: ${esc(new Date(e.ultimaEjecucion).toLocaleString('es-CO'))}`);
  if (e.proximaEjecucion) partes.push(`Próxima: ${esc(new Date(e.proximaEjecucion).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }))}`);
  if (e.ultimoError) partes.push(`<span style="color:#d03b3b">Error: ${esc(e.ultimoError)}</span>`);
  return `<p class="muted">${partes.join(' · ')}</p>`;
}

function pintarOfertas(el, ofertas, isAdmin, recargar) {
  const lista = ofertas.filter((o) => (filtroEstado === 'abiertas' ? ['Pendiente', 'Cotizada'].includes(o.estado) : filtroEstado === 'todas' ? true : o.estado === filtroEstado));
  el.innerHTML = `
    <div class="card">
      <div class="filters">
        <div class="field"><label>Mostrar</label>
          <select id="f-estado">
            ${[['abiertas', 'Abiertas (pendientes y cotizadas)'], ['Pendiente', 'Pendientes'], ['Cotizada', 'Cotizadas'], ['Cumplida', 'Cumplidas'], ['Descartada', 'Descartadas'], ['todas', 'Todas']]
              .map(([v, l]) => `<option value="${v}" ${filtroEstado === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </div>
      ${lista.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Tipo</th><th>Empresa / remitente</th><th>Asunto</th><th>Recibido</th><th>Días</th><th>Fecha límite</th><th>Estado</th><th>Cotización</th><th></th></tr></thead>
        <tbody>${lista.map((o) => `
          <tr>
            <td><span class="pill">${esc(o.tipo)}</span></td>
            <td>${esc(o.empresa || '')}<div class="muted" style="font-size:12px">${esc(o.remitente || '')}</div></td>
            <td>${esc(o.asunto || '')}${o.resumen ? `<div class="muted" style="font-size:12px">${esc(o.resumen)}</div>` : ''}
              ${o.tipo === 'Proveedor' && o.valor ? `<div style="font-size:12px">Valor: ${money(o.valor)}</div>` : ''}</td>
            <td>${fmtDMY(o.fecha_recibido)}</td>
            <td class="num">${o.dias ?? ''}</td>
            <td style="${o.vencida ? 'color:#d03b3b;font-weight:600' : ''}">${o.fecha_limite ? fmtDMY(o.fecha_limite) : ''}</td>
            <td><span class="badge ${ESTADO_CLASE[o.estado] || ''}">${esc(o.estado)}</span></td>
            <td>${o.cotizacion_numero ? `<a href="#/cotizaciones/${o.cotizacion_id}">${esc(o.cotizacion_numero)}</a>` : ''}</td>
            <td style="white-space:nowrap">${outlook(o.web_link)}
              ${isAdmin ? `<div class="btn-row" style="margin-top:4px">
                ${o.tipo !== 'Proveedor' ? `<button class="btn btn-secondary btn-sm" data-accion="vincular" data-id="${o.id}">Vincular cotización</button>` : ''}
                ${o.estado !== 'Cumplida' ? `<button class="btn btn-secondary btn-sm" data-accion="cumplida" data-id="${o.id}">Cumplida</button>` : ''}
                ${o.estado !== 'Descartada' ? `<button class="btn btn-secondary btn-sm" data-accion="descartar" data-id="${o.id}">Descartar</button>` : ''}
              </div>` : ''}</td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">No hay ofertas en este filtro.</div>'}
    </div>`;
  el.querySelector('#f-estado').addEventListener('change', (e) => { filtroEstado = e.target.value; pintarOfertas(el, ofertas, isAdmin, recargar); });
  el.querySelectorAll('button[data-accion]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.id;
    let cuerpo;
    if (btn.dataset.accion === 'vincular') {
      const numero = prompt('Número de la cotización con que se respondió (por ejemplo C-1-235):');
      if (numero === null) return;
      cuerpo = { cotizacion_numero: numero };
    } else if (btn.dataset.accion === 'cumplida') cuerpo = { estado: 'Cumplida' };
    else cuerpo = { estado: 'Descartada' };
    try {
      await api.put(`/api/buzon/${id}`, cuerpo);
      recargar();
    } catch (e) {
      alert(e.message);
    }
  }));
}

function pintarOrdenes(el, ordenes, isAdmin, recargar) {
  el.innerHTML = `
    <div class="card">
      ${ordenes.length ? `<div class="table-wrap"><table>
        <thead><tr><th>OC</th><th>Cliente</th><th>Fecha</th><th class="num">Valor</th><th>Descripción</th><th>Cotización</th><th>Factura(s)</th><th></th></tr></thead>
        <tbody>${ordenes.map((o) => `
          <tr style="${!o.facturas.length && o.dias_sin_factura > 30 ? 'background:#fdecec' : ''}">
            <td><strong>${esc(o.numero)}</strong></td>
            <td>${esc(o.cliente || '')}</td>
            <td>${fmtDMY(o.fecha)}</td>
            <td class="num">${o.valor != null ? money(o.valor) : ''}</td>
            <td>${esc(o.descripcion || '')}${o.adjunto ? `<div class="muted" style="font-size:12px">${esc(o.adjunto)}</div>` : ''}</td>
            <td>${o.cotizacion_numero ? `<a href="#/cotizaciones/${o.cotizacion_id}">${esc(o.cotizacion_numero)}</a>` : (isAdmin ? `<button class="btn btn-secondary btn-sm" data-oc="${o.id}">Vincular</button>` : '')}</td>
            <td>${o.facturas.length ? o.facturas.map((f) => `${esc(f.numero)} <span class="muted">(${esc(f.estado || '')})</span>`).join('<br>') : `<span class="muted">Sin factura${o.dias_sin_factura != null ? ` · ${o.dias_sin_factura} d` : ''}</span>`}</td>
            <td>${outlook(o.web_link)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">Todavía no han llegado órdenes de compra por correo.</div>'}
    </div>`;
  el.querySelectorAll('button[data-oc]').forEach((btn) => btn.addEventListener('click', async () => {
    const numero = prompt('Número de la cotización de esta orden de compra (por ejemplo C-1-235):');
    if (!numero) return;
    try {
      await api.put(`/api/ordenes-compra/${btn.dataset.oc}`, { cotizacion_numero: numero });
      recargar();
    } catch (e) {
      alert(e.message);
    }
  }));
}

function pintarRegistro(el, registro) {
  el.innerHTML = `
    <div class="card">
      <p class="muted">Correos que pasaron el filtro (con palabras de negocio o documentos adjuntos), cómo los clasificó la IA y qué se hizo con cada uno.</p>
      ${registro.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Buzón</th><th>Carpeta</th><th>Remitente</th><th>Asunto</th><th>Tipo</th><th>Acción</th><th></th></tr></thead>
        <tbody>${registro.map((m) => `
          <tr>
            <td style="white-space:nowrap">${m.fecha ? esc(new Date(m.fecha).toLocaleString('es-CO')) : ''}</td>
            <td>${esc((m.buzon || '').split('@')[0])}</td>
            <td>${m.carpeta === 'sentitems' ? 'Enviados' : 'Recibidos'}</td>
            <td>${esc(m.remitente || '')}</td>
            <td>${esc(m.asunto || '')}${m.adjuntos ? `<div class="muted" style="font-size:12px">${esc(m.adjuntos)}</div>` : ''}</td>
            <td>${esc(TIPO_LABEL[m.tipo] || m.tipo || '')}</td>
            <td>${m.estado === 'error' ? `<span style="color:#d03b3b">Error: ${esc(m.error || '')}</span>` : esc(m.accion || '')}</td>
            <td>${outlook(m.web_link)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">Todavía no se ha leído ningún correo.</div>'}
    </div>`;
}
