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

  // Diagnostico, solo lectura: una cotizacion tal como la devuelve Siigo, en el
  // detalle y en el listado (pueden traer campos distintos), mas una prueba de
  // si el filtro updated_start funciona. Existe para ubicar en que campo guarda
  // Siigo el titulo de la cotizacion: en Observaciones no esta.
  router.get('/api/siigo/cotizaciones/:numero/crudo', withAdmin(async ({ res, params }) => {
    const cot = db.prepare(
      'SELECT id, numero, fecha_cotizacion, siigo_quotation_id FROM cotizaciones WHERE numero = ?'
    ).get(params.numero);
    if (!cot || !cot.siigo_quotation_id) throw new HttpError(404, 'Esa cotización no existe o no viene de Siigo.');
    const detalle = await siigo.obtenerCotizacion(cot.siigo_quotation_id);
    let enListado = null;
    try {
      const desde = addDays(String(detalle.date || cot.fecha_cotizacion).slice(0, 10), -10);
      for (let page = 1; page <= 10 && !enListado; page++) {
        const data = await siigo.listarCotizaciones({ createdStart: desde, createdEnd: todayStr(), page, pageSize: 100 });
        enListado = (data.results || []).find((q) => q.id === cot.siigo_quotation_id) || null;
        if (!(data.results || []).length || page * 100 >= ((data.pagination && data.pagination.total_results) || 0)) break;
      }
    } catch (e) {
      enListado = { error: e.message };
    }
    const prueba = {};
    for (const [nombre, filtro] of [['sin_filtro', {}], ['updated_ultimos_2_dias', { updatedStart: addDays(todayStr(), -2) }]]) {
      try {
        const data = await siigo.listarCotizaciones({ ...filtro, page: 1, pageSize: 5 });
        prueba[nombre] = { total: data.pagination && data.pagination.total_results, primeras: (data.results || []).map((q) => q.name) };
      } catch (e) {
        prueba[nombre] = { error: e.message };
      }
    }
    sendJson(res, 200, { numero: cot.numero, siigo_id: cot.siigo_quotation_id, detalle, enListado, pruebaUpdatedStart: prueba });
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
