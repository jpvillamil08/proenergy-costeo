'use strict';
// Motor de calculo: costeo, rentabilidad, semaforo de viabilidad, cartera y flujo de caja.
// Cada resultado se devuelve junto con una linea de "desglose" auditable (formula + valores).
const { todayStr, addDays, diffDays, isAfter, maxDate } = require('./dates');

const sum = (arr, fn) => arr.reduce((acc, x) => acc + (fn(x) || 0), 0);
const safeDiv = (a, b) => (b ? a / b : 0);

function totalGastosFijos(p) {
  if (!p) return 0;
  return (
    (p.arriendo_taller || 0) +
    (p.servicios_publicos || 0) +
    (p.internet_comunicaciones || 0) +
    (p.nomina_administrativa || 0) +
    (p.transporte_fijo || 0) +
    (p.depreciacion || 0) +
    (p.seguros_impuestos || 0) +
    (p.otros || 0)
  );
}

function costoFijoHora(p) {
  if (!p) return 0;
  return safeDiv(totalGastosFijos(p), p.horas_productivas_mes || 0);
}

// Bloque de costeo para un conjunto de lineas, en version 'presupuestado' o 'real'.
function costeoLineas(manoObra, materiales, precioVenta, parametros, politica, kind) {
  const horasCampo = kind === 'real' ? 'horas_reales' : 'horas_presupuestadas';
  const cantCampo = kind === 'real' ? 'cantidad_real' : 'cantidad_presupuestada';

  const moInterna = manoObra.filter((m) => m.tipo === 'Interno');
  const moExterna = manoObra.filter((m) => m.tipo === 'Externo');

  const horasInternas = sum(moInterna, (m) => m[horasCampo]);
  const horasExternas = sum(moExterna, (m) => m[horasCampo]);
  const horasTotales = horasInternas + horasExternas;

  const costoMoInterna = sum(moInterna, (m) => m[horasCampo] * m.tarifa_hora * (m.factor_prestacional || 1));
  const costoMoExterna = sum(moExterna, (m) => m[horasCampo] * m.tarifa_hora);

  const matDirectos = materiales.filter((m) => m.clasificacion === 'Directo');
  const matIndirectos = materiales.filter((m) => m.clasificacion === 'Indirecto');
  const materialesDirectos = sum(matDirectos, (m) => m[cantCampo] * m.costo_unitario);
  const materialesIndirectos = sum(matIndirectos, (m) => m[cantCampo] * m.costo_unitario);

  const subtotalCostoDirecto = materialesDirectos + materialesIndirectos + costoMoInterna + costoMoExterna;

  const cfh = costoFijoHora(parametros);
  const gastosFijosAplicados = horasTotales * cfh;

  const pctImprevistos = politica ? politica.pct_imprevistos : 0;
  const imprevistos = subtotalCostoDirecto * pctImprevistos;

  const pctComision = politica ? politica.pct_comision_ventas : 0;
  const comisionVentas = precioVenta * pctComision;

  const costoInternoTotal = subtotalCostoDirecto + gastosFijosAplicados + imprevistos + comisionVentas;

  const utilidad = precioVenta - costoInternoTotal;
  const margenPct = safeDiv(utilidad, precioVenta);
  const margenContribucion = safeDiv(precioVenta - subtotalCostoDirecto, precioVenta);

  const desglose = [
    { concepto: 'Materiales directos', formula: 'Σ (cantidad × costo unitario) de líneas Directo', valor: materialesDirectos },
    { concepto: 'Materiales indirectos', formula: 'Σ (cantidad × costo unitario) de líneas Indirecto', valor: materialesIndirectos },
    { concepto: 'Mano de obra interna', formula: 'Σ (horas × tarifa hora × factor prestacional)', valor: costoMoInterna },
    { concepto: 'Mano de obra externa', formula: 'Σ (horas × tarifa hora)', valor: costoMoExterna },
    { concepto: 'Subtotal costo directo', formula: 'Materiales directos + indirectos + M.O. interna + M.O. externa', valor: subtotalCostoDirecto, subtotal: true },
    { concepto: 'Horas totales', formula: 'Horas internas + horas externas', valor: horasTotales, esHoras: true },
    { concepto: 'Costo fijo por hora (parámetro vigente)', formula: 'Total gastos fijos mensuales ÷ horas productivas del mes', valor: cfh },
    { concepto: 'Gastos fijos aplicados', formula: 'Horas totales × costo fijo por hora', valor: gastosFijosAplicados },
    { concepto: `Imprevistos (${(pctImprevistos * 100).toFixed(1)}%)`, formula: 'Subtotal costo directo × % imprevistos', valor: imprevistos },
    { concepto: `Comisión de ventas (${(pctComision * 100).toFixed(1)}%)`, formula: 'Precio de venta × % comisión de ventas', valor: comisionVentas },
    { concepto: 'Costo interno total', formula: 'Costo directo + gastos fijos aplicados + imprevistos + comisión', valor: costoInternoTotal, subtotal: true },
    { concepto: 'Utilidad', formula: 'Precio de venta − costo interno total', valor: utilidad, subtotal: true },
    { concepto: 'Margen %', formula: 'Utilidad ÷ precio de venta', valor: margenPct, esPct: true },
  ];

  return {
    kind,
    horasInternas, horasExternas, horasTotales,
    costoMoInterna, costoMoExterna,
    materialesDirectos, materialesIndirectos, materialesTotal: materialesDirectos + materialesIndirectos,
    subtotalCostoDirecto,
    costoFijoHora: cfh, gastosFijosAplicados,
    pctImprevistos, imprevistos,
    pctComision, comisionVentas,
    costoInternoTotal,
    utilidad, margenPct, margenContribucion,
    desglose,
  };
}

