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

// Cache simple en memoria de clientes de Siigo ya resueltos en esta ejecucion,
// para no pedir el mismo cliente dos veces al listar varias cotizaciones.
const cacheClientes = new Map();
async function nombreClientePorId(id) {
  if (!id) return 'Cliente sin identificar';
  if (cacheClientes.has(id)) return cacheClientes.get(id);
  try {
    const cliente = await siigo.obtenerCliente(id);
    const nombre = siigo.nombreCliente(cliente);
    cacheClientes.set(id, nombre);
    return nombre;
  } catch (e) {
    return 'Cliente de Siigo (no se pudo consultar el nombre)';
  }
}

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
  router.post('/api/siigo/importar/:siigoId', withAdmin(async ({ res, params, user }) => {
    const yaExiste = db.prepare('SELECT id FROM cotizaciones WHERE siigo_quotation_id = ?').get(params.siigoId);
    if (yaExiste) throw new HttpError(409, 'Esta cotización de Siigo ya fue importada antes.');

    const q = await siigo.obtenerCotizacion(params.siigoId);
    const clienteNombre = await nombreClientePorId(q.customer && q.customer.id);
    const fecha = (q.date || todayStr()).slice(0, 10);
    const descripcion = (q.items || []).map((it) => it.description).filter(Boolean).join('; ').slice(0, 500);
    const numero = q.name || svc.generarNumero();

    const param = parametrosVigenteEn(fecha);
    const politica = politicaVigenteEn(fecha);
    if (!param || !politica) throw new HttpError(400, 'No hay parámetros de gastos fijos o políticas comerciales vigentes para esa fecha. Configúrelos primero en Admin.');

    const numeroFinal = db.prepare('SELECT id FROM cotizaciones WHERE numero = ?').get(numero) ? svc.generarNumero() : numero;

    const info = db.prepare(
      `INSERT INTO cotizaciones (numero, cliente, descripcion, fecha_cotizacion, condicion_pago,
        dias_credito_otorgados, precio_venta, pct_anticipo, estado, parametros_id, politica_id,
        creado_por, actualizado_por, siigo_quotation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      numeroFinal, clienteNombre, descripcion || `Importada desde Siigo (cotización ${numero})`, fecha,
      'Contado', 0, Number(q.total) || 0, 0, 'Borrador', param.id, politica.id, user.id, user.id, params.siigoId
    );
    registrar({ usuario: user, accion: 'CREAR', entidad: 'cotizaciones', entidadId: info.lastInsertRowid, valorNuevo: `${numeroFinal} (importada de Siigo)` });
    sendJson(res, 201, svc.getCotizacionFull(info.lastInsertRowid));
  }));
};
