'use strict';
// Lectura automatica del correo (Outlook) hacia la plataforma. Corre cada hora
// desde lib/scheduler.js, y a mano con POST /api/correo/ejecutar.
//
// Por cada correo nuevo de los buzones configurados (recibidos y enviados):
//   1. filtro previo sin IA (lib/correo-extraccion.js, prefiltro);
//   2. la IA lo clasifica y extrae sus datos (extraer);
//   3. se aplica la accion segun el tipo (aplicar):
//      - cotizacion de Siigo enviada   -> se vincula y pasa a "Enviada"
//      - cotizacion propia enviada     -> se crea en la plataforma (origen 'correo')
//        (las hechas en Word con actas y alcance tecnico, que no pasan por Siigo)
//      - orden de compra recibida      -> ordenes_compra + cotizacion "Aprobada"
//      - solicitud / licitacion        -> buzon de ofertas, "Pendiente"
//      - cotizacion de proveedor       -> buzon de ofertas con sus items
// Todo queda en correo_mensajes (con el JSON extraido y el enlace al correo) y
// lo que se crea o cambia, en auditoria como "Sistema".
//
// NUNCA inventa: si el documento no trae un valor, queda vacio. El unico
// calculo es el IVA (x1,19) cuando el documento trae solo el valor sin IVA,
// para seguir la convencion de la plataforma (precio_venta con IVA), y queda
// anotado en la descripcion.

const db = require('../db');
const outlook = require('./outlook');
const extraccion = require('./correo-extraccion');
const siigoSync = require('./siigo-sync');
const cotizacionService = require('./cotizacion-service');
const { registrar } = require('./audit');
const { todayStr, addDays } = require('./dates');

const CARPETAS = ['inbox', 'sentitems'];
const DIAS_PRIMERA_LECTURA = 30;
const MAX_INTENTOS = 3;

// ---------------------------------------------------------------- utilidades

