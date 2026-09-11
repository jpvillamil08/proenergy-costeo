'use strict';
// Buzon de ofertas, ordenes de compra y registro del correo (lectura automatica
// de Outlook, ver lib/correo-sync.js).
//   GET  /api/buzon                  ofertas (solicitudes, licitaciones, proveedores)
//   GET  /api/buzon/:id              una oferta con sus items
//   PUT  /api/buzon/:id              cambiar estado / vincular cotizacion (admin)
//   GET  /api/ordenes-compra         OC recibidas, con su cotizacion y facturas
//   PUT  /api/ordenes-compra/:id     vincular a mano una cotizacion (admin)
//   GET  /api/correo/mensajes        registro de lo leido (admin)
//   GET  /api/correo/estado          configuracion y ultima corrida (admin)
//   POST /api/correo/ejecutar        lectura inmediata, en segundo plano (admin)
const db = require('../db');
const { sendJson, readJsonBody, HttpError } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { registrarCambios, registrar } = require('../lib/audit');
const scheduler = require('../lib/scheduler');
const correo = require('../lib/correo-sync');
const ia = require('../lib/claude');
const { diffDays, todayStr } = require('../lib/dates');

const ESTADOS = ['Pendiente', 'Cotizada', 'Cumplida', 'Descartada'];

function cotizacionPorNumero(numero) {
  const n = String(numero || '').trim().toUpperCase();
  if (!n) return null;
  return db.prepare('SELECT id, numero, estado FROM cotizaciones WHERE upper(numero) = ?').get(n) || null;
}

function filaBuzon(b) {
  return {
    ...b,
    dias: b.fecha_recibido ? diffDays(todayStr(), b.fecha_recibido) : null,
    vencida: Boolean(b.fecha_limite && b.fecha_limite < todayStr() && ['Pendiente'].includes(b.estado)),
  };
}

