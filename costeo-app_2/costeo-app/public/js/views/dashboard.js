import { api } from '../api.js';
import { money, pct, num, fmtDMY, esc, SEMAFORO_LABEL, SEMAFORO_CLASS } from '../format.js';
import { horizontalBarChart, groupedBarChart, lineChart, donutChart, severityBarChart, PALETTE, STATUS } from '../charts.js';
import { stillMounted } from '../guard.js';

let cache = null;
let sortState = { col: 'utilidad', dir: -1 };
let filtros = { cliente: '', estado: '', semaforo: '', desde: '', hasta: '' };

export async function renderDashboard(content, state) {
  content.innerHTML = '<div class="spinner-msg">Cargando indicadores…</div>';
  const data = await api.get('/api/dashboard');
  if (!stillMounted(content)) return;
  cache = data;
  paint(content, state);
}

function paint(content, state) {
  const d = cache;
  content.innerHTML = `
    <div id="alertas"></div>
    <div class="kpi-grid" id="kpis"></div>
    <div class="grid-2">
      <div class="card"><div class="chart-title">Utilidad por cotización (mayor a menor)</div><div id="chart-utilidad-cot"></div></div>
      <div class="card"><div class="chart-title">Composición del costo total</div><div id="chart-composicion"></div></div>
      <div class="card"><div class="chart-title">Utilidad y margen por cliente</div><div id="chart-cliente"></div></div>
      <div class="card"><div class="chart-title">Antigüedad de cartera</div><div id="chart-cartera"></div></div>
      <div class="card"><div class="chart-title">Evolución mensual (ventas, costo, utilidad)</div><div id="chart-evolucion"></div></div>
      <div class="card"><div class="chart-title">Horas facturadas y utilidad por trabajador</div><div id="chart-trabajador"></div></div>
    </div>
    <div class="card"><div class="chart-title">Presupuestado vs. real (cotizaciones ejecutadas)</div><div id="chart-comparativo"></div></div>
    <div class="section-title"><h2>Detalle de cotizaciones</h2>
      <div class="btn-row">
        <button class="btn btn-secondary btn-sm" id="btn-export-csv">Exportar tabla a CSV</button>
      </div>
    </div>
    <div class="card">
      <div class="filters" id="filtros"></div>
      <div class="table-wrap" id="tabla-wrap"></div>
    </div>
  `;
  paintAlertas(d.alertas);
  paintKpis(d.kpis);
  horizontalBarChart(document.getElementById('chart-utilidad-cot'), {
    data: d.graficos.utilidadMargenPorCotizacion.map((r) => ({
      label: `${r.numero} · ${r.cliente}`, value: r.utilidad,
      tooltip: `<strong>${esc(r.numero)} · ${esc(r.cliente)}</strong><br>Utilidad: ${money(r.utilidad)}<br>Margen: ${pct(r.margenPct)}`,
    })),
    color: PALETTE[0],
  });
  const comp = d.graficos.composicionCosto;
  donutChart(document.getElementById('chart-composicion'), {
    data: [
      { label: 'Materiales directos', value: comp.materialesDirectos, color: PALETTE[0] },
      { label: 'Materiales indirectos', value: comp.materialesIndirectos, color: PALETTE[1] },
      { label: 'M.O. interna', value: comp.moInterna, color: PALETTE[2] },
      { label: 'M.O. externa', value: comp.moExterna, color: PALETTE[3] },
      { label: 'Gastos fijos aplicados', value: comp.gastosFijos, color: PALETTE[4] },
      { label: 'Imprevistos', value: comp.imprevistos, color: PALETTE[5] },
      { label: 'Comisión de ventas', value: comp.comision, color: PALETTE[6] },
    ],
  });
  horizontalBarChart(document.getElementById('chart-cliente'), {
    data: d.graficos.utilidadMargenPorCliente.map((r) => ({
      label: r.cliente, value: r.utilidad,
      tooltip: `<strong>${esc(r.cliente)}</strong><br>Utilidad: ${money(r.utilidad)}<br>Margen: ${pct(r.margenPct)}`,
    })),
    color: PALETTE[2],
  });
  const buckets = d.graficos.antiguedadCartera;
  severityBarChart(document.getElementById('chart-cartera'), {
    data: [
      { label: 'Corriente', value: buckets['Corriente'] || 0, color: STATUS.good },
      { label: '1-30', value: buckets['1-30'] || 0, color: PALETTE[3] },
      { label: '31-60', value: buckets['31-60'] || 0, color: STATUS.warning },
      { label: '61-90', value: buckets['61-90'] || 0, color: STATUS.serious },
      { label: '+90', value: buckets['+90'] || 0, color: STATUS.critical },
    ],
  });
  const evo = d.graficos.evolucionMensual;
  lineChart(document.getElementById('chart-evolucion'), {
    categories: evo.map((e) => e.mes),
    series: [
      { name: 'Ventas', color: PALETTE[0], data: evo.map((e) => e.ventas) },
      { name: 'Costo interno', color: PALETTE[1], data: evo.map((e) => e.costo) },
      { name: 'Utilidad', color: PALETTE[2], data: evo.map((e) => e.utilidad) },
    ],
  });
  horizontalBarChart(document.getElementById('chart-trabajador'), {
    data: d.graficos.horasPorTrabajador.map((r) => ({ label: `${r.trabajador} (${num(r.horas, 0)} h)`, value: r.utilidad })),
    color: PALETTE[6],
  });
  const cmp = d.graficos.presupuestadoVsReal;
  if (cmp.length) {
    groupedBarChart(document.getElementById('chart-comparativo'), {
      categories: cmp.map((c) => c.numero),
      series: [
        { name: 'Horas presupuestadas', color: PALETTE[0], data: cmp.map((c) => c.horasPresupuestadas) },
        { name: 'Horas reales', color: PALETTE[7], data: cmp.map((c) => c.horasReales) },
      ],
      valueFmt: (v) => num(v, 0) + ' h',
    });
  } else {
    document.getElementById('chart-comparativo').innerHTML = '<div class="empty-state">Aún no hay cotizaciones ejecutadas o cerradas para comparar.</div>';
  }

  paintFiltros();
  paintTabla();

  document.getElementById('btn-export-csv').addEventListener('click', () => exportarCsv(filtrarYOrdenar()));
}

