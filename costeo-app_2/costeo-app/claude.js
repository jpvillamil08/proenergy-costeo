import { api } from '../api.js';
import { money, pct, esc } from '../format.js';
import { stillMounted } from '../guard.js';

const MESES_ABR = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

let isAdmin = false, tab = 'presupuesto', anio = 2026, anios = [2026];
let estado = null, ventas = null, editandoLineaId = null, editandoMacroId = null;

export async function renderPresupuesto(content, state) {
  isAdmin = state.usuario.rol === 'admin';
  tab = 'presupuesto'; editandoLineaId = null; editandoMacroId = null;
  content.innerHTML = '<div class="spinner-msg">Cargando presupuesto…</div>';
  const listaAnios = await api.get('/api/presupuesto/anios');
  if (!stillMounted(content)) return;
  anios = listaAnios.length ? listaAnios : [2026];
  anio = anios.includes(2026) ? 2026 : anios[0];
  await cargarPresupuesto(content);
}

async function cargarPresupuesto(content) {
  estado = await api.get(`/api/presupuesto/estado?anio=${anio}`);
  if (!stillMounted(content)) return;
  paint(content);
}

async function cargarVentas(content) {
  if (ventas) { paint(content); return; }
  ventas = await api.get('/api/ventas-historicas');
  if (!stillMounted(content)) return;
  paint(content);
}

function tabBtn(id, label) { return `<button data-tab="${id}" class="${tab === id ? 'active' : ''}">${label}</button>`; }

function paint(content) {
  content.innerHTML = `
    <div class="toolbar">
      <h1 class="mt-0">Presupuesto</h1>
      <div class="field" style="max-width:140px; margin:0;">
        <label>Año</label>
        <select id="sel-anio">${anios.map((a) => `<option value="${a}" ${a === anio ? 'selected' : ''}>${a}</option>`).join('')}</select>
      </div>
    </div>
    <div class="tabs" id="tabs">
      ${tabBtn('presupuesto', 'Presupuesto ' + anio)}
      ${tabBtn('ventas', 'Ventas históricas (referencia)')}
    </div>
    <div id="tab-body"></div>
  `;
  document.getElementById('sel-anio').addEventListener('change', async (e) => {
    anio = Number(e.target.value);
    editandoLineaId = null; editandoMacroId = null;
    content.querySelector('#tab-body').innerHTML = '<div class="spinner-msg">Cargando…</div>';
    await cargarPresupuesto(content);
  });
  content.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', async () => {
    tab = b.dataset.tab;
    if (tab === 'ventas' && !ventas) {
      paint(content);
      content.querySelector('#tab-body').innerHTML = '<div class="spinner-msg">Cargando…</div>';
      await cargarVentas(content);
      return;
    }
    paint(content);
  }));

  const body = document.getElementById('tab-body');
  if (tab === 'presupuesto') paintPresupuesto(body, content);
  else paintVentas(body);
}

// ---------------- Presupuesto (macro + P&G) ----------------
function paintPresupuesto(body, content) {
  body.innerHTML = `
    <div class="card">
      <h3 class="mt-0">Variables macroeconómicas ${anio}</h3>
      <p class="muted" style="margin-top:-6px; font-size:12.5px;">Tasa impositiva, IPC, PIB, IBR y renta presuntiva usados en la proyección.</p>
      <div class="table-wrap">${tablaMacro()}</div>
    </div>
    <div class="card">
      <div class="section-title" style="margin:0 0 10px;">
        <h2>Estado de resultados proyectado</h2>
        <span class="muted" style="font-size:12px;">Los valores se importaron del modelo de presupuesto en Excel. ${isAdmin ? 'Haz clic en una fila para editarla.' : ''}</span>
      </div>
      <div class="table-wrap">${tablaPresupuesto()}</div>
    </div>
  `;
  cablearMacro(body);
  cablearPresupuesto(body);
}

function totalFila(valores) {
  return valores.reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);
}