function rentabilidadExtra(costeo, precioVenta, politica) {
  const objetivo = politica ? politica.pct_utilidad_objetivo : 0;
  const margenMin = politica ? politica.margen_minimo_aceptable : 0;
  const pctComision = politica ? politica.pct_comision_ventas : 0;

  const precioSugerido = objetivo < 1 ? safeDiv(costeo.costoInternoTotal, 1 - objetivo) : 0;
  const diferenciaPrecioSugerido = precioSugerido - precioVenta;

  // Parte fija del costo que no depende del precio (todo excepto la comision de ventas)
  const parteFija = costeo.subtotalCostoDirecto + costeo.gastosFijosAplicados + costeo.imprevistos;
  const precioEquilibrio = (1 - pctComision) > 0 ? safeDiv(parteFija, 1 - pctComision) : 0;

  const denomDescMax = 1 - margenMin - pctComision;
  const precioMinMargenMinimo = denomDescMax > 0 ? safeDiv(parteFija, denomDescMax) : precioVenta;
  const descuentoMaximo = precioVenta - precioMinMargenMinimo;
  const descuentoMaximoPct = safeDiv(descuentoMaximo, precioVenta);

  const utilidadPorHora = costeo.horasTotales > 0 ? safeDiv(costeo.utilidad, costeo.horasTotales) : null;
  const utilidadPorMaterial = costeo.materialesTotal > 0 ? safeDiv(costeo.utilidad, costeo.materialesTotal) : null;

  const base = costeo.costoInternoTotal || 1;
  const participaciones = {
    materialesDirectos: safeDiv(costeo.materialesDirectos, base),
    materialesIndirectos: safeDiv(costeo.materialesIndirectos, base),
    moInterna: safeDiv(costeo.costoMoInterna, base),
    moExterna: safeDiv(costeo.costoMoExterna, base),
    gastosFijos: safeDiv(costeo.gastosFijosAplicados, base),
    imprevistos: safeDiv(costeo.imprevistos, base),
    comision: safeDiv(costeo.comisionVentas, base),
  };

  return {
    precioSugerido, diferenciaPrecioSugerido,
    precioEquilibrio,
    descuentoMaximo, descuentoMaximoPct,
    utilidadPorHora, utilidadPorMaterial,
    participaciones,
    desglose: [
      { concepto: 'Precio sugerido', formula: 'Costo interno total ÷ (1 − % utilidad objetivo)', valor: precioSugerido },
      { concepto: 'Diferencia vs. precio ofertado', formula: 'Precio sugerido − precio ofertado', valor: diferenciaPrecioSugerido },
      { concepto: 'Precio de equilibrio (utilidad = 0)', formula: '(Costo directo + gastos fijos + imprevistos) ÷ (1 − % comisión)', valor: precioEquilibrio },
      { concepto: 'Descuento máximo posible', formula: 'Precio ofertado − precio al margen mínimo aceptable', valor: descuentoMaximo },
      { concepto: 'Utilidad por hora trabajada', formula: 'Utilidad ÷ horas totales', valor: utilidadPorHora },
      { concepto: 'Utilidad por peso de material invertido', formula: 'Utilidad ÷ total materiales', valor: utilidadPorMaterial },
    ],
  };
}

