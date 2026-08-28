import { api } from './api.js';
import { esc } from './format.js';
import { montarAsistente, desmontarAsistente } from './asistente-widget.js';

import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderCotizacionesList } from './views/cotizaciones-list.js';
import { renderCotizacionDetail } from './views/cotizacion-detail.js';
import { renderCotizacionNueva } from './views/cotizacion-nueva.js';
import { renderParametros } from './views/admin-parametros.js';
import { renderPoliticas } from './views/admin-politicas.js';
import { renderTrabajadores } from './views/admin-trabajadores.js';
import { renderProveedores } from './views/admin-proveedores.js';
import { renderMateriales } from './views/admin-materiales.js';
import { renderPresupuesto } from './views/presupuesto.js';
import { renderPlantillas } from './views/admin-plantillas.js';
import { renderAuditoria } from './views/auditoria.js';
import { renderImportExport } from './views/import-export.js';
import { renderEstadisticas } from './views/estadisticas.js';
import { renderFacturas } from './views/facturas.js';

const appEl = document.getElementById('app');
export const state = { usuario: null };

const NAV_ADMIN = [
  ['#/dashboard', 'Dashboard'],
  ['#/cotizaciones', 'Cotizaciones'],
  ['#/facturas', 'Facturas'],
  ['#/estadisticas', 'Estadísticas'],
  ['#/presupuesto', 'Presupuesto'],
  ['#/admin/parametros', 'Parámetros'],
  ['#/admin/politicas', 'Políticas'],
  ['#/admin/trabajadores', 'Trabajadores'],
  ['#/admin/proveedores', 'Proveedores'],
  ['#/admin/materiales', 'Materiales'],
  ['#/admin/plantillas', 'Plantillas'],
  ['#/import-export', 'Importar/Exportar'],
  ['#/auditoria', 'Auditoría'],
];
const NAV_GERENCIA = [
  ['#/dashboard', 'Dashboard'],
  ['#/cotizaciones', 'Cotizaciones'],
  ['#/facturas', 'Facturas'],
  ['#/estadisticas', 'Estadísticas'],
  ['#/presupuesto', 'Presupuesto'],
  ['#/auditoria', 'Auditoría'],
];

function layoutShell() {
  const nav = state.usuario.rol === 'admin' ? NAV_ADMIN : NAV_GERENCIA;
  const hash = location.hash || '#/dashboard';
  appEl.innerHTML = `
    <header class="topbar">
      <div class="brand"><img src="/img/logo.png" alt="PROENERGY" class="brand-logo"><span>PROENERGY</span></div>
      <nav>${nav.map(([href, label]) => `<a href="${href}" class="${hash.startsWith(href) ? 'active' : ''}">${label}</a>`).join('')}</nav>
      <div class="user">
        <span>${esc(state.usuario.nombre)}</span>
        <span class="rol-badge">${state.usuario.rol === 'admin' ? 'Administrador' : 'Gerencia'}</span>
        <button id="btn-logout">Salir</button>
      </div>
    </header>
    <main class="content" id="content"></main>
  `;
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await api.post('/api/logout');
    state.usuario = null;
    desmontarAsistente();
    location.hash = '#/login';
    boot();
  });
  montarAsistente();
  return document.getElementById('content');
}

async function router() {
  let hash = location.hash || '#/dashboard';
  if (!state.usuario) {
    if (hash !== '#/login') { location.hash = '#/login'; return; }
    renderLogin(appEl, async (usuario) => { state.usuario = usuario; location.hash = '#/dashboard'; router(); });
    return;
  }
  if (hash === '#/login') { location.hash = '#/dashboard'; return; }

  const content = layoutShell();
  content.innerHTML = '<div class="spinner-msg">Cargando…</div>';

  const isAdmin = state.usuario.rol === 'admin';
  const adminOnly = (fn) => (isAdmin ? fn : async () => { content.innerHTML = '<div class="error-box">Esta sección es exclusiva del Administrador.</div>'; });

  try {
    const m = hash.match(/^#\/cotizaciones\/(\d+)$/);
    if (hash === '#/dashboard') await renderDashboard(content, state);
    else if (hash === '#/cotizaciones') await renderCotizacionesList(content, state);
    else if (hash === '#/cotizaciones/nueva') await (isAdmin ? renderCotizacionNueva(content, state) : (content.innerHTML = '<div class="error-box">Solo el Administrador puede crear cotizaciones.</div>'));
    else if (hash === '#/estadisticas') await renderEstadisticas(content, state);
    else if (hash === '#/facturas') await renderFacturas(content, state);
    else if (m) await renderCotizacionDetail(content, state, m[1]);
    else if (hash === '#/admin/parametros') await adminOnly(renderParametros)(content, state);
    else if (hash === '#/admin/politicas') await adminOnly(renderPoliticas)(content, state);
    else if (hash === '#/admin/trabajadores') await adminOnly(renderTrabajadores)(content, state);
    else if (hash === '#/admin/proveedores') await adminOnly(renderProveedores)(content, state);
    else if (hash === '#/admin/materiales') await adminOnly(renderMateriales)(content, state);
    else if (hash === '#/presupuesto') await renderPresupuesto(content, state);
    else if (hash === '#/admin/plantillas') await adminOnly(renderPlantillas)(content, state);
    else if (hash === '#/import-export') await adminOnly(renderImportExport)(content, state);
    else if (hash === '#/auditoria') await renderAuditoria(content, state);
    else content.innerHTML = '<div class="error-box">Página no encontrada.</div>';
  } catch (e) {
    console.error(e);
    if (e.status === 401) { state.usuario = null; desmontarAsistente(); location.hash = '#/login'; router(); return; }
    content.innerHTML = `<div class="error-box">Error: ${esc(e.message)}</div>`;
  }
}

async function boot() {
  try {
    const r = await api.get('/api/me');
    state.usuario = r.usuario;
  } catch (e) {
    state.usuario = null;
  }
  router();
}

window.addEventListener('hashchange', router);
boot();
