import { api } from '../api.js';
import { money, pct, num, fmtDMY, esc, todayInputVal, SEMAFORO_LABEL, SEMAFORO_CLASS } from '../format.js';
import { stillMounted } from '../guard.js';

const ESTADOS = ['Borrador', 'Enviada', 'Aprobada', 'Rechazada', 'Ejecutada', 'Cerrada'];
const CARGOS = ['Tecnico', 'Liniero', 'Coordinador operativo', 'Conductor', 'Otros'];

let full = null, isAdmin = false, cotId = null, tab = 'costeo';
let trabajadoresCat = [], proveedoresCat = [], plantillasCat = [], materialesCat = [];

export async function renderCotizacionDetail(content, state, id) {
  cotId = id;
  isAdmin = state.usuario.rol === 'admin';
  tab = 'costeo';
  content.innerHTML = '<div class="spinner-msg">Cargando cotización…</div>';
  const [f, trabs, provs, plantillas, materiales] = await Promise.all([
    api.get(`/api/cotizaciones/${id}`),
    api.get('/api/trabajadores'),
    api.get('/api/proveedores'),
    isAdmin ? api.get('/api/plantillas') : Promise.resolve([]),
    isAdmin ? api.get('/api/materiales') : Promise.resolve([]),
  ]);
  if (!stillMounted(content)) return;
  full = f; trabajadoresCat = trabs; proveedoresCat = provs; plantillasCat = plantillas; materialesCat = materiales;
  paint(content);
}

async function reload(content) {
  const fresh = await api.get(`/api/cotizaciones/${cotId}`);
  if (!stillMounted(content)) return;
  full = fresh;
  paint(content);
}

function paint(content) {
  const { cot, calculo } = full;
  const sem = calculo.semaforo;
  content.innerHTML = `
    <div class="breadcrumb"><a href="#/cotizaciones">Cotizaciones</a> / ${esc(cot.numero)}</div>
    ${!isAdmin ? '<div class="readonly-banner">Modo de solo lectura — Gerencia. No se pueden modificar datos.</div>' : ''}
    <div class="toolbar">
      <div>
        <h1 class="mt-0">${esc(cot.numero)} — ${esc(cot.cliente)}</h1>
        <span class="badge estado-${cot.estado}">${cot.estado}</span>
        <span class="pill">Creada ${fmtDMY(cot.fecha_cotizacion)}</span>
      </div>
      <div class="btn-row">
        ${isAdmin ? `<button class="btn btn-secondary btn-sm" id="btn-guardar-plantilla">Guardar como plantilla</button>` : ''}
        <button class="btn btn-secondary btn-sm" id="btn-print-comercial">Ver cotización comercial</button>
        <button class="btn btn-secondary btn-sm" id="btn-print-interna">Ver cotización interna (PDF)</button>
      </div>
    </div>

    <div class="card" style="display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;">
      <div><span class="sem sem-grande ${SEMAFORO_CLASS[sem.estado]}">${SEMAFORO_LABEL[sem.estado]}</span></div>
      <div style="flex:1; min-width:260px; font-size:13.5px; color:var(--ink-2)">${esc(sem.mensaje)}</div>
    </div>

    <div class="card" id="header-card"></div>

    <div class="tabs" id="tabs">
      ${tabBtn('costeo', 'Costeo y rentabilidad')}
      ${tabBtn('mano-obra', 'Mano de obra')}
      ${tabBtn('materiales', 'Materiales')}
      ${tabBtn('comparativo', 'Presupuestado vs. real')}
      ${tabBtn('cartera', 'Pagos y cartera')}
      ${tabBtn('flujo', 'Flujo de caja')}
    </div>
    <div id="tab-body"></div>
  `;
  document.getElementById('btn-print-comercial').addEventListener('click', () => window.open(`/print/comercial/${cotId}`, '_blank'));
  document.getElementById('btn-print-interna').addEventListener('click', () => window.open(`/print/interna/${cotId}`, '_blank'));
  const btnPlantilla = document.getElementById('btn-guardar-plantilla');
  if (btnPlantilla) btnPlantilla.addEventListener('click', async () => {
    const nombre = prompt('Nombre de la nueva plantilla:', `Plantilla ${full.cot.numero}`);
    if (!nombre) return;
    const datos = {
      manoObra: full.manoObra.map((m) => ({ trabajador_id: m.trabajador_id, horas_presupuestadas: m.horas_presupuestadas })),
      materiales: full.materiales.map((m) => ({ descripcion: m.descripcion, clasificacion: m.clasificacion, forma_pago: m.forma_pago, proveedor_id: m.proveedor_id, dias_credito_proveedor: m.dias_credito_proveedor, cantidad_presupuestada: m.cantidad_presupuestada, costo_unitario: m.costo_unitario })),
    };
    await api.post('/api/plantillas', { nombre, descripcion: `Generada desde ${full.cot.numero} — ${full.cot.cliente}`, datos });
    alert('Plantilla guardada correctamente.');
  });
  content.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; paint(content); }));

  paintHeaderCard(content);
  const body = document.getElementById('tab-body');
  if (tab === 'costeo') paintCosteo(body);
  else if (tab === 'mano-obra') paintManoObra(body, content);
  else if (tab === 'materiales') paintMateriales(body, content);
  else if (tab === 'comparativo') paintComparativo(body);
  else if (tab === 'cartera') paintCartera(body, content);
  else if (tab === 'flujo') paintFlujo(body);
}

