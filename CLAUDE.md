# CLAUDE.md — PROENERGY · App de Costeo

Contexto permanente del repositorio para Claude Code. Léelo antes de tocar código.
El `README.md` es el manual del usuario final; este archivo es el mapa técnico.

## Qué es

Aplicación web interna de **PROENERGY** (empresa colombiana de servicios
eléctricos) que reemplaza la hoja de Excel de costeo. Por cada **cotización**
calcula: costo directo (materiales + mano de obra), gastos fijos aplicados por
hora, imprevistos, comisión, utilidad, margen, **semáforo de viabilidad**,
cartera (recaudo/mora) y **flujo de caja**. Además consolida presupuesto anual,
facturación sincronizada desde Siigo y un asistente de chat sobre los datos
reales.

Dos roles: `admin` (captura y edita todo) y `gerencia` (solo lectura + auditoría).
Todo está en **español** y en **pesos colombianos**.

## Comandos

```bash
npm run seed    # siembra datos de ejemplo SOLO si la BD esta vacia
npm start       # arranca en http://localhost:3000 (PORT=4000 npm start para cambiar puerto)
```

- **No hay `npm install`, ni build, ni tests, ni linter.** No existe `node_modules`.
- Para reiniciar desde cero (borra TODO, incluidos datos reales):
  `node server/seed.js --force`
- Usuarios de prueba: `admin`/`admin123`, `gerencia`/`gerencia123`.

## Reglas duras del proyecto

1. **Cero dependencias externas.** Nada de Express, Prisma, React, ni ninguna
   librería de npm. Todo se resuelve con módulos nativos de Node: `node:sqlite`,
   `node:http`, `node:crypto`, `node:zlib`, `fetch` nativo. Hasta el
   lector/escritor de `.xlsx` está hecho a mano (`server/lib/xlsx.js`). Si algo
   parece que necesita una librería, se escribe a mano o se propone al usuario
   antes de agregarla.
2. **Requiere Node ≥ 22.5** por el módulo `node:sqlite` (marcado experimental,
   pero es el que sostiene toda la persistencia).
3. **Nunca inventar cifras.** Es el principio rector del dominio: el estimador
   (`server/lib/estimador.js`) solo cruza contra el catálogo real y contra
   cotizaciones anteriores; la carga de materiales desde Siigo marca
   `[REVISAR]` con costo $0 cuando no hay cruce confiable, en vez de suponer un
   precio; el asistente de IA tiene prohibido dar números sin consultar sus
   herramientas. Mantén ese criterio en cualquier código nuevo.
4. **Sin secretos en el código.** Claves de Siigo y de IA van solo por variables
   de entorno (Railway → Variables).

## Arquitectura

### Backend — `server/`

```
index.js       Servidor http nativo: sirve /public, monta rutas, arranca el scheduler.
db.js          Conexion SQLite + esquema + migraciones ligeras + cargas iniciales.
seed.js        Datos de ejemplo (idempotente salvo --force).
lib/           Logica reutilizable.
routes/        Endpoints REST bajo /api/... (y vistas HTML bajo /print/...).
data/costeo.db Base de datos local (ignorada por git).
```

- **Router propio** en `server/lib/http-helpers.js` (sin Express). Cada archivo
  de `routes/` exporta `module.exports = (router) => { ... }` y registra rutas
  con `router.get/post/put/del('/api/...', handler)`. El handler recibe
  `{ req, res, params, query, user }`. Los errores se lanzan con
  `throw new HttpError(status, mensaje)` y el router los serializa a JSON.
- **Autorización**: envuelve *siempre* el handler con `withAuth(...)` (requiere
  sesión) o `withAdmin(...)` (además exige rol admin), de `server/lib/guard.js`.
  Sesión por cookie `sesion` (token aleatorio, tabla `sesiones`, 7 días);
  contraseñas con `scrypt` (`server/lib/auth.js`).
- **Auditoría**: toda escritura relevante registra con `registrar(...)` o
  `registrarCambios(...)` de `server/lib/audit.js`. Al agregar un endpoint de
  escritura, agrégale su registro de auditoría.

### Motor de cálculo — `server/lib/calc.js`

El corazón del negocio. `calcularCotizacion({cot, manoObra, materiales,
parametros, politica, pagos, cxp})` devuelve `{ costeoPresupuestado, costeoReal,
rentabilidad, comparativo, semaforo, cartera, flujoCaja }`.

- Cada bloque incluye un array **`desglose`** con `{ concepto, formula, valor }`:
  la app muestra la fórmula junto a cada cifra para que sea auditable. **Si
  agregas un cálculo, agrégale su línea de desglose.**
