'use strict';
const db = require('../db');
const { sendJson } = require('../lib/http-helpers');
const { withAuth, withAdmin } = require('../lib/guard');
const { todayStr, addDays, diffDays } = require('../lib/dates');
const siigo = require('../lib/siigo');
const { vigenteEn: politicaVigenteEn } = require('./politicas.routes');
const vinculo = require('../lib/facturas-vinculo');
const sync = require('../lib/siigo-sync');
const { tituloDeObservaciones } = require('../lib/titulo');

// Nombre de cliente de una factura de Siigo.
//
// OJO: el objeto "customer" embebido en cada factura de /v1/invoices NO trae el
// nombre, solo {id, identification, branch_office}. Antes se le pasaba directo a
// siigo.nombreCliente(), que al no encontrar nombre caia en el ultimo caso y
// devolvia la identificacion: por eso todas las facturas quedaron guardadas con
// el NIT ("804001062") en vez del nombre del cliente, y asi se veian en la
// pantalla de Facturas y en el top de clientes de Estadisticas.
//
// El nombre real hay que pedirlo a /v1/customers/{id}; sync.nombreClientePorId
// ya lo hace y cachea el resultado, asi que un cliente se consulta una sola vez
// por corrida aunque tenga cincuenta facturas.
async function nombreClienteFactura(f) {
  const id = f && f.customer && f.customer.id;
  if (id) {
    const nombre = await sync.nombreClientePorId(id);
    if (nombre && !/^\s*\d+\s*$/.test(nombre)) return nombre;
  }
  // Sin id o sin nombre utilizable: al menos se conserva la identificacion.
  if (f && f.customer) return siigo.nombreCliente(f.customer);
  return 'Cliente sin identificar';
}

// Vencimiento de una factura de Siigo. Se acepta f.due_date por si alguna vez
// viniera en el primer nivel, pero la fuente real son las cuotas de f.payments.
function fechaVencimiento(f) {
  const fechas = [];
  if (f && f.due_date) fechas.push(String(f.due_date).slice(0, 10));
  for (const p of (f && Array.isArray(f.payments) ? f.payments : [])) {
    if (p && p.due_date) fechas.push(String(p.due_date).slice(0, 10));
  }
  const validas = fechas.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!validas.length) return null;
  return validas.sort()[validas.length - 1]; // la mas tardia
}

// Orden de compra, de servicio o contrato que el cliente asigna al trabajo. Va
// escrita a mano dentro de las observaciones de la factura, en formas muy
// distintas: "ORDEN DE COMPRA 2356", "O.C. 2179", "OC2191", "ORDEN DE SERVICIO
// 88", "CONTRATO 123". Se extrae para tenerla como dato y no como parrafo.
function ordenDelCliente(observaciones) {
  const t = String(observaciones || '');
  const patrones = [
    // El \b inicial de las formas abreviadas es imprescindible: sin el,
    // "PRODUCTOS 2356" termina en "OS" y se leeria como orden de servicio.
    // Por eso la forma corta de OS exige ademas el punto ("O.S.").
    [/ORDEN\s+DE\s+SERVICIO\s*\.?\s*(?:N[o\u00b0.]*\s*)?(\d{2,7})/i, 'OS'],
    [/\bO\.\s?S\.?\s*\.?\s*(?:N[o\u00b0.]*\s*)?(\d{2,7})/i, 'OS'],
    [/ORDEN\s+DE\s+COMPRA\s*\.?\s*(?:N[o\u00b0.]*\s*)?(\d{2,7})/i, 'OC'],
    [/\bO\.?\s?C\.?\s*\.?\s*(?:N[o\u00b0.]*\s*)?(\d{2,7})/i, 'OC'],
    [/\bCONTRATO\s*\.?\s*(?:N[o\u00b0.]*\s*)?(\d{2,7})/i, 'CONTRATO'],
  ];
  const encontradas = [];
  for (const [rx, tipo] of patrones) {
    const m = t.match(rx);
    if (m) encontradas.push(`${tipo} ${m[1]}`);
  }
  // Se devuelven todas las que aparezcan: una factura puede citar la orden de
  // compra y el contrato a la vez.
  return encontradas.length ? [...new Set(encontradas)].join(' / ') : null;
}

