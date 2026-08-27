'use strict';
const db = require('../db');
const { readJsonBody, readBody, HttpError } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { registrar } = require('../lib/audit');
const { toCsv, parseCsv } = require('../lib/csv');
const { writeXlsxMultiSheet, readXlsxFirstSheetAsObjects } = require('../lib/xlsx');
const svc = require('../lib/cotizacion-service');
const { vigenteEn: parametrosVigenteEn } = require('./parametros.routes');
const { vigenteEn: politicaVigenteEn } = require('./politicas.routes');
const { todayStr } = require('../lib/dates');

const COLS_COT = [
  { key: 'numero', label: 'numero' },
  { key: 'cliente', label: 'cliente' },
  { key: 'descripcion', label: 'descripcion' },
  { key: 'fecha_cotizacion', label: 'fecha_cotizacion' },
  { key: 'fecha_aprobacion', label: 'fecha_aprobacion' },
  { key: 'condicion_pago', label: 'condicion_pago' },
  { key: 'dias_credito_otorgados', label: 'dias_credito_otorgados' },
  { key: 'precio_venta', label: 'precio_venta' },
  { key: 'pct_anticipo', label: 'pct_anticipo' },
  { key: 'estado', label: 'estado' },
];
const COLS_MO = [
  { key: 'cotizacion_numero', label: 'cotizacion_numero' },
  { key: 'trabajador', label: 'trabajador' },
  { key: 'tipo', label: 'tipo' },
  { key: 'tarifa_hora', label: 'tarifa_hora' },
  { key: 'horas_presupuestadas', label: 'horas_presupuestadas' },
  { key: 'horas_reales', label: 'horas_reales' },
];
const COLS_MAT = [
  { key: 'cotizacion_numero', label: 'cotizacion_numero' },
  { key: 'descripcion', label: 'descripcion' },
  { key: 'clasificacion', label: 'clasificacion' },
  { key: 'forma_pago', label: 'forma_pago' },
  { key: 'proveedor', label: 'proveedor' },
  { key: 'dias_credito_proveedor', label: 'dias_credito_proveedor' },
  { key: 'fecha_compra', label: 'fecha_compra' },
  { key: 'cantidad_presupuestada', label: 'cantidad_presupuestada' },
  { key: 'cantidad_real', label: 'cantidad_real' },
  { key: 'costo_unitario', label: 'costo_unitario' },
];

function dataCotizaciones() {
  return db.prepare('SELECT * FROM cotizaciones ORDER BY numero').all();
}
function dataManoObra() {
  return db.prepare(
    `SELECT mo.*, c.numero AS cotizacion_numero FROM cotizacion_mano_obra mo JOIN cotizaciones c ON c.id = mo.cotizacion_id ORDER BY c.numero`
  ).all().map((r) => ({ ...r, trabajador: r.nombre_snapshot }));
}
function dataMateriales() {
  return db.prepare(
    `SELECT m.*, c.numero AS cotizacion_numero, p.nombre AS proveedor FROM cotizacion_materiales m
     JOIN cotizaciones c ON c.id = m.cotizacion_id LEFT JOIN proveedores p ON p.id = m.proveedor_id ORDER BY c.numero`
  ).all();
}

