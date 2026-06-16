// ============================================================
// shows.js — the show (Step 8): the payoff of the craft loop.
//
// Defines a SONG QUALITY score (content + band chemistry + member
// skill + gear fidelity) — the foundation the mogul loop will reuse
// for releases. Book a show at The Dive's stage, pick a setlist,
// and play: the crowd size scales with fame + chemistry, and your
// take (money / fame / fans) scales with quality. Gigging is how
// you clear the debt. Emits show:played.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat, activeBand, bandById, performingMembers, playerFame, liveCut, merchCut, accrueOwed, ensureContracts, bandEarn, payCoverRoyalty, addBuzz, townBuzz, relationshipDraw, ownerPayMult, gainShowRapport } from "../engine/state.js";
import { emit } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { advanceMinutes } from "./time.js";
import { findReady, nextCommitment, complete, slotLabel } from "./calendar.js";
import { deviceFidelity, instrumentQuality } from "./gear.js";
import { simulateSet, tierMult, memberStamina, playerStamina, playerEndurance, TIER_FLAVOR } from "./performance.js";
import { addCondition } from "./conditions.js";
import { bandTier, addBandRegionalFame, regionOfCity, checkMilestones } from "../engine/state.js";

let overlay = null, pendingShowCmt = null, perfBand = null, perfVenueId = "thedive";
let bookSource = "own", bookQuery = "", setlistModalOpen = false;

function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const songById = (id) => (getState().songs || []).find((s) => s.id === id) || null;

// ---- quality ----
function songGearQuality(song) {
  const pats = getState().patterns || [];
  const qs = [];
  (song.tracks || []).forEach((tr) => (tr || []).forEach((c) => {
    if (!c || !c.patternId) return;
    const p = pats.find((x) => x.id === c.patternId); if (!p) return;
    if (typeof p.gearQ === "number") qs.push(p.gearQ);              // stamped at record time
    else if (p.instrument) qs.push(instrumentQuality(p.instrument)); // legacy loop fallback
  }));
  if (!qs.length) return null;
  return qs.reduce((a, b) => a + b, 0) / qs.length;
}
export function songQuality(song, band) {
  if (!song) return 0;
  band = band || activeBand() || {};
  const tracks = song.tracks || [];
  const used = tracks.filter((t) => t && t.length).length;
  const clips = tracks.reduce((n, t) => n + (t ? t.length : 0), 0);
  const content = Math.min(1, (used / 4) * 0.6 + Math.min(1, clips / 8) * 0.4);
  const maxChem = DATA.config.band?.maxChemistry || 100;
  const chem = (band.chemistry || 0) / maxChem;
  const ps = DATA.config.band?.playerStats || { musicianship: 55, songwriting: 55 };
  const perf = (band.id ? performingMembers(band.id) : []).map((m) => ({ mus: m.stats?.musicianship || 0, wri: m.stats?.songwriting || 0 }));
  if (band.playerIn) perf.push({ mus: ps.musicianship || 55, wri: ps.songwriting || 55 });
  const skill = perf.length ? perf.reduce((a, x) => a + (0.6 * x.mus + 0.4 * x.wri) / 100, 0) / perf.length : 0;
  const fid = deviceFidelity();
  const gq = songGearQuality(song);
  const production = gq == null ? fid : (0.6 * fid + 0.4 * gq);   // recorder + instrument tier
  const q = 100 * (0.30 * content + 0.25 * chem + 0.20 * skill + 0.25 * production);
  return Math.round(Math.max(0, Math.min(100, q)));
}
function tierFlavor(q) {
  if (q < 40) return ["Rough night.", "Half the room kept talking. You got through it."];
  if (q < 65) return ["Decent set.", "A few heads nodding. Not bad for a dive."];
  if (q < 85) return ["The crowd was into it!", "Real applause. Someone bought your sticker."];
  return ["You tore the roof off.", "The whole room lost it. People are asking your name."];
}


