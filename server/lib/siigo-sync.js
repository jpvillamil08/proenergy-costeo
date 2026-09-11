'use strict';
// Logica de sincronizacion con Siigo, compartida por las rutas manuales
// (siigo.routes.js, siigo-materiales.routes.js) y por el programador
// automatico (scheduler.js). Vive aqui para que el cron y el boton de la app
// hagan exactamente lo mismo, sin duplicar reglas.
//
// Dos operaciones:
//   1. importarNuevas()      trae de Siigo las cotizaciones que aun no existen
//                            en la app (numero, cliente, fecha y precio; Siigo
//                            no maneja costos internos).
//   2. cargarMateriales()    para las cotizaciones importadas que todavia no
//                            tienen lineas, trae sus items de Siigo y los cruza
//                            contra el catalogo real de materiales.
//
// NUNCA inventa un costo: cuando el cruce contra el catalogo no es claro y
// unico, la linea se crea igual (para no perder la cantidad ni la descripcion
// original) pero con costo 0 y la descripcion marcada "[REVISAR]", para que
// alguien la complete a mano.

const db = require('../db');
const siigo = require('./siigo');
const { tokenizar } = require('./estimador');
const { registrar } = require('./audit');
const { todayStr, addDays } = require('./dates');
const cotizacionService = require('./cotizacion-service');

const PAUSA_ENTRE_LLAMADAS_MS = 300; // para no saturar la API de Siigo

function pausa(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- pendientes

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

// ---------------------------------------------------------------- cruce

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
  return items.map((it) => {
    const descripcion = it.description || it.name || it.code || 'Item sin descripción';
    const cantidad = Number(it.quantity ?? it.qty ?? 1) || 1;
    // precioVenta: lo que se le cobra al cliente por unidad. Sirve para deducir
    // el costo cuando no se consigue el precio del proveedor (ver
    // costosDesdePrecioDeVenta).
    const precioVenta = Number(it.price ?? it.unit_price ?? 0) || 0;
    return {
      descripcionOriginal: descripcion, cantidad, precioVenta, codigo: it.code || null,
      match: mejorMatch(descripcion, catalogo),
    };
  });
}

// ---------------------------------------------------------------- costo desde el precio

// Deduce el costo de las lineas que quedaron en $0 a partir del precio de venta
// que la propia cotizacion tiene en Siigo, restandole el margen indicado.
//
// Por que existe: para muchos items no se consigue el precio del proveedor, pero
// SI se sabe a cuanto se vendieron. Si la empresa cotiza con un margen conocido,
// el costo se puede despejar de ahi. Es una aproximacion, no el costo real de la
// factura de compra, y por eso se registra en la auditoria diciendo de donde
// salio.
//
// El cruce entre la linea guardada y el item de Siigo se hace por descripcion
// normalizada; si una cotizacion repite la misma descripcion en varias lineas,
// se emparejan en orden.
async function costosDesdePrecioDeVenta({ margen = 0.30, soloSimular = true, usuario = null, limite = null } = {}) {
  const normaliza = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/^\s*\[REVISAR\]\s*/, '')
    .replace(/\s+/g, ' ').trim();

  let cots = db.prepare(
    `SELECT DISTINCT c.id, c.numero, c.siigo_quotation_id
     FROM cotizaciones c
     JOIN cotizacion_materiales m ON m.cotizacion_id = c.id
     WHERE c.siigo_quotation_id IS NOT NULL
       AND (m.costo_unitario IS NULL OR m.costo_unitario <= 0)
     ORDER BY c.id`
  ).all();
  if (limite) cots = cots.slice(0, limite);

  const update = db.prepare('UPDATE cotizacion_materiales SET costo_unitario = ? WHERE id = ?');
  const lineasDe = db.prepare(
    `SELECT id, descripcion, cantidad_presupuestada FROM cotizacion_materiales
     WHERE cotizacion_id = ? AND (costo_unitario IS NULL OR costo_unitario <= 0) ORDER BY orden, id`
  );

  let lineasActualizadas = 0;
  let cotizacionesTocadas = 0;
  let sinPrecioEnSiigo = 0;
  let sinCorrespondencia = 0;
  const errores = [];
  const detalle = [];

  for (const cot of cots) {
    let items;
    try {
      const q = await siigo.obtenerCotizacion(cot.siigo_quotation_id);
      items = Array.isArray(q.items) ? q.items : [];
    } catch (e) {
      errores.push({ numero: cot.numero, error: e.message });
      continue;
    }
    // Agrupa los precios de Siigo por descripcion normalizada
    const porDescripcion = new Map();
    for (const it of items) {
      const d = normaliza(it.description || it.name || it.code);
      const precio = Number(it.price ?? it.unit_price ?? 0) || 0;
      if (!d) continue;
      if (!porDescripcion.has(d)) porDescripcion.set(d, []);
      porDescripcion.get(d).push(precio);
    }

    let tocadas = 0;
    for (const linea of lineasDe.all(cot.id)) {
      const d = normaliza(linea.descripcion);
      const cola = porDescripcion.get(d);
      if (!cola || !cola.length) { sinCorrespondencia++; continue; }
      const precioVenta = cola.shift();
      if (!precioVenta || precioVenta <= 0) { sinPrecioEnSiigo++; continue; }
      const costo = Math.round(precioVenta * (1 - margen) * 100) / 100;
      if (!soloSimular) update.run(costo, linea.id);
      lineasActualizadas++;
      tocadas++;
      if (detalle.length < 40) {
        detalle.push({
          cotizacion: cot.numero,
          descripcion: String(linea.descripcion).slice(0, 70),
          precio_venta_siigo: precioVenta,
          costo_calculado: costo,
        });
      }
    }
    if (tocadas) {
      cotizacionesTocadas++;
      if (!soloSimular) {
        registrar({
          usuario, accion: 'EDITAR', entidad: 'cotizacion_materiales', entidadId: cot.id,
          campo: 'costo_unitario',
          valorNuevo: `${tocadas} linea(s) costeadas al ${Math.round((1 - margen) * 100)}% del precio de venta de Siigo (margen ${Math.round(margen * 100)}%)`,
        });
      }
    }
    await pausa(PAUSA_ENTRE_LLAMADAS_MS);
  }

  return {
    simulacion: soloSimular,
    margen_aplicado: margen,
    cotizaciones_revisadas: cots.length,
    cotizaciones_con_cambios: cotizacionesTocadas,
    lineas_actualizadas: lineasActualizadas,
    lineas_sin_precio_en_siigo: sinPrecioEnSiigo,
    lineas_sin_correspondencia: sinCorrespondencia,
    errores,
    muestra: detalle,
  };
}

