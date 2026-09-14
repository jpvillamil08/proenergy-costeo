'use strict';
// Herramientas de solo lectura que el asistente de chat puede usar para
// responder preguntas sobre los datos reales de PROENERGY. Cada herramienta
// reutiliza la misma logica de calculo que ya usan el Dashboard y el detalle
// de cotizacion (server/lib/cotizacion-service.js + calc.js), asi que las
// cifras que entrega el asistente son siempre consistentes con lo que se ve
// en la app.

const db = require('../db');
const svc = require('./cotizacion-service');
const { resumen } = require('../routes/cotizaciones.routes');
const { todayStr, diffDays } = require('./dates');

const ACTIVAS = ['Enviada', 'Aprobada', 'Ejecutada', 'Cerrada'];

function redondear(n, dec = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = Math.pow(10, dec);
  return Math.round(Number(n) * f) / f;
}

function resumenCompacto(r) {
  return {
    numero: r.numero, cliente: r.cliente, estado: r.estado,
    fecha_cotizacion: r.fecha_cotizacion,
    precio_venta: redondear(r.precio_venta),
    utilidad: redondear(r.utilidad),
    margenPct: redondear(r.margenPct, 4),
    semaforo: r.semaforo,
    estadoPago: r.estadoPago,
    saldoPendiente: redondear(r.saldoPendiente),
    diasMora: r.diasMora,
    riesgoLiquidez: r.riesgoLiquidez,
  };
}

function todasLasCotizaciones() {
  return svc.listCotizacionesFull().map(resumen);
}

// ---- Herramienta: resumen_general ----
function resumenGeneral() {
  const rows = todasLasCotizaciones();
  const activas = rows.filter((r) => ACTIVAS.includes(r.estado));
  const valorTotalOfertado = activas.reduce((a, r) => a + r.precio_venta, 0);
  const utilidadTotal = activas.reduce((a, r) => a + r.utilidad, 0);
  const margenPromedioPonderado = valorTotalOfertado ? utilidadTotal / valorTotalOfertado : 0;

  const porEstado = {};
  rows.forEach((r) => { porEstado[r.estado] = (porEstado[r.estado] || 0) + 1; });

  const noViables = activas.filter((r) => r.semaforo === 'NO_VIABLE');
  // Sin lineas de costo cargadas: su margen no es real y no debe leerse como rentabilidad.
  const sinCostos = rows.filter((r) => r.semaforo === 'SIN_DATOS');
  const vencidas = rows.filter((r) => r.estadoPago === 'VENCIDO');
  const carteraVencida = vencidas.reduce((a, r) => a + (r.saldoPendiente || 0), 0);
  const carteraPorCobrar = rows.reduce((a, r) => a + (r.saldoPendiente || 0), 0);
  const cajaNegativa = activas.filter((r) => r.cajaNegativa);

  return {
    fecha_consulta: todayStr(),
    total_cotizaciones: rows.length,
    por_estado: porEstado,
    valor_total_ofertado_activas: redondear(valorTotalOfertado),
    utilidad_total_activas: redondear(utilidadTotal),
    margen_promedio_ponderado: redondear(margenPromedioPonderado, 4),
    cartera_por_cobrar: redondear(carteraPorCobrar),
    cartera_vencida: redondear(carteraVencida),
    cantidad_sin_costos_cargados: sinCostos.length,
    advertencia_sin_costos: sinCostos.length
      ? `${sinCostos.length} cotizacion(es) no tienen materiales ni mano de obra cargados: su costo y su margen no son reales.`
      : null,
    cantidad_no_viables: noViables.length,
    cotizaciones_no_viables: noViables.slice(0, 15).map(resumenCompacto),
    cantidad_cartera_vencida: vencidas.length,
    cotizaciones_cartera_vencida: vencidas.slice(0, 15).map(resumenCompacto),
    cantidad_caja_negativa: cajaNegativa.length,
    cotizaciones_caja_negativa: cajaNegativa.slice(0, 15).map(resumenCompacto),
  };
}

