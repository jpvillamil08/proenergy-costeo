import { api } from '../api.js';
import { money, pct, num, esc } from '../format.js';
import { stillMounted } from '../guard.js';
import { horizontalBarChart, groupedBarChart, donutChart, PALETTE } from '../charts.js';
import { subnavCrm, configCrm, COLOR_ETAPA, millones, filaActividad, conectarActividades, formActividad, formNegocio, formEmpresa, badgeEtapa } from './crm-comun.js';

// Tablero del CRM: indicadores del embudo, pronostico, meta del mes, alertas y agenda.

let periodo = 'anio';

function rango(p, hoy) {
  const [y, m] = [Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7))];
  const iso = (d) => d.toISOString().slice(0, 10);
  if (p === 'mes') return { desde: `${hoy.slice(0, 7)}-01`, hasta: hoy };
  if (p === 'trimestre') return { desde: iso(new Date(Date.UTC(y, Math.floor((m - 1) / 3) * 3, 1))), hasta: hoy };
  if (p === '12m') return { desde: iso(new Date(Date.UTC(y - 1, m - 1, Number(hoy.slice(8, 10))))), hasta: hoy };
  return { desde: `${y}-01-01`, hasta: hoy };
}

export async function renderCrmTablero(content, state) {
  const isAdmin = state.usuario.rol === 'admin';
  content.innerHTML = `${subnavCrm('tablero')}<div class="spinner-msg">Cargando CRM…</div>`;
  const cfg = await configCrm();
  const { desde, hasta } = rango(periodo, cfg.ahora.slice(0, 10));
  const [t, al] = await Promise.all([api.get(`/api/crm/tablero?desde=${desde}&hasta=${hasta}`), api.get('/api/crm/alertas')]);
  if (!stillMounted(content)) return;
  const k = t.kpis;

  content.innerHTML = `
    ${subnavCrm('tablero')}
    <div class="toolbar">
      <h1 class="mt-0">CRM comercial</h1>
      <div class="btn-row">
        <select id="crm-periodo" class="select-sm">
          ${[['mes', 'Este mes'], ['trimestre', 'Este trimestre'], ['anio', 'Este año'], ['12m', 'Últimos 12 meses']].map(([v, l]) => `<option value="${v}" ${periodo === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        ${isAdmin ? `<button class="btn btn-secondary btn-sm" id="b-sync" title="Vincula cotizaciones, facturas, OC y correos nuevos y avanza los negocios">Sincronizar</button>
          <button class="btn btn-secondary btn-sm" id="b-empresa">+ Empresa</button>
          <button class="btn btn-secondary btn-sm" id="b-actividad">+ Actividad</button>
          <button class="btn btn-primary btn-sm" id="b-negocio">+ Negocio</button>` : ''}
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi"><div class="label">Pipeline abierto</div><div class="value" title="${money(k.pipeline_sin_iva)}">${millones(k.pipeline_sin_iva)}</div><div class="sub">${k.pipeline_negocios} negocio(s) · sin IVA</div></div>
      <div class="kpi"><div class="label">Pronóstico ponderado</div><div class="value" title="${money(k.ponderado)}">${millones(k.ponderado)}</div><div class="sub">valor × probabilidad de la etapa</div></div>
      <div class="kpi"><div class="label">Ganado en el período</div><div class="value" title="${money(k.ganado_sin_iva)}">${millones(k.ganado_sin_iva)}</div><div class="sub">${k.ganados} ganado(s) · ${k.perdidos} perdido(s)</div></div>
      <div class="kpi ${k.cumplimiento_meta != null && k.cumplimiento_meta < 0.5 ? 'alerta' : ''}"><div class="label">Facturado del mes vs meta</div>
        <div class="value">${k.cumplimiento_meta != null ? pct(k.cumplimiento_meta) : '—'}</div>
        <div class="sub">${millones(k.facturado_mes_sin_iva)} de ${k.meta_mes != null ? millones(k.meta_mes) : 'sin meta cargada'}</div>
        ${k.cumplimiento_meta != null ? `<div class="meter"><span style="width:${Math.min(100, k.cumplimiento_meta * 100)}%"></span></div>` : ''}</div>
      <div class="kpi"><div class="label">Tasa de cierre</div><div class="value">${k.conversion != null ? pct(k.conversion) : '—'}</div><div class="sub">ganados ÷ cerrados del período</div></div>
      <div class="kpi"><div class="label">Ciclo de venta</div><div class="value">${k.ciclo_dias != null ? num(k.ciclo_dias, 0) + ' días' : '—'}</div><div class="sub">de la cotización al cierre</div></div>
    </div>

    <div class="grid-2">
      <div class="card"><h3>Embudo abierto (sin IVA)</h3><div id="g-embudo"></div>
        <div class="table-wrap"><table class="compacta"><thead><tr><th>Etapa</th><th class="num">Negocios</th><th class="num">Valor</th><th class="num">Prob.</th><th class="num">Ponderado</th></tr></thead>
        <tbody>${t.embudo.map((e) => `<tr><td><a href="#/crm/negocios?etapa=${encodeURIComponent(e.etapa)}">${badgeEtapa(e.etapa)}</a></td><td class="num">${e.cantidad}</td><td class="num">${money(e.valor_sin_iva)}</td><td class="num">${pct(e.probabilidad, 0)}</td><td class="num">${money(e.ponderado)}</td></tr>`).join('')}</tbody></table></div>
      </div>
      <div class="card"><h3>Pronóstico por mes de cierre esperado</h3><div id="g-pronostico"></div>
        <p class="muted small">Los negocios sin fecha de cierre esperada no se pueden ubicar en un mes: complételas en cada negocio.</p></div>
    </div>

    <div class="grid-2">
      <div class="card"><div class="section-title mt-0"><h3 class="mt-0">Alertas</h3><span class="muted small">${al.criticas} crítica(s)</span></div>
        <div id="crm-alertas">${pintarAlertas(al.alertas)}</div></div>
      <div class="card"><div class="section-title mt-0"><h3 class="mt-0">Próximos 7 días</h3><a href="#/crm/agenda" class="small">Ver agenda</a></div>
        <div id="crm-proximas">${t.proximas.length ? t.proximas.map((a) => filaActividad(a, { isAdmin })).join('') : '<div class="empty-state">No hay actividades programadas.</div>'}</div></div>
    </div>

    <div class="grid-2">
      <div class="card"><h3>Top clientes del período</h3>
        ${t.topClientes.length ? `<div class="table-wrap"><table class="compacta"><thead><tr><th>Cliente</th><th class="num">Facturas</th><th class="num">Facturado</th><th class="num">Cartera</th></tr></thead>
        <tbody>${t.topClientes.map((c) => `<tr><td><a href="#/crm/empresas/${c.id}">${esc(c.nombre)}</a></td><td class="num">${c.facturas}</td><td class="num">${money(c.facturado)}</td><td class="num">${money(c.cartera)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">Sin facturas en el período.</div>'}
      </div>
      <div class="card"><h3>Motivos de pérdida</h3><div id="g-motivos"></div></div>
    </div>

    <div class="grid-2">
      <div class="card"><h3>Días promedio por etapa</h3>
        <div class="table-wrap"><table class="compacta"><thead><tr><th>Etapa</th><th class="num">Negocios</th><th class="num">Días promedio</th></tr></thead>
        <tbody>${t.diasPorEtapa.map((d) => `<tr><td>${badgeEtapa(d.etapa)}</td><td class="num">${d.negocios}</td><td class="num">${d.dias_promedio != null ? num(d.dias_promedio, 0) : '—'}</td></tr>`).join('')}</tbody></table></div>
        <p class="muted small">Negocios iniciados en el período. Cuenta desde que entraron a la etapa hasta que salieron (o hasta hoy).</p></div>
      <div class="card"><h3>Actividad comercial del período</h3>
        ${t.actividades.length ? `<div class="table-wrap"><table class="compacta"><thead><tr><th>Tipo</th><th class="num">Registradas</th><th class="num">Realizadas</th></tr></thead>
        <tbody>${t.actividades.map((a) => `<tr><td>${esc(a.tipo)}</td><td class="num">${a.total}</td><td class="num">${a.completadas || 0}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">Todavía no se han registrado llamadas, visitas ni reuniones.</div>'}
        <p class="muted small">${k.empresas} empresas en el CRM · ${k.clientes} clientes activos (con factura en los últimos 12 meses).</p></div>
    </div>

    <details class="desglose card"><summary><span>¿De dónde salen estas cifras?</span><span class="flecha">›</span></summary>
      <div class="cuerpo"><table><thead><tr><th>Concepto</th><th>Fórmula</th><th class="num">Valor</th></tr></thead>
      <tbody>${t.desglose.map((d) => `<tr><td>${esc(d.concepto)}</td><td class="small">${esc(d.formula)}</td><td class="num">${d.valor == null ? '—' : d.concepto.startsWith('Tasa') ? pct(d.valor) : d.concepto.includes('días') ? num(d.valor, 0) : money(d.valor)}</td></tr>`).join('')}</tbody></table></div>
    </details>`;

  horizontalBarChart(document.getElementById('g-embudo'), {
    data: t.embudo.map((e) => ({ label: e.etapa, value: e.valor_sin_iva, color: COLOR_ETAPA[e.etapa], tooltip: `<strong>${esc(e.etapa)}</strong><br>${e.cantidad} negocio(s)<br>${money(e.valor_sin_iva)} sin IVA` })),
  });
  groupedBarChart(document.getElementById('g-pronostico'), {
    categories: t.pronostico.map((p) => p.etiqueta),
    series: [
      { name: 'Valor sin IVA', data: t.pronostico.map((p) => p.valor_sin_iva), color: PALETTE[0] },
      { name: 'Ponderado', data: t.pronostico.map((p) => p.ponderado), color: PALETTE[2] },
    ],
    valueFmt: millones,
  });
  const gm = document.getElementById('g-motivos');
  if (t.motivosPerdida.length) donutChart(gm, { data: t.motivosPerdida.map((m, i) => ({ label: m.motivo, value: m.cantidad, color: PALETTE[i % PALETTE.length] })), valueFmt: (v) => `${v}` });
  else gm.innerHTML = '<div class="empty-state">Sin negocios perdidos en el período.</div>';

  const recargar = () => renderCrmTablero(content, state);
  document.getElementById('crm-periodo').addEventListener('change', (e) => { periodo = e.target.value; recargar(); });
  conectarActividades(document.getElementById('crm-proximas'), t.proximas, recargar);
  if (isAdmin) {
    document.getElementById('b-sync').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Sincronizando…';
      try {
        const r = await api.post('/api/crm/sincronizar');
        alert(`Listo: ${r.empresasCreadas} empresa(s) nueva(s), ${r.negociosCreados} negocio(s) nuevo(s), ${r.negociosAvanzados} cambio(s) de etapa, ${r.correosVinculados} correo(s) enlazados.`);
      } catch (err) { alert(err.message); }
      recargar();
    });
    document.getElementById('b-empresa').addEventListener('click', async () => { const r = await formEmpresa(); if (r && r.id) location.hash = `#/crm/empresas/${r.id}`; });
    document.getElementById('b-negocio').addEventListener('click', async () => { const r = await formNegocio(); if (r && r.id) location.hash = `#/crm/negocios/${r.id}`; });
    document.getElementById('b-actividad').addEventListener('click', async () => { if (await formActividad()) recargar(); });
  }
}

export function pintarAlertas(alertas, limite = 14) {
  if (!alertas.length) return '<div class="alert-empty">Todo al día: no hay alertas.</div>';
  const clase = { critica: '', aviso: 'warning', info: 'info' };
  const grupos = [];
  for (const a of alertas.slice(0, limite)) {
    let g = grupos.find((x) => x.nombre === a.grupo);
    if (!g) grupos.push(g = { nombre: a.grupo, items: [] });
    g.items.push(a);
  }
  return `${grupos.map((g) => `<div class="alerta-grupo"><div class="alerta-grupo-titulo">${esc(g.nombre)}</div><div class="alert-list">
    ${g.items.map((a) => `<div class="alert-item ${clase[a.severidad]}"><div><a href="${esc(a.enlace)}">${esc(a.titulo)}</a><div class="small">${esc(a.detalle)}</div></div></div>`).join('')}
  </div></div>`).join('')}
  ${alertas.length > limite ? `<p class="muted small">Y ${alertas.length - limite} alerta(s) más.</p>` : ''}`;
}
