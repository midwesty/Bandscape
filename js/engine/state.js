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
  if (stats.endurance == null) stats.endurance = (cfg.performance && cfg.performance.playerStartEndurance) || 50; // Step 28: stamina-on-stage stat

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
  if (npc.stats) return { musicianship: 50, stagePresence: 50, songwriting: 50, reliability: 60, endurance: 50, ...npc.stats };
  const base = Math.round((sk == null ? 0.5 : sk) * 100);
  return { musicianship: clamp100(base), stagePresence: clamp100(base - 8), songwriting: clamp100(base - 4), reliability: clamp100((rel == null ? 0.6 : rel) * 100), endurance: clamp100(npc.endurance != null ? npc.endurance * 100 : base - 2) };
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

// ---- Credits & splits (Step 21.1) ----
// Resolve any credit holder (the player, a musician, or a band) to a display name.
export function creditName(id) {
  if (id === PLAYER_ARTIST) return playerArtistName();
  const b = (getState()?.bands || []).find((x) => x.id === id);
  if (b) return b.name || "Unnamed band";
  return artistName(id);
}
// Which band (if any) a credit holder belongs to — for the picker's affiliation hint.
export function creditAffiliation(id) {
  if (id === PLAYER_ARTIST) return "You";
  const b = (getState()?.bands || []).find((x) => x.id === id);
  if (b) return "Band";
  const m = (getState()?.musicians || []).find((x) => x.id === id);
  if (m && m.bandId) { const mb = (getState()?.bands || []).find((x) => x.id === m.bandId); return mb ? (mb.name || "a band") : "free agent"; }
  return m ? "free agent" : "";
}
// Distinct loop-authors (artistIds) across the given songs — i.e. everyone who recorded a part used in them.
export function songWriters(songIds) {
  const ids = new Set(songIds || []);
  const songs = (getState().songs || []).filter((s) => ids.has(s.id));
  const byPat = {}; for (const p of (getState().patterns || [])) byPat[p.id] = p;
  const authors = [];
  const seen = new Set();
  for (const sg of songs) for (const tr of (sg.tracks || [])) for (const c of (tr || [])) {
    const p = byPat[c && c.patternId]; const a = p && p.artistId;
    if (a && !seen.has(a)) { seen.add(a); authors.push(a); }
  }
  return authors;
}
// Build a default credits list for a release: the band performs, you produce, loop-authors write.
export function autoCredits(bandId, songIds) {
  const cfg = (DATA.config && DATA.config.credits) || {};
  const credits = []; const seen = new Set();
  const add = (id, role, pct) => { if (id == null || seen.has(id)) return; seen.add(id); credits.push({ id, role, pct: Math.round(pct) }); };
  if (bandId) add(bandId, "Performer", cfg.bandPct != null ? cfg.bandPct : 50);
  add(PLAYER_ARTIST, "Producer", cfg.playerPct != null ? cfg.playerPct : 20);
  const writers = songWriters(songIds).filter((a) => !seen.has(a));
  const pool = cfg.writerPoolPct != null ? cfg.writerPoolPct : 30;
  const each = writers.length ? Math.floor(pool / writers.length) : 0;
  writers.forEach((a) => add(a, "Songwriter", each));
  return credits;
}

