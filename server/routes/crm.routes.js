'use strict';
// CRM comercial (logica en lib/crm.js). Lectura para cualquier usuario con
// sesion; escritura solo admin, siempre con auditoria.
//   GET  /api/crm/config                       etapas, listas y usuarios responsables
//   GET  /api/crm/tablero?desde&hasta          indicadores, embudo y pronostico
//   GET  /api/crm/alertas[?resumen=1]          alertas con su evidencia
//   POST /api/crm/sincronizar                  vincular documentos y avanzar negocios (admin)
//   GET|POST /api/crm/empresas                 listado / crear
//   GET|PUT|DELETE /api/crm/empresas/:id       ficha / editar / eliminar
//   GET  /api/crm/empresas/:id/360             ficha 360 (todo lo de la empresa)
//   GET  /api/crm/duplicados                   posibles duplicados
//   POST /api/crm/empresas/:id/fusionar        { origen_id } se fusiona dentro de :id
//   GET|POST /api/crm/contactos, PUT|DELETE /api/crm/contactos/:id
//   GET|POST /api/crm/negocios, GET|PUT|DELETE /api/crm/negocios/:id
//   PUT  /api/crm/negocios/:id/etapa           { etapa, motivo_perdida, fecha }
//   POST /api/crm/negocios/:id/cotizaciones    { numero, quitar }
//   GET|POST /api/crm/actividades, PUT|DELETE /api/crm/actividades/:id
//   GET  /api/crm/actividades/:id/ics          archivo para el calendario de Outlook
//   GET|POST /api/crm/conciliacion             posibles facturas de cada cotizacion / vincular las confirmadas
//   GET  /api/crm/exportar.xlsx, GET /api/crm/plantilla.xlsx
//   POST /api/crm/importar?tipo=empresas|contactos&formato=xlsx|csv
const db = require('../db');
const { sendJson, readJsonBody, readBody, HttpError } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { registrar, registrarCambios } = require('../lib/audit');
const crm = require('../lib/crm');
const { writeXlsxMultiSheet, readXlsxFirstSheetAsObjects } = require('../lib/xlsx');
const { parseCsv } = require('../lib/csv');

const texto = (v, max = 500) => {
  const t = v == null ? '' : String(v).trim();
  return t ? t.slice(0, max) : null;
};
const fecha = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v).slice(0, 10)) ? String(v).slice(0, 10) : null);
const fechaHora = (v) => (v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(v)) ? String(v).slice(0, 16) : null);
const entero = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

function usuarioValido(id) {
  if (id == null || id === '') return null;
  const u = db.prepare('SELECT id FROM usuarios WHERE id = ? AND activo = 1').get(id);
  if (!u) throw new HttpError(400, 'Responsable inválido');
  return u.id;
}
function empresaOError(id) {
  const e = db.prepare('SELECT * FROM crm_empresas WHERE id = ?').get(id);
  if (!e) throw new HttpError(404, 'No existe esa empresa');
  return e;
}
function negocioOError(id) {
  const n = db.prepare('SELECT * FROM crm_negocios WHERE id = ?').get(id);
  if (!n) throw new HttpError(404, 'No existe ese negocio');
  return n;
}

