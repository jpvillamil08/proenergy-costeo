'use strict';

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 25 * 1024 * 1024) { reject(new Error('Cuerpo demasiado grande')); req.destroy(); return; }
      data.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(data)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    const err = new Error('JSON invalido');
    err.status = 400;
    throw err;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler) {
    const paramNames = [];
    const regexStr = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          paramNames.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    const regex = new RegExp(`^${regexStr}$`);
    this.routes.push({ method, regex, paramNames, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  del(p, h) { this.add('DELETE', p, h); }

  async handle(req, res, ctx) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const m = pathname.match(route.regex);
      if (!m) continue;
      const params = {};
      route.paramNames.forEach((name, i) => { params[name] = m[i + 1]; });
      const query = Object.fromEntries(url.searchParams.entries());
      try {
        await route.handler({ req, res, params, query, ...ctx });
      } catch (e) {
        const status = e.status || 500;
        if (status >= 500) console.error(e);
        sendJson(res, status, { error: e.message || 'Error interno' });
      }
      return true;
    }
    return false;
  }
}

module.exports = { sendJson, readBody, readJsonBody, HttpError, Router };
