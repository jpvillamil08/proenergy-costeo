import { api } from '../api.js';
import { esc } from '../format.js';
import { stillMounted } from '../guard.js';
import { abrirModal } from '../modal.js';
import { subnavCrm, configCrm, formActividad, filaActividad, conectarActividades, ICONO_ACTIVIDAD } from './crm-comun.js';

// Agenda: calendario mensual o semanal y la lista de tareas (vencidas, hoy,
// proximas). Los recordatorios son dentro de la app; "Outlook" descarga un .ics
// para agregar la actividad al calendario personal.

let vista = 'mes';
let cursor = null; // 'YYYY-MM-DD'
const filtros = { responsable: '', tipo: '', completadas: true };

const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const aFecha = (s) => new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))));
const aTexto = (d) => d.toISOString().slice(0, 10);
const sumar = (s, dias) => aTexto(new Date(aFecha(s).getTime() + dias * 86400000));
const lunesDe = (s) => sumar(s, -((aFecha(s).getUTCDay() + 6) % 7));

function rangoVisible() {
  if (vista === 'semana') { const ini = lunesDe(cursor); return { desde: ini, hasta: sumar(ini, 6) }; }
  const primero = `${cursor.slice(0, 7)}-01`;
  const ini = lunesDe(primero);
  return { desde: ini, hasta: sumar(ini, 41) };
}

