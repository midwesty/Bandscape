// ============================================================
// state.js — the single source of truth for a save.
// Everything that should persist lives on STATE.
// ============================================================

import { DATA } from "./data.js";

export let STATE = null;

export function getState() { return STATE; }
export function setState(s) { STATE = s; }

// Build a fresh game from the data files + character creation choices.
export function newGameState(slot, char) {
  const cfg = DATA.config;

  const stats = {};
  for (const def of DATA.stats.stats) stats[def.id] = def.start;
  // character creation can override starting cash/etc. later if desired
  stats.money = cfg.economy.startingMoney;

  return {
    meta: {
      version: cfg.version,
      slot,
      createdAt: Date.now(),
      lastSaved: null
    },
    player: {
      name: char.name || "Nameless",
      avatar: char.avatar || { color: "#ff3b6b", shape: "circle" },
      vibe: char.vibe || "punk"
    },
    time: {
      day: cfg.time.startDay,
      hour: cfg.time.startHour,
      minute: cfg.time.startMinute
    },
    stats,
    conditions: [],          // [{ id, untilHourAbs }]
    inventory: [                                   // pockets (stacks: {item, qty})
      { item: "water", qty: 2 },
      { item: "pizza_slice", qty: 1 },
      { item: "smokes", qty: 1 }
    ],
    containers: {
      fridge:  [ { item: "beer", qty: 4 }, { item: "water", qty: 3 }, { item: "cold_fries", qty: 2 }, { item: "energy_drink", qty: 2 } ],
      storage: [ { item: "ramen_cup", qty: 3 }, { item: "candy_bar", qty: 2 }, { item: "guitar_picks", qty: 8 } ]
    },
    equipped: { instrumentId: null },        // what you're holding
    owned: [],                               // instruments you've picked up (for the in-app switcher)
    addictions: {},                          // substance -> accumulated use (light hook for later)
    patterns: [],            // Step 4 (loop format ported from old build)
    musicFolders: [],        // Step 16: custom tag-style folders for the library
    musicSettings: { key: "C", bpm: 110, timeSig: "4/4", bars: 2, countInBars: 1, metroOn: true, accent: "beat1", chordOct: 3, noteOct: 4 },
    songs: [],               // Step 5
    songDraft: null,         // current studio arrangement in progress
    bands: [{ id: "band_1", name: null, genre: null, playerIn: true, chemistry: 0, fans: 0, fame: 0, pressKit: null, showsPlayed: 0 }], // Step 10 / BandMgmt 3.0
    activeBandId: "band_1",
    musicians: [],                           // BandMgmt 3.0: persistent pool of everyone you've met
    releases: [],                            // Step 14: published releases (Streamr)
    showsByTown: {},                         // Step 15: per-town show counts (venue gates)
    gear: { device: "sp400" },               // Step 11: SoundPound device
    debt: { pawn: cfg.economy.startingDebtPawn },
    calendar: { commitments: [] },   // Step 9: booked rehearsals / shows
    flags: {},
    location: "apartment",
    placedObjects: { apartment: JSON.parse(JSON.stringify(DATA.locations.apartment?.objects || [])) },
    objectives: { active: [], completed: [] },
    _step1Complete: false
  };
}

// ---- stat helpers (data-driven clamping) ----
const ROLE_BY_ARCH = { drummer: "drums", bassist: "bass", singer: "vocals", vocalist: "vocals", keyboardist: "piano", keys: "piano", guitarist: "guitar" };
export function roleFromArchetype(a) { return ROLE_BY_ARCH[(a || "").toLowerCase()] || "guitar"; }
export function bandById(id) { const s = getState(); return (s && s.bands || []).find((b) => b.id === id) || null; }
export function activeBand() {
  const s = getState(); if (!s) return null;
  if (!s.bands) {
    const legacy = s.band || { name: null, members: [], chemistry: 0 };
    legacy.id = legacy.id || "band_1"; legacy.playerIn = true;
    legacy.pressKit = legacy.pressKit || null; legacy.showsPlayed = legacy.showsPlayed || 0;
    legacy.members = (legacy.members || []).map((m) => ({ ...m, role: m.role || roleFromArchetype(m.archetype), happiness: m.happiness == null ? 70 : m.happiness }));
    s.bands = [legacy]; s.activeBandId = legacy.id; delete s.band;
  }
  return s.bands.find((b) => b.id === s.activeBandId) || s.bands[0] || null;
}