// ---------------------------------------------------------------- materiales

// Crea las lineas de materiales de las cotizaciones pendientes (un lote por
// llamada). `usuario` puede ser null: la auditoria lo registra como "Sistema".
async function cargarMateriales({ limit, usuario = null } = {}) {
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
        usuario, accion: 'IMPORTAR', entidad: 'cotizacion_materiales', entidadId: cot.id,
        valorNuevo: `Carga automatica desde Siigo: ${analizados.length} items (${analizados.filter((a) => a.match).length} con match, ${analizados.filter((a) => !a.match).length} para revisar)`,
      });
      cotizacionesProcesadas++;
    } catch (e) {
      errores.push({ numero: cot.numero, error: e.message });
    }
    await pausa(PAUSA_ENTRE_LLAMADAS_MS);
  }

  return { cotizacionesProcesadas, lineasInsertadas, lineasSinMatch, pendientesTotales: totalPendientes(), errores };
}

// ---------------------------------------------------------------- cotizaciones

const cacheClientes = new Map();
async function nombreClientePorId(id) {
  if (!id) return 'Cliente sin identificar';
  if (cacheClientes.has(id)) return cacheClientes.get(id);
  try {
    const nombre = siigo.nombreCliente(await siigo.obtenerCliente(id));
    cacheClientes.set(id, nombre);
    return nombre;
  } catch (e) {
    return 'Cliente de Siigo (no se pudo consultar el nombre)';
  }
}