// Split an `amount` of income from a release among its credit holders by % (Step 21.2).
// The releasing band receives the full amount first, then non-retained shares flow out:
// you → wallet, another band → its account, a member → their owed (settled on Payday from
// their band's account; cross-band members get the cash moved to their band first). The
// releasing band keeps its own share; free agents/unresolved ids leave it with the band.
export function splitRoyalty(bandId, credits, amount, note, category = "streaming") {
  amount = Math.floor(amount); const rb = bandById(bandId);
  if (!rb || !(amount > 0)) return;
  rb.account = (rb.account || 0) + amount;
  logTx({ account: bandId, band: bandId, amount, category, note: note || "Royalties" });
  const list = (credits && credits.length) ? credits : [{ id: bandId, pct: 100 }];
  const totalPct = list.reduce((a, c) => a + (Number(c.pct) || 0), 0) || 1;
  const shares = list.map((c) => ({ id: c.id, raw: amount * (Number(c.pct) || 0) / totalPct }));
  shares.forEach((sh) => (sh.amt = Math.floor(sh.raw)));
  let rem = amount - shares.reduce((a, s) => a + s.amt, 0);
  if (rem > 0) { const own = shares.find((s) => s.id === bandId); if (own) own.amt += rem; else { shares.sort((a, b) => b.raw - a.raw); if (shares[0]) shares[0].amt += rem; } }
  for (const sh of shares) {
    if (sh.amt <= 0 || sh.id === bandId) continue;               // band keeps its own share
    if (sh.id === PLAYER_ARTIST) {
      rb.account -= sh.amt; addStat("money", sh.amt);
      logTx({ account: bandId, band: bandId, amount: -sh.amt, category: "royalty", note: "Your royalty cut" });
      logTx({ account: "wallet", band: bandId, amount: sh.amt, category: "royalty", note: `Royalty from ${rb.name || "release"}` });
      continue;
    }
    const ob = bandById(sh.id);
    if (ob) {
      rb.account -= sh.amt; ob.account = (ob.account || 0) + sh.amt;
      logTx({ account: bandId, band: bandId, amount: -sh.amt, category: "royalty", note: `Royalty to ${ob.name || "a band"}` });
      logTx({ account: sh.id, band: sh.id, amount: sh.amt, category: "royalty", note: `Royalty from ${rb.name || "a release"}` });
      continue;
    }
    const m = (getState().musicians || []).find((x) => x.id === sh.id);
    if (m && m.bandId) {
      if (m.bandId !== bandId) {
        const mb = bandById(m.bandId);
        if (mb) {
          rb.account -= sh.amt; mb.account = (mb.account || 0) + sh.amt;
          logTx({ account: bandId, band: bandId, amount: -sh.amt, category: "royalty", note: `Royalty to ${mb.name || "a band"}` });
          logTx({ account: m.bandId, band: m.bandId, amount: sh.amt, category: "royalty", note: `Royalty for ${m.name || "a writer"}` });
        }
      }
      accrueOwed(m, sh.amt);                                      // paid on Payday from their band
    }
    // free agent / unresolved id → releasing band retains the share
  }
}

// Live cover royalty: when a band performs a song RELEASED by another act, it pays a cut of
// that song's share of the gig to the original credit-holders, plus a small fame bump to them.
export function payCoverRoyalty(performerBandId, songId, perSongPay) {
  const rel = (getState().releases || []).find((r) => (r.songIds || []).includes(songId));
  if (!rel || rel.bandId === performerBandId) return null;       // own or unreleased → no royalty
  const pb = bandById(performerBandId); if (!pb) return null;
  const credits = (rel.credits && rel.credits.length) ? rel.credits : [{ id: rel.bandId, pct: 100 }];
  const rate = (DATA.config.credits && DATA.config.credits.liveCoverRate) || 0.4;
  const royalty = Math.floor((perSongPay || 0) * rate);
  if (royalty <= 0) return null;
  pb.account = (pb.account || 0) - royalty;
  logTx({ account: performerBandId, band: performerBandId, amount: -royalty, category: "royalty", note: `Cover royalty: ${rel.title || "song"}` });
  splitRoyalty(rel.bandId, credits, royalty, `Live cover: ${rel.title || "song"}`, "royalty");
  const totalPct = credits.reduce((a, c) => a + (Number(c.pct) || 0), 0) || 1;
  const ff = (DATA.config.credits && DATA.config.credits.liveFameFactor) || 3;
  for (const c of credits) {
    const fame = Math.max(0, Math.round(ff * (Number(c.pct) || 0) / totalPct));
    if (fame <= 0) continue;
    if (c.id === PLAYER_ARTIST) addStat("fame", fame);
    else { const b = bandById(c.id); if (b) b.fame = (b.fame || 0) + fame; else { const m = (getState().musicians || []).find((x) => x.id === c.id); if (m) m.fame = (m.fame || 0) + fame; } }
  }
  return { royalty, title: rel.title || "song", owner: (bandById(rel.bandId) || {}).name || "another act" };
}

