// Capa de acceso a datos - SQLite nativo de Node (node:sqlite)
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'costeo.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
// Modo de journal por defecto (un solo archivo .db): mas simple de respaldar/copiar
// para una aplicacion de un solo usuario/oficina que WAL (que deja archivos -wal/-shm).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  nombre TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('admin','gerencia')),
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  expira_en TEXT NOT NULL
);

-- Parametros de gastos fijos, versionados por fecha de vigencia
CREATE TABLE IF NOT EXISTS parametros_gastos_fijos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha_vigencia TEXT NOT NULL,
  arriendo_taller REAL NOT NULL DEFAULT 0,
  servicios_publicos REAL NOT NULL DEFAULT 0,
  internet_comunicaciones REAL NOT NULL DEFAULT 0,
  nomina_administrativa REAL NOT NULL DEFAULT 0,
  transporte_fijo REAL NOT NULL DEFAULT 0,
  depreciacion REAL NOT NULL DEFAULT 0,
  seguros_impuestos REAL NOT NULL DEFAULT 0,
  otros REAL NOT NULL DEFAULT 0,
  horas_productivas_mes REAL NOT NULL DEFAULT 1,
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Politicas comerciales, versionadas por fecha de vigencia
CREATE TABLE IF NOT EXISTS politicas_comerciales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha_vigencia TEXT NOT NULL,
  pct_utilidad_objetivo REAL NOT NULL,
  margen_minimo_aceptable REAL NOT NULL,
  pct_imprevistos REAL NOT NULL,
  pct_comision_ventas REAL NOT NULL,
  dias_credito_estandar_cliente INTEGER NOT NULL DEFAULT 0,
  pct_iva REAL NOT NULL DEFAULT 0.19,
  pct_retefuente REAL NOT NULL DEFAULT 0,
  pct_ica REAL NOT NULL DEFAULT 0,
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trabajadores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  cargo TEXT NOT NULL CHECK (cargo IN ('Tecnico','Liniero','Coordinador operativo','Conductor','Otros')),
  tipo TEXT NOT NULL CHECK (tipo IN ('Interno','Externo')),
  tarifa_hora REAL NOT NULL DEFAULT 0,
  factor_prestacional REAL DEFAULT 1,
  factura_iva INTEGER DEFAULT 0,
  aplica_retencion INTEGER DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proveedores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  nit TEXT,
  dias_credito_habituales INTEGER NOT NULL DEFAULT 0,
  contacto TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plantillas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  datos_json TEXT NOT NULL, -- snapshot lineas mano de obra + materiales
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cotizaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE NOT NULL,
  cliente TEXT NOT NULL,
  descripcion TEXT,
  fecha_cotizacion TEXT NOT NULL,
  fecha_aprobacion TEXT,
  condicion_pago TEXT NOT NULL CHECK (condicion_pago IN ('Contado','Credito')) DEFAULT 'Contado',
  dias_credito_otorgados INTEGER NOT NULL DEFAULT 0,
  precio_venta REAL NOT NULL DEFAULT 0,
  pct_anticipo REAL NOT NULL DEFAULT 0,
  estado TEXT NOT NULL CHECK (estado IN ('Borrador','Enviada','Aprobada','Rechazada','Ejecutada','Cerrada')) DEFAULT 'Borrador',
  parametros_id INTEGER REFERENCES parametros_gastos_fijos(id),
  politica_id INTEGER REFERENCES politicas_comerciales(id),
  creado_por INTEGER REFERENCES usuarios(id),
  actualizado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cotizacion_mano_obra (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cotizacion_id INTEGER NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  trabajador_id INTEGER REFERENCES trabajadores(id),
  nombre_snapshot TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('Interno','Externo')),
  tarifa_hora REAL NOT NULL DEFAULT 0,
  factor_prestacional REAL DEFAULT 1,
  horas_presupuestadas REAL NOT NULL DEFAULT 0,
  horas_reales REAL NOT NULL DEFAULT 0,
  orden INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cotizacion_materiales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cotizacion_id INTEGER NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  descripcion TEXT NOT NULL,
  clasificacion TEXT NOT NULL CHECK (clasificacion IN ('Directo','Indirecto')) DEFAULT 'Directo',
  forma_pago TEXT NOT NULL CHECK (forma_pago IN ('Contado','Credito')) DEFAULT 'Contado',
  proveedor_id INTEGER REFERENCES proveedores(id),
  dias_credito_proveedor INTEGER NOT NULL DEFAULT 0,
  fecha_compra TEXT,
  cantidad_presupuestada REAL NOT NULL DEFAULT 0,
  cantidad_real REAL NOT NULL DEFAULT 0,
  costo_unitario REAL NOT NULL DEFAULT 0,
  orden INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pagos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cotizacion_id INTEGER NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL,
  valor REAL NOT NULL,
  medio_pago TEXT NOT NULL CHECK (medio_pago IN ('Transferencia','Efectivo','Cheque')),
  referencia TEXT,
  observacion TEXT,
  creado_por INTEGER REFERENCES usuarios(id),
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cuentas_por_pagar (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cotizacion_id INTEGER REFERENCES cotizaciones(id) ON DELETE CASCADE,
  cotizacion_material_id INTEGER REFERENCES cotizacion_materiales(id) ON DELETE CASCADE,
  proveedor_id INTEGER REFERENCES proveedores(id),
  valor REAL NOT NULL,
  fecha_compra TEXT NOT NULL,
  fecha_vencimiento TEXT NOT NULL,
  pagado INTEGER NOT NULL DEFAULT 0,
  fecha_pago TEXT
);

CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER REFERENCES usuarios(id),
  usuario_nombre TEXT,
  accion TEXT NOT NULL, -- CREAR, EDITAR, ELIMINAR, LOGIN
  entidad TEXT NOT NULL,
  entidad_id INTEGER,
  campo TEXT,
  valor_anterior TEXT,
  valor_nuevo TEXT,
  fecha TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Catalogo maestro de materiales (independiente de las cotizaciones), con precios
-- por proveedor para poder comparar y elegir el mas barato al armar una cotizacion.
CREATE TABLE IF NOT EXISTS materiales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  descripcion TEXT NOT NULL,
  unidad TEXT NOT NULL DEFAULT 'UND',
  categoria TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS materiales_precios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materiales(id) ON DELETE CASCADE,
  proveedor_id INTEGER NOT NULL REFERENCES proveedores(id),
  precio_unitario REAL NOT NULL DEFAULT 0,
  precio_con_iva REAL,
  fecha_actualizacion TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(material_id, proveedor_id)
);

-- Presupuesto anual (importado desde el modelo de Excel de la empresa): estructura
-- jerarquica del P&G (ingresos, costos, gastos) con valores mes a mes, editables
-- por el admin. No recalcula subtotales automaticamente (igual que en el Excel
-- original, los totales quedan como valores propios que el admin puede ajustar).
CREATE TABLE IF NOT EXISTS presupuesto_lineas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fila INTEGER NOT NULL,
  marcador TEXT,
  etiqueta TEXT NOT NULL,
  nivel INTEGER NOT NULL DEFAULT 0,
  es_total INTEGER NOT NULL DEFAULT 0,
  orden INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presupuesto_valores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  linea_id INTEGER NOT NULL REFERENCES presupuesto_lineas(id) ON DELETE CASCADE,
  anio INTEGER NOT NULL,
  mes INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  valor REAL,
  UNIQUE(linea_id, anio, mes)
);

CREATE TABLE IF NOT EXISTS presupuesto_variables_macro (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  etiqueta TEXT NOT NULL,
  orden INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presupuesto_variables_valores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variable_id INTEGER NOT NULL REFERENCES presupuesto_variables_macro(id) ON DELETE CASCADE,
  anio INTEGER NOT NULL,
  mes INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  valor REAL,
  UNIQUE(variable_id, anio, mes)
);

