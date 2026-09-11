'use strict';
// Programador de tareas automaticas, sin librerias (solo setTimeout).
//
// Corre la sincronizacion completa con Siigo dos veces al dia, a las 9:00 a.m.
// y a las 5:00 p.m. hora de Colombia:
//   - importa las cotizaciones nuevas y les carga los materiales;
//   - pone al dia las ya importadas que alguien edito en Siigo (precio, items);
//   - completa los titulos y costea con la regla del precio las lineas en $0;
//   - trae las facturas del año pasado y del actual (saldos y pagos) y las
//     vincula con sus cotizaciones.
// Antes solo importaba cotizaciones nuevas a las 7 p.m.: las ediciones en Siigo
// nunca llegaban a la app y costos y facturas dependian de correr a mano el
// comando diario en el PC.
//
// IMPORTANTE - zona horaria: el contenedor de Railway corre en UTC, no en hora
// de Colombia. Por eso la hora NO se calcula con getHours() (que devolveria la
// hora del contenedor) sino en UTC explicito, igual que hace lib/dates.js:
// Colombia es UTC-5 todo el año (no tiene horario de verano), asi que las
// 9:00 a.m. y 5:00 p.m. de Bogota son las 14:00 y las 22:00 UTC.
//
// Si el servicio se reinicia (un despliegue, por ejemplo) el temporizador se
// pierde y se vuelve a programar solo al arrancar. Si el reinicio ocurre justo
// despues de la hora, esa corrida se salta y se hace al dia siguiente; nada se
// pierde, porque la sincronizacion siempre mira los ultimos 30 dias y solo trae
// lo que falte.

const siigo = require('./siigo');
const sync = require('./siigo-sync');
const facturasSync = require('./facturas-sync');
const { registrar } = require('./audit');
const { todayStr } = require('./dates');

const OFFSET_COLOMBIA_HORAS = -5;
const HORAS_LOCALES_SINCRONIZACION = [9, 17]; // 9:00 a.m. y 5:00 p.m. hora de Colombia
const DIAS_HACIA_ATRAS = 30; // ventana de cotizaciones NUEVAS que se revisa en Siigo

// Estado en memoria, expuesto por GET /api/siigo/sync/estado para poder ver
// desde la app si el programador esta vivo y como fue la ultima corrida.
const estado = {
  activo: false,
  proximaEjecucion: null,
  ultimaEjecucion: null,
  ultimoResultado: null,
  ultimoError: null,
  ejecutando: false,
  paso: null, // en que va la corrida en curso (para ver el avance desde la app)
  corridas: 0,
};

// Milisegundos desde ahora hasta la proxima vez que sean las HORA_LOCAL en la
// zona indicada. Todo el calculo se hace sobre el reloj UTC para no depender
// de la zona horaria del contenedor.
// La mas cercana de varias horas locales del dia.
function msHastaProximaDeVarias(horasLocales, offsetHoras, ahora = new Date()) {
  return horasLocales
    .map((h) => msHastaProximaHoraLocal(h, offsetHoras, ahora))
    .sort((a, b) => a.ms - b.ms)[0];
}

function msHastaProximaHoraLocal(horaLocal, offsetHoras, ahora = new Date()) {
  const horaUtcObjetivo = ((horaLocal - offsetHoras) % 24 + 24) % 24;
  const objetivo = new Date(Date.UTC(
    ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate(),
    horaUtcObjetivo, 0, 0, 0
  ));
  if (objetivo.getTime() <= ahora.getTime()) objetivo.setUTCDate(objetivo.getUTCDate() + 1);
  return { ms: objetivo.getTime() - ahora.getTime(), fecha: objetivo };
}

