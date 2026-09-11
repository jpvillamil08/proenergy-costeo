'use strict';
// Logica de sincronizacion con Siigo, compartida por las rutas manuales
// (siigo.routes.js, siigo-materiales.routes.js) y por el programador
// automatico (scheduler.js). Vive aqui para que el cron y el boton de la app
// hagan exactamente lo mismo, sin duplicar reglas.
//
// Operaciones:
//   1. importarNuevas()        trae de Siigo las cotizaciones que aun no existen
//                              en la app (numero, cliente, fecha y precio; Siigo
//                              no maneja costos internos).
//   2. cargarMateriales()      para las cotizaciones importadas que todavia no
//                              tienen lineas, trae sus items de Siigo y los cruza
//                              contra el catalogo real de materiales.
//   3. revisarModificadas()    vuelve a mirar las cotizaciones ya importadas y,
//                              si alguien las edito en Siigo (precio, items,
//                              cantidades), pone la app al dia.
//   4. completarTitulos()      guarda la cotizacion cruda de Siigo de las que
//                              aun no la tienen (de ahi sale el titulo).
//   5. costosDesdePrecioDeVenta()  costea las lineas en $0 con la regla del
//                              precio de Siigo menos 30%.
//
// NUNCA inventa un costo: cuando el cruce contra el catalogo no es claro y
// unico, la linea se crea igual (para no perder la cantidad ni la descripcion
// original) pero con costo 0 y la descripcion marcada "[REVISAR]", para que
// alguien la complete a mano. Y NUNCA pisa un costo que alguien escribio a mano
// (cotizacion_materiales.costo_origen = 'manual').

const crypto = require('node:crypto');
const db = require('../db');
const siigo = require('./siigo');
const { tokenizar } = require('./estimador');
const { registrar } = require('./audit');
const { todayStr, addDays } = require('./dates');
const { tituloDeCotizacion } = require('./titulo');
const cotizacionService = require('./cotizacion-service');

const PAUSA_ENTRE_LLAMADAS_MS = 300; // para no saturar la API de Siigo
const MARGEN_REGLA = 0.30;           // regla del costo: precio de Siigo menos 30%
const MARCA_RETIRADA = '[YA NO ESTÁ EN SIIGO] ';

function pausa(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- items de Siigo

// Descripcion comparable: sin tildes, en mayusculas, sin las marcas que pone la
// app ("[REVISAR]", "[YA NO ESTÁ EN SIIGO]") y con los espacios colapsados.
function normalizarDescripcion(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/^\s*\[YA NO ESTA EN SIIGO\]\s*/, '')
    .replace(/^\s*\[REVISAR\]\s*/, '')
    .replace(/\s+/g, ' ').trim();
}

// Items de una cotizacion de Siigo con una clave estable: codigo + descripcion
// + numero de ocurrencia (una cotizacion puede repetir el mismo item). Con esa
// clave se sabe que linea de la app corresponde a que item aunque cambien la
// cantidad o el precio.
function itemsDeSiigo(q) {
  const vistos = new Map();
  return (Array.isArray(q && q.items) ? q.items : []).map((it) => {
    const descripcion = it.description || it.name || it.code || 'Item sin descripción';
    const descNorm = normalizarDescripcion(descripcion);
    const base = `${String(it.code || '').trim().toUpperCase()}|${descNorm}`;
    const n = (vistos.get(base) || 0) + 1;
    vistos.set(base, n);
    return {
      clave: `${base}#${n}`, descripcion, descNorm, codigo: it.code || null,
      cantidad: Number(it.quantity ?? it.qty ?? 1) || 1,
      precio: Number(it.price ?? it.unit_price ?? 0) || 0,
    };
  });
}

// Huella de lo que importa de la cotizacion: si cambia, alguien la edito en Siigo.
// Entran todos los campos simples del primer nivel (total, fecha, observaciones y
// el campo del titulo, donde sea que Siigo lo guarde) en crudo, no el titulo ya
// calculado: asi, si cambia la regla del titulo, las huellas no cambian todas.
function huellaCotizacion(q) {
  const simples = Object.keys(q || {}).sort()
    .filter((k) => k !== 'metadata' && ['string', 'number', 'boolean'].includes(typeof q[k]))
    .map((k) => [k, q[k]]);
  const datos = {
    simples,
    cliente: (q.customer && q.customer.id) || null,
    items: (q.items || []).map((it) => [
      it.code || '', it.description || '', Number(it.quantity) || 0, Number(it.price) || 0, Number(it.discount) || 0,
    ]),
  };
  return crypto.createHash('sha1').update(JSON.stringify(datos)).digest('hex');
}

