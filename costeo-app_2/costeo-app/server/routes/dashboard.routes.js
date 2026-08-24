'use strict';
const db = require('../db');
const { sendJson } = require('../lib/http-helpers');
const { withAuth } = require('../lib/guard');
const svc = require('../lib/cotizacion-service');
const { resumen } = require('./cotizaciones.routes');
const { todayStr, diffDays } = require('../lib/dates');
const { totalGastosFijos } = require('../lib/calc');
const { vigenteEn: parametrosVigenteEn } = require('./parametros.routes');

const ESTADOS = ['Borrador', 'Enviada', 'Aprobada', 'Rechazada', 'Ejecutada', 'Cerrada'];
const ACTIVAS = ['Enviada', 'Aprobada', 'Ejecutada', 'Cerrada'];

module.exports = (router) => {
  router.get('/api/dashboard', withAuth(async ({ res }) => {
    const full = svc.listCotizacionesFull();
    const rows = full.map(resumen);

    const porEstado = {};
    ESTADOS.forEach((e) => { porEstado[e] = 0; });
    rows.forEach((r) => { porEstado[r.estado] = (porEstado[r.estado] || 0) + 1; });

    const activas = full.filter((f) => ACTIVAS.includes(f.cot.estado));
    const valorTotalOfertado = activas.reduce((a, f) => a + f.cot.precio_venta, 0);
    const costoInternoTotalSum = activas.reduce((a, f) => a + f.calculo.costeoPresupuestado.costoInternoTotal, 0);
    const utilidadTotal = activas.reduce((a, f) => a + f.calculo.costeoPresupuestado.utilidad, 0);
    const margenPromedioPonderado = valorTotalOfertado ? utilidadTotal / valorTotalOfertado : 0;

    const conFechaAprobacion = full.filter((f) => f.cot.fecha_aprobacion && ACTIVAS.includes(f.cot.estado));
    const carteraPorCobrar = conFechaAprobacion.reduce((a, f) => a + f.calculo.cartera.saldoPendiente, 0);
    const carteraVencida = conFechaAprobacion.filter((f) => f.calculo.cartera.estadoPago === 'VENCIDO').reduce((a, f) => a + f.calculo.cartera.saldoPendiente, 0);
    const cobradas = conFechaAprobacion.filter((f) => f.calculo.cartera.diasRealesCobro !== null);
    const diasPromedioRealesCobro = cobradas.length ? cobradas.reduce((a, f) => a + f.calculo.cartera.diasRealesCobro, 0) / cobradas.length : null;

    const decididas = full.filter((f) => f.cot.estado !== 'Borrador');
    const aprobadasOMas = full.filter((f) => ['Aprobada', 'Ejecutada', 'Cerrada'].includes(f.cot.estado));
    const tasaConversion = decididas.length ? aprobadasOMas.length / decididas.length : null;

    const hoy = todayStr();
    const paramVigente = parametrosVigenteEn(hoy);
    const gastosFijosRealesMes = totalGastosFijos(paramVigente);
    const mesActual = hoy.slice(0, 7);
    const gastosFijosAplicadosMes = full
      .filter((f) => (f.cot.fecha_cotizacion || '').slice(0, 7) === mesActual && ACTIVAS.includes(f.cot.estado))
      .reduce((a, f) => a + f.calculo.costeoPresupuestado.gastosFijosAplicados, 0);
    const absorcionGastosFijos = {
      aplicados: gastosFijosAplicadosMes,
      reales: gastosFijosRealesMes,
      pct: gastosFijosRealesMes ? gastosFijosAplicadosMes / gastosFijosRealesMes : 0,
    };

    // ---- Graficos ----
    const utilidadMargenPorCotizacion = rows
      .filter((r) => ACTIVAS.includes(r.estado))
      .map((r) => ({ numero: r.numero, cliente: r.cliente, utilidad: r.utilidad, margenPct: r.margenPct }))
      .sort((a, b) => b.utilidad - a.utilidad);

    const composicionCosto = activas.reduce((acc, f) => {
      const c = f.calculo.costeoPresupuestado;
      acc.materialesDirectos += c.materialesDirectos;
      acc.materialesIndirectos += c.materialesIndirectos;
      acc.moInterna += c.costoMoInterna;
      acc.moExterna += c.costoMoExterna;
      acc.gastosFijos += c.gastosFijosAplicados;
      acc.imprevistos += c.imprevistos;
      acc.comision += c.comisionVentas;
      return acc;
    }, { materialesDirectos: 0, materialesIndirectos: 0, moInterna: 0, moExterna: 0, gastosFijos: 0, imprevistos: 0, comision: 0 });

    const porCliente = {};
    activas.forEach((f) => {
      const k = f.cot.cliente;
      if (!porCliente[k]) porCliente[k] = { cliente: k, utilidad: 0, ventas: 0 };
      porCliente[k].utilidad += f.calculo.costeoPresupuestado.utilidad;
      porCliente[k].ventas += f.cot.precio_venta;
    });
    const utilidadMargenPorCliente = Object.values(porCliente).map((c) => ({ ...c, margenPct: c.ventas ? c.utilidad / c.ventas : 0 })).sort((a, b) => b.utilidad - a.utilidad);

    const antiguedadCartera = { Corriente: 0, '1-30': 0, '31-60': 0, '61-90': 0, '+90': 0 };
    conFechaAprobacion.forEach((f) => {
      const cart = f.calculo.cartera;
      if (cart.saldoPendiente > 0.5 && cart.bucket) antiguedadCartera[cart.bucket] = (antiguedadCartera[cart.bucket] || 0) + cart.saldoPendiente;
    });

    const evolMap = {};
    activas.forEach((f) => {
      const mes = (f.cot.fecha_cotizacion || '').slice(0, 7);
      if (!mes) return;
      if (!evolMap[mes]) evolMap[mes] = { mes, ventas: 0, costo: 0, utilidad: 0 };
      evolMap[mes].ventas += f.cot.precio_venta;
      evolMap[mes].costo += f.calculo.costeoPresupuestado.costoInternoTotal;
      evolMap[mes].utilidad += f.calculo.costeoPresupuestado.utilidad;
    });
    const evolucionMensual = Object.values(evolMap).sort((a, b) => a.mes.localeCompare(b.mes));

    const porTrabajador = {};
    activas.forEach((f) => {
      const costoMoTotal = f.calculo.costeoPresupuestado.costoMoInterna + f.calculo.costeoPresupuestado.costoMoExterna;
      f.manoObra.forEach((m) => {
        const nombre = m.nombre_snapshot || 'Sin nombre';
        if (!porTrabajador[nombre]) porTrabajador[nombre] = { trabajador: nombre, horas: 0, utilidad: 0 };
        const horas = m.horas_reales || m.horas_presupuestadas || 0;
        porTrabajador[nombre].horas += horas;
        const costoLinea = horas * m.tarifa_hora * (m.tipo === 'Interno' ? (m.factor_prestacional || 1) : 1);
        const participacion = costoMoTotal ? costoLinea / costoMoTotal : 0;
        porTrabajador[nombre].utilidad += f.calculo.costeoPresupuestado.utilidad * participacion;
      });
    });
    const horasPorTrabajador = Object.values(porTrabajador).sort((a, b) => b.horas - a.horas);

    const presupuestadoVsReal = full
      .filter((f) => ['Ejecutada', 'Cerrada'].includes(f.cot.estado))
      .map((f) => ({
        numero: f.cot.numero, cliente: f.cot.cliente,
        horasPresupuestadas: f.calculo.comparativo.horas.presupuestadas,
        horasReales: f.calculo.comparativo.horas.reales,
        materialesPresupuestados: f.calculo.comparativo.materiales.presupuestados,
        materialesReales: f.calculo.comparativo.materiales.reales,
        impactoUtilidad: f.calculo.comparativo.utilidad.impacto,
      }));

    // ---- Alertas ----
    const noViables = full.filter((f) => f.calculo.semaforo.estado === 'NO_VIABLE' && ACTIVAS.includes(f.cot.estado))
      .map((f) => ({ id: f.cot.id, numero: f.cot.numero, cliente: f.cot.cliente, margenPct: f.calculo.costeoPresupuestado.margenPct, mensaje: f.calculo.semaforo.mensaje }));

    const vencidas = full.filter((f) => f.calculo.cartera.estadoPago === 'VENCIDO')
      .map((f) => ({ id: f.cot.id, numero: f.cot.numero, cliente: f.cot.cliente, diasMora: f.calculo.cartera.diasMora, saldoPendiente: f.calculo.cartera.saldoPendiente }))
      .sort((a, b) => b.diasMora - a.diasMora);

    const brechaCajaNegativa = full.filter((f) => f.calculo.flujoCaja.cajaNegativa && ACTIVAS.includes(f.cot.estado))
      .map((f) => ({ id: f.cot.id, numero: f.cot.numero, cliente: f.cot.cliente, fecha: f.calculo.flujoCaja.fechaCajaNegativa, brechaCajaDias: f.calculo.flujoCaja.brechaCajaDias }));

    const desviacionesEjecucion = full.filter((f) => ['Ejecutada', 'Cerrada'].includes(f.cot.estado) &&
      (Math.abs(f.calculo.comparativo.horas.desviacionPct) > 0.1 || Math.abs(f.calculo.comparativo.materiales.desviacionPct) > 0.1))
      .map((f) => ({ id: f.cot.id, numero: f.cot.numero, cliente: f.cot.cliente, desviacionHorasPct: f.calculo.comparativo.horas.desviacionPct, desviacionMaterialesPct: f.calculo.comparativo.materiales.desviacionPct, impactoUtilidad: f.calculo.comparativo.utilidad.impacto }));

    const cxpTodas = db.prepare(
      `SELECT cxp.*, c.numero AS cotizacion_numero, p.nombre AS proveedor_nombre FROM cuentas_por_pagar cxp
       LEFT JOIN cotizaciones c ON c.id = cxp.cotizacion_id LEFT JOIN proveedores p ON p.id = cxp.proveedor_id
       WHERE cxp.pagado = 0`
    ).all();
    const cxpVencenEstaSemana = cxpTodas.filter((c) => {
      const d = diffDays(c.fecha_vencimiento, hoy);
      return d !== null && d >= 0 && d <= 7;
    }).sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento));

    sendJson(res, 200, {
      kpis: {
        porEstado, valorTotalOfertado, costoInternoTotal: costoInternoTotalSum, utilidadTotal, margenPromedioPonderado,
        carteraPorCobrar, carteraVencida, diasPromedioRealesCobro, tasaConversion, absorcionGastosFijos,
      },
      graficos: {
        utilidadMargenPorCotizacion, composicionCosto, utilidadMargenPorCliente, antiguedadCartera,
        evolucionMensual, horasPorTrabajador, presupuestadoVsReal,
      },
      alertas: { noViables, vencidas, brechaCajaNegativa, desviacionesEjecucion, cxpVencenEstaSemana },
      tabla: rows,
    });
  }));
};