function evaluarSemaforo(costeoPresupuestado, politica, comparativo) {
  const margen = costeoPresupuestado.margenPct;
  const objetivo = politica ? politica.pct_utilidad_objetivo : 0;
  const margenMin = politica ? politica.margen_minimo_aceptable : 0;

  let estado, mensaje, ajuste = null;
  if (costeoPresupuestado.utilidad >= 0 && margen >= objetivo) {
    estado = 'VIABLE';
    mensaje = 'La cotización cumple o supera la utilidad objetivo definida en las políticas comerciales.';
  } else if (costeoPresupuestado.utilidad >= 0 && margen >= margenMin) {
    estado = 'VIABLE_CON_AJUSTE';
    const targetCosto = costeoPresupuestado.utilidad !== null ? null : null;
    const rent = rentabilidadExtra(costeoPresupuestado, costeoPresupuestado._precioVenta, politica);
    const costoObjetivo = costeoPresupuestado._precioVenta * (1 - objetivo);
    const bajarCostoEn = costeoPresupuestado.costoInternoTotal - costoObjetivo;
    const horasExceso = costeoPresupuestado.costoFijoHora > 0 ? bajarCostoEn / costeoPresupuestado.costoFijoHora : null;
    ajuste = {
      subirPrecioA: rent.precioSugerido,
      subirPrecioEn: rent.diferenciaPrecioSugerido,
      bajarCostoEn,
      horasDeMasEstimadas: horasExceso,
    };
    mensaje = `El margen (${(margen * 100).toFixed(1)}%) está entre el mínimo aceptable (${(margenMin * 100).toFixed(1)}%) y el objetivo (${(objetivo * 100).toFixed(1)}%). Para alcanzar el objetivo: suba el precio a ${Math.round(rent.precioSugerido).toLocaleString('es-CO')} (+${Math.round(rent.diferenciaPrecioSugerido).toLocaleString('es-CO')}), o reduzca el costo en ${Math.round(bajarCostoEn).toLocaleString('es-CO')}.`;
  } else {
    estado = 'NO_VIABLE';
    const motivos = [];
    if (costeoPresupuestado._precioVenta > 0 && costeoPresupuestado._precioVenta < costeoPresupuestado.subtotalCostoDirecto) {
      motivos.push('el precio ofertado es inferior incluso al costo directo (materiales + mano de obra).');
    }
    if (comparativo && comparativo.horas.desviacionPct > 0.1) {
      motivos.push(`exceso de horas ejecutadas frente a lo presupuestado (${(comparativo.horas.desviacionPct * 100).toFixed(1)}%).`);
    }
    if (comparativo && comparativo.materiales.desviacionPct > 0.1) {
      motivos.push(`materiales consumidos por encima de lo presupuestado (${(comparativo.materiales.desviacionPct * 100).toFixed(1)}%).`);
    }
    if (safeDiv(costeoPresupuestado.gastosFijosAplicados, costeoPresupuestado._precioVenta || 1) > 0.35) {
      motivos.push('el trabajo no alcanza a absorber los gastos fijos que le corresponden (poca escala frente a la estructura).');
    }
    if (!motivos.length) {
      motivos.push('el precio ofertado es demasiado bajo frente al costo interno total de la cotización.');
    }
    mensaje = `Margen (${(margen * 100).toFixed(1)}%) por debajo del mínimo aceptable (${(margenMin * 100).toFixed(1)}%) o utilidad negativa. Motivo(s): ${motivos.join(' ')}`;
  }
  return { estado, mensaje, ajuste };
}

