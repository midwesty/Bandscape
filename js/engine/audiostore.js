// ============================================================
// audiostore.js — audio clips live in IndexedDB (keyed by the
// pattern id), NOT localStorage. localStorage tops out near 5MB
// and a few recordings blow past it; IndexedDB has hundreds of
// MB+, so recordings stop getting silently dropped on save.
//
// Values are stored as data-URL strings (same shape playback and
// export already use). All IndexedDB access is lazy/inside
// functions so this module is import-safe in non-browser tooling.
// ============================================================

const DB_NAME = "bandscape-audio";
const STORE = "clips";
const DB_VERSION = 1;
let _dbp = null;

function db() {
  if (_dbp) return _dbp;
  _dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no-indexeddb"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbp;
}

function store(mode) { return db().then((d) => d.transaction(STORE, mode).objectStore(STORE)); }

export async function putAudio(id, dataURL) {
  const st = await store("readwrite");
  return new Promise((res, rej) => { const r = st.put(dataURL, id); r.onsuccess = () => res(true); r.onerror = () => rej(r.error); });
}

export async function getAudio(id) {
  const st = await store("readonly");
  return new Promise((res, rej) => { const r = st.get(id); r.onsuccess = () => res(r.result != null ? r.result : null); r.onerror = () => rej(r.error); });
}

export async function deleteAudio(id) {
  try {
    const st = await store("readwrite");
    return await new Promise((res) => { const r = st.delete(id); r.onsuccess = () => res(true); r.onerror = () => res(false); });
  } catch { return false; }
}

export async function copyAudio(oldId, newId) {
  try { const d = await getAudio(oldId); if (d != null) await putAudio(newId, d); return true; } catch { return false; }
}

export async function hasAudio(id) {
  try { return (await getAudio(id)) != null; } catch { return false; }
}

// Read every stored clip as { id: dataURL } — used by full backup export.
export async function allAudio() {
  try {
    const st = await store("readonly");
    return await new Promise((res, rej) => {
      const out = {}; const r = st.openCursor();
      r.onsuccess = () => { const c = r.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); };
      r.onerror = () => rej(r.error);
    });
  } catch { return {}; }
}