function tabBtn(id, label) { return `<button data-tab="${id}" class="${tab === id ? 'active' : ''}">${label}</button>`; }

// ---------------- Encabezado ----------------
function paintHeaderCard(content) {
  const cot = full.cot;
  const el = document.getElementById('header-card');
  if (!isAdmin) {
    el.innerHTML = `
      <div class="form-row">
        <div><label>Descripción</label><div>${esc(cot.descripcion || '—')}</div></div>
        <div><label>Condición de pago</label><div>${esc(cot.condicion_pago)}${cot.condicion_pago === 'Credito' ? ` (${cot.dias_credito_otorgados} días)` : ''}</div></div>
        <div><label>Precio de venta</label><div>${money(cot.precio_venta)}</div></div>
        <div><label>Anticipo</label><div>${pct(cot.pct_anticipo)}</div></div>
        <div><label>Fecha de aprobación</label><div>${fmtDMY(cot.fecha_aprobacion)}</div></div>
      </div>`;
    return;
  }
  el.innerHTML = `
    <form id="form-header">
      <div class="form-row">
        <div class="field"><label>Cliente</label><input name="cliente" value="${esc(cot.cliente)}" required></div>
        <div class="field"><label>Estado</label><select name="estado">${ESTADOS.map((e) => `<option ${e === cot.estado ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
        <div class="field"><label>Fecha de cotización</label><input type="date" name="fecha_cotizacion" value="${cot.fecha_cotizacion}" required></div>
        <div class="field"><label>Fecha de aprobación/entrega</label><input type="date" name="fecha_aprobacion" value="${cot.fecha_aprobacion || ''}"></div>
        <div class="field"><label>Condición de pago</label><select name="condicion_pago"><option ${cot.condicion_pago === 'Contado' ? 'selected' : ''}>Contado</option><option ${cot.condicion_pago === 'Credito' ? 'selected' : ''}>Credito</option></select></div>
        <div class="field"><label>Días de crédito otorgados</label><input type="number" name="dias_credito_otorgados" value="${cot.dias_credito_otorgados}" min="0"></div>
        <div class="field"><label>Precio de venta (sin IVA)</label><input type="number" name="precio_venta" value="${cot.precio_venta}" min="0" step="1000" required></div>
        <div class="field"><label>% Anticipo solicitado</label><input type="number" name="pct_anticipo" value="${cot.pct_anticipo * 100}" min="0" max="100" step="0.1"></div>
      </div>
      <div class="field"><label>Descripción del trabajo</label><textarea name="descripcion" rows="2">${esc(cot.descripcion || '')}</textarea></div>
      <div class="btn-row">
        <button class="btn btn-primary" type="submit">Guardar cambios</button>
        <button class="btn btn-danger" type="button" id="btn-eliminar">Eliminar cotización</button>
      </div>
      <div id="header-msg"></div>
    </form>`;
  document.getElementById('form-header').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.put(`/api/cotizaciones/${cotId}`, {
        cliente: fd.get('cliente'), descripcion: fd.get('descripcion'), fecha_cotizacion: fd.get('fecha_cotizacion'),
        fecha_aprobacion: fd.get('fecha_aprobacion') || null, condicion_pago: fd.get('condicion_pago'),
        dias_credito_otorgados: Number(fd.get('dias_credito_otorgados')), precio_venta: Number(fd.get('precio_venta')),
        pct_anticipo: Number(fd.get('pct_anticipo')) / 100, estado: fd.get('estado'),
      });
      await reload(content);
    } catch (err) { document.getElementById('header-msg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  });
  document.getElementById('btn-eliminar').addEventListener('click', async () => {
    if (!confirm(`¿Eliminar la cotización ${cot.numero}? Esta acción no se puede deshacer.`)) return;
    await api.del(`/api/cotizaciones/${cotId}`);
    location.hash = '#/cotizaciones';
  });
}

// ---------------- Costeo / rentabilidad ----------------
function desgloseTable(lineas) {
  return `<table><thead><tr><th>Concepto</th><th>Fórmula</th><th class="num">Valor</th></tr></thead><tbody>
    ${lineas.map((l) => `<tr${l.subtotal ? ' style="font-weight:700;background:#f8f8f7"' : ''}><td>${esc(l.concepto)}</td><td class="muted">${esc(l.formula)}</td>
    <td class="num">${l.esPct ? pct(l.valor) : l.esHoras ? num(l.valor, 1) + ' h' : money(l.valor)}</td></tr>`).join('')}
  </tbody></table>`;
}

function paintCosteo(body) {
  const c = full.calculo.costeoPresupuestado;
  const rent = full.calculo.rentabilidad;
  const sem = full.calculo.semaforo;
  const part = rent.participaciones;
  body.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <h3>Costeo (presupuestado)</h3>
        ${desgloseTable(c.desglose)}
      </div>
      <div class="card">
        <h3>Rentabilidad</h3>
        ${desgloseTable(rent.desglose)}
      </div>
    </div>
    ${sem.ajuste ? `
    <div class="card">
      <h3>Ajuste sugerido para alcanzar la utilidad objetivo</h3>
      <div class="form-row">
        <div class="kpi"><div class="label">Subir el precio a</div><div class="value">${money(sem.ajuste.subirPrecioA)}</div><div class="sub">+${money(sem.ajuste.subirPrecioEn)}</div></div>
        <div class="kpi"><div class="label">O bajar el costo en</div><div class="value">${money(sem.ajuste.bajarCostoEn)}</div></div>
        <div class="kpi"><div class="label">Horas de más estimadas</div><div class="value">${sem.ajuste.horasDeMasEstimadas !== null ? num(sem.ajuste.horasDeMasEstimadas, 1) + ' h' : 'N/A'}</div></div>
      </div>
    </div>` : ''}
    <div class="card">
      <h3>Participación de cada componente en el costo interno total</h3>
      <table><tbody>
        <tr><td>Materiales directos</td><td class="num">${pct(part.materialesDirectos)}</td></tr>
        <tr><td>Materiales indirectos</td><td class="num">${pct(part.materialesIndirectos)}</td></tr>
        <tr><td>Mano de obra interna</td><td class="num">${pct(part.moInterna)}</td></tr>
        <tr><td>Mano de obra externa</td><td class="num">${pct(part.moExterna)}</td></tr>
        <tr><td>Gastos fijos aplicados</td><td class="num">${pct(part.gastosFijos)}</td></tr>
        <tr><td>Imprevistos</td><td class="num">${pct(part.imprevistos)}</td></tr>
        <tr><td>Comisión de ventas</td><td class="num">${pct(part.comision)}</td></tr>
      </tbody></table>
    </div>
  `;
}

// ---------------- Mano de obra ----------------
function paintManoObra(body, content) {
  const rows = full.manoObra;
  body.innerHTML = `
    <div class="card">
      <div class="section-title" style="margin-top:0"><h2>Líneas de mano de obra</h2>${isAdmin ? aplicarPlantillaBtn() : ''}</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Trabajador</th><th>Tipo</th><th class="num">Tarifa/h</th><th class="num">Horas presup.</th><th class="num">Horas reales</th><th class="num">Costo presup.</th><th class="num">Costo real</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows.map((m) => {
          const factor = m.tipo === 'Interno' ? (m.factor_prestacional || 1) : 1;
          const costoPres = m.horas_presupuestadas * m.tarifa_hora * factor;
          const costoReal = m.horas_reales * m.tarifa_hora * factor;
          return `<tr data-id="${m.id}">
            <td>${esc(m.nombre_snapshot)}</td><td>${m.tipo}</td><td class="num">${money(m.tarifa_hora)}</td>
            <td class="num">${isAdmin ? `<input type="number" class="mo-horas-pres" style="width:80px" value="${m.horas_presupuestadas}" min="0" step="0.5">` : num(m.horas_presupuestadas)}</td>
            <td class="num">${isAdmin ? `<input type="number" class="mo-horas-real" style="width:80px" value="${m.horas_reales}" min="0" step="0.5">` : num(m.horas_reales)}</td>
            <td class="num">${money(costoPres)}</td><td class="num">${money(costoReal)}</td>
            ${isAdmin ? `<td class="btn-row"><button class="btn btn-sm btn-secondary act-guardar-mo">Guardar</button><button class="btn btn-sm btn-danger act-borrar-mo">✕</button></td>` : ''}
          </tr>`;
        }).join('') || `<tr><td colspan="8" class="empty-state">Sin líneas registradas.</td></tr>`}</tbody>
      </table></div>
    </div>
    ${isAdmin ? `<div class="card">
      <h3>Agregar línea de mano de obra</h3>
      <form id="form-mo" class="form-row">
        <div class="field"><label>Trabajador</label><select name="trabajador_id" required>
          <option value="">Seleccione…</option>
          ${trabajadoresCat.map((t) => `<option value="${t.id}">${esc(t.nombre)} — ${esc(t.cargo)} (${t.tipo}, ${money(t.tarifa_hora)}/h)</option>`).join('')}
        </select></div>
        <div class="field"><label>Horas presupuestadas</label><input type="number" name="horas_presupuestadas" min="0" step="0.5" value="0" required></div>
        <div class="field"><label>Horas reales (opcional)</label><input type="number" name="horas_reales" min="0" step="0.5" value="0"></div>
        <div class="field" style="align-self:end"><button class="btn btn-primary">Agregar</button></div>
      </form>
    </div>` : ''}
  `;
  if (!isAdmin) return;
  body.querySelectorAll('.act-guardar-mo').forEach((btn) => btn.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr'); const id = tr.dataset.id;
    const horas_presupuestadas = Number(tr.querySelector('.mo-horas-pres').value) || 0;
    const horas_reales = Number(tr.querySelector('.mo-horas-real').value) || 0;
    await api.put(`/api/cotizaciones/${cotId}/mano-obra/${id}`, { horas_presupuestadas, horas_reales });
    await reload(content);
  }));
  body.querySelectorAll('.act-borrar-mo').forEach((btn) => btn.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr');
    if (!confirm('¿Eliminar esta línea de mano de obra?')) return;
    await api.del(`/api/cotizaciones/${cotId}/mano-obra/${tr.dataset.id}`);
    await reload(content);
  }));
  document.getElementById('form-mo').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api.post(`/api/cotizaciones/${cotId}/mano-obra`, {
      trabajador_id: Number(fd.get('trabajador_id')), horas_presupuestadas: Number(fd.get('horas_presupuestadas')), horas_reales: Number(fd.get('horas_reales')),
    });
    await reload(content);
  });
  wireAplicarPlantilla(content);
}