// ---- venue registry (Step 15) ----
export function venueById(id) { return ((DATA.venues && DATA.venues.venues) || {})[id] || null; }
export function venueList() { const v = (DATA.venues && DATA.venues.venues) || {}; return Object.keys(v).map((id) => Object.assign({ id }, v[id])); }
export function venuesInTown(town) { return venueList().filter((v) => v.town === town); }
export function showsInTown(town) { return (getState().showsByTown || {})[town] || 0; }
// ---- venue reputation (Step 17.2) ----
export function venueRepOf(id) { return (getState().venueRep || {})[id] || 0; }
export function addVenueRep(id, d) { const s = getState(); s.venueRep = s.venueRep || {}; s.venueRep[id] = Math.max(0, Math.min(100, (s.venueRep[id] || 0) + d)); }
export function venueTier(id) { const r = venueRepOf(id); const tiers = (DATA.config.venueRep && DATA.config.venueRep.tiers) || [{ min: 0, name: "Newcomer", pay: 0 }]; let t = tiers[0]; for (const x of tiers) if (r >= x.min) t = x; return t; }
export function venueRepPayMult(id) { return 1 + (venueTier(id).pay || 0); }
export function townRep(town) { const vs = (DATA.venues && DATA.venues.venues) || {}; let m = 0; for (const k in vs) if (vs[k].town === town) m = Math.max(m, venueRepOf(k)); return m; }
export function venueStanding(id) { const t = venueTier(id); return { name: t.name, rep: venueRepOf(id), payBonus: Math.round((t.pay || 0) * 100) }; }
export function venueEligible(id) {
  const v = venueById(id); if (!v) return false; if (v.open) return true;
  if (v.genreLock && v.genre) { const b = activeBand(); if (!b || String(b.genre || "").toLowerCase() !== String(v.genre).toLowerCase()) return false; } // hard genre gate (e.g. Pokeville saloon)
  const s = getState(); const r = v.req || {};
  const rc = DATA.config.venueRep || {};
  if (townRep(v.town) >= (rc.unlockTownRep || 50)) return true;   // earned your way in
  if (r.minFame && (s.stats.fame || 0) < r.minFame) return false;
  if (r.minFans && (s.stats.fans || 0) < r.minFans) return false;
  if (r.minReleases && (s.releases || []).length < r.minReleases) return false;
  if (r.showsInTown && showsInTown(v.town) < r.showsInTown) return false;
  if (r.minBuzz && townBuzz(v.town) < r.minBuzz) return false;
  return true;
}
export function venueReqText(id) {
  const v = venueById(id); if (!v) return ""; if (v.open) return "Open mic — any band with a demo can play.";
  const s = getState(); const r = v.req || {}; const p = [];
  if (v.genreLock && v.genre) { const b = activeBand(); const ok = b && String(b.genre || "").toLowerCase() === String(v.genre).toLowerCase(); if (!ok) p.push(`${v.genre}-only stage (your act isn't ${v.genre})`); }
  if (r.minReleases) p.push(`${(s.releases || []).length}/${r.minReleases} releases`);
  if (r.minFans) p.push(`${s.stats.fans || 0}/${r.minFans} fans`);
  if (r.minFame) p.push(`${s.stats.fame || 0}/${r.minFame} fame`);
  if (r.showsInTown) p.push(`${showsInTown(v.town)}/${r.showsInTown} shows in town`);
  if (r.minBuzz) p.push(`${townBuzz(v.town)}/${r.minBuzz} buzz`);
  const rc = DATA.config.venueRep || {}; const tr = townRep(v.town); const need = rc.unlockTownRep || 50;
  return "Requires " + p.join(" · ") + ` — or earn it: town standing ${tr}/${need}`;
}

// ---- booking ----
export function openPerform(venueId = "thedive") {
  const s = getState();
  perfVenueId = venueId;
  const ready = findReady("show", null, venueId);
  if (!ready) {
    const nx = nextCommitment("show");
    toast(nx ? `No show booked here right now. Next: Day ${nx.day}, ${slotLabel(nx.slot)}.` : "No show booked here. Book one in the BAND app.", "info");
    return;
  }
  perfBand = bandById(ready.bandId) || activeBand() || {};
  if (!(perfBand.playerIn) && !performingMembers(perfBand.id).length) { toast("You booked a show with no band?!", "warn"); return; }
  if (!(s.songs || []).length) { toast("A gig and no songs. Awkward.", "warn"); return; }
  pendingShowCmt = ready.id;
  overlay = overlay || document.getElementById("show");
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => overlay.classList.add("open"));
  document.body.classList.add("modal-open");
  bookSource = "own"; bookQuery = ""; setlistModalOpen = false;
  renderBooking(new Set([perfBand.pressKit?.songId].filter(Boolean)));
}
export function closeShow() {
  overlay.classList.remove("open");
  document.body.classList.remove("modal-open");
  setTimeout(() => overlay.classList.add("hidden"), 200);
}

function showBuffMult() {          // Step 27.3: Fresh/Primped (any condition w/ showDrawMult) lift the crowd
  const s = getState(); let m = 1;
  for (const c of (s && s.conditions) || []) {
    const d = DATA.conditions && DATA.conditions.conditions && DATA.conditions.conditions[c.id];
    if (d && d.showDrawMult) m *= d.showDrawMult;
  }
  return m;
}
// Build the list of performers (NPC members + the player) with their stamina pools.
function buildPerformers(band) {
  const performers = [];
  const mem = band && band.id ? performingMembers(band.id) : [];
  for (const m of mem) performers.push({ name: m.name, max: memberStamina(m), isPlayer: false });
  if (band && band.playerIn) performers.push({ name: "You", max: playerStamina(), isPlayer: true });
  if (!performers.length) performers.push({ name: "You", max: playerStamina(), isPlayer: true });
  return performers;
}

