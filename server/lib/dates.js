'use strict';
// Utilidades de fechas en formato 'YYYY-MM-DD', tratadas siempre en UTC
// para evitar corrimientos de un dia por zona horaria.

function parseDate(s) {
  if (!s) return null;
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d);
}

function todayStr() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function addDays(dateStr, days) {
  const t = parseDate(dateStr);
  if (t === null) return null;
  const d = new Date(t + days * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function diffDays(dateStrA, dateStrB) {
  const a = parseDate(dateStrA);
  const b = parseDate(dateStrB);
  if (a === null || b === null) return null;
  return Math.round((a - b) / 86400000);
}

function isBefore(dateStrA, dateStrB) {
  const d = diffDays(dateStrA, dateStrB);
  return d !== null && d < 0;
}

function isAfter(dateStrA, dateStrB) {
  const d = diffDays(dateStrA, dateStrB);
  return d !== null && d > 0;
}

function maxDate(dates) {
  const valid = dates.filter(Boolean);
  if (!valid.length) return null;
  return valid.reduce((max, d) => (parseDate(d) > parseDate(max) ? d : max));
}

function fmtDMY(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

module.exports = { parseDate, todayStr, addDays, diffDays, isBefore, isAfter, maxDate, fmtDMY };
