// Graficos SVG minimalistas, sin librerias externas, siguiendo la paleta validada
// (ver skill dataviz): orden categorico fijo, marcas delgadas, leyenda y etiquetas directas.
import { money, pct, num, esc } from './format.js';

export const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
export const STATUS = { good: '#0ca30c', warning: '#b3790f', serious: '#ec835a', critical: '#d03b3b' };

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

let tooltipEl = null;
function tooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'viz-tooltip';
    tooltipEl.style.display = 'none';
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}
function showTooltip(evt, html) {
  const tt = tooltip();
  tt.innerHTML = html;
  tt.style.left = evt.clientX + 'px';
  tt.style.top = evt.clientY + 'px';
  tt.style.display = 'block';
}
function hideTooltip() { if (tooltipEl) tooltipEl.style.display = 'none'; }

// ---------- Barra horizontal (utilidad por cotizacion/cliente, horas por trabajador) ----------
export function horizontalBarChart(container, { data, valueFmt = money, color = '#2a78d6', height, negativeColor = '#d03b3b' }) {
  container.innerHTML = '';
  if (!data || !data.length) { container.innerHTML = '<div class="empty-state">Sin datos para graficar.</div>'; return; }
  const W = container.clientWidth || 600;
  const rowH = 26;
  const H = height || Math.max(60, data.length * rowH + 20);
  const maxAbs = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const labelW = Math.min(180, W * 0.32);
  const barAreaW = W - labelW - 90;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  data.forEach((d, i) => {
    const y = i * rowH + 6;
    const barW = Math.max(1, (Math.abs(d.value) / maxAbs) * barAreaW);
    const g = svgEl('g');
    const label = svgEl('text', { x: 0, y: y + 13, 'font-size': 11.5, fill: '#52514e' });
    label.textContent = d.label.length > 22 ? d.label.slice(0, 21) + '…' : d.label;
    const rect = svgEl('rect', {
      x: labelW, y, width: barW, height: 15, rx: 4,
      fill: d.value < 0 ? negativeColor : (d.color || color),
    });
    const valText = svgEl('text', { x: labelW + barW + 6, y: y + 12, 'font-size': 11.5, fill: '#0b0b0b', 'font-weight': 600 });
    valText.textContent = valueFmt(d.value);
    rect.addEventListener('mousemove', (e) => showTooltip(e, d.tooltip || `<strong>${esc(d.label)}</strong><br>${valueFmt(d.value)}`));
    rect.addEventListener('mouseleave', hideTooltip);
    g.append(label, rect, valText);
    svg.appendChild(g);
  });
  container.appendChild(svg);
}

// ---------- Barras verticales agrupadas (presupuestado vs real) ----------
export function groupedBarChart(container, { categories, series, valueFmt = money }) {
  container.innerHTML = '';
  if (!categories || !categories.length) { container.innerHTML = '<div class="empty-state">Sin datos para graficar.</div>'; return; }
  const W = container.clientWidth || 600;
  const H = 260;
  const padL = 60, padB = 40, padT = 14, padR = 10;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxVal = Math.max(1, ...series.flatMap((s) => s.data));
  const groupW = plotW / categories.length;
  const barW = Math.min(28, (groupW - 12) / series.length);
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  // gridlines
  for (let i = 0; i <= 4; i++) {
    const y = padT + plotH - (i / 4) * plotH;
    svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: '#e1e0d9', 'stroke-width': 1 }));
    const t = svgEl('text', { x: padL - 8, y: y + 4, 'font-size': 10.5, fill: '#898781', 'text-anchor': 'end' });
    t.textContent = valueFmt((maxVal / 4) * i).replace('$ ', '');
    svg.appendChild(t);
  }
  categories.forEach((cat, ci) => {
    const gx = padL + ci * groupW + (groupW - barW * series.length) / 2;
    series.forEach((s, si) => {
      const v = s.data[ci] || 0;
      const h = (v / maxVal) * plotH;
      const rect = svgEl('rect', { x: gx + si * barW, y: padT + plotH - h, width: barW - 3, height: h, rx: 3, fill: s.color });
      rect.addEventListener('mousemove', (e) => showTooltip(e, `<strong>${esc(cat)}</strong><br>${esc(s.name)}: ${valueFmt(v)}`));
      rect.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(rect);
    });
    const t = svgEl('text', { x: padL + ci * groupW + groupW / 2, y: H - padB + 16, 'font-size': 10.5, fill: '#52514e', 'text-anchor': 'middle' });
    t.textContent = cat.length > 12 ? cat.slice(0, 11) + '…' : cat;
    svg.appendChild(t);
  });
  container.appendChild(svg);
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = series.map((s) => `<span class="item"><span class="dot" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('');
  container.appendChild(legend);
}

// ---------- Lineas (evolucion mensual) ----------
export function lineChart(container, { categories, series, valueFmt = money }) {
  container.innerHTML = '';
  if (!categories || !categories.length) { container.innerHTML = '<div class="empty-state">Sin datos para graficar.</div>'; return; }
  const W = container.clientWidth || 600;
  const H = 260;
  const padL = 64, padB = 34, padT = 14, padR = 16;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxVal = Math.max(1, ...series.flatMap((s) => s.data));
  const stepX = categories.length > 1 ? plotW / (categories.length - 1) : 0;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  for (let i = 0; i <= 4; i++) {
    const y = padT + plotH - (i / 4) * plotH;
    svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: '#e1e0d9', 'stroke-width': 1 }));
    const t = svgEl('text', { x: padL - 8, y: y + 4, 'font-size': 10.5, fill: '#898781', 'text-anchor': 'end' });
    t.textContent = valueFmt((maxVal / 4) * i).replace('$ ', '');
    svg.appendChild(t);
  }
  categories.forEach((cat, i) => {
    const t = svgEl('text', { x: padL + i * stepX, y: H - padB + 16, 'font-size': 10.5, fill: '#52514e', 'text-anchor': 'middle' });
    t.textContent = cat;
    svg.appendChild(t);
  });
  series.forEach((s) => {
    const pts = s.data.map((v, i) => [padL + i * stepX, padT + plotH - (v / maxVal) * plotH]);
    const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    svg.appendChild(svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    pts.forEach(([x, y], i) => {
      const c = svgEl('circle', { cx: x, cy: y, r: 4, fill: s.color, stroke: '#fcfcfb', 'stroke-width': 1.5 });
      c.addEventListener('mousemove', (e) => showTooltip(e, `<strong>${esc(categories[i])}</strong><br>${esc(s.name)}: ${valueFmt(s.data[i])}`));
      c.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(c);
    });
  });
  container.appendChild(svg);
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = series.map((s) => `<span class="item"><span class="dot" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('');
  container.appendChild(legend);
}

