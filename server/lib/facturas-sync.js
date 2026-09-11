'use strict';
// Sincronizacion de facturas de venta de Siigo hacia la tabla local, compartida
// por la ruta manual (POST /api/facturas/sincronizar) y por el programador
// automatico (lib/scheduler.js), para que las dos apliquen las mismas reglas.
// Se puede correr cuantas veces se quiera: no duplica (upsert por
// siigo_invoice_id) y refresca saldos, estados y observaciones.

const db = require('../db');
const siigo = require('./siigo');
const vinculo = require('./facturas-vinculo');
const sync = require('./siigo-sync');
const { todayStr } = require('./dates');
const { tituloDeObservaciones } = require('./titulo');

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

// Trae e inserta/actualiza todas las facturas de Siigo creadas entre desde y
// hasta (YYYY-MM-DD) y, con las observaciones ya guardadas, intenta vincular
// cada una con su cotizacion (solo donde el numero encontrado existe de verdad).
async function sincronizarFacturas({ desde = '2000-01-01', hasta = todayStr() } = {}) {
  const createdStart = desde;
  const createdEnd = hasta;
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
  return { ok: true, totalSincronizadas, vinculo: resultadoVinculo };
}

module.exports = { sincronizarFacturas, nombreClienteFactura, fechaVencimiento, ordenDelCliente };