function aplicarPlantillaBtn() {
  if (!plantillasCat.length) return '';
  return `<div class="btn-row">
    <select id="sel-plantilla" style="width:auto"><option value="">Aplicar plantilla…</option>${plantillasCat.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}</select>
    <button class="btn btn-secondary btn-sm" id="btn-aplicar-plantilla">Aplicar</button>
  </div>`;
}
function wireAplicarPlantilla(content) {
  const btn = document.getElementById('btn-aplicar-plantilla');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const id = document.getElementById('sel-plantilla').value;
    if (!id) return;
    await api.post(`/api/cotizaciones/${cotId}/aplicar-plantilla/${id}`, {});
    await reload(content);
  });
}

// ---------------- Materiales ----------------
function paintMateriales(body, content) {
  const rows = full.materiales;
  body.innerHTML = `
    <div class="card">
      <div class="section-title" style="margin-top:0"><h2>Líneas de materiales e insumos</h2>${isAdmin ? aplicarPlantillaBtn() : ''}</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Descripción</th><th>Clasif.</th><th>Pago</th><th>Proveedor</th><th class="num">Días créd.</th><th class="num">Cant. presup.</th><th class="num">Cant. real</th><th class="num">Costo unit.</th><th class="num">Total presup.</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows.map((m) => {
          const prov = proveedoresCat.find((p) => p.id === m.proveedor_id);
          return `<tr data-id="${m.id}">
            <td>${esc(m.descripcion)}</td><td>${m.clasificacion}</td><td>${m.forma_pago}</td><td>${esc(prov ? prov.nombre : '—')}</td>
            <td class="num">${m.dias_credito_proveedor}</td>
            <td class="num">${isAdmin ? `<input type="number" class="mat-cant-pres" style="width:80px" value="${m.cantidad_presupuestada}" min="0" step="0.01">` : num(m.cantidad_presupuestada)}</td>
            <td class="num">${isAdmin ? `<input type="number" class="mat-cant-real" style="width:80px" value="${m.cantidad_real}" min="0" step="0.01">` : num(m.cantidad_real)}</td>
            <td class="num">${money(m.costo_unitario)}</td>
            <td class="num">${money(m.cantidad_presupuestada * m.costo_unitario)}</td>
            ${isAdmin ? `<td class="btn-row"><button class="btn btn-sm btn-secondary act-guardar-mat">Guardar</button><button class="btn btn-sm btn-danger act-borrar-mat">✕</button></td>` : ''}
          </tr>`;
        }).join('') || `<tr><td colspan="10" class="empty-state">Sin líneas registradas.</td></tr>`}</tbody>
      </table></div>
    </div>
    ${isAdmin ? `<div class="card">
      <h3>Agregar línea de material</h3>
      ${materialesCat.length ? `<div class="field" style="max-width:420px; margin-bottom:10px;">
        <label>Elegir del catálogo (opcional, autocompleta descripción, proveedor y precio)</label>
        <select id="sel-material-cat">
          <option value="">— Escribir manualmente —</option>
          ${materialesCat.map((m) => `<option value="${m.id}">${esc(m.descripcion)}${m.mejor_precio !== null ? ` (desde ${money(m.mejor_precio)})` : ''}</option>`).join('')}
        </select>
      </div>` : ''}
      <form id="form-mat" class="form-row">
        <div class="field"><label>Descripción</label><input name="descripcion" required></div>
        <div class="field"><label>Clasificación</label><select name="clasificacion"><option>Directo</option><option>Indirecto</option></select></div>
        <div class="field"><label>Forma de pago</label><select name="forma_pago"><option>Contado</option><option>Credito</option></select></div>
        <div class="field"><label>Proveedor</label><select name="proveedor_id"><option value="">—</option>${proveedoresCat.map((p) => `<option value="${p.id}" data-dias="${p.dias_credito_habituales}">${esc(p.nombre)}</option>`).join('')}</select></div>
        <div class="field"><label>Días de crédito proveedor</label><input type="number" name="dias_credito_proveedor" min="0" value="0"></div>
        <div class="field"><label>Fecha de compra</label><input type="date" name="fecha_compra" value="${todayInputVal()}"></div>
        <div class="field"><label>Cantidad presupuestada</label><input type="number" name="cantidad_presupuestada" min="0" step="0.01" value="0" required></div>
        <div class="field"><label>Cantidad real (opcional)</label><input type="number" name="cantidad_real" min="0" step="0.01" value="0"></div>
        <div class="field"><label>Costo unitario</label><input type="number" name="costo_unitario" min="0" step="1" value="0" required></div>
        <div class="field" style="align-self:end"><button class="btn btn-primary">Agregar</button></div>
      </form>
    </div>` : ''}
  `;
  if (!isAdmin) return;
  const provSel = document.querySelector('#form-mat select[name=proveedor_id]');
  if (provSel) provSel.addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    const dias = opt ? opt.dataset.dias : null;
    if (dias) document.querySelector('#form-mat input[name=dias_credito_proveedor]').value = dias;
  });
  const selMatCat = document.getElementById('sel-material-cat');
  if (selMatCat) selMatCat.addEventListener('change', (e) => {
    const mat = materialesCat.find((m) => String(m.id) === e.target.value);
    const form = document.getElementById('form-mat');
    if (!mat) return;
    form.descripcion.value = mat.descripcion;
    if (mat.mejor_precio !== null) form.costo_unitario.value = mat.mejor_precio;
    if (mat.mejor_proveedor_id) {
      form.proveedor_id.value = mat.mejor_proveedor_id;
      form.proveedor_id.dispatchEvent(new Event('change'));
    }
  });
  body.querySelectorAll('.act-guardar-mat').forEach((btn) => btn.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr'); const id = tr.dataset.id;
    const m = full.materiales.find((x) => String(x.id) === id);
    const cantidad_presupuestada = Number(tr.querySelector('.mat-cant-pres').value) || 0;
    const cantidad_real = Number(tr.querySelector('.mat-cant-real').value) || 0;
    await api.put(`/api/cotizaciones/${cotId}/materiales/${id}`, { ...m, cantidad_presupuestada, cantidad_real });
    await reload(content);
  }));
  body.querySelectorAll('.act-borrar-mat').forEach((btn) => btn.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr');
    if (!confirm('¿Eliminar esta línea de material?')) return;
    await api.del(`/api/cotizaciones/${cotId}/materiales/${tr.dataset.id}`);
    await reload(content);
  }));
  document.getElementById('form-mat').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api.post(`/api/cotizaciones/${cotId}/materiales`, {
      descripcion: fd.get('descripcion'), clasificacion: fd.get('clasificacion'), forma_pago: fd.get('forma_pago'),
      proveedor_id: fd.get('proveedor_id') || null, dias_credito_proveedor: Number(fd.get('dias_credito_proveedor')) || 0,
      fecha_compra: fd.get('fecha_compra') || null, cantidad_presupuestada: Number(fd.get('cantidad_presupuestada')) || 0,
      cantidad_real: Number(fd.get('cantidad_real')) || 0, costo_unitario: Number(fd.get('costo_unitario')) || 0,
    });
    await reload(content);
  });
  wireAplicarPlantilla(content);
}