const upsertSql = `
  INSERT INTO facturas (siigo_invoice_id, numero, cliente, fecha, vencimiento, total, saldo, estado, anulada, observaciones, orden, titulo, sincronizado_en)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
  ON CONFLICT(siigo_invoice_id) DO UPDATE SET
    numero = excluded.numero, cliente = excluded.cliente, fecha = excluded.fecha, vencimiento = excluded.vencimiento,
    total = excluded.total, saldo = excluded.saldo, estado = excluded.estado,
    anulada = excluded.anulada, observaciones = excluded.observaciones,
    orden = excluded.orden, titulo = excluded.titulo, sincronizado_en = datetime('now')
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
        // Fecha de vencimiento real de la factura.
        //
        // OJO: Siigo NO la trae en el primer nivel del objeto. Antes se leia
        // f.due_date, que siempre es undefined, asi que las 435 facturas quedaron
        // guardadas sin vencimiento y la cartera caia siempre en el plazo asumido
        // de 30 dias desde la emision: eso inflaba la cartera vencida (marcaba el
        // 77% del saldo como vencido). La fecha real viene en cada cuota, dentro
        // de f.payments[].due_date.
        //
        // Con varias cuotas se toma la MAS TARDIA: es la fecha en que la factura
        // deberia estar totalmente pagada, y usarla evita marcar como vencido un
        // saldo que todavia tiene cuotas por vencer.
        const vencimiento = fechaVencimiento(f);
        upsert.run(
          String(f.id), f.name || String(f.number || f.id), await nombreClienteFactura(f),
          (f.date || '').slice(0, 10), vencimiento, total, saldo, estado, anulada,
          f.observations || null, ordenDelCliente(f.observations), tituloDeObservaciones(f.observations)
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
    // Con las observaciones ya guardadas, se intenta vincular cada factura con
    // su cotizacion. Solo vincula donde el numero encontrado existe de verdad.
    const resultadoVinculo = vinculo.vincular({ soloSimular: false });
    sendJson(res, 200, { ok: true, totalSincronizadas, vinculo: resultadoVinculo });
  }));

  // Diagnostico del vinculo factura-cotizacion, sin escribir nada: dice cuantas
  // facturas traen el numero de cotizacion en sus observaciones y cuantas no.
  router.get('/api/facturas/vinculo', withAdmin(async ({ res }) => {
    sendJson(res, 200, vinculo.vincular({ soloSimular: true, soloSinVinculo: false }));
  }));

  // Vuelve a correr el vinculo sobre las facturas ya sincronizadas (util si se
  // corrigieron observaciones en Siigo o se importaron cotizaciones nuevas).
  router.post('/api/facturas/vincular', withAdmin(async ({ res, query }) => {
    sendJson(res, 200, vinculo.vincular({ soloSimular: false, soloSinVinculo: query.todas !== '1' }));
  }));

  // Lista facturas locales dentro de un rango (por defecto, ultimo año).
  router.get('/api/facturas', withAuth(async ({ res, query }) => {
    const desde = query.desde || addDays(todayStr(), -365);
    const hasta = query.hasta || todayStr();
    // Se trae tambien el numero de la cotizacion vinculada, para mostrarlo en
    // la tabla sin que el frontend tenga que cruzar nada.
    const rows = db.prepare(
      `SELECT f.*, c.numero AS cotizacion_numero FROM facturas f
       LEFT JOIN cotizaciones c ON c.id = f.cotizacion_id
       WHERE f.fecha BETWEEN ? AND ? ORDER BY f.fecha DESC`
    ).all(desde, hasta);
    // El titulo se calcula desde las observaciones ya guardadas, para que las
    // facturas sincronizadas antes de existir la columna lo muestren sin
    // esperar a la siguiente sincronizacion.
    for (const r of rows) r.titulo = tituloDeObservaciones(r.observaciones);
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
