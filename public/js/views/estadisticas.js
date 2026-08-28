import { api } from '../api.js';
import { money, pct, num, todayInputVal } from '../format.js';
import { lineChart, horizontalBarChart, PALETTE } from '../charts.js';
import { stillMounted } from '../guard.js';

// Rango por defecto: ultimo año.
function haceUnAnio() {
  const n = new Date();
  n.setFullYear(n.getFullYear() - 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

const filtros = { desde: haceUnAnio(), hasta: todayInputVal() };

export async function renderEstadisticas(content, state) {
  content.innerHTML = '<div class="spinner-msg">Cargando estadísticas…</div>';
  const cotizaciones = await api.get(`/api/cotizaciones/estadisticas?desde=${filtros.desde}&hasta=${filtros.hasta}`);
  if (!stillMounted(content)) return;
  paint(content, state, { cotizaciones });
}

function paint(content, state, data) {
  const { cotizaciones } = data;

  content.innerHTML = `
    <div class="toolbar"><h1 class="mt-0">Estadísticas</h1></div>
    <div class="card">
      <div class="filters" id="filtros-globales">
        <div class="field"><label>Desde</label><input type="date" id="f-desde" value="${filtros.desde}"></div>
        <div class="field"><label>Hasta</label><input type="date" id="f-hasta" value="${filtros.hasta}"></div>
      </div>
    </div>

    <div class="section-title"><h2>Cotizaciones: creadas vs. aprobadas</h2></div>
    <div id="bloque-cotizaciones"></div>
  `;

  document.getElementById('f-desde').addEventListener('change', (e) => { filtros.desde = e.target.value; renderEstadisticas(content, state); });
  document.getElementById('f-hasta').addEventListener('change', (e) => { filtros.hasta = e.target.value; renderEstadisticas(content, state); });

  paintCotizaciones(document.getElementById('bloque-cotizaciones'), cotizaciones);
}

function paintCotizaciones(el, c) {
  const conv = c.tasaConversionSobreDecididas === null ? '—' : pct(c.tasaConversionSobreDecididas);
  el.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="label">Cotizaciones creadas</div><div class="value">${num(c.total, 0)}</div></div>
      <div class="kpi"><div class="label">Aprobadas (Aprobada/Ejecutada/Cerrada)</div><div class="value">${num(c.aprobadas, 0)}</div></div>
      <div class="kpi"><div class="label">Tasa de conversión (sobre decididas)</div><div class="value">${conv}</div></div>
      <div class="kpi"><div class="label">Valor total cotizado</div><div class="value">${money(c.valorTotalCotizado)}</div></div>
      <div class="kpi"><div class="label">Valor aprobado</div><div class="value">${money(c.valorAprobado)}</div></div>
      <div class="kpi"><div class="label">Por estado</div><div class="sub">${Object.entries(c.porEstado).map(([e, n]) => `${e}: <strong>${n}</strong>`).join(' · ') || '—'}</div></div>
    </div>
    <div class="grid-2">
      <div class="card"><div class="chart-title">Creadas vs. aprobadas por mes</div><div id="chart-cot-mes"></div></div>
      <div class="card"><div class="chart-title">Cotizaciones por estado</div><div id="chart-cot-estado"></div></div>
    </div>
  `;
  lineChart(document.getElementById('chart-cot-mes'), {
    categories: c.porMes.map((m) => m.mes),
    series: [
      { name: 'Creadas', color: PALETTE[0], data: c.porMes.map((m) => m.creadas) },
      { name: 'Aprobadas', color: PALETTE[2], data: c.porMes.map((m) => m.aprobadas) },
    ],
    valueFmt: (v) => num(v, 0),
  });
  const estadosOrden = ['Borrador', 'Enviada', 'Aprobada', 'Rechazada', 'Ejecutada', 'Cerrada'];
  horizontalBarChart(document.getElementById('chart-cot-estado'), {
    data: estadosOrden.filter((e) => c.porEstado[e]).map((e, i) => ({ label: e, value: c.porEstado[e], color: PALETTE[i % PALETTE.length] })),
    color: PALETTE[1],
    valueFmt: (v) => num(v, 0),
  });
}
