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
import { getState, addStat, activeBand, bandById, performingMembers, playerFame } from "../engine/state.js";
import { emit } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { advanceMinutes } from "./time.js";
import { findReady, nextCommitment, complete, slotLabel } from "./calendar.js";
import { deviceFidelity } from "./gear.js";

let overlay = null, pendingShowCmt = null, perfBand = null;

function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const songById = (id) => (getState().songs || []).find((s) => s.id === id) || null;

// ---- quality ----
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
  const q = 100 * (0.30 * content + 0.25 * chem + 0.20 * skill + 0.25 * fid);
  return Math.round(Math.max(0, Math.min(100, q)));
}
function tierFlavor(q) {
  if (q < 40) return ["Rough night.", "Half the room kept talking. You got through it."];
  if (q < 65) return ["Decent set.", "A few heads nodding. Not bad for a dive."];
  if (q < 85) return ["The crowd was into it!", "Real applause. Someone bought your sticker."];
  return ["You tore the roof off.", "The whole room lost it. People are asking your name."];
}

// ---- booking ----
export function openPerform() {
  const s = getState();
  const ready = findReady("show");
  if (!ready) {
    const nx = nextCommitment("show");
    toast(nx ? `No show tonight. Next: Day ${nx.day}, ${slotLabel(nx.slot)} — be here then.` : "No show booked. Book one in the BAND app.", "info");
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

function estimate(setIds, band) {
  band = band || perfBand || activeBand() || {};
  const cfg = DATA.config.shows;
  const mem = band.id ? performingMembers(band.id) : [];
  const starPower = mem.reduce((a, m) => a + (m.fame || 0), 0) + (band.playerIn ? playerFame() : 0);
  const draw = Math.round((cfg.baseAudience || 8) + (band.fame || 0) * (cfg.fameDrawFactor || 0.5) + starPower * (cfg.starDrawFactor || 0.4) + (band.chemistry || 0) / (cfg.chemDrawDiv || 20));
  const qs = [...setIds].map((id) => songQuality(songById(id), band)).filter((n) => n >= 0);
  const avgQ = qs.length ? qs.reduce((a, b) => a + b, 0) / qs.length : 0;
  const qf = 0.4 + 0.6 * (avgQ / 100);
  const lengthFactor = 1 + 0.15 * Math.max(0, setIds.size - 1);
  const pay = Math.round(draw * (cfg.payPerHead || 2) * qf * lengthFactor);
  const fans = Math.max(0, Math.round(draw * (avgQ / 100) * 0.6));
  const fameGain = Math.max(1, Math.round(2 + avgQ / 20 + draw * 0.1));
  return { draw, avgQ: Math.round(avgQ), pay, fans, fameGain };
}

function renderBooking(selected) {
  const s = getState(); const songs = s.songs || [];
  const est = estimate(selected, perfBand);
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
  overlay.querySelectorAll("[data-song]").forEach((cb) => cb.addEventListener("change", () => {
    cb.checked ? selected.add(cb.dataset.song) : selected.delete(cb.dataset.song);
    renderBooking(selected);
  }));
  const go = overlay.querySelector("#show-go");
  if (go) go.addEventListener("click", () => playShow([...selected]));
}

// ---- play ----
function playShow(setIds) {
  if (!setIds.length) return;
  const s = getState(); const cfg = DATA.config.shows;
  const band = perfBand || activeBand() || {};
  const est = estimate(new Set(setIds), band);
  const energy = (cfg.energyCost || 25) + (setIds.length - 1) * 5;
  const minutes = (cfg.minutes || 180) + (setIds.length - 1) * 20;

  addStat("money", est.pay);
  addStat("mood", cfg.moodGain || 8);
  addStat("energy", -energy);
  const maxChem = DATA.config.band?.maxChemistry || 100;
  // per-band identity grows
  band.fans = (band.fans || 0) + est.fans;
  band.fame = (band.fame || 0) + est.fameGain;
  band.chemistry = Math.min(maxChem, (band.chemistry || 0) + (cfg.chemistryGain || 5));
  band.showsPlayed = (band.showsPlayed || 0) + 1;
  // player's personal clout (career-wide, smaller)
  addStat("fame", Math.max(1, Math.round(est.fameGain * (cfg.playerFameShare ?? 0.4))));
  addStat("fans", Math.round(est.fans * (cfg.playerFansShare ?? 0.25)));
  // each performing musician gains individual fame
  for (const m of performingMembers(band.id)) m.fame = (m.fame || 0) + Math.max(1, Math.round(est.fameGain * (cfg.memberFameShare ?? 0.3)));
  advanceMinutes(minutes);
  persist();
  if (pendingShowCmt) { complete(pendingShowCmt); pendingShowCmt = null; }
  emit("show:played", { bandId: band.id, pay: est.pay, fame: est.fameGain, fans: est.fans, quality: est.avgQ });
  emit("renderAll");

  const [head, sub] = tierFlavor(est.avgQ);
  overlay.innerHTML = `
    <div class="show-modal">
      <div class="shop-head"><span class="shop-title">SHOW REPORT</span><button class="phone-nav" id="show-close2">✕</button></div>
      <div class="show-body show-report">
        <div class="report-head">${esc(head)}</div>
        <p class="shop-note">${esc(sub)}</p>
        <div class="show-est">
          <div><span>Crowd</span><strong>${est.draw}</strong></div>
          <div><span>Earned</span><strong class="good">$${est.pay}</strong></div>
          <div><span>Fame</span><strong>+${est.fameGain}</strong></div>
          <div><span>New fans</span><strong>+${est.fans}</strong></div>
        </div>
        <button class="btn" id="show-done">Done</button>
      </div>
    </div>`;
  overlay.querySelector("#show-close2").addEventListener("click", closeShow);
  overlay.querySelector("#show-done").addEventListener("click", closeShow);
  toast(`Show done — $${est.pay}, +${est.fans} fans.`, "good");
}
