'use strict';
// Carga automatica de materiales para cotizaciones importadas desde Siigo.
//
// Problema que resuelve: al importar una cotizacion desde Siigo (ver
// siigo.routes.js) solo se trae numero, cliente, fecha y precio de venta.
// Siigo no maneja costos internos, asi que las lineas de cotizacion_materiales
// quedan vacias y el costeo real (materiales + mano de obra) sale en cero.
//
// Esta ruta busca, para cada cotizacion importada de Siigo que TODAVIA no
// tiene materiales cargados, los items originales de esa cotizacion en Siigo
// (descripcion + cantidad — eso si lo tiene Siigo) y los cruza por palabras
// clave contra el catalogo real de materiales (que si tiene costos, cargados
// a mano en la app). Cuando el cruce es claro y unico, crea la linea de
// materiales con la cantidad de Siigo y el costo real del catalogo. Cuando
// el item no tiene un cruce confiable, igual se crea la linea (para no perder
// la cantidad ni la descripcion original) pero con costo $0 y la descripcion
// marcada "[REVISAR]", para que quede visible en la cotizacion y alguien la
// complete a mano — nunca se inventa un costo.
//
// Dos rutas:
//   GET  /api/siigo/materiales/preview  -> solo mira y reporta, no escribe nada.
//   POST /api/siigo/materiales/cargar   -> ejecuta y escribe (procesa un lote
//                                          por llamada, controlado por ?limit=).
// Ambas son solo para Administrador.
const db = require('../db');
const { sendJson, HttpError } = require('../lib/http-helpers');
const { withAdmin } = require('../lib/guard');
const { registrar } = require('../lib/audit');
const siigo = require('../lib/siigo');
const { tokenizar } = require('../lib/estimador');
const PAUSA_ENTRE_LLAMADAS_MS = 300; // para no saturar la API de Siigo
const LIMITE_DEFECTO = 15; // cotizaciones por llamada, para no exceder el tiempo de una peticion HTTP
function pausa(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Cotizaciones importadas de Siigo que aun no tienen ninguna linea de materiales.
function cotizacionesPendientes(limit) {
  return db.prepare(
    `SELECT c.* FROM cotizaciones c
     WHERE c.siigo_quotation_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM cotizacion_materiales m WHERE m.cotizacion_id = c.id)
     ORDER BY c.id
     LIMIT ?`
  ).all(limit);
}
function totalPendientes() {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM cotizaciones c
     WHERE c.siigo_quotation_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM cotizacion_materiales m WHERE m.cotizacion_id = c.id)`
  ).get().n;
}
// Catalogo de materiales activos, pre-tokenizado, con su mejor precio (el mas
// barato entre proveedores) resuelto una sola vez para toda la corrida.
function catalogoTokenizado() {
  const materiales = db.prepare('SELECT * FROM materiales WHERE activo = 1').all();
  return materiales.map((m) => {
    const mejor = db.prepare(
      `SELECT precio_unitario, proveedor_id FROM materiales_precios WHERE material_id = ? ORDER BY precio_unitario ASC LIMIT 1`
    ).get(m.id);
    return {
      material_id: m.id,
      descripcion: m.descripcion,
      unidad: m.unidad,
      tokens: tokenizar(m.descripcion),
      costo_unitario: mejor ? mejor.precio_unitario : null,
      proveedor_id: mejor ? mejor.proveedor_id : null,
    };
  });
}
// Busca el material del catalogo que mejor cruza con la descripcion de un item
// de Siigo. Exige minimo de palabras compartidas (mas alto entre mas larga sea
// la descripcion) y que el mejor candidato sea unico (sin empate), para no
// adivinar cuando hay ambiguedad. Si el material candidato no tiene precio
// registrado en el catalogo, tampoco se acepta como match (no hay costo real
// que usar).
function mejorMatch(descripcionItem, catalogo) {
  const tokensItem = tokenizar(descripcionItem);
  if (!tokensItem.length) return null;
  const candidatos = catalogo
    .map((m) => ({ m, score: tokensItem.filter((t) => m.tokens.includes(t)).length }))
    .filter((c) => c.score > 0 && c.m.costo_unitario !== null);
  if (!candidatos.length) return null;
  candidatos.sort((a, b) => b.score - a.score);
  const minScore = tokensItem.length <= 2 ? 1 : 2;
  if (candidatos[0].score < minScore) return null;
  const top = candidatos[0].score;
  if (candidatos.filter((c) => c.score === top).length > 1) return null; // empate: ambiguo
  return candidatos[0].m;
}
// Trae los items de una cotizacion de Siigo y les aplica el cruce contra el
// catalogo. No escribe nada: se usa tanto en preview como antes de escribir.
async function analizarCotizacion(cot, catalogo) {
  const q = await siigo.obtenerCotizacion(cot.siigo_quotation_id);
  const items = Array.isArray(q.items) ? q.items : [];
  const analizados = items.map((it) => {
    const descripcion = it.description || it.name || it.code || 'Item sin descripción';
    const cantidad = Number(it.quantity ?? it.qty ?? 1) || 1;
    const match = mejorMatch(descripcion, catalogo);
    return { descripcionOriginal: descripcion, cantidad, match };
  });
  return analizados;
}
module.exports = (router) => {
  router.get('/api/siigo/materiales/preview', withAdmin(async ({ res, query }) => {
    const limit = Math.min(Number(query.limit) || LIMITE_DEFECTO, 50);
    const pendientes = cotizacionesPendientes(limit);
    const catalogo = catalogoTokenizado();
    const resultado = [];
    const errores = [];
    for (const cot of pendientes) {
      try {
        const analizados = await analizarCotizacion(cot, catalogo);
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
      pendientesTotales: totalPendientes(),
      resultado,
      errores,
    });
  }));
  router.post('/api/siigo/materiales/cargar', withAdmin(async ({ res, query, user }) => {
    const limit = Math.min(Number(query.limit) || LIMITE_DEFECTO, 50);
    const pendientes = cotizacionesPendientes(limit);
    const catalogo = catalogoTokenizado();
    const insert = db.prepare(
      `INSERT INTO cotizacion_materiales
        (cotizacion_id, descripcion, clasificacion, forma_pago, proveedor_id, dias_credito_proveedor, cantidad_presupuestada, cantidad_real, costo_unitario)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    let cotizacionesProcesadas = 0;
    let lineasInsertadas = 0;
    let lineasSinMatch = 0;
    const errores = [];
    for (const cot of pendientes) {
      try {
        const analizados = await analizarCotizacion(cot, catalogo);
        for (const a of analizados) {
          if (a.match) {
            insert.run(cot.id, a.match.descripcion, 'Directo', 'Contado', a.match.proveedor_id, 0, a.cantidad, 0, a.match.costo_unitario);
          } else {
            insert.run(cot.id, `[REVISAR] ${a.descripcionOriginal}`, 'Directo', 'Contado', null, 0, a.cantidad, 0, 0);
            lineasSinMatch++;
          }
          lineasInsertadas++;
        }
        registrar({
          usuario: user, accion: 'IMPORTAR', entidad: 'cotizacion_materiales', entidadId: cot.id,
          valorNuevo: `Carga automatica desde Siigo: ${analizados.length} items (${analizados.filter((a) => a.match).length} con match, ${analizados.filter((a) => !a.match).length} para revisar)`,
        });
        cotizacionesProcesadas++;
      } catch (e) {
        errores.push({ numero: cot.numero, error: e.message });
      }
      await pausa(PAUSA_ENTRE_LLAMADAS_MS);
    }
    sendJson(res, 200, {
      cotizacionesProcesadas,
      lineasInsertadas,
      lineasSinMatch,
      pendientesTotales: totalPendientes(),
      errores,
    });
  }));
};
