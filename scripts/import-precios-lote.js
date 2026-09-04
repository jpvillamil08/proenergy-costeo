'use strict';
// Carga puntual de la tabla de precios pegada por el usuario en el chat el
// 2026-09-04. Proveedor no especificado: se crea un proveedor placeholder
// "Proveedor nuevo (pendiente de nombre)" que el usuario debe renombrar desde
// Admin > Materiales cuando confirme de quien son estos precios.
//
// Reglas aplicadas (ver mensaje al usuario para el detalle):
// - precio pegado = precio_unitario (sin IVA), igual que el resto del catalogo;
//   precio_con_iva = precio_unitario * 1.19 (mismo criterio que data-materiales-iniciales.js).
// - Se OMITE la fila "PR $156.000" (descripcion incompleta, no se adivina que es).
// - "TORNILLO 5/8 X 12" se crea como material SIN precio (no traia precio).
// - "PLATINA GALVANIZADA Y/O RIEL CHANEL" aparecia duplicada con el mismo precio:
//   se crea una sola vez.
const db = require('../server/db');
const { registrar } = require('../server/lib/audit');

const PROVEEDOR_NOMBRE = 'Proveedor nuevo (pendiente de nombre)';

function obtenerOCrearProveedor(nombre) {
  let p = db.prepare('SELECT * FROM proveedores WHERE nombre = ?').get(nombre);
  if (p) return p;
  const info = db.prepare('INSERT INTO proveedores (nombre) VALUES (?)').run(nombre);
  registrar({ usuario: null, accion: 'CREAR', entidad: 'proveedores', entidadId: info.lastInsertRowid, valorNuevo: nombre });
  return db.prepare('SELECT * FROM proveedores WHERE id = ?').get(info.lastInsertRowid);
}

function fijarPrecio(materialId, proveedorId, precioUnitario) {
  const precioConIva = Math.round(precioUnitario * 1.19 * 100) / 100;
  const existente = db.prepare('SELECT * FROM materiales_precios WHERE material_id = ? AND proveedor_id = ?').get(materialId, proveedorId);
  if (existente) {
    db.prepare(`UPDATE materiales_precios SET precio_unitario=?, precio_con_iva=?, fecha_actualizacion=datetime('now') WHERE id=?`)
      .run(precioUnitario, precioConIva, existente.id);
    registrar({ usuario: null, accion: 'EDITAR', entidad: 'materiales_precios', entidadId: materialId, valorNuevo: `${PROVEEDOR_NOMBRE}: ${precioUnitario}` });
  } else {
    db.prepare('INSERT INTO materiales_precios (material_id, proveedor_id, precio_unitario, precio_con_iva) VALUES (?,?,?,?)')
      .run(materialId, proveedorId, precioUnitario, precioConIva);
    registrar({ usuario: null, accion: 'CREAR', entidad: 'materiales_precios', entidadId: materialId, valorNuevo: `${PROVEEDOR_NOMBRE}: ${precioUnitario}` });
  }
}

function obtenerOCrearMaterial(descripcion, unidad, categoria) {
  let m = db.prepare('SELECT * FROM materiales WHERE id = ?').get(descripcion.__id);
  return m;
}

function crearMaterial(descripcion, unidad, categoria) {
  const info = db.prepare('INSERT INTO materiales (descripcion, unidad, categoria, activo) VALUES (?,?,?,1)')
    .run(descripcion, unidad, categoria || null);
  registrar({ usuario: null, accion: 'CREAR', entidad: 'materiales', entidadId: info.lastInsertRowid, valorNuevo: descripcion });
  return db.prepare('SELECT * FROM materiales WHERE id = ?').get(info.lastInsertRowid);
}

const proveedor = obtenerOCrearProveedor(PROVEEDOR_NOMBRE);

// --- 1) Precios para materiales YA EXISTENTES (coincidencia de producto) ---
const MATCHES = [
  { id: 43, precio: 781000.0, item: 'GABINETE METALICO CERTIFICADO PARA 2 MEDIDORES' },
  { id: 27, precio: 480000.0, item: 'BLOQUE DE PRUEBA TIPO CUCHILLA MARCA FARCEL' },
  { id: 5, precio: 10200.0, item: 'CORAZA LT 1' },
  { id: 25, precio: 10200.0, item: 'CONECTOR LT Recto 1' },
  { id: 20, precio: 60409.0, item: 'CABLE CONTROL 6x12 AWG' },
  { id: 19, precio: 42273.0, item: 'CABLE CONTROL 4x12 AWG' },
  { id: 41, precio: 840.0, item: 'TERMINAL DE OJO #12 AWG AMARILLO' },
  { id: 21, precio: 9800.0, item: 'CINTA BANDIT de 3/4 mts' },
  { id: 22, precio: 2800.0, item: 'HEBILLA PARA CINTA BANDIT 3/4' },
  { id: 3, precio: 34892.0, item: 'CABLE CU N°2 DESNUDO' },
  { id: 45, precio: 11000.0, item: 'TERMINAL PONCHABLE PARA CABLE N°2 CON OJO 1/2' },
  { id: 18, precio: 213333.0, item: 'CRUCETA METALICA AUTOSOPORTADA 2,40 MTS' },
  { id: 23, precio: 11000.0, item: 'ESPARRAGOS DE 12' },
  { id: 42, precio: 157000.0, item: 'CAJA DE POLICARBONATO' },
  { id: 26, precio: 540000.0, item: 'Suministro de sistema puesta a tierra' },
];

