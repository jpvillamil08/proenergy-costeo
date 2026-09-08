#!/usr/bin/env node
'use strict';
// Reporte de materiales que aparecen en las lineas de las cotizaciones pero
// NO existen (o no coinciden claramente por nombre) en el catalogo maestro de
// materiales (tabla `materiales`).
//
// Que hace:
//   1. Lee todas las cotizaciones (o el subconjunto que se le indique por
//      rango de id, rango de fechas o estado).
//   2. Lee sus lineas de `cotizacion_materiales`.
//   3. Lee el catalogo maestro completo (`/api/materiales?todos=1`).
//   4. Para cada linea, busca si su descripcion existe en el catalogo:
//        - Coincidencia EXACTA (normalizada: sin tildes, mayus/minus, espacios) -> existe, se ignora.
//        - Sin exacta pero con buena coincidencia por palabras clave -> se
//          reporta como faltante, pero con una nota de "posible ya existe
//          como: ..." para que decidas si es solo un cambio de nombre.
//        - Sin ninguna coincidencia razonable -> se reporta como faltante.
//   5. Agrupa cada material faltante UNA sola vez (por su descripcion, ya
//      normalizada) y cuenta en cuantas cotizaciones distintas aparece.
//   6. Guarda un JSON con el detalle completo y lo ordena de mayor a menor
//      frecuencia.
//
// No inventa nada: si una linea no tiene costo unitario registrado (por
// ejemplo las que vienen marcadas "[REVISAR]" de una carga automatica desde
// Siigo), se reporta igual pero el precio de referencia queda explicitamente
// en null, nunca se rellena con un supuesto.
//
// NUNCA escribas tu usuario/clave en este archivo: se piden por variables de
// entorno para que las escribas tu mismo en tu propia terminal. Este script
// solo LEE, no modifica nada.
//
// Uso en PowerShell:
//   $env:ADMIN_USERNAME = "admin"
//   $env:ADMIN_PASSWORD = "tu-clave"
//   node scripts/reporte-materiales-faltantes.js https://proenergy-costeo-production-8844.up.railway.app
//
// Filtros opcionales (todos opcionales, se combinan):
//   node scripts/reporte-materiales-faltantes.js <URL> --desde=2026-01-01 --hasta=2026-06-30
//   node scripts/reporte-materiales-faltantes.js <URL> --estado=Aprobada
//   node scripts/reporte-materiales-faltantes.js <URL> --idDesde=200 --idHasta=234
// (--estado puede repetirse separado por comas, ej: --estado=Aprobada,Ejecutada,Cerrada)

const BASE_URL = (process.argv[2] || '').replace(/\/+$/, '');
const USERNAME = process.env.ADMIN_USERNAME;
const PASSWORD = process.env.ADMIN_PASSWORD;

const args = {};
for (const a of process.argv.slice(3)) {
  const m = a.match(/^--([a-zA-Z]+)=(.*)$/);
  if (m) args[m[1]] = m[2];
}
const DESDE_FECHA = args.desde || null;
const HASTA_FECHA = args.hasta || null;
const ID_DESDE = args.idDesde ? Number(args.idDesde) : null;
const ID_HASTA = args.idHasta ? Number(args.idHasta) : null;
const ESTADOS = args.estado ? args.estado.split(',').map((s) => s.trim()) : null;

if (!BASE_URL) {
  console.error('Uso: node scripts/reporte-materiales-faltantes.js <URL_DE_LA_APP> [--desde=YYYY-MM-DD] [--hasta=YYYY-MM-DD] [--estado=Aprobada,Ejecutada] [--idDesde=N] [--idHasta=N]');
  process.exit(1);
}
if (!USERNAME || !PASSWORD) {
  console.error('Faltan credenciales. Define ADMIN_USERNAME y ADMIN_PASSWORD como variables de entorno antes de correr este script.');
  process.exit(1);
}

let cookie = null;

