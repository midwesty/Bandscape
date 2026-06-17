// ============================================================
// worldmusic.js — Step 31: the living world of bands.
//
// Self-contained + deterministic. Reuses the music-theory ideas from
// songwriter.js but with its OWN seeded RNG (never touches songwriter,
// so the DAW is unchanged). Two jobs:
//   1) PROCEDURAL ARRANGER: turn a seed + recipe (genre, tier) into a
//      full, playable song (verse/chorus structure) in the song-player's
//      format. Patterns are regenerated on demand and cached transiently
//      — never persisted — so a whole world of catalogs is featherweight.
//   2) POPULATION: mint ~50 world bands across all regions with full NPC
//      members and deep, tier-scaled catalogs (stored as seeds in state).
// ============================================================
import { DATA } from "../engine/data.js";
import { getState, mainGenre } from "../engine/state.js";
import { registerPatternSource } from "./songplayer.js";

// ---------- seeded RNG ----------
function seedNum(str) { let h = 2166136261; const s = String(str); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// ---------- music theory ----------
const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10] };
const PROGS = [[0, 3, 4, 3], [0, 4, 5, 3], [0, 5, 3, 4], [0, 0, 3, 4], [5, 3, 0, 4], [0, 4, 0, 4]];
const KEYS = [0, 2, 4, 5, 7, 9]; // C D E F G A semitone offsets
// per main-genre recipe: scale feel, bpm range, instruments, drum energy
const GENRE_REC = {
  rock: { feel: "mixolydian", bpm: [120, 160], insts: ["guitar", "bass", "drums"], lead: "guitar" },
  metal: { feel: "minor", bpm: [140, 190], insts: ["guitar", "bass", "drums"], lead: "guitar" },
  pop: { feel: "major", bpm: [100, 128], insts: ["piano", "bass", "drums"], lead: "piano" },
  hiphop: { feel: "minor", bpm: [82, 100], insts: ["piano", "bass", "drums"], lead: "piano" },
  electronic: { feel: "minor", bpm: [120, 132], insts: ["piano", "bass", "drums"], lead: "piano" },
  jazz: { feel: "dorian", bpm: [100, 150], insts: ["piano", "bass", "drums"], lead: "piano" },
  soul: { feel: "dorian", bpm: [88, 118], insts: ["piano", "bass", "drums"], lead: "piano" },
  country: { feel: "major", bpm: [92, 132], insts: ["guitar", "bass", "drums"], lead: "guitar" }
};
const TIER_SKILL = { "Local Act": 0.32, "Hometown Draw": 0.45, "Regional": 0.58, "Touring Act": 0.72, "National": 0.85, "Legend": 0.95 };
const BEATS = 4, SPB = 4, SECTION_BARS = 4;

function triad(scale, deg) { return [0, 2, 4].map((i) => { const idx = deg + i; return scale[idx % scale.length] + 12 * Math.floor(idx / scale.length); }); }
function genMelodic(rng, rootBase, scale, prog, bars, skill, energy) {
  const notes = [];
  for (let b = 0; b < bars; b++) {
    const deg = prog[b % prog.length], tri = triad(scale, deg), bs = b * BEATS * SPB;
    tri.forEach((semi, i) => notes.push({ start: bs, length: SPB, pitch: rootBase + semi, vel: i === 0 ? 0.7 : 0.5 }));
    for (let beat = 1; beat < BEATS; beat++) {
      if (rng() < 0.3 + skill * 0.5 + energy * 0.1) {
        const semi = tri[Math.floor(rng() * tri.length)] + (rng() < skill * 0.5 ? 12 : 0);
        const len = rng() < skill ? Math.max(1, Math.floor(SPB / 2)) : SPB;
        notes.push({ start: bs + beat * SPB, length: len, pitch: rootBase + 12 + semi, vel: 0.85 });
      }
    }
  }
  return notes;
}
function genBass(rng, rootBase, scale, prog, bars, skill) {
  const notes = [];
  for (let b = 0; b < bars; b++) {
    const deg = prog[b % prog.length], root = scale[deg % scale.length], bs = b * BEATS * SPB;
    notes.push({ start: bs, length: SPB * 2, pitch: rootBase + root, vel: 0.9 });
    notes.push({ start: bs + SPB * 2, length: SPB * 2, pitch: rootBase + root + (rng() < skill ? 7 : 0), vel: 0.8 });
  }
  return notes;
}
function genDrums(rng, bars, skill, energy) {
  const notes = [], half = Math.max(1, Math.floor(SPB / 2));
  for (let b = 0; b < bars; b++) {
    const bs = b * BEATS * SPB;
    for (let beat = 0; beat < BEATS; beat++) {
      const t = bs + beat * SPB;
      notes.push({ start: t, length: 1, piece: beat % 2 === 0 ? "kick" : "snare" });
      for (let h = 0; h < SPB; h += half) notes.push({ start: t + h, length: 1, piece: "hihat" });
      if (rng() < skill * 0.3 + energy * 0.2) notes.push({ start: t + half, length: 1, piece: "kick" });
    }
    if (rng() < skill * 0.5) notes.push({ start: bs + BEATS * SPB - 1, length: 1, piece: "crash" });
  }
  return notes;
}

