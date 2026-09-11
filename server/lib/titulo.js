'use strict';
// Titulo (actividad) de un documento de Siigo: lo que PROENERGY escribe en el
// campo Observaciones de la cotizacion o de la factura ("PREVISITAS MES DE
// JULIO", "ADICIONALES TRIPLE A VILLANUEVA").
//
// Por que Observaciones y no la primera linea de items: se comprobo contra lo
// que el equipo registraba a mano. La primera linea casi siempre es un material
// o un servicio ("ACCESORIOS CONSUMIBLES GENERALES", "RETIRO E INSTALACION DE
// MEDIDA DIRECTA"); en cambio los titulos registrados coinciden con las
// observaciones de las facturas (C-1-201 "PREVISITAS MES DE JULIO" = FV-2-424
// "ORDEN DE COMPRA 2549 - PREVISITAS MES DE JULIO").
//
// Las cotizaciones anteriores a agosto de 2026 no tienen titulo: quedan en null,
// nunca se rellenan con otro texto.

const PREFIJO_REVISAR = /^\s*\[REVISAR\]\s*/i;

// Referencia de orden al comienzo ("ORDEN DE COMPRA 2356 -", "O.C. 2377",
// "CONTRATO 45:"). Se quita porque ya va en su propia columna y no describe el
// trabajo.
const ORDEN_INICIAL = /^\s*(?:ORDEN\s+DE\s+(?:COMPRA|SERVICIO)|O\.?\s?[CS]\.?|CONTRATO)\s*(?:N[^\s\d]{0,2}\s*)?\d+\s*[-,.:;]*\s*/i;

// Espacios de ancho cero (U+200B a U+200D) y BOM (U+FEFF) que trae Siigo.
const INVISIBLES = new RegExp('[' + String.fromCharCode(0x200b) + '-' +
  String.fromCharCode(0x200d) + String.fromCharCode(0xfeff) + ']', 'g');

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Siigo devuelve el texto con entidades HTML, a veces dobles ("&amp;#x2F;").
function decodificar(texto) {
  let t = String(texto || '');
  for (let i = 0; i < 3; i++) {
    const antes = t;
    t = t
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTIDADES ? ENTIDADES[n.toLowerCase()] : m));
    if (t === antes) break;
  }
  return t;
}

function limpiar(texto) {
  return decodificar(texto)
    .replace(INVISIBLES, '')
    .replace(PREFIJO_REVISAR, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.;,:-]+$/, '')
    .slice(0, 160);
}

function tituloDeObservaciones(observaciones) {
  const t = limpiar(decodificar(observaciones).replace(ORDEN_INICIAL, ''));
  return t || null;
}

module.exports = { limpiar, decodificar, tituloDeObservaciones };
