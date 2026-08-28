'use strict';
const db = require('../db');
const { sendJson } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { todayStr, addDays, diffDays } = require('../lib/dates');
const siigo = require('../lib/siigo');
const { vigenteEn: politicaVigenteEn } = require('./politicas.routes');

// Nombre de cliente de una factura de Siigo. El objeto "customer" que viene
// embebido en cada factura de /v1/invoices trae la misma forma que el cliente
// completo de /v1/customers, asi que reutilizamos siigo.nombreCliente().
function nombreClienteFactura(f) {
  if (f && f.customer) return siigo.nombreCliente(f.customer);
  return 'Cliente sin identificar';
}

const upsertSql = `
  INSERT INTO facturas (siigo_invoice_id, numero, cliente, fecha, vencimiento, total, saldo, estado, anulada, sincronizado_en)
  VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))
  ON CONFLICT(siigo_invoice_id) DO UPDATE SET
    numero = excluded.numero, cliente = excluded.cliente, fecha = excluded.fecha, vencimiento = excluded.vencimiento,
    total = excluded.total, saldo = excluded.saldo, estado = excluded.estado,
    anulada = excluded.anulada, sincronizado_en = datetime('now')
`;

module.exports = (router) => {
  router.get('/api/facturas/estado', withAdmin(async ({ res }) => {
    sendJson(res, 200, { configurada: siigo.configurada() });
  }));

  // Trae una sola factura cruda de Siigo, sin guardar nada: solo para verificar
  // que los campos que se estan leyendo (customer, total, balance, date, etc.)
  // coinciden con lo que Siigo realmente devuelve.
  router.get('/api/facturas/muestra', withAdmin(async ({ res }) => {
    const data = await siigo.listarFacturas({ page: 1, pageSize: 1 });
    sendJson(res, 200, data);
  }));

  // Sincroniza (trae e inserta/actualiza) todas las facturas de Siigo en el rango
  // dado hacia la tabla local. Se puede volver a correr cuando se quiera: no
  // duplica (upsert por siigo_invoice_id).
  router.post('/api/facturas/sincronizar', withAdmin(async ({ res, query }) => {
    const createdStart = query.desde || '2000-01-01';
    const createdEnd = query.hasta || todayStr();
    const upsert = db.prepare(upsertSql);
    let page = 1;
    let totalSincronizadas = 0;
    let totalPaginas = 1;
    while (page <= totalPaginas) {
      const data = await siigo.listarFacturas({ createdStart, createdEnd, page, pageSize: 100 });
      const results = data.results || [];
      for (const f of results) {
        const total = Number(f.total) || 0;
        const saldo = Number(f.balance) || 0;
        const anulada = f.canceled ? 1 : 0;
        const estado = anulada ? 'Anulada' : (saldo <= 0.5 ? 'Pagada' : 'Pendiente');
        // due_date: fecha de vencimiento real que reporta Siigo para la factura, si
        // la trae. No se inventa una fecha aqui: si Siigo no la reporta, queda NULL
        // y el modulo de cartera asume el plazo de credito estandar vigente.
        const vencimiento = f.due_date ? String(f.due_date).slice(0, 10) : null;
        upsert.run(
          String(f.id), f.name || String(f.number || f.id), nombreClienteFactura(f),
          (f.date || '').slice(0, 10), vencimiento, total, saldo, estado, anulada
        );
        totalSincronizadas++;
      }
      const pageSize = (data.pagination && data.pagination.page_size) || 100;
      const totalResults = (data.pagination && data.pagination.total_results) || results.length;
      totalPaginas = Math.max(1, Math.ceil(totalResults / pageSize));
      if (results.length === 0) break;
      page++;
      if (page > 100) break; // salvaguarda
    }
    sendJson(res, 200, { ok: true, totalSincronizadas });
  }));

  // Lista facturas locales dentro de un rango (por defecto, ultimo año).
  router.get('/api/facturas', withAuth(async ({ res, query }) => {
    const desde = query.desde || addDays(todayStr(), -365);
    const hasta = query.hasta || todayStr();
    const rows = db.prepare('SELECT * FROM facturas WHERE fecha BETWEEN ? AND ? ORDER BY fecha DESC').all(desde, hasta);
    sendJson(res, 200, rows);
  }));

  // Estadisticas agregadas de facturacion dentro de un rango de fechas.
  router.get('/api/facturas/estadisticas', withAuth(async ({ res, query }) => {
    const desde = query.desde || addDays(todayStr(), -365);
    const hasta = query.hasta || todayStr();
    const rows = db.prepare('SELECT * FROM facturas WHERE fecha BETWEEN ? AND ?').all(desde, hasta);
    const vigentes = rows.filter((r) => !r.anulada);
    const totalFacturado = vigentes.reduce((a, r) => a + r.total, 0);
    const totalSaldo = vigentes.reduce((a, r) => a + r.saldo, 0);

    // Cartera: saldo pendiente de las facturas vigentes. Para saber si esta
    // vencida se usa la fecha de vencimiento real de Siigo (columna
    // "vencimiento") cuando la factura la trae; si no, se asume el plazo de
    // credito estandar de la politica comercial vigente (nunca se inventa una
    // fecha de vencimiento puntual).
    const hoy = todayStr();
    const politica = politicaVigenteEn(hoy);
    const plazoAsumidoDias = (politica && politica.dias_credito_estandar_cliente) || 30;
    const pendientes = vigentes.filter((r) => r.saldo > 0.5);
    const antiguedadCartera = { Corriente: 0, '1-30': 0, '31-60': 0, '61-90': 0, '+90': 0 };
    let carteraVencida = 0;
    let usaPlazoAsumido = false;
    pendientes.forEach((r) => {
      let vencimientoEfectivo = r.vencimiento;
      if (!vencimientoEfectivo) { vencimientoEfectivo = addDays(r.fecha, plazoAsumidoDias); usaPlazoAsumido = true; }
      const diasVencido = diffDays(hoy, vencimientoEfectivo);
      let bucket;
      if (diasVencido === null || diasVencido <= 0) bucket = 'Corriente';
      else if (diasVencido <= 30) bucket = '1-30';
      else if (diasVencido <= 60) bucket = '31-60';
      else if (diasVencido <= 90) bucket = '61-90';
      else bucket = '+90';
      antiguedadCartera[bucket] += r.saldo;
      if (bucket !== 'Corriente') carteraVencida += r.saldo;
    });

    const porMesMap = {};
    const cobradoPorMesMap = {};
    for (const r of vigentes) {
      const mes = r.fecha.slice(0, 7);
      porMesMap[mes] = (porMesMap[mes] || 0) + r.total;
      cobradoPorMesMap[mes] = (cobradoPorMesMap[mes] || 0) + (r.total - r.saldo);
    }
    const porMes = Object.keys(porMesMap).sort().map((mes) => ({ mes, total: porMesMap[mes], cobrado: cobradoPorMesMap[mes] || 0 }));

    const porClienteMap = {};
    for (const r of vigentes) porClienteMap[r.cliente] = (porClienteMap[r.cliente] || 0) + r.total;
    const topClientes = Object.entries(porClienteMap)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([cliente, total]) => ({ cliente, total }));

    sendJson(res, 200, {
      desde, hasta,
      cantidad: vigentes.length, cantidadAnuladas: rows.length - vigentes.length,
      totalFacturado, totalSaldo,
      carteraPorCobrar: totalSaldo, carteraVencida, antiguedadCartera,
      usaPlazoAsumido, plazoAsumidoDias,
      porMes, topClientes,
      ultimaSincronizacion: rows.length ? rows.reduce((a, r) => (r.sincronizado_en > a ? r.sincronizado_en : a), '') : null,
    });
  }));
};
