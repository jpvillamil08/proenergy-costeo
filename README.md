# PROENERGY — Costeo, Rentabilidad y Flujo de Caja por Cotización

Aplicación web de PROENERGY para reemplazar la hoja de Excel de costeo de la
empresa: cotizaciones, mano de obra, materiales, gastos fijos, rentabilidad,
semáforo de viabilidad, cartera y flujo de caja.

## Requisitos

- **Node.js 22.5 o superior** (usa el módulo experimental `node:sqlite`, incluido
  en Node — no necesita instalar ninguna base de datos aparte).
- No requiere `npm install`: toda la aplicación (backend y frontend) está escrita
  sin dependencias externas, para que corra en cualquier equipo con Node.js
  instalado, sin acceso a internet.

## Puesta en marcha

```bash
# 1) Cargar datos de ejemplo (usuarios, catálogos y 8 cotizaciones de muestra)
npm run seed

# 2) Iniciar la aplicación
npm start
```

Abra `http://localhost:3000` en el navegador.

Si el puerto 3000 está ocupado, puede cambiarlo: `PORT=4000 npm start`.

### Usuarios de prueba

| Usuario     | Contraseña   | Rol            |
|-------------|--------------|----------------|
| `admin`     | `admin123`   | Administrador (captura y edita todo) |
| `gerencia`  | `gerencia123`| Gerencia (solo lectura + auditoría)  |

## Qué incluye

- **Autenticación** con sesión por cookie y dos roles (Administrador / Gerencia).
- **Registro de auditoría** de quién cambió qué y cuándo (visible para ambos roles).
- **Parámetros de gastos fijos** y **políticas comerciales** versionados por
  fecha de vigencia: cada cotización conserva la tasa de costo fijo por hora y
  las políticas vigentes al momento en que fue creada.
- **Catálogos**: trabajadores (internos/externos, factor prestacional, IVA,
  retención) y proveedores (NIT, días de crédito habituales, contacto).
- **Cotizaciones** con líneas de mano de obra y materiales, cada una con
  cantidades/horas **presupuestadas** y **reales** por separado.
- **Motor de cálculo** (`server/lib/calc.js`) que produce cada cifra como una
  línea auditable con su fórmula: costeo directo, gastos fijos aplicados,
  imprevistos, comisión, costo interno total, utilidad, margen, margen de
  contribución, precio sugerido, precio de equilibrio, descuento máximo,
  utilidad por hora y por material, participación por componente.
- **Semáforo de viabilidad** (Viable / Viable con ajuste / No viable) con el
  ajuste sugerido (subir precio, bajar costo, horas de más) o el motivo textual
  de no viabilidad, y evaluación de **riesgo de liquidez** (brecha entre días
  de cobro al cliente y días de crédito de proveedores).
- **Cartera**: recaudo, saldo, % recaudado, fecha de pago total, días reales
  vs. esperados de cobro, estado (Sin facturar / Por cobrar / Abonado parcial /
  Pagado / Vencido) y antigüedad de cartera por rangos.
- **Cuentas por pagar** a proveedores generadas automáticamente desde las
  líneas de materiales a crédito.
- **Flujo de caja** por cotización, con salidas de contado/crédito, entradas
  por anticipo y pagos, saldo acumulado y alerta de caja negativa.
- **Comparativo presupuestado vs. real** con desviación en pesos/porcentaje e
  impacto directo en la utilidad.
- **Dashboard de Gerencia** (solo lectura): KPIs, alertas destacadas, 7
  gráficos y una tabla resumen ordenable/filtrable/exportable a CSV.
- **Importar/exportar** cotizaciones, mano de obra y materiales en CSV y en un
  Excel real (`.xlsx`) de tres hojas — sin librerías externas.
- **Plantillas reutilizables** de mano de obra + materiales, creadas desde
  cualquier cotización ("Guardar como plantilla") y aplicables a una nueva.
- **Vista de impresión / PDF** en dos versiones: comercial (solo precio, para
  el cliente) e interna (costeo y utilidad completos, para uso interno). Use
  el botón "Imprimir / Guardar como PDF" del navegador sobre esa vista.
- **Diseño responsive**, en español, con formato de pesos colombianos
  (`$ 1.234.567`, sin decimales), porcentajes con un decimal y fechas
  día/mes/año.

