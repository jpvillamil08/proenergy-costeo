'use strict';
const db = require('../db');

function registrar({ usuario, accion, entidad, entidadId, campo = null, valorAnterior = null, valorNuevo = null }) {
  db.prepare(
    `INSERT INTO auditoria (usuario_id, usuario_nombre, accion, entidad, entidad_id, campo, valor_anterior, valor_nuevo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    usuario ? usuario.id : null,
    usuario ? usuario.nombre : 'Sistema',
    accion,
    entidad,
    entidadId ?? null,
    campo,
    valorAnterior === null || valorAnterior === undefined ? null : String(valorAnterior),
    valorNuevo === null || valorNuevo === undefined ? null : String(valorNuevo)
  );
}

// Compara dos objetos "planos" y registra un evento de auditoria por cada campo que cambio.
function registrarCambios({ usuario, entidad, entidadId, antes, despues, ignorar = [] }) {
  const campos = new Set([...Object.keys(antes || {}), ...Object.keys(despues || {})]);
  for (const campo of campos) {
    if (ignorar.includes(campo)) continue;
    const a = antes ? antes[campo] : undefined;
    const d = despues ? despues[campo] : undefined;
    if (a === d) continue;
    if (a === undefined && d === undefined) continue;
    registrar({ usuario, accion: 'EDITAR', entidad, entidadId, campo, valorAnterior: a, valorNuevo: d });
  }
}

module.exports = { registrar, registrarCambios };
