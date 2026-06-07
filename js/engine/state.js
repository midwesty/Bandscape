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
    musicSettings: { key: "C", bpm: 110, timeSig: "4/4", bars: 2, countInBars: 1, metroOn: true, accent: "beat1", chordOct: 3, noteOct: 4 },
    songs: [],               // Step 5
    songDraft: null,         // current studio arrangement in progress
    bands: [{ id: "band_1", name: null, members: [], chemistry: 0, pressKit: null, showsPlayed: 0, playerIn: true }], // Step 10
    activeBandId: "band_1",
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
