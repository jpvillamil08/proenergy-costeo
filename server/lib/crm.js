'use strict';
// CRM comercial: empresas, contactos, negocios, actividades, alertas y tablero.
//
// La idea central: el CRM NO se llena a mano desde cero. Las empresas salen de
// lo que ya existe (cotizaciones, facturas, ordenes de compra, buzon y ventas
// historicas) y los negocios avanzan solos con las senales reales:
//   cotizacion Borrador/Enviada -> Propuesta enviada
//   cotizacion Aprobada         -> Propuesta aceptada
//   orden de compra vinculada   -> OC recibida
//   cotizacion Ejecutada        -> Actividad ejecutada
//   factura vinculada           -> Cierre ganado (fecha real = la de la factura)
//   todas sus cotizaciones Rechazada -> Cierre perdido
// "Enviar factura" es manual. La sincronizacion SOLO avanza (nunca devuelve lo
// que alguien movio a mano) y no toca negocios ya cerrados.
//
// Reglas de "nunca inventar":
//   - Dos empresas son la misma solo por NIT exacto o por nombre normalizado
//     identico. Los parecidos se listan en duplicados() y decide una persona.
//   - Un negocio automatico no tiene fecha de cierre esperada: queda vacia y la
//     alerta lo dice, en vez de poner una fecha supuesta.
//   - La probabilidad por etapa es un supuesto declarado (ETAPAS), editable en
//     cada negocio, y el pronostico muestra su formula.
//
// La plataforma no envia correos: los recordatorios son alertas dentro de la app.

const db = require('../db');
const { registrar } = require('./audit');
const { todayStr, addDays, diffDays } = require('./dates');
const { tituloDeCotizacion, tituloDeObservaciones } = require('./titulo');

const ETAPAS = [
  { nombre: 'Previsita', probabilidad: 0.10, abierta: true },
  { nombre: 'Propuesta enviada', probabilidad: 0.30, abierta: true },
  { nombre: 'Propuesta aceptada', probabilidad: 0.60, abierta: true },
  { nombre: 'OC recibida', probabilidad: 0.80, abierta: true },
  { nombre: 'Actividad ejecutada', probabilidad: 0.90, abierta: true },
  { nombre: 'Enviar factura', probabilidad: 0.95, abierta: true },
  { nombre: 'Cierre ganado', probabilidad: 1, abierta: false },
  { nombre: 'Cierre perdido', probabilidad: 0, abierta: false },
];
const NOMBRES_ETAPAS = ETAPAS.map((e) => e.nombre);
const ETAPAS_ABIERTAS = ETAPAS.filter((e) => e.abierta).map((e) => e.nombre);
const GANADO = 'Cierre ganado';
const PERDIDO = 'Cierre perdido';

const TIPOS_EMPRESA = ['Prospecto', 'Cliente', 'Inactivo'];
const SECTORES = ['Hotelería', 'Comercio', 'Industria', 'Operador de red', 'Constructora', 'Oficial', 'Residencial', 'Salud', 'Educación', 'Otro'];
const ORIGENES = ['Siigo', 'Correo', 'Manual', 'Importación', 'Referido', 'Licitación', 'Visita', 'Feria o evento', 'Web'];
const ROLES_CONTACTO = ['Decisor', 'Técnico', 'Compras', 'Financiero', 'Otro'];
const TIPOS_ACTIVIDAD = ['Llamada', 'Visita', 'Reunión', 'Correo', 'WhatsApp', 'Tarea', 'Nota'];
const MOTIVOS_PERDIDA = ['Precio', 'Eligió a la competencia', 'Sin presupuesto', 'Proyecto cancelado o aplazado', 'Sin respuesta del cliente', 'Tiempo de entrega', 'Cotización rechazada', 'Otro'];

// Negocios automaticos: desde esta fecha de cotizacion. Las anteriores quedan
// solo en el historial de cada empresa (convertirlas en negocios recrearia
// cientos de negocios viejos sin decision, como paso en HubSpot).
const INICIO_NEGOCIOS_AUTO = '2026-01-01';
const IVA = 1.19;
const DIAS_SIN_ACTIVIDAD = 15;
const DIAS_PROPUESTA_ESTANCADA = 10;
const DIAS_PROPUESTA_VIEJA = 90;
const DIAS_REACTIVAR = 180;
const DIAS_INACTIVO = 365;
const DOMINIOS_GENERICOS = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'outlook.es', 'yahoo.com', 'yahoo.es', 'live.com', 'hotmail.es',
  'icloud.com', 'msn.com', 'proenergyco.com',
]);

// ---------------------------------------------------------------- utilidades

// Hora de Colombia (UTC-5 todo el ano). El contenedor corre en UTC.
function ahoraColombia() {
  const d = new Date(Date.now() - 5 * 3600000);
  return d.toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:MM'
}
function hoyColombia() {
  return ahoraColombia().slice(0, 10);
}

function indiceEtapa(etapa) {
  return NOMBRES_ETAPAS.indexOf(etapa);
}
function probabilidadDe(negocio) {
  if (negocio.probabilidad != null) return Number(negocio.probabilidad);
  const e = ETAPAS.find((x) => x.nombre === negocio.etapa);
  return e ? e.probabilidad : 0;
}

const SUFIJO_COMPUESTO = /^(?:SAS|SA|ESP|LTDA|EU|SCA|SCS|SC|BIC)+$/;
const SUFIJOS = new Set(['SAS', 'SA', 'ESP', 'LTDA', 'LIMITADA', 'LIMITADAD', 'CIA', 'EU', 'BIC', 'SCA', 'SC', 'SCS', 'EN', 'LIQUIDACION', 'ZF', 'ZOMAC']);

