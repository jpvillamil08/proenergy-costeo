'use strict';
const db = require('../db');
const { sendJson, readJsonBody, HttpError } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { registrar, registrarCambios } = require('../lib/audit');

// Arma cada material con su lista de precios por proveedor y el mas barato
// (mejor_precio), para que el frontend pueda pintar la tabla comparativa y
// tambien usarlo directamente al elegir un material en una cotizacion.
function materialConPrecios(material) {
  const precios = db.prepare(
    `SELECT mp.*, p.nombre AS proveedor_nombre FROM materiales_precios mp
     JOIN proveedores p ON p.id = mp.proveedor_id WHERE mp.material_id = ? ORDER BY mp.precio_unitario ASC`
  ).all(material.id);
  const mejor = precios.length ? precios[0] : null;
  return {
    ...material,
    precios,
    mejor_precio: mejor ? mejor.precio_unitario : null,
    mejor_proveedor_id: mejor ? mejor.proveedor_id : null,
    mejor_proveedor_nombre: mejor ? mejor.proveedor_nombre : null,
  };
}

module.exports = (router) => {
  router.get('/api/materiales', withAuth(async ({ res, query }) => {
    const activos = query.todos === '1' ? '' : 'WHERE activo = 1';
    const materiales = db.prepare(`SELECT * FROM materiales ${activos} ORDER BY descripcion`).all();
    sendJson(res, 200, materiales.map(materialConPrecios));
  }));

  router.post('/api/materiales', withAdmin(async ({ req, res, user }) => {
    const b = await readJsonBody(req);
    if (!b.descripcion) throw new HttpError(400, 'La descripción es obligatoria');
    const info = db.prepare('INSERT INTO materiales (descripcion, unidad, categoria, activo) VALUES (?,?,?,1)')
      .run(b.descripcion, b.unidad || 'UND', b.categoria || null);
    registrar({ usuario: user, accion: 'CREAR', entidad: 'materiales', entidadId: info.lastInsertRowid, valorNuevo: b.descripcion });
    sendJson(res, 201, materialConPrecios(db.prepare('SELECT * FROM materiales WHERE id = ?').get(info.lastInsertRowid)));
  }));

  router.put('/api/materiales/:id', withAdmin(async ({ req, res, params, user }) => {
    const antes = db.prepare('SELECT * FROM materiales WHERE id = ?').get(params.id);
    if (!antes) throw new HttpError(404, 'Material no encontrado');
    const b = await readJsonBody(req);
    db.prepare('UPDATE materiales SET descripcion=?, unidad=?, categoria=?, activo=? WHERE id=?').run(
      b.descripcion, b.unidad || 'UND', b.categoria || null, b.activo === false || b.activo === 0 ? 0 : 1, params.id
    );
    const despues = db.prepare('SELECT * FROM materiales WHERE id = ?').get(params.id);
    registrarCambios({ usuario: user, entidad: 'materiales', entidadId: params.id, antes, despues, ignorar: ['creado_en'] });
    sendJson(res, 200, materialConPrecios(despues));
  }));

  router.del('/api/materiales/:id', withAdmin(async ({ res, params, user }) => {
    db.prepare('UPDATE materiales SET activo = 0 WHERE id = ?').run(params.id);
    registrar({ usuario: user, accion: 'ELIMINAR', entidad: 'materiales', entidadId: params.id });
    sendJson(res, 200, { ok: true });
  }));

  // Crea o actualiza el precio de un material para un proveedor especifico
  // (clave unica material_id+proveedor_id: si ya existe, lo actualiza).
  router.put('/api/materiales/:id/precios/:proveedorId', withAdmin(async ({ req, res, params, user }) => {
    const material = db.prepare('SELECT * FROM materiales WHERE id = ?').get(params.id);
    if (!material) throw new HttpError(404, 'Material no encontrado');
    const proveedor = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(params.proveedorId);
    if (!proveedor) throw new HttpError(404, 'Proveedor no encontrado');
    const b = await readJsonBody(req);
    const precioUnitario = Number(b.precio_unitario);
    if (!Number.isFinite(precioUnitario) || precioUnitario < 0) throw new HttpError(400, 'precio_unitario invalido');
    const precioConIva = b.precio_con_iva !== undefined && b.precio_con_iva !== null && b.precio_con_iva !== ''
      ? Number(b.precio_con_iva) : Math.round(precioUnitario * 1.19 * 100) / 100;
    const existente = db.prepare('SELECT * FROM materiales_precios WHERE material_id = ? AND proveedor_id = ?').get(params.id, params.proveedorId);
    if (existente) {
      db.prepare(`UPDATE materiales_precios SET precio_unitario=?, precio_con_iva=?, fecha_actualizacion=datetime('now') WHERE id=?`)
        .run(precioUnitario, precioConIva, existente.id);
    } else {
      db.prepare('INSERT INTO materiales_precios (material_id, proveedor_id, precio_unitario, precio_con_iva) VALUES (?,?,?,?)')
        .run(params.id, params.proveedorId, precioUnitario, precioConIva);
    }
    registrar({ usuario: user, accion: existente ? 'EDITAR' : 'CREAR', entidad: 'materiales_precios', entidadId: material.id, valorNuevo: `${proveedor.nombre}: ${precioUnitario}` });
    sendJson(res, 200, materialConPrecios(material));
  }));

  router.del('/api/materiales/:id/precios/:proveedorId', withAdmin(async ({ res, params, user }) => {
    const material = db.prepare('SELECT * FROM materiales WHERE id = ?').get(params.id);
    if (!material) throw new HttpError(404, 'Material no encontrado');
    db.prepare('DELETE FROM materiales_precios WHERE material_id = ? AND proveedor_id = ?').run(params.id, params.proveedorId);
    registrar({ usuario: user, accion: 'ELIMINAR', entidad: 'materiales_precios', entidadId: material.id });
    sendJson(res, 200, materialConPrecios(material));
  }));
};
