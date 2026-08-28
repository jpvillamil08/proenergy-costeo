'use strict';
// Script de datos de ejemplo. SOLO crea datos si la base de datos esta vacia
// (util para que "npm run seed && npm start" sea el comando de arranque en
// hosting: la primera vez siembra datos de ejemplo, en los reinicios
// siguientes NO toca nada porque ya hay datos reales). Para forzar un reinicio
// completo desde cero (borra TODO lo que haya, incluida informacion real
// capturada), ejecute: node server/seed.js --force
const fs = require('node:fs');
const path = require('node:path');

const FORCE = process.argv.includes('--force') || process.env.FORCE_SEED === '1';
// IMPORTANTE: esta ruta debe calcularse exactamente igual que en db.js (usando
// RAILWAY_VOLUME_MOUNT_PATH cuando existe). Si aqui se usara una ruta distinta
// a la que realmente usa la base de datos, esta comprobacion revisaria un
// archivo equivocado: en Railway eso hace que este script piense que "ya hay
// datos" (revisando una copia vieja empaquetada en la imagen) mientras la
// base de datos real (en el disco persistente) esta vacia, o al reves.
const dbPath = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data'), 'costeo.db');

if (fs.existsSync(dbPath) && !FORCE) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const check = new DatabaseSync(dbPath);
    const row = check.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='usuarios'").get();
    if (row && row.n > 0) {
      const n = check.prepare('SELECT COUNT(*) n FROM usuarios').get().n;
      check.close();
      if (n > 0) {
        console.log(`Ya existe una base de datos con ${n} usuario(s) — no se toca nada.`);
        console.log('(Para borrar todo y volver a sembrar datos de ejemplo: node server/seed.js --force)');
        process.exit(0);
      }
    }
    check.close();
  } catch (e) { /* archivo invalido o corrupto: sigue y lo recrea */ }
}

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  try { fs.unlinkSync(dbPath + suffix); } catch (e) { /* no existia */ }
}

const db = require('./db');
const { hashPassword } = require('./lib/auth');

function vigenteEnLista(rows, fecha) {
  const candidatos = rows.filter((r) => r.fecha_vigencia <= fecha).sort((a, b) => b.fecha_vigencia.localeCompare(a.fecha_vigencia));
  return candidatos[0];
}

console.log('Creando usuarios...');
const admin = hashPassword('admin123');
const gerencia = hashPassword('gerencia123');
db.prepare(`INSERT INTO usuarios (username, password_hash, password_salt, nombre, rol) VALUES (?,?,?,?,?)`)
  .run('admin', admin.hash, admin.salt, 'Administrador General', 'admin');
db.prepare(`INSERT INTO usuarios (username, password_hash, password_salt, nombre, rol) VALUES (?,?,?,?,?)`)
  .run('gerencia', gerencia.hash, gerencia.salt, 'Gerencia', 'gerencia');
const adminUser = db.prepare('SELECT * FROM usuarios WHERE username = ?').get('admin');

console.log('Creando parametros de gastos fijos (versionados)...');
const paramInsert = db.prepare(
  `INSERT INTO parametros_gastos_fijos (fecha_vigencia, arriendo_taller, servicios_publicos, internet_comunicaciones,
    nomina_administrativa, transporte_fijo, depreciacion, seguros_impuestos, otros, horas_productivas_mes, creado_por)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`
);
// Version historica (para demostrar el versionado por fecha de vigencia)
paramInsert.run('2026-01-01', 2500000, 1350000, 4500000, 12800000, 4200000, 1000000, 2700000, 1800000, 145, adminUser.id);
// Version vigente: datos reales tomados del Excel de PROENERGY (hoja "Parametros")
paramInsert.run('2026-07-01', 2650000, 1500000, 5000000, 14100000, 4600000, 1000000, 3000000, 2000000, 160, adminUser.id);
const parametros = db.prepare('SELECT * FROM parametros_gastos_fijos ORDER BY fecha_vigencia').all();

