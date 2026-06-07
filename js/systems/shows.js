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
import { getState, addStat } from "../engine/state.js";
import { emit } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { advanceMinutes } from "./time.js";

let overlay = null;

function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const songById = (id) => (getState().songs || []).find((s) => s.id === id) || null;

// ---- quality ----
export function songQuality(song) {
  if (!song) return 0;
  const tracks = song.tracks || [];
  const used = tracks.filter((t) => t && t.length).length;
  const clips = tracks.reduce((n, t) => n + (t ? t.length : 0), 0);
  const content = Math.min(1, (used / 4) * 0.6 + Math.min(1, clips / 8) * 0.4);
  const s = getState();
  const maxChem = DATA.config.band?.maxChemistry || 100;
  const chem = (s.band?.chemistry || 0) / maxChem;
  const members = s.band?.members || [];
  const skill = members.length ? members.reduce((a, m) => a + (m.skill || 0), 0) / members.length : 0;
  const fid = DATA.config.gear?.fidelity ?? 0.5;
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
export function openBooking() {
  const s = getState(); const band = s.band || {};
  if (!band.members || !band.members.length) { toast("You need a band first — recruit some of these musicians.", "warn"); return; }
  if (!(s.songs || []).length) { toast("Book what, exactly? Record and save a song first.", "warn"); return; }
  if (!band.pressKit) { toast("The booker wants a press kit — put one together in your BAND app.", "warn"); return; }
  overlay = overlay || document.getElementById("show");
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => overlay.classList.add("open"));
  document.body.classList.add("modal-open");
  renderBooking(new Set([band.pressKit.songId].filter(Boolean)));
}
export function closeShow() {
  overlay.classList.remove("open");
  document.body.classList.remove("modal-open");
  setTimeout(() => overlay.classList.add("hidden"), 200);
}

function estimate(setIds) {
  const s = getState(); const cfg = DATA.config.shows;
  const fame = s.stats.fame || 0;
  const chem = s.band?.chemistry || 0;
  const draw = Math.round((cfg.baseAudience || 8) + fame * (cfg.fameDrawFactor || 0.5) + chem / (cfg.chemDrawDiv || 20));
  const qs = [...setIds].map((id) => songQuality(songById(id))).filter((n) => n >= 0);
  const avgQ = qs.length ? qs.reduce((a, b) => a + b, 0) / qs.length : 0;
  const qf = 0.4 + 0.6 * (avgQ / 100);
  const lengthFactor = 1 + 0.15 * Math.max(0, setIds.size - 1);
  const pay = Math.round(draw * (cfg.payPerHead || 2) * qf * lengthFactor);
  const fans = Math.max(0, Math.round(draw * (avgQ / 100) * 0.6));
  const fame2 = Math.max(1, Math.round(2 + avgQ / 20 + draw * 0.1));
  return { draw, avgQ: Math.round(avgQ), pay, fans, fameGain: fame2 };
}

function renderBooking(selected) {
  const s = getState(); const songs = s.songs || [];
  const est = estimate(selected);
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
              <span class="set-name">${esc(sg.name)}</span><span class="set-q">Q ${songQuality(sg)}</span></label>`;
          }).join("")}
        </div>
        <div class="show-est">
          <div><span>Expected crowd</span><strong>${est.draw}</strong></div>
          <div><span>Set quality</span><strong>${est.avgQ}</strong></div>
          <div><span>Est. take</span><strong class="good">$${est.pay}</strong></div>
          <div><span>Fame / Fans</span><strong>+${est.fameGain} / +${est.fans}</strong></div>
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
  const est = estimate(new Set(setIds));
  const energy = (cfg.energyCost || 25) + (setIds.length - 1) * 5;
  const minutes = (cfg.minutes || 180) + (setIds.length - 1) * 20;

  addStat("money", est.pay);
  addStat("fame", est.fameGain);
  addStat("fans", est.fans);
  addStat("mood", cfg.moodGain || 8);
  addStat("energy", -energy);
  const maxChem = DATA.config.band?.maxChemistry || 100;
  s.band.chemistry = Math.min(maxChem, (s.band.chemistry || 0) + (cfg.chemistryGain || 5));
  s.band.showsPlayed = (s.band.showsPlayed || 0) + 1;
  advanceMinutes(minutes);
  persist();
  emit("show:played", { pay: est.pay, fame: est.fameGain, fans: est.fans, quality: est.avgQ });
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