// Empareja las lineas de materiales de la app con los items de Siigo: primero
// por la clave guardada y despues por descripcion (las lineas "[REVISAR]"
// conservan la descripcion de Siigo). Devuelve los pares, los items que no
// tienen linea y las lineas que no tienen item.
function emparejar(lineas, items) {
  const libres = new Map(lineas.map((l) => [l.id, l]));
  const pares = [];
  let pendientes = [];
  for (const it of items) {
    const l = [...libres.values()].find((x) => x.siigo_item === it.clave);
    if (l) { pares.push([it, l]); libres.delete(l.id); } else pendientes.push(it);
  }
  const sinLinea = [];
  for (const it of pendientes) {
    const l = [...libres.values()].find((x) => !x.siigo_item && normalizarDescripcion(x.descripcion) === it.descNorm);
    if (l) { pares.push([it, l]); libres.delete(l.id); } else sinLinea.push(it);
  }
  pendientes = null;
  return { pares, sinLinea, sobrantes: [...libres.values()] };
}

function costoPorRegla(precio) {
  return Math.round(precio * (1 - MARGEN_REGLA) * 100) / 100;
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

// Items de una cotizacion de Siigo con el cruce contra el catalogo aplicado. No
// escribe nada: se usa tanto en preview como antes de escribir. `q` es opcional
// (si ya se consulto la cotizacion, no se vuelve a pedir).
async function analizarCotizacion(cot, catalogo, q = null) {
  const cotSiigo = q || await siigo.obtenerCotizacion(cot.siigo_quotation_id);
  return itemsDeSiigo(cotSiigo).map((it) => ({
    descripcionOriginal: it.descripcion, cantidad: it.cantidad,
    // precioVenta: lo que se le cobra al cliente por unidad. Sirve para deducir
    // el costo cuando no se consigue el precio del proveedor (ver
    // costosDesdePrecioDeVenta).
    precioVenta: it.precio, codigo: it.codigo, clave: it.clave,
    match: mejorMatch(it.descripcion, catalogo),
  }));
}

const insertLinea = () => db.prepare(
  `INSERT INTO cotizacion_materiales
    (cotizacion_id, descripcion, clasificacion, forma_pago, proveedor_id, dias_credito_proveedor,
     cantidad_presupuestada, cantidad_real, costo_unitario, siigo_item, precio_venta_siigo, costo_origen)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
);

// Inserta la linea de un item de Siigo: con el material del catalogo si el
// cruce es claro, o "[REVISAR]" en $0 si no (la costea despues la regla).
function insertarLineaDeItem(stmt, cotId, a) {
  if (a.match) {
    stmt.run(cotId, a.match.descripcion, 'Directo', 'Contado', a.match.proveedor_id, 0, a.cantidad, 0,
      a.match.costo_unitario, a.clave, a.precioVenta, 'catalogo');
  } else {
    stmt.run(cotId, `[REVISAR] ${a.descripcionOriginal}`, 'Directo', 'Contado', null, 0, a.cantidad, 0,
      0, a.clave, a.precioVenta, null);
  }
}

// ---------------------------------------------------------------- costo desde el precio

// Deduce el costo de las lineas que quedaron en $0 a partir del precio de venta
// que la propia cotizacion tiene en Siigo, restandole el margen indicado.
//
// Por que existe: para muchos items no se consigue el precio del proveedor, pero
// SI se sabe a cuanto se vendieron. Si la empresa cotiza con un margen conocido,
// el costo se puede despejar de ahi. Es una aproximacion, no el costo real de la
// factura de compra, y por eso se registra en la auditoria diciendo de donde
// salio, y la linea queda con costo_origen = 'regla_precio' (si el precio cambia
// en Siigo, la sincronizacion lo recalcula; un costo manual no se toca nunca).
//
// El cruce entre la linea guardada y el item de Siigo se hace por descripcion
// normalizada; si una cotizacion repite la misma descripcion en varias lineas,
// se emparejan en orden.
async function costosDesdePrecioDeVenta({ margen = MARGEN_REGLA, soloSimular = true, usuario = null, limite = null } = {}) {
  let cots = db.prepare(
    `SELECT DISTINCT c.id, c.numero, c.siigo_quotation_id
     FROM cotizaciones c
     JOIN cotizacion_materiales m ON m.cotizacion_id = c.id
     WHERE c.siigo_quotation_id IS NOT NULL
       AND (m.costo_unitario IS NULL OR m.costo_unitario <= 0)
       AND COALESCE(m.costo_origen, '') <> 'manual'
     ORDER BY c.id`
  ).all();
  if (limite) cots = cots.slice(0, limite);

  const update = db.prepare(
    `UPDATE cotizacion_materiales SET costo_unitario = ?, precio_venta_siigo = ?, costo_origen = 'regla_precio' WHERE id = ?`
  );
  const lineasDe = db.prepare(
    `SELECT id, descripcion, cantidad_presupuestada FROM cotizacion_materiales
     WHERE cotizacion_id = ? AND (costo_unitario IS NULL OR costo_unitario <= 0)
       AND COALESCE(costo_origen, '') <> 'manual'
     ORDER BY orden, id`
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
      items = itemsDeSiigo(await siigo.obtenerCotizacion(cot.siigo_quotation_id));
    } catch (e) {
      errores.push({ numero: cot.numero, error: e.message });
      continue;
    }
    // Agrupa los precios de Siigo por descripcion normalizada
    const porDescripcion = new Map();
    for (const it of items) {
      if (!it.descNorm) continue;
      if (!porDescripcion.has(it.descNorm)) porDescripcion.set(it.descNorm, []);
      porDescripcion.get(it.descNorm).push(it.precio);
    }

    let tocadas = 0;
    for (const linea of lineasDe.all(cot.id)) {
      const cola = porDescripcion.get(normalizarDescripcion(linea.descripcion));
      if (!cola || !cola.length) { sinCorrespondencia++; continue; }
      const precioVenta = cola.shift();
      if (!precioVenta || precioVenta <= 0) { sinPrecioEnSiigo++; continue; }
      const costo = Math.round(precioVenta * (1 - margen) * 100) / 100;
      if (!soloSimular) update.run(costo, precioVenta, linea.id);
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
        cotizacionService.syncCuentasPorPagar(cot.id);
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
  const insert = insertLinea();
  let cotizacionesProcesadas = 0;
  let lineasInsertadas = 0;
  let lineasSinMatch = 0;
  const errores = [];

  for (const cot of pendientes) {
    try {
      const q = await siigo.obtenerCotizacion(cot.siigo_quotation_id);
      const analizados = await analizarCotizacion(cot, catalogo, q);
      for (const a of analizados) {
        insertarLineaDeItem(insert, cot.id, a);
        if (!a.match) lineasSinMatch++;
        lineasInsertadas++;
      }
      guardarBaseSiigo(cot, q);
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

function descripcionDeItems(q) {
  return (q.items || []).map((it) => it.description).filter(Boolean).join('; ').slice(0, 500);
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
  const descripcion = descripcionDeItems(q);
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
      creado_por, actualizado_por, siigo_quotation_id, observaciones_siigo, siigo_json, siigo_huella, siigo_revisado_en)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`
  ).run(
    numeroFinal, clienteNombre, descripcion || `Importada desde Siigo (cotización ${numero})`, fecha,
    'Contado', 0, Number(q.total) || 0, 0, 'Borrador', param.id, politica.id,
    usuario ? usuario.id : null, usuario ? usuario.id : null, siigoId, q.observations || '',
    JSON.stringify(q), huellaCotizacion(q)
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

// ---------------------------------------------------------------- base de comparacion

// Guarda la cotizacion cruda de Siigo y su huella: es el punto de partida para
// saber despues si alguien la edito. Tambien le pone a las lineas que ya existian
// la clave del item de Siigo del que salieron (las cargadas antes de existir
// esa columna no la tienen), para que la proxima reconciliacion las encuentre.
// No cambia cantidades, precios ni costos.
function guardarBaseSiigo(cot, q) {
  db.prepare(
    `UPDATE cotizaciones SET siigo_json = ?, observaciones_siigo = ?, siigo_huella = ?, siigo_revisado_en = datetime('now')
     WHERE id = ?`
  ).run(JSON.stringify(q), q.observations || '', huellaCotizacion(q), cot.id);

  const items = itemsDeSiigo(q);
  const lineas = db.prepare('SELECT * FROM cotizacion_materiales WHERE cotizacion_id = ? ORDER BY orden, id').all(cot.id);
  if (!lineas.length) return;
  const { pares, sinLinea, sobrantes } = emparejar(lineas, items);
  // Lineas que cruzaron con el catalogo tienen la descripcion del catalogo, no la
  // de Siigo. Si lo que queda sin emparejar calza uno a uno (misma cantidad de
  // lineas no manuales que de items), se emparejan en el orden en que se crearon.
  const candidatas = sobrantes.filter((l) => !l.siigo_item && l.costo_origen !== 'manual');
  if (sinLinea.length && candidatas.length === sinLinea.length) {
    sinLinea.forEach((it, k) => pares.push([it, candidatas[k]]));
  }
  const upd = db.prepare(
    `UPDATE cotizacion_materiales SET siigo_item = ?, precio_venta_siigo = COALESCE(precio_venta_siigo, ?),
       costo_origen = COALESCE(costo_origen, ?) WHERE id = ?`
  );
  for (const [it, l] of pares) {
    // Origen desconocido: si el costo es exactamente el de la regla, salio de ahi.
    let origen = null;
    if (!l.costo_origen && it.precio > 0 && Math.abs(Number(l.costo_unitario) - costoPorRegla(it.precio)) < 0.01) origen = 'regla_precio';
    else if (!l.costo_origen && l.proveedor_id) origen = 'catalogo';
    upd.run(it.clave, it.precio, origen, l.id);
  }
}

// ---------------------------------------------------------------- cotizaciones modificadas

function pesos(v) {
  return '$ ' + Math.round(Number(v) || 0).toLocaleString('es-CO');
}

// Pone una cotizacion de la app al dia con lo que hoy dice Siigo. Reglas:
//  - Cabecera: precio, cliente, fecha y descripcion salen de Siigo.
//  - Linea cuyo item sigue en Siigo: se actualizan cantidad y precio de Siigo.
//    Si su costo salio de la regla (precio - 30%) y el precio cambio, se
//    recalcula. Un costo manual o del catalogo no se toca.
//  - Item nuevo en Siigo: se crea la linea (catalogo o "[REVISAR]" en $0; la
//    regla la costea en el mismo ciclo).
//  - Linea cuyo item ya no esta en Siigo: se borra, salvo que tenga costo manual
//    o datos de ejecucion (cantidad real o fecha de compra): esa se conserva
//    marcada "[YA NO ESTÁ EN SIIGO]" para que alguien decida.
//  - Mano de obra: no se toca; Siigo no la maneja.
// Devuelve la lista de cambios (vacia si no hubo ninguno visible).
async function actualizarDesdeSiigo(cot, q, { usuario = null, catalogo = null } = {}) {
  const cliente = await nombreClientePorId(q.customer && q.customer.id);
  const cat = catalogo || catalogoTokenizado();
  const cambios = [];
  const precio = Number(q.total) || 0;
  const fecha = String(q.date || cot.fecha_cotizacion).slice(0, 10);
  const descripcion = descripcionDeItems(q) || cot.descripcion;
  if (Math.abs(precio - (Number(cot.precio_venta) || 0)) > 0.5) cambios.push(`precio ${pesos(cot.precio_venta)} → ${pesos(precio)}`);
  if (fecha !== cot.fecha_cotizacion) cambios.push(`fecha ${cot.fecha_cotizacion} → ${fecha}`);
  const clienteFinal = /no se pudo consultar/.test(cliente) ? cot.cliente : cliente;
  if (clienteFinal !== cot.cliente) cambios.push(`cliente ${cot.cliente} → ${clienteFinal}`);

  const items = itemsDeSiigo(q);
  const lineas = db.prepare('SELECT * FROM cotizacion_materiales WHERE cotizacion_id = ? ORDER BY orden, id').all(cot.id);
  const { pares, sinLinea, sobrantes } = emparejar(lineas, items);
  const analizadosNuevos = sinLinea.map((it) => ({
    descripcionOriginal: it.descripcion, cantidad: it.cantidad, precioVenta: it.precio, clave: it.clave,
    match: mejorMatch(it.descripcion, cat),
  }));

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE cotizaciones SET precio_venta = ?, fecha_cotizacion = ?, descripcion = ?, cliente = ?,
         actualizado_en = datetime('now') WHERE id = ?`
    ).run(precio, fecha, descripcion, clienteFinal, cot.id);

    const updLinea = db.prepare(
      `UPDATE cotizacion_materiales SET siigo_item = ?, precio_venta_siigo = ?, cantidad_presupuestada = ?,
         costo_unitario = ?, descripcion = ? WHERE id = ?`
    );
    for (const [it, l] of pares) {
      let costo = Number(l.costo_unitario) || 0;
      const precioAntes = l.precio_venta_siigo;
      if (l.costo_origen === 'regla_precio' && it.precio > 0 && precioAntes != null && Math.abs(precioAntes - it.precio) > 0.005) {
        costo = costoPorRegla(it.precio);
        cambios.push(`${it.descripcion.slice(0, 40)}: precio ${pesos(precioAntes)} → ${pesos(it.precio)} (costo por regla recalculado)`);
      } else if (precioAntes != null && Math.abs(precioAntes - it.precio) > 0.005) {
        cambios.push(`${it.descripcion.slice(0, 40)}: precio ${pesos(precioAntes)} → ${pesos(it.precio)}`);
      }
      if (Math.abs((Number(l.cantidad_presupuestada) || 0) - it.cantidad) > 1e-9) {
        cambios.push(`${it.descripcion.slice(0, 40)}: cantidad ${l.cantidad_presupuestada} → ${it.cantidad}`);
      }
      // Las lineas "[REVISAR]" muestran la descripcion de Siigo: se mantiene al dia.
      const desc = /^\s*\[REVISAR\]/i.test(l.descripcion) ? `[REVISAR] ${it.descripcion}` : l.descripcion.replace(MARCA_RETIRADA, '');
      updLinea.run(it.clave, it.precio, it.cantidad, costo, desc, l.id);
    }

    const insert = insertLinea();
    for (const a of analizadosNuevos) {
      insertarLineaDeItem(insert, cot.id, a);
      cambios.push(`línea nueva: ${a.descripcionOriginal.slice(0, 50)} × ${a.cantidad}`);
    }

    for (const l of sobrantes) {
      // Sin clave no se sabe si la linea vino de Siigo (pudo agregarla alguien
      // en la app): no se toca.
      if (!l.siigo_item) continue;
      const conservar = l.costo_origen === 'manual' || Number(l.cantidad_real) > 0 || l.fecha_compra;
      if (conservar) {
        if (!l.descripcion.startsWith(MARCA_RETIRADA)) {
          db.prepare('UPDATE cotizacion_materiales SET descripcion = ? WHERE id = ?').run(MARCA_RETIRADA + l.descripcion, l.id);
          cambios.push(`ya no está en Siigo (se conserva): ${l.descripcion.slice(0, 50)}`);
        }
      } else {
        db.prepare('DELETE FROM cotizacion_materiales WHERE id = ?').run(l.id);
        cambios.push(`línea eliminada: ${l.descripcion.slice(0, 50)}`);
      }
    }

    db.prepare(
      `UPDATE cotizaciones SET siigo_json = ?, observaciones_siigo = ?, siigo_huella = ?, siigo_revisado_en = datetime('now')
       WHERE id = ?`
    ).run(JSON.stringify(q), q.observations || '', huellaCotizacion(q), cot.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  if (cambios.length) {
    cotizacionService.syncCuentasPorPagar(cot.id);
    registrar({
      usuario, accion: 'SINCRONIZAR', entidad: 'cotizaciones', entidadId: cot.id,
      valorNuevo: `${cot.numero} cambió en Siigo: ${cambios.join('; ')}`.slice(0, 2000),
    });
  }
  return cambios;
}

// Ids de Siigo de las cotizaciones editadas desde `desde`, o null si el filtro
// updated_start no sirve (si con filtro Siigo devuelve lo mismo que sin el, lo
// esta ignorando y no se puede confiar en el).
async function idsActualizadasDesde(desde) {
  const sinFiltro = await siigo.listarCotizaciones({ page: 1, pageSize: 1 });
  const conFiltro = await siigo.listarCotizaciones({ updatedStart: desde, page: 1, pageSize: 100 });
  const totalSin = (sinFiltro.pagination && sinFiltro.pagination.total_results) || 0;
  const totalCon = (conFiltro.pagination && conFiltro.pagination.total_results) || 0;
  if (!totalSin || totalCon >= totalSin) return null;
  const ids = new Set((conFiltro.results || []).map((q) => q.id));
  for (let page = 2; page <= 20 && ids.size < totalCon; page++) {
    const data = await siigo.listarCotizaciones({ updatedStart: desde, page, pageSize: 100 });
    if (!(data.results || []).length) break;
    for (const q of data.results) ids.add(q.id);
  }
  return ids;
}

// Vuelve a mirar en Siigo las cotizaciones ya importadas y pone al dia las que
// cambiaron. Si el filtro por fecha de actualizacion de Siigo funciona, solo se
// consultan las editadas desde la ultima revision; si no, todas (unos minutos,
// con pausa entre llamadas). Las que nunca se habian comparado solo guardan su
// base: la primera vez no hay contra que comparar.
async function revisarModificadas({ usuario = null, pausaMs = 500 } = {}) {
  let cands = db.prepare(
    `SELECT * FROM cotizaciones WHERE siigo_quotation_id IS NOT NULL ORDER BY fecha_cotizacion DESC, id DESC`
  ).all();
  const ultima = db.prepare('SELECT MAX(siigo_revisado_en) AS f FROM cotizaciones').get().f;
  let modo = 'todas';
  if (ultima) {
    try {
      const ids = await idsActualizadasDesde(addDays(String(ultima).slice(0, 10), -1));
      if (ids) {
        cands = cands.filter((c) => !c.siigo_huella || ids.has(c.siigo_quotation_id));
        modo = 'editadas en Siigo desde ' + String(ultima).slice(0, 10);
      }
    } catch (e) { /* sin filtro: se revisan todas */ }
  }

  const catalogo = catalogoTokenizado();
  const resultado = { modo, revisadas: 0, sinCambios: 0, basesNuevas: 0, modificadas: 0, cambios: [], errores: [] };
  const tocar = db.prepare(`UPDATE cotizaciones SET siigo_revisado_en = datetime('now') WHERE id = ?`);
  for (const cot of cands) {
    try {
      const q = await siigo.obtenerCotizacion(cot.siigo_quotation_id);
      resultado.revisadas++;
      if (!cot.siigo_huella) {
        guardarBaseSiigo(cot, q);
        resultado.basesNuevas++;
      } else if (huellaCotizacion(q) !== cot.siigo_huella) {
        const cambios = await actualizarDesdeSiigo(cot, q, { usuario, catalogo });
        resultado.modificadas++;
        if (resultado.cambios.length < 40) resultado.cambios.push({ numero: cot.numero, cambios: cambios.length ? cambios : ['sin cambios visibles (título u otro dato)'] });
      } else {
        if (!cot.siigo_json) guardarBaseSiigo(cot, q); else tocar.run(cot.id);
        resultado.sinCambios++;
      }
    } catch (e) {
      resultado.errores.push({ numero: cot.numero, error: e.message });
    }
    await pausa(pausaMs);
  }
  return resultado;
}

// ---------------------------------------------------------------- titulos

// Guarda la cotizacion cruda de Siigo (y con ella el titulo) de las que se
// importaron antes de que se guardara. Un lote por llamada, para no pasarse del
// tiempo maximo de una peticion en Railway; se llama hasta que no queden.
async function completarTitulos({ limite = 25 } = {}) {
  const pendientes = db.prepare(
    `SELECT * FROM cotizaciones WHERE siigo_quotation_id IS NOT NULL AND siigo_json IS NULL ORDER BY id LIMIT ?`
  ).all(limite);
  let conTexto = 0;
  const errores = [];
  for (const c of pendientes) {
    try {
      const q = await siigo.obtenerCotizacion(c.siigo_quotation_id);
      guardarBaseSiigo(c, q);
      if (tituloDeCotizacion(q)) conTexto++;
    } catch (e) {
      errores.push({ numero: c.numero, error: e.message });
    }
    await pausa(PAUSA_ENTRE_LLAMADAS_MS);
  }
  const quedan = db.prepare(
    `SELECT COUNT(*) AS n FROM cotizaciones WHERE siigo_quotation_id IS NOT NULL AND siigo_json IS NULL`
  ).get().n;
  return { procesadas: pendientes.length, conTexto, pendientes: quedan, errores };
}

// ---------------------------------------------------------------- orquestador

// Pasos de cotizaciones de la sincronizacion (el programador agrega despues las
// facturas). `alAvanzar(paso)` informa en que va, para GET /api/siigo/sync/estado.
async function sincronizarCotizaciones({ dias = 30, usuario = null, parametrosVigenteEn, politicaVigenteEn,
  maxLotes = 30, tamanoLote = 10, alAvanzar = () => {} } = {}) {
  const inicio = new Date();
  alAvanzar('Importando cotizaciones nuevas');
  const nuevas = await importarNuevas({ dias, usuario, parametrosVigenteEn, politicaVigenteEn });

  alAvanzar('Cargando materiales de las nuevas');
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

  alAvanzar('Revisando cotizaciones modificadas en Siigo');
  const modificadas = await revisarModificadas({ usuario });
  errores.push(...modificadas.errores);

  alAvanzar('Completando títulos');
  let titulos = { procesadas: 0, pendientes: 0 };
  for (let k = 0; k < 20; k++) {
    const r = await completarTitulos({ limite: 25 });
    titulos = { procesadas: titulos.procesadas + r.procesadas, pendientes: r.pendientes };
    errores.push(...r.errores);
    if (!r.pendientes || !r.procesadas) break;
  }

  alAvanzar('Costeando líneas en $0 con la regla del precio');
  const costeo = await costosDesdePrecioDeVenta({ soloSimular: false, usuario });
  errores.push(...costeo.errores);

  return {
    inicio: inicio.toISOString(),
    // Mismos nombres de siempre, los lee scripts/actualizar-cotizaciones-dia.py
    cotizacionesImportadas: nuevas.importadas.length,
    detalleImportadas: nuevas.importadas,
    cotizacionesConMaterialesCargados: cotizacionesConMateriales,
    lineasInsertadas,
    lineasSinPrecio: lineasSinMatch,
    pendientesTotales: totalPendientes(),
    modificadas: {
      modo: modificadas.modo, revisadas: modificadas.revisadas, modificadas: modificadas.modificadas,
      basesNuevas: modificadas.basesNuevas, cambios: modificadas.cambios,
    },
    titulosCompletados: titulos.procesadas,
    lineasCosteadasPorRegla: costeo.lineas_actualizadas,
    errores,
  };
}

// Compatibilidad: lo que antes corria el programador (solo cotizaciones).
async function sincronizar(opciones = {}) {
  const r = await sincronizarCotizaciones(opciones);
  r.fin = new Date().toISOString();
  r.duracionSegundos = Math.round((Date.now() - new Date(r.inicio).getTime()) / 1000);
  return r;
}

module.exports = {
  cotizacionesPendientes, totalPendientes, catalogoTokenizado, mejorMatch,
  analizarCotizacion, cargarMateriales, importarCotizacion, importarNuevas,
  sincronizar, sincronizarCotizaciones, nombreClientePorId, costosDesdePrecioDeVenta,
  completarTitulos, completarObservaciones: completarTitulos,
  revisarModificadas, actualizarDesdeSiigo, guardarBaseSiigo,
  // los usa tambien lib/correo-sync.js (cotizaciones registradas desde el correo)
  insertLinea, insertarLineaDeItem, costoPorRegla,
  // para pruebas
  itemsDeSiigo, huellaCotizacion, emparejar, normalizarDescripcion,
};