console.log('Creando politicas comerciales (versionadas)...');
const polInsert = db.prepare(
  `INSERT INTO politicas_comerciales (fecha_vigencia, pct_utilidad_objetivo, margen_minimo_aceptable, pct_imprevistos,
    pct_comision_ventas, dias_credito_estandar_cliente, pct_iva, pct_retefuente, pct_ica, creado_por)
   VALUES (?,?,?,?,?,?,?,?,?,?)`
);
// Version historica
polInsert.run('2026-01-01', 0.28, 0.14, 0.05, 0.02, 30, 0.19, 0.02, 0.007, adminUser.id);
// Version vigente: datos reales del Excel de PROENERGY (hoja "Parametros", seccion 3).
// El Excel no definia margen minimo aceptable, retencion en la fuente ni ICA:
// se dejan valores estandar de referencia para servicios en Colombia; ajustelos
// en Admin > Politicas comerciales con su contador si difieren.
polInsert.run('2026-07-01', 0.30, 0.15, 0.05, 0.00, 30, 0.19, 0.02, 0.00966, adminUser.id);
const politicas = db.prepare('SELECT * FROM politicas_comerciales ORDER BY fecha_vigencia').all();

console.log('Creando catalogo de trabajadores...');
const trabInsert = db.prepare(
  `INSERT INTO trabajadores (nombre, cargo, tipo, tarifa_hora, factor_prestacional, factura_iva, aplica_retencion, activo)
   VALUES (?,?,?,?,?,?,?,1)`
);
const trabajadores = {};
function trab(nombre, cargo, tipo, tarifa, factor, iva = 0, ret = 0) {
  const info = trabInsert.run(nombre, cargo, tipo, tarifa, factor, iva, ret);
  trabajadores[nombre] = info.lastInsertRowid;
}
// Estructura real de planta de PROENERGY (Excel, hoja "Parametros", seccion 2):
// 3 tecnicos internos, 1 tecnico externo, 1 coordinador operativo externo,
// 2 linieros externos y 1 conductor externo. El Excel no traia tarifas/hora
// diligenciadas (estaban en 0): se dejan tarifas de referencia del mercado
// para que la demo funcione de inmediato — edite nombres y tarifas reales en
// Admin > Trabajadores.
trab('Carlos Ramírez', 'Tecnico', 'Interno', 18000, 1.52);
trab('Diego Herrera', 'Tecnico', 'Interno', 19000, 1.52);
trab('Sandra Ruiz', 'Tecnico', 'Interno', 17000, 1.52);
trab('Pedro Salgado', 'Tecnico', 'Externo', 25000, 1, 1, 1);
trab('Andrés Gómez', 'Coordinador operativo', 'Externo', 45000, 1, 1, 1);
trab('Jorge Peña', 'Liniero', 'Externo', 32000, 1, 0, 1);
trab('Mario Ibáñez', 'Liniero', 'Externo', 30000, 1, 0, 1);
trab('Luis Torres', 'Conductor', 'Externo', 22000, 1, 0, 1);

console.log('Creando catalogo de proveedores...');
const provInsert = db.prepare(`INSERT INTO proveedores (nombre, nit, dias_credito_habituales, contacto, activo) VALUES (?,?,?,?,1)`);
const proveedores = {};
function prov(nombre, nit, dias, contacto) {
  const info = provInsert.run(nombre, nit, dias, contacto);
  proveedores[nombre] = info.lastInsertRowid;
}
prov('Eléctricos del Valle S.A.S.', '900123456-1', 30, 'Ana Ríos - 3001234567');
prov('Ferretería Industrial JC', '800234567-2', 15, 'Julián Castro - 3009876543');
prov('Cables y Conductores de Colombia', '900345678-3', 45, 'Marcela Ortiz - 3012345678');
prov('Herramientas y EPP Ltda.', '900456789-4', 0, 'Fabián Ruiz - 3023456789');
prov('Transformadores del Caribe', '900567890-5', 15, 'Wilson Pérez - 3034567890');

