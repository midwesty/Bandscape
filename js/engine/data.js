// ============================================================
// data.js — loads every JSON data file once at boot.
// Add a new file here and it's available game-wide as DATA.<key>.
// ============================================================

export const DATA = {
  config: null,
  stats: null,
  conditions: null,
  artists: null,
  objectives: null,
  dialogue: null,
  items: null,
  npcs: null,
  shops: null,
  devices: null,
  venues: null,
  properties: null,
  decor: null,
  instruments: {},
  locations: {}
};

const FILES = {
  config:     "data/config.json",
  stats:      "data/stats.json",
  conditions: "data/conditions.json",
  artists: "data/artists.json",
  objectives: "data/objectives.json",
  dialogue:   "data/dialogue.json",
  items:      "data/items.json",
  npcs:       "data/npcs.json",
  shops:      "data/shops.json",
  devices:    "data/devices.json",
  venues:     "data/venues.json",
  regions:     "data/regions.json",
  genres:      "data/genres.json",
  properties:  "data/properties.json",
  worldaudio:  "data/audio/world.json",
  decor:       "data/decor.json"
};

const INSTRUMENTS = ["guitar", "bass", "piano", "drums", "microphone"];
const LOCATIONS = ["apartment", "town", "venue", "rocktroit", "rocktroit_bar", "arcade", "loft", "rock_loft", "musicstore", "thrift", "apartment_bath", "rock_loft_kitchen", "rock_loft_bath", "rock_loft_bed", "loft_kitchen", "loft_bath", "loft_bed", "loft_balcony", "pokeville", "flamcago", "flamcago_venue", "flamcago_bar", "flamcago_arcade", "flamcago_apt", "records", "kansas_snarey", "kansas_venue", "kansas_bar", "kansas_arcade", "kansas_apt", "jazz_orleans", "orleans_venue", "orleans_bar", "orleans_arcade", "orleans_apt", "flamcago_warehouse", "kansas_levee", "orleans_bourbon", "rocktroit_cut", "van_interior", "bus_interior", "new_funk_city", "newfunk_bar", "newfunk_venue", "newfunk_apt", "newfunk_arcade", "newfunk_block", "bostone", "bost_bar", "bost_venue", "bost_apt", "bost_arcade", "bost_block", "jamlanta", "jam_bar", "jam_venue", "jam_apt", "jam_arcade", "jam_block", "cost_angeles", "cost_bar", "cost_venue", "cost_apt", "cost_arcade", "cost_block", "porthole", "port_bar", "port_venue", "port_apt", "port_arcade", "port_block", "san_flamenco", "sanf_bar", "sanf_venue", "sanf_apt", "sanf_arcade", "sanf_block", "londrum", "lon_bar", "lon_venue", "lon_apt", "lon_arcade", "lon_block", "berlinn", "ber_bar", "ber_venue", "ber_apt", "ber_arcade", "ber_block", "amsterjam", "ams_bar", "ams_venue", "ams_apt", "ams_arcade", "ams_block", "tokyolo", "tok_bar", "tok_venue", "tok_apt", "tok_arcade", "tok_block", "osanka", "osa_bar", "osa_venue", "osa_apt", "osa_arcade", "osa_block", "kyodo", "kyo_bar", "kyo_venue", "kyo_apt", "kyo_arcade", "kyo_block"];

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
