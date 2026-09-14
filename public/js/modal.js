// Ventana modal reutilizable (formularios del CRM). Hasta ahora la app usaba
// prompt()/alert(), que no sirven para formularios de varios campos.
import { esc } from './format.js';

// abrirModal({ titulo, cuerpo (html), textoGuardar, ancho, alMontar(el), alGuardar(el) })
// alGuardar puede lanzar un error: se muestra dentro del modal y no se cierra.
// Devuelve una promesa que resuelve con lo que devuelva alGuardar, o null si se cancela.
export function abrirModal({ titulo, cuerpo, textoGuardar = 'Guardar', ancho = 560, alMontar, alGuardar, soloLectura = false }) {
  return new Promise((resolve) => {
    const fondo = document.createElement('div');
    fondo.className = 'modal-fondo';
    fondo.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="max-width:${Number(ancho)}px">
        <div class="modal-cabecera"><h3>${esc(titulo)}</h3><button type="button" class="modal-x" aria-label="Cerrar">✕</button></div>
        <form class="modal-cuerpo" novalidate>
          ${cuerpo}
          <div class="modal-error"></div>
          <div class="modal-pie btn-row">
            ${soloLectura ? '' : `<button type="submit" class="btn btn-primary">${esc(textoGuardar)}</button>`}
            <button type="button" class="btn btn-secondary modal-cancelar">${soloLectura ? 'Cerrar' : 'Cancelar'}</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(fondo);
    const form = fondo.querySelector('form');
    const cerrar = (valor) => {
      document.removeEventListener('keydown', onKey);
      fondo.remove();
      resolve(valor);
    };
    const onKey = (e) => { if (e.key === 'Escape') cerrar(null); };
    document.addEventListener('keydown', onKey);
    fondo.querySelector('.modal-x').addEventListener('click', () => cerrar(null));
    fondo.querySelector('.modal-cancelar').addEventListener('click', () => cerrar(null));
    fondo.addEventListener('mousedown', (e) => { if (e.target === fondo) cerrar(null); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!alGuardar) { cerrar(true); return; }
      const btn = form.querySelector('button[type="submit"]');
      const errEl = form.querySelector('.modal-error');
      errEl.innerHTML = '';
      btn.disabled = true;
      try {
        const r = await alGuardar(form);
        cerrar(r === undefined ? true : r);
      } catch (err) {
        errEl.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    });
    if (alMontar) alMontar(form, cerrar);
    const primero = form.querySelector('input:not([type=hidden]):not([disabled]), select, textarea');
    if (primero) primero.focus();
  });
}

// Campo de formulario. campo: { name, label, type, value, options: [[valor, etiqueta]] | [texto], required, full, help, attrs }
export function campoHtml(c) {
  const id = `f-${c.name}`;
  const req = c.required ? ' required' : '';
  const attrs = c.attrs || '';
  const v = c.value ?? '';
  let control;
  if (c.type === 'select') {
    const opts = (c.options || []).map((o) => (Array.isArray(o) ? o : [o, o]));
    control = `<select id="${id}" name="${c.name}"${req} ${attrs}>
      ${c.vacio !== false ? `<option value="">${esc(c.vacio || '—')}</option>` : ''}
      ${opts.map(([val, lab]) => `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}
    </select>`;
  } else if (c.type === 'textarea') {
    control = `<textarea id="${id}" name="${c.name}" rows="${c.rows || 3}"${req} ${attrs}>${esc(v)}</textarea>`;
  } else if (c.type === 'checkbox') {
    return `<div class="field ${c.full ? 'full' : ''}"><label class="check"><input type="checkbox" id="${id}" name="${c.name}" ${v ? 'checked' : ''} ${attrs}> ${esc(c.label)}</label></div>`;
  } else {
    control = `<input id="${id}" name="${c.name}" type="${c.type || 'text'}" value="${esc(v)}"${req} ${attrs}>`;
  }
  return `<div class="field ${c.full ? 'full' : ''}"><label for="${id}">${esc(c.label)}${c.required ? ' *' : ''}</label>${control}${c.help ? `<span class="field-help">${esc(c.help)}</span>` : ''}</div>`;
}

// Lee los valores de un formulario: checkbox -> boolean, el resto texto.
export function valoresForm(form) {
  const o = {};
  for (const el of form.querySelectorAll('input[name], select[name], textarea[name]')) {
    o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return o;
}

export function abrirFormulario({ titulo, campos, textoGuardar, ancho, alGuardar, alMontar, intro = '' }) {
  return abrirModal({
    titulo, textoGuardar, ancho, alMontar,
    cuerpo: `${intro}<div class="form-grid">${campos.map(campoHtml).join('')}</div>`,
    alGuardar: async (form) => {
      const faltan = campos.filter((c) => c.required && !String(valoresForm(form)[c.name] || '').trim());
      if (faltan.length) throw new Error(`Complete: ${faltan.map((c) => c.label).join(', ')}`);
      return alGuardar(valoresForm(form), form);
    },
  });
}
