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
import { getState, addStat, activeBand, bandById, performingMembers, playerFame, liveCut, merchCut, accrueOwed, ensureContracts, bandEarn } from "../engine/state.js";
import { emit } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { advanceMinutes } from "./time.js";
import { findReady, nextCommitment, complete, slotLabel } from "./calendar.js";
import { deviceFidelity, instrumentQuality } from "./gear.js";

let overlay = null, pendingShowCmt = null, perfBand = null, perfVenueId = "thedive";

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
  const s = getState(); const r = v.req || {};
  const rc = DATA.config.venueRep || {};
  if (townRep(v.town) >= (rc.unlockTownRep || 50)) return true;   // earned your way in
  if (r.minFame && (s.stats.fame || 0) < r.minFame) return false;
  if (r.minFans && (s.stats.fans || 0) < r.minFans) return false;
  if (r.minReleases && (s.releases || []).length < r.minReleases) return false;
  if (r.showsInTown && showsInTown(v.town) < r.showsInTown) return false;
  return true;
}
export function venueReqText(id) {
  const v = venueById(id); if (!v) return ""; if (v.open) return "Open mic — any band with a demo can play.";
  const s = getState(); const r = v.req || {}; const p = [];
  if (r.minReleases) p.push(`${(s.releases || []).length}/${r.minReleases} releases`);
  if (r.minFans) p.push(`${s.stats.fans || 0}/${r.minFans} fans`);
  if (r.minFame) p.push(`${s.stats.fame || 0}/${r.minFame} fame`);
  if (r.showsInTown) p.push(`${showsInTown(v.town)}/${r.showsInTown} shows in town`);
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
  renderBooking(new Set([perfBand.pressKit?.songId].filter(Boolean)));
}
export function closeShow() {
  overlay.classList.remove("open");
  document.body.classList.remove("modal-open");
  setTimeout(() => overlay.classList.add("hidden"), 200);
}

function estimate(setIds, band, venueId) {
  band = band || perfBand || activeBand() || {};
  const cfg = DATA.config.shows;
  const vId = venueId || perfVenueId;
  const mem = band.id ? performingMembers(band.id) : [];
  const starPower = mem.reduce((a, m) => a + (m.fame || 0), 0) + (band.playerIn ? playerFame() : 0);
  const vm = (DATA.venues && DATA.venues.venues && DATA.venues.venues[vId] && DATA.venues.venues[vId].drawMult) || 1;
  const draw = Math.round(((cfg.baseAudience || 8) + (band.fame || 0) * (cfg.fameDrawFactor || 0.5) + starPower * (cfg.starDrawFactor || 0.4) + (band.chemistry || 0) / (cfg.chemDrawDiv || 20)) * vm);
  const qs = [...setIds].map((id) => songQuality(songById(id), band)).filter((n) => n >= 0);
  const avgQ = qs.length ? qs.reduce((a, b) => a + b, 0) / qs.length : 0;
  const qf = 0.4 + 0.6 * (avgQ / 100);
  const lengthFactor = 1 + 0.15 * Math.max(0, setIds.size - 1);
  const pay = Math.round(draw * (cfg.payPerHead || 2) * qf * lengthFactor * venueRepPayMult(vId));
  const fans = Math.max(0, Math.round(draw * (avgQ / 100) * 0.6));
  const fameGain = Math.max(1, Math.round(2 + avgQ / 20 + draw * 0.1));
  return { draw, avgQ: Math.round(avgQ), pay, fans, fameGain };
}

