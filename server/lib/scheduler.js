'use strict';
// Programador de tareas automaticas, sin librerias (solo setTimeout).
//
// Hoy corre una sola tarea: la sincronizacion diaria con Siigo a las 7:00 p.m.
// hora de Colombia, que importa las cotizaciones nuevas y les carga los
// materiales. Antes de esto, las cotizaciones de Siigo se quedaban sin importar
// hasta que alguien se acordaba de darle al boton (llegaron a acumularse 5 dias).
//
// IMPORTANTE - zona horaria: el contenedor de Railway corre en UTC, no en hora
// de Colombia. Por eso la hora NO se calcula con getHours() (que devolveria la
// hora del contenedor) sino en UTC explicito, igual que hace lib/dates.js:
// Colombia es UTC-5 todo el año (no tiene horario de verano), asi que las
// 7:00 p.m. de Bogota son las 00:00 UTC del dia siguiente.
//
// Si el servicio se reinicia (un despliegue, por ejemplo) el temporizador se
// pierde y se vuelve a programar solo al arrancar. Si el reinicio ocurre justo
// despues de la hora, esa corrida se salta y se hace al dia siguiente; nada se
// pierde, porque la sincronizacion siempre mira los ultimos 30 dias y solo trae
// lo que falte.

const siigo = require('./siigo');
const sync = require('./siigo-sync');
const { registrar } = require('./audit');

const OFFSET_COLOMBIA_HORAS = -5;
const HORA_LOCAL_SINCRONIZACION = 19; // 7:00 p.m. hora de Colombia
const DIAS_HACIA_ATRAS = 30; // ventana que se revisa en Siigo en cada corrida

// Estado en memoria, expuesto por GET /api/siigo/sync/estado para poder ver
// desde la app si el programador esta vivo y como fue la ultima corrida.
const estado = {
  activo: false,
  proximaEjecucion: null,
  ultimaEjecucion: null,
  ultimoResultado: null,
  ultimoError: null,
  ejecutando: false,
  corridas: 0,
};

// Milisegundos desde ahora hasta la proxima vez que sean las HORA_LOCAL en la
// zona indicada. Todo el calculo se hace sobre el reloj UTC para no depender
// de la zona horaria del contenedor.
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
    const r = await sync.sincronizar({
      dias: DIAS_HACIA_ATRAS,
      usuario: null, // queda en auditoria como "Sistema"
      parametrosVigenteEn,
      politicaVigenteEn,
    });
    estado.ultimaEjecucion = new Date().toISOString();
    estado.ultimoResultado = r;
    estado.ultimoError = null;
    estado.corridas++;
    console.log(
      `[scheduler] Sincronizacion ${etiqueta} lista en ${r.duracionSegundos}s: ` +
      `${r.cotizacionesImportadas} cotizacion(es) nueva(s), ${r.lineasInsertadas} linea(s) ` +
      `(${r.lineasSinPrecio} sin precio), ${r.errores.length} error(es).`
    );
    // Solo se deja rastro en auditoria cuando algo cambio, para no llenarla de
    // registros vacios los dias en que Siigo no trae nada nuevo.
    if (r.cotizacionesImportadas || r.lineasInsertadas) {
      registrar({
        usuario: null, accion: 'SINCRONIZAR', entidad: 'siigo', entidadId: null,
        valorNuevo: `Sincronizacion ${etiqueta}: ${r.cotizacionesImportadas} cotizacion(es) nueva(s), ` +
          `${r.lineasInsertadas} linea(s) de materiales (${r.lineasSinPrecio} sin precio).`,
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
  }
}

function programarSiguiente() {
  const { ms, fecha } = msHastaProximaHoraLocal(HORA_LOCAL_SINCRONIZACION, OFFSET_COLOMBIA_HORAS);
  estado.proximaEjecucion = fecha.toISOString();
  const horas = (ms / 3600000).toFixed(1);
  console.log(`[scheduler] Proxima sincronizacion con Siigo: ${fecha.toISOString()} (en ${horas} h) = 7:00 p.m. hora Colombia.`);
  const t = setTimeout(async () => {
    await ejecutarSincronizacion({ manual: false });
    programarSiguiente(); // se reprograma para el dia siguiente
  }, ms);
  // No mantiene vivo el proceso por si mismo: si el servidor se apaga, se apaga.
  if (typeof t.unref === 'function') t.unref();
}

function iniciar() {
  if (estado.activo) return estado;
  estado.activo = true;
  if (!siigo.configurada()) {
    console.log('[scheduler] Siigo no esta configurado: la sincronizacion diaria queda programada pero no hara nada hasta que se definan las variables de entorno.');
  }
  programarSiguiente();
  return estado;
}

module.exports = { iniciar, ejecutarSincronizacion, estado, msHastaProximaHoraLocal };