-- Ventas historicas importadas del Excel (referencia, no editable desde la app):
-- por producto/servicio y por cliente, mes a mes.
CREATE TABLE IF NOT EXISTS ventas_historicas_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_codigo TEXT,
  descripcion TEXT NOT NULL,
  clasificacion TEXT,
  grupo TEXT,
  mes TEXT NOT NULL,
  valor REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ventas_historicas_cliente (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nit TEXT,
  cliente TEXT NOT NULL,
  mes TEXT,
  num_comprobantes INTEGER,
  valor_bruto REAL,
  subtotal REAL,
  impuesto_cargo REAL,
  total REAL
);

CREATE INDEX IF NOT EXISTS idx_mo_cot ON cotizacion_mano_obra(cotizacion_id);
CREATE INDEX IF NOT EXISTS idx_mat_cot ON cotizacion_materiales(cotizacion_id);
CREATE INDEX IF NOT EXISTS idx_pagos_cot ON pagos(cotizacion_id);
CREATE INDEX IF NOT EXISTS idx_cxp_cot ON cuentas_por_pagar(cotizacion_id);
CREATE INDEX IF NOT EXISTS idx_aud_fecha ON auditoria(fecha);
CREATE INDEX IF NOT EXISTS idx_matprecios_material ON materiales_precios(material_id);
CREATE INDEX IF NOT EXISTS idx_prewalores_linea ON presupuesto_valores(linea_id);
CREATE INDEX IF NOT EXISTS idx_prevalores_anio ON presupuesto_valores(anio);
CREATE INDEX IF NOT EXISTS idx_premacro_valores ON presupuesto_variables_valores(variable_id);
CREATE INDEX IF NOT EXISTS idx_ventashist_item_mes ON ventas_historicas_item(mes);
`;

db.exec(SCHEMA);

// Migraciones ligeras: agrega columnas nuevas si la base de datos ya existia
// de una version anterior (CREATE TABLE IF NOT EXISTS no altera tablas existentes).
function columnaExiste(tabla, columna) {
  return db.prepare(`PRAGMA table_info(${tabla})`).all().some((c) => c.name === columna);
}
if (!columnaExiste('cotizaciones', 'siigo_quotation_id')) {
  db.exec(`ALTER TABLE cotizaciones ADD COLUMN siigo_quotation_id TEXT;`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cot_siigo ON cotizaciones(siigo_quotation_id) WHERE siigo_quotation_id IS NOT NULL;`);
}

// Carga del catalogo inicial de materiales y precios (solo la primera vez que
// esta version corre: si la tabla materiales ya tiene datos, no hace nada, para
// no pisar ediciones que el usuario ya haya hecho en la app).
const totalMateriales = db.prepare('SELECT COUNT(*) AS n FROM materiales').get().n;
if (totalMateriales === 0) {
  const catalogoInicial = require('./data-materiales-iniciales');
  const buscarProveedor = db.prepare('SELECT * FROM proveedores WHERE lower(nombre) = lower(?)');
  const crearProveedor = db.prepare('INSERT INTO proveedores (nombre, dias_credito_habituales, activo) VALUES (?, 0, 1)');
  const crearMaterial = db.prepare('INSERT INTO materiales (descripcion, unidad, activo) VALUES (?, ?, 1)');
  const crearPrecio = db.prepare(
    'INSERT INTO materiales_precios (material_id, proveedor_id, precio_unitario, precio_con_iva) VALUES (?, ?, ?, ?)'
  );
  const idProveedorPorNombre = new Map();
  db.exec('BEGIN');
  try {
    for (const mat of catalogoInicial) {
      const infoMat = crearMaterial.run(mat.descripcion, mat.unidad || 'UND');
      for (const p of mat.precios) {
        let provId = idProveedorPorNombre.get(p.proveedor.toLowerCase());
        if (!provId) {
          const existente = buscarProveedor.get(p.proveedor);
          provId = existente ? existente.id : crearProveedor.run(p.proveedor).lastInsertRowid;
          idProveedorPorNombre.set(p.proveedor.toLowerCase(), provId);
        }
        crearPrecio.run(infoMat.lastInsertRowid, provId, p.precio_unitario, p.precio_con_iva ?? null);
      }
    }
    db.exec('COMMIT');
    console.log(`Catalogo de materiales: ${catalogoInicial.length} materiales importados desde data-materiales-iniciales.js`);
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('No se pudo importar el catalogo inicial de materiales:', e);
  }
}

