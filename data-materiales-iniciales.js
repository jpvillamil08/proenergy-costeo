'use strict';
const db = require('../db');
const { sendJson, readJsonBody, HttpError } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { registrar, registrarCambios } = require('../lib/audit');
const svc = require('../lib/cotizacion-service');

module.exports = (router) => {
  router.get('/api/cotizaciones/:id/pagos', withAuth(async ({ res, params }) => {
    sendJson(res, 200, svc.getPagos(params.id));
  }));

  router.post('/api/cotizaciones/:id/pagos', withAdmin(async ({ req, res, params, user }) => {
    const b = await readJsonBody(req);
    if (!b.fecha || !b.valor) throw new HttpError(400, 'Fecha y valor son obligatorios');
    const info = db.prepare(
      `INSERT INTO pagos (cotizacion_id, fecha, valor, medio_pago, referencia, observacion, creado_por)
       VALUES (?,?,?,?,?,?,?)`
    ).run(params.id, b.fecha, Number(b.valor), b.medio_pago || 'Transferencia', b.referencia || '', b.observacion || '', user.id);
    registrar({ usuario: user, accion: 'CREAR', entidad: 'pagos', entidadId: info.lastInsertRowid, valorNuevo: `${b.valor} (${b.fecha})` });
    sendJson(res, 201, svc.getCotizacionFull(params.id));
  }));

  router.put('/api/cotizaciones/:id/pagos/:pagoId', withAdmin(async ({ req, res, params, user }) => {
    const antes = db.prepare('SELECT * FROM pagos WHERE id = ?').get(params.pagoId);
    if (!antes) throw new HttpError(404, 'Pago no encontrado');
    const b = await readJsonBody(req);
    db.prepare('UPDATE pagos SET fecha=?, valor=?, medio_pago=?, referencia=?, observacion=? WHERE id=?').run(
      b.fecha, Number(b.valor), b.medio_pago, b.referencia || '', b.observacion || '', params.pagoId
    );
    const despues = db.prepare('SELECT * FROM pagos WHERE id = ?').get(params.pagoId);
    registrarCambios({ usuario: user, entidad: 'pagos', entidadId: params.pagoId, antes, despues });
    sendJson(res, 200, svc.getCotizacionFull(params.id));
  }));

  router.del('/api/cotizaciones/:id/pagos/:pagoId', withAdmin(async ({ res, params, user }) => {
    db.prepare('DELETE FROM pagos WHERE id = ?').run(params.pagoId);
    registrar({ usuario: user, accion: 'ELIMINAR', entidad: 'pagos', entidadId: params.pagoId });
    sendJson(res, 200, svc.getCotizacionFull(params.id));
  }));
};