module.exports = (router) => {
  router.get('/api/buzon', withAuth(async ({ res, query }) => {
    const filtros = [];
    const args = [];
    if (query.estado) { filtros.push('b.estado = ?'); args.push(query.estado); }
    if (query.tipo) { filtros.push('b.tipo = ?'); args.push(query.tipo); }
    const filas = db.prepare(
      `SELECT b.*, m.web_link, m.buzon, c.numero AS cotizacion_numero, u.nombre AS atendido_por_nombre
       FROM buzon_ofertas b
       LEFT JOIN correo_mensajes m ON m.id = b.mensaje_id
       LEFT JOIN cotizaciones c ON c.id = b.cotizacion_id
       LEFT JOIN usuarios u ON u.id = b.atendido_por
       ${filtros.length ? 'WHERE ' + filtros.join(' AND ') : ''}
       ORDER BY CASE b.estado WHEN 'Pendiente' THEN 0 WHEN 'Cotizada' THEN 1 ELSE 2 END, b.fecha_recibido DESC, b.id DESC`
    ).all(...args);
    sendJson(res, 200, filas.map(filaBuzon));
  }));

  router.get('/api/buzon/:id', withAuth(async ({ res, params }) => {
    const b = db.prepare(
      `SELECT b.*, m.web_link, c.numero AS cotizacion_numero FROM buzon_ofertas b
       LEFT JOIN correo_mensajes m ON m.id = b.mensaje_id LEFT JOIN cotizaciones c ON c.id = b.cotizacion_id WHERE b.id = ?`
    ).get(params.id);
    if (!b) throw new HttpError(404, 'No existe esa oferta');
    const items = db.prepare('SELECT * FROM buzon_items WHERE buzon_id = ? ORDER BY id').all(params.id);
    sendJson(res, 200, { ...filaBuzon(b), items });
  }));

  // Cambia el estado y/o vincula la cotizacion con que se respondio.
  // Vincular una cotizacion deja la oferta "Cotizada" si estaba "Pendiente".
  router.put('/api/buzon/:id', withAdmin(async ({ req, res, params, user }) => {
    const antes = db.prepare('SELECT * FROM buzon_ofertas WHERE id = ?').get(params.id);
    if (!antes) throw new HttpError(404, 'No existe esa oferta');
    const b = await readJsonBody(req);
    let estado = b.estado || antes.estado;
    let cotizacionId = antes.cotizacion_id;
    if (b.cotizacion_numero !== undefined) {
      if (!String(b.cotizacion_numero || '').trim()) cotizacionId = null;
      else {
        const cot = cotizacionPorNumero(b.cotizacion_numero);
        if (!cot) throw new HttpError(400, `No existe la cotización ${b.cotizacion_numero}`);
        cotizacionId = cot.id;
        if (!b.estado && estado === 'Pendiente') estado = 'Cotizada';
      }
    }
    if (!ESTADOS.includes(estado)) throw new HttpError(400, 'Estado inválido');
    const cierra = ['Cumplida', 'Descartada'].includes(estado) && estado !== antes.estado;
    db.prepare(
      `UPDATE buzon_ofertas SET estado = ?, cotizacion_id = ?,
         atendido_por = CASE WHEN ? THEN ? ELSE atendido_por END,
         atendido_en = CASE WHEN ? THEN datetime('now') ELSE atendido_en END
       WHERE id = ?`
    ).run(estado, cotizacionId, cierra ? 1 : 0, user.id, cierra ? 1 : 0, params.id);
    const despues = db.prepare('SELECT * FROM buzon_ofertas WHERE id = ?').get(params.id);
    registrarCambios({ usuario: user, entidad: 'buzon_ofertas', entidadId: params.id, antes, despues, ignorar: ['atendido_en'] });
    sendJson(res, 200, filaBuzon(despues));
  }));

  router.get('/api/ordenes-compra', withAuth(async ({ res }) => {
    const filas = db.prepare(
      `SELECT o.*, m.web_link, c.numero AS cotizacion_numero FROM ordenes_compra o
       LEFT JOIN correo_mensajes m ON m.id = o.mensaje_id LEFT JOIN cotizaciones c ON c.id = o.cotizacion_id
       ORDER BY o.fecha DESC, o.id DESC`
    ).all();
    sendJson(res, 200, filas.map((o) => {
      const facturas = correo.facturasDeOC(o.numero);
      return { ...o, facturas, dias_sin_factura: facturas.length ? null : (o.fecha ? diffDays(todayStr(), o.fecha) : null) };
    }));
  }));

  router.put('/api/ordenes-compra/:id', withAdmin(async ({ req, res, params, user }) => {
    const antes = db.prepare('SELECT * FROM ordenes_compra WHERE id = ?').get(params.id);
    if (!antes) throw new HttpError(404, 'No existe esa orden de compra');
    const b = await readJsonBody(req);
    const cot = String(b.cotizacion_numero || '').trim() ? cotizacionPorNumero(b.cotizacion_numero) : null;
    if (String(b.cotizacion_numero || '').trim() && !cot) throw new HttpError(400, `No existe la cotización ${b.cotizacion_numero}`);
    db.prepare('UPDATE ordenes_compra SET cotizacion_id = ? WHERE id = ?').run(cot ? cot.id : null, params.id);
    if (cot && ['Borrador', 'Enviada'].includes(cot.estado)) {
      db.prepare(`UPDATE cotizaciones SET estado = 'Aprobada', fecha_aprobacion = COALESCE(fecha_aprobacion, ?) WHERE id = ?`).run(antes.fecha || todayStr(), cot.id);
      registrar({ usuario: user, accion: 'EDITAR', entidad: 'cotizaciones', entidadId: cot.id, campo: 'estado', valorAnterior: cot.estado, valorNuevo: `Aprobada (OC ${antes.numero})` });
    }
    const despues = db.prepare('SELECT * FROM ordenes_compra WHERE id = ?').get(params.id);
    registrarCambios({ usuario: user, entidad: 'ordenes_compra', entidadId: params.id, antes, despues });
    sendJson(res, 200, despues);
  }));

  router.get('/api/correo/mensajes', withAdmin(async ({ res, query }) => {
    const limite = Math.min(Number(query.limite) || 200, 1000);
    sendJson(res, 200, db.prepare(
      `SELECT id, buzon, carpeta, fecha, remitente, asunto, adjuntos, tipo, accion, estado, error, web_link
       FROM correo_mensajes ORDER BY fecha DESC, id DESC LIMIT ?`
    ).all(limite));
  }));

  router.get('/api/correo/estado', withAdmin(async ({ res }) => {
    sendJson(res, 200, {
      configurado: correo.configurado(), iaConfigurada: ia.configurada(),
      buzones: String(process.env.CORREO_BUZONES || '').split(',').map((s) => s.trim()).filter(Boolean),
      ...scheduler.estadoCorreo,
    });
  }));

  // Lectura inmediata. Responde de una y sigue en segundo plano (la primera
  // lectura revisa 30 dias y puede tardar varios minutos).
  router.post('/api/correo/ejecutar', withAdmin(async ({ res }) => {
    if (scheduler.estadoCorreo.ejecutando) {
      sendJson(res, 200, { omitida: true, motivo: 'Ya hay una lectura en curso.', paso: scheduler.estadoCorreo.paso });
      return;
    }
    if (!correo.configurado()) throw new HttpError(400, 'La lectura del correo no está configurada. Ver docs/conectar-outlook.md.');
    scheduler.ejecutarCorreo({ manual: true }).catch(() => {});
    sendJson(res, 202, { iniciada: true });
  }));
};
