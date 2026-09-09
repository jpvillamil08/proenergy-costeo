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
        <!--
          Aqui se mostraban las credenciales de prueba (admin/admin123 y
          gerencia/gerencia123). Servia mientras la app corria solo en local,
          pero en produccion cualquiera que abriera la direccion las veia y
          entraba a ver clientes, precios y margenes. Se retiraron: las
          credenciales iniciales estan en el README, para quien monta la app.
        -->
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
