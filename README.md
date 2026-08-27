'use strict';
const db = require('../db');
const { sendJson, readJsonBody, HttpError } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { registrar } = require('../lib/audit');

const ACTIVAS_INGRESO = ['Aprobada', 'Ejecutada', 'Cerrada'];
// Etiqueta de la linea del presupuesto contra la que se compara el ingreso real
// facturado por el sistema (cotizaciones aprobadas/ejecutadas/cerradas).
const ETIQUETA_INGRESOS_REAL = 'Total Ingresos Operacionales Netos';

function valoresPorMes(rows) {
  const arr = new Array(12).fill(null);
  rows.forEach((r) => { arr[r.mes - 1] = r.valor; });
  return arr;
}

// Ingreso real por mes, calculado igual que el Dashboard: suma de precio_venta
// de cotizaciones activas, agrupadas por el mes de fecha_aprobacion (o
// fecha_cotizacion si no tiene fecha de aprobacion), para el anio pedido.
function ingresosRealesPorMes(anio) {
  const cot = db.prepare(
    `SELECT precio_venta, fecha_aprobacion, fecha_cotizacion FROM cotizaciones WHERE estado IN ('Aprobada','Ejecutada','Cerrada')`
  ).all();
  const arr = new Array(12).fill(null);
  cot.forEach((c) => {
    const fecha = c.fecha_aprobacion || c.fecha_cotizacion;
    if (!fecha) return;
    const [y, m] = fecha.slice(0, 7).split('-').map(Number);
    if (y !== Number(anio)) return;
    arr[m - 1] = (arr[m - 1] || 0) + c.precio_venta;
  });
  return arr;
}

