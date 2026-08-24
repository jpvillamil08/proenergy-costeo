import { api } from '../api.js';
import { money, num, esc } from '../format.js';
import { stillMounted } from '../guard.js';

export async function renderPlantillas(content) {
  content.innerHTML = '<div class="spinner-msg">Cargando…</div>';
  const rows = await api.get('/api/plantillas');
  if (!stillMounted(content)) return;
  paint(content, rows);
}

function paint(content, rows) {
  content.innerHTML = `
    <div class="toolbar">
      <h1 class="mt-0">Plantillas reutilizables</h1>
    </div>
    <p class="muted">Las plantillas se crean desde el detalle de una cotización ya capturada (pestaña Mano de obra o Materiales, botón "Guardar como plantilla"), para no volver a digitar trabajos repetitivos.</p>
    <div class="grid-2">
      ${rows.map((p) => `
        <div class="card">
          <div class="toolbar" style="margin-bottom:6px"><h3 class="mt-0">${esc(p.nombre)}</h3><button class="btn btn-sm btn-danger act-del" data-id="${p.id}">Eliminar</button></div>
          <p class="muted" style="margin-top:0">${esc(p.descripcion || '')}</p>
          <table><tbody>
            <tr><td>Líneas de mano de obra</td><td class="num">${(p.datos.manoObra || []).length}</td></tr>
            <tr><td>Líneas de materiales</td><td class="num">${(p.datos.materiales || []).length}</td></tr>
            <tr><td>Horas totales presupuestadas</td><td class="num">${num((p.datos.manoObra || []).reduce((a, m) => a + (Number(m.horas_presupuestadas) || 0), 0))}</td></tr>
            <tr><td>Materiales presupuestados ($)</td><td class="num">${money((p.datos.materiales || []).reduce((a, m) => a + (Number(m.cantidad_presupuestada) || 0) * (Number(m.costo_unitario) || 0), 0))}</td></tr>
          </tbody></table>
        </div>
      `).join('') || '<div class="empty-state">Aún no hay plantillas guardadas.</div>'}
    </div>
  `;
  content.querySelectorAll('.act-del').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('¿Eliminar esta plantilla?')) return;
    await api.del(`/api/plantillas/${btn.dataset.id}`);
    renderPlantillas(content);
  }));
}