// estimate, now Performance-Arc aware. roll=false -> deterministic projection for the
// booking planner; roll=true -> actually gambles collapse rolls for the live show.
function estimateWithSim(setIds, band, venueId, roll) {
  band = band || perfBand || activeBand() || {};
  const cfg = DATA.config.shows;
  const vId = venueId || perfVenueId;
  const ids = [...setIds];
  const mem = band.id ? performingMembers(band.id) : [];
  const starPower = mem.reduce((a, m) => a + (m.fame || 0), 0) + (band.playerIn ? playerFame() : 0);
  const vRec = (DATA.venues && DATA.venues.venues && DATA.venues.venues[vId]) || {};
  const vm = vRec.drawMult || 1; const pm = vRec.payMult || 1; const relMult = relationshipDraw(vRec.town);
  const draw = Math.round(((cfg.baseAudience || 8) + (band.fame || 0) * (cfg.fameDrawFactor || 0.5) + starPower * (cfg.starDrawFactor || 0.4) + (band.chemistry || 0) / (cfg.chemDrawDiv || 20)) * vm * relMult * showBuffMult());
  const songs = ids.map((id) => { const sg = songById(id); return { q: Math.max(0, songQuality(sg, band)), bars: (sg && sg.lengthBars) || null }; });
  const baseQ = songs.length ? Math.round(songs.reduce((a, b) => a + b.q, 0) / songs.length) : 0;
  const sim = simulateSet({ songs, performers: buildPerformers(band), setGenre: band.genre, venuePref: vRec.preferredGenre, roll: !!roll });
  const tm = tierMult(sim.tier);
  const realizedQ = sim.realizedQ;
  const playedN = sim.collapsed ? sim.playedCount : ids.length;
  const qf = 0.4 + 0.6 * (realizedQ / 100);
  const lengthFactor = 1 + 0.15 * Math.max(0, playedN - 1);
  const pay = Math.round(draw * (cfg.payPerHead || 2) * qf * lengthFactor * venueRepPayMult(vId) * pm * ownerPayMult(vId) * (tm.pay == null ? 1 : tm.pay));
  const fans = Math.max(0, Math.round(draw * (realizedQ / 100) * 0.6 * (tm.fans == null ? 1 : tm.fans)));
  const fameGain = Math.max(1, Math.round((2 + realizedQ / 20 + draw * 0.1) * (tm.fame == null ? 1 : tm.fame)));
  return { draw, avgQ: realizedQ, baseQ, pay, fans, fameGain, sim, tier: sim.tier, repDelta: tm.rep };
}
function estimate(setIds, band, venueId) { return estimateWithSim(setIds, band, venueId, false); }
function showBuzz(est) { return Math.max(1, Math.round(2 + (est.draw || 0) * 0.2 + Math.max(0, (est.avgQ || 0) - 50) * 0.04)); }

function releaseOf(songId) { return (getState().releases || []).find((r) => (r.songIds || []).includes(songId)) || null; }
function songOwnerBandId(songId) { const r = releaseOf(songId); return r ? r.bandId : null; }
function bandNameOf(id) { const b = bandById(id); return b ? (b.name || "Unknown") : "Unknown"; }

function bookSongList() {
  const all = getState().songs || [];
  const q = bookQuery.trim().toLowerCase();
  const pid = perfBand && perfBand.id;
  return all.filter((sg) => {
    const owner = songOwnerBandId(sg.id);
    if (bookSource === "covers") { if (!owner || owner === pid) return false; }
    else { if (owner && owner !== pid) return false; }
    if (q && !((sg.name || "").toLowerCase().includes(q))) return false;
    return true;
  });
}
function setlistModalHTML() {
  const saved = getState().setlists || [];
  const last = (perfBand && perfBand.lastSetlist) || [];
  const rows = saved.length
    ? saved.map((sl) => `<div class="set-saved-row"><button class="set-load" data-load="${sl.id}">${esc(sl.name)} <span class="muted">(${(sl.songIds || []).length})</span></button><button class="set-del" data-del="${sl.id}" title="Delete">✕</button></div>`).join("")
    : `<p class="muted" style="padding:8px">No saved setlists yet. Pick songs, then tap “Save set.”</p>`;
  return `<div class="set-modal-scrim" id="set-modal-scrim"><div class="set-modal">
      <div class="shop-head"><span class="shop-title">CHOOSE SETLIST</span><button class="phone-nav" id="set-modal-close">✕</button></div>
      <div class="set-modal-body">
        ${last.length ? `<button class="set-load" id="set-modal-last">↺ Use last set <span class="muted">(${last.length})</span></button>` : ""}
        ${rows}
      </div>
    </div></div>`;
}