function evaluarCartera(cot, politica, pagos) {
  const hoy = todayStr();
  const fechaAprobacion = cot.fecha_aprobacion;
  const diasEsperados = cot.condicion_pago === 'Credito' ? cot.dias_credito_otorgados : 0;
  const fechaPagoEsperada = fechaAprobacion ? addDays(fechaAprobacion, diasEsperados) : null;

  // El precio de venta (sin IVA) es la base sobre la que se hace seguimiento de cartera,
  // porque es la cifra que administracion cotiza, anticipa y concilia dia a dia.
  // El IVA/retefuente/ICA se calculan aparte como informacion adicional (valor facturado y neto real
  // a recibir), sin alterar el saldo pendiente ni el estado de pago.
  const pctIva = politica ? politica.pct_iva : 0;
  const pctRetefuente = politica ? politica.pct_retefuente : 0;
  const pctIca = politica ? politica.pct_ica : 0;
  const valorFacturado = cot.precio_venta * (1 + pctIva);
  const retenciones = cot.precio_venta * (pctRetefuente + pctIca);
  const netoARecibir = valorFacturado - retenciones;
  const montoBaseCobro = cot.precio_venta;

  const pagosOrdenados = [...pagos].sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  const totalRecaudado = sum(pagosOrdenados, (p) => p.valor);
  const saldoPendiente = Math.max(0, montoBaseCobro - totalRecaudado);
  const pctRecaudado = safeDiv(totalRecaudado, montoBaseCobro);
  const fechaUltimoPago = maxDate(pagosOrdenados.map((p) => p.fecha));

  let acumulado = 0;
  let fechaPagoTotal = null;
  for (const p of pagosOrdenados) {
    acumulado += p.valor;
    if (acumulado >= montoBaseCobro - 0.5) { fechaPagoTotal = p.fecha; break; }
  }

  const diasRealesCobro = fechaPagoTotal && fechaAprobacion ? diffDays(fechaPagoTotal, fechaAprobacion) : null;
  const desviacionDias = diasRealesCobro !== null ? diasRealesCobro - diasEsperados : null;

  let estadoPago;
  if (!fechaAprobacion) estadoPago = 'Sin facturar';
  else if (saldoPendiente <= 0.5) estadoPago = 'PAGADO';
  else if (fechaPagoEsperada && isAfter(hoy, fechaPagoEsperada)) estadoPago = 'VENCIDO';
  else if (totalRecaudado > 0) estadoPago = 'Abonado parcial';
  else estadoPago = 'Por cobrar';

  let diasMora = 0;
  let bucket = null;
  if (saldoPendiente > 0.5 && fechaPagoEsperada) {
    diasMora = diffDays(hoy, fechaPagoEsperada);
    if (diasMora <= 0) bucket = 'Corriente';
    else if (diasMora <= 30) bucket = '1-30';
    else if (diasMora <= 60) bucket = '31-60';
    else if (diasMora <= 90) bucket = '61-90';
    else bucket = '+90';
  }

  return {
    fechaPagoEsperada, diasEsperados,
    valorFacturado, retenciones, netoARecibir, montoBaseCobro,
    totalRecaudado, saldoPendiente, pctRecaudado,
    fechaUltimoPago, fechaPagoTotal,
    diasRealesCobro, desviacionDias,
    estadoPago, diasMora: Math.max(0, diasMora), bucket,
    desglose: [
      { concepto: 'Precio de venta (base de cobro)', formula: 'Precio ofertado, sin IVA', valor: montoBaseCobro },
      { concepto: 'Total recaudado', formula: 'Σ pagos registrados', valor: totalRecaudado },
      { concepto: 'Saldo pendiente', formula: 'Precio de venta − total recaudado', valor: saldoPendiente },
      { concepto: 'Valor facturado (informativo, con IVA)', formula: 'Precio de venta × (1 + % IVA)', valor: valorFacturado },
      { concepto: 'Retenciones (informativo: RteFte + ICA)', formula: 'Precio de venta × (% retefuente + % ICA)', valor: retenciones },
      { concepto: 'Neto real a recibir (informativo)', formula: 'Valor facturado − retenciones', valor: netoARecibir },
    ],
  };
}