const cotInsert = db.prepare(
  `INSERT INTO cotizaciones (numero, cliente, descripcion, fecha_cotizacion, fecha_aprobacion, condicion_pago,
    dias_credito_otorgados, precio_venta, pct_anticipo, estado, parametros_id, politica_id, creado_por, actualizado_por)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
const moInsert = db.prepare(
  `INSERT INTO cotizacion_mano_obra (cotizacion_id, trabajador_id, nombre_snapshot, tipo, tarifa_hora, factor_prestacional, horas_presupuestadas, horas_reales)
   VALUES (?,?,?,?,?,?,?,?)`
);
const matInsert = db.prepare(
  `INSERT INTO cotizacion_materiales (cotizacion_id, descripcion, clasificacion, forma_pago, proveedor_id, dias_credito_proveedor, fecha_compra, cantidad_presupuestada, cantidad_real, costo_unitario)
   VALUES (?,?,?,?,?,?,?,?,?,?)`
);
const pagoInsert = db.prepare(
  `INSERT INTO pagos (cotizacion_id, fecha, valor, medio_pago, referencia, observacion, creado_por) VALUES (?,?,?,?,?,?,?)`
);

function crearCotizacion(datos) {
  const param = vigenteEnLista(parametros, datos.fecha_cotizacion);
  const politica = vigenteEnLista(politicas, datos.fecha_cotizacion);
  const info = cotInsert.run(
    datos.numero, datos.cliente, datos.descripcion, datos.fecha_cotizacion, datos.fecha_aprobacion || null,
    datos.condicion_pago, datos.dias_credito_otorgados || 0, datos.precio_venta, datos.pct_anticipo || 0,
    datos.estado, param.id, politica.id, adminUser.id, adminUser.id
  );
  const cotId = info.lastInsertRowid;
  for (const m of (datos.manoObra || [])) {
    const tId = trabajadores[m.nombre];
    const t = db.prepare('SELECT * FROM trabajadores WHERE id = ?').get(tId);
    moInsert.run(cotId, tId, t.nombre, t.tipo, t.tarifa_hora, t.factor_prestacional, m.horasPres, m.horasReal ?? m.horasPres);
  }
  for (const mt of (datos.materiales || [])) {
    matInsert.run(
      cotId, mt.descripcion, mt.clasificacion, mt.formaPago, mt.proveedor ? proveedores[mt.proveedor] : null,
      mt.diasCredito || 0, mt.fechaCompra || datos.fecha_aprobacion || datos.fecha_cotizacion,
      mt.cantPres, mt.cantReal ?? mt.cantPres, mt.costoUnit
    );
  }
  for (const p of (datos.pagos || [])) {
    pagoInsert.run(cotId, p.fecha, p.valor, p.medio, p.referencia || '', p.observacion || '', adminUser.id);
  }
  const svc = require('./lib/cotizacion-service');
  svc.syncCuentasPorPagar(cotId);
  return cotId;
}

console.log('Creando cotizaciones de ejemplo...');

// 1) VIABLE, Cerrada, contado, pagada rapido
crearCotizacion({
  numero: 'COT-0001', cliente: 'Ingenio La Cabaña', descripcion: 'Mantenimiento preventivo subestación 34.5kV',
  fecha_cotizacion: '2026-02-10', fecha_aprobacion: '2026-02-12', condicion_pago: 'Contado', dias_credito_otorgados: 0,
  precio_venta: 8500000, pct_anticipo: 0.5, estado: 'Cerrada',
  manoObra: [
    { nombre: 'Carlos Ramírez', horasPres: 40, horasReal: 38 },
    { nombre: 'Jorge Peña', horasPres: 24, horasReal: 24 },
  ],
  materiales: [
    { descripcion: 'Aceite dieléctrico', clasificacion: 'Directo', formaPago: 'Contado', proveedor: 'Ferretería Industrial JC', cantPres: 20, costoUnit: 45000 },
    { descripcion: 'Kit de mantenimiento y repuestos menores', clasificacion: 'Directo', formaPago: 'Contado', proveedor: 'Ferretería Industrial JC', cantPres: 1, costoUnit: 1200000 },
    { descripcion: 'EPP desechable', clasificacion: 'Indirecto', formaPago: 'Contado', proveedor: 'Herramientas y EPP Ltda.', cantPres: 10, costoUnit: 15000 },
  ],
  pagos: [
    { fecha: '2026-02-12', valor: 4250000, medio: 'Transferencia', referencia: 'ANT-001' },
    { fecha: '2026-02-20', valor: 4250000, medio: 'Transferencia', referencia: 'SALDO-001' },
  ],
});

// 2) VIABLE_CON_AJUSTE, Ejecutada, credito 30, abonado parcial, desviacion de horas
crearCotizacion({
  numero: 'COT-0002', cliente: 'Constructora Andina', descripcion: 'Instalación de red eléctrica en bodega industrial',
  fecha_cotizacion: '2026-07-20', fecha_aprobacion: '2026-08-05', condicion_pago: 'Credito', dias_credito_otorgados: 30,
  precio_venta: 36000000, pct_anticipo: 0.3, estado: 'Ejecutada',
  manoObra: [
    { nombre: 'Andrés Gómez', horasPres: 30, horasReal: 34 },
    { nombre: 'Jorge Peña', horasPres: 120, horasReal: 138 },
    { nombre: 'Luis Torres', horasPres: 40, horasReal: 42 },
    { nombre: 'Pedro Salgado', horasPres: 60, horasReal: 65 },
  ],
  materiales: [
    { descripcion: 'Cable encauchetado 3x8 AWG', clasificacion: 'Directo', formaPago: 'Credito', proveedor: 'Cables y Conductores de Colombia', diasCredito: 45, cantPres: 500, cantReal: 540, costoUnit: 8500 },
    { descripcion: 'Tablero de distribución', clasificacion: 'Directo', formaPago: 'Credito', proveedor: 'Eléctricos del Valle S.A.S.', diasCredito: 30, cantPres: 2, cantReal: 2, costoUnit: 1500000 },
    { descripcion: 'Breakers y accesorios', clasificacion: 'Directo', formaPago: 'Contado', proveedor: 'Ferretería Industrial JC', cantPres: 1, cantReal: 1, costoUnit: 2200000 },
    { descripcion: 'Conectores y terminales', clasificacion: 'Directo', formaPago: 'Credito', proveedor: 'Ferretería Industrial JC', diasCredito: 15, fechaCompra: '2026-08-10', cantPres: 1, cantReal: 1, costoUnit: 450000 },
    { descripcion: 'Señalización y EPP', clasificacion: 'Indirecto', formaPago: 'Contado', proveedor: 'Herramientas y EPP Ltda.', cantPres: 1, cantReal: 1, costoUnit: 350000 },
  ],
  pagos: [
    { fecha: '2026-08-05', valor: 10800000, medio: 'Transferencia', referencia: 'ANT-002' },
    { fecha: '2026-08-15', valor: 8000000, medio: 'Transferencia', referencia: 'ABONO-002' },
  ],
});

// 3) NO_VIABLE, Aprobada, credito 60 vs proveedor 15 -> riesgo de liquidez, VENCIDA sin pago
crearCotizacion({
  numero: 'COT-0003', cliente: 'Almacenes Rendón', descripcion: 'Cambio de transformador de potencia 75kVA',
  fecha_cotizacion: '2026-04-01', fecha_aprobacion: '2026-04-10', condicion_pago: 'Credito', dias_credito_otorgados: 60,
  precio_venta: 9000000, pct_anticipo: 0.2, estado: 'Aprobada',
  manoObra: [
    { nombre: 'Andrés Gómez', horasPres: 20, horasReal: 20 },
    { nombre: 'Mario Ibáñez', horasPres: 40, horasReal: 40 },
  ],
  materiales: [
    { descripcion: 'Transformador trifásico 75kVA', clasificacion: 'Directo', formaPago: 'Credito', proveedor: 'Transformadores del Caribe', diasCredito: 15, cantPres: 1, cantReal: 1, costoUnit: 6500000 },
    { descripcion: 'Aisladores y conectores', clasificacion: 'Directo', formaPago: 'Credito', proveedor: 'Eléctricos del Valle S.A.S.', diasCredito: 15, cantPres: 1, cantReal: 1, costoUnit: 800000 },
  ],
  pagos: [],
});

// 4) Enviada, sin aprobar, sin facturar
crearCotizacion({
  numero: 'COT-0004', cliente: 'Hospital San Rafael', descripcion: 'Cableado estructurado y tablero de emergencia',
  fecha_cotizacion: '2026-08-10', condicion_pago: 'Credito', dias_credito_otorgados: 30,
  precio_venta: 15000000, pct_anticipo: 0.3, estado: 'Enviada',
  manoObra: [
    { nombre: 'Diego Herrera', horasPres: 50 },
    { nombre: 'Sandra Ruiz', horasPres: 20 },
  ],
  materiales: [
    { descripcion: 'Cableado estructurado', clasificacion: 'Directo', formaPago: 'Credito', proveedor: 'Cables y Conductores de Colombia', diasCredito: 45, cantPres: 300, costoUnit: 9000 },
    { descripcion: 'Tablero de emergencia', clasificacion: 'Directo', formaPago: 'Credito', proveedor: 'Eléctricos del Valle S.A.S.', diasCredito: 30, cantPres: 1, costoUnit: 2800000 },
  ],
  pagos: [],
});

// 5) Borrador
crearCotizacion({
  numero: 'COT-0005', cliente: 'Textiles del Norte', descripcion: 'Diagnóstico de tablero general (por definir alcance)',
  fecha_cotizacion: '2026-08-18', condicion_pago: 'Contado', dias_credito_otorgados: 0,
  precio_venta: 3000000, pct_anticipo: 0, estado: 'Borrador',
  manoObra: [{ nombre: 'Carlos Ramírez', horasPres: 8 }],
  materiales: [],
  pagos: [],
});

// 6) Rechazada
crearCotizacion({
  numero: 'COT-0006', cliente: 'Agroindustrias Vallejo', descripcion: 'Ampliación de red eléctrica planta de empaque',
  fecha_cotizacion: '2026-05-15', condicion_pago: 'Credito', dias_credito_otorgados: 30,
  precio_venta: 12000000, pct_anticipo: 0.3, estado: 'Rechazada',
  manoObra: [{ nombre: 'Jorge Peña', horasPres: 80 }],
  materiales: [{ descripcion: 'Cable y ductería', clasificacion: 'Directo', formaPago: 'Credito', proveedor: 'Cables y Conductores de Colombia', diasCredito: 45, cantPres: 200, costoUnit: 8500 }],
  pagos: [],
});

// 7) Ejecutada, gran desviacion presupuestado vs real, VENCIDA
crearCotizacion({
  numero: 'COT-0007', cliente: 'Minera del Cesar', descripcion: 'Montaje de línea de media tensión 800m',
  fecha_cotizacion: '2026-05-20', fecha_aprobacion: '2026-05-25', condicion_pago: 'Credito', dias_credito_otorgados: 45,
  precio_venta: 80000000, pct_anticipo: 0.4, estado: 'Ejecutada',
  manoObra: [
    { nombre: 'Andrés Gómez', horasPres: 40, horasReal: 55 },
    { nombre: 'Jorge Peña', horasPres: 300, horasReal: 370 },
    { nombre: 'Mario Ibáñez', horasPres: 120, horasReal: 150 },
    { nombre: 'Luis Torres', horasPres: 60, horasReal: 65 },
  ],
  materiales: [
    { descripcion: 'Conductor ACSR calibre 2/0', clasificacion: 'Directo', formaPago: 'Credito', proveedor: 'Cables y Conductores de Colombia', diasCredito: 45, cantPres: 800, cantReal: 860, costoUnit: 18000 },
    { descripcion: 'Postería y crucetas', clasificacion: 'Directo', formaPago: 'Credito', proveedor: 'Eléctricos del Valle S.A.S.', diasCredito: 30, cantPres: 16, cantReal: 18, costoUnit: 450000 },
    { descripcion: 'Aisladores y herrajes', clasificacion: 'Directo', formaPago: 'Contado', proveedor: 'Ferretería Industrial JC', cantPres: 1, cantReal: 1, costoUnit: 3200000 },
    { descripcion: 'EPP y señalización de obra', clasificacion: 'Indirecto', formaPago: 'Contado', proveedor: 'Herramientas y EPP Ltda.', cantPres: 1, cantReal: 1, costoUnit: 900000 },
  ],
  pagos: [
    { fecha: '2026-05-25', valor: 32000000, medio: 'Transferencia', referencia: 'ANT-007' },
    { fecha: '2026-07-01', valor: 20000000, medio: 'Transferencia', referencia: 'ABONO-007' },
  ],
});

// 8) VIABLE, Cerrada, contado, pago inmediato (caso sano reciente)
crearCotizacion({
  numero: 'COT-0008', cliente: 'Edificio Torre Central', descripcion: 'Revisión y certificación de tablero eléctrico',
  fecha_cotizacion: '2026-08-01', fecha_aprobacion: '2026-08-03', condicion_pago: 'Contado', dias_credito_otorgados: 0,
  precio_venta: 5000000, pct_anticipo: 1, estado: 'Cerrada',
  manoObra: [{ nombre: 'Diego Herrera', horasPres: 16, horasReal: 15 }],
  materiales: [{ descripcion: 'Materiales varios de certificación', clasificacion: 'Directo', formaPago: 'Contado', proveedor: 'Ferretería Industrial JC', cantPres: 1, cantReal: 1, costoUnit: 400000 }],
  pagos: [{ fecha: '2026-08-04', valor: 5000000, medio: 'Efectivo', referencia: 'PAGO-008' }],
});

console.log('Creando plantillas reutilizables...');
const plantillaInsert = db.prepare('INSERT INTO plantillas (nombre, descripcion, datos_json, creado_por) VALUES (?,?,?,?)');
plantillaInsert.run(
  'Mantenimiento preventivo subestación',
  'Cuadrilla y materiales tipicos para mantenimiento preventivo de subestación',
  JSON.stringify({
    manoObra: [
      { trabajador_id: trabajadores['Carlos Ramírez'], horas_presupuestadas: 40 },
      { trabajador_id: trabajadores['Jorge Peña'], horas_presupuestadas: 24 },
    ],
    materiales: [
      { descripcion: 'Aceite dieléctrico', clasificacion: 'Directo', forma_pago: 'Contado', proveedor_id: proveedores['Ferretería Industrial JC'], cantidad_presupuestada: 20, costo_unitario: 45000 },
      { descripcion: 'EPP desechable', clasificacion: 'Indirecto', forma_pago: 'Contado', proveedor_id: proveedores['Herramientas y EPP Ltda.'], cantidad_presupuestada: 10, costo_unitario: 15000 },
    ],
  }),
  adminUser.id
);
plantillaInsert.run(
  'Instalación de red eléctrica industrial',
  'Base tipica para proyectos de instalación de red en bodegas/plantas',
  JSON.stringify({
    manoObra: [
      { trabajador_id: trabajadores['Andrés Gómez'], horas_presupuestadas: 30 },
      { trabajador_id: trabajadores['Jorge Peña'], horas_presupuestadas: 120 },
      { trabajador_id: trabajadores['Luis Torres'], horas_presupuestadas: 40 },
    ],
    materiales: [
      { descripcion: 'Cable encauchetado 3x8 AWG', clasificacion: 'Directo', forma_pago: 'Credito', proveedor_id: proveedores['Cables y Conductores de Colombia'], dias_credito_proveedor: 45, cantidad_presupuestada: 500, costo_unitario: 8500 },
      { descripcion: 'Tablero de distribución', clasificacion: 'Directo', forma_pago: 'Credito', proveedor_id: proveedores['Eléctricos del Valle S.A.S.'], dias_credito_proveedor: 30, cantidad_presupuestada: 2, costo_unitario: 1500000 },
    ],
  }),
  adminUser.id
);

console.log('\nListo. Usuarios de prueba:');
console.log('  Administrador -> usuario: admin      clave: admin123');
console.log('  Gerencia      -> usuario: gerencia    clave: gerencia123');
console.log(`\nCotizaciones creadas: ${db.prepare('SELECT COUNT(*) n FROM cotizaciones').get().n}`);