// ---- Herramienta: buscar_cotizaciones ----
function buscarCotizaciones({ texto, estado, solo_no_viables, solo_vencidas } = {}) {
  let rows = todasLasCotizaciones();
  if (texto) {
    const t = String(texto).toLowerCase();
    rows = rows.filter((r) => `${r.numero} ${r.cliente}`.toLowerCase().includes(t));
  }
  if (estado) rows = rows.filter((r) => r.estado === estado);
  if (solo_no_viables) rows = rows.filter((r) => r.semaforo === 'NO_VIABLE');
  if (solo_vencidas) rows = rows.filter((r) => r.estadoPago === 'VENCIDO');
  return { total_encontradas: rows.length, resultados: rows.slice(0, 25).map(resumenCompacto) };
}

// ---- Herramienta: detalle_cotizacion ----
function detalleCotizacion({ numero } = {}) {
  if (!numero) return { error: 'Debes indicar el numero de cotizacion (ej: COT-0001).' };
  const rows = svc.listCotizacionesFull();
  const full = rows.find((f) => f.cot.numero.toLowerCase() === String(numero).toLowerCase());
  if (!full) return { error: `No se encontro ninguna cotizacion con numero "${numero}".` };
  const r = resumen(full);
  const c = full.calculo.costeoPresupuestado;
  return {
    ...resumenCompacto(r),
    descripcion: r.descripcion,
    condicion_pago: r.condicion_pago,
    dias_credito_otorgados: r.dias_credito_otorgados,
    costo_interno_total: redondear(c.costoInternoTotal),
    materiales_directos: redondear(c.materialesDirectos),
    materiales_indirectos: redondear(c.materialesIndirectos),
    costo_mano_obra_interna: redondear(c.costoMoInterna),
    costo_mano_obra_externa: redondear(c.costoMoExterna),
    gastos_fijos_aplicados: redondear(c.gastosFijosAplicados),
    imprevistos: redondear(c.imprevistos),
    comision_ventas: redondear(c.comisionVentas),
    horas_totales: redondear(c.horasTotales, 1),
    mensaje_semaforo: full.calculo.semaforo.mensaje,
    total_recaudado: redondear(r.totalRecaudado),
  };
}

// ---- Herramienta: cuentas_por_pagar_pendientes ----
function cuentasPorPagarPendientes() {
  const hoy = todayStr();
  const cxp = db.prepare(
    `SELECT cxp.*, c.numero AS cotizacion_numero, p.nombre AS proveedor_nombre FROM cuentas_por_pagar cxp
     LEFT JOIN cotizaciones c ON c.id = cxp.cotizacion_id LEFT JOIN proveedores p ON p.id = cxp.proveedor_id
     WHERE cxp.pagado = 0 ORDER BY cxp.fecha_vencimiento`
  ).all();
  const conDias = cxp.map((c) => ({
    proveedor: c.proveedor_nombre || 'Sin proveedor',
    cotizacion: c.cotizacion_numero || null,
    valor: redondear(c.valor),
    fecha_vencimiento: c.fecha_vencimiento,
    dias_para_vencer: diffDays(c.fecha_vencimiento, hoy) === null ? null : -diffDays(c.fecha_vencimiento, hoy),
    vencida: diffDays(c.fecha_vencimiento, hoy) !== null && diffDays(c.fecha_vencimiento, hoy) < 0,
  }));
  return {
    total_pendiente: redondear(conDias.reduce((a, c) => a + c.valor, 0)),
    cantidad: conDias.length,
    cuentas: conDias.slice(0, 30),
  };
}