// ============================================================
// BandMgmt 3.0 — persistent MUSICIAN pool + band identity.
// Membership is a reference (musician.bandId) rather than an
// embedded copy; the player belongs via per-band `playerIn`.
// ============================================================
const clamp100 = (v) => Math.max(1, Math.min(100, Math.round(v)));
function npcDefById(id) { return (DATA.npcs?.npcs || []).find((n) => n.id === id) || {}; }
function seedStats(npc, sk, rel) {
  if (npc.stats) return { musicianship: 50, stagePresence: 50, songwriting: 50, reliability: 60, ...npc.stats };
  const base = Math.round((sk == null ? 0.5 : sk) * 100);
  return { musicianship: clamp100(base), stagePresence: clamp100(base - 8), songwriting: clamp100(base - 4), reliability: clamp100((rel == null ? 0.6 : rel) * 100) };
}
export function musicianFromNpc(npc, bandId = null, status = "active") {
  const sk = npc.skill, rel = npc.reliability;
  return {
    id: npc.id, name: npc.name || "Musician", archetype: npc.archetype || "musician", genre: npc.genre || null,
    isPlayer: false, status, bandId, role: roleFromArchetype(npc.archetype),
    happiness: npc.happyStart ?? (DATA.config.band?.happiness?.start) ?? 70,
    stats: seedStats(npc, sk, rel),
    potential: npc.potential != null ? npc.potential : clamp100((sk == null ? 0.5 : sk) * 100 + 15),
    fame: npc.fame != null ? npc.fame : Math.round((sk == null ? 0.5 : sk) * 10),
    contract: null, relationships: {}, vices: npc.vices || [], metAt: getState()?.time?.day || 1
  };
}
function memberToMusician(m, bandId) {
  const npc = npcDefById(m.id);
  return {
    id: m.id, name: m.name || npc.name || "Musician", archetype: m.archetype || npc.archetype || "musician", genre: npc.genre || null,
    isPlayer: false, status: "active", bandId, role: m.role || roleFromArchetype(m.archetype || npc.archetype),
    happiness: m.happiness == null ? 70 : m.happiness,
    stats: seedStats(npc, m.skill != null ? m.skill : npc.skill, m.reliability != null ? m.reliability : npc.reliability),
    potential: npc.potential != null ? npc.potential : clamp100((m.skill || 0.5) * 100 + 15),
    fame: npc.fame != null ? npc.fame : Math.round((m.skill || npc.skill || 0.5) * 10),
    contract: null, relationships: {}, vices: npc.vices || [], metAt: getState()?.time?.day || 1
  };
}
// Idempotent: builds the musician pool from any legacy embedded members, upgrades band fields.
export function ensureMusicianModel() {
  const s = getState(); if (!s) return;
  activeBand(); // guarantees s.bands exists (also migrates a legacy single band)
  if (!Array.isArray(s.musicians)) s.musicians = [];
  for (const b of s.bands) {
    if (b.fans == null) b.fans = 0;
    if (b.fame == null) b.fame = 0;
    if (b.genre === undefined) b.genre = null;
    if (Array.isArray(b.members)) {
      for (const m of b.members) { if (!s.musicians.find((x) => x.id === m.id)) s.musicians.push(memberToMusician(m, b.id)); }
      delete b.members; // normalized away
    }
  }
}
export function allMusicians() { ensureMusicianModel(); return getState().musicians; }
export function musicianById(id) { ensureMusicianModel(); return getState().musicians.find((m) => m.id === id) || null; }
export function bandMembers(bandId, opts = {}) {
  ensureMusicianModel();
  const inc = opts.includeBenched !== false;
  return getState().musicians.filter((m) => m.bandId === bandId && (m.status === "active" || (inc && m.status === "benched")));
}
export function performingMembers(bandId) { ensureMusicianModel(); return getState().musicians.filter((m) => m.bandId === bandId && m.status === "active"); }
export function freeAgents() { ensureMusicianModel(); return getState().musicians.filter((m) => m.status === "free_agent"); }
export function retiredMusicians() { ensureMusicianModel(); return getState().musicians.filter((m) => m.status === "retired"); }
export function musicianOVR(m) { const s = (m && m.stats) || {}; return Math.round(0.4 * (s.musicianship || 0) + 0.25 * (s.stagePresence || 0) + 0.25 * (s.songwriting || 0) + 0.1 * (s.reliability || 0)); }
export function playerFame() { return getState()?.stats?.fame || 0; }
export function setMusicianStatus(id, status) {
  const m = musicianById(id); if (!m) return;
  m.status = status;
  if (status === "free_agent" || status === "retired") m.bandId = null;
}
export function assignMusician(id, bandId) { const m = musicianById(id); if (!m) return; m.bandId = bandId; m.status = "active"; }