// Nombre comparable de una empresa: sin tildes, sin puntuacion y sin la forma
// societaria del final. "RUITOQUE S.A. E.S.P." = "Ruitoque SA ESP" = "RUITOQUE".
function normalizarEmpresa(nombre) {
  const tokens = String(nombre || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/&/g, ' Y ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // Letras sueltas seguidas se juntan: "S A S" -> "SAS", "E S P" -> "ESP".
  const juntos = [];
  for (const t of tokens) {
    const ultimo = juntos[juntos.length - 1];
    if (t.length === 1 && ultimo && ultimo.suelta) {
      ultimo.texto += t;
    } else {
      juntos.push({ texto: t, suelta: t.length === 1 });
    }
  }
  const palabras = juntos.map((j) => j.texto);
  let quitoCia = false;
  while (palabras.length > 1) {
    const ultima = palabras[palabras.length - 1];
    // SUFIJO_COMPUESTO: "S.A. E.S.P." queda como una sola palabra "SAESP" al
    // juntar las letras sueltas.
    if (SUFIJOS.has(ultima) || SUFIJO_COMPUESTO.test(ultima)) { quitoCia = ultima === 'CIA'; palabras.pop(); continue; }
    if (ultima === 'Y' && quitoCia) { palabras.pop(); quitoCia = false; continue; }
    break;
  }
  return palabras.join(' ');
}

// NIT comparable: solo digitos y sin el digito de verificacion ("804.001.062-5"
// -> "804001062"). Los NIT colombianos tienen 9 digitos; una cedula puede tener
// menos, por eso solo se quita el DV cuando viene separado con guion.
function normalizarNit(nit) {
  const t = String(nit || '').trim();
  if (!t) return null;
  const sinDv = t.includes('-') ? t.slice(0, t.lastIndexOf('-')) : t;
  const d = sinDv.replace(/\D/g, '');
  return d.length >= 5 ? d : null;
}

function soloNumero(texto) {
  return /^\s*[\d.\-\s]+\s*$/.test(String(texto || ''));
}

function dominioDe(email) {
  const m = String(email || '').trim().toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
  return m ? m[1] : null;
}

// Valor con y sin IVA de una cotizacion. Lo importado de Siigo y lo registrado
// desde el correo guarda precio_venta CON IVA (ver CLAUDE.md); lo creado en la
// app se costea sin IVA.
function valoresCotizacion(c) {
  const precio = Number(c.precio_venta) || 0;
  if (c.origen === 'siigo' || c.origen === 'correo' || c.siigo_quotation_id) return { con: precio, sin: precio / IVA };
  return { con: precio * IVA, sin: precio };
}

function tituloCotizacion(c) {
  let t = null;
  if (c.siigo_json) {
    try { t = tituloDeCotizacion(JSON.parse(c.siigo_json)); } catch (e) { t = null; }
  }
  return t || tituloDeObservaciones(c.observaciones_siigo) || null;
}

function pesos(v) {
  return '$ ' + Math.round(Number(v) || 0).toLocaleString('es-CO');
}

function recortar(texto, n) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ---------------------------------------------------------------- empresas

function empresaPorAlias(clave) {
  const a = db.prepare('SELECT empresa_id FROM crm_empresa_alias WHERE clave = ?').get(clave);
  return a ? db.prepare('SELECT * FROM crm_empresas WHERE id = ?').get(a.empresa_id) : null;
}

// Empresa existente para un nombre y/o NIT, o null.
function buscarEmpresa({ nombre, nit }) {
  const n = normalizarNit(nit);
  if (n) {
    const e = db.prepare('SELECT * FROM crm_empresas WHERE nit = ? ORDER BY id LIMIT 1').get(n) || empresaPorAlias(`nit:${n}`);
    if (e) return e;
  }
  if (nombre && !soloNumero(nombre)) {
    const norm = normalizarEmpresa(nombre);
    if (norm) {
      const e = db.prepare('SELECT * FROM crm_empresas WHERE nombre_norm = ? ORDER BY id LIMIT 1').get(norm) || empresaPorAlias(`nombre:${norm}`);
      if (e) return e;
    }
  }
  return null;
}

// Busca la empresa y, si no existe, la crea. Si la encontro por nombre y no
// tenia NIT, le completa el NIT. Devuelve null si no hay con que identificarla
// (por ejemplo, una factura vieja guardada solo con un numero y sin NIT).
function empresaPara({ nombre, nit, origen, usuario = null, resumen = null }) {
  const n = normalizarNit(nit);
  const existente = buscarEmpresa({ nombre, nit: n });
  if (existente) {
    if (n && !existente.nit) {
      const otra = db.prepare('SELECT id FROM crm_empresas WHERE nit = ?').get(n);
      if (!otra) db.prepare(`UPDATE crm_empresas SET nit = ?, actualizado_en = datetime('now') WHERE id = ?`).run(n, existente.id);
    }
    return existente;
  }
  if (!nombre || soloNumero(nombre) || /^cliente (sin identificar|de siigo)/i.test(nombre)) return null;
  const norm = normalizarEmpresa(nombre);
  if (!norm) return null;
  const info = db.prepare(
    `INSERT INTO crm_empresas (nombre, nombre_norm, nit, origen, creado_por) VALUES (?,?,?,?,?)`
  ).run(String(nombre).replace(/\s+/g, ' ').trim(), norm, n, origen || 'Manual', usuario ? usuario.id : null);
  if (resumen) resumen.empresasCreadas++;
  return db.prepare('SELECT * FROM crm_empresas WHERE id = ?').get(info.lastInsertRowid);
}

function nitDeCotizacion(c) {
  if (!c.siigo_json) return null;
  try {
    const q = JSON.parse(c.siigo_json);
    return normalizarNit(q && q.customer && q.customer.identification);
  } catch (e) {
    return null;
  }
}

// Cliente / Inactivo / Prospecto segun las facturas (salvo que alguien lo haya
// fijado a mano).
function recalcularTipos() {
  const hoy = todayStr();
  const filas = db.prepare(
    `SELECT e.id, e.tipo,
       (SELECT MAX(f.fecha) FROM facturas f WHERE f.empresa_id = e.id AND f.anulada = 0) AS ultima_factura,
       (SELECT COUNT(*) FROM ventas_historicas_cliente v WHERE v.nit IS NOT NULL AND v.nit = e.nit) AS historicas
     FROM crm_empresas e WHERE e.tipo_manual = 0`
  ).all();
  const upd = db.prepare(`UPDATE crm_empresas SET tipo = ?, actualizado_en = datetime('now') WHERE id = ?`);
  let n = 0;
  for (const e of filas) {
    let tipo = 'Prospecto';
    if (e.ultima_factura) tipo = diffDays(hoy, e.ultima_factura) > DIAS_INACTIVO ? 'Inactivo' : 'Cliente';
    else if (e.historicas) tipo = 'Inactivo';
    if (tipo !== e.tipo) { upd.run(tipo, e.id); n++; }
  }
  return n;
}

// ---------------------------------------------------------------- historial de etapas

function registrarEtapa(negocioId, anterior, nueva, { fecha, usuario = null, automatico = false, detalle = null }) {
  db.prepare(
    `INSERT INTO crm_etapas_historial (negocio_id, etapa_anterior, etapa_nueva, fecha, usuario_id, automatico, detalle)
     VALUES (?,?,?,?,?,?,?)`
  ).run(negocioId, anterior, nueva, fecha || ahoraColombia(), usuario ? usuario.id : null, automatico ? 1 : 0, detalle);
}

// Cambia la etapa de un negocio y deja el historial. Cierre perdido exige
// motivo; al cerrar se fija la fecha real (la de la senal, o hoy).
function cambiarEtapa(negocio, etapa, { usuario = null, automatico = false, fecha = null, motivo = null, detalle = null } = {}) {
  if (!NOMBRES_ETAPAS.includes(etapa)) {
    const err = new Error(`Etapa inválida: ${etapa}`);
    err.status = 400;
    throw err;
  }
  if (etapa === negocio.etapa) return false;
  if (etapa === PERDIDO && !String(motivo || negocio.motivo_perdida || '').trim()) {
    const err = new Error('Para marcar un negocio como perdido indique el motivo.');
    err.status = 400;
    throw err;
  }
  const cuando = fecha || ahoraColombia();
  const cerrada = etapa === GANADO || etapa === PERDIDO;
  db.prepare(
    `UPDATE crm_negocios SET etapa = ?, etapa_desde = ?,
       fecha_cierre_real = CASE WHEN ? THEN ? ELSE NULL END,
       motivo_perdida = CASE WHEN ? THEN ? ELSE motivo_perdida END,
       actualizado_en = datetime('now')
     WHERE id = ?`
  ).run(etapa, cuando, cerrada ? 1 : 0, cuando.slice(0, 10), etapa === PERDIDO ? 1 : 0, motivo || negocio.motivo_perdida || null, negocio.id);
  registrarEtapa(negocio.id, negocio.etapa, etapa, { fecha: cuando, usuario, automatico, detalle });
  registrar({
    usuario, accion: automatico ? 'SINCRONIZAR' : 'EDITAR', entidad: 'crm_negocios', entidadId: negocio.id,
    campo: 'etapa', valorAnterior: negocio.etapa, valorNuevo: detalle ? `${etapa} (${detalle})` : etapa,
  });
  return true;
}

// ---------------------------------------------------------------- sincronizacion

// Etapa que dicen las senales reales de las cotizaciones de un negocio.
function senalesDeNegocio(negocioId) {
  const cots = db.prepare('SELECT * FROM cotizaciones WHERE negocio_id = ?').all(negocioId);
  if (!cots.length) return null;
  let mejor = { idx: -1, fecha: null, detalle: null };
  const subir = (idx, fecha, detalle) => {
    if (idx > mejor.idx) mejor = { idx, fecha, detalle };
  };
  let rechazadas = 0;
  for (const c of cots) {
    const facturas = db.prepare(
      `SELECT numero, fecha FROM facturas WHERE anulada = 0 AND (cotizacion_id = ?
         OR id IN (SELECT factura_id FROM ordenes_compra WHERE cotizacion_id = ? AND factura_id IS NOT NULL))
       ORDER BY fecha LIMIT 1`
    ).get(c.id, c.id);
    if (facturas) { subir(indiceEtapa(GANADO), facturas.fecha, `factura ${facturas.numero} de ${c.numero}`); continue; }
    if (c.estado === 'Rechazada') { rechazadas++; continue; }
    if (c.estado === 'Ejecutada' || c.estado === 'Cerrada') subir(indiceEtapa('Actividad ejecutada'), null, `${c.numero} ${c.estado.toLowerCase()}`);
    const oc = db.prepare('SELECT numero, fecha FROM ordenes_compra WHERE cotizacion_id = ? ORDER BY fecha LIMIT 1').get(c.id);
    if (oc) subir(indiceEtapa('OC recibida'), oc.fecha, `OC ${oc.numero} de ${c.numero}`);
    if (['Aprobada', 'Ejecutada', 'Cerrada'].includes(c.estado)) subir(indiceEtapa('Propuesta aceptada'), c.fecha_aprobacion, `${c.numero} aprobada`);
    subir(indiceEtapa('Propuesta enviada'), c.fecha_envio || c.fecha_cotizacion, `${c.numero} enviada`);
  }
  if (mejor.idx < 0 && rechazadas === cots.length) {
    return { etapa: PERDIDO, fecha: null, detalle: 'todas sus cotizaciones fueron rechazadas', motivo: 'Cotización rechazada' };
  }
  return mejor.idx < 0 ? null : { etapa: NOMBRES_ETAPAS[mejor.idx], fecha: mejor.fecha, detalle: mejor.detalle };
}

// Fecha de una senal para el historial: la del documento si se conoce y no es
// futura; si no, ahora.
function fechaSenal(fecha) {
  if (!fecha) return ahoraColombia();
  const f = String(fecha).slice(0, 10);
  return f > hoyColombia() ? ahoraColombia() : `${f}T00:00`;
}

function avanzarNegocio(negocio, resumen) {
  if (!ETAPAS_ABIERTAS.includes(negocio.etapa)) return false;
  const s = senalesDeNegocio(negocio.id);
  if (!s) return false;
  if (s.etapa === PERDIDO) {
    cambiarEtapa(negocio, PERDIDO, { automatico: true, motivo: s.motivo, detalle: s.detalle });
    resumen.negociosAvanzados++;
    return true;
  }
  if (indiceEtapa(s.etapa) <= indiceEtapa(negocio.etapa)) return false;
  cambiarEtapa(negocio, s.etapa, { automatico: true, fecha: fechaSenal(s.fecha), detalle: s.detalle });
  resumen.negociosAvanzados++;
  return true;
}

function crearNegocio({ empresaId, nombre, etapa = 'Previsita', fechaInicio, origen, auto = false, usuario = null, ...resto }) {
  const inicio = fechaInicio || hoyColombia();
  const info = db.prepare(
    `INSERT INTO crm_negocios (empresa_id, contacto_id, nombre, etapa, etapa_desde, fecha_inicio, valor_estimado, probabilidad,
       fecha_cierre_esperada, origen, responsable_id, buzon_oferta_id, descripcion, auto, creado_por)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    empresaId, resto.contacto_id || null, nombre, etapa, `${inicio}T00:00`, inicio,
    resto.valor_estimado ?? null, resto.probabilidad ?? null, resto.fecha_cierre_esperada || null,
    origen || null, resto.responsable_id || null, resto.buzon_oferta_id || null, resto.descripcion || null,
    auto ? 1 : 0, usuario ? usuario.id : null
  );
  const id = info.lastInsertRowid;
  registrarEtapa(id, null, etapa, { fecha: `${inicio}T00:00`, usuario, automatico: auto });
  registrar({ usuario, accion: auto ? 'SINCRONIZAR' : 'CREAR', entidad: 'crm_negocios', entidadId: id, valorNuevo: `${nombre} (${etapa})` });
  return db.prepare('SELECT * FROM crm_negocios WHERE id = ?').get(id);
}

// Enlaza correos de Outlook con contactos (email exacto) o empresas (dominio).
function vincularCorreos(resumen) {
  const contactos = db.prepare(`SELECT id, empresa_id, lower(email) AS email FROM crm_contactos WHERE email IS NOT NULL AND email <> '' AND activo = 1`).all();
  const porEmail = new Map(contactos.map((c) => [c.email.trim(), c]));
  const porDominio = new Map(
    db.prepare(`SELECT id, lower(dominio_correo) AS d FROM crm_empresas WHERE dominio_correo IS NOT NULL AND dominio_correo <> ''`).all()
      .map((e) => [e.d.trim(), e.id])
  );
  const pendientes = db.prepare(`SELECT id, remitente, destinatarios FROM correo_mensajes WHERE empresa_id IS NULL`).all();
  const upd = db.prepare('UPDATE correo_mensajes SET empresa_id = ?, contacto_id = ? WHERE id = ?');
  for (const m of pendientes) {
    const direcciones = [m.remitente, ...String(m.destinatarios || '').split(',')]
      .map((d) => String(d || '').trim().toLowerCase()).filter(Boolean);
    let hecho = false;
    for (const d of direcciones) {
      const c = porEmail.get(d);
      if (c) { upd.run(c.empresa_id, c.id, m.id); hecho = true; break; }
    }
    if (hecho) { resumen.correosVinculados++; continue; }
    for (const d of direcciones) {
      const dom = dominioDe(d);
      if (dom && !DOMINIOS_GENERICOS.has(dom) && porDominio.has(dom)) { upd.run(porDominio.get(dom), null, m.id); hecho = true; break; }
    }
    if (hecho) resumen.correosVinculados++;
  }
  // Correos que ya generaron algo en la plataforma heredan la empresa de eso.
  const heredados = db.prepare(
    `UPDATE correo_mensajes SET empresa_id = COALESCE(
        (SELECT empresa_id FROM cotizaciones WHERE correo_mensaje_id = correo_mensajes.id AND empresa_id IS NOT NULL LIMIT 1),
        (SELECT empresa_id FROM ordenes_compra WHERE mensaje_id = correo_mensajes.id AND empresa_id IS NOT NULL LIMIT 1),
        (SELECT empresa_id FROM buzon_ofertas WHERE mensaje_id = correo_mensajes.id AND empresa_id IS NOT NULL LIMIT 1))
     WHERE empresa_id IS NULL`
  ).run();
  resumen.correosVinculados += Number(heredados.changes) || 0;
}

// Dominio de correo de la empresa a partir de sus contactos, cuando todos los
// correos corporativos de sus contactos comparten el mismo dominio.
function completarDominios() {
  const filas = db.prepare(
    `SELECT e.id, GROUP_CONCAT(lower(c.email), ' ') AS emails FROM crm_empresas e
     JOIN crm_contactos c ON c.empresa_id = e.id AND c.email IS NOT NULL AND c.email <> ''
     WHERE e.dominio_correo IS NULL OR e.dominio_correo = '' GROUP BY e.id`
  ).all();
  for (const f of filas) {
    const dominios = [...new Set(String(f.emails).split(' ').map(dominioDe).filter((d) => d && !DOMINIOS_GENERICOS.has(d)))];
    if (dominios.length === 1) db.prepare('UPDATE crm_empresas SET dominio_correo = ? WHERE id = ?').run(dominios[0], f.id);
  }
}

// Una corrida completa. Idempotente: correrla dos veces seguidas no cambia nada
// la segunda vez.
function sincronizarCrm() {
  const inicio = Date.now();
  const resumen = {
    empresasCreadas: 0, documentosVinculados: 0, negociosCreados: 0, negociosAvanzados: 0,
    tiposActualizados: 0, correosVinculados: 0,
  };
  db.exec('BEGIN');
  try {
    // 1. Empresas y vinculos. Primero lo que trae NIT, para que el NIT quede
    //    en la empresa antes de cruzar lo que solo trae nombre.
    const vhist = db.prepare(
      `SELECT nit, cliente FROM ventas_historicas_cliente WHERE cliente IS NOT NULL AND trim(cliente) <> '' GROUP BY nit, cliente`
    ).all();
    for (const v of vhist) empresaPara({ nombre: v.cliente, nit: v.nit, origen: 'Siigo', resumen });

    for (const c of db.prepare('SELECT * FROM cotizaciones WHERE empresa_id IS NULL').all()) {
      const nit = nitDeCotizacion(c);
      const e = empresaPara({ nombre: c.cliente, nit, origen: c.origen === 'correo' ? 'Correo' : 'Siigo', resumen });
      if (e) {
        db.prepare('UPDATE cotizaciones SET empresa_id = ?, nit = COALESCE(nit, ?) WHERE id = ?').run(e.id, nit, c.id);
        resumen.documentosVinculados++;
      }
    }
    for (const f of db.prepare('SELECT id, cliente, nit FROM facturas WHERE empresa_id IS NULL').all()) {
      const e = empresaPara({ nombre: f.cliente, nit: f.nit, origen: 'Siigo', resumen });
      if (e) { db.prepare('UPDATE facturas SET empresa_id = ? WHERE id = ?').run(e.id, f.id); resumen.documentosVinculados++; }
    }
    for (const o of db.prepare('SELECT o.id, o.cliente, c.empresa_id AS cot_empresa FROM ordenes_compra o LEFT JOIN cotizaciones c ON c.id = o.cotizacion_id WHERE o.empresa_id IS NULL').all()) {
      const id = o.cot_empresa || (empresaPara({ nombre: o.cliente, origen: 'Correo', resumen }) || {}).id;
      if (id) { db.prepare('UPDATE ordenes_compra SET empresa_id = ? WHERE id = ?').run(id, o.id); resumen.documentosVinculados++; }
    }
    for (const b of db.prepare(`SELECT id, empresa FROM buzon_ofertas WHERE empresa_id IS NULL AND tipo IN ('Solicitud','Licitación')`).all()) {
      const e = empresaPara({ nombre: b.empresa, origen: 'Correo', resumen });
      if (e) { db.prepare('UPDATE buzon_ofertas SET empresa_id = ? WHERE id = ?').run(e.id, b.id); resumen.documentosVinculados++; }
    }

    // 2. Negocios de las solicitudes y licitaciones del buzon.
    const ofertas = db.prepare(
      `SELECT b.* FROM buzon_ofertas b WHERE b.empresa_id IS NOT NULL AND b.tipo IN ('Solicitud','Licitación')
         AND b.estado <> 'Descartada' AND COALESCE(b.fecha_recibido, b.creado_en) >= ?
         AND NOT EXISTS (SELECT 1 FROM crm_negocios n WHERE n.buzon_oferta_id = b.id)`
    ).all(INICIO_NEGOCIOS_AUTO);
    for (const b of ofertas) {
      crearNegocio({
        empresaId: b.empresa_id, nombre: recortar(`${b.tipo === 'Licitación' ? 'Licitación' : 'Solicitud'}: ${b.asunto || b.resumen || 'sin asunto'}`, 120),
        etapa: 'Previsita', fechaInicio: String(b.fecha_recibido || b.creado_en).slice(0, 10), origen: b.tipo === 'Licitación' ? 'Licitación' : 'Correo',
        auto: true, buzon_oferta_id: b.id, descripcion: b.resumen, fecha_cierre_esperada: null,
      });
      resumen.negociosCreados++;
    }
    // La cotizacion con que se respondio una solicitud entra a su negocio.
    const respuestas = db.prepare(
      `SELECT n.id AS negocio_id, b.cotizacion_id FROM crm_negocios n JOIN buzon_ofertas b ON b.id = n.buzon_oferta_id
       JOIN cotizaciones c ON c.id = b.cotizacion_id WHERE c.negocio_id IS NULL`
    ).all();
    for (const r of respuestas) db.prepare('UPDATE cotizaciones SET negocio_id = ? WHERE id = ?').run(r.negocio_id, r.cotizacion_id);
    // Solicitud descartada en el buzon y sin cotizaciones: negocio perdido.
    const descartadas = db.prepare(
      `SELECT n.* FROM crm_negocios n JOIN buzon_ofertas b ON b.id = n.buzon_oferta_id
       WHERE b.estado = 'Descartada' AND n.etapa = 'Previsita' AND NOT EXISTS (SELECT 1 FROM cotizaciones c WHERE c.negocio_id = n.id)`
    ).all();
    for (const n of descartadas) {
      cambiarEtapa(n, PERDIDO, { automatico: true, motivo: 'Otro', detalle: 'descartada en el buzón' });
      resumen.negociosAvanzados++;
    }

    // 3. Un negocio por cotizacion (desde INICIO_NEGOCIOS_AUTO).
    const sinNegocio = db.prepare(
      `SELECT * FROM cotizaciones WHERE negocio_id IS NULL AND empresa_id IS NOT NULL AND fecha_cotizacion >= ? ORDER BY fecha_cotizacion, id`
    ).all(INICIO_NEGOCIOS_AUTO);
    for (const c of sinNegocio) {
      const titulo = tituloCotizacion(c) || (/^Importada desde Siigo/i.test(c.descripcion || '') ? '' : recortar(c.descripcion, 70));
      const n = crearNegocio({
        empresaId: c.empresa_id, nombre: recortar(`${c.numero}${titulo ? ' · ' + titulo : ''}`, 120),
        etapa: 'Propuesta enviada', fechaInicio: c.fecha_cotizacion, origen: c.origen === 'correo' ? 'Correo' : 'Siigo', auto: true,
      });
      db.prepare('UPDATE cotizaciones SET negocio_id = ? WHERE id = ?').run(n.id, c.id);
      resumen.negociosCreados++;
    }

    // 4. Avance automatico de todos los negocios abiertos.
    const abiertos = db.prepare(`SELECT * FROM crm_negocios WHERE etapa IN (${ETAPAS_ABIERTAS.map(() => '?').join(',')})`).all(...ETAPAS_ABIERTAS);
    for (const n of abiertos) avanzarNegocio(n, resumen);

    // 5. Tipo de empresa, dominios y correos.
    resumen.tiposActualizados = recalcularTipos();
    completarDominios();
    vincularCorreos(resumen);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  resumen.duracionMs = Date.now() - inicio;
  const algo = resumen.empresasCreadas || resumen.negociosCreados || resumen.negociosAvanzados;
  if (algo) {
    registrar({
      usuario: null, accion: 'SINCRONIZAR', entidad: 'crm', entidadId: null,
      valorNuevo: `CRM: ${resumen.empresasCreadas} empresa(s) nueva(s), ${resumen.negociosCreados} negocio(s) nuevo(s), ${resumen.negociosAvanzados} cambio(s) de etapa, ${resumen.documentosVinculados} documento(s) vinculados.`,
    });
  }
  return resumen;
}

// ---------------------------------------------------------------- consultas de negocios

const SQL_NEGOCIO = `
  SELECT n.*, e.nombre AS empresa_nombre, e.sector AS empresa_sector, e.tipo AS empresa_tipo,
    ct.nombre AS contacto_nombre, u.nombre AS responsable_nombre,
    (SELECT COUNT(*) FROM cotizaciones c WHERE c.negocio_id = n.id) AS n_cotizaciones,
    NULLIF(MAX(
      COALESCE((SELECT MAX(substr(COALESCE(a.completada_en, a.creado_en), 1, 10)) FROM crm_actividades a WHERE a.negocio_id = n.id), ''),
      COALESCE((SELECT MAX(substr(h.fecha, 1, 10)) FROM crm_etapas_historial h WHERE h.negocio_id = n.id AND h.automatico = 0), '')
    ), '') AS ultima_actividad
  FROM crm_negocios n
  JOIN crm_empresas e ON e.id = n.empresa_id
  LEFT JOIN crm_contactos ct ON ct.id = n.contacto_id
  LEFT JOIN usuarios u ON u.id = n.responsable_id`;

// Completa un negocio con sus valores (de sus cotizaciones o del estimado) y
// los dias en la etapa.
function enriquecerNegocio(n) {
  const cots = db.prepare('SELECT id, numero, estado, precio_venta, origen, siigo_quotation_id, fecha_cotizacion FROM cotizaciones WHERE negocio_id = ?').all(n.id);
  let con = 0;
  let sin = 0;
  const vigentes = cots.filter((c) => c.estado !== 'Rechazada');
  for (const c of (vigentes.length ? vigentes : cots)) {
    const v = valoresCotizacion(c);
    con += v.con;
    sin += v.sin;
  }
  if (!cots.length && n.valor_estimado != null) {
    sin = Number(n.valor_estimado) || 0;
    con = sin * IVA;
  }
  const prob = probabilidadDe(n);
  const hoy = hoyColombia();
  // Movimiento = actividad registrada, cambio de etapa (manual o por una senal
  // real como una OC o una factura) o el inicio del negocio. creado_en no sirve:
  // en los negocios automaticos es la fecha en que corrio la sincronizacion.
  const ultima = [n.ultima_actividad, n.etapa_desde, n.fecha_inicio].filter(Boolean).map((x) => String(x).slice(0, 10)).sort().pop();
  return {
    ...n,
    valor_con_iva: con, valor_sin_iva: sin, valor_desde_cotizaciones: cots.length > 0,
    probabilidad_efectiva: prob, valor_ponderado: sin * prob,
    // Max 0: hay cotizaciones con fecha futura en Siigo (p. ej. 2027 por error de digitacion).
    dias_en_etapa: n.etapa_desde ? Math.max(0, diffDays(hoy, String(n.etapa_desde).slice(0, 10))) : null,
    dias_sin_actividad: ultima ? Math.max(0, diffDays(hoy, ultima)) : null,
    cierre_vencido: Boolean(ETAPAS_ABIERTAS.includes(n.etapa) && n.fecha_cierre_esperada && n.fecha_cierre_esperada < hoy),
    abierto: ETAPAS_ABIERTAS.includes(n.etapa),
    cotizaciones: cots.map((c) => ({ id: c.id, numero: c.numero, estado: c.estado, fecha_cotizacion: c.fecha_cotizacion, ...valoresCotizacion(c) })),
  };
}

function listarNegocios({ empresaId, cotizacionId, etapa, responsableId, texto, abiertos } = {}) {
  const w = [];
  const a = [];
  if (empresaId) { w.push('n.empresa_id = ?'); a.push(empresaId); }
  if (cotizacionId) { w.push('n.id = (SELECT negocio_id FROM cotizaciones WHERE id = ?)'); a.push(cotizacionId); }
  if (etapa) { w.push('n.etapa = ?'); a.push(etapa); }
  if (responsableId) { w.push('n.responsable_id = ?'); a.push(responsableId); }
  if (abiertos) { w.push(`n.etapa IN (${ETAPAS_ABIERTAS.map(() => '?').join(',')})`); a.push(...ETAPAS_ABIERTAS); }
  if (texto) {
    w.push(`(n.nombre LIKE ? OR e.nombre LIKE ? OR EXISTS (SELECT 1 FROM cotizaciones c WHERE c.negocio_id = n.id AND c.numero LIKE ?))`);
    a.push(`%${texto}%`, `%${texto}%`, `%${texto}%`);
  }
  const filas = db.prepare(`${SQL_NEGOCIO} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY n.fecha_inicio DESC, n.id DESC`).all(...a);
  return filas.map(enriquecerNegocio);
}

function getNegocio(id) {
  const n = db.prepare(`${SQL_NEGOCIO} WHERE n.id = ?`).get(id);
  if (!n) return null;
  const neg = enriquecerNegocio(n);
  neg.historial = db.prepare(
    `SELECT h.*, u.nombre AS usuario_nombre FROM crm_etapas_historial h LEFT JOIN usuarios u ON u.id = h.usuario_id
     WHERE h.negocio_id = ? ORDER BY h.fecha, h.id`
  ).all(id);
  neg.actividades = listarActividades({ negocioId: id });
  neg.posibles_facturas = neg.abierto && neg.cotizaciones.length ? posiblesFacturas({ cotizacionIds: neg.cotizaciones.map((c) => c.id) }) : [];
  neg.buzon = n.buzon_oferta_id ? db.prepare('SELECT b.*, m.web_link FROM buzon_ofertas b LEFT JOIN correo_mensajes m ON m.id = b.mensaje_id WHERE b.id = ?').get(n.buzon_oferta_id) : null;
  return neg;
}

// ---------------------------------------------------------------- actividades

function listarActividades({ empresaId, negocioId, contactoId, desde, hasta, pendientes, responsableId, limite } = {}) {
  const w = [];
  const a = [];
  if (empresaId) { w.push('a.empresa_id = ?'); a.push(empresaId); }
  if (negocioId) { w.push('a.negocio_id = ?'); a.push(negocioId); }
  if (contactoId) { w.push('a.contacto_id = ?'); a.push(contactoId); }
  if (desde) { w.push('a.fecha_programada >= ?'); a.push(desde); }
  if (hasta) { w.push('a.fecha_programada <= ?'); a.push(`${hasta}T23:59`); }
  if (pendientes) w.push(`a.completada = 0 AND a.tipo <> 'Nota'`);
  if (responsableId) { w.push('a.responsable_id = ?'); a.push(responsableId); }
  const ahora = ahoraColombia();
  return db.prepare(
    `SELECT a.*, e.nombre AS empresa_nombre, c.nombre AS contacto_nombre, n.nombre AS negocio_nombre, u.nombre AS responsable_nombre
     FROM crm_actividades a
     LEFT JOIN crm_empresas e ON e.id = a.empresa_id
     LEFT JOIN crm_contactos c ON c.id = a.contacto_id
     LEFT JOIN crm_negocios n ON n.id = a.negocio_id
     LEFT JOIN usuarios u ON u.id = a.responsable_id
     ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
     ORDER BY COALESCE(a.fecha_programada, a.creado_en) DESC, a.id DESC
     ${limite ? 'LIMIT ' + Number(limite) : ''}`
  ).all(...a).map((x) => ({
    ...x,
    vencida: Boolean(!x.completada && x.tipo !== 'Nota' && x.fecha_programada && x.fecha_programada < ahora),
  }));
}

// ---------------------------------------------------------------- empresas: listado y ficha 360

function listarEmpresas({ texto, tipo, sector, ciudad, responsableId, sinActividadDias } = {}) {
  const w = ['e.activo = 1'];
  const a = [];
  if (texto) { w.push('(e.nombre LIKE ? OR e.nit LIKE ? OR e.ciudad LIKE ?)'); a.push(`%${texto}%`, `%${texto}%`, `%${texto}%`); }
  if (tipo) { w.push('e.tipo = ?'); a.push(tipo); }
  if (sector) { w.push('e.sector = ?'); a.push(sector); }
  if (ciudad) { w.push('e.ciudad LIKE ?'); a.push(`%${ciudad}%`); }
  if (responsableId) { w.push('e.responsable_id = ?'); a.push(responsableId); }
  const hace12 = addDays(todayStr(), -365);
  const filas = db.prepare(
    `SELECT e.*, u.nombre AS responsable_nombre,
       (SELECT COUNT(*) FROM crm_contactos c WHERE c.empresa_id = e.id AND c.activo = 1) AS n_contactos,
       (SELECT COUNT(*) FROM crm_negocios n WHERE n.empresa_id = e.id AND n.etapa IN (${ETAPAS_ABIERTAS.map(() => '?').join(',')})) AS negocios_abiertos,
       (SELECT COUNT(*) FROM cotizaciones c WHERE c.empresa_id = e.id) AS n_cotizaciones,
       (SELECT COALESCE(SUM(f.total), 0) FROM facturas f WHERE f.empresa_id = e.id AND f.anulada = 0 AND f.fecha >= ?) AS facturado_12m,
       (SELECT COALESCE(SUM(f.saldo), 0) FROM facturas f WHERE f.empresa_id = e.id AND f.anulada = 0) AS cartera,
       (SELECT MAX(f.fecha) FROM facturas f WHERE f.empresa_id = e.id AND f.anulada = 0) AS ultima_factura,
       (SELECT MAX(COALESCE(x.completada_en, x.fecha_programada, x.creado_en)) FROM crm_actividades x WHERE x.empresa_id = e.id AND (x.completada = 1 OR x.tipo = 'Nota')) AS ultimo_contacto
     FROM crm_empresas e LEFT JOIN usuarios u ON u.id = e.responsable_id
     WHERE ${w.join(' AND ')}
     ORDER BY facturado_12m DESC, e.nombre`
  ).all(...ETAPAS_ABIERTAS, hace12, ...a);
  const hoy = hoyColombia();
  return filas
    .map((e) => ({ ...e, dias_sin_contacto: e.ultimo_contacto ? diffDays(hoy, String(e.ultimo_contacto).slice(0, 10)) : null }))
    .filter((e) => !sinActividadDias || e.dias_sin_contacto === null || e.dias_sin_contacto > Number(sinActividadDias));
}

function ficha360(empresaId) {
  const empresa = db.prepare('SELECT e.*, u.nombre AS responsable_nombre FROM crm_empresas e LEFT JOIN usuarios u ON u.id = e.responsable_id WHERE e.id = ?').get(empresaId);
  if (!empresa) return null;
  // Se pide aqui para evitar un require circular con cotizacion-service.
  const svc = require('./cotizacion-service');
  const contactos = db.prepare('SELECT * FROM crm_contactos WHERE empresa_id = ? AND activo = 1 ORDER BY es_principal DESC, nombre').all(empresaId);
  const negocios = listarNegocios({ empresaId });
  const actividades = listarActividades({ empresaId });
  const cotizaciones = db.prepare('SELECT id FROM cotizaciones WHERE empresa_id = ? ORDER BY fecha_cotizacion DESC, id DESC').all(empresaId)
    .map(({ id }) => svc.getCotizacionFull(id)).filter(Boolean)
    .map(({ cot, calculo }) => ({
      id: cot.id, numero: cot.numero, fecha_cotizacion: cot.fecha_cotizacion, titulo: cot.titulo, descripcion: cot.descripcion,
      estado: cot.estado, precio_venta: cot.precio_venta, negocio_id: cot.negocio_id, ...valoresCotizacion(cot),
      semaforo: calculo.semaforo.estado, estadoPago: calculo.cartera.estadoPago,
    }));
  const facturas = db.prepare(
    `SELECT f.id, f.numero, f.fecha, f.vencimiento, f.total, f.saldo, f.estado, f.anulada, f.titulo, f.orden, f.cotizacion_id, c.numero AS cotizacion_numero
     FROM facturas f LEFT JOIN cotizaciones c ON c.id = f.cotizacion_id WHERE f.empresa_id = ? ORDER BY f.fecha DESC`
  ).all(empresaId);
  const ordenes = db.prepare(
    `SELECT o.*, c.numero AS cotizacion_numero, m.web_link FROM ordenes_compra o
     LEFT JOIN cotizaciones c ON c.id = o.cotizacion_id LEFT JOIN correo_mensajes m ON m.id = o.mensaje_id
     WHERE o.empresa_id = ? ORDER BY o.fecha DESC`
  ).all(empresaId);
  const buzon = db.prepare(
    `SELECT b.*, m.web_link FROM buzon_ofertas b LEFT JOIN correo_mensajes m ON m.id = b.mensaje_id WHERE b.empresa_id = ? ORDER BY b.fecha_recibido DESC`
  ).all(empresaId);
  const correos = db.prepare(
    `SELECT m.id, m.fecha, m.carpeta, m.remitente, m.destinatarios, m.asunto, m.adjuntos, m.tipo, m.accion, m.web_link, c.nombre AS contacto_nombre
     FROM correo_mensajes m LEFT JOIN crm_contactos c ON c.id = m.contacto_id WHERE m.empresa_id = ? ORDER BY m.fecha DESC LIMIT 200`
  ).all(empresaId);

  const vigentes = facturas.filter((f) => !f.anulada);
  const facturado = vigentes.reduce((s, f) => s + (Number(f.total) || 0), 0);
  const cerrados = negocios.filter((n) => !n.abierto);
  const ganados = cerrados.filter((n) => n.etapa === GANADO).length;
  const hace12 = addDays(todayStr(), -365);
  const contactosHechos = actividades.filter((x) => x.completada || x.tipo === 'Nota')
    .map((x) => String(x.completada_en || x.fecha_programada || x.creado_en));
  const ultimoCorreo = correos[0] ? String(correos[0].fecha || '') : null;
  const kpis = {
    cotizado_con_iva: cotizaciones.reduce((s, c) => s + c.con, 0),
    n_cotizaciones: cotizaciones.length,
    facturado: facturado,
    facturado_12m: vigentes.filter((f) => f.fecha >= hace12).reduce((s, f) => s + (Number(f.total) || 0), 0),
    n_facturas: vigentes.length,
    ticket_promedio: vigentes.length ? facturado / vigentes.length : null,
    cartera: vigentes.reduce((s, f) => s + (Number(f.saldo) || 0), 0),
    cartera_vencida: vigentes.filter((f) => f.saldo > 0.5 && f.vencimiento && f.vencimiento < todayStr()).reduce((s, f) => s + f.saldo, 0),
    pipeline_sin_iva: negocios.filter((n) => n.abierto).reduce((s, n) => s + n.valor_sin_iva, 0),
    negocios_abiertos: negocios.filter((n) => n.abierto).length,
    tasa_cierre: cerrados.length ? ganados / cerrados.length : null,
    ganados, perdidos: cerrados.length - ganados,
    primera_factura: vigentes.length ? vigentes[vigentes.length - 1].fecha : null,
    ultima_factura: vigentes.length ? vigentes[0].fecha : null,
    ultimo_contacto: [...contactosHechos, ultimoCorreo].filter(Boolean).sort().pop() || null,
  };

  const linea = [];
  for (const x of actividades) {
    linea.push({
      fecha: x.completada_en || x.fecha_programada || x.creado_en, clase: 'actividad', tipo: x.tipo,
      titulo: `${x.tipo}: ${x.asunto}`, detalle: [x.resultado, x.descripcion].filter(Boolean).join(' — '),
      estado: x.tipo === 'Nota' ? null : x.completada ? 'Completada' : x.vencida ? 'Vencida' : 'Programada', actividad_id: x.id,
    });
  }
  for (const n of negocios) {
    for (const h of db.prepare('SELECT * FROM crm_etapas_historial WHERE negocio_id = ? ORDER BY fecha').all(n.id)) {
      linea.push({
        fecha: h.fecha, clase: 'etapa', titulo: h.etapa_anterior ? `${n.nombre}: ${h.etapa_anterior} → ${h.etapa_nueva}` : `Negocio creado: ${n.nombre}`,
        detalle: [h.detalle, h.automatico ? 'automático' : null].filter(Boolean).join(' · '), enlace: `#/crm/negocios/${n.id}`,
      });
    }
  }
  for (const c of cotizaciones) linea.push({ fecha: c.fecha_cotizacion, clase: 'cotizacion', titulo: `Cotización ${c.numero} (${c.estado})`, detalle: c.titulo || recortar(c.descripcion, 120), valor: c.con, enlace: `#/cotizaciones/${c.id}` });
  for (const f of facturas) linea.push({ fecha: f.fecha, clase: 'factura', titulo: `Factura ${f.numero}${f.anulada ? ' (anulada)' : ''}`, detalle: [f.titulo, f.orden].filter(Boolean).join(' · '), valor: f.total });
  for (const o of ordenes) linea.push({ fecha: o.fecha, clase: 'oc', titulo: `Orden de compra ${o.numero}`, detalle: o.descripcion, valor: o.valor, web_link: o.web_link });
  for (const b of buzon) linea.push({ fecha: b.fecha_recibido, clase: 'buzon', titulo: `${b.tipo}: ${b.asunto || ''}`, detalle: b.resumen, estado: b.estado, web_link: b.web_link });
  for (const m of correos) linea.push({ fecha: m.fecha, clase: 'correo', titulo: `${m.carpeta === 'sentitems' ? 'Correo enviado' : 'Correo recibido'}: ${m.asunto || '(sin asunto)'}`, detalle: m.accion, web_link: m.web_link });
  linea.sort((x, y) => String(y.fecha || '').localeCompare(String(x.fecha || '')));

  return { empresa, contactos, negocios, actividades, cotizaciones, facturas, ordenes, buzon, correos, kpis, linea: linea.slice(0, 400) };
}

