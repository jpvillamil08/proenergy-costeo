'use strict';
// Ajuste puntual pedido por el usuario el 2026-09-04: el material "Accesorios
// consumibles..." debe quedar en $100.000 (antes había quedado en $250.000,
// tomado de la tabla de precios pegada en el chat).
//
// Es idempotente y no asume que el import anterior (import-precios-lote.js)
// ya se corrió en esta base de datos:
//   - Si el material ya existe (se busca por "accesorios consumibles" en la
//     descripcion, sin distinguir mayusculas), actualiza su(s) precio(s)
//     existentes a $100.000.
//   - Si no existe ningun material asi, lo crea con ese precio, bajo el mismo
//     proveedor placeholder usado en el import anterior.
const db = require('../server/db');
const { registrar } = require('../server/lib/audit');

const NUEVO_PRECIO = 100000.0;
const PROVEEDOR_NOMBRE = 'Proveedor nuevo (pendiente de nombre)';

function obtenerOCrearProveedor(nombre) {
  let p = db.prepare('SELECT * FROM proveedores WHERE nombre = ?').get(nombre);
  if (p) return p;
  const info = db.prepare('INSERT INTO proveedores (nombre) VALUES (?)').run(nombre);
  registrar({ usuario: null, accion: 'CREAR', entidad: 'proveedores', entidadId: info.lastInsertRowid, valorNuevo: nombre });
  return db.prepare('SELECT * FROM proveedores WHERE id = ?').get(info.lastInsertRowid);
}

const materiales = db.prepare(
  "SELECT * FROM materiales WHERE lower(descripcion) LIKE '%accesorios consumibles%'"
).all();

const resumen = [];

if (materiales.length) {
  for (const mat of materiales) {
    const precios = db.prepare('SELECT * FROM materiales_precios WHERE material_id = ?').all(mat.id);
    const precioConIva = Math.round(NUEVO_PRECIO * 1.19 * 100) / 100;
    if (precios.length) {
      for (const p of precios) {
        const anterior = p.precio_unitario;
        db.prepare(`UPDATE materiales_precios SET precio_unitario=?, precio_con_iva=?, fecha_actualizacion=datetime('now') WHERE id=?`)
          .run(NUEVO_PRECIO, precioConIva, p.id);
        registrar({ usuario: null, accion: 'EDITAR', entidad: 'materiales_precios', entidadId: mat.id, campo: 'precio_unitario', valorAnterior: String(anterior), valorNuevo: String(NUEVO_PRECIO) });
        resumen.push(`${mat.descripcion}: $${anterior.toLocaleString('es-CO')} -> $${NUEVO_PRECIO.toLocaleString('es-CO')} (proveedor_id ${p.proveedor_id})`);
      }
    } else {
      const proveedor = obtenerOCrearProveedor(PROVEEDOR_NOMBRE);
      db.prepare('INSERT INTO materiales_precios (material_id, proveedor_id, precio_unitario, precio_con_iva) VALUES (?,?,?,?)')
        .run(mat.id, proveedor.id, NUEVO_PRECIO, precioConIva);
      registrar({ usuario: null, accion: 'CREAR', entidad: 'materiales_precios', entidadId: mat.id, valorNuevo: `${proveedor.nombre}: ${NUEVO_PRECIO}` });
      resumen.push(`${mat.descripcion}: (sin precio) -> $${NUEVO_PRECIO.toLocaleString('es-CO')} (proveedor "${proveedor.nombre}")`);
    }
  }
} else {
  const proveedor = obtenerOCrearProveedor(PROVEEDOR_NOMBRE);
  const info = db.prepare('INSERT INTO materiales (descripcion, unidad, activo) VALUES (?,?,1)')
    .run('Accesorios consumibles', 'UND');
  registrar({ usuario: null, accion: 'CREAR', entidad: 'materiales', entidadId: info.lastInsertRowid, valorNuevo: 'Accesorios consumibles' });
  const precioConIva = Math.round(NUEVO_PRECIO * 1.19 * 100) / 100;
  db.prepare('INSERT INTO materiales_precios (material_id, proveedor_id, precio_unitario, precio_con_iva) VALUES (?,?,?,?)')
    .run(info.lastInsertRowid, proveedor.id, NUEVO_PRECIO, precioConIva);
  registrar({ usuario: null, accion: 'CREAR', entidad: 'materiales_precios', entidadId: info.lastInsertRowid, valorNuevo: `${proveedor.nombre}: ${NUEVO_PRECIO}` });
  resumen.push(`Material "Accesorios consumibles" creado -> $${NUEVO_PRECIO.toLocaleString('es-CO')} (proveedor "${proveedor.nombre}")`);
}

console.log(JSON.stringify({ resumen }, null, 2));