function plannerHTML(est) {
  const sim = est && est.sim; if (!sim) return "";
  const n = sim.perSong.length;
  const pips = sim.perSong.map((e) => {
    const cls = e.state === "collapse" ? "pp-collapse" : e.state === "risk" ? "pp-risk" : e.state === "sloppy" ? "pp-sloppy" : "pp-strong";
    const lbl = e.state === "collapse" ? "\u2715" : e.state === "risk" ? `${e.collapseChance}%` : (e.i + 1);
    return `<span class="set-pip ${cls}" title="Song ${e.i + 1}: ${e.state}${e.state === "risk" ? ` \u00b7 ${e.collapseChance}% collapse` : ""}">${lbl}</span>`;
  }).join("");
  const firstRisk = sim.perSong.find((e) => e.state === "risk" || e.state === "collapse");
  let warn;
  if (sim.collapsed) warn = `<div class="set-warn bad">\u26a0 At your current energy you'll likely collapse around song ${sim.collapsedAt + 1}. Trim the set or rest up first.</div>`;
  else if (firstRisk) warn = `<div class="set-warn warn">\u26a0 Danger zone from song ${firstRisk.i + 1} (${firstRisk.collapseChance}% collapse). Pull it off for a bigger payoff.</div>`;
  else if (n > sim.safeLimit) warn = `<div class="set-warn warn">Songs past ${sim.safeLimit} get sloppy as you tire.</div>`;
  else warn = `<div class="set-warn ok">Safe set \u2014 you've got gas for all ${n}.</div>`;
  return `<div class="set-planner">
    <div class="set-planner-top"><span>Set plan · endurance ${Math.round(playerEndurance())}</span><span class="tier-badge tier-${(est.tier || "").toLowerCase()}">${est.tier || ""}</span></div>
    <div class="set-pips">${pips || `<span class="muted">Pick songs to see the plan.</span>`}</div>
    ${warn}
  </div>`;
}

