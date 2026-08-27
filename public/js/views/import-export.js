import { esc } from '../format.js';

const TIPOS = [
  ['cotizaciones', 'Cotizaciones (encabezado)'],
  ['mano_obra', 'Líneas de mano de obra'],
  ['materiales', 'Líneas de materiales'],
];

export async function renderImportExport(content) {
  content.innerHTML = `
    <h1>Importar y exportar</h1>
    <p class="muted">Usa las mismas columnas del modelo de datos para migrar lo que ya tienes en Excel. Puedes exportar primero para ver el formato exacto esperado.</p>
    <div class="grid-2">
      <div class="card">
        <h3>Exportar</h3>
        <p class="muted">Un archivo Excel con tres hojas (Cotizaciones, Mano de obra, Materiales), o archivos CSV independientes por tabla.</p>
        <div class="btn-row" style="flex-direction:column; align-items:stretch">
          <a class="btn btn-primary" href="/api/export/cotizaciones.xlsx">Descargar Excel completo (.xlsx)</a>
          <a class="btn btn-secondary" href="/api/export/cotizaciones.csv">Cotizaciones (.csv)</a>
          <a class="btn btn-secondary" href="/api/export/mano-obra.csv">Mano de obra (.csv)</a>
          <a class="btn btn-secondary" href="/api/export/materiales.csv">Materiales (.csv)</a>
        </div>
      </div>
      <div class="card">
        <h3>Importar</h3>
        <p class="muted">Importa por tipo. Si el número de cotización ya existe, se actualiza el encabezado; para mano de obra y materiales, las líneas de una cotización se reemplazan por completo con lo importado.</p>
        <form id="form-import">
          <div class="field"><label>Tipo de datos</label>
            <select name="tipo">${TIPOS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Archivo (.csv o .xlsx)</label><input type="file" name="archivo" accept=".csv,.xlsx" required></div>
          <button class="btn btn-primary" type="submit">Importar</button>
        </form>
        <div id="resultado"></div>
      </div>
    </div>
    <div class="card">
      <h3>Columnas esperadas</h3>
      <div class="grid-3">
        <div><strong>Cotizaciones</strong><br><span class="muted">numero, cliente, descripcion, fecha_cotizacion, fecha_aprobacion, condicion_pago, dias_credito_otorgados, precio_venta, pct_anticipo, estado</span></div>
        <div><strong>Mano de obra</strong><br><span class="muted">cotizacion_numero, trabajador, tipo, tarifa_hora, horas_presupuestadas, horas_reales</span></div>
        <div><strong>Materiales</strong><br><span class="muted">cotizacion_numero, descripcion, clasificacion, forma_pago, proveedor, dias_credito_proveedor, fecha_compra, cantidad_presupuestada, cantidad_real, costo_unitario</span></div>
      </div>
    </div>
  `;
  document.getElementById('form-import').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const tipo = fd.get('tipo');
    const archivo = fd.get('archivo');
    if (!archivo || !archivo.name) return;
    const formato = archivo.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
    const resEl = document.getElementById('resultado');
    resEl.innerHTML = '<div class="spinner-msg">Importando…</div>';
    try {
      const res = await fetch(`/api/import?tipo=${tipo}&formato=${formato}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': formato === 'xlsx' ? 'application/octet-stream' : 'text/csv' },
        body: archivo,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al importar');
      const resumen = data.creadas !== undefined
        ? `${data.creadas} creadas, ${data.actualizadas} actualizadas`
        : `${data.insertadas} líneas insertadas`;
      resEl.innerHTML = `<div class="ok-box">Importación completa: ${resumen}.</div>` +
        (data.errores && data.errores.length ? `<div class="error-box">${data.errores.length} filas con error:<br>${data.errores.slice(0, 15).map(esc).join('<br>')}</div>` : '');
    } catch (err) {
      resEl.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  });
}
