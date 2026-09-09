'use strict';
// Vincula cada factura de Siigo con la cotizacion a la que pertenece.
//
// De donde sale el vinculo: en Siigo, el numero de la cotizacion se escribe a
// mano en el campo "observations" de la factura, mezclado con otro texto libre
// (ordenes de compra, nombre de la obra, etc.). Por ejemplo:
//   "ORDEN DE COMPRA 2356 EQUIPOS CTS Y PTS - MERCAMAR RODADERO"
//   "C-1-231 MANTENIMIENTO SUBESTACION"
//
// Como NO se adivina: en vez de inventar un formato de numero de cotizacion y
// confiar en una expresion regular, se busca dentro del texto cualquiera de los
// numeros de cotizacion que EXISTEN de verdad en la base. Si el texto no
// contiene ninguno, la factura queda sin vincular y se reporta. Asi nunca se
// asocia una factura a una cotizacion equivocada.
//
// Ambiguedad: si las observaciones mencionan dos cotizaciones distintas, no se
// elige ninguna; se reporta para que una persona decida.

const db = require('../db');

// Normaliza para comparar: sin tildes, mayusculas, y separadores unificados a
// guion, para que "C 1 231", "C_1_231" y "c-1-231" se reconozcan igual.
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Numeros de cotizacion existentes, ordenados del mas largo al mas corto para
// que "C-1-231" gane sobre un hipotetico "C-1-23" contenido en el mismo texto.
function cotizacionesIndexadas() {
  const filas = db.prepare('SELECT id, numero FROM cotizaciones WHERE numero IS NOT NULL').all();
  return filas
    .map((c) => ({ id: c.id, numero: c.numero, norm: normalizar(c.numero) }))
    .filter((c) => c.norm.length >= 4) // evita numeros demasiado cortos y ambiguos
    .sort((a, b) => b.norm.length - a.norm.length);
}

// Forma abreviada que se usa en la practica: "COT 88", "COT-88", "COTIZACION 88",
// "COT. N 88". Se refiere a la cotizacion C-1-88. Se captura el numero suelto y
// despues se comprueba contra las cotizaciones que existen: si no hay ninguna
// que termine en ese numero, no se vincula.
// OJO: "O.C. 2189" / "OC2191" es ORDEN DE COMPRA del cliente, NO una cotizacion.
// Por eso el patron exige "COT" y no acepta "OC".
const RE_COT_CORTA = /(?:^|-)COT(?:IZACION|IZACIONES)?-?(?:N-?)?(?:O-?)?(\d{1,5})(?:$|-)/g;

// Busca en el texto los numeros de cotizacion que realmente existen.
// Devuelve todas las coincidencias distintas encontradas.
function buscarCotizaciones(observaciones, indice) {
  const texto = normalizar(observaciones);
  if (!texto) return [];
  const encontradas = [];
  const yaCubierto = [];

  // 1) Numero completo tal cual aparece en la base ("C-1-231")
  for (const c of indice) {
    // Se exige que el numero aparezca delimitado, no como parte de otro numero
    // mas largo: "C-1-23" no debe coincidir dentro de "C-1-231".
    const re = new RegExp(`(^|-)${c.norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|-)`);
    if (!re.test(texto)) continue;
    // Si ya se acepto una coincidencia mas larga que contiene a esta, se ignora
    if (yaCubierto.some((prev) => prev.includes(c.norm))) continue;
    encontradas.push(c);
    yaCubierto.push(c.norm);
  }

  // 2) Forma abreviada "COT 88" -> se resuelve contra las cotizaciones reales.
  //    Si el numero suelto corresponde a mas de una cotizacion, se descarta por
  //    ambiguo en vez de elegir al azar.
  RE_COT_CORTA.lastIndex = 0;
  let m;
  while ((m = RE_COT_CORTA.exec(texto)) !== null) {
    const suelto = m[1].replace(/^0+/, '') || m[1];
    const candidatas = indice.filter((c) => {
      const cola = c.norm.split('-').pop();
      return cola.replace(/^0+/, '') === suelto;
    });
    if (candidatas.length !== 1) continue;
    const c = candidatas[0];
    if (encontradas.some((e) => e.id === c.id)) continue;
    encontradas.push(c);
  }

  return encontradas;
}

// Recorre las facturas guardadas y llena cotizacion_id donde se pueda.
// `soloSimular` no escribe nada: sirve para ver cuantas vincularian.
function vincular({ soloSimular = false, soloSinVinculo = true } = {}) {
  const indice = cotizacionesIndexadas();
  const filtro = soloSinVinculo ? 'WHERE cotizacion_id IS NULL' : '';
  const facturas = db.prepare(`SELECT id, numero, cliente, observaciones, cotizacion_id FROM facturas ${filtro}`).all();
  const update = db.prepare('UPDATE facturas SET cotizacion_id = ? WHERE id = ?');

  let vinculadas = 0;
  let sinObservaciones = 0;
  let sinNumero = 0;
  const ambiguas = [];
  const ejemplosSinNumero = [];
  const detalle = [];

  for (const f of facturas) {
    if (!f.observaciones || !String(f.observaciones).trim()) {
      sinObservaciones++;
      continue;
    }
    const hits = buscarCotizaciones(f.observaciones, indice);
    if (hits.length === 0) {
      sinNumero++;
      if (ejemplosSinNumero.length < 15) {
        ejemplosSinNumero.push({ factura: f.numero, cliente: f.cliente, observaciones: String(f.observaciones).slice(0, 140) });
      }
      continue;
    }
    if (hits.length > 1) {
      ambiguas.push({
        factura: f.numero,
        observaciones: String(f.observaciones).slice(0, 140),
        candidatas: hits.map((h) => h.numero),
      });
      continue;
    }
    if (!soloSimular) update.run(hits[0].id, f.id);
    vinculadas++;
    if (detalle.length < 25) {
      detalle.push({ factura: f.numero, cotizacion: hits[0].numero, observaciones: String(f.observaciones).slice(0, 100) });
    }
  }

  return {
    simulacion: soloSimular,
    facturas_revisadas: facturas.length,
    vinculadas,
    sin_observaciones: sinObservaciones,
    con_observaciones_pero_sin_numero_de_cotizacion: sinNumero,
    ambiguas: ambiguas.length,
    detalle_ambiguas: ambiguas.slice(0, 15),
    ejemplos_sin_numero: ejemplosSinNumero,
    ejemplos_vinculadas: detalle,
  };
}

module.exports = { normalizar, buscarCotizaciones, cotizacionesIndexadas, vincular };