// Campos editables de una empresa, validados.
function datosEmpresa(b, antes = {}) {
  const pick = (k, f) => (b[k] !== undefined ? f(b[k]) : (antes[k] ?? null));
  const d = {
    nombre: pick('nombre', (v) => texto(v, 200)),
    nit: pick('nit', (v) => crm.normalizarNit(v)),
    tipo: pick('tipo', (v) => (crm.TIPOS_EMPRESA.includes(v) ? v : null)),
    sector: pick('sector', (v) => texto(v, 80)),
    ciudad: pick('ciudad', (v) => texto(v, 80)),
    direccion: pick('direccion', (v) => texto(v, 200)),
    telefono: pick('telefono', (v) => texto(v, 60)),
    web: pick('web', (v) => texto(v, 200)),
    dominio_correo: pick('dominio_correo', (v) => (texto(v, 120) || '').toLowerCase().replace(/^@/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null),
    origen: pick('origen', (v) => texto(v, 60)),
    responsable_id: pick('responsable_id', usuarioValido),
    notas: pick('notas', (v) => texto(v, 4000)),
  };
  if (!d.nombre) throw new HttpError(400, 'El nombre de la empresa es obligatorio');
  if (!d.tipo) d.tipo = antes.tipo || 'Prospecto';
  return d;
}

function guardarEmpresa({ b, user, id = null }) {
  const antes = id ? empresaOError(id) : {};
  const d = datosEmpresa(b, antes);
  const norm = crm.normalizarEmpresa(d.nombre);
  if (d.nit) {
    const otra = db.prepare('SELECT id, nombre FROM crm_empresas WHERE nit = ? AND id <> ?').get(d.nit, id || 0);
    if (otra) throw new HttpError(400, `Ya existe una empresa con el NIT ${d.nit}: ${otra.nombre}`);
  }
  const mismoNombre = db.prepare('SELECT id, nombre FROM crm_empresas WHERE nombre_norm = ? AND id <> ?').get(norm, id || 0);
  if (mismoNombre) throw new HttpError(400, `Ya existe la empresa ${mismoNombre.nombre}. Ábrala y edítela, o fusiónelas desde Posibles duplicados.`);
  // tipo 'auto' = volver al calculo automatico (Cliente / Inactivo / Prospecto segun facturas).
  const tipoManual = b.tipo === 'auto' ? 0 : b.tipo !== undefined && b.tipo !== antes.tipo ? 1 : (antes.tipo_manual || 0);
  if (id) {
    db.prepare(
      `UPDATE crm_empresas SET nombre=?, nombre_norm=?, nit=?, tipo=?, tipo_manual=?, sector=?, ciudad=?, direccion=?, telefono=?, web=?,
         dominio_correo=?, origen=?, responsable_id=?, notas=?, actualizado_en=datetime('now') WHERE id=?`
    ).run(d.nombre, norm, d.nit, d.tipo, tipoManual, d.sector, d.ciudad, d.direccion, d.telefono, d.web, d.dominio_correo, d.origen, d.responsable_id, d.notas, id);
    const despues = db.prepare('SELECT * FROM crm_empresas WHERE id = ?').get(id);
    registrarCambios({ usuario: user, entidad: 'crm_empresas', entidadId: id, antes, despues, ignorar: ['actualizado_en', 'nombre_norm'] });
    return despues;
  }
  const info = db.prepare(
    `INSERT INTO crm_empresas (nombre, nombre_norm, nit, tipo, tipo_manual, sector, ciudad, direccion, telefono, web, dominio_correo, origen, responsable_id, notas, creado_por)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(d.nombre, norm, d.nit, d.tipo, b.tipo ? 1 : 0, d.sector, d.ciudad, d.direccion, d.telefono, d.web, d.dominio_correo, d.origen || 'Manual', d.responsable_id, d.notas, user.id);
  registrar({ usuario: user, accion: 'CREAR', entidad: 'crm_empresas', entidadId: info.lastInsertRowid, valorNuevo: d.nombre });
  return db.prepare('SELECT * FROM crm_empresas WHERE id = ?').get(info.lastInsertRowid);
}

function datosContacto(b, antes = {}) {
  const pick = (k, f) => (b[k] !== undefined ? f(b[k]) : (antes[k] ?? null));
  const d = {
    empresa_id: pick('empresa_id', entero),
    nombre: pick('nombre', (v) => texto(v, 150)),
    cargo: pick('cargo', (v) => texto(v, 120)),
    rol: pick('rol', (v) => texto(v, 40)),
    email: pick('email', (v) => (texto(v, 150) || '').toLowerCase() || null),
    telefono: pick('telefono', (v) => texto(v, 60)),
    celular: pick('celular', (v) => texto(v, 60)),
    es_principal: pick('es_principal', (v) => (v === true || v === 1 || v === '1' || /^s[ií]$/i.test(String(v)) ? 1 : 0)) || 0,
    notas: pick('notas', (v) => texto(v, 2000)),
  };
  if (!d.nombre) throw new HttpError(400, 'El nombre del contacto es obligatorio');
  if (!d.empresa_id) throw new HttpError(400, 'Indique la empresa del contacto');
  empresaOError(d.empresa_id);
  if (d.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) throw new HttpError(400, 'Correo electrónico inválido');
  return d;
}

function guardarContacto({ b, user, id = null }) {
  const antes = id ? db.prepare('SELECT * FROM crm_contactos WHERE id = ?').get(id) : {};
  if (id && !antes) throw new HttpError(404, 'No existe ese contacto');
  const d = datosContacto(b, antes);
  if (d.email) {
    const otro = db.prepare('SELECT c.id, c.nombre, e.nombre AS empresa FROM crm_contactos c JOIN crm_empresas e ON e.id = c.empresa_id WHERE lower(c.email) = ? AND c.id <> ? AND c.activo = 1').get(d.email, id || 0);
    if (otro) throw new HttpError(400, `El correo ${d.email} ya es de ${otro.nombre} (${otro.empresa})`);
  }
  let cid = id;
  if (id) {
    db.prepare('UPDATE crm_contactos SET empresa_id=?, nombre=?, cargo=?, rol=?, email=?, telefono=?, celular=?, es_principal=?, notas=? WHERE id=?')
      .run(d.empresa_id, d.nombre, d.cargo, d.rol, d.email, d.telefono, d.celular, d.es_principal, d.notas, id);
    registrarCambios({ usuario: user, entidad: 'crm_contactos', entidadId: id, antes, despues: db.prepare('SELECT * FROM crm_contactos WHERE id = ?').get(id) });
  } else {
    cid = db.prepare('INSERT INTO crm_contactos (empresa_id, nombre, cargo, rol, email, telefono, celular, es_principal, notas, creado_por) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(d.empresa_id, d.nombre, d.cargo, d.rol, d.email, d.telefono, d.celular, d.es_principal, d.notas, user.id).lastInsertRowid;
    registrar({ usuario: user, accion: 'CREAR', entidad: 'crm_contactos', entidadId: cid, valorNuevo: `${d.nombre}${d.email ? ' <' + d.email + '>' : ''}` });
  }
  if (d.es_principal) db.prepare('UPDATE crm_contactos SET es_principal = 0 WHERE empresa_id = ? AND id <> ?').run(d.empresa_id, cid);
  // Con un correo corporativo nuevo se completa el dominio de la empresa y se
  // enlazan los correos de Outlook que ya estaban leidos.
  crm.completarDominios();
  if (d.email) {
    db.prepare(
      `UPDATE correo_mensajes SET empresa_id = ?, contacto_id = ?
       WHERE contacto_id IS NULL AND (lower(remitente) = ? OR (',' || replace(lower(destinatarios), ' ', '') || ',') LIKE ?)`
    ).run(d.empresa_id, cid, d.email, `%,${d.email},%`);
  }
  return db.prepare('SELECT * FROM crm_contactos WHERE id = ?').get(cid);
}

function datosNegocio(b, antes = {}) {
  const pick = (k, f) => (b[k] !== undefined ? f(b[k]) : (antes[k] ?? null));
  const d = {
    empresa_id: pick('empresa_id', entero),
    contacto_id: pick('contacto_id', entero),
    nombre: pick('nombre', (v) => texto(v, 200)),
    valor_estimado: pick('valor_estimado', entero),
    probabilidad: pick('probabilidad', (v) => {
      const p = entero(v);
      if (p == null) return null;
      const f = p > 1 ? p / 100 : p;
      if (f < 0 || f > 1) throw new HttpError(400, 'La probabilidad va de 0 a 100%');
      return f;
    }),
    fecha_cierre_esperada: pick('fecha_cierre_esperada', fecha),
    origen: pick('origen', (v) => texto(v, 60)),
    responsable_id: pick('responsable_id', usuarioValido),
    descripcion: pick('descripcion', (v) => texto(v, 4000)),
    motivo_perdida: pick('motivo_perdida', (v) => texto(v, 200)),
  };
  if (!d.nombre) throw new HttpError(400, 'El nombre del negocio es obligatorio');
  if (!d.empresa_id) throw new HttpError(400, 'Indique la empresa del negocio');
  empresaOError(d.empresa_id);
  if (d.contacto_id && !db.prepare('SELECT 1 FROM crm_contactos WHERE id = ? AND empresa_id = ?').get(d.contacto_id, d.empresa_id)) {
    throw new HttpError(400, 'El contacto no pertenece a esa empresa');
  }
  return d;
}

function datosActividad(b, antes = {}) {
  const pick = (k, f) => (b[k] !== undefined ? f(b[k]) : (antes[k] ?? null));
  const d = {
    tipo: pick('tipo', (v) => (crm.TIPOS_ACTIVIDAD.includes(v) ? v : null)),
    asunto: pick('asunto', (v) => texto(v, 200)),
    descripcion: pick('descripcion', (v) => texto(v, 4000)),
    empresa_id: pick('empresa_id', entero),
    contacto_id: pick('contacto_id', entero),
    negocio_id: pick('negocio_id', entero),
    fecha_programada: pick('fecha_programada', fechaHora),
    duracion_min: pick('duracion_min', (v) => Math.max(5, Math.min(1440, entero(v) || 30))) || 30,
    responsable_id: pick('responsable_id', usuarioValido),
    resultado: pick('resultado', (v) => texto(v, 2000)),
    completada: pick('completada', (v) => (v === true || v === 1 || v === '1' ? 1 : 0)) || 0,
  };
  if (!d.tipo) throw new HttpError(400, 'Tipo de actividad inválido');
  if (!d.asunto) throw new HttpError(400, 'El asunto es obligatorio');
  if (d.negocio_id) {
    const n = negocioOError(d.negocio_id);
    if (d.empresa_id && d.empresa_id !== n.empresa_id) throw new HttpError(400, 'El negocio no pertenece a esa empresa');
    d.empresa_id = n.empresa_id;
  }
  if (d.empresa_id) empresaOError(d.empresa_id);
  if (d.contacto_id) {
    const c = db.prepare('SELECT empresa_id FROM crm_contactos WHERE id = ?').get(d.contacto_id);
    if (!c) throw new HttpError(400, 'No existe ese contacto');
    if (d.empresa_id && c.empresa_id !== d.empresa_id) throw new HttpError(400, 'El contacto no pertenece a esa empresa');
    d.empresa_id = c.empresa_id;
  }
  if (d.tipo === 'Nota') d.completada = 1;
  if (!d.fecha_programada && d.tipo !== 'Nota' && !d.completada) throw new HttpError(400, 'Indique la fecha y hora de la actividad');
  return d;
}

// ---------------------------------------------------------------- importacion

// Encabezados comparables: "Teléfono" = "telefono", "Dominio de correo" = "dominio_de_correo".
function claveEncabezado(h) {
  return String(h || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
function filaNormalizada(f) {
  const o = {};
  for (const [k, v] of Object.entries(f)) o[claveEncabezado(k)] = typeof v === 'string' ? v.trim() : v;
  return o;
}
function responsablePorTexto(t) {
  if (!t) return null;
  const u = db.prepare('SELECT id FROM usuarios WHERE activo = 1 AND (lower(username) = lower(?) OR lower(nombre) = lower(?))').get(t, t);
  return u ? u.id : null;
}

function importarEmpresas(filas, user) {
  let creadas = 0, actualizadas = 0;
  const errores = [];
  filas.map(filaNormalizada).forEach((f, i) => {
    const fila = i + 2;
    try {
      if (!f.nombre) throw new Error('falta el nombre');
      const existente = crm.buscarEmpresa({ nombre: f.nombre, nit: f.nit });
      const b = {
        nombre: existente ? existente.nombre : f.nombre, nit: f.nit || undefined, sector: f.sector || undefined, ciudad: f.ciudad || undefined,
        direccion: f.direccion || undefined, telefono: f.telefono || undefined, web: f.web || f.sitio_web || undefined,
        dominio_correo: f.dominio_correo || f.dominio_de_correo || undefined, origen: f.origen || (existente ? undefined : 'Importación'),
        tipo: crm.TIPOS_EMPRESA.includes(f.tipo) ? f.tipo : undefined,
        responsable_id: f.responsable ? (responsablePorTexto(f.responsable) ?? undefined) : undefined,
        notas: f.notas || undefined,
      };
      // Al actualizar, las celdas vacias no borran lo que ya tiene la empresa.
      for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
      if (existente) { guardarEmpresa({ b, user, id: existente.id }); actualizadas++; }
      else { guardarEmpresa({ b, user }); creadas++; }
    } catch (e) {
      errores.push(`Fila ${fila}: ${e.message}`);
    }
  });
  return { creadas, actualizadas, errores };
}

function importarContactos(filas, user) {
  let creadas = 0, actualizadas = 0;
  const errores = [];
  filas.map(filaNormalizada).forEach((f, i) => {
    const fila = i + 2;
    try {
      if (!f.nombre) throw new Error('falta el nombre del contacto');
      const empresa = crm.buscarEmpresa({ nombre: f.empresa, nit: f.nit_empresa || f.nit });
      if (!empresa) throw new Error(`no se encontró la empresa "${f.empresa || f.nit_empresa || ''}" (impórtela primero)`);
      const email = String(f.email || f.correo || f.correo_electronico || '').toLowerCase();
      const existente = email
        ? db.prepare('SELECT id FROM crm_contactos WHERE lower(email) = ? AND activo = 1').get(email)
        : db.prepare('SELECT id FROM crm_contactos WHERE empresa_id = ? AND lower(nombre) = lower(?) AND activo = 1').get(empresa.id, f.nombre);
      const b = {
        empresa_id: empresa.id, nombre: f.nombre, cargo: f.cargo || undefined, rol: f.rol || undefined, email: email || undefined,
        telefono: f.telefono || undefined, celular: f.celular || undefined,
        es_principal: f.principal ? f.principal : undefined, notas: f.notas || undefined,
      };
      for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
      if (existente) { guardarContacto({ b, user, id: existente.id }); actualizadas++; }
      else { guardarContacto({ b, user }); creadas++; }
    } catch (e) {
      errores.push(`Fila ${fila}: ${e.message}`);
    }
  });
  return { creadas, actualizadas, errores };
}

function enviarXlsx(res, nombre, buf) {
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${nombre}"`,
  });
  res.end(buf);
}

