'use strict';
// Cliente minimo para la API de Claude (Anthropic Messages API), sin dependencias
// externas (usa fetch nativo de Node). Incluye un loop simple de "tool use" para
// que el asistente pueda consultar datos reales de la app antes de responder.
//
// Requiere una variable de entorno (se configura en Railway > Variables,
// NUNCA escrita en este archivo):
//   ANTHROPIC_API_KEY  -> API key de la cuenta de Anthropic/Claude
// Opcional:
//   ANTHROPIC_MODEL    -> id del modelo a usar (por defecto claude-sonnet-4-5-20250929)

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOOL_ITERACIONES = 6;

function configurada() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function requerirConfig() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error(
      'El asistente todavia no esta configurado. Falta la variable de entorno ' +
      'ANTHROPIC_API_KEY (Railway > Variables) con una API key de Anthropic/Claude.'
    );
    err.status = 400;
    throw err;
  }
  return apiKey;
}

async function llamarClaude({ system, messages, tools }) {
  const apiKey = requerirConfig();
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const res = await fetch(API_URL, {
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

// Corre el loop de conversacion + tool use hasta que Claude entregue una
// respuesta final en texto (o se agote el limite de iteraciones, por seguridad).
// `herramientas` es un array de { schema, ejecutar(input) }.
async function conversar({ system, mensajes, herramientas = [] }) {
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

module.exports = { conversar, configurada };