// ---------------------------------------------------------------- duplicados y fusion

function tokens(norm) {
  return new Set(String(norm).split(' ').filter((t) => t.length > 2));
}

// Pares de empresas que podrian ser la misma. Solo se sugieren: nunca se fusionan solas.
function duplicados() {
  const empresas = db.prepare('SELECT id, nombre, nombre_norm, nit, tipo, ciudad FROM crm_empresas WHERE activo = 1').all();
  const pares = [];
  for (let i = 0; i < empresas.length; i++) {
    const a = empresas[i];
    const ta = tokens(a.nombre_norm);
    for (let j = i + 1; j < empresas.length; j++) {
      const b = empresas[j];
      let motivo = null;
      if (a.nit && b.nit && a.nit === b.nit) motivo = 'Mismo NIT';
      else {
        const tb = tokens(b.nombre_norm);
        const inter = [...ta].filter((t) => tb.has(t)).length;
        const union = new Set([...ta, ...tb]).size;
        const contiene = a.nombre_norm.length >= 6 && b.nombre_norm.length >= 6 &&
          (a.nombre_norm.includes(b.nombre_norm) || b.nombre_norm.includes(a.nombre_norm));
        if (contiene) motivo = 'Un nombre contiene al otro';
        else if (union && inter / union >= 0.6 && inter >= 2) motivo = 'Nombres muy parecidos';
        if (motivo && a.nit && b.nit && a.nit !== b.nit) motivo = null; // NIT distintos: son empresas distintas
      }
      if (motivo) pares.push({ motivo, a, b });
    }
  }
  return pares;
}

