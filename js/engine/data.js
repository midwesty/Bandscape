// ============================================================
// data.js — loads every JSON data file once at boot.
// Add a new file here and it's available game-wide as DATA.<key>.
// ============================================================

export const DATA = {
  config: null,
  stats: null,
  conditions: null,
  objectives: null,
  dialogue: null,
  items: null,
  npcs: null,
  shops: null,
  devices: null,
  venues: null,
  properties: null,
  instruments: {},
  locations: {}
};

const FILES = {
  config:     "data/config.json",
  stats:      "data/stats.json",
  conditions: "data/conditions.json",
  objectives: "data/objectives.json",
  dialogue:   "data/dialogue.json",
  items:      "data/items.json",
  npcs:       "data/npcs.json",
  shops:      "data/shops.json",
  devices:    "data/devices.json",
  venues:     "data/venues.json",
  properties:  "data/properties.json"
};

const INSTRUMENTS = ["guitar", "bass", "piano", "drums", "microphone"];
const LOCATIONS = ["apartment", "town", "venue", "rocktroit", "rocktroit_bar", "arcade", "loft"];

async function fetchJSON(path) {
  const res = await fetch(path + "?v=" + Date.now()); // cache-bust (GitHub Pages caches hard)
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

export async function loadAllData() {
  const errors = [];

  await Promise.all(Object.entries(FILES).map(async ([key, path]) => {
    try { DATA[key] = await fetchJSON(path); }
    catch (e) { errors.push(e.message); }
  }));

  await Promise.all(INSTRUMENTS.map(async (id) => {
    try { DATA.instruments[id] = await fetchJSON(`data/instruments/${id}.json`); }
    catch (e) { errors.push(e.message); }
  }));

  await Promise.all(LOCATIONS.map(async (id) => {
    try { DATA.locations[id] = await fetchJSON(`data/locations/${id}.json`); }
    catch (e) { errors.push(e.message); }
  }));

  return { ok: errors.length === 0, errors };
}
