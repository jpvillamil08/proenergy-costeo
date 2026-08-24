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

CREATE INDEX IF NOT EXISTS idx_mo_cot ON cotizacion_mano_obra(cotizacion_id);
CREATE INDEX IF NOT EXISTS idx_mat_cot ON cotizacion_materiales(cotizacion_id);
CREATE INDEX IF NOT EXISTS idx_pagos_cot ON pagos(cotizacion_id);
CREATE INDEX IF NOT EXISTS idx_cxp_cot ON cuentas_por_pagar(cotizacion_id);
CREATE INDEX IF NOT EXISTS idx_aud_fecha ON auditoria(fecha);
`;

db.exec(SCHEMA);

module.exports = db;