export async function renderCrmAgenda(content, state) {
  const isAdmin = state.usuario.rol === 'admin';
  content.innerHTML = `${subnavCrm('agenda')}<div class="spinner-msg">Cargando agenda…</div>`;
  const cfg = await configCrm();
  const hoy = cfg.ahora.slice(0, 10);
  if (!cursor) cursor = hoy;
  const { desde, hasta } = rangoVisible();
  const url = vista === 'tareas' ? '/api/crm/actividades?pendientes=1' : `/api/crm/actividades?desde=${desde}&hasta=${hasta}`;
  const todas = await api.get(url);
  if (!stillMounted(content)) return;
  const recargar = () => renderCrmAgenda(content, state);

  const actividades = todas.filter((a) => a.tipo !== 'Nota'
    && (!filtros.responsable || String(a.responsable_id) === String(filtros.responsable))
    && (!filtros.tipo || a.tipo === filtros.tipo)
    && (filtros.completadas || !a.completada));

  const titulo = vista === 'mes' ? `${MESES[Number(cursor.slice(5, 7)) - 1]} ${cursor.slice(0, 4)}`
    : vista === 'semana' ? `Semana del ${desde.split('-').reverse().join('/')} al ${hasta.split('-').reverse().join('/')}` : 'Tareas pendientes';

  content.innerHTML = `
    ${subnavCrm('agenda')}
    <div class="toolbar">
      <h1 class="mt-0">Agenda</h1>
      <div class="btn-row">
        <div class="toggle">${[['mes', 'Mes'], ['semana', 'Semana'], ['tareas', 'Tareas']].map(([v, l]) => `<button data-v="${v}" class="${vista === v ? 'active' : ''}">${l}</button>`).join('')}</div>
        ${isAdmin ? '<button class="btn btn-primary btn-sm" id="b-nueva">+ Actividad</button>' : ''}
      </div>
    </div>
    <div class="card filtros-card"><div class="filters">
      ${vista !== 'tareas' ? `<div class="btn-row"><button class="btn btn-secondary btn-sm" id="b-ant">‹</button><button class="btn btn-secondary btn-sm" id="b-hoy">Hoy</button><button class="btn btn-secondary btn-sm" id="b-sig">›</button><strong class="agenda-titulo">${esc(titulo)}</strong></div>` : `<strong class="agenda-titulo">${titulo}</strong>`}
      <div class="field"><label>Responsable</label><select id="f-resp"><option value="">Todos</option>${cfg.usuarios.map((u) => `<option value="${u.id}" ${String(filtros.responsable) === String(u.id) ? 'selected' : ''}>${esc(u.nombre)}</option>`).join('')}</select></div>
      <div class="field"><label>Tipo</label><select id="f-tipo"><option value="">Todos</option>${cfg.tiposActividad.filter((t) => t !== 'Nota').map((t) => `<option ${filtros.tipo === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      ${vista !== 'tareas' ? `<label class="check"><input type="checkbox" id="f-comp" ${filtros.completadas ? 'checked' : ''}> Mostrar realizadas</label>` : ''}
    </div></div>
    <div id="ag-cuerpo"></div>`;

  const cuerpo = document.getElementById('ag-cuerpo');
  if (vista === 'tareas') pintarTareas(cuerpo, actividades, hoy, isAdmin, recargar);
  else pintarCalendario(cuerpo, actividades, { desde, hoy, isAdmin, recargar, dias: vista === 'semana' ? 7 : 42 });

  content.querySelectorAll('.toggle button').forEach((b) => b.addEventListener('click', () => { vista = b.dataset.v; recargar(); }));
  const mover = (dir) => {
    if (vista === 'semana') cursor = sumar(cursor, 7 * dir);
    else { const d = aFecha(`${cursor.slice(0, 7)}-01`); d.setUTCMonth(d.getUTCMonth() + dir); cursor = aTexto(d); }
    recargar();
  };
  const bAnt = document.getElementById('b-ant');
  if (bAnt) {
    bAnt.addEventListener('click', () => mover(-1));
    document.getElementById('b-sig').addEventListener('click', () => mover(1));
    document.getElementById('b-hoy').addEventListener('click', () => { cursor = hoy; recargar(); });
    document.getElementById('f-comp').addEventListener('change', (e) => { filtros.completadas = e.target.checked; recargar(); });
  }
  document.getElementById('f-resp').addEventListener('change', (e) => { filtros.responsable = e.target.value; recargar(); });
  document.getElementById('f-tipo').addEventListener('change', (e) => { filtros.tipo = e.target.value; recargar(); });
  if (isAdmin) document.getElementById('b-nueva').addEventListener('click', async () => { if (await formActividad()) recargar(); });
}

function chip(a) {
  const clase = a.completada ? 'hecha' : a.vencida ? 'vencida' : '';
  return `<button type="button" class="ag-chip ${clase}" data-act="${a.id}" title="${esc(`${a.tipo}: ${a.asunto}${a.empresa_nombre ? ' — ' + a.empresa_nombre : ''}`)}">
    <span class="ag-hora">${esc((a.fecha_programada || '').slice(11, 16))}</span> ${ICONO_ACTIVIDAD[a.tipo] || ''} ${esc(a.asunto)}</button>`;
}

function pintarCalendario(el, actividades, { desde, hoy, isAdmin, recargar, dias }) {
  const mesActual = cursor.slice(0, 7);
  const celdas = [];
  for (let i = 0; i < dias; i++) {
    const dia = sumar(desde, i);
    const delDia = actividades.filter((a) => (a.fecha_programada || '').slice(0, 10) === dia).sort((x, y) => String(x.fecha_programada).localeCompare(String(y.fecha_programada)));
    const max = dias === 7 ? 50 : 4;
    celdas.push(`<div class="ag-dia ${dia === hoy ? 'hoy' : ''} ${dias === 42 && dia.slice(0, 7) !== mesActual ? 'fuera' : ''}" data-dia="${dia}">
      <div class="ag-num">${dias === 7 ? `${DIAS[i]} ` : ''}${Number(dia.slice(8, 10))}</div>
      ${delDia.slice(0, max).map(chip).join('')}
      ${delDia.length > max ? `<button type="button" class="ag-mas" data-dia-mas="${dia}">+${delDia.length - max} más</button>` : ''}
    </div>`);
  }
  el.innerHTML = `<div class="card agenda ${dias === 7 ? 'semana' : 'mes'}">
    ${dias === 42 ? `<div class="ag-cab">${DIAS.map((d) => `<div>${d}</div>`).join('')}</div>` : ''}
    <div class="ag-grid">${celdas.join('')}</div>
    ${isAdmin ? '<p class="muted small">Haga clic en un espacio vacío de un día para agendar allí.</p>' : ''}
  </div>`;
  el.querySelectorAll('.ag-chip').forEach((b) => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    verActividad(actividades.find((a) => a.id === Number(b.dataset.act)), isAdmin, recargar);
  }));
  el.querySelectorAll('.ag-mas').forEach((b) => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const dia = b.dataset.diaMas;
    verDia(dia, actividades.filter((a) => (a.fecha_programada || '').slice(0, 10) === dia), isAdmin, recargar);
  }));
  if (isAdmin) {
    el.querySelectorAll('.ag-dia').forEach((d) => d.addEventListener('click', async () => {
      if (await formActividad({ fecha: `${d.dataset.dia}T09:00` })) recargar();
    }));
  }
}

async function verActividad(a, isAdmin, recargar) {
  if (!a) return;
  await verDia(null, [a], isAdmin, recargar);
}

async function verDia(dia, lista, isAdmin, recargar) {
  let cambio = false;
  await abrirModal({
    titulo: dia ? `Actividades del ${dia.split('-').reverse().join('/')}` : 'Actividad', ancho: 760, soloLectura: true,
    cuerpo: `<div class="lista-modal">${lista.map((a) => filaActividad(a, { isAdmin })).join('')}</div>`,
    alMontar: (form, cerrar) => {
      conectarActividades(form, lista, () => { cambio = true; cerrar(true); });
    },
  });
  if (cambio) recargar();
}

function pintarTareas(el, actividades, hoy, isAdmin, recargar) {
  const pend = actividades.filter((a) => !a.completada).sort((x, y) => String(x.fecha_programada || '9').localeCompare(String(y.fecha_programada || '9')));
  const grupos = [
    ['Vencidas', pend.filter((a) => a.vencida)],
    ['Hoy', pend.filter((a) => !a.vencida && (a.fecha_programada || '').slice(0, 10) === hoy)],
    ['Próximos 7 días', pend.filter((a) => (a.fecha_programada || '').slice(0, 10) > hoy && (a.fecha_programada || '').slice(0, 10) <= sumar(hoy, 7))],
    ['Más adelante', pend.filter((a) => (a.fecha_programada || '').slice(0, 10) > sumar(hoy, 7))],
    ['Sin fecha', pend.filter((a) => !a.fecha_programada)],
  ];
  el.innerHTML = grupos.filter(([, l]) => l.length).map(([nombre, l]) => `<div class="card"><h3 class="${nombre === 'Vencidas' ? 'rojo' : ''}">${nombre} (${l.length})</h3>
    <div data-grupo="${esc(nombre)}">${l.map((a) => filaActividad(a, { isAdmin })).join('')}</div></div>`).join('')
    || '<div class="card"><div class="empty-state">No hay tareas pendientes.</div></div>';
  el.querySelectorAll('[data-grupo]').forEach((g) => conectarActividades(g, pend, recargar));
}