module.exports = (router) => {
  router.get('/api/presupuesto/anios', withAuth(async ({ res }) => {
    const rows = db.prepare('SELECT DISTINCT anio FROM presupuesto_valores ORDER BY anio').all();
    sendJson(res, 200, rows.map((r) => r.anio));
  }));

  router.get('/api/presupuesto/estado', withAuth(async ({ res, query }) => {
    const anio = Number(query.anio) || new Date().getFullYear();

    const macroDefs = db.prepare('SELECT * FROM presupuesto_variables_macro ORDER BY orden').all();
    const macro = macroDefs.map((v) => {
      const valores = db.prepare('SELECT mes, valor FROM presupuesto_variables_valores WHERE variable_id = ? AND anio = ?').all(v.id, anio);
      return { id: v.id, etiqueta: v.etiqueta, valores: valoresPorMes(valores) };
    });

    const lineaDefs = db.prepare('SELECT * FROM presupuesto_lineas ORDER BY orden').all();
    const lineas = lineaDefs.map((l) => {
      const valores = db.prepare('SELECT mes, valor FROM presupuesto_valores WHERE linea_id = ? AND anio = ?').all(l.id, anio);
      return {
        id: l.id, fila: l.fila, marcador: l.marcador, etiqueta: l.etiqueta,
        nivel: l.nivel, esTotal: !!l.es_total, valores: valoresPorMes(valores),
      };
    });

    const lineaIngresos = lineaDefs.find((l) => l.etiqueta === ETIQUETA_INGRESOS_REAL);
    const real = { etiquetaComparada: ETIQUETA_INGRESOS_REAL, lineaId: lineaIngresos ? lineaIngresos.id : null, porMes: ingresosRealesPorMes(anio) };

    sendJson(res, 200, { anio, macro, lineas, real });
  }));

  router.put('/api/presupuesto/lineas/:id', withAdmin(async ({ req, res, params, user }) => {
    const linea = db.prepare('SELECT * FROM presupuesto_lineas WHERE id = ?').get(params.id);
    if (!linea) throw new HttpError(404, 'Línea de presupuesto no encontrada');
    const b = await readJsonBody(req);
    const anio = Number(b.anio);
    if (!anio) throw new HttpError(400, 'anio es obligatorio');
    const valores = Array.isArray(b.valores) ? b.valores : [];
    if (valores.length !== 12) throw new HttpError(400, 'Se esperan 12 valores (uno por mes)');
    const upsert = db.prepare(
      `INSERT INTO presupuesto_valores (linea_id, anio, mes, valor) VALUES (?,?,?,?)
       ON CONFLICT(linea_id, anio, mes) DO UPDATE SET valor = excluded.valor`
    );
    db.exec('BEGIN');
    try {
      valores.forEach((v, i) => {
        const num = v === null || v === '' || v === undefined ? null : Number(v);
        upsert.run(linea.id, anio, i + 1, Number.isFinite(num) ? num : null);
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    registrar({ usuario: user, accion: 'EDITAR', entidad: 'presupuesto_lineas', entidadId: linea.id, campo: `valores_${anio}`, valorNuevo: linea.etiqueta });
    const filas = db.prepare('SELECT mes, valor FROM presupuesto_valores WHERE linea_id = ? AND anio = ?').all(linea.id, anio);
    sendJson(res, 200, { id: linea.id, anio, valores: valoresPorMes(filas) });
  }));

  router.put('/api/presupuesto/macro/:id', withAdmin(async ({ req, res, params, user }) => {
    const variable = db.prepare('SELECT * FROM presupuesto_variables_macro WHERE id = ?').get(params.id);
    if (!variable) throw new HttpError(404, 'Variable macroeconómica no encontrada');
    const b = await readJsonBody(req);
    const anio = Number(b.anio);
    if (!anio) throw new HttpError(400, 'anio es obligatorio');
    const valores = Array.isArray(b.valores) ? b.valores : [];
    if (valores.length !== 12) throw new HttpError(400, 'Se esperan 12 valores (uno por mes)');
    const upsert = db.prepare(
      `INSERT INTO presupuesto_variables_valores (variable_id, anio, mes, valor) VALUES (?,?,?,?)
       ON CONFLICT(variable_id, anio, mes) DO UPDATE SET valor = excluded.valor`
    );
    db.exec('BEGIN');
    try {
      valores.forEach((v, i) => {
        const num = v === null || v === '' || v === undefined ? null : Number(v);
        upsert.run(variable.id, anio, i + 1, Number.isFinite(num) ? num : null);
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    registrar({ usuario: user, accion: 'EDITAR', entidad: 'presupuesto_variables_macro', entidadId: variable.id, campo: `valores_${anio}`, valorNuevo: variable.etiqueta });
    const filas = db.prepare('SELECT mes, valor FROM presupuesto_variables_valores WHERE variable_id = ? AND anio = ?').all(variable.id, anio);
    sendJson(res, 200, { id: variable.id, anio, valores: valoresPorMes(filas) });
  }));

  // ---- Ventas historicas importadas del Excel (solo lectura) ----
  router.get('/api/ventas-historicas', withAuth(async ({ res }) => {
    const productos = db.prepare('SELECT * FROM ventas_historicas_item ORDER BY item_codigo, mes').all();
    const clientes = db.prepare('SELECT * FROM ventas_historicas_cliente ORDER BY cliente, mes').all();

    const porItem = {};
    productos.forEach((p) => {
      const k = p.item_codigo || p.descripcion;
      if (!porItem[k]) porItem[k] = { item: p.item_codigo, descripcion: p.descripcion, clasificacion: p.clasificacion, grupo: p.grupo, total: 0, valores: {} };
      porItem[k].valores[p.mes] = p.valor;
      porItem[k].total += p.valor;
    });

    const porCliente = {};
    clientes.forEach((c) => {
      const k = c.cliente;
      if (!porCliente[k]) porCliente[k] = { cliente: c.cliente, nit: c.nit, total: 0, comprobantes: 0, detalle: [] };
      porCliente[k].total += c.total || 0;
      porCliente[k].comprobantes += c.num_comprobantes || 0;
      porCliente[k].detalle.push({ mes: c.mes, valor_bruto: c.valor_bruto, subtotal: c.subtotal, impuesto_cargo: c.impuesto_cargo, total: c.total, num_comprobantes: c.num_comprobantes });
    });

    sendJson(res, 200, {
      productos: Object.values(porItem).sort((a, b) => b.total - a.total),
      clientes: Object.values(porCliente).sort((a, b) => b.total - a.total),
    });
  }));
};

module.exports.ingresosRealesPorMes = ingresosRealesPorMes;