// Fusiona `origenId` dentro de `destinoId`: mueve todos los vinculos, completa
// los datos que le falten al destino y guarda el nombre y NIT del origen como
// alias para que la sincronizacion no la vuelva a crear.
function fusionar(destinoId, origenId, usuario) {
  if (Number(destinoId) === Number(origenId)) {
    const err = new Error('No se puede fusionar una empresa consigo misma.');
    err.status = 400;
    throw err;
  }
  const destino = db.prepare('SELECT * FROM crm_empresas WHERE id = ?').get(destinoId);
  const origen = db.prepare('SELECT * FROM crm_empresas WHERE id = ?').get(origenId);
  if (!destino || !origen) {
    const err = new Error('No existe alguna de las dos empresas.');
    err.status = 404;
    throw err;
  }
  if (destino.nit && origen.nit && destino.nit !== origen.nit) {
    const err = new Error(`Tienen NIT distintos (${destino.nit} y ${origen.nit}): son empresas diferentes.`);
    err.status = 400;
    throw err;
  }
  db.exec('BEGIN');
  try {
    for (const t of ['cotizaciones', 'facturas', 'ordenes_compra', 'buzon_ofertas', 'correo_mensajes', 'crm_contactos', 'crm_negocios', 'crm_actividades']) {
      db.prepare(`UPDATE ${t} SET empresa_id = ? WHERE empresa_id = ?`).run(destinoId, origenId);
    }
    const campos = ['nit', 'sector', 'ciudad', 'direccion', 'telefono', 'web', 'dominio_correo', 'responsable_id'];
    const completar = campos.filter((c) => (destino[c] == null || destino[c] === '') && origen[c] != null && origen[c] !== '');
    // El NIT se libera del origen antes de pasarlo al destino.
    if (completar.length) {
      db.prepare(`UPDATE crm_empresas SET nit = NULL WHERE id = ?`).run(origenId);
      db.prepare(`UPDATE crm_empresas SET ${completar.map((c) => `${c} = ?`).join(', ')}, actualizado_en = datetime('now') WHERE id = ?`)
        .run(...completar.map((c) => origen[c]), destinoId);
    }
    if (origen.notas) {
      db.prepare(`UPDATE crm_empresas SET notas = trim(COALESCE(notas, '') || char(10) || ?) WHERE id = ?`).run(origen.notas, destinoId);
    }
    db.prepare('UPDATE crm_empresa_alias SET empresa_id = ? WHERE empresa_id = ?').run(destinoId, origenId);
    const alias = db.prepare('INSERT OR REPLACE INTO crm_empresa_alias (clave, empresa_id) VALUES (?, ?)');
    if (origen.nombre_norm !== destino.nombre_norm) alias.run(`nombre:${origen.nombre_norm}`, destinoId);
    if (origen.nit && origen.nit !== destino.nit) alias.run(`nit:${origen.nit}`, destinoId);
    db.prepare('DELETE FROM crm_empresas WHERE id = ?').run(origenId);
    registrar({ usuario, accion: 'ELIMINAR', entidad: 'crm_empresas', entidadId: origenId, valorAnterior: origen.nombre, valorNuevo: `Fusionada en ${destino.nombre} (#${destino.id})` });
    registrar({ usuario, accion: 'EDITAR', entidad: 'crm_empresas', entidadId: destinoId, campo: 'fusion', valorNuevo: `Recibió a ${origen.nombre} (#${origen.id})` });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return db.prepare('SELECT * FROM crm_empresas WHERE id = ?').get(destinoId);
}

// ---------------------------------------------------------------- alertas

// Cada alerta trae el dato que la sustenta (fecha, dias, numero), para que la
// persona pueda verificarla. severidad: 'critica' | 'aviso' | 'info'.
function alertas() {
  const ahora = ahoraColombia();
  const hoy = hoyColombia();
  const lista = [];

  for (const x of listarActividades({ pendientes: true })) {
    if (!x.fecha_programada) continue;
    const dia = x.fecha_programada.slice(0, 10);
    const quien = [x.empresa_nombre, x.contacto_nombre].filter(Boolean).join(' · ');
    if (x.fecha_programada < ahora) {
      lista.push({ clave: `act-${x.id}`, grupo: 'Tareas vencidas', severidad: 'critica', titulo: `${x.tipo}: ${x.asunto}`, detalle: `${quien ? quien + ' · ' : ''}programada para ${dia.split('-').reverse().join('/')} ${x.fecha_programada.slice(11)} (hace ${diffDays(hoy, dia)} día(s))`, enlace: '#/crm/agenda', actividad_id: x.id });
    } else if (dia === hoy) {
      lista.push({ clave: `act-${x.id}`, grupo: 'Para hoy', severidad: 'aviso', titulo: `${x.tipo}: ${x.asunto}`, detalle: `${quien ? quien + ' · ' : ''}a las ${x.fecha_programada.slice(11)}`, enlace: '#/crm/agenda', actividad_id: x.id });
    }
  }

  const abiertos = listarNegocios({ abiertos: true });
  let viejas = 0;
  let viejasValor = 0;
  let sinFecha = 0;
  const estancadas = new Map();
  const quietos = new Map();
  const agregarPorEmpresa = (mapa, n, alerta) => {
    if (!mapa.has(n.empresa_id)) mapa.set(n.empresa_id, { negocios: [], alertas: [] });
    mapa.get(n.empresa_id).negocios.push(n);
    mapa.get(n.empresa_id).alertas.push(alerta);
  };
  for (const n of abiertos) {
    const enlace = `#/crm/negocios/${n.id}`;
    if (n.cierre_vencido) {
      lista.push({ clave: `cierre-${n.id}`, grupo: 'Fecha de cierre pasada', severidad: 'critica', titulo: n.nombre, detalle: `${n.empresa_nombre} · debía cerrar el ${n.fecha_cierre_esperada.split('-').reverse().join('/')} y sigue en ${n.etapa}`, enlace });
      continue;
    }
    if (!n.fecha_cierre_esperada) sinFecha++;
    const diasInicio = diffDays(hoy, n.fecha_inicio);
    if (n.etapa === 'Propuesta enviada' && diasInicio > DIAS_PROPUESTA_VIEJA) {
      viejas++;
      viejasValor += n.valor_sin_iva;
      continue;
    }
    if (n.etapa === 'Propuesta enviada' && n.dias_en_etapa > DIAS_PROPUESTA_ESTANCADA) {
      agregarPorEmpresa(estancadas, n, { clave: `prop-${n.id}`, grupo: 'Propuestas sin respuesta', severidad: 'aviso', titulo: n.nombre, detalle: `${n.empresa_nombre} · enviada hace ${n.dias_en_etapa} días, sin avance · ${pesos(n.valor_sin_iva)} sin IVA`, enlace });
    } else if (n.dias_sin_actividad != null && n.dias_sin_actividad > DIAS_SIN_ACTIVIDAD && n.etapa !== 'Propuesta enviada') {
      agregarPorEmpresa(quietos, n, { clave: `quieto-${n.id}`, grupo: 'Negocios sin actividad', severidad: 'aviso', titulo: n.nombre, detalle: `${n.empresa_nombre} · ${n.dias_sin_actividad} días sin actividad · en ${n.etapa}`, enlace });
    }
  }
  // Un cliente con muchas propuestas quietas (Ruitoque cotiza varias por semana)
  // se resume en una sola alerta, para que no tape las demas.
  for (const [mapa, grupo, que] of [[estancadas, 'Propuestas sin respuesta', 'propuesta(s) enviada(s) sin avance'], [quietos, 'Negocios sin actividad', 'negocio(s) sin actividad']]) {
    for (const { negocios, alertas: items } of mapa.values()) {
      if (items.length < 3) { lista.push(...items); continue; }
      const dias = negocios.map((n) => (grupo === 'Propuestas sin respuesta' ? n.dias_en_etapa : n.dias_sin_actividad));
      lista.push({
        clave: `${grupo}-${negocios[0].empresa_id}`, grupo, severidad: 'aviso',
        titulo: `${negocios[0].empresa_nombre}: ${negocios.length} ${que}`,
        detalle: `Entre ${Math.min(...dias)} y ${Math.max(...dias)} días · suman ${pesos(negocios.reduce((t, n) => t + n.valor_sin_iva, 0))} sin IVA · ${negocios.slice(0, 4).map((n) => n.nombre.split(' · ')[0]).join(', ')}${negocios.length > 4 ? '…' : ''}`,
        enlace: `#/crm/empresas/${negocios[0].empresa_id}`,
      });
    }
  }
  if (viejas) {
    lista.push({ clave: 'prop-viejas', grupo: 'Propuestas sin respuesta', severidad: 'info', titulo: `${viejas} propuesta(s) con más de ${DIAS_PROPUESTA_VIEJA} días sin decisión`, detalle: `Suman ${pesos(viejasValor)} sin IVA. Conviene marcarlas como ganadas o perdidas para que el embudo sea real.`, enlace: '#/crm/negocios?etapa=Propuesta%20enviada' });
  }
  const conciliables = posiblesFacturas();
  if (conciliables.length) {
    const seguras = conciliables.filter((p) => p.unica && p.exacta).length;
    lista.push({ clave: 'conciliar', grupo: 'Datos por completar', severidad: 'info', titulo: `${conciliables.length} cotización(es) con una posible factura sin vincular`, detalle: `${seguras} con una sola factura del mismo cliente por el valor exacto. Al confirmarlas, sus negocios pasan a Cierre ganado.`, enlace: '#/crm/negocios?conciliar=1' });
  }
  if (sinFecha) {
    lista.push({ clave: 'sin-fecha', grupo: 'Datos por completar', severidad: 'info', titulo: `${sinFecha} negocio(s) abierto(s) sin fecha de cierre esperada`, detalle: 'Sin esa fecha el pronóstico por mes no los puede ubicar.', enlace: '#/crm/negocios' });
  }

  const buzon = db.prepare(`SELECT id, asunto, empresa, fecha_limite, fecha_recibido FROM buzon_ofertas WHERE estado = 'Pendiente' AND tipo IN ('Solicitud','Licitación')`).all();
  for (const b of buzon.filter((x) => x.fecha_limite && x.fecha_limite < todayStr())) {
    lista.push({ clave: `buzon-${b.id}`, grupo: 'Buzón', severidad: 'critica', titulo: b.asunto || 'Solicitud sin asunto', detalle: `${b.empresa || ''} · fecha límite ${b.fecha_limite.split('-').reverse().join('/')} vencida`, enlace: '#/buzon' });
  }
  const buzonAbiertas = buzon.filter((x) => !(x.fecha_limite && x.fecha_limite < todayStr())).length;
  if (buzonAbiertas) lista.push({ clave: 'buzon-pend', grupo: 'Buzón', severidad: 'aviso', titulo: `${buzonAbiertas} solicitud(es) del buzón pendientes`, detalle: 'Sin cotización ni respuesta registrada.', enlace: '#/buzon' });

  const ocSinFactura = db.prepare(
    `SELECT o.id, o.numero, o.fecha, e.nombre AS empresa FROM ordenes_compra o LEFT JOIN crm_empresas e ON e.id = o.empresa_id
     WHERE o.factura_id IS NULL AND o.fecha IS NOT NULL AND o.fecha < ?`
  ).all(addDays(todayStr(), -30));
  for (const o of ocSinFactura) {
    lista.push({ clave: `oc-${o.id}`, grupo: 'Órdenes de compra sin factura', severidad: 'aviso', titulo: `OC ${o.numero}`, detalle: `${o.empresa || ''} · recibida el ${o.fecha.split('-').reverse().join('/')} (${diffDays(todayStr(), o.fecha)} días) y sin factura`, enlace: '#/buzon' });
  }

  for (const r of clientesAReactivar().slice(0, 10)) {
    lista.push({ clave: `react-${r.id}`, grupo: 'Clientes a reactivar', severidad: 'info', titulo: r.nombre, detalle: `Última factura ${r.ultima_numero} del ${r.ultima_factura.split('-').reverse().join('/')} (hace ${r.dias} días) · facturado histórico ${pesos(r.facturado)}`, enlace: `#/crm/empresas/${r.id}` });
  }

  const orden = { critica: 0, aviso: 1, info: 2 };
  lista.sort((a, b) => orden[a.severidad] - orden[b.severidad]);
  return {
    // La campana cuenta lo que pide accion hoy: lo vencido y lo programado para hoy.
    total: lista.filter((x) => x.severidad === 'critica' || x.grupo === 'Para hoy').length,
    criticas: lista.filter((x) => x.severidad === 'critica').length,
    alertas: lista,
  };
}

// Clientes que facturaban y llevan mas de DIAS_REACTIVAR dias sin factura, sin
// negocio abierto. Ordenados por lo que han facturado.
function clientesAReactivar() {
  const hoy = todayStr();
  return db.prepare(
    `SELECT e.id, e.nombre, e.tipo,
       MAX(f.fecha) AS ultima_factura, SUM(f.total) AS facturado, COUNT(*) AS n_facturas,
       (SELECT f2.numero FROM facturas f2 WHERE f2.empresa_id = e.id AND f2.anulada = 0 ORDER BY f2.fecha DESC LIMIT 1) AS ultima_numero
     FROM crm_empresas e JOIN facturas f ON f.empresa_id = e.id AND f.anulada = 0
     WHERE e.activo = 1 AND NOT EXISTS (
       SELECT 1 FROM crm_negocios n WHERE n.empresa_id = e.id AND n.etapa IN (${ETAPAS_ABIERTAS.map(() => '?').join(',')}))
     GROUP BY e.id HAVING MAX(f.fecha) < ?
     ORDER BY facturado DESC`
  ).all(...ETAPAS_ABIERTAS, addDays(hoy, -DIAS_REACTIVAR)).map((r) => ({ ...r, dias: diffDays(hoy, r.ultima_factura) }));
}

// ---------------------------------------------------------------- conciliacion cotizacion <-> factura

// La mayoria de las facturas no dicen en sus observaciones de que cotizacion
// salen, asi que sus negocios se quedan en "Propuesta enviada" aunque ya se
// cobraron. Aqui se PROPONEN parejas (nunca se vinculan solas): factura del
// mismo cliente, sin cotizacion, emitida entre la fecha de la cotizacion y 180
// dias despues, por el mismo valor (+-0,5% o $1.000). `unica` = esa cotizacion
// tiene una sola factura candidata y esa factura una sola cotizacion candidata.
function posiblesFacturas({ cotizacionIds = null } = {}) {
  const cots = db.prepare(
    `SELECT c.id, c.numero, c.empresa_id, c.fecha_cotizacion, c.precio_venta, c.negocio_id, c.estado, e.nombre AS empresa_nombre
     FROM cotizaciones c JOIN crm_empresas e ON e.id = c.empresa_id
     WHERE c.precio_venta > 0 AND c.estado <> 'Rechazada'
       AND NOT EXISTS (SELECT 1 FROM facturas f WHERE f.cotizacion_id = c.id)`
  ).all().filter((c) => !cotizacionIds || cotizacionIds.includes(c.id));
  const candidatas = db.prepare(
    `SELECT id, numero, fecha, total, titulo FROM facturas
     WHERE empresa_id = ? AND anulada = 0 AND cotizacion_id IS NULL
       AND fecha >= ? AND fecha <= date(?, '+180 day') AND abs(total - ?) <= max(1000, ? * 0.005)
     ORDER BY abs(total - ?), fecha`
  );
  const pares = [];
  const usoFactura = new Map();
  for (const c of cots) {
    const fs = candidatas.all(c.empresa_id, c.fecha_cotizacion, c.fecha_cotizacion, c.precio_venta, c.precio_venta, c.precio_venta);
    if (!fs.length) continue;
    for (const f of fs) usoFactura.set(f.id, (usoFactura.get(f.id) || 0) + 1);
    pares.push({ cotizacion: c, facturas: fs });
  }
  return pares.map(({ cotizacion, facturas }) => ({
    cotizacion,
    facturas: facturas.map((f) => ({ ...f, diferencia: Math.round((f.total - cotizacion.precio_venta) * 100) / 100, dias: diffDays(f.fecha, cotizacion.fecha_cotizacion) })),
    unica: facturas.length === 1 && usoFactura.get(facturas[0].id) === 1,
    exacta: facturas.length >= 1 && Math.abs(facturas[0].total - cotizacion.precio_venta) < 1,
  })).sort((a, b) => Number(b.unica && b.exacta) - Number(a.unica && a.exacta) || String(b.cotizacion.fecha_cotizacion).localeCompare(String(a.cotizacion.fecha_cotizacion)));
}

// Vincula parejas confirmadas por una persona y avanza sus negocios.
function vincularFacturas(pares, usuario) {
  let vinculadas = 0;
  const errores = [];
  db.exec('BEGIN');
  try {
    for (const p of pares) {
      const c = db.prepare('SELECT id, numero, empresa_id FROM cotizaciones WHERE id = ?').get(p.cotizacion_id);
      const f = db.prepare('SELECT id, numero, empresa_id, cotizacion_id, anulada FROM facturas WHERE id = ?').get(p.factura_id);
      if (!c || !f) { errores.push(`No existe la cotización o la factura (${p.cotizacion_id} / ${p.factura_id})`); continue; }
      if (f.cotizacion_id) { errores.push(`${f.numero} ya está vinculada a otra cotización`); continue; }
      if (f.anulada) { errores.push(`${f.numero} está anulada`); continue; }
      if (c.empresa_id && f.empresa_id && c.empresa_id !== f.empresa_id) { errores.push(`${f.numero} y ${c.numero} son de empresas distintas`); continue; }
      db.prepare('UPDATE facturas SET cotizacion_id = ? WHERE id = ?').run(c.id, f.id);
      registrar({ usuario, accion: 'EDITAR', entidad: 'facturas', entidadId: f.id, campo: 'cotizacion_id', valorNuevo: `${f.numero} → ${c.numero} (conciliación del CRM)` });
      vinculadas++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const r = sincronizarCrm();
  return { vinculadas, errores, negociosAvanzados: r.negociosAvanzados };
}

// ---------------------------------------------------------------- tablero

function mesDe(fecha) {
  return String(fecha || '').slice(0, 7);
}
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function etiquetaMes(ym) {
  const [y, m] = ym.split('-');
  return `${MESES[Number(m) - 1]} ${y.slice(2)}`;
}

// Meta de ventas del mes: linea "Ingresos Operacionales" del presupuesto (la
// misma que usa el informe semanal de gestion comercial).
function metaDelMes(anio, mes) {
  const linea = db.prepare(`SELECT id, etiqueta FROM presupuesto_lineas WHERE fila = 18`).get()
    || db.prepare(`SELECT id, etiqueta FROM presupuesto_lineas WHERE upper(etiqueta) LIKE '%INGRESOS OPERACIONALES%' ORDER BY orden LIMIT 1`).get();
  if (!linea) return null;
  const v = db.prepare('SELECT valor FROM presupuesto_valores WHERE linea_id = ? AND anio = ? AND mes = ?').get(linea.id, anio, mes);
  return v && v.valor != null ? { etiqueta: linea.etiqueta, valor: Number(v.valor) } : null;
}

function tablero({ desde, hasta } = {}) {
  const hoy = hoyColombia();
  desde = desde || `${hoy.slice(0, 4)}-01-01`;
  hasta = hasta || hoy;
  const negocios = listarNegocios({});
  const abiertos = negocios.filter((n) => n.abierto);
  const desglose = [];

  const embudo = ETAPAS.filter((e) => e.abierta).map((e) => {
    const de = abiertos.filter((n) => n.etapa === e.nombre);
    return {
      etapa: e.nombre, probabilidad: e.probabilidad, cantidad: de.length,
      valor_sin_iva: de.reduce((s, n) => s + n.valor_sin_iva, 0),
      valor_con_iva: de.reduce((s, n) => s + n.valor_con_iva, 0),
      ponderado: de.reduce((s, n) => s + n.valor_ponderado, 0),
    };
  });
  const pipeline = embudo.reduce((s, e) => s + e.valor_sin_iva, 0);
  const ponderado = embudo.reduce((s, e) => s + e.ponderado, 0);
  desglose.push({ concepto: 'Pipeline abierto (sin IVA)', formula: 'Σ valor sin IVA de los negocios en etapas abiertas (valor = sus cotizaciones no rechazadas ÷ 1,19, o el valor estimado si no tiene cotizaciones)', valor: pipeline });
  desglose.push({ concepto: 'Pronóstico ponderado (sin IVA)', formula: `Σ valor sin IVA × probabilidad. Probabilidad por etapa: ${ETAPAS.filter((e) => e.abierta).map((e) => `${e.nombre} ${Math.round(e.probabilidad * 100)}%`).join(', ')} (editable en cada negocio)`, valor: ponderado });

  // Pronostico por mes de cierre esperado: los 6 meses desde el actual.
  const meses = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)) - 1 + i, 1));
    meses.push(d.toISOString().slice(0, 7));
  }
  const pronostico = meses.map((ym) => {
    const de = abiertos.filter((n) => mesDe(n.fecha_cierre_esperada) === ym || (ym === meses[0] && n.fecha_cierre_esperada && mesDe(n.fecha_cierre_esperada) < ym));
    return { mes: ym, etiqueta: etiquetaMes(ym), cantidad: de.length, valor_sin_iva: de.reduce((s, n) => s + n.valor_sin_iva, 0), ponderado: de.reduce((s, n) => s + n.valor_ponderado, 0) };
  });
  const sinFecha = abiertos.filter((n) => !n.fecha_cierre_esperada);
  pronostico.push({ mes: null, etiqueta: 'Sin fecha', cantidad: sinFecha.length, valor_sin_iva: sinFecha.reduce((s, n) => s + n.valor_sin_iva, 0), ponderado: sinFecha.reduce((s, n) => s + n.valor_ponderado, 0) });

  const enPeriodo = (f) => f && String(f).slice(0, 10) >= desde && String(f).slice(0, 10) <= hasta;
  const ganados = negocios.filter((n) => n.etapa === GANADO && enPeriodo(n.fecha_cierre_real));
  const perdidos = negocios.filter((n) => n.etapa === PERDIDO && enPeriodo(n.fecha_cierre_real));
  const conversion = ganados.length + perdidos.length ? ganados.length / (ganados.length + perdidos.length) : null;
  desglose.push({ concepto: 'Tasa de cierre del período', formula: `ganados ÷ (ganados + perdidos) cerrados entre ${desde} y ${hasta} = ${ganados.length} ÷ ${ganados.length + perdidos.length}`, valor: conversion });
  const ciclos = ganados.map((n) => diffDays(n.fecha_cierre_real, n.fecha_inicio)).filter((d) => d != null && d >= 0);
  const ciclo = ciclos.length ? ciclos.reduce((s, d) => s + d, 0) / ciclos.length : null;
  desglose.push({ concepto: 'Ciclo de venta promedio (días)', formula: `promedio de (fecha de cierre real − fecha de inicio) de ${ciclos.length} negocio(s) ganado(s) en el período`, valor: ciclo });

  // Dias promedio por etapa, con el historial de los negocios iniciados en el periodo.
  const tiempos = {};
  const hist = db.prepare(
    `SELECT h.negocio_id, h.etapa_nueva, h.fecha FROM crm_etapas_historial h JOIN crm_negocios n ON n.id = h.negocio_id
     WHERE n.fecha_inicio BETWEEN ? AND ? ORDER BY h.negocio_id, h.fecha, h.id`
  ).all(desde, hasta);
  for (let i = 0; i < hist.length; i++) {
    const h = hist[i];
    if (!ETAPAS_ABIERTAS.includes(h.etapa_nueva)) continue;
    const sig = hist[i + 1] && hist[i + 1].negocio_id === h.negocio_id ? hist[i + 1].fecha : `${hoy}T00:00`;
    const dias = diffDays(String(sig).slice(0, 10), String(h.fecha).slice(0, 10));
    if (dias == null || dias < 0) continue;
    (tiempos[h.etapa_nueva] = tiempos[h.etapa_nueva] || []).push(dias);
  }
  const diasPorEtapa = ETAPAS_ABIERTAS.map((e) => ({
    etapa: e, negocios: (tiempos[e] || []).length,
    dias_promedio: (tiempos[e] || []).length ? tiempos[e].reduce((s, d) => s + d, 0) / tiempos[e].length : null,
  }));

  const motivos = {};
  for (const n of perdidos) motivos[n.motivo_perdida || 'Sin motivo'] = (motivos[n.motivo_perdida || 'Sin motivo'] || 0) + 1;

  const topClientes = db.prepare(
    `SELECT e.id, e.nombre, e.tipo, SUM(f.total) AS facturado, COUNT(*) AS facturas, COALESCE(SUM(f.saldo), 0) AS cartera
     FROM facturas f JOIN crm_empresas e ON e.id = f.empresa_id
     WHERE f.anulada = 0 AND f.fecha BETWEEN ? AND ? GROUP BY e.id ORDER BY facturado DESC LIMIT 10`
  ).all(desde, hasta);

  const [anio, mes] = [Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7))];
  const meta = metaDelMes(anio, mes);
  const facturadoMes = db.prepare(`SELECT COALESCE(SUM(total), 0) AS t FROM facturas WHERE anulada = 0 AND substr(fecha, 1, 7) = ?`).get(hoy.slice(0, 7)).t;
  const ganadoMesSin = facturadoMes / IVA;
  desglose.push({ concepto: 'Facturado del mes (sin IVA)', formula: `Σ total de facturas no anuladas de ${hoy.slice(0, 7)} ÷ 1,19 (mismo criterio del informe semanal)`, valor: ganadoMesSin });
  if (meta) desglose.push({ concepto: 'Meta del mes', formula: `Presupuesto › ${meta.etiqueta} › ${MESES[mes - 1]} ${anio}`, valor: meta.valor });

  const actividades = db.prepare(
    `SELECT tipo, COUNT(*) AS total, SUM(completada) AS completadas FROM crm_actividades
     WHERE substr(COALESCE(completada_en, fecha_programada, creado_en), 1, 10) BETWEEN ? AND ? GROUP BY tipo ORDER BY total DESC`
  ).all(desde, hasta);

  return {
    desde, hasta,
    kpis: {
      pipeline_sin_iva: pipeline, pipeline_negocios: abiertos.length, ponderado,
      ganados: ganados.length, ganado_sin_iva: ganados.reduce((s, n) => s + n.valor_sin_iva, 0),
      perdidos: perdidos.length, perdido_sin_iva: perdidos.reduce((s, n) => s + n.valor_sin_iva, 0),
      conversion, ciclo_dias: ciclo,
      facturado_mes_sin_iva: ganadoMesSin, meta_mes: meta ? meta.valor : null,
      cumplimiento_meta: meta && meta.valor ? ganadoMesSin / meta.valor : null,
      empresas: db.prepare('SELECT COUNT(*) AS n FROM crm_empresas WHERE activo = 1').get().n,
      clientes: db.prepare(`SELECT COUNT(*) AS n FROM crm_empresas WHERE activo = 1 AND tipo = 'Cliente'`).get().n,
    },
    embudo, pronostico, diasPorEtapa,
    motivosPerdida: Object.entries(motivos).map(([motivo, cantidad]) => ({ motivo, cantidad })).sort((a, b) => b.cantidad - a.cantidad),
    topClientes, actividades, desglose,
    proximas: listarActividades({ pendientes: true, desde: `${hoy}T00:00`, hasta: addDays(hoy, 7) }).reverse().slice(0, 15),
  };
}

