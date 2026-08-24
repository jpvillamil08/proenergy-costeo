'use strict';
const db = require('../db');
const { sendJson, readJsonBody } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { registrar } = require('../lib/audit');
const { todayStr, addDays, diffDays } = require('../lib/dates');

module.exports = (router) => {
  router.get('/api/cuentas-por-pagar', withAuth(async ({ res }) => {
    const rows = db.prepare(
      `SELECT cxp.*, c.numero AS cotizacion_numero, c.cliente, p.nombre AS proveedor_nombre
       FROM cuentas_por_pagar cxp
       LEFT JOIN cotizaciones c ON c.id = cxp.cotizacion_id
       LEFT JOIN proveedores p ON p.id = cxp.proveedor_id
       ORDER BY cxp.fecha_vencimiento`
    ).all();
    const hoy = todayStr();
    const enriched = rows.map((r) => ({
      ...r,
      diasParaVencer: diffDays(r.fecha_vencimiento, hoy),
      vencida: !r.pagado && diffDays(hoy, r.fecha_vencimiento) > 0,
    }));
    sendJson(res, 200, enriched);
  }));

  router.put('/api/cuentas-por-pagar/:id/pagar', withAdmin(async ({ req, res, params, user }) => {
    const b = await readJsonBody(req).catch(() => ({}));
    db.prepare('UPDATE cuentas_por_pagar SET pagado = 1, fecha_pago = ? WHERE id = ?').run(b.fecha_pago || todayStr(), params.id);
    registrar({ usuario: user, accion: 'EDITAR', entidad: 'cuentas_por_pagar', entidadId: params.id, campo: 'pagado', valorNuevo: '1' });
    sendJson(res, 200, { ok: true });
  }));
};
