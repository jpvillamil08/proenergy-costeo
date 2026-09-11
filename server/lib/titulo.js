'use strict';
// Titulo de un documento de Siigo: la primera linea (primer item) de la
// cotizacion o de la factura. Ahi PROENERGY escribe el trabajo, casi siempre como
// "CLIENTE / SITIO - ACTIVIDAD" ("JUAN VALDEZ - NIC 7721125 - CAMBIO DE
// COMERCIALIZADOR"). Las actividades que el equipo registraba a mano en el Excel
// de ofertas salian exactamente de ese texto, asi que se toma de ahi en vez de
// deducirla con palabras clave.

const PREFIJO_REVISAR = /^\s*\[REVISAR\]\s*/i;
const SIN_TITULO = /^Importada desde Siigo/i; // descripcion por defecto sin items
// Espacios de ancho cero (U+200B a U+200D) y BOM (U+FEFF) que trae Siigo.
const INVISIBLES = new RegExp('[' + String.fromCharCode(0x200b) + '-' +
  String.fromCharCode(0x200d) + String.fromCharCode(0xfeff) + ']', 'g');

function limpiar(texto) {
  return String(texto || '')
    .replace(INVISIBLES, '')
    .replace(PREFIJO_REVISAR, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.;,:-]+$/, '')
    .slice(0, 160);
}

// Desde los items crudos de Siigo (cotizacion o factura): el primero con texto.
function tituloDeItems(items) {
  for (const it of Array.isArray(items) ? items : []) {
    const t = limpiar(it && (it.description || it.name));
    if (t) return t;
  }
  return null;
}

// Para cotizaciones ya guardadas: su descripcion son las descripciones de los
// items unidas con "; " (ver siigo-sync.js), asi que el titulo es el primer tramo.
function tituloDeDescripcion(descripcion) {
  const t = limpiar(String(descripcion || '').split('; ')[0]);
  return t && !SIN_TITULO.test(t) ? t : null;
}

module.exports = { limpiar, tituloDeItems, tituloDeDescripcion };