// ---- Scene: local buzz, venue discovery, contacts (Step 23.1) ----
export function townBuzz(town) { return ((getState().buzz || {})[town]) || 0; }
export function addBuzz(town, n) { const s = getState(); if (!town || !(n > 0)) return; s.buzz = s.buzz || {}; s.buzz[town] = (s.buzz[town] || 0) + Math.round(n); }
export function isDiscovered(venueId) {
  const v = ((DATA.venues && DATA.venues.venues) || {})[venueId];
  if (!v) return false;
  if (!v.discover) return true;                       // known from the start
  return !!((getState().discovered || {})[venueId]);
}
export function discoverVenue(venueId) { const s = getState(); s.discovered = s.discovered || {}; s.discovered[venueId] = true; }
export function discoverTown(cityId) { const vs = (DATA.venues && DATA.venues.venues) || {}; for (const id in vs) { if (vs[id].town === cityId) discoverVenue(id); } }
export function contacts() { return getState().contacts || []; }
export function getRapport(id) { return ((getState().rapport || {})[id]) || 0; }
export function addRapport(id, n) { const s = getState(); if (!id || !n) return; s.rapport = s.rapport || {}; s.rapport[id] = Math.max(0, Math.min(100, (s.rapport[id] || 0) + n)); }
// ---- Relationship payoffs (Step 25.1): rapport perks read from NPC data ----
function npcRoster() { return (DATA.npcs && DATA.npcs.npcs) || []; }
export function relationshipDraw(town) {            // fans you're tight with bring a crowd
  let mult = 1;
  for (const n of npcRoster()) { const pk = n.perk; if (!pk || pk.type !== "draw") continue; if (town && n.town && n.town !== town) continue; if (getRapport(n.id) >= (pk.minRapport || 0)) mult += (pk.bonus || 0); }
  return Math.min(mult, 1.4);                        // cap the crowd boost at +40%
}
export function ownerPayMult(venueId) {             // a venue owner you're a regular with treats you better
  for (const n of npcRoster()) { const pk = n.perk; if (!pk || pk.type !== "booking" || pk.venue !== venueId) continue; if (getRapport(n.id) >= (pk.minRapport || 0)) return pk.payMult || 1; }
  return 1;
}
export function gainShowRapport(town, amount) {     // playing a show warms the fans who showed up
  for (const n of npcRoster()) { const pk = n.perk; if (!pk || pk.type !== "draw") continue; if (town && n.town && n.town !== town) continue; addRapport(n.id, amount); }
}
export function ensureDecorDefaults() {  // Step 26.1: bring pre-dressed decor to saves that already have a frozen placedObjects snapshot
  const s = getState(); if (!s.placedObjects) return;
  const locs = new Set(((DATA.properties && DATA.properties.properties) || []).map((p) => p.location).filter(Boolean));
  for (const loc of locs) {
    const snap = s.placedObjects[loc]; if (!snap) continue;             // no snapshot -> uses fresh defaults already
    const defs = (DATA.locations[loc] && DATA.locations[loc].objects) || [];
    const have = new Set(snap.map((o) => o && o.id).filter(Boolean));
    for (const o of defs) { if (o && o.id && !have.has(o.id)) snap.push(JSON.parse(JSON.stringify(o))); }
  }
}
export function propVibe(loc) {              // Step 26.1: a place's Vibe from its decor (higher-tier + more items both help)
  const s = getState();
  const arr = (s.placedObjects && s.placedObjects[loc]) || (DATA.locations[loc] && DATA.locations[loc].objects) || [];
  const decor = DATA.decor && DATA.decor.items; if (!decor) return 0;
  let sum = 0, n = 0;
  for (const o of arr) { if (o && o.decorId && decor[o.decorId]) { sum += decor[o.decorId].vibe || 0; n++; } }
  return Math.round(sum + Math.min(n, 12) * 0.5);
}
export function homeVibeHere() {        // Vibe of the owned/rented place you're currently standing in (else 0)
  const s = getState();
  const here = controlledProperties().find((p) => p.location === s.location);
  return here ? propVibe(here.location) : 0;
}
function propertyContaining(loc) {      // Step 27.3: the controlled property whose main scene OR any room is `loc`
  return controlledProperties().find((p) => p.location === loc || Object.values(p.rooms || {}).includes(loc)) || null;
}
export function homeAmbient(tag) {      // Step 27.3: sum a décor ambient tag across the WHOLE property (any room), property-wide
  const s = getState();
  const here = propertyContaining(s.location); if (!here) return 0;
  const decor = DATA.decor && DATA.decor.items; if (!decor) return 0;
  const scenes = [here.location, ...Object.values(here.rooms || {})];
  let sum = 0;
  for (const loc of scenes) {
    const arr = (s.placedObjects && s.placedObjects[loc]) || (DATA.locations[loc] && DATA.locations[loc].objects) || [];
    for (const o of arr) { const dd = o && o.decorId && decor[o.decorId]; if (dd && dd.ambient && dd.ambient.tag === tag) sum += dd.ambient.amount || 0; }
  }
  return sum;
}
export function npcPerk(id) { const n = npcRoster().find((x) => x.id === id); return n ? n.perk || null : null; }
export function addContact(c) {
  if (!c || !c.id) return false;
  const s = getState(); s.contacts = s.contacts || [];
  if (s.contacts.some((x) => x.id === c.id)) return false;
  s.contacts.push({ id: c.id, name: c.name || "Someone", role: c.role || "", venueId: c.venueId || null, metDay: (s.time && s.time.day) || 1, rel: c.rel || 1 });
  return true;
}
export function ensureScene() {
  const s = getState();
  s.buzz = s.buzz || {};
  s.discovered = s.discovered || {};
  s.contacts = s.contacts || [];
  s.rapport = s.rapport || {};
  // You already know Ralph — his basement is your first bookable room and first contact.
  if (!s.discovered.ralphs) {
    const v = ((DATA.venues && DATA.venues.venues) || {}).ralphs;
    if (v) { s.discovered.ralphs = true; if (v.booker) addContact(Object.assign({ venueId: "ralphs" }, v.booker)); }
  }
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
// ---- Fleet: vehicles are owned INSTANCES (own many, each assigned to a band) ----
function nextVehId(s) { s._vehSeq = (s._vehSeq || 0) + 1; return "veh#" + s._vehSeq; }
export function ownedVehicles() {
  const s = getState(); if (!s) return [];
  if (!Array.isArray(s.vehicles)) s.vehicles = [];
  if (!s.vehiclesMigrated) {                       // migrate the old single-of-each ownership into the fleet, once
    for (const p of propDefs()) {
      if (!p.vehicle) continue;
      const rec = s.properties && s.properties[p.id];
      if (rec && (rec.status === "owned" || rec.status === "rented")) {
        s.vehicles.push({ id: nextVehId(s), type: p.id, status: rec.status, bandId: rec.bandId || (activeBand() && activeBand().id) || null, nextRentDay: rec.nextRentDay, behind: !!rec.behind });
        s.properties[p.id] = { status: "none" };
      }
    }
    s.vehiclesMigrated = true;
  }
  return s.vehicles;
}
export function vehicleById(id) { return ownedVehicles().find((v) => v.id === id) || null; }
export function addVehicle(type, status, bandId, extra) { const s = getState(); ownedVehicles(); const inst = Object.assign({ id: nextVehId(s), type, status, bandId: bandId || null }, extra || {}); s.vehicles.push(inst); return inst; }
export function removeVehicle(id) { const s = getState(); ownedVehicles(); s.vehicles = s.vehicles.filter((v) => v.id !== id); }
export function setVehicleBand(id, bandId) { const v = vehicleById(id); if (v) v.bandId = bandId; return v; }
export function ownsVehicle() { return ownedVehicles().length > 0; }
export function bandHasVehicle(bandId) { return ownedVehicles().some((v) => v.bandId === bandId); }
export function controlledProperties() {
  const phys = propDefs().filter((p) => { const st = propertyStatus(p.id); return st === "owned" || st === "rented"; });
  const vehTypes = new Set(ownedVehicles().map((v) => v.type));
  const veh = [...vehTypes].map((t) => propDef(t)).filter((d) => d && !phys.includes(d));
  return phys.concat(veh);
}
export function propertyMeta(id) { const s = getState(); return (s.properties && s.properties[id]) || {}; }
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
// Snapshot of one band's payroll for the UI.
export function bandPayroll(bandId) {
  const s = getState(); const b = bandById(bandId);
  const members = (s.musicians || []).filter((m) => m.bandId === bandId && (m.owed || 0) > 0).map((m) => ({ id: m.id, name: m.name, owed: m.owed }));
  const owed = members.reduce((a, m) => a + m.owed, 0);
  const account = b ? (b.account || 0) : 0;
  return { owed, account, short: Math.max(0, owed - account), members };
}

function coverShortfall(b, bandId, short) {
  addStat("money", -short); b.account = (b.account || 0) + short; b.ownerEquity = (b.ownerEquity || 0) + short;
  logTx({ account: "wallet", band: bandId, amount: -short, category: "contribution", note: `Covered ${b.name || "band"} payroll` });
  logTx({ account: bandId, band: bandId, amount: short, category: "contribution", note: "Owner contribution (payroll)" });
}

// Pay ONE band's members from its account. cover=true fronts any shortfall from your wallet.
export function payBand(bandId, cover) {
  const s = getState(); const b = bandById(bandId); if (!b) return { paid: 0, contributed: 0, leftOwed: 0 };
  const members = (s.musicians || []).filter((m) => m.bandId === bandId && (m.owed || 0) > 0);
  const owedTotal = members.reduce((a, m) => a + m.owed, 0);
  if (owedTotal <= 0) return { paid: 0, contributed: 0, leftOwed: 0 };
  let contributed = 0;
  const short = Math.max(0, owedTotal - (b.account || 0));
  if (cover && short > 0 && walletBalance() >= short) { coverShortfall(b, bandId, short); contributed = short; }
  const budget = b.account || 0;
  const ratio = budget >= owedTotal ? 1 : (budget <= 0 ? 0 : budget / owedTotal);
  let paid = 0;
  for (const m of members) { const p = ratio >= 1 ? m.owed : Math.floor(m.owed * ratio); if (p > 0) { m.owed -= p; paid += p; } }
  if (paid > 0) { b.account -= paid; logTx({ account: bandId, band: bandId, amount: -paid, category: "payout", note: `Paid ${members.length} member${members.length > 1 ? "s" : ""}` }); }
  return { paid, contributed, leftOwed: members.reduce((a, m) => a + (m.owed || 0), 0) };
}

// Pay ONE musician what they're owed, from their band's account.
export function payMember(musicianId, cover) {
  const s = getState(); const m = (s.musicians || []).find((x) => x.id === musicianId);
  if (!m || (m.owed || 0) <= 0) return { paid: 0, contributed: 0, leftOwed: 0 };
  const b = bandById(m.bandId); if (!b) return { paid: 0, contributed: 0, leftOwed: m.owed };
  let contributed = 0;
  const short = Math.max(0, m.owed - (b.account || 0));
  if (cover && short > 0 && walletBalance() >= short) { coverShortfall(b, m.bandId, short); contributed = short; }
  const pay = Math.min(m.owed, b.account || 0);
  if (pay > 0) { m.owed -= pay; b.account -= pay; logTx({ account: m.bandId, band: m.bandId, amount: -pay, category: "payout", note: `Paid ${m.name}` }); }
  return { paid: pay, contributed, leftOwed: m.owed || 0 };
}

// Pay every band's members at once.
export function payPayroll(cover) {
  let paid = 0, contributed = 0, leftOwed = 0;
  for (const bs of payrollSummary()) { const r = payBand(bs.bandId, cover); paid += r.paid; contributed += r.contributed; leftOwed += r.leftOwed; }
  return { paid, contributed, leftOwed };
}

// ===================== Step 29: Career spine + regions =====================
// Per-band career ladder (fans + fame + shows played, with top tiers gated on
// regions mastered so the ladder can't be maxed without touring). Region access
// nests above venue rep: career tier -> region unlock -> regional fame -> mastery.
export function regionDef(id) { return ((DATA.regions && DATA.regions.regions) || {})[id] || null; }
export function cityDef(id) { return ((DATA.regions && DATA.regions.cities) || {})[id] || null; }
export function cityCluster(id) { const c = ((DATA.regions && DATA.regions.cities) || {})[id] || {}; return c.cluster || "home"; }
export function cityRegion(id) { const c = ((DATA.regions && DATA.regions.cities) || {})[id] || {}; return c.region || "midwest"; }
export function clusterDef(cid) { return ((DATA.regions && DATA.regions.clusters) || {})[cid] || { dayCost: 0 }; }
export function cityDayCost(id) { return clusterDef(cityCluster(id)).dayCost || 0; }
export function inHomeCircuit(id) { return cityDayCost(id) === 0; }
export function currentCity() { const s = getState(); return (s && s.currentCity) || "yourtown"; }
export function regionOfCity(cityId) { const c = cityDef(cityId); return c ? c.region : null; }

export function bandRegionalFame(bandId, regionId) { const s = getState(); return ((((s && s.regionalFame) || {})[bandId]) || {})[regionId] || 0; }
export function addBandRegionalFame(bandId, regionId, n) {
  if (!bandId || !regionId || !n) return;
  const s = getState(); if (!s) return;
  s.regionalFame = s.regionalFame || {};
  s.regionalFame[bandId] = s.regionalFame[bandId] || {};
  s.regionalFame[bandId][regionId] = Math.max(0, (s.regionalFame[bandId][regionId] || 0) + n);
}
function regionMasterNeed(regionId) {
  const r = regionDef(regionId);
  return (r && r.masterFame) || (DATA.config.career && DATA.config.career.regionMasterFameDefault) || 3000;
}
function regionsMasteredByBand(bandId) {
  const s = getState(); const rf = (((s && s.regionalFame) || {})[bandId]) || {};
  let n = 0; for (const rid in rf) if (rf[rid] >= regionMasterNeed(rid)) n++;
  return n;
}
// A region is "mastered" (for unlocking the next) if ANY of your bands hits its fame bar.
export function regionMastered(regionId) {
  const s = getState(); const rf = (s && s.regionalFame) || {};
  let best = 0; for (const bid in rf) best = Math.max(best, (rf[bid] || {})[regionId] || 0);
  return best >= regionMasterNeed(regionId);
}
export function regionUnlocked(regionId) {
  const r = regionDef(regionId); if (!r) return false;
  if (r.startUnlocked) return true;
  const u = r.unlock || {};
  if (u.type === "start") return true;
  if (u.type === "masterRegion") return regionMastered(u.region);
  if (u.type === "masterAllUS") return ["midwest", "east_coast", "west_coast"].every(regionMastered);
  return false;
}
export function cityUnlocked(cityId) {
  const c = cityDef(cityId); if (!c) return false;
  if (c.startUnlocked) return true;
  const s = getState(); if (s && s.flags && s.flags[cityId + "_unlocked"]) return true; // compat w/ existing flags (rocktroit)
  if (!regionUnlocked(c.region)) return false;
  return !!c.built; // Step 39: a built city in an unlocked region is reachable + bookable
}
export function cityTourEligible(cityId) {
  const c = cityDef(cityId); if (!c) return false;
  return !!c.tourEligible && cityUnlocked(cityId) && (c.built || c.bookableStub);
}

export function bandTier(band) {
  const tiers = (DATA.config.career && DATA.config.career.tiers) || [];
  const fans = (band && band.fans) || 0, fame = (band && band.fame) || 0, shows = (band && band.showsPlayed) || 0;
  const rm = band ? regionsMasteredByBand(band.id) : 0;
  let cur = tiers.length ? { ...tiers[0], index: 0 } : { name: "Local Act", index: 0 };
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (fans >= (t.minFans || 0) && fame >= (t.minFame || 0) && shows >= (t.minShows || 0) && rm >= (t.minRegionsMastered || 0)) cur = { ...t, index: i };
  }
  return cur;
}
function tierIndexByName(n) { const t = (DATA.config.career && DATA.config.career.tiers) || []; const i = t.findIndex((x) => x.name === n); return i < 0 ? 99 : i; }
export function careerStanding(band) {
  const tiers = (DATA.config.career && DATA.config.career.tiers) || [];
  const cur = bandTier(band); const nxt = tiers[cur.index + 1] || null;
  const fans = (band && band.fans) || 0, fame = (band && band.fame) || 0, shows = (band && band.showsPlayed) || 0;
  let toNext = null;
  if (nxt) toNext = {
    fans: Math.max(0, (nxt.minFans || 0) - fans), fame: Math.max(0, (nxt.minFame || 0) - fame),
    shows: Math.max(0, (nxt.minShows || 0) - shows), regions: Math.max(0, (nxt.minRegionsMastered || 0) - (band ? regionsMasteredByBand(band.id) : 0))
  };
  return { tier: cur.name, index: cur.index, fans, fame, shows, next: nxt ? nxt.name : null, toNext };
}

