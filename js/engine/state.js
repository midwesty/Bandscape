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
    inventory: [],           // Step 3
    containers: { fridge: [], storage: [] }, // Step 3
    equipped: { instrumentId: null },        // what you're holding (guitar, etc.)
    patterns: [],            // Step 4 (loop format ported from old build)
    songs: [],               // Step 5
    band: { name: null, members: [] }, // Step 7
    debt: { pawn: cfg.economy.startingDebtPawn },
    flags: {},
    location: "apartment",
    placedObjects: { apartment: JSON.parse(JSON.stringify(DATA.locations.apartment?.objects || [])) },
    objectives: { active: [], completed: [] },
    _step1Complete: false
  };
}

// ---- stat helpers (data-driven clamping) ----
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