function tablaMacro() {
  const filas = estado.macro.map((v) => {
    const editando = editandoMacroId === v.id;
    const celdas = v.valores.map((val, i) => editando
      ? `<td class="num"><input type="number" step="0.0001" data-mes="${i}" value="${val ?? ''}" style="width:78px; padding:4px 6px;"></td>`
      : `<td class="num">${val === null ? '—' : pct(val, 2)}</td>`
    ).join('');
    return `
      <tr data-id="${v.id}" class="${isAdmin ? 'clickable' : ''}">
        <td>${esc(v.etiqueta)}</td>
        ${celdas}
        ${isAdmin ? `<td class="btn-row">${editando
          ? `<button class="btn btn-sm btn-primary act-guardar-macro">Guardar</button><button class="btn btn-sm btn-secondary act-cancelar-macro">Cancelar</button>`
          : `<button class="btn btn-sm btn-secondary act-editar-macro">Editar</button>`}</td>` : ''}
      </tr>`;
  }).join('');
  return `
    <table>
      <thead><tr><th>Variable</th>${MESES_ABR.map((m) => `<th class="num">${m}</th>`).join('')}${isAdmin ? '<th></th>' : ''}</tr></thead>
      <tbody>${filas || `<tr><td colspan="14" class="empty-state">Sin variables macroeconómicas para ${anio}.</td></tr>`}</tbody>
    </table>`;
}

function tablaPresupuesto() {
  const real = estado.real;
  const filas = estado.lineas.map((l) => {
    const editando = editandoLineaId === l.id;
    const esFuerte = l.nivel <= 1;
    const indent = 10 + l.nivel * 16;
    const total = totalFila(l.valores);
    const celdas = l.valores.map((val, i) => editando
      ? `<td class="num"><input type="number" step="1" data-mes="${i}" value="${val ?? ''}" style="width:92px; padding:4px 6px;"></td>`
      : `<td class="num">${val === null ? '—' : money(val)}</td>`
    ).join('');
    const filaPrincipal = `
      <tr data-id="${l.id}" class="${isAdmin && !editando ? 'clickable' : ''}" style="${esFuerte ? 'font-weight:700;' : ''} ${l.esTotal ? 'border-top:2px solid var(--grid);' : ''}">
        <td style="padding-left:${indent}px;">${esc(l.etiqueta)}</td>
        ${celdas}
        <td class="num" style="${esFuerte ? '' : 'color:var(--ink-2);'}">${money(total)}</td>
        ${isAdmin ? `<td class="btn-row">${editando
          ? `<button class="btn btn-sm btn-primary act-guardar-linea">Guardar</button><button class="btn btn-sm btn-secondary act-cancelar-linea">Cancelar</button>`
          : `<button class="btn btn-sm btn-secondary act-editar-linea">Editar</button>`}</td>` : ''}
      </tr>`;

    if (real.lineaId !== l.id) return filaPrincipal;

    // Fila de comparacion "Real" justo debajo de la linea presupuestada que se compara
    const totalReal = real.porMes.some((v) => v !== null) ? totalFila(real.porMes.map((v) => v || 0)) : null;
    const celdasReal = real.porMes.map((v, i) => {
      const presu = l.valores[i];
      if (v === null) return '<td class="num muted">—</td>';
      const cumpl = presu ? v / presu : null;
      return `<td class="num" style="color:var(--ink-2);">${money(v)}${cumpl !== null ? `<div style="font-size:10.5px; color:${cumpl >= 0.9 ? 'var(--good)' : cumpl >= 0.6 ? 'var(--warning)' : 'var(--critical)'};">${pct(cumpl, 0)}</div>` : ''}</td>`;
    }).join('');
    const filaReal = `
      <tr style="background:var(--page);">
        <td style="padding-left:${indent + 10}px; font-size:12.5px; color:var(--ink-2);">↳ Real facturado en el sistema (cotizaciones aprobadas/ejecutadas/cerradas)</td>
        ${celdasReal}
        <td class="num" style="color:var(--ink-2);">${totalReal === null ? '—' : money(totalReal)}</td>
        ${isAdmin ? '<td></td>' : ''}
      </tr>`;
    return filaPrincipal + filaReal;
  }).join('');

  return `
    <table>
      <thead><tr><th>Concepto</th>${MESES_ABR.map((m) => `<th class="num">${m}</th>`).join('')}<th class="num">Total ${anio}</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
      <tbody>${filas || `<tr><td colspan="15" class="empty-state">Sin datos de presupuesto para ${anio}.</td></tr>`}</tbody>
    </table>`;
}

