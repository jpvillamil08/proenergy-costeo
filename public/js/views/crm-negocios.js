import { api } from '../api.js';
import { money, fmtDMY, pct, esc } from '../format.js';
import { stillMounted } from '../guard.js';
import { subnavCrm, configCrm, badgeEtapa, millones, COLOR_ETAPA, formNegocio, moverEtapa, conciliarFacturas } from './crm-comun.js';

// Negocios: tablero Kanban (arrastrar para cambiar de etapa) o lista.

let vista = 'kanban';
const filtros = { texto: '', responsable: '', origen: '', cierre: '', cerrados: '60' };

export async function renderCrmNegocios(content, state, query = {}) {
  const isAdmin = state.usuario.rol === 'admin';
  if (query.etapa) { vista = 'lista'; filtros.etapa = query.etapa; } else if (!filtros._visto) { filtros.etapa = ''; }
  filtros._visto = true;
  content.innerHTML = `${subnavCrm('negocios')}<div class="spinner-msg">Cargando negocios…</div>`;
  const [cfg, negocios, conciliables] = await Promise.all([configCrm(), api.get('/api/crm/negocios'), api.get('/api/crm/conciliacion').catch(() => [])]);
  if (!stillMounted(content)) return;
  const seguras = conciliables.filter((p) => p.unica && p.exacta).length;

  content.innerHTML = `
    ${subnavCrm('negocios')}
    <div class="toolbar">
      <h1 class="mt-0">Negocios</h1>
      <div class="btn-row">
        <div class="toggle"><button data-v="kanban" class="${vista === 'kanban' ? 'active' : ''}">Tablero</button><button data-v="lista" class="${vista === 'lista' ? 'active' : ''}">Lista</button></div>
        ${isAdmin ? '<button class="btn btn-primary btn-sm" id="b-nuevo">+ Negocio</button>' : ''}
      </div>
    </div>
    ${conciliables.length ? `<div class="alert-item warning" style="margin-bottom:12px"><div><strong>${conciliables.length} propuesta(s) tienen una posible factura sin vincular</strong>
      <div class="small">${seguras} con una sola factura del mismo cliente por el valor exacto. Mientras no se vinculen, esos negocios siguen como abiertos e inflan el pipeline.</div></div>
      <button class="btn btn-secondary btn-sm" id="b-conciliar">Revisar y conciliar</button></div>` : ''}
    <div class="card filtros-card">
      <div class="filters">
        <div class="field"><label>Buscar</label><input id="f-texto" value="${esc(filtros.texto)}" placeholder="Negocio, empresa o cotización"></div>
        ${vista === 'lista' ? `<div class="field"><label>Etapa</label><select id="f-etapa"><option value="">Todas</option>${cfg.etapas.map((e) => `<option ${filtros.etapa === e.nombre ? 'selected' : ''}>${esc(e.nombre)}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label>Responsable</label><select id="f-responsable"><option value="">Todos</option><option value="sin" ${filtros.responsable === 'sin' ? 'selected' : ''}>Sin asignar</option>${cfg.usuarios.map((u) => `<option value="${u.id}" ${String(filtros.responsable) === String(u.id) ? 'selected' : ''}>${esc(u.nombre)}</option>`).join('')}</select></div>
        <div class="field"><label>Origen</label><select id="f-origen"><option value="">Todos</option>${[...new Set(negocios.map((n) => n.origen).filter(Boolean))].map((o) => `<option ${filtros.origen === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>
        <div class="field"><label>Cierre esperado</label><select id="f-cierre">
          ${[['', 'Cualquiera'], ['mes', 'Este mes'], ['vencido', 'Fecha pasada'], ['sin', 'Sin fecha']].map(([v, l]) => `<option value="${v}" ${filtros.cierre === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>Cerrados</label><select id="f-cerrados">
          ${[['60', 'Últimos 60 días'], ['365', 'Último año'], ['todos', 'Todos'], ['no', 'Ocultar']].map(([v, l]) => `<option value="${v}" ${filtros.cerrados === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
    </div>
    <div id="neg-cuerpo"></div>`;

  const recargar = () => renderCrmNegocios(content, state);
  content.querySelectorAll('.toggle button').forEach((b) => b.addEventListener('click', () => { vista = b.dataset.v; recargar(); }));
  const pintar = () => {
    const lista = filtrar(negocios, cfg);
    const cuerpo = document.getElementById('neg-cuerpo');
    if (vista === 'kanban') pintarKanban(cuerpo, lista, cfg, isAdmin, recargar);
    else pintarLista(cuerpo, lista);
  };
  const enlazar = (id, clave, evento = 'change') => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evento, () => { filtros[clave] = el.value; pintar(); });
  };
  enlazar('f-texto', 'texto', 'input');
  enlazar('f-etapa', 'etapa');
  enlazar('f-responsable', 'responsable');
  enlazar('f-origen', 'origen');
  enlazar('f-cierre', 'cierre');
  enlazar('f-cerrados', 'cerrados');
  if (isAdmin) document.getElementById('b-nuevo').addEventListener('click', async () => { const r = await formNegocio(); if (r && r.id) location.hash = `#/crm/negocios/${r.id}`; });
  const bConc = document.getElementById('b-conciliar');
  const abrirConciliacion = async () => {
    try { if (await conciliarFacturas({ isAdmin })) recargar(); } catch (e) { alert(e.message); }
  };
  if (bConc) bConc.addEventListener('click', abrirConciliacion);
  pintar();
  if (query.conciliar && conciliables.length) {
    history.replaceState(null, '', '#/crm/negocios');
    abrirConciliacion();
  }
}

function filtrar(negocios, cfg) {
  const hoy = cfg.ahora.slice(0, 10);
  const t = filtros.texto.trim().toLowerCase();
  return negocios.filter((n) => {
    if (t && !`${n.nombre} ${n.empresa_nombre} ${n.cotizaciones.map((c) => c.numero).join(' ')}`.toLowerCase().includes(t)) return false;
    if (vista === 'lista' && filtros.etapa && n.etapa !== filtros.etapa) return false;
    if (filtros.responsable === 'sin' ? n.responsable_id : filtros.responsable && String(n.responsable_id) !== String(filtros.responsable)) return false;
    if (filtros.origen && n.origen !== filtros.origen) return false;
    if (filtros.cierre === 'mes' && String(n.fecha_cierre_esperada || '').slice(0, 7) !== hoy.slice(0, 7)) return false;
    if (filtros.cierre === 'vencido' && !n.cierre_vencido) return false;
    if (filtros.cierre === 'sin' && (n.fecha_cierre_esperada || !n.abierto)) return false;
    if (!n.abierto) {
      if (filtros.cerrados === 'no') return false;
      if (filtros.cerrados !== 'todos' && n.fecha_cierre_real) {
        const dias = (Date.parse(hoy) - Date.parse(n.fecha_cierre_real)) / 86400000;
        if (dias > Number(filtros.cerrados)) return false;
      }
    }
    return true;
  });
}

function tarjeta(n, isAdmin) {
  const alertas = [];
  if (n.cierre_vencido) alertas.push('<span class="chip rojo" title="La fecha de cierre esperada ya pasó">Cierre vencido</span>');
  if (n.abierto && n.dias_sin_actividad > 15) alertas.push(`<span class="chip ambar" title="Días sin actividad registrada">${n.dias_sin_actividad} d quieto</span>`);
  if (n.auto) alertas.push('<span class="chip" title="Creado por la sincronización desde una cotización o el buzón">auto</span>');
  return `<div class="k-tarjeta" draggable="${isAdmin}" data-id="${n.id}">
    <a href="#/crm/negocios/${n.id}" class="k-nombre">${esc(n.nombre)}</a>
    <div class="k-empresa">${esc(n.empresa_nombre)}</div>
    <div class="k-pie"><strong title="${money(n.valor_sin_iva)} sin IVA · ${money(n.valor_con_iva)} con IVA">${millones(n.valor_sin_iva)}</strong>
      <span class="muted">${n.abierto ? `${n.dias_en_etapa ?? 0} d en etapa` : fmtDMY(n.fecha_cierre_real)}</span></div>
    ${n.fecha_cierre_esperada && n.abierto ? `<div class="small muted">Cierre: ${fmtDMY(n.fecha_cierre_esperada)}</div>` : ''}
    ${alertas.length ? `<div class="k-chips">${alertas.join('')}</div>` : ''}
  </div>`;
}

function pintarKanban(el, negocios, cfg, isAdmin, recargar) {
  el.innerHTML = `<div class="kanban">${cfg.etapas.map((e) => {
    const de = negocios.filter((n) => n.etapa === e.nombre);
    const total = de.reduce((s, n) => s + n.valor_sin_iva, 0);
    return `<div class="k-col" data-etapa="${esc(e.nombre)}" style="--c:${COLOR_ETAPA[e.nombre]}">
      <div class="k-cab"><span class="k-titulo">${esc(e.nombre)}</span><span class="k-cuenta">${de.length}</span>
        <div class="k-total">${millones(total)} <span class="muted">· ${pct(e.probabilidad, 0)}</span></div></div>
      <div class="k-lista">${de.map((n) => tarjeta(n, isAdmin)).join('') || '<div class="k-vacia">—</div>'}</div>
    </div>`;
  }).join('')}</div>
  ${isAdmin ? '<p class="muted small">Arrastre una tarjeta a otra columna para cambiar la etapa. Las etapas también avanzan solas con las aprobaciones, órdenes de compra y facturas.</p>' : ''}`;
  if (!isAdmin) return;
  let arrastrando = null;
  el.querySelectorAll('.k-tarjeta').forEach((t) => {
    t.addEventListener('dragstart', (ev) => { arrastrando = Number(t.dataset.id); t.classList.add('arrastrando'); ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', t.dataset.id); });
    t.addEventListener('dragend', () => { t.classList.remove('arrastrando'); el.querySelectorAll('.k-col').forEach((c) => c.classList.remove('sobre')); });
  });
  el.querySelectorAll('.k-col').forEach((col) => {
    col.addEventListener('dragover', (ev) => { ev.preventDefault(); col.classList.add('sobre'); });
    col.addEventListener('dragleave', () => col.classList.remove('sobre'));
    col.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      col.classList.remove('sobre');
      const id = arrastrando || Number(ev.dataTransfer.getData('text/plain'));
      const n = negocios.find((x) => x.id === id);
      if (!n || n.etapa === col.dataset.etapa) return;
      try {
        const r = await moverEtapa(n, col.dataset.etapa);
        if (r) recargar();
      } catch (e) {
        alert(e.message);
      }
    });
  });
}

function pintarLista(el, negocios) {
  const total = negocios.filter((n) => n.abierto).reduce((s, n) => s + n.valor_sin_iva, 0);
  el.innerHTML = `<div class="card">
    <p class="muted small">${negocios.length} negocio(s) · abiertos ${money(total)} sin IVA</p>
    ${negocios.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Negocio</th><th>Empresa</th><th>Etapa</th><th class="num">Valor sin IVA</th><th class="num">Prob.</th><th class="num">Ponderado</th><th>Cotizaciones</th><th>Inicio</th><th>Cierre esperado</th><th>Cierre real</th><th>Responsable</th></tr></thead>
      <tbody>${negocios.map((n) => `<tr>
        <td><a href="#/crm/negocios/${n.id}">${esc(n.nombre)}</a>${n.auto ? ' <span class="chip">auto</span>' : ''}</td>
        <td><a href="#/crm/empresas/${n.empresa_id}">${esc(n.empresa_nombre)}</a></td>
        <td>${badgeEtapa(n.etapa)}${n.motivo_perdida && n.etapa === 'Cierre perdido' ? `<div class="small muted">${esc(n.motivo_perdida)}</div>` : ''}</td>
        <td class="num">${money(n.valor_sin_iva)}</td><td class="num">${pct(n.probabilidad_efectiva, 0)}</td><td class="num">${money(n.valor_ponderado)}</td>
        <td>${n.cotizaciones.map((c) => `<a href="#/cotizaciones/${c.id}">${esc(c.numero)}</a>`).join(', ')}</td>
        <td>${fmtDMY(n.fecha_inicio)}</td>
        <td style="${n.cierre_vencido ? 'color:var(--critical);font-weight:600' : ''}">${n.fecha_cierre_esperada ? fmtDMY(n.fecha_cierre_esperada) : '<span class="tenue">—</span>'}</td>
        <td>${n.fecha_cierre_real ? fmtDMY(n.fecha_cierre_real) : ''}</td>
        <td>${esc(n.responsable_nombre || '')}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">No hay negocios con estos filtros.</div>'}
  </div>`;
}
