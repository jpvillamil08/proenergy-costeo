// Evita que una vista asincrona (fetch en curso) siga mutando el DOM despues
// de que el usuario ya navego a otra pantalla.
export function stillMounted(el) {
  return !!el && document.body.contains(el);
}