async function ejecutarSincronizacion({ manual = false } = {}) {
  if (estado.ejecutando) {
    return { omitida: true, motivo: 'Ya hay una sincronizacion en curso.' };
  }
  if (!siigo.configurada()) {
    const motivo = 'Siigo no esta configurado (faltan SIIGO_USERNAME, SIIGO_ACCESS_KEY y/o SIIGO_PARTNER_ID).';
    estado.ultimoError = motivo;
    console.log(`[scheduler] Sincronizacion omitida: ${motivo}`);
    return { omitida: true, motivo };
  }

  // Se piden aqui, no arriba, para evitar una dependencia circular:
  // las rutas importan lib/, no al reves.
  const { vigenteEn: parametrosVigenteEn } = require('../routes/parametros.routes');
  const { vigenteEn: politicaVigenteEn } = require('../routes/politicas.routes');

  estado.ejecutando = true;
  const etiqueta = manual ? 'manual' : 'automatica';
  console.log(`[scheduler] Iniciando sincronizacion ${etiqueta} con Siigo...`);
  try {
    const r = await sync.sincronizarCotizaciones({
      dias: DIAS_HACIA_ATRAS,
      usuario: null, // queda en auditoria como "Sistema"
      parametrosVigenteEn,
      politicaVigenteEn,
      alAvanzar: (paso) => { estado.paso = paso; },
    });
    // Facturas del año pasado y del actual: asi se refrescan saldos y pagos de
    // la cartera, no solo las facturas nuevas.
    estado.paso = 'Sincronizando facturas';
    try {
      const anio = Number(todayStr().slice(0, 4));
      const fr = await facturasSync.sincronizarFacturas({ desde: `${anio - 1}-01-01`, hasta: todayStr() });
      r.facturasSincronizadas = fr.totalSincronizadas;
      r.vinculoFacturas = fr.vinculo;
    } catch (e) {
      r.errores.push({ paso: 'facturas', error: e.message });
    }
    r.fin = new Date().toISOString();
    r.duracionSegundos = Math.round((Date.now() - new Date(r.inicio).getTime()) / 1000);
    estado.ultimaEjecucion = new Date().toISOString();
    estado.ultimoResultado = r;
    estado.ultimoError = null;
    estado.corridas++;
    const resumen = `${r.cotizacionesImportadas} cotizacion(es) nueva(s), ` +
      `${r.modificadas.modificadas} modificada(s) en Siigo, ${r.lineasInsertadas} linea(s) nuevas ` +
      `(${r.lineasSinPrecio} sin precio), ${r.lineasCosteadasPorRegla} costeada(s) por regla, ` +
      `${r.titulosCompletados} titulo(s), ${r.facturasSincronizadas ?? 0} factura(s)`;
    console.log(`[scheduler] Sincronizacion ${etiqueta} lista en ${r.duracionSegundos}s: ${resumen}, ${r.errores.length} error(es).`);
    // Solo se deja rastro en auditoria cuando algo cambio, para no llenarla de
    // registros vacios los dias en que Siigo no trae nada nuevo. (Cada
    // cotizacion modificada deja ademas su propio registro con el detalle.)
    if (r.cotizacionesImportadas || r.lineasInsertadas || r.modificadas.modificadas || r.lineasCosteadasPorRegla) {
      registrar({
        usuario: null, accion: 'SINCRONIZAR', entidad: 'siigo', entidadId: null,
        valorNuevo: `Sincronizacion ${etiqueta}: ${resumen}.`,
      });
    }
    return r;
  } catch (e) {
    estado.ultimoError = e.message;
    estado.ultimaEjecucion = new Date().toISOString();
    console.error(`[scheduler] Fallo la sincronizacion ${etiqueta}:`, e.message);
    return { error: e.message };
  } finally {
    estado.ejecutando = false;
    estado.paso = null;
  }
}

function programarSiguiente() {
  const { ms, fecha } = msHastaProximaDeVarias(HORAS_LOCALES_SINCRONIZACION, OFFSET_COLOMBIA_HORAS);
  estado.proximaEjecucion = fecha.toISOString();
  const horas = (ms / 3600000).toFixed(1);
  const local = (fecha.getUTCHours() + OFFSET_COLOMBIA_HORAS + 24) % 24;
  console.log(`[scheduler] Proxima sincronizacion con Siigo: ${fecha.toISOString()} (en ${horas} h) = ${local}:00 hora Colombia.`);
  const t = setTimeout(async () => {
    await ejecutarSincronizacion({ manual: false });
    programarSiguiente(); // se reprograma para la siguiente hora
  }, ms);
  // No mantiene vivo el proceso por si mismo: si el servidor se apaga, se apaga.
  if (typeof t.unref === 'function') t.unref();
}

function iniciar() {
  if (estado.activo) return estado;
  estado.activo = true;
  if (!siigo.configurada()) {
    console.log('[scheduler] Siigo no esta configurado: la sincronizacion queda programada pero no hara nada hasta que se definan las variables de entorno.');
  }
  programarSiguiente();
  return estado;
}

module.exports = { iniciar, ejecutarSincronizacion, estado, msHastaProximaHoraLocal, msHastaProximaDeVarias };
