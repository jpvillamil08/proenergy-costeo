import { api } from '../api.js';
import { esc } from '../format.js';
import { stillMounted } from '../guard.js';

export async function renderAuditoria(content) {
  let filtros = { entidad: '', usuario: '', desde: '', hasta: '' };

  async function load() {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(filtros).filter(([, v]) => v)));
    const rows = await api.get(`/api/auditoria?${qs.toString()}`);
    if (!stillMounted(content)) return;
    paint(rows);
  }

  function paint(rows) {
    content.innerHTML = `
      <h1>Registro de auditoría</h1>
      <p class="muted">Historial de quién cambió qué y cuándo — visible para Gerencia y Administración.</p>
      <div class="card">
        <div class="filters" style="margin-bottom:12px">
          <div class="field"><label>Entidad</label>
            <select id="f-entidad"><option value="">Todas</option>
              ${['cotizaciones', 'cotizacion_mano_obra', 'cotizacion_materiales', 'pagos', 'trabajadores', 'proveedores', 'parametros_gastos_fijos', 'politicas_comerciales', 'cuentas_por_pagar', 'usuarios', 'plantillas'].map((e) => `<option value="${e}" ${filtros.entidad === e ? 'selected' : ''}>${e}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Usuario</label><input id="f-usuario" value="${esc(filtros.usuario)}" placeholder="Nombre"></div>
          <div class="field"><label>Desde</label><input type="date" id="f-desde" value="${filtros.desde}"></div>
          <div class="field"><label>Hasta</label><input type="date" id="f-hasta" value="${filtros.hasta}"></div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Entidad</th><th>ID</th><th>Campo</th><th>Antes</th><th>Después</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td>${new Date(r.fecha.replace(' ', 'T') + 'Z').toLocaleString('es-CO')}</td>
            <td>${esc(r.usuario_nombre || 'Sistema')}</td><td>${esc(r.accion)}</td><td>${esc(r.entidad)}</td><td>${r.entidad_id ?? ''}</td>
            <td>${esc(r.campo || '')}</td><td>${esc(r.valor_anterior || '')}</td><td>${esc(r.valor_nuevo || '')}</td>
          </tr>`).join('') || '<tr><td colspan="8" class="empty-state">Sin eventos con los filtros actuales.</td></tr>'}</tbody>
        </table></div>
      </div>
    `;
    document.getElementById('f-entidad').addEventListener('change', (e) => { filtros.entidad = e.target.value; load(); });
    document.getElementById('f-usuario').addEventListener('change', (e) => { filtros.usuario = e.target.value; load(); });
    document.getElementById('f-desde').addEventListener('change', (e) => { filtros.desde = e.target.value; load(); });
    document.getElementById('f-hasta').addEventListener('change', (e) => { filtros.hasta = e.target.value; load(); });
  }

  content.innerHTML = '<div class="spinner-msg">Cargando…</div>';
  await load();
}