// Carga del presupuesto anual y las ventas historicas (solo la primera vez que
// esta version corre: si presupuesto_lineas ya tiene datos, no hace nada, para
// no pisar ediciones que el usuario ya haya hecho en la app).
const totalLineasPresupuesto = db.prepare('SELECT COUNT(*) AS n FROM presupuesto_lineas').get().n;
if (totalLineasPresupuesto === 0) {
  const { VARIABLES_MACRO, LINEAS_PRESUPUESTO, VENTAS_HISTORICAS_ITEM, VENTAS_HISTORICAS_CLIENTE } = require('./data-presupuesto-inicial');
  const crearVariable = db.prepare('INSERT INTO presupuesto_variables_macro (etiqueta, orden) VALUES (?, ?)');
  const crearVarValor = db.prepare('INSERT INTO presupuesto_variables_valores (variable_id, anio, mes, valor) VALUES (?,?,?,?)');
  const crearLinea = db.prepare('INSERT INTO presupuesto_lineas (fila, marcador, etiqueta, nivel, es_total, orden) VALUES (?,?,?,?,?,?)');
  const crearValor = db.prepare('INSERT INTO presupuesto_valores (linea_id, anio, mes, valor) VALUES (?,?,?,?)');
  const crearVentaItem = db.prepare('INSERT INTO ventas_historicas_item (item_codigo, descripcion, clasificacion, grupo, mes, valor) VALUES (?,?,?,?,?,?)');
  const crearVentaCliente = db.prepare(
    'INSERT INTO ventas_historicas_cliente (nit, cliente, mes, num_comprobantes, valor_bruto, subtotal, impuesto_cargo, total) VALUES (?,?,?,?,?,?,?,?)'
  );
  db.exec('BEGIN');
  try {
    VARIABLES_MACRO.forEach((v, i) => {
      const info = crearVariable.run(v.etiqueta, i);
      v.valores2026.forEach((valor, mesIdx) => {
        if (valor === null || valor === undefined) return;
        crearVarValor.run(info.lastInsertRowid, 2026, mesIdx + 1, valor);
      });
    });
    LINEAS_PRESUPUESTO.forEach((l, i) => {
      const info = crearLinea.run(l.fila, l.marcador, l.etiqueta, l.nivel, l.esTotal ? 1 : 0, i);
      l.valores2026.forEach((valor, mesIdx) => {
        if (valor === null || valor === undefined) return;
        crearValor.run(info.lastInsertRowid, 2026, mesIdx + 1, valor);
      });
      l.valores2027.forEach((valor, mesIdx) => {
        if (valor === null || valor === undefined) return;
        crearValor.run(info.lastInsertRowid, 2027, mesIdx + 1, valor);
      });
    });
    const MESES_IDX = { Enero: 1, Febrero: 2, Marzo: 3, Abril: 4, Mayo: 5, Junio: 6, Julio: 7, Agosto: 8, Septiembre: 9, Octubre: 10, Noviembre: 11, Diciembre: 12 };
    VENTAS_HISTORICAS_ITEM.forEach((v) => {
      v.valores.forEach((valor, mesIdx) => {
        if (valor === null || valor === undefined) return;
        crearVentaItem.run(v.item, v.descripcion, v.clasificacion, v.grupo, String(mesIdx + 1).padStart(2, '0'), valor);
      });
    });
    VENTAS_HISTORICAS_CLIENTE.forEach((c) => {
      crearVentaCliente.run(c.nit, c.cliente, c.mes ? String(MESES_IDX[c.mes] || '').padStart(2, '0') || c.mes : null, c.numComprobantes, c.valorBruto, c.subtotal, c.impuestoCargo, c.total);
    });
    db.exec('COMMIT');
    console.log(`Presupuesto: ${LINEAS_PRESUPUESTO.length} lineas y ${VARIABLES_MACRO.length} variables macro importadas. Ventas historicas: ${VENTAS_HISTORICAS_ITEM.length} lineas por item, ${VENTAS_HISTORICAS_CLIENTE.length} por cliente.`);
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('No se pudo importar el presupuesto inicial:', e);
  }
}

module.exports = db;