module.exports = (router) => {
  router.get('/api/export/cotizaciones.csv', withAuth(async ({ res }) => {
    const csv = '﻿' + toCsv(dataCotizaciones(), COLS_COT);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cotizaciones.csv"' });
    res.end(csv);
  }));
  router.get('/api/export/mano-obra.csv', withAuth(async ({ res }) => {
    const csv = '﻿' + toCsv(dataManoObra(), COLS_MO);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="mano_obra.csv"' });
    res.end(csv);
  }));
  router.get('/api/export/materiales.csv', withAuth(async ({ res }) => {
    const csv = '﻿' + toCsv(dataMateriales(), COLS_MAT);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="materiales.csv"' });
    res.end(csv);
  }));

  router.get('/api/export/cotizaciones.xlsx', withAuth(async ({ res }) => {
    const buf = writeXlsxMultiSheet([
      { name: 'Cotizaciones', headers: COLS_COT.map((c) => c.label), rows: dataCotizaciones().map((r) => COLS_COT.map((c) => r[c.key] ?? '')) },
      { name: 'Mano de obra', headers: COLS_MO.map((c) => c.label), rows: dataManoObra().map((r) => COLS_MO.map((c) => (c.key === 'trabajador' ? r.trabajador : r[c.key]) ?? '')) },
      { name: 'Materiales', headers: COLS_MAT.map((c) => c.label), rows: dataMateriales().map((r) => COLS_MAT.map((c) => r[c.key] ?? '')) },
    ]);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="cotizaciones.xlsx"',
    });
    res.end(buf);
  }));

  // Importacion: el cliente envia el archivo crudo (CSV o XLSX) en el cuerpo.
  // Query: ?tipo=cotizaciones|mano_obra|materiales&formato=csv|xlsx
  router.post('/api/import', withAdmin(async ({ req, res, query, user }) => {
    const buf = await readBody(req);
    let filas;
    if (query.formato === 'xlsx') {
      filas = readXlsxFirstSheetAsObjects(buf);
    } else {
      filas = parseCsv(buf.toString('utf8'));
    }
    let resultado;
    if (query.tipo === 'cotizaciones') resultado = importarCotizaciones(filas, user);
    else if (query.tipo === 'mano_obra') resultado = importarManoObra(filas, user);
    else if (query.tipo === 'materiales') resultado = importarMateriales(filas, user);
    else throw new HttpError(400, 'Tipo de importación no reconocido');
    const { sendJson } = require('../lib/http-helpers');
    sendJson(res, 200, resultado);
  }));
};

