// Script de diagnostico y recuperacion de acceso.
// USO: normalmente NO hace falta correrlo. Solo se usa si los usuarios admin/gerencia
// quedan sin poder ingresar (por ejemplo si alguien cambio la clave por error).
//
// Modo diagnostico (por defecto, no modifica nada):
//   node server/reset-admin-password.js
//
// Modo reparacion (deja admin/admin123 y gerencia/gerencia123 como estaban al principio,
// y los vuelve a activar si estaban desactivados):
//   RESET_ADMIN_PASSWORD=1 node server/reset-admin-password.js
'use strict';
const db = require('./db');
const { hashPassword, verifyPassword } = require('./lib/auth');

const CUENTAS = [
  { username: 'admin', password: 'admin123' },
  { username: 'gerencia', password: 'gerencia123' },
];

console.log('--- Diagnostico de usuarios ---');
const todos = db.prepare('SELECT id, username, activo, length(password_hash) lh, length(password_salt) ls FROM usuarios').all();
console.log(JSON.stringify(todos, null, 2));

const reparar = process.env.RESET_ADMIN_PASSWORD === '1';

for (const cuenta of CUENTAS) {
  const u = db.prepare('SELECT * FROM usuarios WHERE lower(username) = ?').get(cuenta.username);
  if (!u) {
    console.log(`[${cuenta.username}] no existe en la base de datos.`);
    continue;
  }
  const coincide = verifyPassword(cuenta.password, u.password_salt, u.password_hash);
  console.log(`[${cuenta.username}] activo=${u.activo} clave_por_defecto_coincide=${coincide}`);

  if (!reparar) continue;

  const { hash, salt } = hashPassword(cuenta.password);
  db.prepare('UPDATE usuarios SET password_hash = ?, password_salt = ?, activo = 1 WHERE id = ?').run(hash, salt, u.id);
  console.log(`[${cuenta.username}] clave restablecida a "${cuenta.password}" y usuario reactivado.`);
}

if (!reparar) {
  console.log('\n(Modo diagnostico: no se modifico nada. Para reparar, vuelve a correr con RESET_ADMIN_PASSWORD=1)');
} else {
  console.log('\nListo. admin/admin123 y gerencia/gerencia123 deberian funcionar de nuevo.');
}
