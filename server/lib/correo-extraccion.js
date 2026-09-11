'use strict';
// Clasifica un correo y extrae sus datos (cotizaciones, ordenes de compra,
// solicitudes, invitaciones, precios de proveedores) con la IA que ya usa la
// app (lib/claude.js: Gemini o Claude). Los PDF se le mandan tal cual; los Word
// se convierten a texto aqui mismo (un .docx es un ZIP, se lee con readZip).
//
// Dos filtros antes de gastar una llamada a la IA:
//   1. prefiltro(): solo pasan correos con palabras de negocio en el asunto o
//      el cuerpo, o con un adjunto PDF/Word. Se descartan boletines y
//      respuestas automaticas.
//   2. La IA recibe la instruccion de devolver null en todo dato que no este
//      escrito en el correo: nunca estima ni calcula cifras.

const { readZip } = require('./xlsx');
const ia = require('./claude');

const PALABRAS = /cotiz|oferta|propuesta|orden\s+de\s+(compra|servicio)|\bo\.?\s?[cs]\.?\s*(n[o°.]*\s*)?\d|solicitud|invitaci[oó]n|licitaci|\brfq\b|precio|presupuesto|alcance/i;
const AUTOMATICO = /^(respuesta autom[aá]tica|automatic reply|fuera de la oficina|out of office|no[- ]reply|undeliverable|no se pudo entregar)/i;
const BOLETIN = /unsubscribe|darse de baja|cancelar (la )?suscripci|anular suscripci/i;
const TIPOS = ['cotizacion_propia', 'cotizacion_siigo', 'solicitud_cliente', 'invitacion_licitar', 'cotizacion_proveedor', 'orden_compra', 'otro'];

function esDocumento(nombre) {
  return /\.(pdf|docx)$/i.test(String(nombre || ''));
}

// ¿Vale la pena mandarle este correo a la IA? `m` es el mensaje de Graph.
function prefiltro(m, nombresAdjuntos = []) {
  const asunto = String(m.subject || '');
  if (AUTOMATICO.test(asunto.trim())) return { pasa: false, motivo: 'respuesta automática' };
  const cabeceras = (m.internetMessageHeaders || []).map((h) => String(h.name || '').toLowerCase());
  const cuerpo = String((m.body && m.body.content) || m.bodyPreview || '');
  if (cabeceras.includes('list-unsubscribe') || BOLETIN.test(cuerpo.slice(-3000))) return { pasa: false, motivo: 'boletín' };
  if (PALABRAS.test(asunto) || PALABRAS.test(cuerpo.slice(0, 4000))) return { pasa: true };
  if (nombresAdjuntos.some(esDocumento)) return { pasa: true };
  return { pasa: false, motivo: 'sin palabras de negocio ni documentos' };
}