function renderBooking(selected) {
  const est = estimate(selected, perfBand);
  const _sl = overlay.querySelector(".set-list"); const _sly = _sl ? _sl.scrollTop : 0;
  const list = bookSongList();
  const saved = getState().setlists || [];
  const last = (perfBand && perfBand.lastSetlist) || [];
  overlay.innerHTML = `
    <div class="show-modal">
      <div class="shop-head"><span class="shop-title">BOOK A SHOW</span><button class="phone-nav" id="show-close">✕</button></div>
      <div class="show-body">
        <div class="set-src">
          <button class="set-srcbtn ${bookSource === "own" ? "on" : ""}" data-src="own">${esc((perfBand && perfBand.name) || "Our")} songs</button>
          <button class="set-srcbtn ${bookSource === "covers" ? "on" : ""}" data-src="covers">Covers</button>
        </div>
        <input id="book-search" class="bank-search" type="text" placeholder="Search songs…" value="${esc(bookQuery)}" autocapitalize="off">
        <div class="set-tools">
          <button class="set-tool" id="set-choose">📋 Setlists${saved.length ? ` (${saved.length})` : ""}</button>
          <button class="set-tool" id="set-save" ${selected.size ? "" : "disabled"}>＋ Save set</button>
        </div>
        <div class="set-list">
          ${list.length ? list.map((sg) => {
            const on = selected.has(sg.id);
            const owner = songOwnerBandId(sg.id);
            const tag = bookSource === "covers" ? `cover · ${esc(bandNameOf(owner))}` : (owner ? "released" : "demo");
            return `<label class="set-row ${on ? "on" : ""}"><input type="checkbox" data-song="${sg.id}" ${on ? "checked" : ""}>
              <span class="set-name">${esc(sg.name)}</span><span class="set-q">${tag} · Q ${songQuality(sg, perfBand)}</span></label>`;
          }).join("") : `<p class="muted" style="padding:8px">${bookSource === "covers" ? "No released songs by other acts yet." : "No songs here yet — make one in the DAW."}</p>`}
        </div>
        <div class="show-est">
          <div><span>Expected crowd</span><strong>${est.draw}</strong></div>
          <div><span>Set quality</span><strong>${est.avgQ}</strong></div>
          <div><span>Est. take</span><strong class="good">$${est.pay}</strong></div>
          <div><span>Band fame / fans</span><strong>+${est.fameGain} / +${est.fans}</strong></div>
        </div>
        ${plannerHTML(est)}
        <button class="btn show-go" id="show-go" ${selected.size ? "" : "disabled"}>▶ PLAY THE SHOW (${selected.size})</button>
      </div>
    </div>
    ${setlistModalOpen ? setlistModalHTML() : ""}`;
  overlay.querySelector("#show-close").addEventListener("click", closeShow);
  const _nsl = overlay.querySelector(".set-list"); if (_nsl) _nsl.scrollTop = _sly;
  overlay.querySelectorAll("[data-song]").forEach((cb) => cb.addEventListener("change", () => {
    cb.checked ? selected.add(cb.dataset.song) : selected.delete(cb.dataset.song);
    const row = cb.closest(".set-row"); if (row) row.classList.toggle("on", cb.checked);
    updateBookEst(selected);
  }));
  overlay.querySelectorAll("[data-src]").forEach((b) => b.addEventListener("click", () => { bookSource = b.dataset.src; renderBooking(selected); }));
  const search = overlay.querySelector("#book-search");
  if (search) search.addEventListener("input", () => { bookQuery = search.value; renderBooking(selected); requestAnimationFrame(() => { const n = overlay.querySelector("#book-search"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); });
  const chooseBtn = overlay.querySelector("#set-choose");
  if (chooseBtn) chooseBtn.addEventListener("click", () => { setlistModalOpen = true; renderBooking(selected); });
  const saveBtn = overlay.querySelector("#set-save");
  if (saveBtn) saveBtn.addEventListener("click", () => {
    if (!selected.size) return;
    const name = (prompt("Name this setlist:", `Set ${(getState().setlists || []).length + 1}`) || "").trim();
    if (!name) return;
    const st = getState(); st.setlists = st.setlists || [];
    st.setlists.push({ id: "set_" + Date.now().toString(36), name, songIds: [...selected], savedDay: st.time?.day || 1 });
    persist(); toast(`Saved setlist “${name}.”`, "good"); renderBooking(selected);
  });
  const mClose = overlay.querySelector("#set-modal-close");
  if (mClose) mClose.addEventListener("click", () => { setlistModalOpen = false; renderBooking(selected); });
  const mScrim = overlay.querySelector("#set-modal-scrim");
  if (mScrim) mScrim.addEventListener("click", (e) => { if (e.target === mScrim) { setlistModalOpen = false; renderBooking(selected); } });
  const mLast = overlay.querySelector("#set-modal-last");
  if (mLast) mLast.addEventListener("click", () => { const ns = new Set((perfBand.lastSetlist || []).filter((id) => (getState().songs || []).some((sg) => sg.id === id))); setlistModalOpen = false; renderBooking(ns); });
  overlay.querySelectorAll("[data-load]").forEach((b) => b.addEventListener("click", () => {
    const sl = (getState().setlists || []).find((x) => x.id === b.dataset.load); if (!sl) return;
    const ns = new Set((sl.songIds || []).filter((id) => (getState().songs || []).some((sg) => sg.id === id)));
    setlistModalOpen = false; renderBooking(ns);
  }));
  overlay.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const st = getState(); st.setlists = (st.setlists || []).filter((x) => x.id !== b.dataset.del); persist(); renderBooking(selected);
  }));
  const go = overlay.querySelector("#show-go");
  if (go) go.addEventListener("click", () => playShow([...selected]));
}

function updateBookEst(selected) {
  const est = estimate(selected, perfBand);
  const e = overlay.querySelector(".show-est");
  if (e) e.innerHTML = `
    <div><span>Expected crowd</span><strong>${est.draw}</strong></div>
    <div><span>Set quality</span><strong>${est.avgQ}</strong></div>
    <div><span>Est. take</span><strong class="good">$${est.pay}</strong></div>
    <div><span>Band fame / fans</span><strong>+${est.fameGain} / +${est.fans}</strong></div>`;
  const pl = overlay.querySelector(".set-planner"); if (pl) pl.outerHTML = plannerHTML(est); else { const e2 = overlay.querySelector(".show-est"); if (e2) e2.insertAdjacentHTML("afterend", plannerHTML(est)); }
  const go = overlay.querySelector("#show-go"); if (go) { go.disabled = !selected.size; go.textContent = `▶ PLAY THE SHOW (${selected.size})`; }
  const sv = overlay.querySelector("#set-save"); if (sv) sv.disabled = !selected.size;
}

