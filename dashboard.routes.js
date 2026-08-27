'use strict';
const db = require('../db');
const { sendJson, readJsonBody } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { registrar } = require('../lib/audit');
const { totalGastosFijos, costoFijoHora } = require('../lib/calc');
const { todayStr } = require('../lib/dates');

function withCalc(p) {
  if (!p) return p;
  return { ...p, total_mensual: totalGastosFijos(p), costo_fijo_hora: costoFijoHora(p) };
}

function vigenteEn(fecha) {
  return db.prepare(
    `SELECT * FROM parametros_gastos_fijos WHERE fecha_vigencia <= ? ORDER BY fecha_vigencia DESC, id DESC LIMIT 1`
  ).get(fecha || todayStr());
}

module.exports = (router) => {
  router.get('/api/parametros', withAuth(async ({ res }) => {
    const rows = db.prepare('SELECT * FROM parametros_gastos_fijos ORDER BY fecha_vigencia DESC, id DESC').all();
    sendJson(res, 200, rows.map(withCalc));
  }));

  router.get('/api/parametros/vigente', withAuth(async ({ res, query }) => {
    sendJson(res, 200, withCalc(vigenteEn(query.fecha)));
  }));

  router.post('/api/parametros', withAdmin(async ({ req, res, user }) => {
    const b = await readJsonBody(req);
    const info = db.prepare(
      `INSERT INTO parametros_gastos_fijos
       (fecha_vigencia, arriendo_taller, servicios_publicos, internet_comunicaciones, nomina_administrativa,
        transporte_fijo, depreciacion, seguros_impuestos, otros, horas_productivas_mes, creado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      b.fecha_vigencia, Number(b.arriendo_taller) || 0, Number(b.servicios_publicos) || 0,
      Number(b.internet_comunicaciones) || 0, Number(b.nomina_administrativa) || 0,
      Number(b.transporte_fijo) || 0, Number(b.depreciacion) || 0, Number(b.seguros_impuestos) || 0,
      Number(b.otros) || 0, Number(b.horas_productivas_mes) || 1, user.id
    );
    registrar({ usuario: user, accion: 'CREAR', entidad: 'parametros_gastos_fijos', entidadId: info.lastInsertRowid, campo: 'nueva_version', valorNuevo: b.fecha_vigencia });
    const row = db.prepare('SELECT * FROM parametros_gastos_fijos WHERE id = ?').get(info.lastInsertRowid);
    sendJson(res, 201, withCalc(row));
  }));

  router.get('/api/parametros/:id', withAuth(async ({ res, params }) => {
    const row = db.prepare('SELECT * FROM parametros_gastos_fijos WHERE id = ?').get(params.id);
    sendJson(res, 200, withCalc(row));
  }));
};

module.exports.vigenteEn = vigenteEn;
module.exports.withCalc = withCalc;