function milestoneMet(m, band) {
  if (m.type === "bandFans") return ((band && band.fans) || 0) >= m.value;
  if (m.type === "bandShows") return ((band && band.showsPlayed) || 0) >= m.value;
  if (m.type === "releases") { const s = getState(); return (s.releases || []).filter((r) => !band || r.bandId === band.id).length >= m.value; }
  if (m.type === "bandTier") return bandTier(band).index >= tierIndexByName(m.value);
  return false;
}
function applyMilestoneReward(r, band) {
  if (!r) return;
  if (r.money) addStat("money", r.money);
  if (r.fame) { if (band) band.fame = (band.fame || 0) + r.fame; else addStat("fame", r.fame); }
  if (r.fans) { if (band) band.fans = (band.fans || 0) + r.fans; else addStat("fans", r.fans); }
}
export function checkMilestones(band) {
  const ms = (DATA.config.career && DATA.config.career.milestones) || [];
  const s = getState(); if (!s) return [];
  s.milestones = s.milestones || {};
  const key = band ? band.id : "player";
  const got = (s.milestones[key] = s.milestones[key] || {});
  const newly = [];
  for (const m of ms) { if (got[m.id]) continue; if (milestoneMet(m, band)) { got[m.id] = (s.time && s.time.day) || 1; applyMilestoneReward(m.reward, band); newly.push(m); } }
  return newly;
}