// ---- Herramienta: buscar_material_catalogo ----
function buscarMaterialCatalogo({ texto } = {}) {
  if (!texto) return { error: 'Debes indicar que material buscar.' };
  const t = String(texto).toLowerCase();
  const materiales = db.prepare('SELECT * FROM materiales WHERE activo = 1 AND lower(descripcion) LIKE ? ORDER BY descripcion').all(`%${t}%`);
  const resultados = materiales.slice(0, 15).map((m) => {
    const precios = db.prepare(
      `SELECT mp.precio_unitario, mp.precio_con_iva, p.nombre AS proveedor FROM materiales_precios mp
       JOIN proveedores p ON p.id = mp.proveedor_id WHERE mp.material_id = ? ORDER BY mp.precio_unitario ASC`
    ).all(m.id);
    return {
      descripcion: m.descripcion,
      unidad: m.unidad,
      precios: precios.map((p) => ({ proveedor: p.proveedor, precio_unitario: redondear(p.precio_unitario), precio_con_iva: redondear(p.precio_con_iva) })),
      mejor_precio: precios.length ? redondear(precios[0].precio_unitario) : null,
      mejor_proveedor: precios.length ? precios[0].proveedor : null,
    };
  });
  return { total_encontrados: materiales.length, resultados };
}

// ---- Herramienta: consultar_presupuesto ----
function consultarPresupuesto({ anio, texto } = {}) {
  const anioNum = Number(anio) || new Date().getFullYear();
  const lineaDefs = db.prepare('SELECT * FROM presupuesto_lineas ORDER BY orden').all();
  let lineas = lineaDefs;
  if (texto) {
    const t = String(texto).toLowerCase();
    lineas = lineas.filter((l) => l.etiqueta.toLowerCase().includes(t));
  } else {
    // Sin texto: devuelve solo las lineas principales del P&G (nivel 1) para no saturar la respuesta.
    lineas = lineas.filter((l) => l.nivel <= 1);
  }
  const resultado = lineas.slice(0, 25).map((l) => {
    const filas = db.prepare('SELECT mes, valor FROM presupuesto_valores WHERE linea_id = ? AND anio = ?').all(l.id, anioNum);
    const porMes = {};
    filas.forEach((f) => { porMes[f.mes] = redondear(f.valor); });
    const total = filas.reduce((a, f) => a + (f.valor || 0), 0);
    return { etiqueta: l.etiqueta, nivel: l.nivel, es_total: !!l.es_total, valores_por_mes: porMes, total_anio: redondear(total) };
  });
  return { anio: anioNum, total_lineas_encontradas: lineas.length, lineas: resultado };
}

