'use strict';
// Cliente del asistente de chat, sin dependencias externas (usa fetch nativo
// de Node). Soporta DOS proveedores de IA intercambiables, cada uno con su
// propio loop de "tool use" para que el asistente pueda consultar datos
// reales de la app antes de responder:
//
//   - Google Gemini (GRATIS): variable de entorno GEMINI_API_KEY
//     Se consigue sin tarjeta de credito en https://aistudio.google.com/apikey
//   - Anthropic Claude (de pago): variable de entorno ANTHROPIC_API_KEY
//     Se consigue en https://console.anthropic.com
//
// Si ambas estan configuradas, se usa Gemini por defecto. Ninguna clave se
// escribe en este archivo: se configuran en Railway > Variables.
// Opcionales: GEMINI_MODEL (por defecto gemini-2.5-flash), ANTHROPIC_MODEL
// (por defecto claude-sonnet-4-5-20250929), IA_PROVEEDOR=claude para forzar
// Claude aunque tambien exista GEMINI_API_KEY.

const MAX_TOOL_ITERACIONES = 6;

function proveedorActivo() {
  if (process.env.IA_PROVEEDOR === 'claude' && process.env.ANTHROPIC_API_KEY) return 'claude';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  return null;
}

function configurada() {
  return Boolean(proveedorActivo());
}

function requerirProveedor() {
  const p = proveedorActivo();
  if (!p) {
    const err = new Error(
      'El asistente todavia no esta configurado. En Railway > Variables agrega ' +
      'GEMINI_API_KEY (gratis, sin tarjeta: https://aistudio.google.com/apikey) ' +
      'o ANTHROPIC_API_KEY (de pago: https://console.anthropic.com).'
    );
    err.status = 400;
    throw err;
  }
  return p;
}

// ==================== Google Gemini (gratis) ====================

const GEMINI_URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';

async function llamarGemini({ system, contents, herramientas }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
  const url = `${GEMINI_URL_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(herramientas.length
      ? {
          tools: [{
            functionDeclarations: herramientas.map((h) => ({
              name: h.schema.name,
              description: h.schema.description,
              parameters: (h.schema.input_schema && Object.keys(h.schema.input_schema.properties || {}).length)
                ? h.schema.input_schema
                : { type: 'object', properties: {} },
            })),
          }],
        }
      : {}),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const textoCrudo = await res.text();
  let data = {};
  try { data = textoCrudo ? JSON.parse(textoCrudo) : {}; } catch (e) { /* respuesta no era JSON */ }
  if (!res.ok) {
    const detalle = (data && data.error && data.error.message) || textoCrudo || '(sin cuerpo de respuesta)';
    const err = new Error(`Gemini respondio con error (HTTP ${res.status}): ${detalle}`);
    err.status = 502;
    throw err;
  }
  return data;
}

async function conversarGemini({ system, mensajes, herramientas }) {
  const porNombre = new Map(herramientas.map((h) => [h.schema.name, h.ejecutar]));
  const contents = mensajes.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  for (let i = 0; i < MAX_TOOL_ITERACIONES; i++) {
    const data = await llamarGemini({ system, contents, herramientas });
    const candidato = (data.candidates || [])[0];
    const parts = (candidato && candidato.content && candidato.content.parts) || [];
    contents.push({ role: 'model', parts });

    const llamadasFuncion = parts.filter((p) => p.functionCall);
    if (!llamadasFuncion.length) {
      const texto = parts.filter((p) => p.text).map((p) => p.text).join('\n').trim();
      return texto || 'No tengo una respuesta para eso.';
    }

    const partesResultado = [];
    for (const p of llamadasFuncion) {
      const { name, args } = p.functionCall;
      const fn = porNombre.get(name);
      let contenido;
      try {
        contenido = fn ? await fn(args || {}) : { error: `Herramienta desconocida: ${name}` };
      } catch (e) {
        contenido = { error: e.message };
      }
      partesResultado.push({ functionResponse: { name, response: contenido } });
    }
    contents.push({ role: 'user', parts: partesResultado });
  }
  return 'No pude terminar de procesar tu pregunta (demasiados pasos). Intenta preguntar algo mas especifico.';
}

// ==================== Anthropic Claude (de pago) ====================

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

async function llamarClaude({ system, messages, tools }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || CLAUDE_DEFAULT_MODEL;
  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages,
      ...(tools && tools.length ? { tools } : {}),
    }),
  });
  const textoCrudo = await res.text();
  let data = {};
  try { data = textoCrudo ? JSON.parse(textoCrudo) : {}; } catch (e) { /* respuesta no era JSON */ }
  if (!res.ok) {
    const detalle = (data && data.error && data.error.message) || textoCrudo || '(sin cuerpo de respuesta)';
    const err = new Error(`Claude respondio con error (HTTP ${res.status}): ${detalle}`);
    err.status = 502;
    throw err;
  }
  return data;
}

async function conversarClaude({ system, mensajes, herramientas }) {
  const tools = herramientas.map((h) => h.schema);
  const porNombre = new Map(herramientas.map((h) => [h.schema.name, h.ejecutar]));
  const historial = [...mensajes];

  for (let i = 0; i < MAX_TOOL_ITERACIONES; i++) {
    const data = await llamarClaude({ system, messages: historial, tools });
    const bloques = data.content || [];
    historial.push({ role: 'assistant', content: bloques });

    if (data.stop_reason !== 'tool_use') {
      const texto = bloques.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return texto || 'No tengo una respuesta para eso.';
    }

    const usosHerramienta = bloques.filter((b) => b.type === 'tool_use');
    const resultados = [];
    for (const uso of usosHerramienta) {
      const fn = porNombre.get(uso.name);
      let contenido;
      let esError = false;
      try {
        contenido = fn ? await fn(uso.input || {}) : { error: `Herramienta desconocida: ${uso.name}` };
      } catch (e) {
        contenido = { error: e.message };
        esError = true;
      }
      resultados.push({
        type: 'tool_result',
        tool_use_id: uso.id,
        content: JSON.stringify(contenido),
        ...(esError ? { is_error: true } : {}),
      });
    }
    historial.push({ role: 'user', content: resultados });
  }
  return 'No pude terminar de procesar tu pregunta (demasiados pasos). Intenta preguntar algo mas especifico.';
}

// ==================== Interfaz publica (usada por asistente.routes.js) ====================

// Corre el loop de conversacion + tool use hasta que la IA entregue una
// respuesta final en texto (o se agote el limite de iteraciones, por seguridad).
// `herramientas` es un array de { schema, ejecutar(input) } (formato Anthropic:
// schema = {name, description, input_schema}; se traduce automaticamente al
// formato de Gemini cuando ese es el proveedor activo).
async function conversar({ system, mensajes, herramientas = [] }) {
  const proveedor = requerirProveedor();
  if (proveedor === 'gemini') return conversarGemini({ system, mensajes, herramientas });
  return conversarClaude({ system, mensajes, herramientas });
}

module.exports = { conversar, configurada, proveedorActivo };