// ===================== Step 30: Genre taxonomy =====================
// One canonical set of MAIN genres (logic reads only these) with sub-genres for
// flavor. mainGenre() normalizes any loose tag (sub, main name, district tag,
// legacy free-text) down to a main id so booking/fit/matching are reliable.
let _genreRev = null;
function genreRev() {
  if (_genreRev) return _genreRev;
  const g = (DATA.genres && DATA.genres.genres) || {};
  if (!Object.keys(g).length) return {};
  const m = {};
  const add = (k, id) => { if (!k) return; const lk = String(k).toLowerCase().trim(); if (!(lk in m)) m[lk] = id; const st = lk.replace(/[^a-z0-9]/g, ""); if (st && !(st in m)) m[st] = id; };
  for (const id in g) { add(id, id); add(g[id].name, id); (g[id].sub || []).forEach((s) => add(s, id)); }
  _genreRev = m; return m;
}
export function mainGenre(tag) { if (!tag) return null; const m = genreRev(); const lk = String(tag).toLowerCase().trim(); return m[lk] || m[lk.replace(/[^a-z0-9]/g, "")] || null; }
export function mainGenreName(id) { const g = (DATA.genres && DATA.genres.genres) || {}; const k = mainGenre(id) || id; return (g[k] && g[k].name) || (id || ""); }
export function genreList() { const g = (DATA.genres && DATA.genres.genres) || {}; const order = (DATA.genres && DATA.genres.order) || Object.keys(g); return order.filter((id) => g[id]).map((id) => ({ id, name: g[id].name, sub: g[id].sub || [] })); }
export function subgenresOf(id) { const k = mainGenre(id) || id; const g = (DATA.genres && DATA.genres.genres) || {}; return (g[k] && g[k].sub) || []; }
export function sameGenre(a, b) { const ma = mainGenre(a), mb = mainGenre(b); return !!ma && ma === mb; }
