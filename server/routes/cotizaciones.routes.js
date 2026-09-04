'use strict';
const db = require('../db');
const { sendJson, readJsonBody, HttpError } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { registrar, registrarCambios } = require('../lib/audit');
const svc = require('../lib/cotizacion-service');
const estimador = require('../lib/estimador');
const { vigenteEn: parametrosVigenteEn } = require('./parametros.routes');
const { vigenteEn: politicaVigenteEn } = require('./politicas.routes');
const { todayStr, addDays } = require('../lib/dates');

function resumen(full) {
  const { cot, calculo } = full;
  const c = calculo.costeoPresupuestado;
  const cart = calculo.cartera;
  return {
    id: cot.id, numero: cot.numero, cliente: cot.cliente, descripcion: cot.descripcion,
    fecha_cotizacion: cot.fecha_cotizacion, fecha_aprobacion: cot.fecha_aprobacion,
    estado: cot.estado, condicion_pago: cot.condicion_pago, dias_credito_otorgados: cot.dias_credito_otorgados,
    precio_venta: cot.precio_venta,
    costoInternoTotal: c.costoInternoTotal, utilidad: c.utilidad, margenPct: c.margenPct,
    margenContribucion: c.margenContribucion,
    horasTotales: c.horasTotales, gastosFijosAplicados: c.gastosFijosAplicados,
    semaforo: calculo.semaforo.estado,
    fechaPagoEsperada: cart.fechaPagoEsperada, diasEsperados: cart.diasEsperados,
    diasRealesCobro: cart.diasRealesCobro, desviacionDias: cart.desviacionDias,
    totalRecaudado: cart.totalRecaudado, saldoPendiente: cart.saldoPendiente, estadoPago: cart.estadoPago,
    bucket: cart.bucket, diasMora: cart.diasMora,
    riesgoLiquidez: calculo.flujoCaja.riesgoLiquidez, cajaNegativa: calculo.flujoCaja.cajaNegativa,
    desviacionHorasPct: calculo.comparativo.horas.desviacionPct,
    desviacionMaterialesPct: calculo.comparativo.materiales.desviacionPct,
  };
}

