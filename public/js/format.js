// Utilidades de formato: pesos colombianos, porcentajes y fechas dd/mm/aaaa
export function money(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '$ 0';
  const n = Math.round(Number(v));
  const neg = n < 0;
  const s = Math.abs(n).toLocaleString('es-CO', { maximumFractionDigits: 0 });
  return (neg ? '-$ ' : '$ ') + s;
}

export function num(v, dec = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '0';
  return Number(v).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: dec });
}

export function pct(v, dec = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '0,0%';
  return (Number(v) * 100).toLocaleString('es-CO', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + '%';
}

export function fmtDMY(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-');
  if (!y || !m || !d) return '—';
  return `${d}/${m}/${y}`;
}

export function todayInputVal() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

export const SEMAFORO_LABEL = { VIABLE: 'Viable', VIABLE_CON_AJUSTE: 'Viable con ajuste', NO_VIABLE: 'No viable' };
export const SEMAFORO_CLASS = { VIABLE: 'sem-viable', VIABLE_CON_AJUSTE: 'sem-ajuste', NO_VIABLE: 'sem-no-viable' };
