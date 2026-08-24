'use strict';
const db = require('../db');
const { calcularCotizacion } = require('./calc');
const { addDays } = require('./dates');

function generarNumero() {
  const row = db.prepare(`SELECT numero FROM cotizaciones ORDER BY id DESC LIMIT 1`).get();
  let n = 1;
  if (row && row.numero) {
    const m = row.numero.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `COT-${String(n).padStart(4, '0')}`;
}

function getManoObra(cotId) {
  return db.prepare('SELECT * FROM cotizacion_mano_obra WHERE cotizacion_id = ? ORDER BY orden, id').all(cotId);
}
function getMateriales(cotId) {
  return db.prepare('SELECT * FROM cotizacion_materiales WHERE cotizacion_id = ? ORDER BY orden, id').all(cotId);
}
function getPagos(cotId) {
  return db.prepare('SELECT * FROM pagos WHERE cotizacion_id = ? ORDER BY fecha').all(cotId);
}
function getCxp(cotId) {
  return db.prepare('SELECT * FROM cuentas_por_pagar WHERE cotizacion_id = ? ORDER BY fecha_vencimiento').all(cotId);
}

// Regenera las cuentas por pagar pendientes de una cotizacion a partir de sus lineas de materiales a credito.
// Las cuentas ya marcadas como pagadas se conservan como historial.
function syncCuentasPorPagar(cotId) {
  db.prepare('DELETE FROM cuentas_por_pagar WHERE cotizacion_id = ? AND pagado = 0').run(cotId);
  const cot = db.prepare('SELECT * FROM cotizaciones WHERE id = ?').get(cotId);
  const materiales = getMateriales(cotId).filter((m) => m.forma_pago === 'Credito');
  const fechaBase = cot.fecha_aprobacion || cot.fecha_cotizacion;
  const insert = db.prepare(
    `INSERT INTO cuentas_por_pagar (cotizacion_id, cotizacion_material_id, proveedor_id, valor, fecha_compra, fecha_vencimiento, pagado)
     VALUES (?,?,?,?,?,?,0)`
  );
  for (const m of materiales) {
    const valor = (m.cantidad_presupuestada || 0) * m.costo_unitario;
    if (!valor) continue;
    const fechaCompra = m.fecha_compra || fechaBase;
    const vencimiento = addDays(fechaCompra, m.dias_credito_proveedor || 0);
    insert.run(cotId, m.id, m.proveedor_id, valor, fechaCompra, vencimiento);
  }
}

function getParametros(id) {
  return db.prepare('SELECT * FROM parametros_gastos_fijos WHERE id = ?').get(id);
}
function getPolitica(id) {
  return db.prepare('SELECT * FROM politicas_comerciales WHERE id = ?').get(id);
}

function getCotizacionFull(id) {
  const cot = db.prepare('SELECT * FROM cotizaciones WHERE id = ?').get(id);
  if (!cot) return null;
  const manoObra = getManoObra(id);
  const materiales = getMateriales(id);
  const pagos = getPagos(id);
  const cxp = getCxp(id);
  const parametros = getParametros(cot.parametros_id);
  const politica = getPolitica(cot.politica_id);
  const calculo = calcularCotizacion({ cot, manoObra, materiales, parametros, politica, pagos, cxp });
  return { cot, manoObra, materiales, pagos, cxp, parametros, politica, calculo };
}

function listCotizacionesFull() {
  const cots = db.prepare('SELECT * FROM cotizaciones ORDER BY fecha_cotizacion DESC, id DESC').all();
  return cots.map((cot) => {
    const manoObra = getManoObra(cot.id);
    const materiales = getMateriales(cot.id);
    const pagos = getPagos(cot.id);
    const cxp = getCxp(cot.id);
    const parametros = getParametros(cot.parametros_id);
    const politica = getPolitica(cot.politica_id);
    const calculo = calcularCotizacion({ cot, manoObra, materiales, parametros, politica, pagos, cxp });
    return { cot, manoObra, materiales, pagos, cxp, parametros, politica, calculo };
  });
}

module.exports = {
  generarNumero, getManoObra, getMateriales, getPagos, getCxp,
  syncCuentasPorPagar, getParametros, getPolitica, getCotizacionFull, listCotizacionesFull,
};