// ---------- transient pattern cache (NEVER persisted) ----------
const _patCache = new Map();
function resolvePattern(id) { return _patCache.get(id) || null; }
registerPatternSource(resolvePattern);

function makePattern(id, inst, notes) {
  return { id, instrument: inst, length: SECTION_BARS * BEATS * SPB, stepsPerBeat: SPB, timeSig: "4/4", notes, type: "midi", generated: true };
}

// Regenerate a full song (deterministic) from a song reference {id, genreMain, tier}.
// Returns a song object in the player's format and caches its patterns.
export function materializeWorldSong(ref) {
  if (typeof ref === "string") ref = _songIndex.get(ref);
  if (!ref) return null;
  const rng = mulberry32(seedNum(ref.id));
  const recId = mainGenre(ref.genreMain) || "rock";
  const rec = GENRE_REC[recId] || GENRE_REC.rock;
  const scale = SCALES[rec.feel] || SCALES.major;
  const bpm = Math.round(rec.bpm[0] + rng() * (rec.bpm[1] - rec.bpm[0]));
  const keyRoot = 48 + pick(rng, KEYS);
  const skill = Math.min(1, (TIER_SKILL[ref.tier] || 0.4) + (rng() - 0.5) * 0.15);
  const verseProg = pick(rng, PROGS), chorusProg = pick(rng, PROGS);
  const patterns = [];
  const trackOf = {};
  for (const inst of rec.insts) {
    for (const sec of ["verse", "chorus"]) {
      const prog = sec === "chorus" ? chorusProg : verseProg;
      const energy = sec === "chorus" ? 1 : 0.4;
      let notes;
      if (inst === "drums") notes = genDrums(rng, SECTION_BARS, skill, energy);
      else if (inst === "bass") notes = genBass(rng, keyRoot - 12, scale, prog, SECTION_BARS, skill);
      else notes = genMelodic(rng, keyRoot + (sec === "chorus" ? 12 : 0), scale, prog, SECTION_BARS, skill, energy);
      const pid = `${ref.id}_${inst}_${sec}`;
      const pat = makePattern(pid, inst, notes);
      _patCache.set(pid, pat);
      (trackOf[inst] = trackOf[inst] || {})[sec] = pid;
    }
  }
  // structure scales with tier
  const ti = ["Local Act", "Hometown Draw", "Regional", "Touring Act", "National", "Legend"].indexOf(ref.tier);
  let sections = ["verse", "chorus", "verse", "chorus"];
  if (ti >= 3) sections = sections.concat(["verse", "chorus"]);
  if (ti >= 5) sections = sections.concat(["chorus"]);
  const tracks = rec.insts.map((inst) => sections.map((sec, i) => ({ patternId: trackOf[inst][sec], startBar: i * SECTION_BARS })));
  return { _songId: ref.id, name: ref.title || "Untitled", bpm, lengthBars: sections.length * SECTION_BARS, tracks, fx: [] };
}

// ---------- population ----------
const _songIndex = new Map(); // songId -> ref (transient; rebuilt from state)

const ADJ = ["Velvet", "Rusty", "Neon", "Wet", "Broken", "Holy", "Plastic", "Midnight", "Concrete", "Paper", "Electric", "Dead", "Golden", "Lonesome", "Screaming", "Quiet", "Crystal", "Burning", "Hollow", "Static"];
const NOUN = ["Lawnmowers", "Tenants", "Cathedrals", "Hounds", "Comets", "Casseroles", "Dial Tones", "Landlords", "Saints", "Mondays", "Engines", "Ghosts", "Pilots", "Vandals", "Sirens", "Cassettes", "Foxes", "Pylons", "Embers", "Drifters", "Sons", "Daughters", "Machines", "Pioneers"];
const FIRST = ["Jules", "Marco", "Dev", "Nina", "Sasha", "Cole", "Remy", "Theo", "Iris", "Gus", "Mara", "Kai", "Lena", "Vince", "Otis", "Pax", "Reese", "Wren", "Zane", "Dot", "Hugo", "Sly", "Bex", "Ned"];
const LAST = ["Vega", "Mercer", "Stone", "Cobb", "Frey", "Nakamura", "Diaz", "Holloway", "Pike", "Ruiz", "Banks", "Okafor", "Sato", "Lindqvist", "Vance", "Cruz", "Bell", "Reyes", "Quinn", "Marsh"];
const ROLES = ["vocals", "guitar", "bass", "drums", "keys"];
const TIERS = ["Local Act", "Hometown Draw", "Regional", "Touring Act", "National", "Legend"];
const TIER_WEIGHTS = [35, 25, 20, 12, 6, 2];
const TIER_FANS = { "Local Act": [40, 220], "Hometown Draw": [200, 700], "Regional": [600, 2200], "Touring Act": [2000, 7000], "National": [6000, 20000], "Legend": [18000, 80000] };
const CATALOG_DEPTH = { "Local Act": [1, 2], "Hometown Draw": [2, 3], "Regional": [3, 5], "Touring Act": [4, 6], "National": [5, 8], "Legend": [7, 11] };
const REL_TITLES = ["Static", "Overpass", "Cheap Seats", "Last Call", "Hometown Static", "Detour", "Closing Time", "Patron Saint", "Dial Tone", "Slow Burn", "County Line", "Afterglow", "Vacancy", "Tin Roof", "Long Way", "Ghost Notes", "Rust", "Neon Sermon", "Backroads", "Tape Hiss", "Curfew", "Loose Change", "Wildfire", "Undertow"];