- El semáforo tiene cuatro estados: `VIABLE`, `VIABLE_CON_AJUSTE`, `NO_VIABLE` y
  **`SIN_DATOS`**. Este último se devuelve cuando el costo directo es cero (sin
  líneas cargadas, o todas en `$0` como quedan las importadas de Siigo con
  `[REVISAR]`). Existe porque sin él esas cotizaciones daban margen ~100% y
  salían **VIABLE en verde**, que es la lectura contraria a la realidad. Al tocar
  el semáforo, mantén los cuatro estados sincronizados en `public/js/format.js`
  (`SEMAFORO_LABEL` / `SEMAFORO_CLASS`) y en `public/css/styles.css`.
- `server/lib/cotizacion-service.js` es la única puerta de entrada a los datos de
  una cotización (`getCotizacionFull`, `listCotizacionesFull`). Dashboard,
  detalle, asistente y estimador lo reutilizan para que las cifras nunca se
  contradigan entre pantallas. **No dupliques consultas ni cálculos: pasa por
  este servicio.**
- `syncCuentasPorPagar(cotId)` regenera las CxP pendientes desde las líneas de
  materiales a crédito (conserva las ya pagadas). Llámalo tras editar una
  cotización o sus materiales.

### Frontend — `public/`

SPA en **JavaScript vanilla con módulos ES**, servida tal cual (sin bundler).

- `js/app.js`: router por hash (`#/cotizaciones/12`), layout y menú por rol.
- `js/views/*.js`: una pantalla por archivo, cada una exporta
  `render<Nombre>(content, state)` que pinta dentro del contenedor recibido.
- `js/api.js` (fetch JSON), `js/format.js` (money/pct/fechas/`esc`),
  `js/guard.js` (`stillMounted` evita que un fetch tardío pise el DOM de otra
  vista), `js/charts.js` (gráficos SVG a mano), `js/asistente-widget.js` (chat).
- Se construye HTML con template strings: **pasa siempre el texto por `esc()`**.
- Los estáticos se sirven con `Cache-Control: no-store` (imágenes, un día). Es a
  propósito: el frontend son módulos ES y el navegador los guarda en su registro
  interno de módulos, del que no salen ni con recarga forzada, así que tras un
  despliegue los usuarios seguían viendo el código anterior. No lo cambies a
  `no-cache` sin resolver antes el versionado de los imports.

## Modelo de datos (SQLite)

Tablas principales: `usuarios`, `sesiones`, `parametros_gastos_fijos`,
`politicas_comerciales`, `trabajadores`, `proveedores`, `materiales` +
`materiales_precios`, `plantillas`, `cotizaciones` + `cotizacion_mano_obra` +
`cotizacion_materiales`, `pagos`, `cuentas_por_pagar`, `facturas`, `auditoria`,
`presupuesto_lineas`/`presupuesto_valores` (+ variables macro) y
`ventas_historicas_item`/`ventas_historicas_cliente`.

Conceptos que hay que respetar:

- **Parámetros y políticas versionados por fecha.** Al crear una cotización se
  congelan `parametros_id` y `politica_id` (los vigentes en su fecha, vía
  `vigenteEn(fecha)` que exportan `parametros.routes.js` y `politicas.routes.js`).
  Cambiar los parámetros hoy **no** debe alterar cotizaciones viejas.
- **Presupuestado vs. real**: cada línea guarda ambas cantidades
  (`horas_presupuestadas`/`horas_reales`, `cantidad_presupuestada`/`cantidad_real`)
  y el motor calcula los dos escenarios en paralelo.
- **Fechas** siempre `'YYYY-MM-DD'` como texto, manipuladas en UTC con
  `server/lib/dates.js` (evita corrimientos de un día por zona horaria).
- **Cartera sobre el precio sin IVA**: el saldo se sigue contra `precio_venta`;
  IVA, retefuente e ICA se calculan aparte como información y no alteran el saldo.
- **Migraciones**: no hay herramienta de migraciones. Para columnas nuevas se usa
  el patrón de `db.js` — `columnaExiste(tabla, columna)` + `ALTER TABLE ... ADD
  COLUMN`. Las cargas iniciales (catálogo de materiales, presupuesto) solo corren
  si la tabla está vacía, para no pisar datos reales.

## Integraciones