// ---------------- Comparativo ----------------
function paintComparativo(body) {
  const c = full.calculo.comparativo;
  body.innerHTML = `
    <div class="card">
      <h3>Presupuestado vs. real</h3>
      <table>
        <thead><tr><th>Concepto</th><th class="num">Presupuestado</th><th class="num">Real</th><th class="num">Desviación</th><th class="num">Desviación %</th></tr></thead>
        <tbody>
          <tr><td>Horas</td><td class="num">${num(c.horas.presupuestadas)}</td><td class="num">${num(c.horas.reales)}</td>
            <td class="num">${num(c.horas.desviacion)}</td><td class="num">${pct(c.horas.desviacionPct)}</td></tr>
          <tr><td>Materiales ($)</td><td class="num">${money(c.materiales.presupuestados)}</td><td class="num">${money(c.materiales.reales)}</td>
            <td class="num">${money(c.materiales.desviacion)}</td><td class="num">${pct(c.materiales.desviacionPct)}</td></tr>
          <tr><td>Costo directo</td><td class="num">${money(c.costoDirecto.presupuestado)}</td><td class="num">${money(c.costoDirecto.real)}</td>
            <td class="num">${money(c.costoDirecto.desviacion)}</td><td class="num">—</td></tr>
          <tr style="font-weight:700"><td>Utilidad</td><td class="num">${money(c.utilidad.presupuestada)}</td><td class="num">${money(c.utilidad.real)}</td>
            <td class="num">${money(c.utilidad.impacto)}</td><td class="num">—</td></tr>
          <tr><td>Margen</td><td class="num">${pct(c.margen.presupuestado)}</td><td class="num">${pct(c.margen.real)}</td><td class="num">—</td><td class="num">—</td></tr>
        </tbody>
      </table>
      <p class="muted" style="margin-top:10px">El impacto en utilidad muestra cuánto ganó o dejó de ganar la cotización por la diferencia entre lo presupuestado y lo realmente ejecutado.</p>
    </div>
  `;
}