function normNumero(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Cotizacion existente por numero (C-1-235, o la referencia de una propia).
function cotizacionPorNumero(numero) {
  const n = normNumero(numero);
  if (n.length < 4) return null;
  return db.prepare('SELECT * FROM cotizaciones').all().find((c) => normNumero(c.numero) === n) || null;
}

// Numeros C-1-xxx que aparecen en el asunto o el cuerpo y existen de verdad
// (complementa lo que diga la IA; mismo criterio que lib/facturas-vinculo.js).
function numerosSiigoEnTexto(texto) {
  const t = normNumero(texto);
  const salida = new Set();
  for (const m of t.matchAll(/(?:^|-)(C-\d+-\d+)(?=-|$)/g)) salida.add(m[1]);
  return [...salida];
}

function soloNumeroOC(v) {
  const m = String(v || '').match(/\d{2,10}/);
  return m ? m[0].replace(/^0+/, '') || '0' : null;
}

function fechaDe(m, carpeta) {
  return String((carpeta === 'sentitems' ? m.sentDateTime : m.receivedDateTime) || m.receivedDateTime || new Date().toISOString());
}

function dominio(correo) {
  const m = String(correo || '').match(/@([^>\s]+)/);
  return m ? m[1].toLowerCase() : null;
}

// Entrada del buzon que corresponde a la misma conversacion (hilo de correo).
function buzonDeConversacion(conversacion) {
  if (!conversacion) return null;
  return db.prepare(
    `SELECT b.* FROM buzon_ofertas b JOIN correo_mensajes m ON m.id = b.mensaje_id
     WHERE m.conversacion = ? ORDER BY b.id LIMIT 1`
  ).get(conversacion) || null;
}

// ---------------------------------------------------------------- acciones

function marcarEnviada(cot, mensajeId, fecha) {
  db.prepare(
    `UPDATE cotizaciones SET fecha_envio = COALESCE(fecha_envio, ?), correo_mensaje_id = COALESCE(correo_mensaje_id, ?),
       estado = CASE WHEN estado = 'Borrador' THEN 'Enviada' ELSE estado END, actualizado_en = datetime('now')
     WHERE id = ?`
  ).run(fecha.slice(0, 10), mensajeId, cot.id);
}

// Si el correo enviado responde al hilo de una solicitud del buzon, esa
// solicitud queda "Cotizada" con esta cotizacion: es la evidencia mas directa
// de que se respondio.
function cerrarSolicitudDelHilo(conversacion, cotId) {
  const b = buzonDeConversacion(conversacion);
  if (b && b.estado === 'Pendiente' && b.tipo !== 'Proveedor') {
    db.prepare(`UPDATE buzon_ofertas SET estado = 'Cotizada', cotizacion_id = ? WHERE id = ?`).run(cotId, b.id);
    registrar({ usuario: null, accion: 'EDITAR', entidad: 'buzon_ofertas', entidadId: b.id, campo: 'estado', valorAnterior: 'Pendiente', valorNuevo: 'Cotizada (respondida desde el correo)' });
    return b.id;
  }
  return null;
}

function aplicarCotizacionSiigo(d, msg, fila) {
  const numeros = new Set([...d.cotizaciones_siigo, ...numerosSiigoEnTexto(`${msg.subject} ${(msg.body && msg.body.content) || ''}`)]);
  const hechas = [];
  for (const n of numeros) {
    const cot = cotizacionPorNumero(n);
    if (!cot) continue;
    marcarEnviada(cot, fila.id, fila.fecha);
    cerrarSolicitudDelHilo(fila.conversacion, cot.id);
    registrar({ usuario: null, accion: 'EDITAR', entidad: 'cotizaciones', entidadId: cot.id, campo: 'fecha_envio', valorNuevo: `Enviada por correo el ${fila.fecha.slice(0, 10)}: ${msg.subject || ''}`.slice(0, 500) });
    hechas.push(cot.numero);
  }
  return hechas.length ? `Enviada: ${hechas.join(', ')}` : 'Cotización de Siigo no encontrada en la plataforma';
}

function aplicarCotizacionPropia(d, msg, fila) {
  const para = (msg.toRecipients || []).map((r) => r.emailAddress && r.emailAddress.address).filter(Boolean);
  const numero = d.referencia ? d.referencia.toUpperCase().slice(0, 60) : null;
  const existente = numero ? cotizacionPorNumero(numero) : null;
  if (existente) {
    marcarEnviada(existente, fila.id, fila.fecha);
    cerrarSolicitudDelHilo(fila.conversacion, existente.id);
    return `Ya existía ${existente.numero}: vinculada al correo`;
  }
  const { vigenteEn: parametrosVigenteEn } = require('../routes/parametros.routes');
  const { vigenteEn: politicaVigenteEn } = require('../routes/politicas.routes');
  const fecha = d.fecha || fila.fecha.slice(0, 10);
  const param = parametrosVigenteEn(fecha);
  const politica = politicaVigenteEn(fecha);
  if (!param || !politica) throw new Error('No hay parámetros o políticas vigentes para ' + fecha);

  let precio = d.valor_con_iva;
  let notaIva = '';
  if (precio == null && d.valor_sin_iva != null) {
    precio = Math.round(d.valor_sin_iva * 1.19 * 100) / 100;
    notaIva = ` [Precio con IVA calculado: el documento trae ${Math.round(d.valor_sin_iva).toLocaleString('es-CO')} sin IVA × 1,19]`;
  }
  const numeroFinal = numero || cotizacionService.generarNumero();
  const cliente = d.empresa || dominio(para[0]) || 'Cliente sin identificar';
  const descripcion = `${d.titulo_proyecto || msg.subject || 'Cotización enviada por correo'}${d.resumen ? ' — ' + d.resumen : ''}${notaIva}`.slice(0, 1000);
  const info = db.prepare(
    `INSERT INTO cotizaciones (numero, cliente, descripcion, fecha_cotizacion, condicion_pago, dias_credito_otorgados,
       precio_venta, pct_anticipo, estado, parametros_id, politica_id, origen, correo_mensaje_id, fecha_envio)
     VALUES (?,?,?,?,'Contado',0,?,0,'Enviada',?,?,'correo',?,?)`
  ).run(numeroFinal, cliente, descripcion, fecha, precio || 0, param.id, politica.id, fila.id, fila.fecha.slice(0, 10));
  const cotId = info.lastInsertRowid;

  // Items: igual que los de Siigo (cruce con el catalogo o "[REVISAR]"), y el
  // costo por la regla del precio (-30%) donde no hay cruce, porque aqui no
  // hay cotizacion de Siigo de donde volver a leer el precio.
  if (d.items.length) {
    const catalogo = siigoSync.catalogoTokenizado();
    const insert = siigoSync.insertLinea();
    d.items.forEach((it, k) => {
      siigoSync.insertarLineaDeItem(insert, cotId, {
        descripcionOriginal: it.descripcion, cantidad: it.cantidad || 1, precioVenta: it.precio_unitario || 0,
        clave: `CORREO|${k + 1}`, match: siigoSync.mejorMatch(it.descripcion, catalogo),
      });
    });
    db.prepare(
      `UPDATE cotizacion_materiales SET costo_unitario = ROUND(precio_venta_siigo * 0.70, 2), costo_origen = 'regla_precio'
       WHERE cotizacion_id = ? AND costo_origen IS NULL AND COALESCE(precio_venta_siigo, 0) > 0`
    ).run(cotId);
    cotizacionService.syncCuentasPorPagar(cotId);
  }
  cerrarSolicitudDelHilo(fila.conversacion, cotId);
  registrar({ usuario: null, accion: 'CREAR', entidad: 'cotizaciones', entidadId: cotId, valorNuevo: `${numeroFinal} registrada desde el correo: ${msg.subject || ''}`.slice(0, 500) });
  return `Cotización ${numeroFinal} registrada (${d.items.length} ítems)`;
}

function aplicarOrdenCompra(d, msg, fila, nombresAdjuntos) {
  const numero = soloNumeroOC(d.numero_oc) || soloNumeroOC((msg.subject || '').match(/(orden\s+de\s+(compra|servicio)|\bo\.?\s?[cs]\.?)\s*(n[o°.]*\s*)?\d{2,10}/i)?.[0]);
  if (!numero) return 'Orden de compra sin número: revisar';
  const repetida = db.prepare('SELECT id FROM ordenes_compra WHERE numero = ? AND COALESCE(cliente, \'\') = COALESCE(?, \'\')').get(numero, d.empresa);
  if (repetida) return `OC ${numero} ya registrada`;
  const refs = [...d.cotizaciones_siigo, d.referencia, ...numerosSiigoEnTexto(`${msg.subject} ${(msg.body && msg.body.content) || ''}`)].filter(Boolean);
  const cot = refs.map(cotizacionPorNumero).find(Boolean) || null;
  const info = db.prepare(
    `INSERT INTO ordenes_compra (mensaje_id, numero, cliente, fecha, valor, descripcion, cotizacion_id, adjunto, referencias)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(fila.id, numero, d.empresa, d.fecha || fila.fecha.slice(0, 10), d.valor_con_iva ?? d.valor_sin_iva,
    (d.titulo_proyecto || d.resumen || msg.subject || '').slice(0, 500), cot ? cot.id : null, nombresAdjuntos.join(', ').slice(0, 300) || null,
    JSON.stringify([...new Set(refs)]));
  if (cot) aprobarPorOC(cot, numero, d.fecha || fila.fecha.slice(0, 10));
  registrar({ usuario: null, accion: 'CREAR', entidad: 'ordenes_compra', entidadId: info.lastInsertRowid, valorNuevo: `OC ${numero}${d.empresa ? ' de ' + d.empresa : ''}${cot ? ' → ' + cot.numero : ''}` });
  asociarOrdenesConFacturas();
  return `OC ${numero} registrada${cot ? ' y asociada a ' + cot.numero : ''}`;
}

function aplicarBuzon(tipoBuzon, d, msg, fila) {
  const previa = buzonDeConversacion(fila.conversacion);
  if (previa) return `Ya estaba en el buzón (#${previa.id}, mismo hilo)`;
  const de = msg.from && msg.from.emailAddress;
  const info = db.prepare(
    `INSERT INTO buzon_ofertas (mensaje_id, tipo, remitente, empresa, asunto, resumen, valor, fecha_recibido, fecha_limite)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(fila.id, tipoBuzon, de ? `${de.name || ''} <${de.address}>`.trim() : null, d.empresa, (msg.subject || '').slice(0, 300),
    d.resumen, tipoBuzon === 'Proveedor' ? (d.valor_sin_iva ?? d.valor_con_iva) : null, fila.fecha.slice(0, 10), d.fecha_limite);
  const id = info.lastInsertRowid;
  if (tipoBuzon === 'Proveedor') {
    const ins = db.prepare('INSERT INTO buzon_items (buzon_id, descripcion, cantidad, unidad, precio_unitario) VALUES (?,?,?,?,?)');
    for (const it of d.items) ins.run(id, it.descripcion, it.cantidad, it.unidad, it.precio_unitario);
  }
  registrar({ usuario: null, accion: 'CREAR', entidad: 'buzon_ofertas', entidadId: id, valorNuevo: `${tipoBuzon}: ${msg.subject || ''}`.slice(0, 500) });
  return `${tipoBuzon} en el buzón (#${id})`;
}

// Decide y ejecuta la accion segun el tipo y la carpeta.
function aplicar(d, msg, fila, nombresAdjuntos) {
  const enviado = fila.carpeta === 'sentitems';
  if (enviado && d.tipo === 'cotizacion_siigo') return aplicarCotizacionSiigo(d, msg, fila);
  if (enviado && d.tipo === 'cotizacion_propia') {
    // Si el documento nombra una cotizacion de Siigo, es esa: no se duplica.
    if (d.cotizaciones_siigo.some(cotizacionPorNumero)) return aplicarCotizacionSiigo(d, msg, fila);
    return aplicarCotizacionPropia(d, msg, fila);
  }
  if (!enviado && d.tipo === 'orden_compra') return aplicarOrdenCompra(d, msg, fila, nombresAdjuntos);
  if (!enviado && d.tipo === 'solicitud_cliente') return aplicarBuzon('Solicitud', d, msg, fila);
  if (!enviado && d.tipo === 'invitacion_licitar') return aplicarBuzon('Licitación', d, msg, fila);
  if (!enviado && d.tipo === 'cotizacion_proveedor') return aplicarBuzon('Proveedor', d, msg, fila);
  return 'Sin acción';
}

// La orden de compra aprueba la cotizacion que nombra (si seguia en Borrador o
// Enviada; una Ejecutada o Cerrada no se toca).
function aprobarPorOC(cot, numeroOC, fecha) {
  if (!['Borrador', 'Enviada'].includes(cot.estado)) return;
  db.prepare(`UPDATE cotizaciones SET estado = 'Aprobada', fecha_aprobacion = COALESCE(fecha_aprobacion, ?), actualizado_en = datetime('now') WHERE id = ?`)
    .run(fecha, cot.id);
  registrar({ usuario: null, accion: 'EDITAR', entidad: 'cotizaciones', entidadId: cot.id, campo: 'estado', valorAnterior: cot.estado, valorNuevo: `Aprobada (orden de compra ${numeroOC} recibida por correo)` });
}

// OC que llegaron antes de que su cotizacion existiera en la plataforma (por
// ejemplo, la cotizacion propia se registro despues): se reintenta el cruce.
function asociarOrdenesConCotizaciones() {
  let n = 0;
  for (const oc of db.prepare('SELECT * FROM ordenes_compra WHERE cotizacion_id IS NULL AND referencias IS NOT NULL').all()) {
    let refs = [];
    try { refs = JSON.parse(oc.referencias) || []; } catch (e) { refs = []; }
    const cot = refs.map(cotizacionPorNumero).find(Boolean);
    if (!cot) continue;
    db.prepare('UPDATE ordenes_compra SET cotizacion_id = ? WHERE id = ?').run(cot.id, oc.id);
    aprobarPorOC(cot, oc.numero, oc.fecha || todayStr());
    registrar({ usuario: null, accion: 'EDITAR', entidad: 'ordenes_compra', entidadId: oc.id, campo: 'cotizacion', valorNuevo: `OC ${oc.numero} → ${cot.numero}` });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- OC <-> facturas

// Facturas cuyo numero de orden (sacado de las observaciones de Siigo, p. ej.
// "OC 2356" u "OS 88 / CONTRATO 12") coincide con el de la OC.
function facturasDeOC(numero) {
  const n = soloNumeroOC(numero);
  if (!n) return [];
  return db.prepare(`SELECT id, numero, fecha, total, saldo, estado, orden FROM facturas WHERE orden IS NOT NULL AND anulada = 0`).all()
    .filter((f) => (String(f.orden).match(/\d{2,10}/g) || []).some((x) => (x.replace(/^0+/, '') || '0') === n));
}

// Llena factura_id de las OC que aun no la tienen (se llama al final de cada
// corrida del correo y despues de sincronizar facturas).
function asociarOrdenesConFacturas() {
  let n = 0;
  for (const oc of db.prepare('SELECT id, numero FROM ordenes_compra WHERE factura_id IS NULL').all()) {
    const fs = facturasDeOC(oc.numero);
    if (fs.length) {
      db.prepare('UPDATE ordenes_compra SET factura_id = ? WHERE id = ?').run(fs[0].id, oc.id);
      registrar({ usuario: null, accion: 'EDITAR', entidad: 'ordenes_compra', entidadId: oc.id, campo: 'factura', valorNuevo: `OC ${oc.numero} facturada en ${fs.map((f) => f.numero).join(', ')}` });
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- orquestador

async function procesarMensaje(buzon, carpeta, m, resumen, { lector, extractor }) {
  if (db.prepare('SELECT 1 FROM correo_mensajes WHERE graph_id = ?').get(m.id)) return;
  let nombres = [];
  if (m.hasAttachments) {
    try { nombres = await lector.nombresAdjuntos(buzon, m.id); } catch (e) { nombres = []; }
  }
  const pf = extraccion.prefiltro(m, nombres);
  if (!pf.pasa) { resumen.descartados++; return; }

  const de = m.from && m.from.emailAddress;
  const fila = {
    fecha: fechaDe(m, carpeta), carpeta, conversacion: m.conversationId || null,
  };
  const info = db.prepare(
    `INSERT INTO correo_mensajes (graph_id, buzon, carpeta, fecha, remitente, destinatarios, asunto, adjuntos, web_link, conversacion)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(m.id, buzon, carpeta, fila.fecha, de ? de.address : null,
    (m.toRecipients || []).map((r) => r.emailAddress && r.emailAddress.address).filter(Boolean).join(', '),
    (m.subject || '').slice(0, 500), nombres.join(', ').slice(0, 500) || null, m.webLink || null, fila.conversacion);
  fila.id = info.lastInsertRowid;
  await clasificarYAplicar(fila, m, buzon, nombres, resumen, { lector, extractor });
}

async function clasificarYAplicar(fila, m, buzon, nombres, resumen, { lector, extractor }) {
  try {
    const adj = nombres.some(extraccion.esDocumento) ? await lector.adjuntos(buzon, m.id) : [];
    const d = await extractor({ mensaje: m, adjuntos: adj, carpeta: fila.carpeta });
    db.exec('BEGIN');
    let accion;
    try {
      accion = aplicar(d, m, fila, nombres);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    db.prepare(`UPDATE correo_mensajes SET tipo = ?, extraido_json = ?, accion = ?, estado = 'procesado', error = NULL WHERE id = ?`)
      .run(d.tipo, JSON.stringify(d), accion, fila.id);
    resumen.procesados++;
    resumen.porTipo[d.tipo] = (resumen.porTipo[d.tipo] || 0) + 1;
    if (accion !== 'Sin acción' && resumen.acciones.length < 30) resumen.acciones.push(`${m.subject || '(sin asunto)'} → ${accion}`);
  } catch (e) {
    db.prepare(`UPDATE correo_mensajes SET estado = 'error', error = ? WHERE id = ?`).run(String(e.message).slice(0, 500), fila.id);
    resumen.errores.push({ asunto: m.subject, error: e.message });
  }
}

// Una corrida completa sobre todos los buzones y carpetas. `lector` y
// `extractor` se pueden reemplazar en pruebas (Graph y la IA simulados).
async function revisarCorreo({ lector = outlook, extractor = extraccion.extraer, alAvanzar = () => {} } = {}) {
  const { buzones } = lector.config ? lector.config() : outlook.config();
  const resumen = { inicio: new Date().toISOString(), leidos: 0, descartados: 0, procesados: 0, porTipo: {}, acciones: [], errores: [] };
  // Las dos carpetas de todos los buzones se procesan JUNTAS, en orden
  // cronologico: asi una orden de compra que llega despues de enviar la
  // cotizacion la encuentra ya registrada.
  const cola = [];
  const marcas = [];
  for (const buzon of buzones) {
    for (const carpeta of CARPETAS) {
      alAvanzar(`Leyendo ${carpeta === 'inbox' ? 'recibidos' : 'enviados'} de ${buzon}`);
      const est = db.prepare('SELECT leido_hasta FROM correo_estado WHERE buzon = ? AND carpeta = ?').get(buzon, carpeta);
      const desde = est ? est.leido_hasta : `${addDays(todayStr(), -DIAS_PRIMERA_LECTURA)}T00:00:00Z`;
      const mensajes = await lector.mensajesDesde(buzon, carpeta, desde);
      let hasta = desde;
      for (const m of mensajes) {
        const f = fechaDe(m, carpeta);
        cola.push({ buzon, carpeta, m, fecha: f });
        if (f > hasta) hasta = f;
      }
      marcas.push([buzon, carpeta, hasta]);
    }
  }
  cola.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  resumen.leidos = cola.length;
  for (const [k, x] of cola.entries()) {
    alAvanzar(`Procesando correo ${k + 1} de ${cola.length}`);
    await procesarMensaje(x.buzon, x.carpeta, x.m, resumen, { lector, extractor });
  }
  for (const [buzon, carpeta, hasta] of marcas) {
    db.prepare(
      `INSERT INTO correo_estado (buzon, carpeta, leido_hasta) VALUES (?,?,?)
       ON CONFLICT(buzon, carpeta) DO UPDATE SET leido_hasta = excluded.leido_hasta`
    ).run(buzon, carpeta, hasta);
  }
  // Reintenta los que fallaron (por ejemplo, la IA no respondio), hasta 3 veces.
  alAvanzar('Reintentando correos con error');
  const conError = db.prepare(
    `SELECT * FROM correo_mensajes WHERE estado = 'error' AND intentos < ? ORDER BY id LIMIT 20`
  ).all(MAX_INTENTOS);
  for (const fila of conError) {
    db.prepare('UPDATE correo_mensajes SET intentos = intentos + 1 WHERE id = ?').run(fila.id);
    try {
      const m = await lector.mensaje(fila.buzon, fila.graph_id);
      const nombres = String(fila.adjuntos || '').split(', ').filter(Boolean);
      await clasificarYAplicar({ id: fila.id, fecha: fila.fecha, carpeta: fila.carpeta, conversacion: fila.conversacion }, m, fila.buzon, nombres, resumen, { lector, extractor });
    } catch (e) {
      db.prepare(`UPDATE correo_mensajes SET error = ? WHERE id = ?`).run(String(e.message).slice(0, 500), fila.id);
    }
  }
  alAvanzar('Asociando órdenes de compra con cotizaciones y facturas');
  resumen.ocConCotizacion = asociarOrdenesConCotizaciones();
  resumen.ocFacturadas = asociarOrdenesConFacturas();
  resumen.fin = new Date().toISOString();
  return resumen;
}

module.exports = {
  revisarCorreo, aplicar, asociarOrdenesConFacturas, asociarOrdenesConCotizaciones, facturasDeOC, soloNumeroOC, numerosSiigoEnTexto,
  configurado: () => outlook.configurado(),
};