- **Siigo** (`server/lib/siigo.js` + `siigo.routes.js`, `siigo-materiales.routes.js`,
  `facturas.routes.js`): importa cotizaciones (solo número, cliente, fecha y
  precio — Siigo no maneja costos internos), cruza los ítems contra el catálogo
  para cargar materiales, y sincroniza facturas de venta. Variables:
  `SIIGO_USERNAME`, `SIIGO_ACCESS_KEY`, `SIIGO_PARTNER_ID`.
  - **La actividad es el título del documento en Siigo** (nunca la primera
    línea de ítems: esa suele ser un material). `server/lib/titulo.js` es la única
    regla. En las facturas va en Observaciones. En las cotizaciones NO está en
    Observaciones: el campo se ubica con `scripts/diagnostico-cotizacion-siigo.py`
    y se configura en `CAMPOS_TITULO_COTIZACION`. La app guarda la cotización
    cruda en `cotizaciones.siigo_json` y `cotizacion-service` calcula `cot.titulo`
    desde ahí (y quita la cruda antes de mandarla al frontend), así que cambiar
    la regla corrige todas sin volver a consultar Siigo. Las que no tienen título
    quedan en blanco; nunca se deducen con palabras clave.
  - **Cotizaciones editadas en Siigo** se ponen al día solas
    (`revisarModificadas` / `actualizarDesdeSiigo` en `siigo-sync.js`): se compara
    una huella (`cotizaciones.siigo_huella`) y, si cambió, se actualizan precio,
    cliente, fecha y líneas. Cada línea de materiales sabe de qué ítem de Siigo
    salió (`siigo_item`) y de dónde salió su costo (`costo_origen`: `catalogo`,
    `regla_precio` o `manual`). **Un costo `manual` nunca lo toca la
    sincronización**; uno por regla se recalcula si cambia el precio. Una línea
    cuyo ítem desaparece de Siigo se borra, salvo que sea manual o tenga datos de
    ejecución: esa queda marcada `[YA NO ESTÁ EN SIIGO]`. Al editar costos en la
    app (PUT de materiales) el origen pasa a `manual`.
  - **`precio_venta` de lo importado de Siigo trae el IVA del 19%** (se guarda
    `q.total`), mientras los costos son sin IVA; por eso los márgenes de la app
    salen inflados. Decisión del usuario: no migrarlo; los informes muestran con
    y sin IVA (sin IVA = con IVA ÷ 1,19) y el margen sobre sin IVA.
