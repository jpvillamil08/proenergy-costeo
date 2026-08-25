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
require('./routes/plantillas.routes')(router);
require('./routes/cotizaciones.routes')(router);
require('./routes/pagos.routes')(router);
require('./routes/cxp.routes')(router);
require('./routes/dashboard.routes')(router);
require('./routes/auditoria.routes')(router);
require('./routes/import_export.routes')(router);
require('./routes/print.routes')(router);
require('./routes/siigo.routes')(router);

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
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(content);
  return true;
}

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
