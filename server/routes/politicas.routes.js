'use strict';
const db = require('../db');
const { sendJson, readJsonBody } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { registrar } = require('../lib/audit');
const { todayStr } = require('../lib/dates');

function vigenteEn(fecha) {
  return db.prepare(
    `SELECT * FROM politicas_comerciales WHERE fecha_vigencia <= ? ORDER BY fecha_vigencia DESC, id DESC LIMIT 1`
  ).get(fecha || todayStr());
}

module.exports = (router) => {
  router.get('/api/politicas', withAuth(async ({ res }) => {
    sendJson(res, 200, db.prepare('SELECT * FROM politicas_comerciales ORDER BY fecha_vigencia DESC, id DESC').all());
  }));

  router.get('/api/politicas/vigente', withAuth(async ({ res, query }) => {
    sendJson(res, 200, vigenteEn(query.fecha));
  }));

  router.post('/api/politicas', withAdmin(async ({ req, res, user }) => {
    const b = await readJsonBody(req);
    const info = db.prepare(
      `INSERT INTO politicas_comerciales
       (fecha_vigencia, pct_utilidad_objetivo, margen_minimo_aceptable, pct_imprevistos, pct_comision_ventas,
        dias_credito_estandar_cliente, pct_iva, pct_retefuente, pct_ica, creado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      b.fecha_vigencia, Number(b.pct_utilidad_objetivo) || 0, Number(b.margen_minimo_aceptable) || 0,
      Number(b.pct_imprevistos) || 0, Number(b.pct_comision_ventas) || 0,
      Number(b.dias_credito_estandar_cliente) || 0, Number(b.pct_iva) || 0,
      Number(b.pct_retefuente) || 0, Number(b.pct_ica) || 0, user.id
    );
    registrar({ usuario: user, accion: 'CREAR', entidad: 'politicas_comerciales', entidadId: info.lastInsertRowid, campo: 'nueva_version', valorNuevo: b.fecha_vigencia });
    sendJson(res, 201, db.prepare('SELECT * FROM politicas_comerciales WHERE id = ?').get(info.lastInsertRowid));
  }));
};

module.exports.vigenteEn = vigenteEn;
