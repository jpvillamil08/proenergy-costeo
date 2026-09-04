import { api } from '../api.js';
import { esc, todayInputVal, money } from '../format.js';

export async function renderCotizacionNueva(content) {
  // Materiales sugeridos por la ultima estimacion (para poder agregarlos como
  // lineas reales al crear la cotizacion). Se guarda aqui, indexado por
  // material_id, para leer las cantidades/checkboxes al enviar el formulario.
  let materialesSugeridos = [];

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
        <div class="field">
          <label>Descripción del trabajo</label>
          <textarea name="descripcion" rows="3"></textarea>
          <div class="btn-row" style="margin-top:6px">
            <button type="button" id="btn-estimar" class="btn btn-secondary">Estimar costos a partir de la descripción</button>
          </div>
        </div>
        <div id="estimacion-resultado"></div>
        <div class="btn-row"><button class="btn btn-primary" type="submit">Crear y continuar</button><a class="btn btn-secondary" href="#/cotizaciones">Cancelar</a></div>
      </form>
    </div>
  `;

  const form = document.getElementById('form-nueva');
  const estimBox = document.getElementById('estimacion-resultado');

  document.getElementById('btn-estimar').addEventListener('click', async () => {
    const descripcion = form.elements['descripcion'].value.trim();
    if (!descripcion) {
      estimBox.innerHTML = `<div class="error-box">Escriba primero la descripción del trabajo.</div>`;
      return;
    }
    estimBox.innerHTML = `<div class="muted">Buscando materiales del catálogo y cotizaciones anteriores parecidas…</div>`;
    try {
      const { materiales, precedentes } = await api.post('/api/cotizaciones/estimar-costos', { descripcion });
      materialesSugeridos = materiales;
      estimBox.innerHTML = renderEstimacion(materiales, precedentes);
    } catch (err) {
      estimBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const cot = await api.post('/api/cotizaciones', {
        numero: fd.get('numero') || undefined, cliente: fd.get('cliente'), descripcion: fd.get('descripcion'),
        fecha_cotizacion: fd.get('fecha_cotizacion'), condicion_pago: fd.get('condicion_pago'),
        dias_credito_otorgados: Number(fd.get('dias_credito_otorgados')), precio_venta: Number(fd.get('precio_venta')),
        pct_anticipo: Number(fd.get('pct_anticipo')) / 100, estado: 'Borrador',
      });
      await agregarMaterialesSeleccionados(cot.cot.id);
      location.hash = `#/cotizaciones/${cot.cot.id}`;
    } catch (err) {
      document.getElementById('msg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  });

  // Toma los checkboxes marcados del panel de estimacion y crea cada material
  // como linea real de la cotizacion recien creada (precio real del catalogo,
  // cantidad que el usuario haya dejado en el input).
  async function agregarMaterialesSeleccionados(cotizacionId) {
    const filas = estimBox.querySelectorAll('tr[data-material-id]');
    for (const fila of filas) {
      const checkbox = fila.querySelector('input[type="checkbox"]');
      if (!checkbox || !checkbox.checked) continue;
      const materialId = fila.getAttribute('data-material-id');
      const sugerido = materialesSugeridos.find((m) => String(m.material_id) === materialId);
      if (!sugerido || sugerido.mejor_precio == null) continue;
      const cantidadInput = fila.querySelector('input[type="number"]');
      const cantidad = Number(cantidadInput ? cantidadInput.value : 1) || 1;
      await api.post(`/api/cotizaciones/${cotizacionId}/materiales`, {
        descripcion: sugerido.descripcion,
        clasificacion: 'Directo',
        forma_pago: 'Contado',
        proveedor_id: sugerido.mejor_proveedor_id,
        cantidad_presupuestada: cantidad,
        costo_unitario: sugerido.mejor_precio,
      });
    }
  }
}

function renderEstimacion(materiales, precedentes) {
  const filasMateriales = materiales.length
    ? materiales.map((m) => `
        <tr data-material-id="${m.material_id}">
          <td><input type="checkbox" ${m.sin_precio ? 'disabled' : ''}></td>
          <td>${esc(m.descripcion)}${m.sin_precio ? ' <span class="muted">(sin precio en catálogo)</span>' : ''}</td>
          <td>${esc(m.unidad)}</td>
          <td><input type="number" min="1" step="1" value="1" style="width:70px" ${m.sin_precio ? 'disabled' : ''}></td>
          <td>${m.mejor_precio != null ? money(m.mejor_precio) : '—'}</td>
          <td>${esc(m.mejor_proveedor_nombre || '—')}</td>
        </tr>`).join('')
    : `<tr><td colspan="6" class="muted">No se encontraron materiales del catálogo que calcen con esta descripción.</td></tr>`;

  const filasPrecedentes = precedentes.length
    ? precedentes.map((p) => `
        <tr>
          <td><a href="#/cotizaciones/${p.id}" target="_blank">${esc(p.numero)}</a></td>
          <td>${esc(p.cliente)}</td>
          <td>${esc(p.descripcion)}</td>
          <td>${esc(p.estado)}</td>
          <td>${p.horasTotales} h</td>
          <td>${money(p.costoManoObra)}</td>
          <td>${money(p.materialesTotal)}</td>
        </tr>`).join('')
    : `<tr><td colspan="7" class="muted">No se encontraron cotizaciones anteriores con una descripción parecida.</td></tr>`;

  return `
    <div class="card" style="background:#f8f9fb;margin-top:10px">
      <h3 style="margin-top:0">Materiales sugeridos (precios reales del catálogo)</h3>
      <p class="muted" style="margin-top:-6px">Marca los que apliquen y ajusta la cantidad; se agregarán como líneas de material al crear la cotización.</p>
      <div class="table-wrap"><table>
        <thead><tr><th></th><th>Material</th><th>Unidad</th><th>Cantidad</th><th>Precio unitario</th><th>Mejor proveedor</th></tr></thead>
        <tbody>${filasMateriales}</tbody>
      </table></div>

      <h3>Cotizaciones anteriores con descripción parecida</h3>
      <p class="muted" style="margin-top:-6px">Referencia de horas y costo de mano de obra real (o presupuestado si aún no se ejecutó). No se agregan automáticamente: revísalas y crea tus propias líneas de mano de obra con criterio.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Número</th><th>Cliente</th><th>Descripción</th><th>Estado</th><th>Horas</th><th>Costo M.O.</th><th>Materiales</th></tr></thead>
        <tbody>${filasPrecedentes}</tbody>
      </table></div>
    </div>
  `;
}