const HERRAMIENTAS = [
  {
    schema: {
      name: 'resumen_general',
      description: 'Devuelve un resumen general del estado actual de PROENERGY: KPIs (valor ofertado, utilidad, margen, cartera por cobrar y vencida), y las cotizaciones no viables, con cartera vencida o con riesgo de caja negativa. Usa esta herramienta como punto de partida para preguntas generales sobre el estado del negocio.',
      input_schema: { type: 'object', properties: {} },
    },
    ejecutar: async () => resumenGeneral(),
  },
  {
    schema: {
      name: 'buscar_cotizaciones',
      description: 'Busca cotizaciones por texto (numero o nombre de cliente), estado, o filtros de no viables / cartera vencida. Usa esta herramienta cuando el usuario pregunte por cotizaciones de un cliente especifico o con ciertas caracteristicas.',
      input_schema: {
        type: 'object',
        properties: {
          texto: { type: 'string', description: 'Texto a buscar en el numero o el nombre del cliente (busqueda parcial, no distingue mayusculas).' },
          estado: { type: 'string', enum: ['Borrador', 'Enviada', 'Aprobada', 'Rechazada', 'Ejecutada', 'Cerrada'], description: 'Filtrar por estado exacto de la cotizacion.' },
          solo_no_viables: { type: 'boolean', description: 'Si es true, solo devuelve cotizaciones con semaforo NO_VIABLE.' },
          solo_vencidas: { type: 'boolean', description: 'Si es true, solo devuelve cotizaciones con cartera en estado VENCIDO.' },
        },
      },
    },
    ejecutar: async (input) => buscarCotizaciones(input),
  },
  {
    schema: {
      name: 'detalle_cotizacion',
      description: 'Devuelve el detalle completo de una cotizacion especifica (costos, utilidad, margen, cartera, flujo de caja) a partir de su numero exacto (ej: COT-0001). Usa buscar_cotizaciones primero si no conoces el numero exacto.',
      input_schema: {
        type: 'object',
        properties: { numero: { type: 'string', description: 'Numero exacto de la cotizacion, ej: COT-0001.' } },
        required: ['numero'],
      },
    },
    ejecutar: async (input) => detalleCotizacion(input),
  },
  {
    schema: {
      name: 'cuentas_por_pagar_pendientes',
      description: 'Devuelve la lista de cuentas por pagar a proveedores que aun no han sido pagadas, con su fecha de vencimiento y si ya estan vencidas. Usa esta herramienta para preguntas sobre pagos a proveedores o flujo de caja saliente.',
      input_schema: { type: 'object', properties: {} },
    },
    ejecutar: async () => cuentasPorPagarPendientes(),
  },
  {
    schema: {
      name: 'buscar_material_catalogo',
      description: 'Busca materiales en el catalogo de precios por proveedor (ej: cables, conectores, breakers) y devuelve el precio de cada proveedor que lo cotizo, indicando cual es el mas barato. Usa esta herramienta para preguntas sobre precios o proveedores de materiales especificos.',
      input_schema: {
        type: 'object',
        properties: { texto: { type: 'string', description: 'Texto a buscar en la descripcion del material (busqueda parcial).' } },
        required: ['texto'],
      },
    },
    ejecutar: async (input) => buscarMaterialCatalogo(input),
  },
  {
    schema: {
      name: 'consultar_presupuesto',
      description: 'Consulta el presupuesto anual de PROENERGY (ingresos, costos, gastos, utilidad) mes a mes, importado del modelo de presupuesto de la empresa. Si no se indica texto, devuelve las lineas principales del estado de resultados (Ingresos Operacionales, Costos Operacionales, Utilidad Bruta, Gastos Operacionales, Utilidad Operacional, Utilidad Neta, etc). Usa el parametro texto para buscar una linea especifica (ej: "nomina", "combustible", "seguros").',
      input_schema: {
        type: 'object',
        properties: {
          anio: { type: 'integer', description: 'Año del presupuesto a consultar (ej: 2026 o 2027). Si no se indica, usa el año actual.' },
          texto: { type: 'string', description: 'Texto para buscar una linea especifica del presupuesto por su nombre (busqueda parcial).' },
        },
      },
    },
    ejecutar: async (input) => consultarPresupuesto(input),
  },
  {
    schema: {
      name: 'buscar_empresas_crm',
      description: 'Busca empresas (clientes y prospectos) en el CRM por nombre, NIT o ciudad, o filtra por tipo (Cliente, Prospecto, Inactivo). Devuelve facturado de los ultimos 12 meses, cartera, negocios abiertos, ultima factura y ultimo contacto. Usala para preguntas sobre clientes.',
      input_schema: {
        type: 'object',
        properties: {
          texto: { type: 'string', description: 'Parte del nombre, NIT o ciudad.' },
          tipo: { type: 'string', enum: ['Cliente', 'Prospecto', 'Inactivo'] },
        },
      },
    },
    ejecutar: async (input) => buscarEmpresasCrm(input),
  },
  {
    schema: {
      name: 'ficha_empresa_crm',
      description: 'Ficha 360 de una empresa del CRM: datos, contactos, negocios con su etapa y valor, ultimas actividades (llamadas, visitas, notas), cotizaciones, facturas, cartera y ordenes de compra. Usala antes de sugerir la siguiente accion con un cliente.',
      input_schema: {
        type: 'object',
        properties: { empresa: { type: 'string', description: 'Nombre (o parte) o NIT de la empresa.' } },
        required: ['empresa'],
      },
    },
    ejecutar: async (input) => fichaEmpresaCrm(input),
  },
  {
    schema: {
      name: 'embudo_crm',
      description: 'Estado del embudo comercial: negocios abiertos por etapa con su valor sin IVA, pronostico ponderado, ganados y perdidos del periodo, tasa de cierre, ciclo de venta, motivos de perdida, facturado del mes contra la meta del presupuesto y los negocios abiertos mas grandes.',
      input_schema: {
        type: 'object',
        properties: {
          desde: { type: 'string', description: 'Fecha inicial YYYY-MM-DD del periodo (por defecto, 1 de enero del año actual).' },
          hasta: { type: 'string', description: 'Fecha final YYYY-MM-DD (por defecto, hoy).' },
        },
      },
    },
    ejecutar: async (input) => embudoCrm(input),
  },
  {
    schema: {
      name: 'alertas_crm',
      description: 'Alertas comerciales con la evidencia de cada una: tareas vencidas y de hoy, negocios con fecha de cierre pasada, propuestas sin respuesta, negocios sin actividad, solicitudes del buzon pendientes, OC sin factura y clientes a reactivar (facturaban y llevan mas de 180 dias sin factura). Usala para "que debo hacer hoy", "a quien llamo" o "que clientes reactivar".',
      input_schema: { type: 'object', properties: {} },
    },
    ejecutar: async () => alertasCrm(),
  },
];