function importarCotizaciones(filas, user) {
  let creadas = 0, actualizadas = 0;
  const errores = [];
  for (const f of filas) {
    try {
      if (!f.numero || !f.cliente) { errores.push(`Fila sin numero o cliente: ${JSON.stringify(f)}`); continue; }
      const existente = db.prepare('SELECT * FROM cotizaciones WHERE numero = ?').get(f.numero);
      const fecha = f.fecha_cotizacion || todayStr();
      if (existente) {
        db.prepare(
          `UPDATE cotizaciones SET cliente=?, descripcion=?, fecha_cotizacion=?, fecha_aprobacion=?, condicion_pago=?,
           dias_credito_otorgados=?, precio_venta=?, pct_anticipo=?, estado=?, actualizado_por=?, actualizado_en=datetime('now') WHERE numero=?`
        ).run(
          f.cliente, f.descripcion || '', fecha, f.fecha_aprobacion || null, f.condicion_pago || 'Contado',
          Number(f.dias_credito_otorgados) || 0, Number(f.precio_venta) || 0, Number(f.pct_anticipo) || 0,
          f.estado || 'Borrador', user.id, f.numero
        );
        actualizadas++;
      } else {
        const param = parametrosVigenteEn(fecha);
        const politica = politicaVigenteEn(fecha);
        if (!param || !politica) { errores.push(`No hay parámetros/políticas vigentes para ${f.numero} (${fecha})`); continue; }
        db.prepare(
          `INSERT INTO cotizaciones (numero, cliente, descripcion, fecha_cotizacion, fecha_aprobacion, condicion_pago,
            dias_credito_otorgados, precio_venta, pct_anticipo, estado, parametros_id, politica_id, creado_por, actualizado_por)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          f.numero, f.cliente, f.descripcion || '', fecha, f.fecha_aprobacion || null, f.condicion_pago || 'Contado',
          Number(f.dias_credito_otorgados) || 0, Number(f.precio_venta) || 0, Number(f.pct_anticipo) || 0,
          f.estado || 'Borrador', param.id, politica.id, user.id, user.id
        );
        creadas++;
      }
    } catch (e) { errores.push(`${f.numero || '?'}: ${e.message}`); }
  }
  registrar({ usuario: user, accion: 'IMPORTAR', entidad: 'cotizaciones', valorNuevo: `${creadas} creadas, ${actualizadas} actualizadas` });
  return { creadas, actualizadas, errores };
}

function importarManoObra(filas, user) {
  let insertadas = 0;
  const errores = [];
  const limpiadas = new Set();
  for (const f of filas) {
    try {
      const cot = db.prepare('SELECT * FROM cotizaciones WHERE numero = ?').get(f.cotizacion_numero);
      if (!cot) { errores.push(`Cotización no encontrada: ${f.cotizacion_numero}`); continue; }
      if (!limpiadas.has(cot.id)) { db.prepare('DELETE FROM cotizacion_mano_obra WHERE cotizacion_id = ?').run(cot.id); limpiadas.add(cot.id); }
      let trab = db.prepare('SELECT * FROM trabajadores WHERE lower(nombre) = lower(?)').get(f.trabajador);
      if (!trab) {
        const info = db.prepare('INSERT INTO trabajadores (nombre, cargo, tipo, tarifa_hora, factor_prestacional, activo) VALUES (?,?,?,?,?,1)')
          .run(f.trabajador, 'Otros', f.tipo === 'Externo' ? 'Externo' : 'Interno', Number(f.tarifa_hora) || 0, 1);
        trab = db.prepare('SELECT * FROM trabajadores WHERE id = ?').get(info.lastInsertRowid);
      }
      db.prepare(
        `INSERT INTO cotizacion_mano_obra (cotizacion_id, trabajador_id, nombre_snapshot, tipo, tarifa_hora, factor_prestacional, horas_presupuestadas, horas_reales)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(cot.id, trab.id, trab.nombre, f.tipo || trab.tipo, Number(f.tarifa_hora) || trab.tarifa_hora, trab.factor_prestacional || 1, Number(f.horas_presupuestadas) || 0, Number(f.horas_reales) || 0);
      insertadas++;
    } catch (e) { errores.push(e.message); }
  }
  registrar({ usuario: user, accion: 'IMPORTAR', entidad: 'cotizacion_mano_obra', valorNuevo: `${insertadas} líneas` });
  return { insertadas, errores };
}

function importarMateriales(filas, user) {
  let insertadas = 0;
  const errores = [];
  const limpiadas = new Set();
  for (const f of filas) {
    try {
      const cot = db.prepare('SELECT * FROM cotizaciones WHERE numero = ?').get(f.cotizacion_numero);
      if (!cot) { errores.push(`Cotización no encontrada: ${f.cotizacion_numero}`); continue; }
      if (!limpiadas.has(cot.id)) { db.prepare('DELETE FROM cotizacion_materiales WHERE cotizacion_id = ?').run(cot.id); limpiadas.add(cot.id); }
      let provId = null;
      if (f.proveedor) {
        let prov = db.prepare('SELECT * FROM proveedores WHERE lower(nombre) = lower(?)').get(f.proveedor);
        if (!prov) {
          const info = db.prepare('INSERT INTO proveedores (nombre, dias_credito_habituales, activo) VALUES (?,?,1)').run(f.proveedor, Number(f.dias_credito_proveedor) || 0);
          prov = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(info.lastInsertRowid);
        }
        provId = prov.id;
      }
      db.prepare(
        `INSERT INTO cotizacion_materiales (cotizacion_id, descripcion, clasificacion, forma_pago, proveedor_id, dias_credito_proveedor, fecha_compra, cantidad_presupuestada, cantidad_real, costo_unitario)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(cot.id, f.descripcion, f.clasificacion || 'Directo', f.forma_pago || 'Contado', provId, Number(f.dias_credito_proveedor) || 0, f.fecha_compra || null, Number(f.cantidad_presupuestada) || 0, Number(f.cantidad_real) || 0, Number(f.costo_unitario) || 0);
      insertadas++;
      svc.syncCuentasPorPagar(cot.id);
    } catch (e) { errores.push(e.message); }
  }
  registrar({ usuario: user, accion: 'IMPORTAR', entidad: 'cotizacion_materiales', valorNuevo: `${insertadas} líneas` });
  return { insertadas, errores };
}
