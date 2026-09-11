'use strict';
// Cliente minimo de Microsoft Graph para LEER los buzones de Outlook de la
// empresa (solo lectura: permiso de aplicacion Mail.Read). Sin librerias:
// fetch nativo de Node.
//
// La aplicacion la registra el administrador de Microsoft 365 (paso a paso en
// docs/conectar-outlook.md) y queda limitada a los buzones de CORREO_BUZONES.
// Variables de entorno (Railway > Variables, NUNCA en este archivo):
//   MS_TENANT_ID       id del directorio (tenant) de Proenergy
//   MS_CLIENT_ID       id de la aplicacion registrada
//   MS_CLIENT_SECRET   secreto de la aplicacion
//   CORREO_BUZONES     buzones a leer, separados por coma
// Sin ellas, el modulo queda apagado y lo dice (GET /api/correo/estado).

const GRAPH = 'https://graph.microsoft.com/v1.0';

function config() {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const secreto = process.env.MS_CLIENT_SECRET;
  const buzones = String(process.env.CORREO_BUZONES || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!tenant || !clientId || !secreto || !buzones.length) {
    const err = new Error(
      'La lectura del correo no esta configurada. Faltan MS_TENANT_ID, MS_CLIENT_ID, ' +
      'MS_CLIENT_SECRET y/o CORREO_BUZONES (Railway > Variables). Ver docs/conectar-outlook.md.'
    );
    err.status = 400;
    throw err;
  }
  return { tenant, clientId, secreto, buzones };
}

function configurado() {
  try { config(); return true; } catch (e) { return false; }
}

// Token de aplicacion (client credentials), cacheado en memoria hasta 5 minutos
// antes de vencer, como el de Siigo.
let token = { valor: null, vence: 0 };
async function obtenerToken() {
  if (token.valor && Date.now() < token.vence) return token.valor;
  const { tenant, clientId, secreto } = config();
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: secreto,
      scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error(`Microsoft rechazo la autenticacion (HTTP ${res.status}): ${data.error_description || data.error || 'sin detalle'}`);
    err.status = 502;
    throw err;
  }
  token = { valor: data.access_token, vence: Date.now() + Math.max((data.expires_in || 3600) - 300, 60) * 1000 };
  return token.valor;
}

async function graph(rutaOUrl) {
  const url = rutaOUrl.startsWith('http') ? rutaOUrl : GRAPH + rutaOUrl;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${await obtenerToken()}`, Prefer: 'outlook.body-content-type="text"' },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`Microsoft Graph respondio con error (HTTP ${res.status}): ${(data && data.error && data.error.message) || 'sin detalle'}`);
    err.status = 502;
    throw err;
  }
  return data;
}

// Mensajes de una carpeta ('inbox' o 'sentitems') recibidos/enviados desde
// `desde` (ISO), del mas viejo al mas nuevo, con todas las paginas.
async function mensajesDesde(buzon, carpeta, desde, { max = 500 } = {}) {
  const campoFecha = carpeta === 'sentitems' ? 'sentDateTime' : 'receivedDateTime';
  const qs = new URLSearchParams({
    $filter: `${campoFecha} ge ${desde}`,
    $orderby: `${campoFecha} asc`,
    $top: '50',
    $select: [
      'id', 'subject', 'bodyPreview', 'body', 'from', 'toRecipients', 'ccRecipients',
      'receivedDateTime', 'sentDateTime', 'hasAttachments', 'webLink', 'internetMessageHeaders', 'conversationId',
    ].join(','),
  });
  let url = `/users/${encodeURIComponent(buzon)}/mailFolders/${carpeta}/messages?${qs.toString()}`;
  const salida = [];
  while (url && salida.length < max) {
    const data = await graph(url);
    salida.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return salida;
}

// Un mensaje por su id (para reintentar los que fallaron).
async function mensaje(buzon, id) {
  return graph(`/users/${encodeURIComponent(buzon)}/messages/${encodeURIComponent(id)}?$select=id,subject,bodyPreview,body,from,toRecipients,receivedDateTime,sentDateTime,hasAttachments,webLink,conversationId`);
}

// Solo los nombres de los adjuntos (sin descargarlos), para el filtro previo.
async function nombresAdjuntos(buzon, mensajeId) {
  const data = await graph(`/users/${encodeURIComponent(buzon)}/messages/${encodeURIComponent(mensajeId)}/attachments?$select=name,size`);
  return (data.value || []).map((a) => a.name).filter(Boolean);
}

// Adjuntos de archivo de un mensaje (con su contenido en base64).
async function adjuntos(buzon, mensajeId) {
  const data = await graph(`/users/${encodeURIComponent(buzon)}/messages/${encodeURIComponent(mensajeId)}/attachments`);
  return (data.value || []).filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment');
}

module.exports = { configurado, config, mensajesDesde, mensaje, nombresAdjuntos, adjuntos };
