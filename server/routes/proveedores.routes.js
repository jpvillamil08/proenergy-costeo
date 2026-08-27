'use strict';
const db = require('../db');
const { sendJson, readJsonBody, HttpError } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { registrar, registrarCambios } = require('../lib/audit');

module.exports = (router) => {
  router.get('/api/proveedores', withAuth(async ({ res, query }) => {
    const activos = query.todos === '1' ? '' : 'WHERE activo = 1';
    sendJson(res, 200, db.prepare(`SELECT * FROM proveedores ${activos} ORDER BY nombre`).all());
  }));

  router.post('/api/proveedores', withAdmin(async ({ req, res, user }) => {
    const b = await readJsonBody(req);
    if (!b.nombre) throw new HttpError(400, 'El nombre es obligatorio');
    const info = db.prepare(
      `INSERT INTO proveedores (nombre, nit, dias_credito_habituales, contacto, activo) VALUES (?,?,?,?,1)`
    ).run(b.nombre, b.nit || '', Number(b.dias_credito_habituales) || 0, b.contacto || '');
    registrar({ usuario: user, accion: 'CREAR', entidad: 'proveedores', entidadId: info.lastInsertRowid, valorNuevo: b.nombre });
    sendJson(res, 201, db.prepare('SELECT * FROM proveedores WHERE id = ?').get(info.lastInsertRowid));
  }));

  router.put('/api/proveedores/:id', withAdmin(async ({ req, res, params, user }) => {
    const antes = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(params.id);
    if (!antes) throw new HttpError(404, 'Proveedor no encontrado');
    const b = await readJsonBody(req);
    db.prepare('UPDATE proveedores SET nombre=?, nit=?, dias_credito_habituales=?, contacto=?, activo=? WHERE id=?').run(
      b.nombre, b.nit || '', Number(b.dias_credito_habituales) || 0, b.contacto || '', b.activo === false || b.activo === 0 ? 0 : 1, params.id
    );
    const despues = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(params.id);
    registrarCambios({ usuario: user, entidad: 'proveedores', entidadId: params.id, antes, despues, ignorar: ['creado_en'] });
    sendJson(res, 200, despues);
  }));

  router.del('/api/proveedores/:id', withAdmin(async ({ res, params, user }) => {
    db.prepare('UPDATE proveedores SET activo = 0 WHERE id = ?').run(params.id);
    registrar({ usuario: user, accion: 'ELIMINAR', entidad: 'proveedores', entidadId: params.id });
    sendJson(res, 200, { ok: true });
  }));
};
