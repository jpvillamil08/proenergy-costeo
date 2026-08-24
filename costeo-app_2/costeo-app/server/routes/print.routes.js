'use strict';
const { HttpError } = require('../lib/http-helpers');
const { withAuth } = require('../lib/guard');
const svc = require('../lib/cotizacion-service');
const { fmtDMY } = require('../lib/dates');

const EMPRESA = 'PROENERGY'; // Nombre/razon social que aparece en las cotizaciones impresas

function money(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '$ 0';
  return '$ ' + Math.round(v).toLocaleString('es-CO', { maximumFractionDigits: 0 });
}
function pct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '0,0%';
  return (v * 100).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2937; margin: 0; padding: 32px; font-size: 13px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 14px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #1f4e5f; color: #1f4e5f; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1f4e5f; padding-bottom: 12px; margin-bottom: 16px; }
  .header .empresa-block { display: flex; align-items: center; gap: 10px; }
  .header .empresa-block img { height: 38px; width: auto; }
  .empresa { font-size: 16px; font-weight: 700; color: #1f4e5f; }
  .doc-title { text-align: right; }
  .doc-title .numero { font-size: 22px; font-weight: 700; color: #1f4e5f; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; }
  th { background: #f1f5f7; font-size: 11px; text-transform: uppercase; color: #475569; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin-bottom: 8px; }
  .info-grid div span.label { color: #64748b; }
  .totales { margin-top: 12px; width: 320px; margin-left: auto; }
  .totales tr td:first-child { color: #475569; }
  .totales tr.grand td { font-weight: 700; font-size: 16px; border-top: 2px solid #1f4e5f; color: #1f4e5f; }
  .semaforo { display: inline-block; padding: 6px 16px; border-radius: 6px; font-weight: 700; font-size: 14px; }
  .semaforo.VIABLE { background: #dcfce7; color: #166534; }
  .semaforo.VIABLE_CON_AJUSTE { background: #fef3c7; color: #92400e; }
  .semaforo.NO_VIABLE { background: #fee2e2; color: #991b1b; }
  .footer { margin-top: 40px; font-size: 11px; color: #94a3b8; text-align: center; }
  @media print { body { padding: 12mm; } .no-print { display: none; } }
  .no-print { margin-bottom: 16px; }
  .no-print button { padding: 8px 16px; font-size: 13px; cursor: pointer; }
`;

function layout(title, body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>${BASE_CSS}</style></head><body>
  <div class="no-print"><button onclick="window.print()">Imprimir / Guardar como PDF</button></div>
  ${body}
  </body></html>`;
}

function comercialHtml(full) {
  const { cot } = full;
  const cart = full.calculo.cartera;
  const materiales = full.materiales;
  const manoObra = full.manoObra;
  const totalHoras = manoObra.reduce((a, m) => a + (m.horas_presupuestadas || 0), 0);
  return layout(`Cotización ${cot.numero} - ${cot.cliente}`, `
    <div class="header">
      <div class="empresa-block"><img src="/img/logo.png" alt="${esc(EMPRESA)}"><div><div class="empresa">${esc(EMPRESA)}</div><div>Servicios eléctricos y de energía</div></div></div>
      <div class="doc-title"><div>COTIZACIÓN</div><div class="numero">${esc(cot.numero)}</div><div>${fmtDMY(cot.fecha_cotizacion)}</div></div>
    </div>
    <div class="info-grid">
      <div><span class="label">Cliente: </span><strong>${esc(cot.cliente)}</strong></div>
      <div><span class="label">Condición de pago: </span>${esc(cot.condicion_pago)}${cot.condicion_pago === 'Credito' ? ` (${cot.dias_credito_otorgados} días)` : ''}</div>
      <div><span class="label">Descripción del trabajo: </span>${esc(cot.descripcion || '-')}</div>
      <div><span class="label">Anticipo solicitado: </span>${pct(cot.pct_anticipo)}</div>
    </div>
    <h2>Alcance del trabajo</h2>
    <table><thead><tr><th>Concepto</th><th class="num">Horas estimadas</th></tr></thead>
    <tbody>${manoObra.map((m) => `<tr><td>${esc(m.nombre_snapshot)} - ${esc(m.tipo)}</td><td class="num">${m.horas_presupuestadas}</td></tr>`).join('') || '<tr><td colspan="2">Sin líneas registradas</td></tr>'}
    <tr><td><strong>Total horas estimadas</strong></td><td class="num"><strong>${totalHoras}</strong></td></tr></tbody></table>
    <h2>Materiales e insumos incluidos</h2>
    <table><thead><tr><th>Descripción</th><th class="num">Cantidad</th></tr></thead>
    <tbody>${materiales.map((m) => `<tr><td>${esc(m.descripcion)}</td><td class="num">${m.cantidad_presupuestada}</td></tr>`).join('') || '<tr><td colspan="2">Sin líneas registradas</td></tr>'}</tbody></table>
    <table class="totales">
      <tr><td>Precio de venta (sin IVA)</td><td class="num">${money(cot.precio_venta)}</td></tr>
      <tr><td>IVA</td><td class="num">${money(cart.valorFacturado - cot.precio_venta)}</td></tr>
      <tr class="grand"><td>Total a facturar</td><td class="num">${money(cart.valorFacturado)}</td></tr>
    </table>
    <p>Fecha esperada de pago: <strong>${cart.fechaPagoEsperada ? fmtDMY(cart.fechaPagoEsperada) : 'Por definir (pendiente de aprobación)'}</strong></p>
    <div class="footer">${esc(EMPRESA)} — Documento generado por el sistema de costeo y cotizaciones</div>
  `);
}

function interaLinea(l) {
  return `<tr><td>${esc(l.concepto)}</td><td style="color:#64748b;font-size:11px">${esc(l.formula)}</td><td class="num">${l.esPct ? pct(l.valor) : l.esHoras ? (l.valor || 0).toLocaleString('es-CO') : money(l.valor)}</td></tr>`;
}

function internaHtml(full) {
  const { cot, calculo } = full;
  const c = calculo.costeoPresupuestado;
  const rent = calculo.rentabilidad;
  const sem = calculo.semaforo;
  const cart = calculo.cartera;
  return layout(`Cotización interna ${cot.numero} - ${cot.cliente}`, `
    <div class="header">
      <div class="empresa-block"><img src="/img/logo.png" alt="${esc(EMPRESA)}"><div><div class="empresa">${esc(EMPRESA)}</div><div>Documento interno de costeo — uso exclusivo Gerencia/Administración</div></div></div>
      <div class="doc-title"><div>COTIZACIÓN INTERNA</div><div class="numero">${esc(cot.numero)}</div><div>${fmtDMY(cot.fecha_cotizacion)}</div></div>
    </div>
    <div class="info-grid">
      <div><span class="label">Cliente: </span><strong>${esc(cot.cliente)}</strong></div>
      <div><span class="label">Estado: </span>${esc(cot.estado)}</div>
      <div><span class="label">Descripción: </span>${esc(cot.descripcion || '-')}</div>
      <div><span class="label">Semáforo: </span><span class="semaforo ${sem.estado}">${sem.estado.replace(/_/g, ' ')}</span></div>
    </div>
    <h2>Costeo detallado</h2>
    <table><thead><tr><th>Concepto</th><th>Fórmula</th><th class="num">Valor</th></tr></thead>
    <tbody>${c.desglose.map(interaLinea).join('')}</tbody></table>
    <h2>Rentabilidad</h2>
    <table><thead><tr><th>Concepto</th><th>Fórmula</th><th class="num">Valor</th></tr></thead>
    <tbody>${rent.desglose.map(interaLinea).join('')}</tbody></table>
    <h2>Viabilidad</h2>
    <p><span class="semaforo ${sem.estado}">${sem.estado.replace(/_/g, ' ')}</span></p>
    <p>${esc(sem.mensaje)}</p>
    <h2>Cartera</h2>
    <table><thead><tr><th>Concepto</th><th>Fórmula</th><th class="num">Valor</th></tr></thead>
    <tbody>${cart.desglose.map(interaLinea).join('')}</tbody></table>
    <p>Estado de pago: <strong>${esc(cart.estadoPago)}</strong> — Días esperados: ${cart.diasEsperados} — Días reales: ${cart.diasRealesCobro ?? 'N/A'}</p>
    <div class="footer">Documento interno — no distribuir al cliente</div>
  `);
}

module.exports = (router) => {
  router.get('/print/comercial/:id', withAuth(async ({ res, params }) => {
    const full = svc.getCotizacionFull(params.id);
    if (!full) throw new HttpError(404, 'Cotización no encontrada');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(comercialHtml(full));
  }));

  router.get('/print/interna/:id', withAuth(async ({ res, params, user }) => {
    if (user.rol !== 'admin' && user.rol !== 'gerencia') throw new HttpError(403, 'No autorizado');
    const full = svc.getCotizacionFull(params.id);
    if (!full) throw new HttpError(404, 'Cotización no encontrada');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(internaHtml(full));
  }));
};
