'use strict';
const db = require('../db');
const { sendJson, readJsonBody, HttpError } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { registrar, registrarCambios } = require('../lib/audit');

module.exports = (router) => {
  router.get('/api/trabajadores', withAuth(async ({ res, query }) => {
    const activos = query.todos === '1' ? '' : 'WHERE activo = 1';
    sendJson(res, 200, db.prepare(`SELECT * FROM trabajadores ${activos} ORDER BY nombre`).all());
  }));

  router.post('/api/trabajadores', withAdmin(async ({ req, res, user }) => {
    const b = await readJsonBody(req);
    if (!b.nombre) throw new HttpError(400, 'El nombre es obligatorio');
    const info = db.prepare(
      `INSERT INTO trabajadores (nombre, cargo, tipo, tarifa_hora, factor_prestacional, factura_iva, aplica_retencion, activo)
       VALUES (?,?,?,?,?,?,?,1)`
    ).run(b.nombre, b.cargo, b.tipo, Number(b.tarifa_hora) || 0, Number(b.factor_prestacional) || 1, b.factura_iva ? 1 : 0, b.aplica_retencion ? 1 : 0);
    registrar({ usuario: user, accion: 'CREAR', entidad: 'trabajadores', entidadId: info.lastInsertRowid, valorNuevo: b.nombre });
    sendJson(res, 201, db.prepare('SELECT * FROM trabajadores WHERE id = ?').get(info.lastInsertRowid));
  }));

  router.put('/api/trabajadores/:id', withAdmin(async ({ req, res, params, user }) => {
    const antes = db.prepare('SELECT * FROM trabajadores WHERE id = ?').get(params.id);
    if (!antes) throw new HttpError(404, 'Trabajador no encontrado');
    const b = await readJsonBody(req);
    db.prepare(
      `UPDATE trabajadores SET nombre=?, cargo=?, tipo=?, tarifa_hora=?, factor_prestacional=?, factura_iva=?, aplica_retencion=?, activo=? WHERE id=?`
    ).run(
      b.nombre, b.cargo, b.tipo, Number(b.tarifa_hora) || 0, Number(b.factor_prestacional) || 1,
      b.factura_iva ? 1 : 0, b.aplica_retencion ? 1 : 0, b.activo === false || b.activo === 0 ? 0 : 1, params.id
    );
    const despues = db.prepare('SELECT * FROM trabajadores WHERE id = ?').get(params.id);
    registrarCambios({ usuario: user, entidad: 'trabajadores', entidadId: params.id, antes, despues, ignorar: ['creado_en'] });
    sendJson(res, 200, despues);
  }));

  router.del('/api/trabajadores/:id', withAdmin(async ({ res, params, user }) => {
    db.prepare('UPDATE trabajadores SET activo = 0 WHERE id = ?').run(params.id);
    registrar({ usuario: user, accion: 'ELIMINAR', entidad: 'trabajadores', entidadId: params.id });
    sendJson(res, 200, { ok: true });
  }));
};