// Crea en la app el borrador correspondiente a una cotizacion de Siigo.
// Devuelve null si ya estaba importada. `parametrosVigenteEn`/`politicaVigenteEn`
// se reciben como argumentos para no crear una dependencia circular con las
// rutas que los exportan.
async function importarCotizacion(siigoId, { usuario, parametrosVigenteEn, politicaVigenteEn }) {
  if (db.prepare('SELECT id FROM cotizaciones WHERE siigo_quotation_id = ?').get(siigoId)) return null;

  const q = await siigo.obtenerCotizacion(siigoId);
  const clienteNombre = await nombreClientePorId(q.customer && q.customer.id);
  const fecha = (q.date || todayStr()).slice(0, 10);
  const descripcion = (q.items || []).map((it) => it.description).filter(Boolean).join('; ').slice(0, 500);
  const numero = q.name || cotizacionService.generarNumero();

  const param = parametrosVigenteEn(fecha);
  const politica = politicaVigenteEn(fecha);
  if (!param || !politica) {
    const err = new Error('No hay parámetros de gastos fijos o políticas comerciales vigentes para esa fecha. Configúrelos primero en Admin.');
    err.status = 400;
    throw err;
  }

  const numeroFinal = db.prepare('SELECT id FROM cotizaciones WHERE numero = ?').get(numero)
    ? cotizacionService.generarNumero()
    : numero;

  const info = db.prepare(
    `INSERT INTO cotizaciones (numero, cliente, descripcion, fecha_cotizacion, condicion_pago,
      dias_credito_otorgados, precio_venta, pct_anticipo, estado, parametros_id, politica_id,
      creado_por, actualizado_por, siigo_quotation_id, observaciones_siigo)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    numeroFinal, clienteNombre, descripcion || `Importada desde Siigo (cotización ${numero})`, fecha,
    'Contado', 0, Number(q.total) || 0, 0, 'Borrador', param.id, politica.id,
    usuario ? usuario.id : null, usuario ? usuario.id : null, siigoId, q.observations || ''
  );
  registrar({
    usuario, accion: 'CREAR', entidad: 'cotizaciones', entidadId: info.lastInsertRowid,
    valorNuevo: `${numeroFinal} (importada de Siigo)`,
  });
  return info.lastInsertRowid;
}

// Busca en Siigo las cotizaciones de los ultimos `dias` e importa las que
// todavia no existan en la app.
async function importarNuevas({ dias = 30, usuario = null, parametrosVigenteEn, politicaVigenteEn } = {}) {
  const createdStart = addDays(todayStr(), -Math.abs(dias));
  const createdEnd = todayStr();
  const importadas = [];
  const errores = [];
  let page = 1;

  while (page <= 20) {
    const data = await siigo.listarCotizaciones({ createdStart, createdEnd, page, pageSize: 100 });
    const resultados = data.results || [];
    if (!resultados.length) break;

    for (const q of resultados) {
      try {
        const id = await importarCotizacion(q.id, { usuario, parametrosVigenteEn, politicaVigenteEn });
        if (id) {
          const cot = db.prepare('SELECT numero, cliente, precio_venta FROM cotizaciones WHERE id = ?').get(id);
          importadas.push(cot);
          await pausa(PAUSA_ENTRE_LLAMADAS_MS);
        }
      } catch (e) {
        errores.push({ siigoId: q.id, numero: q.name || q.number, error: e.message });
      }
    }

    const total = (data.pagination && data.pagination.total_results) || 0;
    if (page * 100 >= total) break;
    page++;
  }

  return { importadas, errores, desde: createdStart, hasta: createdEnd };
}

// ---------------------------------------------------------------- observaciones

// Trae de Siigo las observaciones (el titulo del trabajo) de las cotizaciones
// que se importaron antes de guardarlas. Un lote por llamada, para no pasarse
// del tiempo maximo de una peticion en Railway; se llama hasta que no queden.
async function completarObservaciones({ limite = 25 } = {}) {
  const pendientes = db.prepare(
    `SELECT id, numero, siigo_quotation_id FROM cotizaciones
     WHERE siigo_quotation_id IS NOT NULL AND observaciones_siigo IS NULL
     ORDER BY id LIMIT ?`
  ).all(limite);
  const guardar = db.prepare('UPDATE cotizaciones SET observaciones_siigo = ? WHERE id = ?');
  let conTexto = 0;
  const errores = [];
  for (const c of pendientes) {
    try {
      const q = await siigo.obtenerCotizacion(c.siigo_quotation_id);
      const obs = (q && q.observations) || '';
      guardar.run(obs, c.id);   // '' marca "consultada y sin observaciones"
      if (obs.trim()) conTexto++;
    } catch (e) {
      errores.push({ numero: c.numero, error: e.message });
    }
    await pausa(PAUSA_ENTRE_LLAMADAS_MS);
  }
  const quedan = db.prepare(
    `SELECT COUNT(*) AS n FROM cotizaciones
     WHERE siigo_quotation_id IS NOT NULL AND observaciones_siigo IS NULL`
  ).get().n;
  return { procesadas: pendientes.length, conTexto, pendientes: quedan, errores };
}

// ---------------------------------------------------------------- orquestador

// Lo que corre el programador diario: primero trae las cotizaciones nuevas y
// despues les carga los materiales, en lotes, hasta que no queden pendientes.
// El limite de lotes evita una corrida infinita si algo va mal.
async function sincronizar({ dias = 30, usuario = null, parametrosVigenteEn, politicaVigenteEn, maxLotes = 30, tamanoLote = 10 } = {}) {
  const inicio = new Date();
  const nuevas = await importarNuevas({ dias, usuario, parametrosVigenteEn, politicaVigenteEn });

  let lineasInsertadas = 0;
  let lineasSinMatch = 0;
  let cotizacionesConMateriales = 0;
  const errores = [...nuevas.errores];

  for (let lote = 0; lote < maxLotes; lote++) {
    if (totalPendientes() === 0) break;
    const r = await cargarMateriales({ limit: tamanoLote, usuario });
    lineasInsertadas += r.lineasInsertadas;
    lineasSinMatch += r.lineasSinMatch;
    cotizacionesConMateriales += r.cotizacionesProcesadas;
    errores.push(...r.errores);
    if (r.cotizacionesProcesadas === 0) break; // no avanza: evitar bucle infinito
  }

  return {
    inicio: inicio.toISOString(),
    fin: new Date().toISOString(),
    duracionSegundos: Math.round((Date.now() - inicio.getTime()) / 1000),
    cotizacionesImportadas: nuevas.importadas.length,
    detalleImportadas: nuevas.importadas,
    cotizacionesConMaterialesCargados: cotizacionesConMateriales,
    lineasInsertadas,
    lineasSinPrecio: lineasSinMatch,
    pendientesTotales: totalPendientes(),
    errores,
  };
}

module.exports = {
  cotizacionesPendientes, totalPendientes, catalogoTokenizado, mejorMatch,
  analizarCotizacion, cargarMateriales, importarCotizacion, importarNuevas,
  sincronizar, nombreClientePorId, costosDesdePrecioDeVenta, completarObservaciones,
};
