'use strict';
const db = require('../db');
const { sendJson, readJsonBody, HttpError } = require('../lib/http-helpers');
const { verifyPassword, createSession, destroySession, parseCookies } = require('../lib/auth');
const { withAuth, currentUser } = require('../lib/guard');
const { registrar } = require('../lib/audit');

function publicUser(u) {
  return { id: u.id, username: u.username, nombre: u.nombre, rol: u.rol };
}

module.exports = (router) => {
  router.post('/api/login', async ({ req, res }) => {
    const body = await readJsonBody(req);
    const username = (body.username || '').trim().toLowerCase();
    const password = body.password || '';
    const u = db.prepare('SELECT * FROM usuarios WHERE lower(username) = ? AND activo = 1').get(username);
    if (!u || !verifyPassword(password, u.password_salt, u.password_hash)) {
      registrar({ usuario: null, accion: 'LOGIN_FALLIDO', entidad: 'usuarios', entidadId: null, campo: 'username', valorNuevo: username });
      throw new HttpError(401, 'Usuario o contraseña incorrectos');
    }
    const token = createSession(u.id);
    registrar({ usuario: u, accion: 'LOGIN', entidad: 'usuarios', entidadId: u.id });
    res.setHeader('Set-Cookie', `sesion=${token}; HttpOnly; Path=/; Max-Age=${7 * 86400}; SameSite=Lax`);
    sendJson(res, 200, { usuario: publicUser(u) });
  });

  router.post('/api/logout', async ({ req, res }) => {
    const cookies = parseCookies(req);
    if (cookies.sesion) destroySession(cookies.sesion);
    res.setHeader('Set-Cookie', 'sesion=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/me', withAuth(async ({ res, user }) => {
    sendJson(res, 200, { usuario: publicUser(user) });
  }));
};