// ---- play ----
// ---- merch sales at a show (Step 17.0) ----
function sellMerchAtShow(band, audience) {
  const cfg = (DATA.config && DATA.config.merch) || {};
  const types = cfg.types || [];
  const inv = band.merch || {};
  const fans = band.fans || 0;
  let revenue = 0; const lines = [];
  for (const t of types) {
    const slot = inv[t.id]; if (!slot || !slot.stock) continue;
    const price = slot.price || t.basePrice || 1;
    const priceFactor = Math.pow((t.basePrice || price) / price, cfg.priceElastic || 0.6);
    const demand = audience * (cfg.saleRateBase || 0.18) * (t.appeal || 1) * priceFactor + fans * (cfg.fanFactor || 0.00015) * (t.appeal || 1);
    const sold = Math.max(0, Math.min(slot.stock, Math.round(demand)));
    if (sold > 0) { slot.stock -= sold; const rev = sold * price; revenue += rev; lines.push({ name: t.name, sold, rev }); }
  }
  return { revenue: Math.round(revenue), lines };
}

function playShow(setIds) {
  if (!setIds.length) return;
  const s = getState(); const cfg = DATA.config.shows;
  const band = perfBand || activeBand() || {};
  const _tierBefore = band && band.id ? bandTier(band).name : null;
  if (band && band.id) band.lastSetlist = [...setIds];
  const est = estimateWithSim(new Set(setIds), band, undefined, true);
  const playedN = est.sim.collapsed ? est.sim.playedCount : setIds.length;
  if (!band.playerIn) { const bst = cfg.attendBoost || 1.15; est.pay = Math.round(est.pay * bst); est.fans = Math.round(est.fans * bst); est.fameGain = Math.round(est.fameGain * bst); est._boosted = bst; }
  const energy = (cfg.energyCost || 25) + Math.max(0, playedN - 1) * 5;
  const minutes = (cfg.minutes || 180) + Math.max(0, playedN - 1) * 20;

  bandEarn(band.id, est.pay, "show", "Show pay");
  const perSongPay = setIds.length ? est.pay / setIds.length : 0;
  const coverPaid = [];
  for (const sid of setIds) { const cr = payCoverRoyalty(band.id, sid, perSongPay); if (cr) coverPaid.push(cr); }
  const coverTotal = coverPaid.reduce((a, c) => a + c.royalty, 0);
  addBuzz((venueById(perfVenueId) || {}).town, showBuzz(est));
  gainShowRapport((venueById(perfVenueId) || {}).town, 2);
  { const st = getState(); st.stats.showsPlayed = (st.stats.showsPlayed || 0) + 1; }
  const merch = sellMerchAtShow(band, est.draw);
  if (merch.revenue > 0) { bandEarn(band.id, merch.revenue, "merch", "Merch sales at show"); band.merchSold = (band.merchSold || 0) + merch.revenue; }
  if (est.sim.collapsed) { const col = (DATA.config.performance && DATA.config.performance.collapse) || {}; addStat("health", -(col.healthHit || 12)); addStat("mood", -(col.moodHit || 10)); addCondition("exhausted"); }
  else addStat("mood", cfg.moodGain || 8);
  addStat("energy", -energy);
  const maxChem = DATA.config.band?.maxChemistry || 100;
  // per-band identity grows
  band.fans = (band.fans || 0) + est.fans;
  band.fame = (band.fame || 0) + est.fameGain;
  band.chemistry = Math.min(maxChem, (band.chemistry || 0) + (cfg.chemistryGain || 5));
  band.showsPlayed = (band.showsPlayed || 0) + 1;
  const _town = (DATA.venues && DATA.venues.venues && DATA.venues.venues[perfVenueId] && DATA.venues.venues[perfVenueId].town);
  if (_town) { s.showsByTown = s.showsByTown || {}; s.showsByTown[_town] = (s.showsByTown[_town] || 0) + 1; }
  addVenueRep(perfVenueId, est.repDelta != null ? est.repDelta : 1);
  // player's personal clout (career-wide, smaller)
  addStat("fame", Math.max(1, Math.round(est.fameGain * (cfg.playerFameShare ?? 0.4))));
  addStat("fans", Math.round(est.fans * (cfg.playerFansShare ?? 0.25)));
  // each performing musician gains individual fame + accrues their contracted cut (live + merch)
  ensureContracts();
  const cutLines = []; let cutTotal = 0;
  for (const m of performingMembers(band.id)) {
    m.fame = (m.fame || 0) + Math.max(1, Math.round(est.fameGain * (cfg.memberFameShare ?? 0.3)));
    const cut = liveCut(m, est.pay) + merchCut(m, merch.revenue);
    if (cut > 0) { accrueOwed(m, cut); cutLines.push({ name: m.name, cut }); cutTotal += cut; }
  }
  // Step 29: regional fame accrual + career progression detection
  if (band.id) {
    const _city = DATA.venues && DATA.venues.venues && DATA.venues.venues[perfVenueId] && DATA.venues.venues[perfVenueId].town;
    const _region = _city ? regionOfCity(_city) : null;
    if (_region) addBandRegionalFame(band.id, _region, est.fameGain);
    const _tierAfter = bandTier(band).name;
    if (_tierBefore && _tierAfter !== _tierBefore) toast(`\u25B2 ${band.name || "Your band"} leveled up \u2014 now a ${_tierAfter}!`, "good");
    for (const ms of checkMilestones(band)) toast(`\u2605 Milestone: ${ms.name}${ms.reward && ms.reward.money ? ` (+$${ms.reward.money})` : ""}`, "good");
  }
  // Performance Arc: gigging builds Endurance; pushing past your safe limit trains it harder.
  let endGain = 0;
  { const pc = DATA.config.performance || {}; const pushF = 1 + 0.3 * Math.max(0, playedN - (est.sim.safeLimit || 0));
    endGain = (pc.enduranceGrowthPerShow || 0.6) * pushF;
    if (s && s.stats) s.stats.endurance = Math.min(100, Math.round(((s.stats.endurance || 50) + endGain) * 10) / 10);
    for (const m of performingMembers(band.id)) { if (m.stats) m.stats.endurance = Math.min(100, Math.round(((m.stats.endurance || 50) + endGain * 0.5) * 10) / 10); } }
  advanceMinutes(minutes);
  persist();
  if (pendingShowCmt) { complete(pendingShowCmt); pendingShowCmt = null; }
  emit("show:played", { bandId: band.id, pay: est.pay, merch: merch.revenue, fame: est.fameGain, fans: est.fans, quality: est.avgQ, tier: est.tier, collapsed: est.sim.collapsed });
  emit("renderAll");

  const head = est.sim.collapsed ? "Cut Short" : est.tier;
  const sub = TIER_FLAVOR[est.tier] || "";
  overlay.innerHTML = `
    <div class="show-modal">
      <div class="shop-head"><span class="shop-title">SHOW REPORT</span><button class="phone-nav" id="show-close2">✕</button></div>
      <div class="show-body show-report">
        <div class="report-head">${esc(head)}</div>
        <p class="shop-note">${esc(sub)}</p>
        ${est._boosted ? `<p class="shop-note" style="color:var(--green)">You showed up to manage — the band raised their game (+${Math.round((est._boosted - 1) * 100)}%).</p>` : ""}
        <p class="shop-note">Played ${playedN} of ${setIds.length} song${setIds.length !== 1 ? "s" : ""}.${endGain > 0 ? ` Endurance +${endGain.toFixed(1)}.` : ""}</p>
        <div class="show-est">
          <div><span>Crowd</span><strong>${est.draw}</strong></div>
          <div><span>Earned</span><strong class="good">$${est.pay}</strong></div>
          ${merch.revenue > 0 ? `<div><span>Merch</span><strong class="good">$${merch.revenue}</strong></div>` : ""}
          <div><span>Fame</span><strong>+${est.fameGain}</strong></div>
          <div><span>New fans</span><strong>+${est.fans}</strong></div>
        </div>
        ${coverTotal > 0 ? `<div class="show-cuts">
          <div class="show-cuts-h">Cover royalties paid to original artists</div>
          ${coverPaid.map((c) => `<div><span>${esc(c.title)} <span class="muted">· ${esc(c.owner)}</span></span><strong class="bad">$${c.royalty}</strong></div>`).join("")}
          <div class="show-cuts-total"><span>Royalties off the top</span><strong class="bad">$${coverTotal}</strong></div>
        </div>` : ""}
        ${cutLines.length ? `<div class="show-cuts">
          <div class="show-cuts-h">Band's cut — added to what you owe</div>
          ${cutLines.map((c) => `<div><span>${esc(c.name)}</span><strong>$${c.cut}</strong></div>`).join("")}
          <div class="show-cuts-total"><span>Owed this show</span><strong class="bad">$${cutTotal}</strong></div>
          <p class="shop-note" style="margin-top:6px">${esc(band.name || "The band")} banked $${est.pay + merch.revenue} into its account; settle up on Payday.</p>
        </div>` : ""}
        <button class="btn" id="show-done">Done</button>
      </div>
    </div>`;
  overlay.querySelector("#show-close2").addEventListener("click", closeShow);
  overlay.querySelector("#show-done").addEventListener("click", closeShow);
  toast(est.sim.collapsed ? `${TIER_FLAVOR.Collapse} You still earned $${est.pay}.` : `${est.tier} show — $${est.pay}${merch.revenue > 0 ? ` +$${merch.revenue} merch` : ""}, +${est.fans} fans${cutTotal > 0 ? ` · $${cutTotal} owed` : ""}.`, est.sim.collapsed ? "warn" : "good");
}

