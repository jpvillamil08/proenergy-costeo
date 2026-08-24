'use strict';
const crypto = require('node:crypto');
const db = require('../db');

const SESSION_DAYS = 7;

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
}

function createSession(usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sesiones (token, usuario_id, expira_en) VALUES (?, ?, ?)').run(token, usuarioId, expira);
  return token;
}

function destroySession(token) {
  db.prepare('DELETE FROM sesiones WHERE token = ?').run(token);
}

function getUserByToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.* FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.token = ? AND s.expira_en > datetime('now')`
  ).get(token);
  return row || null;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

module.exports = { hashPassword, verifyPassword, createSession, destroySession, getUserByToken, parseCookies };