async function login() {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Login falló (${res.status}): ${text}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/sesion=[^;]+/);
  if (!m) throw new Error('Login OK pero no se recibió cookie de sesión.');
  cookie = m[0];
}

async function api(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Cookie: cookie } });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${data && data.error ? data.error : text}`);
  return data;
}

// --- utilidades de texto (mismo criterio que server/lib/estimador.js, pero
// autocontenidas aqui para no depender de la base de datos local) ---
const STOPWORDS = new Set(['para', 'con', 'sin', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'o', 'en', 'un', 'una', 'unos', 'unas', 'al', 'por', 'que']);
function normalizar(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\[revisar\]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}
function tokenizar(s) {
  return normalizar(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}
function esRevisar(descripcion) {
  return /^\s*\[revisar\]/i.test(descripcion || '');
}

// Mejor coincidencia por palabras clave contra el catalogo (para detectar el
// mismo material con otro nombre). Exige minimo de palabras compartidas y que
// el mejor candidato sea unico, para no adivinar.
function mejorCoincidencia(descripcion, catalogoTokenizado) {
  const tokens = tokenizar(descripcion);
  if (!tokens.length) return null;
  const candidatos = catalogoTokenizado
    .map((m) => ({ m, score: tokens.filter((t) => m.tokens.includes(t)).length }))
    .filter((c) => c.score > 0);
  if (!candidatos.length) return null;
  candidatos.sort((a, b) => b.score - a.score);
  const minScore = tokens.length <= 2 ? 1 : 2;
  if (candidatos[0].score < minScore) return null;
  const top = candidatos[0].score;
  if (candidatos.filter((c) => c.score === top).length > 1) return null; // empate: ambiguo
  return candidatos[0].m;
}

function moda(numeros) {
  if (!numeros.length) return null;
  const cuenta = new Map();
  for (const n of numeros) cuenta.set(n, (cuenta.get(n) || 0) + 1);
  let mejor = numeros[0];
  let mejorCuenta = 0;
  for (const [n, c] of cuenta) if (c > mejorCuenta) { mejor = n; mejorCuenta = c; }
  return mejor;
}

async function main() {
  console.log(`Conectando a ${BASE_URL} ...`);
  await login();
  console.log('Sesión iniciada correctamente.');

  console.log('Descargando catálogo maestro de materiales...');
  const catalogoRaw = await api('/api/materiales?todos=1');
  const catalogo = catalogoRaw.map((m) => ({ ...m, norm: normalizar(m.descripcion), tokens: tokenizar(m.descripcion) }));
  const catalogoPorNorm = new Map(catalogo.map((m) => [m.norm, m]));
  console.log(`Catálogo maestro: ${catalogo.length} materiales.`);

  console.log('Descargando lista de cotizaciones...');
  const lista = await api('/api/cotizaciones');

  let objetivo = lista;
  if (ID_DESDE != null) objetivo = objetivo.filter((r) => r.id >= ID_DESDE);
  if (ID_HASTA != null) objetivo = objetivo.filter((r) => r.id <= ID_HASTA);
  if (DESDE_FECHA) objetivo = objetivo.filter((r) => r.fecha_cotizacion >= DESDE_FECHA);
  if (HASTA_FECHA) objetivo = objetivo.filter((r) => r.fecha_cotizacion <= HASTA_FECHA);
  if (ESTADOS) objetivo = objetivo.filter((r) => ESTADOS.includes(r.estado));

  console.log(`Analizando ${objetivo.length} de ${lista.length} cotizaciones (según filtros aplicados)...`);

  const grupos = new Map(); // norm -> { descripcionMostrada, cotizaciones: Map(id -> {numero,cliente}), precios: [{numero,cantidad,costo}], posibleCoincidencia }
  const erroresPorCotizacion = [];
  let totalLineas = 0;
  let totalLineasConMatch = 0;

  for (const r of objetivo) {
    let detalle;
    try {
      detalle = await api(`/api/cotizaciones/${r.id}`);
    } catch (e) {
      erroresPorCotizacion.push({ id: r.id, numero: r.numero, error: e.message });
      continue;
    }
    for (const linea of detalle.materiales || []) {
      const descripcionOriginal = (linea.descripcion || '').trim();
      if (!descripcionOriginal) continue;
      totalLineas++;
      const norm = normalizar(descripcionOriginal);
      if (catalogoPorNorm.has(norm)) { totalLineasConMatch++; continue; } // existe exacto en el catalogo, no es faltante

      if (!grupos.has(norm)) {
        const candidato = mejorCoincidencia(descripcionOriginal, catalogo);
        grupos.set(norm, {
          descripcionMostrada: descripcionOriginal.replace(/^\s*\[revisar\]\s*/i, ''),
          revisarSiigo: false,
          cotizaciones: new Map(),
          precios: [],
          posibleCoincidencia: candidato ? candidato.descripcion : null,
        });
      }
      const g = grupos.get(norm);
      if (esRevisar(descripcionOriginal)) g.revisarSiigo = true;
      g.cotizaciones.set(r.id, { numero: r.numero, cliente: r.cliente });
      const cantidad = linea.cantidad_presupuestada || linea.cantidad_real || null;
      const costo = linea.costo_unitario || null;
      if (cantidad != null || costo != null) {
        g.precios.push({ cotizacion: r.numero, cantidad, costo_unitario: costo });
      }
    }
  }

  const resultado = [...grupos.entries()].map(([norm, g]) => {
    const preciosConCosto = g.precios.filter((p) => p.costo_unitario);
    const costosUsados = preciosConCosto.map((p) => p.costo_unitario);
    const precioReferencia = costosUsados.length ? moda(costosUsados) : null;
    const preciosDistintos = [...new Set(costosUsados)];
    return {
      material_faltante: g.descripcionMostrada,
      n_cotizaciones: g.cotizaciones.size,
      cotizaciones: [...g.cotizaciones.values()].map((c) => c.numero || `#${c.numero}`),
      clientes: [...new Set([...g.cotizaciones.values()].map((c) => c.cliente))],
      precio_referencia_mas_usado: precioReferencia,
      precios_distintos_encontrados: preciosDistintos.length > 1 ? preciosDistintos : undefined,
      cantidades_y_precios_por_cotizacion: g.precios,
      sin_precio_de_referencia: costosUsados.length === 0,
      viene_marcado_revisar_siigo: g.revisarSiigo,
      posible_coincidencia_en_catalogo: g.posibleCoincidencia,
    };
  });

  resultado.sort((a, b) => b.n_cotizaciones - a.n_cotizaciones);

  const outPath = require('node:path').join(__dirname, '..', `reporte-materiales-faltantes-${Date.now()}.json`);
  require('node:fs').writeFileSync(outPath, JSON.stringify({
    generado_en: new Date().toISOString(),
    base_url: BASE_URL,
    filtros: { idDesde: ID_DESDE, idHasta: ID_HASTA, desde: DESDE_FECHA, hasta: HASTA_FECHA, estados: ESTADOS },
    cotizaciones_analizadas: objetivo.length,
    total_lineas_de_materiales: totalLineas,
    lineas_que_ya_existen_en_catalogo: totalLineasConMatch,
    materiales_faltantes_distintos: resultado.length,
    errores: erroresPorCotizacion,
    materiales_faltantes: resultado,
  }, null, 2));

  console.log(`\nListo. Reporte guardado en: ${outPath}`);
  console.log(`Cotizaciones analizadas: ${objetivo.length}`);
  console.log(`Líneas de materiales revisadas: ${totalLineas} (${totalLineasConMatch} ya existen tal cual en el catálogo)`);
  console.log(`Materiales distintos que faltan o no coinciden por nombre: ${resultado.length}`);
  if (erroresPorCotizacion.length) console.log(`Errores al leer ${erroresPorCotizacion.length} cotización(es), ver detalle en el JSON.`);
}

main().catch((e) => {
  console.error('\nERROR:', e.message);
  process.exit(1);
});