function renderBooking(selected) {
  const s = getState(); const songs = s.songs || [];
  const est = estimate(selected, perfBand);
  const _sl = overlay.querySelector(".set-list"); const _sly = _sl ? _sl.scrollTop : 0;
  overlay.innerHTML = `
    <div class="show-modal">
      <div class="shop-head"><span class="shop-title">BOOK A SHOW</span><button class="phone-nav" id="show-close">✕</button></div>
      <div class="show-body">
        <p class="shop-note">Pick your setlist. Bigger sets pull a little more, but cost more energy and time.</p>
        <div class="show-section">SETLIST</div>
        <div class="set-list">
          ${songs.map((sg) => {
            const on = selected.has(sg.id);
            return `<label class="set-row ${on ? "on" : ""}"><input type="checkbox" data-song="${sg.id}" ${on ? "checked" : ""}>
              <span class="set-name">${esc(sg.name)}</span><span class="set-q">Q ${songQuality(sg, perfBand)}</span></label>`;
          }).join("")}
        </div>
        <div class="show-est">
          <div><span>Expected crowd</span><strong>${est.draw}</strong></div>
          <div><span>Set quality</span><strong>${est.avgQ}</strong></div>
          <div><span>Est. take</span><strong class="good">$${est.pay}</strong></div>
          <div><span>Band fame / fans</span><strong>+${est.fameGain} / +${est.fans}</strong></div>
        </div>
        <button class="btn show-go" id="show-go" ${selected.size ? "" : "disabled"}>▶ PLAY THE SHOW</button>
      </div>
    </div>`;
  overlay.querySelector("#show-close").addEventListener("click", closeShow);
  const _nsl = overlay.querySelector(".set-list"); if (_nsl) _nsl.scrollTop = _sly;
  overlay.querySelectorAll("[data-song]").forEach((cb) => cb.addEventListener("change", () => {
    cb.checked ? selected.add(cb.dataset.song) : selected.delete(cb.dataset.song);
    renderBooking(selected);
  }));
  const go = overlay.querySelector("#show-go");
  if (go) go.addEventListener("click", () => playShow([...selected]));
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
  const est = estimate(new Set(setIds), band);
  if (!band.playerIn) { const bst = cfg.attendBoost || 1.15; est.pay = Math.round(est.pay * bst); est.fans = Math.round(est.fans * bst); est.fameGain = Math.round(est.fameGain * bst); est._boosted = bst; }
  const energy = (cfg.energyCost || 25) + (setIds.length - 1) * 5;
  const minutes = (cfg.minutes || 180) + (setIds.length - 1) * 20;

  bandEarn(band.id, est.pay, "show", "Show pay");
  const merch = sellMerchAtShow(band, est.draw);
  if (merch.revenue > 0) { bandEarn(band.id, merch.revenue, "merch", "Merch sales at show"); band.merchSold = (band.merchSold || 0) + merch.revenue; }
  addStat("mood", cfg.moodGain || 8);
  addStat("energy", -energy);
  const maxChem = DATA.config.band?.maxChemistry || 100;
  // per-band identity grows
  band.fans = (band.fans || 0) + est.fans;
  band.fame = (band.fame || 0) + est.fameGain;
  band.chemistry = Math.min(maxChem, (band.chemistry || 0) + (cfg.chemistryGain || 5));
  band.showsPlayed = (band.showsPlayed || 0) + 1;
  const _town = (DATA.venues && DATA.venues.venues && DATA.venues.venues[perfVenueId] && DATA.venues.venues[perfVenueId].town);
  if (_town) { s.showsByTown = s.showsByTown || {}; s.showsByTown[_town] = (s.showsByTown[_town] || 0) + 1; }
  const repGain = Math.max(-2, (DATA.config.venueRep && DATA.config.venueRep.gainBase != null ? DATA.config.venueRep.gainBase : 2) + Math.round((est.avgQ - 60) / 12));
  addVenueRep(perfVenueId, repGain);
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
  advanceMinutes(minutes);
  persist();
  if (pendingShowCmt) { complete(pendingShowCmt); pendingShowCmt = null; }
  emit("show:played", { bandId: band.id, pay: est.pay, merch: merch.revenue, fame: est.fameGain, fans: est.fans, quality: est.avgQ });
  emit("renderAll");

  const [head, sub] = tierFlavor(est.avgQ);
  overlay.innerHTML = `
    <div class="show-modal">
      <div class="shop-head"><span class="shop-title">SHOW REPORT</span><button class="phone-nav" id="show-close2">✕</button></div>
      <div class="show-body show-report">
        <div class="report-head">${esc(head)}</div>
        <p class="shop-note">${esc(sub)}</p>
        ${est._boosted ? `<p class="shop-note" style="color:var(--green)">You showed up to manage — the band raised their game (+${Math.round((est._boosted - 1) * 100)}%).</p>` : ""}
        <div class="show-est">
          <div><span>Crowd</span><strong>${est.draw}</strong></div>
          <div><span>Earned</span><strong class="good">$${est.pay}</strong></div>
          ${merch.revenue > 0 ? `<div><span>Merch</span><strong class="good">$${merch.revenue}</strong></div>` : ""}
          <div><span>Fame</span><strong>+${est.fameGain}</strong></div>
          <div><span>New fans</span><strong>+${est.fans}</strong></div>
        </div>
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
  toast(`Show done — $${est.pay}${merch.revenue > 0 ? ` +$${merch.revenue} merch` : ""}, +${est.fans} fans${cutTotal > 0 ? ` · $${cutTotal} owed to band` : ""}.`, "good");
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