// ---------- Step 16: library metadata (artist / band / folders) ----------
export const PLAYER_ARTIST = "you";                       // sentinel artist id for the player
export function playerArtistName() { return getState()?.player?.name || "You"; }
export function artistName(artistId) {
  if (!artistId) return "—";
  if (artistId === PLAYER_ARTIST) return playerArtistName();
  const m = (getState()?.musicians || []).find((x) => x.id === artistId);
  return m ? m.name : artistId;
}
function bandByName(name) { return (getState()?.bands || []).find((b) => (b.name || "") === name) || null; }
export function topWriter(bandId) {
  const ms = (getState()?.musicians || []).filter((m) => m.bandId === bandId && (m.status === "active" || m.status === "benched"));
  if (!ms.length) return null;
  return ms.reduce((a, b) => ((b.stats?.songwriting || 0) > (a.stats?.songwriting || 0) ? b : a));
}
// Stamp a freshly-created loop/song with library metadata. Idempotent.
export function stampItem(item, kind, artistId, bandId) {
  const s = getState();
  if (item.artistId == null) item.artistId = artistId || PLAYER_ARTIST;
  if (item.bandId === undefined) item.bandId = bandId !== undefined ? bandId : (activeBand()?.id ?? null);
  if (item.createdDay == null) item.createdDay = s?.time?.day || 1;
  if (item.createdAt == null) item.createdAt = Date.now();
  if (!Array.isArray(item.folders)) item.folders = [];
  item.kind = kind;
  return item;
}
// One-time migration: backfill metadata on pre-Step-16 loops/songs. Idempotent.
export function ensureLibraryMeta() {
  const s = getState(); if (!s) return;
  if (!Array.isArray(s.musicFolders)) s.musicFolders = [];
  if (s._libMetaDone) return;
  const day = s.time?.day || 1;
  for (const p of (s.patterns || [])) {
    if (!Array.isArray(p.folders)) p.folders = [];
    if (p.kind == null) p.kind = "loop";
    if (p.createdDay == null) p.createdDay = day;
    if (p.artistId == null) {
      if (p.by && p.by !== "the band") { const b = bandByName(p.by); if (p.bandId === undefined) p.bandId = b ? b.id : null; const w = topWriter(p.bandId); p.artistId = w ? w.id : null; }
      else { p.artistId = PLAYER_ARTIST; if (p.bandId === undefined) p.bandId = null; }
    }
  }
  for (const sg of (s.songs || [])) {
    if (!Array.isArray(sg.folders)) sg.folders = [];
    if (sg.kind == null) sg.kind = "song";
    if (sg.createdDay == null) sg.createdDay = day;
    if (sg.artistId == null) { sg.artistId = PLAYER_ARTIST; if (sg.bandId === undefined) sg.bandId = null; }
  }
  s._libMetaDone = true;
}

export function statDef(id) {
  return DATA.stats.stats.find((s) => s.id === id) || null;
}

export function addStat(id, delta) {
  if (!STATE) return;
  const def = statDef(id);
  const cur = STATE.stats[id] ?? 0;
  let next = cur + delta;
  if (def) {
    next = Math.max(def.min ?? 0, Math.min(def.max ?? 999999, next));
  }
  STATE.stats[id] = next;
}

export function setFlag(flag, value) {
  if (!STATE) return;
  STATE.flags[flag] = value;
}

// Absolute hour count since game start (used for condition expiry).
export function nowHourAbs() {
  if (!STATE) return 0;
  return (STATE.time.day - 1) * 24 + STATE.time.hour;
}
