'use strict';
const db = require('../db');
const { sendJson, readJsonBody, HttpError } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { registrar } = require('../lib/audit');

module.exports = (router) => {
  router.get('/api/plantillas', withAuth(async ({ res }) => {
    const rows = db.prepare('SELECT * FROM plantillas ORDER BY nombre').all();
    sendJson(res, 200, rows.map((r) => ({ ...r, datos: JSON.parse(r.datos_json) })));
  }));

  router.post('/api/plantillas', withAdmin(async ({ req, res, user }) => {
    const b = await readJsonBody(req);
    if (!b.nombre) throw new HttpError(400, 'El nombre es obligatorio');
    const info = db.prepare('INSERT INTO plantillas (nombre, descripcion, datos_json, creado_por) VALUES (?,?,?,?)').run(
      b.nombre, b.descripcion || '', JSON.stringify(b.datos || { manoObra: [], materiales: [] }), user.id
    );
    registrar({ usuario: user, accion: 'CREAR', entidad: 'plantillas', entidadId: info.lastInsertRowid, valorNuevo: b.nombre });
    sendJson(res, 201, { ok: true, id: info.lastInsertRowid });
  }));

  router.del('/api/plantillas/:id', withAdmin(async ({ res, params, user }) => {
    db.prepare('DELETE FROM plantillas WHERE id = ?').run(params.id);
    registrar({ usuario: user, accion: 'ELIMINAR', entidad: 'plantillas', entidadId: params.id });
    sendJson(res, 200, { ok: true });
  }));
};