function cablearMacro(body) {
  if (!isAdmin) return;
  body.querySelectorAll('.act-editar-macro').forEach((btn) => btn.addEventListener('click', (e) => {
    editandoMacroId = Number(e.target.closest('tr').dataset.id);
    paintPresupuesto(body, null);
  }));
  body.querySelectorAll('.act-cancelar-macro').forEach((btn) => btn.addEventListener('click', () => {
    editandoMacroId = null;
    paintPresupuesto(body, null);
  }));
  body.querySelectorAll('.act-guardar-macro').forEach((btn) => btn.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr');
    const valores = Array.from(tr.querySelectorAll('input[data-mes]')).map((inp) => inp.value === '' ? null : Number(inp.value));
    await api.put(`/api/presupuesto/macro/${tr.dataset.id}`, { anio, valores });
    editandoMacroId = null;
    await cargarPresupuesto(document.getElementById('content'));
  }));
}

function cablearPresupuesto(body) {
  if (!isAdmin) return;
  body.querySelectorAll('.act-editar-linea').forEach((btn) => btn.addEventListener('click', (e) => {
    editandoLineaId = Number(e.target.closest('tr').dataset.id);
    paintPresupuesto(body, null);
  }));
  body.querySelectorAll('.act-cancelar-linea').forEach((btn) => btn.addEventListener('click', () => {
    editandoLineaId = null;
    paintPresupuesto(body, null);
  }));
  body.querySelectorAll('.act-guardar-linea').forEach((btn) => btn.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr');
    const valores = Array.from(tr.querySelectorAll('input[data-mes]')).map((inp) => inp.value === '' ? null : Number(inp.value));
    await api.put(`/api/presupuesto/lineas/${tr.dataset.id}`, { anio, valores });
    editandoLineaId = null;
    const content = document.getElementById('content');
    await cargarPresupuesto(content);
  }));
}

// ---------------- Ventas historicas ----------------
function paintVentas(body) {
  if (!ventas) { body.innerHTML = '<div class="spinner-msg">Cargando…</div>'; return; }
  body.innerHTML = `
    <div class="card">
      <h3 class="mt-0">Ventas por producto/servicio</h3>
      <p class="muted" style="margin-top:-6px; font-size:12.5px;">Histórico importado del Excel de la empresa (solo referencia, no editable).</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Item</th><th>Descripción</th><th>Clasificación</th><th class="num">Total</th><th></th></tr></thead>
        <tbody>${ventas.productos.map((p) => `
          <tr>
            <td>${esc(p.item || '—')}</td>
            <td>${esc(p.descripcion)}</td>
            <td>${esc(p.clasificacion || '—')}</td>
            <td class="num">${money(p.total)}</td>
            <td>
              <details class="desglose"><summary>Ver meses <span class="flecha">▸</span></summary>
              <div class="cuerpo"><table>
                <tbody>${Object.entries(p.valores).sort().map(([mes, v]) => `<tr><td>${esc(mes)}</td><td class="num">${money(v)}</td></tr>`).join('')}</tbody>
              </table></div></details>
            </td>
          </tr>`).join('') || '<tr><td colspan="5" class="empty-state">Sin datos.</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="card">
      <h3 class="mt-0">Ventas por cliente</h3>
      <p class="muted" style="margin-top:-6px; font-size:12.5px;">Facturación agrupada por cliente (histórico importado del Excel).</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Cliente</th><th>NIT</th><th class="num">Comprobantes</th><th class="num">Total</th><th></th></tr></thead>
        <tbody>${ventas.clientes.map((c) => `
          <tr>
            <td>${esc(c.cliente)}</td>
            <td>${esc(c.nit || '—')}</td>
            <td class="num">${c.comprobantes}</td>
            <td class="num">${money(c.total)}</td>
            <td>
              <details class="desglose"><summary>Ver detalle <span class="flecha">▸</span></summary>
              <div class="cuerpo"><table>
                <thead><tr><th>Mes</th><th class="num">Subtotal</th><th class="num">Impuesto cargo</th><th class="num">Total</th></tr></thead>
                <tbody>${c.detalle.map((d) => `<tr><td>${esc(d.mes || '—')}</td><td class="num">${money(d.subtotal)}</td><td class="num">${money(d.impuesto_cargo)}</td><td class="num">${money(d.total)}</td></tr>`).join('')}</tbody>
              </table></div></details>
            </td>
          </tr>`).join('') || '<tr><td colspan="5" class="empty-state">Sin datos.</td></tr>'}</tbody>
      </table></div>
    </div>
  `;
}
