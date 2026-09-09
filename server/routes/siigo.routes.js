'use strict';
const db = require('../db');
const { sendJson, HttpError } = require('../lib/http-helpers');
const { withAdmin } = require('../lib/guard');
const { registrar } = require('../lib/audit');
const svc = require('../lib/cotizacion-service');
const { vigenteEn: parametrosVigenteEn } = require('./parametros.routes');
const { vigenteEn: politicaVigenteEn } = require('./politicas.routes');
const { todayStr, addDays } = require('../lib/dates');
const siigo = require('../lib/siigo');
const sync = require('../lib/siigo-sync');

// El resolutor de nombres de cliente (con su cache) vive en lib/siigo-sync.js,
// para compartirlo con el programador diario.
const nombreClientePorId = sync.nombreClientePorId;

module.exports = (router) => {
  // Estado de la conexion: le dice al frontend si ya estan configuradas las
  // variables de entorno, para mostrar instrucciones en vez de un error crudo.
  router.get('/api/siigo/estado', withAdmin(async ({ res }) => {
    sendJson(res, 200, { configurada: siigo.configurada() });
  }));

  // Lista cotizaciones recientes de Siigo (por defecto, ultimos 90 dias) y marca
  // cuales ya fueron importadas a PROENERGY para no duplicar.
  router.get('/api/siigo/cotizaciones', withAdmin(async ({ res, query }) => {
    const createdStart = query.desde || addDays(todayStr(), -90);
    const createdEnd = query.hasta || todayStr();
    const page = Number(query.page) || 1;
    const data = await siigo.listarCotizaciones({ createdStart, createdEnd, page, pageSize: 25 });
    const yaImportadas = new Set(
      db.prepare('SELECT siigo_quotation_id FROM cotizaciones WHERE siigo_quotation_id IS NOT NULL').all()
        .map((r) => r.siigo_quotation_id)
    );
    const results = await Promise.all((data.results || []).map(async (q) => ({
      id: q.id,
      numero: q.name || String(q.number || q.id),
      fecha: q.date,
      cliente: await nombreClientePorId(q.customer && q.customer.id),
      total: q.total,
      yaImportada: yaImportadas.has(q.id),
    })));
    sendJson(res, 200, { pagination: data.pagination, results });
  }));

  // Trae una cotizacion de Siigo y crea el borrador correspondiente en PROENERGY
  // (cliente, fecha y precio). Las lineas de mano de obra y materiales quedan
  // vacias: Siigo no las maneja, se completan aqui con la calculadora real.
  // La logica vive en lib/siigo-sync.js, compartida con el programador diario.
  router.post('/api/siigo/importar/:siigoId', withAdmin(async ({ res, params, user }) => {
    const id = await sync.importarCotizacion(params.siigoId, {
      usuario: user, parametrosVigenteEn, politicaVigenteEn,
    });
    if (id === null) throw new HttpError(409, 'Esta cotización de Siigo ya fue importada antes.');
    sendJson(res, 201, svc.getCotizacionFull(id));
  }));
};