// Texto de un .docx: parrafos de word/document.xml.
function textoDocx(buffer) {
  const archivos = readZip(buffer);
  const doc = archivos['word/document.xml'];
  if (!doc) return '';
  const xml = Buffer.isBuffer(doc) ? doc.toString('utf8') : String(doc);
  return xml
    .replace(/<w:tab\/>/g, ' ')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const SISTEMA = `Eres el asistente de PROENERGY COLOMBIA S.A.S., empresa de ingeniería eléctrica de Barranquilla (Colombia): subestaciones, transformadores, medición de energía, cambio de comercializador, energía solar. Recibes UN correo de uno de sus buzones (con sus adjuntos) y debes clasificarlo y extraer sus datos.

Responde SOLO un objeto JSON, sin texto adicional, con exactamente estas claves:
{
  "tipo": uno de ${TIPOS.map((t) => `"${t}"`).join(', ')},
  "confianza": número de 0 a 1,
  "empresa": nombre de la empresa contraparte (el cliente o el proveedor; nunca PROENERGY) o null,
  "contacto": nombre de la persona contraparte o null,
  "titulo_proyecto": nombre corto del proyecto o trabajo o null,
  "referencia": código propio del documento (por ejemplo "COT-INGCOST02-2026" o el número de la oferta comercial) o null,
  "cotizaciones_siigo": lista de números de cotización de Siigo con forma "C-1-123" que aparezcan, o [],
  "numero_oc": número de la orden de compra o de servicio (solo el número) o null,
  "valor_sin_iva": número o null,
  "valor_con_iva": número o null,
  "fecha": fecha del documento en formato AAAA-MM-DD o null,
  "fecha_limite": fecha límite para responder o entregar, AAAA-MM-DD, o null,
  "items": lista de hasta 40 objetos {"descripcion": texto, "cantidad": número o null, "unidad": texto o null, "precio_unitario": número o null},
  "resumen": resumen en español de máximo 300 caracteres
}

Cómo clasificar:
- "cotizacion_propia": PROENERGY le envía a un cliente una cotización u oferta comercial PROPIA, hecha fuera de Siigo (normalmente PDF o Word con alcance técnico, "OFERTA COMERCIAL", "COT-"). Solo ocurre en correos ENVIADOS.
- "cotizacion_siigo": PROENERGY envía una cotización generada por Siigo (número tipo C-1-123). Solo en correos ENVIADOS.
- "solicitud_cliente": un cliente, comercializadora u operador de red le pide a PROENERGY que cotice un trabajo o suministro.
- "invitacion_licitar": invitación formal a presentar oferta en un proceso de contratación o licitación, normalmente con fecha límite.
- "cotizacion_proveedor": un proveedor le envía a PROENERGY precios o una cotización de materiales, equipos o servicios.
- "orden_compra": un cliente le envía a PROENERGY una orden de compra, orden de servicio o contrato para ejecutar un trabajo.
- "otro": todo lo demás (facturas, pagos, notificaciones, publicidad, conversaciones internas).

Reglas estrictas:
- Usa null (o [] en listas) para cualquier dato que NO esté escrito en el correo o en sus adjuntos. No estimes, no calcules, no supongas cifras.
- Los valores van en pesos colombianos como número sin separadores de miles ni símbolos (ej. 12500000.5).
- valor_sin_iva y valor_con_iva según lo que diga el documento; si solo aparece uno, el otro va en null.
- Si el correo es una respuesta, clasifica por el contenido nuevo y por los adjuntos, no por el hilo citado.`;

// Extrae los datos de un mensaje. `adjuntos` = [{ name, contentType, contentBytes }]
async function extraer({ mensaje, adjuntos = [], carpeta }) {
  const pdfs = [];
  const textos = [];
  for (const a of adjuntos) {
    if (!esDocumento(a.name) || !a.contentBytes) continue;
    const bytes = Buffer.from(a.contentBytes, 'base64');
    if (bytes.length > 8 * 1024 * 1024) continue; // documentos muy pesados: se omiten
    if (/\.pdf$/i.test(a.name) && pdfs.length < 3) pdfs.push({ nombre: a.name, base64: a.contentBytes });
    else if (/\.docx$/i.test(a.name)) {
      try { textos.push(`--- Adjunto Word: ${a.name}\n${textoDocx(bytes).slice(0, 15000)}`); } catch (e) { /* docx dañado */ }
    }
  }
  const de = mensaje.from && mensaje.from.emailAddress;
  const para = (mensaje.toRecipients || []).map((r) => r.emailAddress && `${r.emailAddress.name || ''} <${r.emailAddress.address}>`).join('; ');
  const contenido = [
    `Carpeta: ${carpeta === 'sentitems' ? 'ENVIADOS (lo mandó PROENERGY)' : 'RECIBIDOS (le llegó a PROENERGY)'}`,
    `De: ${de ? `${de.name || ''} <${de.address}>` : '(desconocido)'}`,
    `Para: ${para}`,
    `Fecha: ${mensaje.sentDateTime || mensaje.receivedDateTime || ''}`,
    `Asunto: ${mensaje.subject || ''}`,
    `Adjuntos: ${adjuntos.map((a) => a.name).join(', ') || 'ninguno'}`,
    '--- Cuerpo del correo',
    String((mensaje.body && mensaje.body.content) || mensaje.bodyPreview || '').slice(0, 8000),
    ...textos,
  ].join('\n');
  const r = await ia.extraerJSON({ system: SISTEMA, texto: contenido, pdfs });
  return normalizar(r);
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function fecha(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function texto(v, max = 300) {
  const t = v === null || v === undefined ? '' : String(v).trim();
  return t ? t.slice(0, max) : null;
}

// Deja la respuesta de la IA con tipos y formatos seguros.
function normalizar(r) {
  r = r || {};
  return {
    tipo: TIPOS.includes(r.tipo) ? r.tipo : 'otro',
    confianza: Math.max(0, Math.min(1, Number(r.confianza) || 0)),
    empresa: texto(r.empresa, 200),
    contacto: texto(r.contacto, 120),
    titulo_proyecto: texto(r.titulo_proyecto, 200),
    referencia: texto(r.referencia, 80),
    cotizaciones_siigo: (Array.isArray(r.cotizaciones_siigo) ? r.cotizaciones_siigo : [])
      .map((x) => String(x).toUpperCase().replace(/\s+/g, '')).filter((x) => /^C-?\d+-?\d+$/.test(x)),
    numero_oc: texto(r.numero_oc, 40),
    valor_sin_iva: num(r.valor_sin_iva),
    valor_con_iva: num(r.valor_con_iva),
    fecha: fecha(r.fecha),
    fecha_limite: fecha(r.fecha_limite),
    items: (Array.isArray(r.items) ? r.items : []).slice(0, 40)
      .filter((it) => it && texto(it.descripcion))
      .map((it) => ({ descripcion: texto(it.descripcion, 300), cantidad: num(it.cantidad), unidad: texto(it.unidad, 20), precio_unitario: num(it.precio_unitario) })),
    resumen: texto(r.resumen, 400),
  };
}

module.exports = { prefiltro, extraer, textoDocx, normalizar, esDocumento, TIPOS };
