// ============================================================
// bus.js — global event bus
// Systems talk to each other by emitting/listening for events
// instead of importing each other directly. Keeps modules loose.
// ============================================================

export function emit(name, detail = {}) {
  document.dispatchEvent(new CustomEvent("bandscape:" + name, { detail }));
}

export function on(name, fn) {
  const handler = (e) => fn(e.detail || {});
  document.addEventListener("bandscape:" + name, handler);
  return () => document.removeEventListener("bandscape:" + name, handler);
}