function weightedTier(rng) { const tot = TIER_WEIGHTS.reduce((a, b) => a + b, 0); let r = rng() * tot; for (let i = 0; i < TIERS.length; i++) { r -= TIER_WEIGHTS[i]; if (r <= 0) return TIERS[i]; } return TIERS[0]; }

function regionGenres(regionId) {
  const r = (DATA.regions && DATA.regions.regions && DATA.regions.regions[regionId]) || {};
  const set = new Set();
  for (const cid of (r.cities || [])) { const c = DATA.regions.cities[cid]; for (const d of ((c && c.districts) || [])) { const m = mainGenre(d.genre); if (m) set.add(m); } }
  const all = Object.keys(GENRE_REC);
  for (const g of all) set.add(g); // every genre possible everywhere, just weighted toward local districts
  return { local: [...set].filter((g, i, a) => a.indexOf(g) === i), all };
}

function genMembers(rng, band) {
  const count = band.genreMain === "hiphop" ? 1 + Math.floor(rng() * 2) : 3 + Math.floor(rng() * 2);
  const skillBase = (TIER_SKILL[band.tier] || 0.4) * 100;
  const roles = ["vocals", ...pick(rng, [["guitar", "bass", "drums"], ["keys", "bass", "drums"], ["guitar", "guitar", "bass", "drums"]])].slice(0, count);
  const members = [];
  for (let i = 0; i < count; i++) {
    const sk = Math.max(10, Math.min(100, Math.round(skillBase + (rng() - 0.4) * 22)));
    members.push({
      id: `${band.id}_m${i}`, name: `${pick(rng, FIRST)} ${pick(rng, LAST)}`,
      archetype: "musician", role: roles[i] || pick(rng, ROLES), genre: band.genreMain,
      isPlayer: false, status: "world", bandId: band.id, world: true,
      happiness: 55 + Math.floor(rng() * 35),
      stats: { musicianship: sk, stagePresence: Math.max(10, sk - 6 + Math.floor(rng() * 12)), songwriting: Math.max(10, sk - 4 + Math.floor(rng() * 10)), reliability: 40 + Math.floor(rng() * 55), endurance: 35 + Math.floor(rng() * 50) },
      fame: Math.round((band.fame || 0) * (0.15 + rng() * 0.2)), potential: Math.min(100, sk + 10 + Math.floor(rng() * 15)),
      contract: null, relationships: {}, vices: []
    });
  }
  return members;
}

function genCatalog(rng, band) {
  const [lo, hi] = CATALOG_DEPTH[band.tier] || [1, 2];
  const n = lo + Math.floor(rng() * (hi - lo + 1));
  const rels = [];
  const fansBase = band.fans || 100;
  for (let i = 0; i < n; i++) {
    const tracks = pick(rng, [1, 1, 2, 3, 3, 4]);
    const type = tracks === 1 ? "Single" : tracks <= 3 ? "EP" : "Album";
    const songs = [];
    for (let j = 0; j < tracks; j++) {
      const sid = `ws_${band.id}_${i}_${j}`;
      const ref = { id: sid, title: `${pick(rng, REL_TITLES)}`, genreMain: band.genreMain, tier: band.tier };
      _songIndex.set(sid, ref);
      songs.push({ id: sid, title: ref.title });
    }
    const streams = Math.round(fansBase * (3 + rng() * 40) * (1 - i * 0.08));
    rels.push({ id: `wr_${band.id}_${i}`, bandId: band.id, title: pick(rng, REL_TITLES) + (rng() < 0.3 ? " " + pick(rng, REL_TITLES) : ""), type, songs, streams: Math.max(10, streams), quality: Math.round((TIER_SKILL[band.tier] || 0.4) * 100), fans: Math.round(Math.max(10, streams) * 0.02), releasedDay: 1 - i });
  }
  return rels;
}

