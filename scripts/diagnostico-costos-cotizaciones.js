#!/usr/bin/env node
'use strict';
// Diagnostico de que le falta a un rango de cotizaciones (por id) para poder
// calcular su costo real: cuenta cuantas lineas de materiales y de mano de
// obra tiene cada una, y compara contra el costo/utilidad que el motor de
// calculo (server/lib/calc.js) esta devolviendo con lo que hay cargado hoy.
// Si una cotizacion no tiene ninguna linea de materiales ni de mano de obra,
// el "costo interno total" que muestra la app en 0 (o casi) no es un costo
// real: es que todavia no se le ha cargado nada (tipico de una cotizacion
// importada de Siigo, que no trae esa informacion).
//
// No escribe nada: solo lee, vía la API de la app ya desplegada, y guarda un
// reporte en un archivo JSON local para que Claude lo revise después.
//
// NUNCA escribas tu usuario/clave en este archivo: se piden por variables de
// entorno para que las escribas tu mismo en tu propia terminal.
//
// Uso en PowerShell:
//   $env:ADMIN_USERNAME = "admin"
//   $env:ADMIN_PASSWORD = "tu-clave"
//   node scripts/diagnostico-costos-cotizaciones.js https://proenergy-costeo-production-8844.up.railway.app 200 234
//
// (los dos numeros al final son el id inicial y el id final del rango, ambos
// incluidos; si los omites usa 1 y el ultimo id que exista)

const BASE_URL = (process.argv[2] || '').replace(/\/+$/, '');
const DESDE = process.argv[3] ? Number(process.argv[3]) : null;
const HASTA = process.argv[4] ? Number(process.argv[4]) : null;
const USERNAME = process.env.ADMIN_USERNAME;
const PASSWORD = process.env.ADMIN_PASSWORD;

if (!BASE_URL) {
  console.error('Uso: node scripts/diagnostico-costos-cotizaciones.js <URL_DE_LA_APP> [id_desde] [id_hasta]');
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

async function main() {
  console.log(`Conectando a ${BASE_URL} ...`);
  await login();
  console.log('Sesión iniciada correctamente.');

  const lista = await api('/api/cotizaciones'); // resumen de todas
  const idsDisponibles = lista.map((r) => r.id).sort((a, b) => a - b);
  const minId = DESDE ?? idsDisponibles[0];
  const maxId = HASTA ?? idsDisponibles[idsDisponibles.length - 1];
  console.log(`Analizando cotizaciones con id entre ${minId} y ${maxId} (de un total de ${lista.length} en la base)...`);

  const objetivo = lista.filter((r) => r.id >= minId && r.id <= maxId);
  const reporte = [];

  for (const r of objetivo) {
    let detalle;
    try {
      detalle = await api(`/api/cotizaciones/${r.id}`);
    } catch (e) {
      reporte.push({ id: r.id, numero: r.numero, error: e.message });
      continue;
    }
    const nMateriales = detalle.materiales.length;
    const nManoObra = detalle.manoObra.length;
    const sinDatosDeCosto = nMateriales === 0 && nManoObra === 0;
    reporte.push({
      id: r.id,
      numero: r.numero,
      cliente: r.cliente,
      descripcion: r.descripcion,
      estado: r.estado,
      origen_siigo: !!detalle.cot.siigo_quotation_id,
      precio_venta: r.precio_venta,
      lineas_materiales: nMateriales,
      lineas_mano_obra: nManoObra,
      costo_interno_total_actual: r.costoInternoTotal,
      utilidad_actual: r.utilidad,
      margen_actual: r.margenPct,
      sin_datos_de_costo: sinDatosDeCosto,
    });
  }

  const outPath = require('node:path').join(__dirname, '..', `diagnostico-costos-${minId}-${maxId}.json`);
  require('node:fs').writeFileSync(outPath, JSON.stringify({ generado_en: new Date().toISOString(), base_url: BASE_URL, total: reporte.length, reporte }, null, 2));

  const sinDatos = reporte.filter((r) => r.sin_datos_de_costo);
  const deSiigo = reporte.filter((r) => r.origen_siigo);
  console.log(`\nListo. Reporte guardado en: ${outPath}`);
  console.log(`Total analizadas: ${reporte.length}`);
  console.log(`Sin ninguna línea de materiales ni mano de obra (costo en $0 real): ${sinDatos.length}`);
  console.log(`Importadas de Siigo: ${deSiigo.length}`);
}

main().catch((e) => {
  console.error('\nERROR:', e.message);
  process.exit(1);
});
