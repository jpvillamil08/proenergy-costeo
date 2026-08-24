'use strict';
const db = require('../db');
const { sendJson } = require('../lib/http-helpers');
const { withAuth } = require('../lib/guard');

module.exports = (router) => {
  router.get('/api/auditoria', withAuth(async ({ res, query }) => {
    const clauses = [];
    const args = [];
    if (query.entidad) { clauses.push('entidad = ?'); args.push(query.entidad); }
    if (query.desde) { clauses.push('date(fecha) >= date(?)'); args.push(query.desde); }
    if (query.hasta) { clauses.push('date(fecha) <= date(?)'); args.push(query.hasta); }
    if (query.usuario) { clauses.push('usuario_nombre LIKE ?'); args.push(`%${query.usuario}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Number(query.limit) || 300, 1000);
    const rows = db.prepare(`SELECT * FROM auditoria ${where} ORDER BY fecha DESC, id DESC LIMIT ?`).all(...args, limit);
    sendJson(res, 200, rows);
  }));
};