function evaluarFlujoCaja(cot, materiales, manoObra, pagos, cxp) {
  const eventos = [];
  const fechaBase = cot.fecha_aprobacion || cot.fecha_cotizacion;

  // Salidas por materiales
  for (const m of materiales) {
    const costoTotal = (m.cantidad_presupuestada || 0) * (m.costo_unitario || 0);
    if (!costoTotal) continue;
    const fechaCompra = m.fecha_compra || fechaBase;
    if (m.forma_pago === 'Contado') {
      eventos.push({ fecha: fechaCompra, tipo: 'salida', concepto: `Compra contado: ${m.descripcion}`, valor: -costoTotal });
    } else {
      const venc = addDays(fechaCompra, m.dias_credito_proveedor || 0);
      eventos.push({ fecha: venc, tipo: 'salida', concepto: `Pago proveedor a crédito: ${m.descripcion}`, valor: -costoTotal });
    }
  }

  // Salida estimada de mano de obra (se paga en la fecha de aprobacion/ejecucion)
  const costoMo = sum(manoObra, (m) => (m.horas_presupuestadas || 0) * m.tarifa_hora * (m.tipo === 'Interno' ? (m.factor_prestacional || 1) : 1));
  if (costoMo && fechaBase) {
    eventos.push({ fecha: fechaBase, tipo: 'salida', concepto: 'Mano de obra (estimada)', valor: -costoMo });
  }

  // Entradas: pagos reales si existen; si no, proyeccion de anticipo + saldo
  if (pagos.length) {
    for (const p of pagos) {
      eventos.push({ fecha: p.fecha, tipo: 'entrada', concepto: `Pago cliente (${p.medio_pago})`, valor: p.valor });
    }
  } else if (fechaBase) {
    const anticipo = cot.precio_venta * (cot.pct_anticipo || 0);
    if (anticipo > 0) eventos.push({ fecha: fechaBase, tipo: 'entrada', concepto: 'Anticipo (proyectado)', valor: anticipo });
    const resto = cot.precio_venta - anticipo;
    const diasEsperados = cot.condicion_pago === 'Credito' ? cot.dias_credito_otorgados : 0;
    const fechaResto = addDays(fechaBase, diasEsperados);
    if (resto > 0) eventos.push({ fecha: fechaResto, tipo: 'entrada', concepto: 'Saldo cliente (proyectado)', valor: resto });
  }

  eventos.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  // El saldo acumulado se evalua netando primero todos los movimientos de un mismo dia,
  // para no marcar una falsa caja negativa solo por el orden interno de los eventos del dia.
  const netoPorFecha = new Map();
  for (const e of eventos) netoPorFecha.set(e.fecha, (netoPorFecha.get(e.fecha) || 0) + e.valor);
  const fechasOrdenadas = [...netoPorFecha.keys()].sort();
  let saldo = 0;
  let cajaNegativa = false;
  let fechaCajaNegativa = null;
  const saldoPorFecha = {};
  for (const f of fechasOrdenadas) {
    saldo += netoPorFecha.get(f);
    saldoPorFecha[f] = saldo;
    if (saldo < -0.5 && !cajaNegativa) { cajaNegativa = true; fechaCajaNegativa = f; }
  }
  for (const e of eventos) e.saldoAcumulado = saldoPorFecha[e.fecha];

  // Brecha de caja: dias de cobro al cliente vs promedio ponderado de dias de credito a proveedores
  const materialesCredito = materiales.filter((m) => m.forma_pago === 'Credito');
  const totalCreditoValor = sum(materialesCredito, (m) => (m.cantidad_presupuestada || 0) * m.costo_unitario);
  const diasProveedorPonderado = totalCreditoValor > 0
    ? safeDiv(sum(materialesCredito, (m) => (m.cantidad_presupuestada || 0) * m.costo_unitario * (m.dias_credito_proveedor || 0)), totalCreditoValor)
    : 0;
  const diasCliente = cot.condicion_pago === 'Credito' ? cot.dias_credito_otorgados : 0;
  const brechaCajaDias = diasCliente - diasProveedorPonderado;

  return {
    eventos, cajaNegativa, fechaCajaNegativa,
    diasProveedorPonderado, diasCliente, brechaCajaDias,
    riesgoLiquidez: brechaCajaDias > 0,
  };
}