// ---------- Donut (composicion de costo) ----------
export function donutChart(container, { data, valueFmt = money }) {
  container.innerHTML = '';
  const total = data.reduce((a, d) => a + Math.max(0, d.value), 0);
  if (!total) { container.innerHTML = '<div class="empty-state">Sin datos para graficar.</div>'; return; }
  const size = Math.min(220, container.clientWidth || 220);
  const r = size / 2 - 10, cx = size / 2, cy = size / 2, rInner = r * 0.55;
  const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
  let ang = -Math.PI / 2;
  data.filter((d) => d.value > 0).forEach((d) => {
    const frac = d.value / total;
    const a0 = ang, a1 = ang + frac * Math.PI * 2;
    ang = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const xi0 = cx + rInner * Math.cos(a1), yi0 = cy + rInner * Math.sin(a1);
    const xi1 = cx + rInner * Math.cos(a0), yi1 = cy + rInner * Math.sin(a0);
    const path = `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${xi0},${yi0} A${rInner},${rInner} 0 ${large} 0 ${xi1},${yi1} Z`;
    const el = svgEl('path', { d: path, fill: d.color, stroke: '#fcfcfb', 'stroke-width': 2 });
    el.addEventListener('mousemove', (e) => showTooltip(e, `<strong>${esc(d.label)}</strong><br>${valueFmt(d.value)} (${pct(d.value / total)})`));
    el.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(el);
  });
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.gap = '16px';
  wrap.style.alignItems = 'center';
  wrap.style.flexWrap = 'wrap';
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.style.flexDirection = 'column';
  legend.innerHTML = data.filter((d) => d.value > 0).map((d) => `<span class="item"><span class="dot" style="background:${d.color}"></span>${esc(d.label)}: <strong>${valueFmt(d.value)}</strong> (${pct(d.value / total)})</span>`).join('');
  wrap.append(svg, legend);
  container.appendChild(wrap);
}

// ---------- Barra simple vertical (antiguedad de cartera) ----------
export function severityBarChart(container, { data, valueFmt = money }) {
  container.innerHTML = '';
  const total = data.reduce((a, d) => a + d.value, 0);
  if (!total) { container.innerHTML = '<div class="empty-state">Sin cartera pendiente.</div>'; return; }
  const W = container.clientWidth || 500;
  const H = 200;
  const padL = 10, padB = 34, padT = 14, padR = 10;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxVal = Math.max(1, ...data.map((d) => d.value));
  const bw = plotW / data.length;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  data.forEach((d, i) => {
    const h = (d.value / maxVal) * plotH;
    const x = padL + i * bw + bw * 0.15;
    const w = bw * 0.7;
    const rect = svgEl('rect', { x, y: padT + plotH - h, width: w, height: h, rx: 4, fill: d.color });
    rect.addEventListener('mousemove', (e) => showTooltip(e, `<strong>${esc(d.label)}</strong><br>${valueFmt(d.value)}`));
    rect.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(rect);
    const vt = svgEl('text', { x: x + w / 2, y: padT + plotH - h - 6, 'font-size': 10.5, 'text-anchor': 'middle', fill: '#0b0b0b', 'font-weight': 600 });
    vt.textContent = valueFmt(d.value).replace('$ ', '');
    if (d.value > 0) svg.appendChild(vt);
    const t = svgEl('text', { x: x + w / 2, y: H - padB + 16, 'font-size': 10.5, 'text-anchor': 'middle', fill: '#52514e' });
    t.textContent = d.label;
    svg.appendChild(t);
  });
  container.appendChild(svg);
}