const RESERVED = [
  { id: "riv_parking_lot_gods", name: "Parking Lot Gods", genreMain: "rock" },
  { id: "riv_the_dishwashers", name: "The Dishwashers", genreMain: "rock" },
  { id: "riv_velvet_lawnmower", name: "Velvet Lawnmower", genreMain: "rock" },
  { id: "riv_casserole", name: "Casserole", genreMain: "pop" },
  { id: "riv_dial_tone_revival", name: "Dial Tone Revival", genreMain: "electronic" },
  { id: "riv_the_landlords", name: "The Landlords", genreMain: "hiphop" },
  { id: "riv_soft_serve", name: "Soft Serve", genreMain: "soul" }
];

function buildBand(rng, id, name, regionId, genreMain, tierForce) {
  const tier = tierForce || weightedTier(rng);
  const [flo, fhi] = TIER_FANS[tier] || [40, 220];
  const fans = Math.round(flo + rng() * (fhi - flo));
  const band = {
    id, name, genreMain, subgenre: null, region: regionId, tier,
    fans, fame: Math.round(fans * (0.06 + rng() * 0.06)),
    merchTag: name.split(" ")[0].toLowerCase(), world: true
  };
  band.members = genMembers(rng, band);
  band.releases = genCatalog(rng, band);
  return band;
}

// Guarantee each region has >= perGenre bands of EACH local genre and >= floor total.
// Purely ADDITIVE — only mints bands to cover gaps, so it safely tops up an existing save.
function mintCoverage(bands, regions, rng, perGenre, floor) {
  const used = new Set(bands.map((b) => b.id));
  const usedNames = new Set(bands.map((b) => b.name));
  const newName = () => { let nm, g = 0; do { nm = `${pick(rng, ADJ)} ${pick(rng, NOUN)}`; g++; } while (usedNames.has(nm) && g < 20); usedNames.add(nm); return nm; };
  const newId = (base) => { let i = 0, id = `${base}_0`; while (used.has(id)) { i++; id = `${base}_${i}`; } used.add(id); return id; };
  for (const region of regions) {
    const rg = regionGenres(region); const local = (rg.local && rg.local.length) ? rg.local : Object.keys(GENRE_REC);
    for (const g of local) {
      let have = bands.filter((b) => b.region === region && b.genreMain === g).length;
      while (have < perGenre) { bands.push(buildBand(rng, newId(`wb_${region}_${g}`), newName(), region, g)); have++; }
    }
    let total = bands.filter((b) => b.region === region).length;
    while (total < floor) { bands.push(buildBand(rng, newId(`wb_${region}_fill`), newName(), region, pick(rng, local))); total++; }
  }
  return bands;
}

export function ensureWorldBands() {
  const s = getState(); if (!s) return [];
  const wc = (DATA.config && DATA.config.world) || {};
  const perGenre = wc.bandsPerGenre || 4, floor = wc.bandsFloorPerRegion || 20, ver = wc.coverageVersion || 2;
  const regions = Object.keys((DATA.regions && DATA.regions.regions) || {});
  if (!regions.length) return Array.isArray(s.worldBands) ? s.worldBands : [];
  const rng = mulberry32(seedNum("bandscape-world-v1"));
  if (Array.isArray(s.worldBands) && s.worldBands.length) {
    if (s.worldCoverageVer !== ver) { mintCoverage(s.worldBands, regions, rng, perGenre, floor); s.worldCoverageVer = ver; reindex(s.worldBands); }
    else if (!_songIndex.size) reindex(s.worldBands);
    return s.worldBands;
  }
  const bands = [];
  RESERVED.forEach((r, i) => { const region = regions[i % Math.min(2, regions.length)]; bands.push(buildBand(rng, r.id, r.name, region, r.genreMain)); });
  mintCoverage(bands, regions, rng, perGenre, floor);
  s.worldBands = bands; s.worldCoverageVer = ver; reindex(bands);
  return bands;
}

function reindex(bands) { _songIndex.clear(); for (const b of (bands || [])) for (const rel of (b.releases || [])) for (const sg of (rel.songs || [])) _songIndex.set(sg.id, { id: sg.id, title: sg.title, genreMain: b.genreMain, tier: b.tier }); }

export function worldBands() { return ensureWorldBands(); }
export function worldBandById(id) { return ensureWorldBands().find((b) => b.id === id) || null; }
export function worldBandsInRegion(regionId) { return ensureWorldBands().filter((b) => b.region === regionId); }
export function isWorldSong(id) { ensureWorldBands(); return _songIndex.has(id); }
export function worldPattern(id) { return resolvePattern(id); }
