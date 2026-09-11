'use strict';
// Carga automatica de materiales para cotizaciones importadas desde Siigo.
//
// Problema que resuelve: al importar una cotizacion desde Siigo (ver
// siigo.routes.js) solo se trae numero, cliente, fecha y precio de venta.
// Siigo no maneja costos internos, asi que las lineas de cotizacion_materiales
// quedan vacias y el costeo real (materiales + mano de obra) sale en cero.
//
// La logica del cruce contra el catalogo vive en lib/siigo-sync.js, compartida
// con el programador automatico (lib/scheduler.js), para que el boton de la app
// y la sincronizacion de las 7 p.m. apliquen exactamente las mismas reglas.
//
// Tres rutas, todas solo para Administrador:
//   GET  /api/siigo/materiales/preview  -> solo mira y reporta, no escribe nada.
//   POST /api/siigo/materiales/cargar   -> ejecuta y escribe (un lote por
//                                          llamada, controlado por ?limit=).
//   POST /api/siigo/sync/ejecutar       -> dispara a mano la misma
//                                          sincronizacion completa que corre
//                                          sola cada dia a las 7 p.m.
//   GET  /api/siigo/sync/estado         -> como va el programador diario.
const { sendJson } = require('../lib/http-helpers');
const { withAdmin } = require('../lib/guard');
const sync = require('../lib/siigo-sync');
const scheduler = require('../lib/scheduler');

const LIMITE_DEFECTO = 15; // cotizaciones por llamada, para no exceder el tiempo de una peticion HTTP
const PAUSA_ENTRE_LLAMADAS_MS = 300;

function pausa(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = (router) => {
  router.get('/api/siigo/materiales/preview', withAdmin(async ({ res, query }) => {
    const limit = Math.min(Number(query.limit) || LIMITE_DEFECTO, 50);
    const pendientes = sync.cotizacionesPendientes(limit);
    const catalogo = sync.catalogoTokenizado();
    const resultado = [];
    const errores = [];
    for (const cot of pendientes) {
      try {
        const analizados = await sync.analizarCotizacion(cot, catalogo);
        resultado.push({
          numero: cot.numero,
          cliente: cot.cliente,
          totalItems: analizados.length,
          matcheados: analizados.filter((a) => a.match).length,
          items: analizados.map((a) => ({
            descripcion: a.descripcionOriginal,
            cantidad: a.cantidad,
            match: a.match ? { material: a.match.descripcion, costo_unitario: a.match.costo_unitario } : null,
          })),
        });
      } catch (e) {
        errores.push({ numero: cot.numero, error: e.message });
      }
      await pausa(PAUSA_ENTRE_LLAMADAS_MS);
    }
    sendJson(res, 200, {
      procesadasEnEstaLlamada: pendientes.length,
      pendientesTotales: sync.totalPendientes(),
      resultado,
      errores,
    });
  }));

  router.post('/api/siigo/materiales/cargar', withAdmin(async ({ res, query, user }) => {
    const limit = Math.min(Number(query.limit) || LIMITE_DEFECTO, 50);
    sendJson(res, 200, await sync.cargarMateriales({ limit, usuario: user }));
  }));

  // Deduce el costo de las lineas que quedaron en $0 a partir del precio de
  // venta que la cotizacion tiene en Siigo, restandole el margen indicado.
  // Simula por defecto: hay que pasar ?ejecutar=1 para que escriba.
  //   ?margen=30   porcentaje a descontar del precio de venta (por defecto 30)
  //   ?limite=N    procesa solo las primeras N cotizaciones (para probar)
  router.post('/api/siigo/materiales/costo-desde-precio', withAdmin(async ({ res, query, user }) => {
    const margen = Math.min(Math.max(Number(query.margen ?? 30), 0), 95) / 100;
    const limite = query.limite ? Number(query.limite) : null;
    sendJson(res, 200, await sync.costosDesdePrecioDeVenta({
      margen, limite, soloSimular: query.ejecutar !== '1', usuario: user,
    }));
  }));

  // Completa, en lotes, las observaciones de Siigo (titulo del trabajo) de las
  // cotizaciones importadas antes de que se guardaran. ?limite=N (maximo 50).
  router.post('/api/siigo/cotizaciones/observaciones', withAdmin(async ({ res, query }) => {
    const limite = Math.min(Math.max(Number(query.limite) || 25, 1), 50);
    sendJson(res, 200, await sync.completarObservaciones({ limite }));
  }));

  // Estado del programador diario: si esta vivo, cuando corre la proxima vez y
  // como fue la ultima corrida.
  router.get('/api/siigo/sync/estado', withAdmin(async ({ res }) => {
    sendJson(res, 200, scheduler.estado);
  }));

  // Dispara a mano la sincronizacion completa (lo mismo que corre a las 7 p.m.).
  // Util para probarla sin esperar, o para ponerse al dia despues de un corte.
  router.post('/api/siigo/sync/ejecutar', withAdmin(async ({ res }) => {
    sendJson(res, 200, await scheduler.ejecutarSincronizacion({ manual: true }));
  }));
};