// ---------------- Cartera / pagos ----------------
function paintCartera(body, content) {
  const cart = full.calculo.cartera;
  const pagos = full.pagos;
  body.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <h3>Estado de cartera</h3>
        <table><tbody>
          <tr><td>Estado de pago</td><td class="num"><span class="pago-badge pago-${cart.estadoPago.replace(' ', '.')}">${esc(cart.estadoPago)}</span></td></tr>
          <tr><td>Fecha esperada de pago</td><td class="num">${fmtDMY(cart.fechaPagoEsperada)}</td></tr>
          <tr><td>Días esperados / reales</td><td class="num">${cart.diasEsperados} / ${cart.diasRealesCobro ?? 'N/A'}</td></tr>
          <tr><td>Desviación días de cobro</td><td class="num">${cart.desviacionDias ?? 'N/A'}</td></tr>
          <tr><td>Fecha último pago</td><td class="num">${fmtDMY(cart.fechaUltimoPago)}</td></tr>
          <tr><td>Fecha de pago total</td><td class="num">${fmtDMY(cart.fechaPagoTotal)}</td></tr>
          <tr><td>% Recaudado</td><td class="num">${pct(cart.pctRecaudado)}</td></tr>
          <tr><td>Antigüedad</td><td class="num">${cart.bucket || '—'} ${cart.diasMora ? `(${cart.diasMora} días)` : ''}</td></tr>
        </tbody></table>
      </div>
      <div class="card">
        <h3>Desglose de facturación</h3>
        ${desgloseTable(cart.desglose)}
      </div>
    </div>
    <div class="card">
      <h3>Historial de pagos</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Valor</th><th>Medio</th><th>Referencia</th><th>Observación</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
        <tbody>${pagos.map((p) => `<tr data-id="${p.id}"><td>${fmtDMY(p.fecha)}</td><td class="num">${money(p.valor)}</td><td>${esc(p.medio_pago)}</td><td>${esc(p.referencia || '')}</td><td>${esc(p.observacion || '')}</td>
          ${isAdmin ? `<td><button class="btn btn-sm btn-danger act-borrar-pago">✕</button></td>` : ''}</tr>`).join('') || `<tr><td colspan="6" class="empty-state">Sin pagos registrados.</td></tr>`}</tbody>
      </table></div>
    </div>
    ${isAdmin ? `<div class="card">
      <h3>Registrar pago</h3>
      <form id="form-pago" class="form-row">
        <div class="field"><label>Fecha</label><input type="date" name="fecha" value="${todayInputVal()}" required></div>
        <div class="field"><label>Valor</label><input type="number" name="valor" min="0" step="1" required></div>
        <div class="field"><label>Medio de pago</label><select name="medio_pago"><option>Transferencia</option><option>Efectivo</option><option>Cheque</option></select></div>
        <div class="field"><label>Referencia</label><input name="referencia"></div>
        <div class="field"><label>Observación</label><input name="observacion"></div>
        <div class="field" style="align-self:end"><button class="btn btn-primary">Registrar</button></div>
      </form>
    </div>` : ''}
  `;
  if (!isAdmin) return;
  body.querySelectorAll('.act-borrar-pago').forEach((btn) => btn.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr');
    if (!confirm('¿Eliminar este pago?')) return;
    await api.del(`/api/cotizaciones/${cotId}/pagos/${tr.dataset.id}`);
    await reload(content);
  }));
  document.getElementById('form-pago').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api.post(`/api/cotizaciones/${cotId}/pagos`, {
      fecha: fd.get('fecha'), valor: Number(fd.get('valor')), medio_pago: fd.get('medio_pago'),
      referencia: fd.get('referencia'), observacion: fd.get('observacion'),
    });
    await reload(content);
  });
}

// ---------------- Flujo de caja ----------------
function paintFlujo(body) {
  const f = full.calculo.flujoCaja;
  body.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi ${f.riesgoLiquidez ? 'alerta' : ''}"><div class="label">Brecha de caja</div><div class="value">${num(f.brechaCajaDias, 1)} días</div>
        <div class="sub">Días de cobro al cliente (${f.diasCliente}) − días promedio ponderado de crédito a proveedores (${num(f.diasProveedorPonderado, 1)})</div></div>
      <div class="kpi ${f.cajaNegativa ? 'alerta' : ''}"><div class="label">¿Caja negativa en algún momento?</div><div class="value">${f.cajaNegativa ? 'Sí' : 'No'}</div>
        ${f.cajaNegativa ? `<div class="sub">Desde ${fmtDMY(f.fechaCajaNegativa)}</div>` : ''}</div>
      <div class="kpi ${f.riesgoLiquidez ? 'alerta' : ''}"><div class="label">Riesgo de liquidez</div><div class="value">${f.riesgoLiquidez ? 'Sí' : 'No'}</div></div>
    </div>
    <div class="card">
      <h3>Movimientos de caja proyectados/registrados</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th class="num">Valor</th><th class="num">Saldo acumulado</th></tr></thead>
        <tbody>${f.eventos.map((e) => `<tr><td>${fmtDMY(e.fecha)}</td><td>${e.tipo === 'entrada' ? 'Entrada' : 'Salida'}</td><td>${esc(e.concepto)}</td>
          <td class="num" style="color:${e.valor < 0 ? 'var(--critical)' : 'var(--good)'}">${money(e.valor)}</td>
          <td class="num" style="color:${e.saldoAcumulado < 0 ? 'var(--critical)' : 'inherit'}">${money(e.saldoAcumulado)}</td></tr>`).join('') || `<tr><td colspan="5" class="empty-state">Sin movimientos proyectados.</td></tr>`}</tbody>
      </table></div>
    </div>
  `;
}