module.exports = (router) => {
  router.get('/api/cotizaciones', withAuth(async ({ res }) => {
    const list = svc.listCotizacionesFull().map(resumen);
    sendJson(res, 200, list);
  }));

  // Estadisticas de cuantas cotizaciones se crean vs. cuantas se aprueban, dentro
  // de un rango de fechas (por fecha_cotizacion). "Aprobada" para este conteo
  // significa Aprobada, Ejecutada o Cerrada (el mismo criterio que ya usa
  // /api/dashboard para la tasa de conversion global, aqui con rango de fechas
  // y desglose mes a mes).
  router.get('/api/cotizaciones/estadisticas', withAuth(async ({ res, query }) => {
    const desde = query.desde || addDays(todayStr(), -365);
    const hasta = query.hasta || todayStr();
    const APROBADAS = ['Aprobada', 'Ejecutada', 'Cerrada'];
    const rows = db.prepare(
      'SELECT id, estado, fecha_cotizacion, precio_venta FROM cotizaciones WHERE fecha_cotizacion BETWEEN ? AND ?'
    ).all(desde, hasta);

    const porEstado = {};
    for (const r of rows) porEstado[r.estado] = (porEstado[r.estado] || 0) + 1;

    const aprobadas = rows.filter((r) => APROBADAS.includes(r.estado));
    const decididas = rows.filter((r) => r.estado !== 'Borrador');
    const tasaConversionSobreDecididas = decididas.length ? aprobadas.length / decididas.length : null;
    const tasaConversionSobreTotal = rows.length ? aprobadas.length / rows.length : null;
    const valorTotalCotizado = rows.reduce((a, r) => a + (r.precio_venta || 0), 0);
    const valorAprobado = aprobadas.reduce((a, r) => a + (r.precio_venta || 0), 0);

    const porMesMap = {};
    for (const r of rows) {
      const mes = (r.fecha_cotizacion || '').slice(0, 7);
      if (!mes) continue;
      if (!porMesMap[mes]) porMesMap[mes] = { creadas: 0, aprobadas: 0 };
      porMesMap[mes].creadas++;
      if (APROBADAS.includes(r.estado)) porMesMap[mes].aprobadas++;
    }
    const porMes = Object.keys(porMesMap).sort().map((mes) => ({ mes, ...porMesMap[mes] }));

    sendJson(res, 200, {
      desde, hasta,
      total: rows.length, aprobadas: aprobadas.length, decididas: decididas.length,
      tasaConversionSobreDecididas, tasaConversionSobreTotal,
      valorTotalCotizado, valorAprobado,
      porEstado, porMes,
    });
  }));

  router.get('/api/cotizaciones/:id', withAuth(async ({ res, params }) => {
    const full = svc.getCotizacionFull(params.id);
    if (!full) throw new HttpError(404, 'Cotización no encontrada');
    sendJson(res, 200, full);
  }));

  router.post('/api/cotizaciones', withAdmin(async ({ req, res, user }) => {
    const b = await readJsonBody(req);
    if (!b.cliente) throw new HttpError(400, 'El cliente es obligatorio');
    const fecha = b.fecha_cotizacion || todayStr();
    const numero = b.numero && b.numero.trim() ? b.numero.trim() : svc.generarNumero();
    const param = parametrosVigenteEn(fecha);
    const politica = politicaVigenteEn(fecha);
    if (!param || !politica) throw new HttpError(400, 'No hay parámetros de gastos fijos o políticas comerciales vigentes para esa fecha. Configúrelos primero.');
    const info = db.prepare(
      `INSERT INTO cotizaciones (numero, cliente, descripcion, fecha_cotizacion, fecha_aprobacion, condicion_pago,
        dias_credito_otorgados, precio_venta, pct_anticipo, estado, parametros_id, politica_id, creado_por, actualizado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      numero, b.cliente, b.descripcion || '', fecha, b.fecha_aprobacion || null,
      b.condicion_pago || 'Contado', Number(b.dias_credito_otorgados) || 0, Number(b.precio_venta) || 0,
      Number(b.pct_anticipo) || 0, b.estado || 'Borrador', param.id, politica.id, user.id, user.id
    );
    registrar({ usuario: user, accion: 'CREAR', entidad: 'cotizaciones', entidadId: info.lastInsertRowid, valorNuevo: numero });
    const full = svc.getCotizacionFull(info.lastInsertRowid);
    sendJson(res, 201, full);
  }));

  // Estima materiales y precedentes de mano de obra a partir de una descripcion
  // de texto libre (se usa antes de crear la cotizacion, o para revisarla ya
  // creada). No inventa cifras: solo cruza contra el catalogo de materiales
  // real y contra cotizaciones anteriores con descripcion parecida.
  router.post('/api/cotizaciones/estimar-costos', withAuth(async ({ req, res }) => {
    const b = await readJsonBody(req);
    if (!b.descripcion || !b.descripcion.trim()) throw new HttpError(400, 'Escriba primero la descripción del trabajo.');
    const materiales = estimador.sugerirMateriales(b.descripcion);
    const precedentes = estimador.buscarPrecedentes(b.descripcion, b.excluir_id);
    sendJson(res, 200, { materiales, precedentes });
  }));

  router.put('/api/cotizaciones/:id', withAdmin(async ({ req, res, params, user }) => {
    const antes = db.prepare('SELECT * FROM cotizaciones WHERE id = ?').get(params.id);
    if (!antes) throw new HttpError(404, 'Cotización no encontrada');
    const b = await readJsonBody(req);
    db.prepare(
      `UPDATE cotizaciones SET cliente=?, descripcion=?, fecha_cotizacion=?, fecha_aprobacion=?, condicion_pago=?,
       dias_credito_otorgados=?, precio_venta=?, pct_anticipo=?, estado=?, actualizado_por=?, actualizado_en=datetime('now')
       WHERE id=?`
    ).run(
      b.cliente, b.descripcion || '', b.fecha_cotizacion, b.fecha_aprobacion || null, b.condicion_pago,
      Number(b.dias_credito_otorgados) || 0, Number(b.precio_venta) || 0, Number(b.pct_anticipo) || 0,
      b.estado, user.id, params.id
    );
    const despues = db.prepare('SELECT * FROM cotizaciones WHERE id = ?').get(params.id);
    registrarCambios({ usuario: user, entidad: 'cotizaciones', entidadId: params.id, antes, despues, ignorar: ['actualizado_en', 'creado_en'] });
    svc.syncCuentasPorPagar(params.id);
    sendJson(res, 200, svc.getCotizacionFull(params.id));
  }));

  router.del('/api/cotizaciones/:id', withAdmin(async ({ res, params, user }) => {
    const cot = db.prepare('SELECT * FROM cotizaciones WHERE id = ?').get(params.id);
    if (!cot) throw new HttpError(404, 'Cotización no encontrada');
    db.prepare('DELETE FROM cotizaciones WHERE id = ?').run(params.id);
    registrar({ usuario: user, accion: 'ELIMINAR', entidad: 'cotizaciones', entidadId: params.id, valorAnterior: cot.numero });
    sendJson(res, 200, { ok: true });
  }));

  // ---- Mano de obra ----
  router.post('/api/cotizaciones/:id/mano-obra', withAdmin(async ({ req, res, params, user }) => {
    const b = await readJsonBody(req);
    const trab = db.prepare('SELECT * FROM trabajadores WHERE id = ?').get(b.trabajador_id);
    if (!trab) throw new HttpError(400, 'Seleccione un trabajador del catálogo');
    const info = db.prepare(
      `INSERT INTO cotizacion_mano_obra (cotizacion_id, trabajador_id, nombre_snapshot, tipo, tarifa_hora, factor_prestacional, horas_presupuestadas, horas_reales)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(params.id, trab.id, trab.nombre, trab.tipo, trab.tarifa_hora, trab.factor_prestacional || 1, Number(b.horas_presupuestadas) || 0, Number(b.horas_reales) || 0);
    registrar({ usuario: user, accion: 'CREAR', entidad: 'cotizacion_mano_obra', entidadId: info.lastInsertRowid, valorNuevo: trab.nombre });
    sendJson(res, 201, svc.getCotizacionFull(params.id));
  }));

  router.put('/api/cotizaciones/:id/mano-obra/:lineId', withAdmin(async ({ req, res, params, user }) => {
    const antes = db.prepare('SELECT * FROM cotizacion_mano_obra WHERE id = ?').get(params.lineId);
    if (!antes) throw new HttpError(404, 'Línea no encontrada');
    const b = await readJsonBody(req);
    db.prepare('UPDATE cotizacion_mano_obra SET horas_presupuestadas=?, horas_reales=? WHERE id=?').run(
      Number(b.horas_presupuestadas) || 0, Number(b.horas_reales) || 0, params.lineId
    );
    registrarCambios({ usuario: user, entidad: 'cotizacion_mano_obra', entidadId: params.lineId, antes, despues: { ...antes, horas_presupuestadas: Number(b.horas_presupuestadas) || 0, horas_reales: Number(b.horas_reales) || 0 } });
    sendJson(res, 200, svc.getCotizacionFull(params.id));
  }));

  router.del('/api/cotizaciones/:id/mano-obra/:lineId', withAdmin(async ({ res, params, user }) => {
    db.prepare('DELETE FROM cotizacion_mano_obra WHERE id = ?').run(params.lineId);
    registrar({ usuario: user, accion: 'ELIMINAR', entidad: 'cotizacion_mano_obra', entidadId: params.lineId });
    sendJson(res, 200, svc.getCotizacionFull(params.id));
  }));

  // ---- Materiales ----
  router.post('/api/cotizaciones/:id/materiales', withAdmin(async ({ req, res, params, user }) => {
    const b = await readJsonBody(req);
    if (!b.descripcion) throw new HttpError(400, 'La descripción del material es obligatoria');
    let diasCredito = Number(b.dias_credito_proveedor) || 0;
    if (b.proveedor_id && !b.dias_credito_proveedor) {
      const prov = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(b.proveedor_id);
      if (prov) diasCredito = prov.dias_credito_habituales;
    }
    const info = db.prepare(
      `INSERT INTO cotizacion_materiales (cotizacion_id, descripcion, clasificacion, forma_pago, proveedor_id,
        dias_credito_proveedor, fecha_compra, cantidad_presupuestada, cantidad_real, costo_unitario)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      params.id, b.descripcion, b.clasificacion || 'Directo', b.forma_pago || 'Contado', b.proveedor_id || null,
      diasCredito, b.fecha_compra || null, Number(b.cantidad_presupuestada) || 0, Number(b.cantidad_real) || 0, Number(b.costo_unitario) || 0
    );
    registrar({ usuario: user, accion: 'CREAR', entidad: 'cotizacion_materiales', entidadId: info.lastInsertRowid, valorNuevo: b.descripcion });
    svc.syncCuentasPorPagar(params.id);
    sendJson(res, 201, svc.getCotizacionFull(params.id));
  }));

  router.put('/api/cotizaciones/:id/materiales/:lineId', withAdmin(async ({ req, res, params, user }) => {
    const antes = db.prepare('SELECT * FROM cotizacion_materiales WHERE id = ?').get(params.lineId);
    if (!antes) throw new HttpError(404, 'Línea no encontrada');
    const b = await readJsonBody(req);
    db.prepare(
      `UPDATE cotizacion_materiales SET descripcion=?, clasificacion=?, forma_pago=?, proveedor_id=?, dias_credito_proveedor=?,
       fecha_compra=?, cantidad_presupuestada=?, cantidad_real=?, costo_unitario=? WHERE id=?`
    ).run(
      b.descripcion, b.clasificacion, b.forma_pago, b.proveedor_id || null, Number(b.dias_credito_proveedor) || 0,
      b.fecha_compra || null, Number(b.cantidad_presupuestada) || 0, Number(b.cantidad_real) || 0, Number(b.costo_unitario) || 0, params.lineId
    );
    const despues = db.prepare('SELECT * FROM cotizacion_materiales WHERE id = ?').get(params.lineId);
    registrarCambios({ usuario: user, entidad: 'cotizacion_materiales', entidadId: params.lineId, antes, despues });
    svc.syncCuentasPorPagar(params.id);
    sendJson(res, 200, svc.getCotizacionFull(params.id));
  }));

  router.del('/api/cotizaciones/:id/materiales/:lineId', withAdmin(async ({ res, params, user }) => {
    db.prepare('DELETE FROM cotizacion_materiales WHERE id = ?').run(params.lineId);
    registrar({ usuario: user, accion: 'ELIMINAR', entidad: 'cotizacion_materiales', entidadId: params.lineId });
    svc.syncCuentasPorPagar(params.id);
    sendJson(res, 200, svc.getCotizacionFull(params.id));
  }));

  // ---- Aplicar plantilla ----
  router.post('/api/cotizaciones/:id/aplicar-plantilla/:plantillaId', withAdmin(async ({ res, params, user }) => {
    const plantilla = db.prepare('SELECT * FROM plantillas WHERE id = ?').get(params.plantillaId);
    if (!plantilla) throw new HttpError(404, 'Plantilla no encontrada');
    const datos = JSON.parse(plantilla.datos_json);
    for (const m of (datos.manoObra || [])) {
      const trab = db.prepare('SELECT * FROM trabajadores WHERE id = ?').get(m.trabajador_id);
      if (!trab) continue;
      db.prepare(
        `INSERT INTO cotizacion_mano_obra (cotizacion_id, trabajador_id, nombre_snapshot, tipo, tarifa_hora, factor_prestacional, horas_presupuestadas, horas_reales)
         VALUES (?,?,?,?,?,?,?,0)`
      ).run(params.id, trab.id, trab.nombre, trab.tipo, trab.tarifa_hora, trab.factor_prestacional || 1, Number(m.horas_presupuestadas) || 0);
    }
    for (const mt of (datos.materiales || [])) {
      db.prepare(
        `INSERT INTO cotizacion_materiales (cotizacion_id, descripcion, clasificacion, forma_pago, proveedor_id, dias_credito_proveedor, cantidad_presupuestada, cantidad_real, costo_unitario)
         VALUES (?,?,?,?,?,?,?,0,?)`
      ).run(params.id, mt.descripcion, mt.clasificacion || 'Directo', mt.forma_pago || 'Contado', mt.proveedor_id || null, Number(mt.dias_credito_proveedor) || 0, Number(mt.cantidad_presupuestada) || 0, Number(mt.costo_unitario) || 0);
    }
    registrar({ usuario: user, accion: 'EDITAR', entidad: 'cotizaciones', entidadId: params.id, campo: 'plantilla_aplicada', valorNuevo: plantilla.nombre });
    svc.syncCuentasPorPagar(params.id);
    sendJson(res, 200, svc.getCotizacionFull(params.id));
  }));
};

module.exports.resumen = resumen;
