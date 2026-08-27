'use strict';
const { HttpError } = require('./http-helpers');
const { parseCookies, getUserByToken } = require('./auth');

function currentUser(req) {
  const cookies = parseCookies(req);
  return getUserByToken(cookies.sesion);
}

function withAuth(handler) {
  return async (ctx) => {
    const user = currentUser(ctx.req);
    if (!user) throw new HttpError(401, 'No autenticado');
    return handler({ ...ctx, user });
  };
}

function withAdmin(handler) {
  return withAuth(async (ctx) => {
    if (ctx.user.rol !== 'admin') throw new HttpError(403, 'Solo el Administrador puede realizar esta accion');
    return handler(ctx);
  });
}

module.exports = { currentUser, withAuth, withAdmin };