// ---------------------------------------------------------------- CRM
// Se pide lib/crm aqui dentro para no cargarlo antes que la base de datos.
function crmLib() {
  return require('./crm');
}

function buscarEmpresasCrm({ texto, tipo } = {}) {
  const lista = crmLib().listarEmpresas({ texto, tipo }).slice(0, 25);
  return lista.map((e) => ({
    id: e.id, nombre: e.nombre, nit: e.nit, tipo: e.tipo, sector: e.sector, ciudad: e.ciudad,
    facturado_12m: redondear(e.facturado_12m), cartera: redondear(e.cartera), negocios_abiertos: e.negocios_abiertos,
    ultima_factura: e.ultima_factura, ultimo_contacto: e.ultimo_contacto, dias_sin_contacto: e.dias_sin_contacto,
  }));
}

function fichaEmpresaCrm({ empresa } = {}) {
  const crm = crmLib();
  const candidatas = crm.listarEmpresas({ texto: empresa });
  if (!candidatas.length) return { error: `No se encontró ninguna empresa con "${empresa}".` };
  if (candidatas.length > 1 && !candidatas.some((c) => c.nombre.toLowerCase() === String(empresa).toLowerCase())) {
    if (candidatas.length > 5) return { varias: candidatas.slice(0, 10).map((c) => c.nombre), aviso: 'Hay varias empresas; pregunte cuál.' };
  }
  const elegida = candidatas.find((c) => c.nombre.toLowerCase() === String(empresa).toLowerCase()) || candidatas[0];
  const f = crm.ficha360(elegida.id);
  return {
    empresa: { nombre: f.empresa.nombre, nit: f.empresa.nit, tipo: f.empresa.tipo, sector: f.empresa.sector, ciudad: f.empresa.ciudad, notas: f.empresa.notas },
    indicadores: Object.fromEntries(Object.entries(f.kpis).map(([k, v]) => [k, typeof v === 'number' ? redondear(v, k === 'tasa_cierre' ? 4 : 0) : v])),
    contactos: f.contactos.map((c) => ({ nombre: c.nombre, cargo: c.cargo, rol: c.rol, email: c.email, celular: c.celular, principal: Boolean(c.es_principal) })),
    negocios: f.negocios.slice(0, 15).map((n) => ({
      nombre: n.nombre, etapa: n.etapa, valor_sin_iva: redondear(n.valor_sin_iva), dias_en_etapa: n.dias_en_etapa,
      dias_sin_actividad: n.dias_sin_actividad, fecha_cierre_esperada: n.fecha_cierre_esperada, fecha_cierre_real: n.fecha_cierre_real, motivo_perdida: n.motivo_perdida,
    })),
    ultimas_actividades: f.actividades.slice(0, 10).map((a) => ({ tipo: a.tipo, asunto: a.asunto, fecha: a.completada_en || a.fecha_programada, realizada: Boolean(a.completada), resultado: a.resultado })),
    cotizaciones_recientes: f.cotizaciones.slice(0, 10).map((c) => ({ numero: c.numero, fecha: c.fecha_cotizacion, estado: c.estado, valor_con_iva: redondear(c.con), actividad: c.titulo })),
    facturas_recientes: f.facturas.slice(0, 10).map((x) => ({ numero: x.numero, fecha: x.fecha, total: redondear(x.total), saldo: redondear(x.saldo), estado: x.estado })),
    ordenes_compra: f.ordenes.slice(0, 10).map((o) => ({ numero: o.numero, fecha: o.fecha, valor: redondear(o.valor), cotizacion: o.cotizacion_numero })),
  };
}

