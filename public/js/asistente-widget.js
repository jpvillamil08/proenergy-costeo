// Widget flotante de chat con el asistente de PROENERGY (Claude).
// Se monta una sola vez en document.body (fuera de #app) para que la
// conversacion no se pierda al navegar entre secciones.
import { api } from './api.js';
import { esc } from './format.js';

let montado = false;
let abierto = false;
let historial = []; // [{role:'user'|'assistant', content:string}]
let enviando = false;
let estadoInicial = null; // null | 'sin-configurar' | 'listo'

function scrollAbajo(el) { el.scrollTop = el.scrollHeight; }

function burbuja(msg) {
  const clase = msg.role === 'user' ? 'asis-msg asis-msg-user' : 'asis-msg asis-msg-bot';
  return `<div class="${clase}">${esc(msg.content).replace(/\n/g, '<br>')}</div>`;
}

export function desmontarAsistente() {
  const el = document.getElementById('asistente-widget');
  if (el) el.remove();
  montado = false;
  abierto = false;
  historial = [];
  estadoInicial = null;
}

export function montarAsistente() {
  if (montado) return;
  montado = true;

  const wrap = document.createElement('div');
  wrap.id = 'asistente-widget';
  wrap.innerHTML = `
    <button id="asis-toggle" class="asis-fab" title="Asistente PROENERGY" aria-label="Abrir asistente">💬</button>
    <div id="asis-panel" class="asis-panel" hidden>
      <div class="asis-header">
        <span>Asistente PROENERGY</span>
        <button id="asis-cerrar" class="asis-cerrar-btn" aria-label="Cerrar">✕</button>
      </div>
      <div id="asis-mensajes" class="asis-mensajes"></div>
      <form id="asis-form" class="asis-form">
        <input id="asis-input" type="text" placeholder="Pregunta por cotizaciones, cartera, costos…" autocomplete="off">
        <button type="submit" class="btn btn-primary">Enviar</button>
      </form>
    </div>
  `;
  document.body.appendChild(wrap);

  const panel = document.getElementById('asis-panel');
  const mensajesEl = document.getElementById('asis-mensajes');
  const form = document.getElementById('asis-form');
  const input = document.getElementById('asis-input');

  function pintarMensajes() {
    if (!historial.length) {
      mensajesEl.innerHTML = '<div class="asis-vacio">Pregúntame por ejemplo: "¿cuáles cotizaciones no son viables?", "¿cuánta cartera está vencida?" o "dame el detalle de COT-0002".</div>';
    } else {
      mensajesEl.innerHTML = historial.map(burbuja).join('');
    }
    scrollAbajo(mensajesEl);
  }

  async function abrir() {
    abierto = true;
    panel.hidden = false;
    pintarMensajes();
    input.focus();
    if (estadoInicial === null) {
      try {
        const r = await api.get('/api/asistente/estado');
        estadoInicial = r.configurada ? 'listo' : 'sin-configurar';
        if (estadoInicial === 'sin-configurar') {
          mensajesEl.innerHTML = '<div class="asis-vacio">El asistente todavía no está configurado. En Railway, pestaña <strong>Variables</strong> del servicio, agrega <code>GEMINI_API_KEY</code> (gratis, sin tarjeta — consíguela en aistudio.google.com/apikey) o <code>ANTHROPIC_API_KEY</code> (de pago).</div>';
        }
      } catch (e) { /* si falla, se intenta igual al enviar el primer mensaje */ }
    }
  }
  function cerrar() { abierto = false; panel.hidden = true; }

  document.getElementById('asis-toggle').addEventListener('click', () => { abierto ? cerrar() : abrir(); });
  document.getElementById('asis-cerrar').addEventListener('click', cerrar);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const texto = input.value.trim();
    if (!texto || enviando) return;
    input.value = '';
    historial.push({ role: 'user', content: texto });
    pintarMensajes();
    enviando = true;
    mensajesEl.insertAdjacentHTML('beforeend', '<div class="asis-msg asis-msg-bot asis-pensando" id="asis-pensando">Pensando…</div>');
    scrollAbajo(mensajesEl);
    try {
      const r = await api.post('/api/asistente/mensaje', { mensaje: texto, historial: historial.slice(0, -1) });
      historial.push({ role: 'assistant', content: r.respuesta });
    } catch (err) {
      historial.push({ role: 'assistant', content: `No pude responder: ${err.message}` });
    } finally {
      enviando = false;
      const p = document.getElementById('asis-pensando');
      if (p) p.remove();
      pintarMensajes();
    }
  });
}