// ============================================================
// Delegated auto-resolve (Step 18.3) — bands the player ISN'T in
// play their booked nights on their own. Same money/fame/fans/
// merch/owed/venue-rep as a real gig, minus the player's personal
// energy/time/clout (they weren't on stage). Called from the
// calendar's day-advance sweep.
// ============================================================
function autoSetlist(band) {
  const s = getState();
  const relIds = new Set();
  (s.releases || []).filter((r) => r.bandId === band.id).forEach((r) => (r.songIds || []).forEach((id) => relIds.add(id)));
  let pool = (s.songs || []).filter((sg) => relIds.has(sg.id));
  if (!pool.length) pool = (s.songs || []).filter((sg) => sg.bandId === band.id);
  if (!pool.length) pool = (s.songs || []).slice();
  pool = pool.sort((a, b) => songQuality(b, band) - songQuality(a, band)).slice(0, 3);
  return pool.map((sg) => sg.id);
}

export function autoResolveShow(commitment) {
  const s = getState(); const cfg = DATA.config.shows;
  const band = bandById(commitment.bandId); if (!band) return null;
  const venueId = commitment.venue || "thedive";
  const setIds = autoSetlist(band); if (!setIds.length) return null;
  const est = estimate(new Set(setIds), band, venueId);
  bandEarn(band.id, est.pay, "show", "Show pay");
  const perSongPay = setIds.length ? est.pay / setIds.length : 0;
  for (const sid of setIds) payCoverRoyalty(band.id, sid, perSongPay);
  addBuzz((venueById(venueId) || {}).town, showBuzz(est));
  const merch = sellMerchAtShow(band, est.draw);
  if (merch.revenue > 0) { bandEarn(band.id, merch.revenue, "merch", "Merch sales at show"); band.merchSold = (band.merchSold || 0) + merch.revenue; }
  const maxChem = (DATA.config.band && DATA.config.band.maxChemistry) || 100;
  band.fans = (band.fans || 0) + est.fans;
  band.fame = (band.fame || 0) + est.fameGain;
  band.chemistry = Math.min(maxChem, (band.chemistry || 0) + (cfg.chemistryGain || 5));
  band.showsPlayed = (band.showsPlayed || 0) + 1;
  const vmeta = (DATA.venues && DATA.venues.venues && DATA.venues.venues[venueId]) || null;
  if (vmeta && vmeta.town) { s.showsByTown = s.showsByTown || {}; s.showsByTown[vmeta.town] = (s.showsByTown[vmeta.town] || 0) + 1; }
  const repGain = Math.max(-2, (DATA.config.venueRep && DATA.config.venueRep.gainBase != null ? DATA.config.venueRep.gainBase : 2) + Math.round((est.avgQ - 60) / 12));
  addVenueRep(venueId, repGain);
  ensureContracts();
  const cutLines = []; let cutTotal = 0;
  for (const m of performingMembers(band.id)) {
    m.fame = (m.fame || 0) + Math.max(1, Math.round(est.fameGain * (cfg.memberFameShare ?? 0.3)));
    const cut = liveCut(m, est.pay) + merchCut(m, merch.revenue);
    if (cut > 0) { accrueOwed(m, cut); cutLines.push({ name: m.name, cut }); cutTotal += cut; }
  }
  emit("show:played", { bandId: band.id, pay: est.pay, merch: merch.revenue, fame: est.fameGain, fans: est.fans, quality: est.avgQ, auto: true });
  return { band: band.name || "Your band", venue: (vmeta && vmeta.name) || "a venue", pay: est.pay, merch: merch.revenue, fans: est.fans, fame: est.fameGain, quality: est.avgQ, cutTotal };
}

