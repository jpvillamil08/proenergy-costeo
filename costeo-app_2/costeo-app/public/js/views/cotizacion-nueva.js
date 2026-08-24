import { api } from '../api.js';
import { esc, todayInputVal } from '../format.js';

export async function renderCotizacionNueva(content) {
  content.innerHTML = `
    <div class="breadcrumb"><a href="#/cotizaciones">Cotizaciones</a> / Nueva</div>
    <h1>Nueva cotización</h1>
    <div class="card" style="max-width:640px">
      <div id="msg"></div>
      <form id="form-nueva">
        <div class="form-row">
          <div class="field"><label>Número (opcional, se autogenera)</label><input name="numero" placeholder="COT-0009"></div>
          <div class="field"><label>Cliente</label><input name="cliente" required></div>
          <div class="field"><label>Fecha de cotización</label><input type="date" name="fecha_cotizacion" value="${todayInputVal()}" required></div>
          <div class="field"><label>Condición de pago</label><select name="condicion_pago"><option>Contado</option><option>Credito</option></select></div>
          <div class="field"><label>Días de crédito otorgados</label><input type="number" name="dias_credito_otorgados" value="0" min="0"></div>
          <div class="field"><label>Precio de venta (sin IVA)</label><input type="number" name="precio_venta" value="0" min="0" step="1000" required></div>
          <div class="field"><label>% Anticipo solicitado</label><input type="number" name="pct_anticipo" value="0" min="0" max="100" step="0.1"></div>
        </div>
        <div class="field"><label>Descripción del trabajo</label><textarea name="descripcion" rows="3"></textarea></div>
        <div class="btn-row"><button class="btn btn-primary" type="submit">Crear y continuar</button><a class="btn btn-secondary" href="#/cotizaciones">Cancelar</a></div>
      </form>
    </div>
  `;
  document.getElementById('form-nueva').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const cot = await api.post('/api/cotizaciones', {
        numero: fd.get('numero') || undefined, cliente: fd.get('cliente'), descripcion: fd.get('descripcion'),
        fecha_cotizacion: fd.get('fecha_cotizacion'), condicion_pago: fd.get('condicion_pago'),
        dias_credito_otorgados: Number(fd.get('dias_credito_otorgados')), precio_venta: Number(fd.get('precio_venta')),
        pct_anticipo: Number(fd.get('pct_anticipo')) / 100, estado: 'Borrador',
      });
      location.hash = `#/cotizaciones/${cot.cot.id}`;
    } catch (err) {
      document.getElementById('msg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  });
}
