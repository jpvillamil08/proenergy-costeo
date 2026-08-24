import { api } from '../api.js';
import { esc } from '../format.js';

export function renderLogin(appEl, onSuccess) {
  appEl.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <img src="/img/logo.png" alt="PROENERGY" class="login-logo">
        <h1>PROENERGY</h1>
        <p class="sub">Costeo, rentabilidad y flujo de caja por cotización</p>
        <div id="login-error"></div>
        <form id="login-form">
          <div class="field"><label>Usuario</label><input name="username" autocomplete="username" required></div>
          <div class="field"><label>Contraseña</label><input name="password" type="password" autocomplete="current-password" required></div>
          <button class="btn btn-primary" style="width:100%; justify-content:center" type="submit">Ingresar</button>
        </form>
        <div class="demo">
          <strong>Usuarios de prueba</strong><br>
          Administrador: <code>admin</code> / <code>admin123</code><br>
          Gerencia (solo lectura): <code>gerencia</code> / <code>gerencia123</code>
        </div>
      </div>
    </div>
  `;
  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const errBox = document.getElementById('login-error');
    errBox.innerHTML = '';
    try {
      const r = await api.post('/api/login', { username: fd.get('username'), password: fd.get('password') });
      onSuccess(r.usuario);
    } catch (err) {
      errBox.innerHTML = `<div class="error">${esc(err.message)}</div>`;
    }
  });
}