function embudoCrm({ desde, hasta } = {}) {
  const crm = crmLib();
  const t = crm.tablero({ desde, hasta });
  const abiertos = crm.listarNegocios({ abiertos: true }).sort((a, b) => b.valor_sin_iva - a.valor_sin_iva).slice(0, 10);
  return {
    periodo: { desde: t.desde, hasta: t.hasta },
    indicadores: Object.fromEntries(Object.entries(t.kpis).map(([k, v]) => [k, typeof v === 'number' ? redondear(v, ['conversion', 'cumplimiento_meta'].includes(k) ? 4 : 0) : v])),
    embudo: t.embudo.map((e) => ({ etapa: e.etapa, negocios: e.cantidad, valor_sin_iva: redondear(e.valor_sin_iva), probabilidad: e.probabilidad, ponderado: redondear(e.ponderado) })),
    pronostico_por_mes: t.pronostico.map((p) => ({ mes: p.etiqueta, negocios: p.cantidad, valor_sin_iva: redondear(p.valor_sin_iva), ponderado: redondear(p.ponderado) })),
    motivos_perdida: t.motivosPerdida,
    dias_promedio_por_etapa: t.diasPorEtapa.map((d) => ({ etapa: d.etapa, dias: redondear(d.dias_promedio, 1), negocios: d.negocios })),
    negocios_abiertos_mas_grandes: abiertos.map((n) => ({ nombre: n.nombre, empresa: n.empresa_nombre, etapa: n.etapa, valor_sin_iva: redondear(n.valor_sin_iva), dias_en_etapa: n.dias_en_etapa, fecha_cierre_esperada: n.fecha_cierre_esperada })),
    formulas: t.desglose.map((d) => `${d.concepto}: ${d.formula}`),
  };
}

function alertasCrm() {
  const a = crmLib().alertas();
  return {
    total: a.total, criticas: a.criticas,
    alertas: a.alertas.slice(0, 40).map((x) => ({ grupo: x.grupo, severidad: x.severidad, titulo: x.titulo, evidencia: x.detalle })),
    clientes_a_reactivar: crmLib().clientesAReactivar().slice(0, 15).map((r) => ({ empresa: r.nombre, ultima_factura: r.ultima_factura, numero: r.ultima_numero, dias_sin_factura: r.dias, facturado_historico: redondear(r.facturado), facturas: r.n_facturas })),
  };
}

module.exports = {
  HERRAMIENTAS, resumenGeneral, buscarCotizaciones, detalleCotizacion, cuentasPorPagarPendientes, buscarMaterialCatalogo, consultarPresupuesto,
  buscarEmpresasCrm, fichaEmpresaCrm, embudoCrm, alertasCrm,
};
