import { api } from '../api.js';
import { money, fmtDMY, pct, esc } from '../format.js';
import { stillMounted } from '../guard.js';
import { subnavCrm, configCrm, badgeEtapa, barraEtapas, formNegocio, moverEtapa, formActividad, filaActividad, conectarActividades, fechaHora } from './crm-comun.js';

// Detalle de un negocio: etapas, datos, cotizaciones vinculadas, actividades e historial.

export async function renderCrmNegocio(content, state, id) {
  const isAdmin = state.usuario.rol === 'admin';
  content.innerHTML = `${subnavCrm('negocios')}<div class="spinner-msg">Cargando negocio…</div>`;
  const [, n] = await Promise.all([configCrm(), api.get(`/api/crm/negocios/${id}`)]);
  if (!stillMounted(content)) return;
  const recargar = () => renderCrmNegocio(content, state, id);

  content.innerHTML = `
    ${subnavCrm('negocios')}
    <div class="breadcrumb"><a href="#/crm/negocios">Negocios</a> / <a href="#/crm/empresas/${n.empresa_id}">${esc(n.empresa_nombre)}</a> / ${esc(n.nombre)}</div>
    ${!isAdmin ? '<div class="readonly-banner">Modo de solo lectura — Gerencia.</div>' : ''}
    <div class="toolbar">
      <div>
        <h1 class="mt-0">${esc(n.nombre)}</h1>
        ${badgeEtapa(n.etapa)} ${n.auto ? '<span class="chip" title="Creado por la sincronización">automático</span>' : ''}
        <span class="pill">Desde ${fmtDMY(n.fecha_inicio)}</span>
        ${n.abierto ? `<span class="pill">${n.dias_en_etapa ?? 0} días en la etapa</span>` : `<span class="pill">Cerrado el ${fmtDMY(n.fecha_cierre_real)}</span>`}
      </div>
      ${isAdmin ? `<div class="btn-row">
        <button class="btn btn-secondary btn-sm" id="b-editar">Editar</button>
        <button class="btn btn-secondary btn-sm" id="b-actividad">+ Actividad</button>
        <button class="btn btn-danger btn-sm" id="b-eliminar">Eliminar</button>
      </div>` : ''}
    </div>

    <div class="card">${barraEtapas(n.etapa, { clickable: isAdmin })}
      ${n.etapa === 'Cierre perdido' ? `<p class="small" style="color:var(--critical)">Motivo: ${esc(n.motivo_perdida || 'sin motivo')}</p>` : ''}
      ${isAdmin ? '<p class="muted small mt-0">Haga clic en una etapa para mover el negocio. La sincronización lo avanza sola con aprobaciones, OC y facturas, pero nunca lo devuelve.</p>' : ''}
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="label">Valor sin IVA</div><div class="value">${money(n.valor_sin_iva)}</div><div class="sub">${money(n.valor_con_iva)} con IVA · ${n.valor_desde_cotizaciones ? 'de sus cotizaciones' : 'estimado'}</div></div>
      <div class="kpi"><div class="label">Probabilidad</div><div class="value">${pct(n.probabilidad_efectiva, 0)}</div><div class="sub">${n.probabilidad != null ? 'fijada en el negocio' : 'la de la etapa'}</div></div>
      <div class="kpi"><div class="label">Ponderado</div><div class="value">${money(n.valor_ponderado)}</div><div class="sub">valor × probabilidad</div></div>
      <div class="kpi ${n.cierre_vencido ? 'alerta' : ''}"><div class="label">Cierre esperado</div><div class="value">${n.fecha_cierre_esperada ? fmtDMY(n.fecha_cierre_esperada) : '—'}</div><div class="sub">${n.fecha_cierre_esperada ? (n.cierre_vencido ? 'ya pasó' : '') : 'sin fecha: complétela'}</div></div>
    </div>

    <div class="grid-2">
      <div class="card"><h3>Datos</h3>
        <dl class="datos">
          <dt>Empresa</dt><dd><a href="#/crm/empresas/${n.empresa_id}">${esc(n.empresa_nombre)}</a></dd>
          <dt>Contacto</dt><dd>${esc(n.contacto_nombre || '—')}</dd>
          <dt>Responsable</dt><dd>${esc(n.responsable_nombre || '—')}</dd>
          <dt>Origen</dt><dd>${esc(n.origen || '—')}</dd>
          <dt>Descripción</dt><dd class="pre">${esc(n.descripcion || '—')}</dd>
          ${n.buzon ? `<dt>Solicitud</dt><dd><a href="#/buzon">${esc(n.buzon.asunto || '')}</a> (${esc(n.buzon.estado)})${n.buzon.web_link ? ` · <a href="${esc(n.buzon.web_link)}" target="_blank" rel="noopener">Abrir en Outlook</a>` : ''}</dd>` : ''}
        </dl>
      </div>
      <div class="card"><h3>Cotizaciones del negocio</h3>
        ${n.cotizaciones.length ? `<div class="table-wrap"><table class="compacta"><thead><tr><th>Número</th><th>Fecha</th><th>Estado</th><th class="num">Con IVA</th><th class="num">Sin IVA</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
          <tbody>${n.cotizaciones.map((c) => `<tr><td><a href="#/cotizaciones/${c.id}">${esc(c.numero)}</a></td><td>${fmtDMY(c.fecha_cotizacion)}</td><td><span class="badge estado-${esc(c.estado)}">${esc(c.estado)}</span></td><td class="num">${money(c.con)}</td><td class="num">${money(c.sin)}</td>
            ${isAdmin ? `<td><button class="btn btn-secondary btn-sm" data-quitar="${esc(c.numero)}" title="Quitar del negocio">✕</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`
          : '<div class="empty-state">Sin cotizaciones vinculadas.</div>'}
        ${isAdmin ? `<form id="f-vincular" class="btn-row" style="margin-top:10px"><input name="numero" placeholder="Número de cotización, ej. C-1-240" style="max-width:260px"><button class="btn btn-secondary btn-sm">Vincular</button></form>
          <p class="muted small">Varias versiones de una misma oferta se agrupan en un solo negocio: el valor es la suma de las no rechazadas.</p>` : ''}
      </div>
    </div>

    ${n.posibles_facturas.length ? `<div class="card"><h3>Posibles facturas de este negocio</h3>
      <p class="muted small">Facturas del mismo cliente, sin cotización vinculada, por el mismo valor. Si corresponde, vincúlela: el negocio pasa a Cierre ganado con la fecha de la factura.</p>
      <div class="table-wrap"><table class="compacta"><thead><tr><th>Cotización</th><th>Factura</th><th>Fecha</th><th class="num">Total</th><th class="num">Diferencia</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
      <tbody>${n.posibles_facturas.flatMap((p) => p.facturas.map((f) => `<tr><td>${esc(p.cotizacion.numero)}</td><td>${esc(f.numero)}${f.titulo ? `<div class="small muted">${esc(f.titulo)}</div>` : ''}</td><td>${fmtDMY(f.fecha)}</td><td class="num">${money(f.total)}</td>
        <td class="num">${f.diferencia ? money(f.diferencia) : '<span class="chip">exacta</span>'}</td>
        ${isAdmin ? `<td><button class="btn btn-secondary btn-sm" data-vfac="${p.cotizacion.id}:${f.id}">Vincular</button></td>` : ''}</tr>`)).join('')}</tbody></table></div></div>` : ''}

    <div class="card"><div class="section-title mt-0"><h3 class="mt-0">Actividades</h3></div>
      <div id="neg-actividades">${n.actividades.length ? n.actividades.map((a) => filaActividad(a, { isAdmin, mostrarEmpresa: false })).join('') : '<div class="empty-state">Sin actividades. Registre llamadas, visitas y acuerdos para ver el seguimiento.</div>'}</div>
    </div>

    <div class="card"><h3>Historial de etapas</h3>
      <div class="table-wrap"><table class="compacta"><thead><tr><th>Fecha</th><th>De</th><th>A</th><th>Por</th><th>Detalle</th></tr></thead>
      <tbody>${n.historial.map((h) => `<tr><td>${fechaHora(h.fecha)}</td><td>${h.etapa_anterior ? badgeEtapa(h.etapa_anterior) : '<span class="muted">Creado</span>'}</td><td>${badgeEtapa(h.etapa_nueva)}</td>
        <td>${h.automatico ? '<span class="chip">automático</span>' : esc(h.usuario_nombre || '')}</td><td class="small">${esc(h.detalle || '')}</td></tr>`).join('')}</tbody></table></div>
    </div>`;

  conectarActividades(document.getElementById('neg-actividades'), n.actividades, recargar);
  if (!isAdmin) return;
  content.querySelectorAll('.barra-etapas .paso').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.etapa === n.etapa) return;
    try { if (await moverEtapa(n, b.dataset.etapa)) recargar(); } catch (e) { alert(e.message); }
  }));
  document.getElementById('b-editar').addEventListener('click', async () => { if (await formNegocio({ negocio: n })) recargar(); });
  document.getElementById('b-actividad').addEventListener('click', async () => { if (await formActividad({ empresaId: n.empresa_id, negocioId: n.id, contactoId: n.contacto_id })) recargar(); });
  document.getElementById('b-eliminar').addEventListener('click', async () => {
    if (!confirm(`¿Eliminar el negocio "${n.nombre}"? Sus cotizaciones y actividades se conservan.`)) return;
    try {
      const r = await api.del(`/api/crm/negocios/${n.id}`);
      if (r.aviso) alert(r.aviso);
      location.hash = '#/crm/negocios';
    } catch (e) { alert(e.message); }
  });
  document.getElementById('f-vincular').addEventListener('submit', async (e) => {
    e.preventDefault();
    const numero = e.target.numero.value.trim();
    if (!numero) return;
    try { await api.post(`/api/crm/negocios/${n.id}/cotizaciones`, { numero }); recargar(); } catch (err) { alert(err.message); }
  });
  content.querySelectorAll('button[data-vfac]').forEach((b) => b.addEventListener('click', async () => {
    const [cotizacion_id, factura_id] = b.dataset.vfac.split(':').map(Number);
    try {
      const r = await api.post('/api/crm/conciliacion', { pares: [{ cotizacion_id, factura_id }] });
      if (r.errores.length) alert(r.errores.join('\n'));
      recargar();
    } catch (err) { alert(err.message); }
  }));
  content.querySelectorAll('button[data-quitar]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`¿Quitar ${b.dataset.quitar} de este negocio?`)) return;
    try { await api.post(`/api/crm/negocios/${n.id}/cotizaciones`, { numero: b.dataset.quitar, quitar: true }); recargar(); } catch (err) { alert(err.message); }
  }));
}