- **Correo de Outlook** (`server/lib/outlook.js` + `correo-extraccion.js` +
  `correo-sync.js`, rutas en `buzon.routes.js`, vista `buzon.js`): cada hora lee
  por Microsoft Graph (permiso de aplicación `Mail.Read`, solo lectura) los
  buzones de `CORREO_BUZONES`, recibidos y enviados. Un filtro previo sin IA deja
  pasar solo correos de negocio; la IA (`claude.extraerJSON`, que manda los PDF
  como documento) los clasifica y extrae datos con la regla de no inventar
  cifras. Según el tipo: cotización de Siigo enviada → pasa a Enviada;
  cotización propia (Word/PDF, fuera de Siigo) → se crea con `origen='correo'`;
  orden de compra → `ordenes_compra`, la cotización pasa a Aprobada y se asocia
  a la factura por el número de OC de `facturas.orden`; solicitud, licitación o
  cotización de proveedor → `buzon_ofertas` (Pendiente → Cotizada → Cumplida).
  Todo queda en `correo_mensajes` con el enlace al correo. Variables:
  `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `CORREO_BUZONES`; guía para
  el administrador en `docs/conectar-outlook.md`.
- **Asistente de chat** (`server/lib/claude.js` + `asistente-tools.js` +
  `asistente.routes.js`): loop propio de *tool use* con dos proveedores
  intercambiables — Gemini (`GEMINI_API_KEY`, por defecto) o Anthropic
  (`ANTHROPIC_API_KEY`; `IA_PROVEEDOR=claude` lo fuerza). Las herramientas son de
  solo lectura y reutilizan `cotizacion-service` para dar cifras consistentes.
- Sin esas variables, cada módulo lanza un error explicativo en vez de fallar de
  forma confusa; los endpoints `/api/*/estado` le dicen al frontend si está
  configurado.

## Tareas automáticas

`server/lib/scheduler.js` corre **la sincronización completa con Siigo a las 9:00
a.m. y a las 5:00 p.m. hora de Colombia**: importa las cotizaciones nuevas de los
últimos 30 días y les carga los materiales, pone al día las que alguien editó en
Siigo, completa los títulos, costea con la regla del precio (−30%) las líneas en
$0 y sincroniza las facturas del año pasado y del actual (`lib/facturas-sync.js`,
compartido con `POST /api/facturas/sincronizar`). Se arranca desde
`server/index.js` y no usa ninguna librería, solo `setTimeout` reprogramándose.

- **La hora se calcula en UTC explícito**, nunca con `getHours()`: el contenedor
  de Railway corre en UTC, no en hora de Colombia. Colombia es UTC−5 todo el año
  (sin horario de verano), así que las 9:00 a.m. y 5:00 p.m. de Bogotá son las
  14:00 y las 22:00 UTC.
- La lógica que ejecuta vive en `server/lib/siigo-sync.js`, **compartida con las
  rutas manuales** (`siigo.routes.js`, `siigo-materiales.routes.js`) para que el
  botón de la app y el cron apliquen exactamente las mismas reglas. Si tocas el
  cruce contra el catálogo, tócalo ahí y ambos caminos quedan iguales.
- Un reinicio (por ejemplo un despliegue) pierde el temporizador y lo reprograma
  al arrancar. Si el reinicio cae justo después de la hora, esa corrida se salta
  y se hace al día siguiente: no se pierde nada, porque siempre revisa una
  ventana de 30 días y solo trae lo que falte.
- Para verlo o dispararlo sin esperar: `GET /api/siigo/sync/estado` (incluye
  `paso`, en qué va la corrida) y `POST /api/siigo/sync/ejecutar` (ambas solo
  admin). `ejecutar` responde 202 de inmediato y sigue en segundo plano: la
  corrida completa tarda minutos y Railway corta las peticiones largas. Un flag
  `ejecutando` evita que dos sincronizaciones se solapen.
- En auditoría queda como `SINCRONIZAR` con usuario `Sistema`, y solo cuando
  algo cambió realmente.

Además, un segundo temporizador lee el correo de Outlook **cada hora en punto**
(`estadoCorreo` en `scheduler.js`, `GET /api/correo/estado`, `POST /api/correo/ejecutar`).

Variables de entorno en uso: `PORT`, `RAILWAY_VOLUME_MOUNT_PATH`, `SIIGO_*`, `MS_*`, `CORREO_BUZONES`,
`GEMINI_API_KEY`/`GEMINI_MODEL`, `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`,
`IA_PROVEEDOR`, `FORCE_SEED`, `RESET_ADMIN_PASSWORD`, y
`ADMIN_USERNAME`/`ADMIN_PASSWORD` (solo para los scripts de diagnóstico).

## Despliegue (Railway)

Producción corre en Railway con un **volumen persistente**. `server/db.js` guarda
la BD en `RAILWAY_VOLUME_MOUNT_PATH` cuando existe, y solo cae a `server/data/` en
local. `seed.js` calcula esa misma ruta — **si las dos rutas se desincronizan, el
seed revisa un archivo equivocado y puede borrar o duplicar datos.** El
`startCommand` de `railway.json` es
`npm run seed && node server/reset-admin-password.js && npm start`.
No sirve un hosting serverless (Vercel): el archivo SQLite se perdería.

## `scripts/`

Utilidades puntuales, no parte del arranque. Unas escriben en la BD local
(`import-precios-lote.js`, `ajustar-precio-accesorios-consumibles.js`, pensadas
para ser idempotentes) y otras solo leen contra la API desplegada y dejan un JSON
de reporte (`diagnostico-costos-cotizaciones.js`, `reporte-materiales-faltantes.js`,
que piden credenciales por variables de entorno, nunca escritas en el archivo).
Lee el encabezado de cada script antes de correrlo.

## Convenciones

- Todo el código, los comentarios y la UI en **español**. Los comentarios del
  servidor suelen ir sin tildes; el texto que ve el usuario siempre con tildes
  correctas.
- Comentarios que explican **por qué**, no qué: el repo documenta decisiones y
  trampas (ver `db.js`, `seed.js`, `calc.js`). Mantén ese estilo.
- Formato: `$ 1.234.567` sin decimales, porcentajes con un decimal, fechas
  `dd/mm/aaaa` en pantalla. Los porcentajes viajan como fracción (`0.15` = 15%).
- `'use strict'` y CommonJS (`require`) en el servidor; módulos ES (`import`) en
  el frontend.
- Mensajes de commit: cortos, en español.

## Al agregar una funcionalidad

1. Endpoint nuevo → archivo en `server/routes/`, registrado en `server/index.js`,
   envuelto en `withAuth`/`withAdmin`, con auditoría si escribe.
2. Cifra nueva → va en `server/lib/calc.js` con su línea de `desglose`, y se lee
   vía `cotizacion-service`.
3. Pantalla nueva → `public/js/views/<nombre>.js` con `render<Nombre>(content, state)`,
   más su entrada en `NAV_ADMIN`/`NAV_GERENCIA` y su rama en el router de `app.js`.
4. Columna nueva → agrégala al `SCHEMA` de `db.js` **y** al bloque de migraciones
   ligeras, para que las bases de datos ya desplegadas se actualicen solas.