function paintAlertas(a) {
  const el = document.getElementById('alertas');
  const bloques = [];
  if (a.noViables.length) {
    bloques.push(card('No viables o por debajo del margen mínimo', a.noViables.map((x) =>
      item(`<a href="#/cotizaciones/${x.id}">${esc(x.numero)}</a> — ${esc(x.cliente)}: margen ${pct(x.margenPct)}`))));
  }
  if (a.vencidas.length) {
    bloques.push(card('Cotizaciones vencidas sin pago completo', a.vencidas.map((x) =>
      item(`<a href="#/cotizaciones/${x.id}">${esc(x.numero)}</a> — ${esc(x.cliente)}: ${x.diasMora} días de mora, saldo ${money(x.saldoPendiente)}`))));
  }
  if (a.brechaCajaNegativa.length) {
    bloques.push(card('Brecha de caja negativa', a.brechaCajaNegativa.map((x) =>
      item(`<a href="#/cotizaciones/${x.id}">${esc(x.numero)}</a> — ${esc(x.cliente)}: caja negativa desde ${fmtDMY(x.fecha)}`))));
  }
  if (a.desviacionesEjecucion.length) {
    bloques.push(card('Desviación de ejecución > 10% frente al presupuesto', a.desviacionesEjecucion.map((x) =>
      item(`<a href="#/cotizaciones/${x.id}">${esc(x.numero)}</a> — ${esc(x.cliente)}: horas ${pct(x.desviacionHorasPct)}, materiales ${pct(x.desviacionMaterialesPct)}, impacto ${money(x.impactoUtilidad)}`, true))));
  }
  if (a.cxpVencenEstaSemana.length) {
    bloques.push(card('Cuentas por pagar que vencen esta semana', a.cxpVencenEstaSemana.map((x) =>
      item(`${esc(x.proveedor_nombre || 'Proveedor')} — ${esc(x.cotizacion_numero || '')}: ${money(x.valor)} vence ${fmtDMY(x.fecha_vencimiento)}`, true))));
  }
  if (!bloques.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="grid-2">${bloques.join('')}</div>`;
}
function item(html, warn) { return `<div class="alert-item${warn ? ' warning' : ''}">${html}</div>`; }
function card(title, items) { return `<div class="card"><h3>${esc(title)}</h3><div class="alert-list">${items.join('')}</div></div>`; }

function paintKpis(k) {
  const el = document.getElementById('kpis');
  const conv = k.tasaConversion === null ? 'N/A' : pct(k.tasaConversion);
  const dias = k.diasPromedioRealesCobro === null ? 'N/A' : num(k.diasPromedioRealesCobro, 0) + ' días';
  el.innerHTML = `
    <div class="kpi"><div class="label">Cotizaciones por estado</div><div class="sub">${Object.entries(k.porEstado).map(([e, n]) => `${e}: <strong>${n}</strong>`).join(' · ')}</div></div>
    <div class="kpi"><div class="label">Valor total ofertado</div><div class="value">${money(k.valorTotalOfertado)}</div></div>
    <div class="kpi"><div class="label">Costo interno total</div><div class="value">${money(k.costoInternoTotal)}</div></div>
    <div class="kpi"><div class="label">Utilidad total</div><div class="value">${money(k.utilidadTotal)}</div></div>
    <div class="kpi"><div class="label">Margen promedio ponderado</div><div class="value">${pct(k.margenPromedioPonderado)}</div></div>
    <div class="kpi alerta"><div class="label">Cartera por cobrar</div><div class="value">${money(k.carteraPorCobrar)}</div></div>
    <div class="kpi alerta"><div class="label">Cartera vencida</div><div class="value">${money(k.carteraVencida)}</div></div>
    <div class="kpi"><div class="label">Días promedio reales de cobro</div><div class="value">${dias}</div></div>
    <div class="kpi"><div class="label">Tasa de conversión</div><div class="value">${conv}</div></div>
    <div class="kpi ${k.absorcionGastosFijos.pct < 1 ? 'alerta' : ''}"><div class="label">Absorción gastos fijos del mes</div><div class="value">${pct(k.absorcionGastosFijos.pct)}</div>
      <div class="sub">Aplicados ${money(k.absorcionGastosFijos.aplicados)} de ${money(k.absorcionGastosFijos.reales)}</div></div>
  `;
}

function paintFiltros() {
  const el = document.getElementById('filtros');
  const clientes = [...new Set(cache.tabla.map((r) => r.cliente))].sort();
  el.innerHTML = `
    <div class="field"><label>Cliente</label>
      <select id="f-cliente"><option value="">Todos</option>${clientes.map((c) => `<option ${filtros.cliente === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Estado</label>
      <select id="f-estado"><option value="">Todos</option>${['Borrador', 'Enviada', 'Aprobada', 'Rechazada', 'Ejecutada', 'Cerrada'].map((e) => `<option value="${e}" ${filtros.estado === e ? 'selected' : ''}>${e}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Semáforo</label>
      <select id="f-semaforo"><option value="">Todos</option>${Object.entries(SEMAFORO_LABEL).map(([k, v]) => `<option value="${k}" ${filtros.semaforo === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Desde</label><input type="date" id="f-desde" value="${filtros.desde}"></div>
    <div class="field"><label>Hasta</label><input type="date" id="f-hasta" value="${filtros.hasta}"></div>
    <div class="field"><label>&nbsp;</label><button class="btn btn-secondary btn-sm" id="f-limpiar">Limpiar filtros</button></div>
  `;
  ['cliente', 'estado', 'semaforo', 'desde', 'hasta'].forEach((k) => {
    document.getElementById('f-' + k).addEventListener('change', (e) => { filtros[k] = e.target.value; paintTabla(); });
  });
  document.getElementById('f-limpiar').addEventListener('click', () => {
    filtros = { cliente: '', estado: '', semaforo: '', desde: '', hasta: '' };
    paintFiltros(); paintTabla();
  });
}

function filtrarYOrdenar() {
  let rows = cache.tabla.filter((r) => {
    if (filtros.cliente && r.cliente !== filtros.cliente) return false;
    if (filtros.estado && r.estado !== filtros.estado) return false;
    if (filtros.semaforo && r.semaforo !== filtros.semaforo) return false;
    if (filtros.desde && r.fecha_cotizacion < filtros.desde) return false;
    if (filtros.hasta && r.fecha_cotizacion > filtros.hasta) return false;
    return true;
  });
  rows = rows.slice().sort((a, b) => {
    const va = a[sortState.col], vb = b[sortState.col];
    if (va === vb) return 0;
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    return va > vb ? sortState.dir : -sortState.dir;
  });
  return rows;
}

const COLS = [
  ['numero', 'Número'], ['cliente', 'Cliente'], ['fecha_cotizacion', 'Fecha'], ['precio_venta', 'Precio ofertado'],
  ['costoInternoTotal', 'Costo interno'], ['utilidad', 'Utilidad'], ['margenPct', 'Margen %'], ['semaforo', 'Semáforo'],
  ['horasTotales', 'Horas'], ['gastosFijosAplicados', 'Gastos fijos aplic.'], ['diasEsperados', 'Días esperados'],
  ['diasRealesCobro', 'Días reales'], ['totalRecaudado', 'Recaudado'], ['saldoPendiente', 'Saldo'], ['estadoPago', 'Estado pago'],
];

function paintTabla() {
  const rows = filtrarYOrdenar();
  const wrap = document.getElementById('tabla-wrap');
  wrap.innerHTML = `
    <table>
      <thead><tr>${COLS.map(([k, l]) => `<th class="sortable" data-col="${k}">${l}${sortState.col === k ? (sortState.dir === 1 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(rowHtml).join('') || '<tr><td colspan="15" class="empty-state">Sin resultados con los filtros actuales.</td></tr>'}</tbody>
    </table>
  `;
  wrap.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      sortState.dir = sortState.col === col ? -sortState.dir : -1;
      sortState.col = col;
      paintTabla();
    });
  });
  wrap.querySelectorAll('tr.clickable').forEach((tr) => {
    tr.addEventListener('click', () => { location.hash = `#/cotizaciones/${tr.dataset.id}`; });
  });
}

function rowHtml(r) {
  return `<tr class="clickable" data-id="${r.id}">
    <td>${esc(r.numero)}</td><td>${esc(r.cliente)}</td><td>${fmtDMY(r.fecha_cotizacion)}</td>
    <td class="num">${money(r.precio_venta)}</td><td class="num">${money(r.costoInternoTotal)}</td>
    <td class="num">${money(r.utilidad)}</td><td class="num">${pct(r.margenPct)}</td>
    <td><span class="sem ${SEMAFORO_CLASS[r.semaforo]}">${SEMAFORO_LABEL[r.semaforo]}</span></td>
    <td class="num">${num(r.horasTotales, 0)}</td><td class="num">${money(r.gastosFijosAplicados)}</td>
    <td class="num">${r.diasEsperados ?? '—'}</td><td class="num">${r.diasRealesCobro ?? '—'}</td>
    <td class="num">${money(r.totalRecaudado)}</td><td class="num">${money(r.saldoPendiente)}</td>
    <td><span class="pago-badge pago-${r.estadoPago.replace(' ', '.')}">${esc(r.estadoPago)}</span></td>
  </tr>`;
}

function exportarCsv(rows) {
  const headers = COLS.map(([, l]) => l);
  const lines = [headers.join(',')];
  rows.forEach((r) => {
    const vals = COLS.map(([k]) => {
      let v = r[k];
      if (typeof v === 'number') v = String(v);
      return `"${String(v ?? '').replace(/"/g, '""')}"`;
    });
    lines.push(vals.join(','));
  });
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tablero_cotizaciones.csv';
  a.click();
}