## Decisiones técnicas (para quien vaya a mantener el código)

- **Persistencia real**: SQLite mediante el módulo nativo `node:sqlite` de
  Node.js (marcado como experimental por Node, pero estable en uso — es el
  mismo motor SQLite embebido). El archivo de base de datos vive en
  `server/data/costeo.db`. Para empezar de cero, borre ese archivo y vuelva a
  correr `npm run seed`.
- **Backend**: `http` nativo de Node + un router propio muy simple
  (`server/lib/http-helpers.js`), sin Express. Rutas REST bajo `/api/...`.
- **Frontend**: JavaScript vanilla (sin build, sin framework), en módulos ES
  servidos directamente desde `public/js`. Enrutamiento por hash (`#/...`).
  Los gráficos del dashboard son SVG hechos a mano (`public/js/charts.js`).
- **Excel**: `server/lib/xlsx.js` construye y lee archivos `.xlsx` reales
  (formato ZIP + SpreadsheetML) sin ninguna librería, usando `node:zlib` para
  descomprimir hojas generadas por Excel/Google Sheets al importar.
- Esta versión se construyó sin dependencias de terceros a propósito, para que
  corra igual en cualquier máquina con Node.js. Si su equipo prefiere migrar a
  Express/Prisma/React más adelante, la lógica de negocio central está aislada
  en `server/lib/calc.js` y puede reutilizarse tal cual.

## Desplegarla en internet (Railway, recomendado)

Esta app guarda los datos en un archivo SQLite real dentro del propio
servidor (`server/data/costeo.db`), así que necesita un hosting que mantenga
un **proceso corriendo con disco persistente** — no una plataforma
"serverless" como Vercel, donde el sistema de archivos se reinicia en cada
invocación y los datos se perderían. Railway sí ofrece eso a bajo costo
(prueba gratis de 30 días con $5 de crédito, luego plan Hobby ~US$5/mes con
volumen persistente incluido).

1. **Cree una cuenta** en [railway.com](https://railway.com) e instale su CLI:
   `npm install -g @railway/cli`
2. Desde la carpeta `costeo-app`, ejecute:
   ```bash
   railway login
   railway init
   railway up
   ```
   Esto sube el proyecto tal cual (no necesita GitHub). Railway detecta
   `package.json` y usa el comando de arranque definido en `railway.json`
   (`npm run seed && npm start`) — la primera vez siembra los datos de
   ejemplo; en los reinicios siguientes **no borra nada** porque el script
   detecta que ya hay datos reales (ver `server/seed.js`).
3. **Agregue un volumen persistente** (indispensable, si no la base de datos
   se pierde en cada redeploy): en el panel del servicio, pestaña
   **Volumes → New Volume**, con *mount path* `/app/server/data`.
4. En **Settings → Networking**, genere un dominio público. Railway asigna
   automáticamente la variable `PORT`, que la app ya respeta.
5. Abra la URL que le entrega Railway, entre con `admin` / `admin123` y
   cambie esa contraseña cuanto antes (Admin → Trabajadores/usuarios).

Si prefiere Vercel de todas formas, dígamelo: hay que migrar la base de
datos a un motor remoto (por ejemplo Turso, compatible con SQLite) porque
Vercel no soporta un archivo SQLite persistente en sus funciones.

## Personalizar el nombre/logo de la empresa en las cotizaciones impresas

El nombre (`EMPRESA`) se edita al inicio de `server/routes/print.routes.js`.
El logo usado en el encabezado, el login y los PDF es `public/img/logo.png`;
para cambiarlo basta con reemplazar ese archivo por otro PNG (idealmente con
fondo transparente).

## Estructura del proyecto

```
server/
  index.js              Servidor HTTP + archivos estáticos + montaje de rutas
  db.js                  Esquema SQLite
  seed.js                 Datos de ejemplo
  lib/                     Motor de cálculo, auth, auditoría, csv, xlsx, fechas
  routes/                  Endpoints REST y vistas de impresión
  data/costeo.db            Base de datos (se genera con npm run seed)
public/
  index.html              Shell de la SPA
  css/styles.css            Estilos
  js/app.js                  Router y layout
  js/views/*.js                Cada pantalla (dashboard, cotización, catálogos…)
```
