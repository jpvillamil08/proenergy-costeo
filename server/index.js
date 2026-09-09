'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Router, sendJson } = require('./lib/http-helpers');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const router = new Router();

// Montaje de rutas de API
require('./routes/auth.routes')(router);
require('./routes/parametros.routes')(router);
require('./routes/politicas.routes')(router);
require('./routes/trabajadores.routes')(router);
require('./routes/proveedores.routes')(router);
require('./routes/materiales.routes')(router);
require('./routes/presupuesto.routes')(router);
require('./routes/plantillas.routes')(router);
require('./routes/cotizaciones.routes')(router);
require('./routes/pagos.routes')(router);
require('./routes/cxp.routes')(router);
require('./routes/dashboard.routes')(router);
require('./routes/auditoria.routes')(router);
require('./routes/import_export.routes')(router);
require('./routes/print.routes')(router);
require('./routes/siigo.routes')(router);
require('./routes/siigo-materiales.routes')(router);
require('./routes/facturas.routes')(router);
require('./routes/asistente.routes')(router);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Prohibido'); return true; }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    if (pathname.startsWith('/api/')) return false;
    // SPA fallback
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  const ext = path.extname(filePath);
  const content = fs.readFileSync(filePath);
  // Sin cabecera de cache, el navegador decidia por su cuenta cuanto guardar los
  // .js y .css, y despues de un despliegue los usuarios seguian viendo la version
  // anterior: la lista de cotizaciones mostraba "undefined" en la columna de
  // semaforo porque cargaba un format.js viejo.
  //
  // Se usa no-store y no no-cache: el frontend son modulos ES (import), y el
  // navegador los guarda en su propio registro de modulos del que ni siquiera
  // una recarga forzada los saca. no-store es lo unico que garantiza que tras
  // cada despliegue todos vean el codigo nuevo. La app pesa poco y es de uso
  // interno, asi que volver a bajarla en cada carga no es problema; las
  // imagenes si se guardan un dia, que son lo pesado y casi nunca cambian.
  const cache = ext === '.png' || ext === '.ico' || ext === '.svg'
    ? 'public, max-age=86400'
    : 'no-store, must-revalidate';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cache,
    // Fecha del archivo en disco: permite que el navegador revalide con
    // If-Modified-Since en vez de descargarlo entero cada vez.
    'Last-Modified': fs.statSync(filePath).mtime.toUTCString(),
  });
  res.end(content);
  return true;
}

// Tareas automaticas: sincronizacion diaria con Siigo a las 7 p.m. hora Colombia.
// Ver server/lib/scheduler.js.
require('./lib/scheduler').iniciar();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/print/')) {
    const handled = await router.handle(req, res, {});
    if (!handled) sendJson(res, 404, { error: 'Ruta no encontrada' });
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`PROENERGY - Costeo App escuchando en http://localhost:${PORT}`);
});