module.exports = (router) => {
  router.get('/api/crm/config', withAuth(async ({ res }) => {
    sendJson(res, 200, {
      etapas: crm.ETAPAS, tiposEmpresa: crm.TIPOS_EMPRESA, sectores: crm.SECTORES, origenes: crm.ORIGENES,
      rolesContacto: crm.ROLES_CONTACTO, tiposActividad: crm.TIPOS_ACTIVIDAD, motivosPerdida: crm.MOTIVOS_PERDIDA,
      usuarios: db.prepare('SELECT id, nombre, rol FROM usuarios WHERE activo = 1 ORDER BY nombre').all(),
      ahora: crm.ahoraColombia(),
    });
  }));

  router.get('/api/crm/tablero', withAuth(async ({ res, query }) => {
    sendJson(res, 200, crm.tablero({ desde: fecha(query.desde), hasta: fecha(query.hasta) }));
  }));

  router.get('/api/crm/alertas', withAuth(async ({ res, query }) => {
    const a = crm.alertas();
    sendJson(res, 200, query.resumen ? { total: a.total, criticas: a.criticas } : a);
  }));

  router.post('/api/crm/sincronizar', withAdmin(async ({ res }) => {
    sendJson(res, 200, crm.sincronizarCrm());
  }));

  // Cotizaciones con una posible factura (mismo cliente y valor) sin vincular.
  // Solo se proponen: las vincula una persona con el POST.
  router.get('/api/crm/conciliacion', withAuth(async ({ res }) => {
    sendJson(res, 200, crm.posiblesFacturas());
  }));

  router.post('/api/crm/conciliacion', withAdmin(async ({ req, res, user }) => {
    const b = await readJsonBody(req);
    const pares = Array.isArray(b.pares) ? b.pares.filter((p) => p && entero(p.cotizacion_id) && entero(p.factura_id)) : [];
    if (!pares.length) throw new HttpError(400, 'No hay parejas cotización-factura para vincular');
    if (pares.length > 500) throw new HttpError(400, 'Máximo 500 parejas por vez');
    sendJson(res, 200, crm.vincularFacturas(pares.map((p) => ({ cotizacion_id: entero(p.cotizacion_id), factura_id: entero(p.factura_id) })), user));
  }));

  // ---------------------------------------------------------------- empresas
  router.get('/api/crm/empresas', withAuth(async ({ res, query }) => {
    if (query.min) {
      sendJson(res, 200, db.prepare('SELECT id, nombre, nit, tipo FROM crm_empresas WHERE activo = 1 ORDER BY nombre').all());
      return;
    }
    sendJson(res, 200, crm.listarEmpresas({
      texto: texto(query.texto), tipo: texto(query.tipo), sector: texto(query.sector), ciudad: texto(query.ciudad),
      responsableId: entero(query.responsable_id), sinActividadDias: entero(query.sin_actividad),
    }));
  }));

  router.post('/api/crm/empresas', withAdmin(async ({ req, res, user }) => {
    sendJson(res, 201, guardarEmpresa({ b: await readJsonBody(req), user }));
  }));

  router.get('/api/crm/duplicados', withAuth(async ({ res }) => {
    sendJson(res, 200, crm.duplicados());
  }));

  router.get('/api/crm/empresas/:id/360', withAuth(async ({ res, params }) => {
    const f = crm.ficha360(params.id);
    if (!f) throw new HttpError(404, 'No existe esa empresa');
    sendJson(res, 200, f);
  }));

  router.get('/api/crm/empresas/:id', withAuth(async ({ res, params }) => {
    sendJson(res, 200, empresaOError(params.id));
  }));

  router.put('/api/crm/empresas/:id', withAdmin(async ({ req, res, params, user }) => {
    sendJson(res, 200, guardarEmpresa({ b: await readJsonBody(req), user, id: Number(params.id) }));
  }));

  // Solo se elimina una empresa sin documentos: una con cotizaciones o facturas
  // se volveria a crear en la siguiente sincronizacion. Esa se fusiona.
  router.del('/api/crm/empresas/:id', withAdmin(async ({ res, params, user }) => {
    const e = empresaOError(params.id);
    const docs = db.prepare(
      `SELECT (SELECT COUNT(*) FROM cotizaciones WHERE empresa_id = ?) + (SELECT COUNT(*) FROM facturas WHERE empresa_id = ?)
        + (SELECT COUNT(*) FROM ordenes_compra WHERE empresa_id = ?) + (SELECT COUNT(*) FROM crm_negocios WHERE empresa_id = ?) AS n`
    ).get(e.id, e.id, e.id, e.id).n;
    if (docs) throw new HttpError(400, `${e.nombre} tiene ${docs} cotización(es), factura(s), OC o negocio(s). Para unirla con otra empresa use Fusionar.`);
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE buzon_ofertas SET empresa_id = NULL WHERE empresa_id = ?').run(e.id);
      db.prepare('UPDATE correo_mensajes SET empresa_id = NULL, contacto_id = NULL WHERE empresa_id = ?').run(e.id);
      db.prepare('DELETE FROM crm_empresas WHERE id = ?').run(e.id);
      registrar({ usuario: user, accion: 'ELIMINAR', entidad: 'crm_empresas', entidadId: e.id, valorAnterior: e.nombre });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    sendJson(res, 200, { ok: true });
  }));

  router.post('/api/crm/empresas/:id/fusionar', withAdmin(async ({ req, res, params, user }) => {
    const b = await readJsonBody(req);
    if (!b.origen_id) throw new HttpError(400, 'Indique la empresa que se fusiona (origen_id)');
    sendJson(res, 200, crm.fusionar(Number(params.id), Number(b.origen_id), user));
  }));

  // ---------------------------------------------------------------- contactos
  router.get('/api/crm/contactos', withAuth(async ({ res, query }) => {
    const w = ['c.activo = 1'];
    const a = [];
    if (query.empresa_id) { w.push('c.empresa_id = ?'); a.push(query.empresa_id); }
    if (query.texto) { w.push('(c.nombre LIKE ? OR c.email LIKE ? OR c.cargo LIKE ? OR e.nombre LIKE ?)'); a.push(...Array(4).fill(`%${query.texto}%`)); }
    sendJson(res, 200, db.prepare(
      `SELECT c.*, e.nombre AS empresa_nombre,
         (SELECT MAX(COALESCE(x.completada_en, x.fecha_programada)) FROM crm_actividades x WHERE x.contacto_id = c.id AND x.completada = 1) AS ultimo_contacto
       FROM crm_contactos c JOIN crm_empresas e ON e.id = c.empresa_id WHERE ${w.join(' AND ')} ORDER BY e.nombre, c.es_principal DESC, c.nombre`
    ).all(...a));
  }));

  router.post('/api/crm/contactos', withAdmin(async ({ req, res, user }) => {
    sendJson(res, 201, guardarContacto({ b: await readJsonBody(req), user }));
  }));

  router.put('/api/crm/contactos/:id', withAdmin(async ({ req, res, params, user }) => {
    sendJson(res, 200, guardarContacto({ b: await readJsonBody(req), user, id: Number(params.id) }));
  }));

  // Borrado logico: el contacto puede estar en actividades y correos pasados.
  router.del('/api/crm/contactos/:id', withAdmin(async ({ res, params, user }) => {
    const c = db.prepare('SELECT * FROM crm_contactos WHERE id = ?').get(params.id);
    if (!c) throw new HttpError(404, 'No existe ese contacto');
    db.prepare('UPDATE crm_contactos SET activo = 0, es_principal = 0 WHERE id = ?').run(c.id);
    registrar({ usuario: user, accion: 'ELIMINAR', entidad: 'crm_contactos', entidadId: c.id, valorAnterior: c.nombre });
    sendJson(res, 200, { ok: true });
  }));

  // ---------------------------------------------------------------- negocios
  router.get('/api/crm/negocios', withAuth(async ({ res, query }) => {
    sendJson(res, 200, crm.listarNegocios({
      empresaId: entero(query.empresa_id), cotizacionId: entero(query.cotizacion_id), etapa: texto(query.etapa),
      responsableId: entero(query.responsable_id), texto: texto(query.texto), abiertos: Boolean(query.abiertos),
    }));
  }));

  router.post('/api/crm/negocios', withAdmin(async ({ req, res, user }) => {
    const b = await readJsonBody(req);
    const d = datosNegocio(b);
    const etapa = crm.NOMBRES_ETAPAS.includes(b.etapa) && crm.ETAPAS_ABIERTAS.includes(b.etapa) ? b.etapa : 'Previsita';
    const n = crm.crearNegocio({ ...d, empresaId: d.empresa_id, nombre: d.nombre, etapa, fechaInicio: fecha(b.fecha_inicio), origen: d.origen || 'Manual', usuario: user });
    if (b.cotizacion_numero) {
      const c = db.prepare('SELECT id, negocio_id FROM cotizaciones WHERE upper(numero) = upper(?)').get(String(b.cotizacion_numero).trim());
      if (c) {
        db.prepare('UPDATE cotizaciones SET negocio_id = ? WHERE id = ?').run(n.id, c.id);
        crm.avanzarNegocio(db.prepare('SELECT * FROM crm_negocios WHERE id = ?').get(n.id), { negociosAvanzados: 0 });
      }
    }
    sendJson(res, 201, crm.getNegocio(n.id));
  }));

  router.get('/api/crm/negocios/:id', withAuth(async ({ res, params }) => {
    const n = crm.getNegocio(params.id);
    if (!n) throw new HttpError(404, 'No existe ese negocio');
    sendJson(res, 200, n);
  }));

  router.put('/api/crm/negocios/:id', withAdmin(async ({ req, res, params, user }) => {
    const antes = negocioOError(params.id);
    const d = datosNegocio(await readJsonBody(req), antes);
    db.prepare(
      `UPDATE crm_negocios SET empresa_id=?, contacto_id=?, nombre=?, valor_estimado=?, probabilidad=?, fecha_cierre_esperada=?,
         origen=?, responsable_id=?, descripcion=?, motivo_perdida=?, actualizado_en=datetime('now') WHERE id=?`
    ).run(d.empresa_id, d.contacto_id, d.nombre, d.valor_estimado, d.probabilidad, d.fecha_cierre_esperada, d.origen, d.responsable_id, d.descripcion, d.motivo_perdida, antes.id);
    if (d.empresa_id !== antes.empresa_id) db.prepare('UPDATE crm_actividades SET empresa_id = ? WHERE negocio_id = ?').run(d.empresa_id, antes.id);
    registrarCambios({ usuario: user, entidad: 'crm_negocios', entidadId: antes.id, antes, despues: db.prepare('SELECT * FROM crm_negocios WHERE id = ?').get(antes.id), ignorar: ['actualizado_en'] });
    sendJson(res, 200, crm.getNegocio(antes.id));
  }));

  router.put('/api/crm/negocios/:id/etapa', withAdmin(async ({ req, res, params, user }) => {
    const n = negocioOError(params.id);
    const b = await readJsonBody(req);
    const cuando = fecha(b.fecha) ? `${fecha(b.fecha)}T${crm.ahoraColombia().slice(11)}` : null;
    crm.cambiarEtapa(n, b.etapa, { usuario: user, motivo: texto(b.motivo_perdida, 200), fecha: cuando });
    sendJson(res, 200, crm.getNegocio(n.id));
  }));

  // Vincula (o quita) una cotizacion al negocio y aplica de una las senales.
  router.post('/api/crm/negocios/:id/cotizaciones', withAdmin(async ({ req, res, params, user }) => {
    const n = negocioOError(params.id);
    const b = await readJsonBody(req);
    const c = db.prepare('SELECT id, numero, negocio_id, empresa_id FROM cotizaciones WHERE upper(numero) = upper(?)').get(String(b.numero || '').trim());
    if (!c) throw new HttpError(400, `No existe la cotización ${b.numero}`);
    if (b.quitar) {
      if (c.negocio_id !== n.id) throw new HttpError(400, `${c.numero} no está en este negocio`);
      db.prepare('UPDATE cotizaciones SET negocio_id = NULL WHERE id = ?').run(c.id);
      registrar({ usuario: user, accion: 'EDITAR', entidad: 'crm_negocios', entidadId: n.id, campo: 'cotizaciones', valorAnterior: c.numero, valorNuevo: null });
    } else {
      if (c.empresa_id && c.empresa_id !== n.empresa_id) {
        const e = db.prepare('SELECT nombre FROM crm_empresas WHERE id = ?').get(c.empresa_id);
        throw new HttpError(400, `${c.numero} es de ${e ? e.nombre : 'otra empresa'}, no de la empresa de este negocio`);
      }
      const anterior = c.negocio_id;
      db.prepare('UPDATE cotizaciones SET negocio_id = ?, empresa_id = COALESCE(empresa_id, ?) WHERE id = ?').run(n.id, n.empresa_id, c.id);
      registrar({ usuario: user, accion: 'EDITAR', entidad: 'crm_negocios', entidadId: n.id, campo: 'cotizaciones', valorNuevo: c.numero });
      // El negocio automatico que queda sin cotizaciones sobra: se elimina.
      if (anterior && anterior !== n.id) {
        const viejo = db.prepare('SELECT * FROM crm_negocios WHERE id = ?').get(anterior);
        const quedan = db.prepare('SELECT COUNT(*) AS k FROM cotizaciones WHERE negocio_id = ?').get(anterior).k;
        const conActividad = db.prepare('SELECT COUNT(*) AS k FROM crm_actividades WHERE negocio_id = ?').get(anterior).k;
        if (viejo && viejo.auto && !quedan && !conActividad) {
          db.prepare('DELETE FROM crm_negocios WHERE id = ?').run(anterior);
          registrar({ usuario: user, accion: 'ELIMINAR', entidad: 'crm_negocios', entidadId: anterior, valorAnterior: viejo.nombre, valorNuevo: `Unido al negocio #${n.id}` });
        }
      }
      crm.avanzarNegocio(db.prepare('SELECT * FROM crm_negocios WHERE id = ?').get(n.id), { negociosAvanzados: 0 });
    }
    sendJson(res, 200, crm.getNegocio(n.id));
  }));

  router.del('/api/crm/negocios/:id', withAdmin(async ({ res, params, user }) => {
    const n = negocioOError(params.id);
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE cotizaciones SET negocio_id = NULL WHERE negocio_id = ?').run(n.id);
      db.prepare('UPDATE crm_actividades SET negocio_id = NULL WHERE negocio_id = ?').run(n.id);
      db.prepare('DELETE FROM crm_negocios WHERE id = ?').run(n.id);
      registrar({ usuario: user, accion: 'ELIMINAR', entidad: 'crm_negocios', entidadId: n.id, valorAnterior: n.nombre });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    sendJson(res, 200, { ok: true, aviso: n.auto ? 'Era automático: sus cotizaciones de 2026 volverán a generar un negocio en la próxima sincronización. Para unirlas a otro negocio, vincúlelas allí.' : null });
  }));

  // ---------------------------------------------------------------- actividades
  router.get('/api/crm/actividades', withAuth(async ({ res, query }) => {
    sendJson(res, 200, crm.listarActividades({
      empresaId: entero(query.empresa_id), negocioId: entero(query.negocio_id), contactoId: entero(query.contacto_id),
      desde: fecha(query.desde) ? `${fecha(query.desde)}T00:00` : null, hasta: fecha(query.hasta),
      pendientes: Boolean(query.pendientes), responsableId: entero(query.responsable_id), limite: entero(query.limite),
    }));
  }));

  router.post('/api/crm/actividades', withAdmin(async ({ req, res, user }) => {
    const d = datosActividad(await readJsonBody(req));
    const info = db.prepare(
      `INSERT INTO crm_actividades (tipo, asunto, descripcion, empresa_id, contacto_id, negocio_id, fecha_programada, duracion_min,
         completada, completada_en, resultado, responsable_id, creado_por) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(d.tipo, d.asunto, d.descripcion, d.empresa_id, d.contacto_id, d.negocio_id, d.fecha_programada, d.duracion_min,
      d.completada, d.completada ? crm.ahoraColombia() : null, d.resultado, d.responsable_id || user.id, user.id);
    registrar({ usuario: user, accion: 'CREAR', entidad: 'crm_actividades', entidadId: info.lastInsertRowid, valorNuevo: `${d.tipo}: ${d.asunto}` });
    sendJson(res, 201, db.prepare('SELECT * FROM crm_actividades WHERE id = ?').get(info.lastInsertRowid));
  }));

  router.put('/api/crm/actividades/:id', withAdmin(async ({ req, res, params, user }) => {
    const antes = db.prepare('SELECT * FROM crm_actividades WHERE id = ?').get(params.id);
    if (!antes) throw new HttpError(404, 'No existe esa actividad');
    const d = datosActividad(await readJsonBody(req), antes);
    const completadaEn = d.completada ? (antes.completada_en || crm.ahoraColombia()) : null;
    db.prepare(
      `UPDATE crm_actividades SET tipo=?, asunto=?, descripcion=?, empresa_id=?, contacto_id=?, negocio_id=?, fecha_programada=?, duracion_min=?,
         completada=?, completada_en=?, resultado=?, responsable_id=? WHERE id=?`
    ).run(d.tipo, d.asunto, d.descripcion, d.empresa_id, d.contacto_id, d.negocio_id, d.fecha_programada, d.duracion_min,
      d.completada, completadaEn, d.resultado, d.responsable_id, antes.id);
    registrarCambios({ usuario: user, entidad: 'crm_actividades', entidadId: antes.id, antes, despues: db.prepare('SELECT * FROM crm_actividades WHERE id = ?').get(antes.id), ignorar: ['completada_en'] });
    sendJson(res, 200, db.prepare('SELECT * FROM crm_actividades WHERE id = ?').get(antes.id));
  }));

  router.del('/api/crm/actividades/:id', withAdmin(async ({ res, params, user }) => {
    const a = db.prepare('SELECT * FROM crm_actividades WHERE id = ?').get(params.id);
    if (!a) throw new HttpError(404, 'No existe esa actividad');
    db.prepare('DELETE FROM crm_actividades WHERE id = ?').run(a.id);
    registrar({ usuario: user, accion: 'ELIMINAR', entidad: 'crm_actividades', entidadId: a.id, valorAnterior: `${a.tipo}: ${a.asunto}` });
    sendJson(res, 200, { ok: true });
  }));

  // Archivo .ics: al abrirlo, Outlook agrega la actividad al calendario de quien
  // lo abre. La plataforma no envia invitaciones.
  router.get('/api/crm/actividades/:id/ics', withAuth(async ({ res, params }) => {
    const [a] = db.prepare('SELECT id FROM crm_actividades WHERE id = ?').all(params.id);
    if (!a) throw new HttpError(404, 'No existe esa actividad');
    const x = crm.listarActividades({}).find((y) => y.id === a.id);
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="actividad-${a.id}.ics"`,
    });
    res.end(crm.icsActividad(x));
  }));

  // ---------------------------------------------------------------- Excel
  router.get('/api/crm/exportar.xlsx', withAuth(async ({ res }) => {
    const empresas = crm.listarEmpresas({});
    const contactos = db.prepare(`SELECT c.*, e.nombre AS empresa, e.nit AS nit_empresa FROM crm_contactos c JOIN crm_empresas e ON e.id = c.empresa_id WHERE c.activo = 1 ORDER BY e.nombre, c.nombre`).all();
    const negocios = crm.listarNegocios({});
    const actividades = crm.listarActividades({});
    const r = Math.round;
    enviarXlsx(res, 'crm-proenergy.xlsx', writeXlsxMultiSheet([
      {
        name: 'Empresas',
        headers: ['Nombre', 'NIT', 'Tipo', 'Sector', 'Ciudad', 'Dirección', 'Teléfono', 'Web', 'Dominio de correo', 'Origen', 'Responsable', 'Contactos', 'Negocios abiertos', 'Cotizaciones', 'Facturado 12 meses', 'Cartera', 'Última factura', 'Último contacto', 'Notas'],
        rows: empresas.map((e) => [e.nombre, e.nit, e.tipo, e.sector, e.ciudad, e.direccion, e.telefono, e.web, e.dominio_correo, e.origen, e.responsable_nombre, e.n_contactos, e.negocios_abiertos, e.n_cotizaciones, r(e.facturado_12m), r(e.cartera), e.ultima_factura, e.ultimo_contacto, e.notas].map((v) => v ?? '')),
      },
      {
        name: 'Contactos',
        headers: ['Empresa', 'NIT empresa', 'Nombre', 'Cargo', 'Rol', 'Email', 'Teléfono', 'Celular', 'Principal', 'Notas'],
        rows: contactos.map((c) => [c.empresa, c.nit_empresa, c.nombre, c.cargo, c.rol, c.email, c.telefono, c.celular, c.es_principal ? 'Sí' : 'No', c.notas].map((v) => v ?? '')),
      },
      {
        name: 'Negocios',
        headers: ['Negocio', 'Empresa', 'Etapa', 'Días en etapa', 'Valor con IVA', 'Valor sin IVA', 'Probabilidad', 'Ponderado sin IVA', 'Cotizaciones', 'Inicio', 'Cierre esperado', 'Cierre real', 'Motivo de pérdida', 'Origen', 'Responsable', 'Automático'],
        rows: negocios.map((n) => [n.nombre, n.empresa_nombre, n.etapa, n.dias_en_etapa, r(n.valor_con_iva), r(n.valor_sin_iva), n.probabilidad_efectiva, r(n.valor_ponderado), n.cotizaciones.map((c) => c.numero).join(', '), n.fecha_inicio, n.fecha_cierre_esperada, n.fecha_cierre_real, n.motivo_perdida, n.origen, n.responsable_nombre, n.auto ? 'Sí' : 'No'].map((v) => v ?? '')),
      },
      {
        name: 'Actividades',
        headers: ['Fecha', 'Tipo', 'Asunto', 'Empresa', 'Contacto', 'Negocio', 'Estado', 'Resultado', 'Descripción', 'Responsable'],
        rows: actividades.map((a) => [a.fecha_programada || a.creado_en, a.tipo, a.asunto, a.empresa_nombre, a.contacto_nombre, a.negocio_nombre, a.tipo === 'Nota' ? 'Nota' : a.completada ? 'Completada' : a.vencida ? 'Vencida' : 'Pendiente', a.resultado, a.descripcion, a.responsable_nombre].map((v) => v ?? '')),
      },
    ]));
  }));

  router.get('/api/crm/plantilla.xlsx', withAuth(async ({ res, query }) => {
    const contactos = query.tipo === 'contactos';
    enviarXlsx(res, contactos ? 'plantilla-contactos.xlsx' : 'plantilla-empresas.xlsx', writeXlsxMultiSheet([contactos
      ? { name: 'Contactos', headers: ['Empresa', 'NIT empresa', 'Nombre', 'Cargo', 'Rol', 'Email', 'Teléfono', 'Celular', 'Principal', 'Notas'], rows: [['RUITOQUE S.A. E.S.P.', '804001062', 'Nombre Apellido', 'Jefe de mantenimiento', 'Técnico', 'nombre@empresa.com', '6076000000', '3000000000', 'Sí', '']] }
      : { name: 'Empresas', headers: ['Nombre', 'NIT', 'Tipo', 'Sector', 'Ciudad', 'Dirección', 'Teléfono', 'Web', 'Dominio de correo', 'Origen', 'Responsable', 'Notas'], rows: [['EMPRESA EJEMPLO S.A.S.', '900000000', 'Prospecto', 'Hotelería', 'Bucaramanga', 'Calle 1 # 2-3', '6070000000', 'www.ejemplo.com', 'ejemplo.com', 'Referido', 'admin', '']] }]));
  }));

  router.post('/api/crm/importar', withAdmin(async ({ req, res, query, user }) => {
    const buf = await readBody(req);
    if (!buf.length) throw new HttpError(400, 'El archivo está vacío');
    let filas;
    try {
      filas = query.formato === 'csv' ? parseCsv(buf.toString('utf8')) : readXlsxFirstSheetAsObjects(buf);
    } catch (e) {
      throw new HttpError(400, `No se pudo leer el archivo: ${e.message}`);
    }
    if (filas.length > 5000) throw new HttpError(400, 'Máximo 5.000 filas por archivo');
    let r;
    if (query.tipo === 'empresas') r = importarEmpresas(filas, user);
    else if (query.tipo === 'contactos') r = importarContactos(filas, user);
    else throw new HttpError(400, 'Tipo de importación no reconocido (empresas o contactos)');
    sendJson(res, 200, { filas: filas.length, ...r });
  }));
};
