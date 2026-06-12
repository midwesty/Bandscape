// ============================================================
// state.js — the single source of truth for a save.
// Everything that should persist lives on STATE.
// ============================================================

import { DATA } from "./data.js";
import { deleteAudio, copyAudio } from "./audiostore.js";

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
    venueRep: {},                            // Step 17.2: per-venue reputation
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

// ---- contracts & payroll (Step 17.1) ----
// contract = { live:{type,value}, merch:{type,value}, streaming:{type,value} }
//   type ∈ "none"|"split"|"fee"; value = fraction (split) or dollars (fee)
export function ensureContracts() {
  const s = getState(); if (!s) return;
  for (const m of (s.musicians || [])) {
    if (!m.contract) m.contract = { live: { type: "none", value: 0 }, merch: { type: "none", value: 0 }, streaming: { type: "none", value: 0 } };
    for (const k of ["live", "merch", "streaming"]) if (!m.contract[k]) m.contract[k] = { type: "none", value: 0 };
    if (typeof m.owed !== "number") m.owed = 0;
  }
}
export function liveCut(m, pay) { const c = m.contract && m.contract.live; if (!c) return 0; if (c.type === "split") return Math.round(pay * (c.value || 0)); if (c.type === "fee") return Math.round(c.value || 0); return 0; }
export function merchCut(m, rev) { const c = m.contract && m.contract.merch; if (!c || c.type !== "split") return 0; return Math.round(rev * (c.value || 0)); }
export function streamCutFrac(m) { const c = m.contract && m.contract.streaming; return (c && c.type === "split") ? (c.value || 0) : 0; }
export function accrueOwed(m, amount) { if (m && amount > 0) m.owed = (m.owed || 0) + Math.round(amount); }
export function totalOwed() { return (getState().musicians || []).reduce((a, m) => a + (m.owed || 0), 0); }
export function spendable() { return (getState().stats.money || 0) - totalOwed(); }
export function payAllOwed() {
  const s = getState(); const cash = s.stats.money || 0;
  const debts = (s.musicians || []).filter((m) => (m.owed || 0) > 0);
  const total = debts.reduce((a, m) => a + m.owed, 0);
  if (total <= 0) return { paid: 0, total: 0, full: true };
  let paid = 0;
  if (cash >= total) { for (const m of debts) { paid += m.owed; m.owed = 0; } }
  else { const ratio = cash / total; for (const m of debts) { const p = Math.floor(m.owed * ratio); m.owed -= p; paid += p; } }
  addStat("money", -paid);
  return { paid, total, full: paid >= total };
}
export function expectedLiveSplit(m) {
  const cfg = (DATA.config.economy && DATA.config.economy.pay) || {};
  const ovr = musicianOVR(m) / 100; const fameW = Math.min(1, (m.fame || 0) / 60);
  const v = (cfg.expectBase ?? 0.05) + ovr * (cfg.expectSkill ?? 0.12) + fameW * (cfg.expectFame ?? 0.08);
  return Math.min(cfg.expectMax ?? 0.30, Math.max(0.02, v));
}
export function effectiveLiveSplit(m) {
  const c = m.contract && m.contract.live; if (!c) return 0;
  if (c.type === "split") return c.value || 0;
  if (c.type === "fee") { const ref = (DATA.config.economy && DATA.config.economy.pay && DATA.config.economy.pay.feeRefShow) || 120; return Math.min(0.5, (c.value || 0) / ref); }
  return 0;
}
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
// ---- folder CRUD + item ops (Step 16.2) ----
export function createFolder(name) {
  const s = getState(); s.musicFolders = s.musicFolders || [];
  const f = { id: "fld_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: (name || "New folder").trim() || "New folder", createdDay: s.time?.day || 1 };
  s.musicFolders.push(f); return f;
}
export function renameFolder(id, name) { const f = (getState().musicFolders || []).find((x) => x.id === id); if (f) f.name = (name || f.name).trim() || f.name; }
export function deleteFolder(id) {
  const s = getState(); s.musicFolders = (s.musicFolders || []).filter((f) => f.id !== id);
  for (const p of (s.patterns || [])) if (Array.isArray(p.folders)) p.folders = p.folders.filter((x) => x !== id);
  for (const g of (s.songs || [])) if (Array.isArray(g.folders)) g.folders = g.folders.filter((x) => x !== id);
}
export function libItemById(id) {
  const s = getState();
  const p = (s.patterns || []).find((x) => x.id === id); if (p) return { item: p, kind: "loop" };
  const g = (s.songs || []).find((x) => x.id === id); if (g) return { item: g, kind: "song" };
  return null;
}
export function toggleItemFolder(id, folderId) {
  const hit = libItemById(id); if (!hit) return;
  const it = hit.item; it.folders = Array.isArray(it.folders) ? it.folders : [];
  const i = it.folders.indexOf(folderId);
  if (i >= 0) it.folders.splice(i, 1); else it.folders.push(folderId);
}
export function renameLibItem(id, name) { const hit = libItemById(id); if (hit) hit.item.name = (name || hit.item.name).trim() || hit.item.name; }
export function deleteLibItem(id) {
  const s = getState(); const hit = libItemById(id); if (!hit) return;
  if (hit.kind === "loop") { if (hit.item && hit.item.type === "audio") deleteAudio(id); s.patterns = (s.patterns || []).filter((x) => x.id !== id); }
  else s.songs = (s.songs || []).filter((x) => x.id !== id);
}
export function duplicateLibItem(id) {
  const s = getState(); const hit = libItemById(id); if (!hit) return null;
  const copy = JSON.parse(JSON.stringify(hit.item));
  copy.id = (hit.kind === "loop" ? "pat_" : "song_") + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  copy.name = (hit.item.name || "Untitled") + " (copy)";
  copy.createdAt = Date.now(); copy.createdDay = s.time?.day || 1;
  copy.folders = Array.isArray(hit.item.folders) ? hit.item.folders.slice() : [];
  if (hit.kind === "loop") { (s.patterns = s.patterns || []).push(copy); if (hit.item && hit.item.type === "audio") copyAudio(id, copy.id); } else (s.songs = s.songs || []).push(copy);
  return copy.id;
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

// ---- dwellings / properties (Step 19.4) ----
export function propDefs() { return (DATA.properties && DATA.properties.properties) || []; }
export function propDef(id) { return propDefs().find((p) => p.id === id) || null; }
export function ensureProperties() {
  const s = getState(); s.properties = s.properties || {};
  for (const p of propDefs()) {
    if (!s.properties[p.id]) s.properties[p.id] = { status: p.startsControlled || "none" };
  }
  return s.properties;
}
export function propertyStatus(id) { const s = getState(); return (s.properties && s.properties[id] && s.properties[id].status) || "none"; }
export function setPropertyStatus(id, status, extra) {
  const s = getState(); s.properties = s.properties || {};
  s.properties[id] = Object.assign({}, s.properties[id], { status }, extra || {});
  return s.properties[id];
}
// properties the player currently controls (owned or rented)
export function controlledProperties() { return propDefs().filter((p) => { const st = propertyStatus(p.id); return st === "owned" || st === "rented"; }); }
// scene ids the player can send gear to / enter
export function controlledLocations() { return controlledProperties().map((p) => p.location); }

// ---- Bank: band accounts, owner equity/loans, transaction ledger (Step 20.1) ----
export function ensureBankAccounts() {
  const s = getState(); if (!s) return;
  s.ledger = s.ledger || [];
  for (const b of (s.bands || [])) {
    if (b.account == null) b.account = 0;
    if (b.ownerEquity == null) b.ownerEquity = 0;
    if (b.ownerLoan == null) b.ownerLoan = 0;
  }
}
export function bandBalance(id) { const b = bandById(id); return b ? (b.account || 0) : 0; }
export function walletBalance() { return (getState().stats && getState().stats.money) || 0; }

const LEDGER_MAX = 500;
export function logTx({ account = "wallet", band = null, amount = 0, category = "misc", note = "" } = {}) {
  const s = getState(); if (!s) return;
  s.ledger = s.ledger || [];
  s.ledger.unshift({
    id: "tx_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    day: (s.time && s.time.day) || 1, account, band, amount: Math.round(amount), category, note,
  });
  if (s.ledger.length > LEDGER_MAX) s.ledger.length = LEDGER_MAX;
}
export function ledgerEntries(filter) {
  const s = getState(); let arr = (s && s.ledger) || [];
  if (filter && filter.account) arr = arr.filter((e) => e.account === filter.account);
  if (filter && filter.band) arr = arr.filter((e) => e.band === filter.band);
  return arr;
}
function bandNm(b) { return (b && b.name) || "your band"; }

// Move money between the player wallet and a band account. Each returns { ok, msg? }.
export function bankContribute(bandId, amt) {
  amt = Math.floor(amt); const b = bandById(bandId); if (!b) return { ok: false, msg: "No band." };
  if (!(amt > 0)) return { ok: false, msg: "Enter an amount." };
  if (walletBalance() < amt) return { ok: false, msg: "Not enough in your wallet." };
  addStat("money", -amt); b.account = (b.account || 0) + amt; b.ownerEquity = (b.ownerEquity || 0) + amt;
  logTx({ account: "wallet", band: bandId, amount: -amt, category: "contribution", note: `Funded ${bandNm(b)}` });
  logTx({ account: bandId, band: bandId, amount: amt, category: "contribution", note: "Owner contribution" });
  return { ok: true };
}
export function bankWithdraw(bandId, amt) {
  amt = Math.floor(amt); const b = bandById(bandId); if (!b) return { ok: false, msg: "No band." };
  if (!(amt > 0)) return { ok: false, msg: "Enter an amount." };
  if ((b.account || 0) < amt) return { ok: false, msg: "The band doesn't have that much." };
  b.account -= amt; b.ownerEquity = Math.max(0, (b.ownerEquity || 0) - amt); addStat("money", amt);
  logTx({ account: bandId, band: bandId, amount: -amt, category: "withdrawal", note: "Owner withdrawal" });
  logTx({ account: "wallet", band: bandId, amount: amt, category: "withdrawal", note: `Withdrew from ${bandNm(b)}` });
  return { ok: true };
}
export function bankBorrow(bandId, amt) {
  amt = Math.floor(amt); const b = bandById(bandId); if (!b) return { ok: false, msg: "No band." };
  if (!(amt > 0)) return { ok: false, msg: "Enter an amount." };
  if ((b.account || 0) < amt) return { ok: false, msg: "The band can't lend that much." };
  b.account -= amt; b.ownerLoan = (b.ownerLoan || 0) + amt; addStat("money", amt);
  logTx({ account: bandId, band: bandId, amount: -amt, category: "loan", note: "Loan to owner" });
  logTx({ account: "wallet", band: bandId, amount: amt, category: "loan", note: `Borrowed from ${bandNm(b)}` });
  return { ok: true };
}
export function bankRepay(bandId, amt) {
  amt = Math.floor(amt); const b = bandById(bandId); if (!b) return { ok: false, msg: "No band." };
  if (!(amt > 0)) return { ok: false, msg: "Enter an amount." };
  const owe = b.ownerLoan || 0; if (owe <= 0) return { ok: false, msg: "No loan to repay." };
  amt = Math.min(amt, owe, walletBalance());
  if (!(amt > 0)) return { ok: false, msg: "Not enough in your wallet." };
  addStat("money", -amt); b.account = (b.account || 0) + amt; b.ownerLoan = owe - amt;
  logTx({ account: "wallet", band: bandId, amount: -amt, category: "repayment", note: `Repaid ${bandNm(b)}` });
  logTx({ account: bandId, band: bandId, amount: amt, category: "repayment", note: "Loan repayment" });
  return { ok: true, paid: amt };
}

// Pay an expense ON BEHALF of a band. The band account pays the full amount; if it's
// short, the difference is first auto-contributed from the player's wallet (recorded as
// owner equity, withdrawable later) so the band can cover it. The UI is responsible for
// confirming any wallet draw before calling this. Returns { ok, contributed } or { ok:false }.
export function bandSpend(bandId, amount, category = "misc", note = "") {
  amount = Math.floor(amount); const b = bandById(bandId);
  if (!b) return { ok: false, msg: "No band." };
  if (!(amount > 0)) return { ok: false, msg: "Nothing to pay." };
  const have = b.account || 0;
  const short = Math.max(0, amount - have);
  if (short > 0) {
    if (walletBalance() < short) return { ok: false, msg: "Not enough money." };
    addStat("money", -short); b.account = have + short; b.ownerEquity = (b.ownerEquity || 0) + short;
    logTx({ account: "wallet", band: bandId, amount: -short, category: "contribution", note: `Covered ${bandNm(b)} ${category}` });
    logTx({ account: bandId, band: bandId, amount: short, category: "contribution", note: "Owner contribution" });
  }
  b.account -= amount;
  logTx({ account: bandId, band: bandId, amount: -amount, category, note: note || category });
  return { ok: true, contributed: short };
}

// Credit income to a band's account (shows, merch sales, streaming). Logged to the ledger.
export function bandEarn(bandId, amount, category = "income", note = "") {
  amount = Math.floor(amount); const b = bandById(bandId);
  if (!b || !(amount > 0)) return 0;
  b.account = (b.account || 0) + amount;
  logTx({ account: bandId, band: bandId, amount, category, note: note || category });
  return amount;
}

// ---- Payroll: pay members from their band accounts (Step 20.3b) ----
// Per-band view of what's owed to members vs what each band's account holds.
export function payrollSummary() {
  const byBand = {};
  for (const m of (getState().musicians || [])) {
    if ((m.owed || 0) <= 0 || !m.bandId) continue;
    const bid = m.bandId;
    if (!byBand[bid]) { const b = bandById(bid); byBand[bid] = { bandId: bid, name: (b && b.name) || "Band", owed: 0, account: (b && b.account) || 0 }; }
    byBand[bid].owed += m.owed;
  }
  return Object.values(byBand).map((b) => ({ ...b, short: Math.max(0, b.owed - b.account) }));
}
export function payrollTotals() {
  const sum = payrollSummary();
  return { owed: sum.reduce((a, b) => a + b.owed, 0), short: sum.reduce((a, b) => a + b.short, 0), bands: sum };
}

// Pay band members from their band accounts. If `cover` is true, any band short on
// payroll has its shortfall auto-contributed from the player's wallet first (tracked as
// owner equity). Otherwise short bands pay pro-rata and the remainder stays owed.
export function payPayroll(cover) {
  const s = getState();
  let paid = 0, contributed = 0, leftOwed = 0;
  for (const bs of payrollSummary()) {
    const b = bandById(bs.bandId); if (!b) continue;
    if (cover && bs.short > 0 && walletBalance() >= bs.short) {
      addStat("money", -bs.short); b.account = (b.account || 0) + bs.short; b.ownerEquity = (b.ownerEquity || 0) + bs.short;
      logTx({ account: "wallet", band: bs.bandId, amount: -bs.short, category: "contribution", note: `Covered ${bs.name} payroll` });
      logTx({ account: bs.bandId, band: bs.bandId, amount: bs.short, category: "contribution", note: "Owner contribution (payroll)" });
      contributed += bs.short;
    }
    const members = (s.musicians || []).filter((m) => m.bandId === bs.bandId && (m.owed || 0) > 0);
    const owedTotal = members.reduce((a, m) => a + m.owed, 0);
    if (owedTotal <= 0) continue;
    const budget = b.account || 0;
    const ratio = budget >= owedTotal ? 1 : (budget <= 0 ? 0 : budget / owedTotal);
    let bandPaid = 0;
    for (const m of members) {
      const p = ratio >= 1 ? m.owed : Math.floor(m.owed * ratio);
      if (p > 0) { m.owed -= p; bandPaid += p; }
    }
    if (bandPaid > 0) {
      b.account -= bandPaid;
      logTx({ account: bs.bandId, band: bs.bandId, amount: -bandPaid, category: "payout", note: `Paid ${members.length} member${members.length > 1 ? "s" : ""}` });
      paid += bandPaid;
    }
    leftOwed += members.reduce((a, m) => a + (m.owed || 0), 0);
  }
  return { paid, contributed, leftOwed };
}
