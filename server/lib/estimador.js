'use strict';
// Estimador de costos a partir de la descripcion de una cotizacion.
//
// Principio: nunca inventa cifras. Solo hace dos cosas, ambas basadas en
// datos reales que ya existen en la base de datos:
//   1) Busca en el catalogo de materiales (con precios reales por proveedor)
//      que materiales podrian aplicar segun las palabras de la descripcion.
//   2) Busca cotizaciones anteriores con una descripcion parecida y muestra
//      sus horas y costos de mano de obra reales (o presupuestados si aun no
//      se ha ejecutado) como precedente, para que el usuario decida.
const db = require('../db');
const cotizacionService = require('./cotizacion-service');

// Palabras comunes en español que no aportan a la busqueda (se ignoran al
// comparar descripciones o al armar el listado de terminos de busqueda).
const STOPWORDS = new Set([
  'para', 'con', 'del', 'las', 'los', 'una', 'uno', 'unos', 'unas', 'que', 'por',
  'sobre', 'entre', 'como', 'esta', 'este', 'estos', 'estas', 'sera', 'será',
  'segun', 'según', 'donde', 'cuando', 'desde', 'hasta', 'mas', 'más', 'pero',
  'todo', 'toda', 'todos', 'todas', 'otro', 'otra', 'otros', 'otras', 'tipo',
  'grupo', 'medida', 'nueva', 'nuevo', 'trabajo', 'servicio', 'instalacion',
  'instalación', 'general', 'generales',
]);

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // quita tildes
}

// Extrae palabras significativas (>=4 letras, sin stopwords) de un texto.
function tokenizar(texto) {
  const limpio = normalizar(texto).replace(/[^a-z0-9\s]/g, ' ');
  const palabras = limpio.split(/\s+/).filter((p) => p.length >= 4);
  const sinStop = palabras.filter((p) => !STOPWORDS.has(normalizar(p)));
  return [...new Set(sinStop)];
}

// ---- 1) Materiales sugeridos desde el catalogo real ----
function sugerirMateriales(descripcion, limit = 15) {
  const tokens = tokenizar(descripcion);
  if (!tokens.length) return [];

  const materiales = db.prepare('SELECT * FROM materiales WHERE activo = 1').all();
  const candidatos = [];
  for (const m of materiales) {
    const descNorm = normalizar(m.descripcion);
    const coincidencias = tokens.filter((t) => descNorm.includes(t));
    if (!coincidencias.length) continue;
    const precios = db.prepare(
      `SELECT mp.precio_unitario, mp.precio_con_iva, mp.proveedor_id, p.nombre AS proveedor_nombre
       FROM materiales_precios mp JOIN proveedores p ON p.id = mp.proveedor_id
       WHERE mp.material_id = ? ORDER BY mp.precio_unitario ASC`
    ).all(m.id);
    const mejor = precios.length ? precios[0] : null;
    candidatos.push({
      material_id: m.id,
      descripcion: m.descripcion,
      unidad: m.unidad,
      coincidencias: coincidencias.length,
      mejor_precio: mejor ? mejor.precio_unitario : null,
      mejor_proveedor_id: mejor ? mejor.proveedor_id : null,
      mejor_proveedor_nombre: mejor ? mejor.proveedor_nombre : null,
      sin_precio: !mejor,
    });
  }
  candidatos.sort((a, b) => b.coincidencias - a.coincidencias || a.descripcion.localeCompare(b.descripcion));
  return candidatos.slice(0, limit);
}

// ---- 2) Precedentes: cotizaciones anteriores con descripcion parecida ----
function buscarPrecedentes(descripcion, excluirId, limit = 5) {
  const tokens = tokenizar(descripcion);
  if (!tokens.length) return [];

  let candidatas = db.prepare(
    `SELECT id, numero, cliente, descripcion, estado, fecha_cotizacion FROM cotizaciones
     WHERE descripcion IS NOT NULL AND trim(descripcion) != ''`
  ).all();
  if (excluirId) candidatas = candidatas.filter((c) => String(c.id) !== String(excluirId));

  // Umbral minimo de palabras compartidas para considerar que "se parece":
  // con descripciones muy cortas (1-2 palabras clave) basta con 1 coincidencia,
  // pero con descripciones mas largas exigimos al menos 2 para evitar que una
  // sola palabra generica (ej. "cambio") arme falsos precedentes.
  const minScore = tokens.length <= 2 ? 1 : 2;

  const puntuadas = candidatas
    .map((c) => {
      const tokensC = tokenizar(c.descripcion);
      const compartidas = tokens.filter((t) => tokensC.includes(t));
      return { c, score: compartidas.length };
    })
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || (a.c.estado === b.c.estado ? 0 : 1));

  const EJECUTADO = new Set(['Ejecutada', 'Cerrada']);
  const resultado = [];
  for (const { c, score } of puntuadas.slice(0, limit)) {
    const full = cotizacionService.getCotizacionFull(c.id);
    if (!full) continue;
    const esReal = EJECUTADO.has(c.estado);
    const bloque = esReal ? full.calculo.costeoReal : full.calculo.costeoPresupuestado;
    resultado.push({
      id: c.id,
      numero: c.numero,
      cliente: c.cliente,
      descripcion: c.descripcion,
      estado: c.estado,
      fecha_cotizacion: c.fecha_cotizacion,
      similitud: score,
      origen_cifras: esReal ? 'real (trabajo ejecutado)' : 'presupuestado (aún no ejecutada, no son horas reales)',
      horasTotales: bloque.horasTotales,
      costoManoObra: bloque.costoMoInterna + bloque.costoMoExterna,
      materialesTotal: bloque.materialesTotal,
    });
  }
  return resultado;
}

module.exports = { tokenizar, sugerirMateriales, buscarPrecedentes };