export function showAutoReport(results) {
  if (!results || !results.length) return;
  const rows = results.map((r) => `<div class="ar-row">
    <div class="ar-h"><strong>${esc(r.band)}</strong><small>@ ${esc(r.venue)} · Q${r.quality}</small></div>
    <div class="ar-stats"><span class="good">$${r.pay}${r.merch ? " +$" + r.merch + " merch" : ""}</span><span>+${r.fans} fans</span><span>+${r.fame} fame</span></div>
    ${r.cutTotal ? `<div class="ar-owed">$${r.cutTotal} owed to the band</div>` : ""}
  </div>`).join("");
  const scrim = document.createElement("div"); scrim.className = "modal-scrim"; scrim.id = "ar-scrim";
  scrim.innerHTML = `<div class="neg-card ar-card">
    <div class="neg-head"><span>WHILE YOU WERE OUT</span><button id="ar-x">\u2715</button></div>
    <p class="neg-ask">Your other acts played their booked nights without you. The gross went into each band's account; settle their cut on Payday.</p>
    ${rows}
    <div class="neg-acts"><button class="btn" id="ar-ok">Nice</button></div>
  </div>`;
  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
  scrim.querySelector("#ar-x").addEventListener("click", close);
  scrim.querySelector("#ar-ok").addEventListener("click", close);
}