// ---------------------------------------------------------------- calendario (.ics)

function icsEscape(t) {
  return String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
// 'YYYY-MM-DDTHH:MM' hora Colombia -> 'YYYYMMDDTHHMMSSZ' en UTC.
function aUtcIcs(local, sumarMin = 0) {
  const [f, h] = String(local).split('T');
  const [y, m, d] = f.split('-').map(Number);
  const [hh, mm] = (h || '09:00').split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh + 5, mm + sumarMin));
  return t.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function icsActividad(x) {
  const inicio = x.fecha_programada || `${hoyColombia()}T09:00`;
  const lineas = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PROENERGY//CRM//ES', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:crm-actividad-${x.id}@proenergy`, `DTSTAMP:${aUtcIcs(ahoraColombia())}`,
    `DTSTART:${aUtcIcs(inicio)}`, `DTEND:${aUtcIcs(inicio, Number(x.duracion_min) || 30)}`,
    `SUMMARY:${icsEscape(`${x.tipo}: ${x.asunto}${x.empresa_nombre ? ' — ' + x.empresa_nombre : ''}`)}`,
    `DESCRIPTION:${icsEscape([x.descripcion, x.contacto_nombre ? 'Contacto: ' + x.contacto_nombre : null, x.negocio_nombre ? 'Negocio: ' + x.negocio_nombre : null].filter(Boolean).join('\n'))}`,
    'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(x.asunto)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lineas.join('\r\n') + '\r\n';
}

module.exports = {
  ETAPAS, NOMBRES_ETAPAS, ETAPAS_ABIERTAS, GANADO, PERDIDO, TIPOS_EMPRESA, SECTORES, ORIGENES, ROLES_CONTACTO,
  TIPOS_ACTIVIDAD, MOTIVOS_PERDIDA, IVA,
  ahoraColombia, hoyColombia, normalizarEmpresa, normalizarNit, dominioDe, valoresCotizacion, probabilidadDe,
  buscarEmpresa, empresaPara, cambiarEtapa, crearNegocio, registrarEtapa, avanzarNegocio, completarDominios,
  sincronizarCrm, listarNegocios, getNegocio, listarActividades, listarEmpresas, ficha360,
  duplicados, fusionar, alertas, clientesAReactivar, tablero, metaDelMes, icsActividad, posiblesFacturas, vincularFacturas,
};