// --- 2) Materiales NUEVOS (no existian en el catalogo) ---
const NUEVOS = [
  { descripcion: 'Transformador de corriente de baja tension 300/5 5VA', unidad: 'UND', categoria: null, precio: 352727.0 },
  { descripcion: 'Conector de perforacion 1/0 a 1/0', unidad: 'UND', categoria: null, precio: 20833.0 },
  { descripcion: 'Celda metalica para TCs', unidad: 'UND', categoria: null, precio: 500000.0 },
  { descripcion: 'Cable CU N°12 verde - Centelsa', unidad: 'MTS', categoria: null, precio: 3923.0 },
  { descripcion: 'Cable CU N°12 blanco - Centelsa', unidad: 'MTS', categoria: null, precio: 3923.0 },
  { descripcion: 'Conector Ampact 4/0 - #2 AWG', unidad: 'UND', categoria: null, precio: 29400.0 },
  { descripcion: 'Conector Ampact #2 a #2', unidad: 'UND', categoria: null, precio: 13824.0 },
  { descripcion: 'Conector Ampac tipo A', unidad: 'UND', categoria: null, precio: 23561.0 },
  { descripcion: 'Transformador de corriente para medicion, relacion 15/5', unidad: 'UND', categoria: null, precio: 2900000.0 },
  { descripcion: 'Transformador de tension 13.200/√3 : 120/√3', unidad: 'UND', categoria: null, precio: 2850000.0 },
  { descripcion: 'Transformador de corriente de baja tension 400/5 5VA tipo ventana', unidad: 'UND', categoria: null, precio: 480000.0 },
  { descripcion: 'DPS polimerico de 15kV', unidad: 'UND', categoria: null, precio: 395000.0 },
  { descripcion: 'Herraje corto para soporte en L de pararrayo', unidad: 'UND', categoria: null, precio: 21884.0 },
  { descripcion: 'Caja cortacircuito', unidad: 'UND', categoria: null, precio: 417000.0 },
  { descripcion: 'Platina galvanizada y/o riel chanel', unidad: 'UND', categoria: null, precio: 23000.0 },
  { descripcion: 'Prensa estopa de 2"', unidad: 'UND', categoria: null, precio: 7200.0 },
  { descripcion: 'Accesorios consumibles generales (tornilleria, tuercas, arandelas, cinta temflex, tomacorriente, bridas plasticas)', unidad: 'UND', categoria: null, precio: 250000.0 },
];

// --- 3) Material nuevo SIN precio (no lo traia la tabla pegada) ---
const SIN_PRECIO = [
  { descripcion: 'Tornillo 5/8 x 12', unidad: 'UND', categoria: null },
];

const resumen = { precios_asignados: [], materiales_creados: [], sin_precio: [], omitidos: ['PR (descripcion incompleta, $156.000)'] };

for (const m of MATCHES) {
  fijarPrecio(m.id, proveedor.id, m.precio);
  const mat = db.prepare('SELECT descripcion FROM materiales WHERE id = ?').get(m.id);
  resumen.precios_asignados.push(`${mat.descripcion} -> $${m.precio.toLocaleString('es-CO')}`);
}

for (const n of NUEVOS) {
  const existente = db.prepare('SELECT * FROM materiales WHERE descripcion = ?').get(n.descripcion);
  const mat = existente || crearMaterial(n.descripcion, n.unidad, n.categoria);
  fijarPrecio(mat.id, proveedor.id, n.precio);
  resumen.materiales_creados.push(`${n.descripcion} -> $${n.precio.toLocaleString('es-CO')}`);
}

for (const s of SIN_PRECIO) {
  const existente = db.prepare('SELECT * FROM materiales WHERE descripcion = ?').get(s.descripcion);
  const mat = existente || crearMaterial(s.descripcion, s.unidad, s.categoria);
  resumen.sin_precio.push(s.descripcion);
}

console.log(JSON.stringify({ proveedor: proveedor.nombre, proveedor_id: proveedor.id, ...resumen }, null, 2));
