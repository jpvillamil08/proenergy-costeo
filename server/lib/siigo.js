'use strict';
// Cliente minimo para la API de Siigo (https://developers.siigo.com).
// Usa fetch nativo de Node (no requiere ninguna libreria externa).
//
// Requiere tres variables de entorno (se configuran en Railway > Variables,
// NUNCA escritas en este archivo):
//   SIIGO_USERNAME     -> "Usuario API" que muestra Siigo
//   SIIGO_ACCESS_KEY   -> "Access Key" que muestra Siigo
//   SIIGO_PARTNER_ID   -> "Partner-Id" que muestra Siigo
//
// Si esas variables no estan configuradas, todas las funciones de este
// modulo lanzan un error claro en vez de fallar de forma confusa.

const BASE_URL = 'https://api.siigo.com';

function config() {
  const username = process.env.SIIGO_USERNAME;
  const accessKey = process.env.SIIGO_ACCESS_KEY;
  const partnerId = process.env.SIIGO_PARTNER_ID;
  if (!username || !accessKey || !partnerId) {
    const err = new Error(
      'La conexion con Siigo no esta configurada. Faltan las variables de entorno ' +
      'SIIGO_USERNAME, SIIGO_ACCESS_KEY y/o SIIGO_PARTNER_ID (Railway > Variables).'
    );
    err.status = 400;
    throw err;
  }
  return { username, accessKey, partnerId };
}

// Cache del token en memoria del proceso (no se guarda en la base de datos:
// es valido solo unas horas y se puede volver a pedir sin problema).
let tokenCache = { value: null, expiraEn: 0 };

async function obtenerToken() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiraEn) return tokenCache.value;

  const { username, accessKey, partnerId } = config();
  const res = await fetch(`${BASE_URL}/auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'PROENERGY-Costeo-App/1.0 (+https://proenergy-costeo-production.up.railway.app)',
      'Partner-Id': partnerId,
    },
    body: JSON.stringify({ username, access_key: accessKey }),
  });
  const textoCrudo = await res.text();
  let data = {};
  try { data = textoCrudo ? JSON.parse(textoCrudo) : {}; } catch (e) { /* respuesta no era JSON */ }
  if (!res.ok || !data.access_token) {
    const detalle = data.message || textoCrudo || '(sin cuerpo de respuesta)';
    const err = new Error(`Siigo rechazo la autenticacion (HTTP ${res.status}): ${detalle}`);
    err.status = 502;
    throw err;
  }
  tokenCache = {
    value: data.access_token,
    // Refresca 5 minutos antes de que expire de verdad, por seguridad.
    expiraEn: now + Math.max((data.expires_in || 3600) - 300, 60) * 1000,
  };
  return tokenCache.value;
}

async function siigoFetch(pathAndQuery, opts = {}) {
  const { partnerId } = config();
  const token = await obtenerToken();
  const res = await fetch(`${BASE_URL}${pathAndQuery}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'PROENERGY-Costeo-App/1.0',
      Authorization: `Bearer ${token}`,
      'Partner-Id': partnerId,
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`Siigo respondio con error (HTTP ${res.status}): ${(data && (data.message || JSON.stringify(data))) || 'sin detalle'}`);
    err.status = 502;
    throw err;
  }
  return data;
}

// Lista cotizaciones de Siigo. Parametros opcionales: createdStart, createdEnd (YYYY-MM-DD), page, pageSize.
async function listarCotizaciones({ createdStart, createdEnd, page = 1, pageSize = 25 } = {}) {
  const qs = new URLSearchParams();
  if (createdStart) qs.set('created_start', createdStart);
  if (createdEnd) qs.set('created_end', createdEnd);
  qs.set('page', String(page));
  qs.set('page_size', String(pageSize));
  return siigoFetch(`/v1/quotations?${qs.toString()}`);
}

async function obtenerCotizacion(id) {
  return siigoFetch(`/v1/quotations/${encodeURIComponent(id)}`);
}

async function obtenerCliente(id) {
  return siigoFetch(`/v1/customers/${encodeURIComponent(id)}`);
}

// Lista facturas de venta de Siigo. Mismos parametros que listarCotizaciones.
async function listarFacturas({ createdStart, createdEnd, page = 1, pageSize = 100 } = {}) {
  const qs = new URLSearchParams();
  if (createdStart) qs.set('created_start', createdStart);
  if (createdEnd) qs.set('created_end', createdEnd);
  qs.set('page', String(page));
  qs.set('page_size', String(pageSize));
  return siigoFetch(`/v1/invoices?${qs.toString()}`);
}

async function obtenerFactura(id) {
  return siigoFetch(`/v1/invoices/${encodeURIComponent(id)}`);
}

// Nombre legible de un cliente de Siigo (persona o empresa).
function nombreCliente(cliente) {
  if (!cliente) return '';
  if (cliente.name && Array.isArray(cliente.name)) return cliente.name.filter(Boolean).join(' ');
  if (cliente.commercial_name) return cliente.commercial_name;
  return cliente.identification || 'Cliente sin nombre';
}

module.exports = {
  listarCotizaciones, obtenerCotizacion, listarFacturas, obtenerFactura, obtenerCliente, nombreCliente,
  configurada: () => {
    try { config(); return true; } catch (e) { return false; }
  },
};