function compararPresupuestadoReal(presupuestado, real) {
  const horasDesv = real.horasTotales - presupuestado.horasTotales;
  const horasDesvPct = safeDiv(horasDesv, presupuestado.horasTotales);
  const matDesv = real.materialesTotal - presupuestado.materialesTotal;
  const matDesvPct = safeDiv(matDesv, presupuestado.materialesTotal);
  const impactoUtilidad = real.utilidad - presupuestado.utilidad;
  return {
    horas: {
      presupuestadas: presupuestado.horasTotales,
      reales: real.horasTotales,
      desviacion: horasDesv,
      desviacionPct: horasDesvPct,
    },
    materiales: {
      presupuestados: presupuestado.materialesTotal,
      reales: real.materialesTotal,
      desviacion: matDesv,
      desviacionPct: matDesvPct,
    },
    costoDirecto: {
      presupuestado: presupuestado.subtotalCostoDirecto,
      real: real.subtotalCostoDirecto,
      desviacion: real.subtotalCostoDirecto - presupuestado.subtotalCostoDirecto,
    },
    utilidad: {
      presupuestada: presupuestado.utilidad,
      real: real.utilidad,
      impacto: impactoUtilidad,
    },
    margen: {
      presupuestado: presupuestado.margenPct,
      real: real.margenPct,
    },
  };
}

// Punto de entrada principal: recibe la cotizacion y sus lineas/relaciones y devuelve
// el objeto completo con todos los bloques (costeo, rentabilidad, semaforo, cartera, flujo, comparativo)
function calcularCotizacion({ cot, manoObra, materiales, parametros, politica, pagos, cxp }) {
  const costeoPresupuestado = costeoLineas(manoObra, materiales, cot.precio_venta, parametros, politica, 'presupuestado');
  costeoPresupuestado._precioVenta = cot.precio_venta;
  const costeoReal = costeoLineas(manoObra, materiales, cot.precio_venta, parametros, politica, 'real');
  costeoReal._precioVenta = cot.precio_venta;

  const rentabilidad = rentabilidadExtra(costeoPresupuestado, cot.precio_venta, politica);
  const comparativo = compararPresupuestadoReal(costeoPresupuestado, costeoReal);
  const semaforo = evaluarSemaforo(costeoPresupuestado, politica, comparativo);
  const cartera = evaluarCartera(cot, politica, pagos);
  const flujoCaja = evaluarFlujoCaja(cot, materiales, manoObra, pagos, cxp);

  return {
    costeoPresupuestado, costeoReal, rentabilidad, comparativo, semaforo, cartera, flujoCaja,
  };
}

module.exports = {
  totalGastosFijos, costoFijoHora, costeoLineas, rentabilidadExtra,
  evaluarSemaforo, evaluarCartera, evaluarFlujoCaja, compararPresupuestadoReal,
  calcularCotizacion,
};
