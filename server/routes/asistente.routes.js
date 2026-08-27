'use strict';
const { sendJson, readJsonBody, HttpError } = require('../lib/http-helpers');
const { withAuth } = require('../lib/guard');
const claude = require('../lib/claude');
const { HERRAMIENTAS } = require('../lib/asistente-tools');

const SYSTEM_PROMPT = `Eres el asistente de datos de PROENERGY, una empresa colombiana de servicios electricos.
Respondes en espanol, de forma breve y clara, sobre cotizaciones, costos, rentabilidad, cartera y cuentas por pagar.
Usa siempre las herramientas disponibles para consultar datos reales antes de responder preguntas sobre cifras o
cotizaciones especificas; nunca inventes numeros. Los valores monetarios estan en pesos colombianos (COP): formatealos
como "$ 1.234.567". Los porcentajes vienen como fraccion (0.15 = 15%). Si una pregunta no tiene relacion con los datos
de PROENERGY, responde brevemente que solo puedes ayudar con temas de costeo, cotizaciones y cartera de la empresa.
Si no encuentras informacion suficiente con las herramientas, dilo con honestidad en vez de adivinar.`;

const MAX_HISTORIAL = 12;

function limpiarHistorial(historial) {
  if (!Array.isArray(historial)) return [];
  return historial
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORIAL)
    .map((m) => ({ role: m.role, content: m.content }));
}

module.exports = (router) => {
  router.get('/api/asistente/estado', withAuth(async ({ res }) => {
    sendJson(res, 200, { configurada: claude.configurada(), proveedor: claude.proveedorActivo() });
  }));

  router.post('/api/asistente/mensaje', withAuth(async ({ req, res }) => {
    const body = await readJsonBody(req);
    const mensaje = (body.mensaje || '').trim();
    if (!mensaje) throw new HttpError(400, 'El mensaje no puede estar vacio.');
    if (mensaje.length > 2000) throw new HttpError(400, 'El mensaje es demasiado largo (maximo 2000 caracteres).');

    const mensajes = [...limpiarHistorial(body.historial), { role: 'user', content: mensaje }];
    const respuesta = await claude.conversar({ system: SYSTEM_PROMPT, mensajes, herramientas: HERRAMIENTAS });
    sendJson(res, 200, { respuesta });
  }));
};
