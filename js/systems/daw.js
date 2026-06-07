// ============================================================
// daw.js — the laptop STUDIO (Step 5).
//
// Arrange your recorded loops (from the SOUND app) as clips on a
// multi-track timeline and play the whole thing back in sync.
// Uses a Web Audio lookahead scheduler so timing stays tight and
// Stop actually stops. Save arrangements as songs (state.songs).
//
// Tap a loop in the palette to "arm" it, then tap a track lane to
// drop it at that bar. Tap a clip to select it (then Delete).
// ============================================================

import { getState } from "../engine/state.js";
import { emit } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { playCode, click, ensureAudio, audioNow } from "./audio.js";

const NTRACKS = 4;
const BARS = 16;
const BARW = 54;                 // px per bar
const BEATS_PER_BAR = 4;
const TRACK_COLORS = ["#ff3b6b", "#4fc3f7", "#7CFC9B", "#b388ff"];

let overlay = null, draft = null, armed = null, selected = null;
let playing = false, schedTimer = null, rafId = null, startTime = 0, events = [], songDur = 0, schedIdx = 0;

// ---- helpers ----
function ensurePatternIds() {
  const pats = getState().patterns || [];
  pats.forEach((p, i) => { if (!p.id) p.id = "pat_" + (p.createdAt || Date.now()) + "_" + i; });
}
function patternById(id) { return (getState().patterns || []).find((p) => p.id === id) || null; }
function clipBars(pat) { return Math.max(1, Math.ceil((pat.length || 32) / 16)); }
function newDraft() { return { name: "Untitled Song", bpm: 110, lengthBars: BARS, metroOn: false, tracks: Array.from({ length: NTRACKS }, () => []) }; }
function persist() { const s = getState(); s.songDraft = draft; saveToSlot(s.meta.slot, s); }

// ---- open / close ----
export function initDAW() { overlay = document.getElementById("daw"); }

export function openDAW() {
  overlay = overlay || document.getElementById("daw");
  ensurePatternIds();
  const s = getState();
  draft = s.songDraft || newDraft();
  if (!Array.isArray(draft.tracks) || draft.tracks.length !== NTRACKS) draft = newDraft();
  armed = null; selected = null;
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => overlay.classList.add("open"));
  document.body.classList.add("modal-open");
  render();
  emit("daw:opened");
}
export function closeDAW() {
  stop();
  overlay.classList.remove("open");
  document.body.classList.remove("modal-open");
  setTimeout(() => overlay.classList.add("hidden"), 200);
}

// ---- render ----
function render() {
  const pats = getState().patterns || [];
  const songs = getState().songs || [];
  overlay.innerHTML = `
    <div class="daw-modal">
      <div class="daw-head">
        <span class="daw-title">STUDIO</span>
        <div class="daw-transport">
          <label class="mus-sel">BPM <input id="daw-bpm" type="number" min="50" max="220" value="${draft.bpm}"></label>
          <label class="mus-check"><input id="daw-metro" type="checkbox" ${draft.metroOn ? "checked" : ""}> Click</label>
          <button class="btn daw-t" id="daw-play">▶ PLAY</button>
          <button class="btn daw-t" id="daw-stop">■ STOP</button>
          <button class="btn daw-t" id="daw-save">SAVE</button>
          <select id="daw-load" class="daw-load"><option value="">Load song…</option>${songs.map((s, i) => `<option value="${i}">${escapeHTML(s.name)}</option>`).join("")}</select>
          <button class="btn daw-t" id="daw-new">NEW</button>
          <button class="phone-nav" id="daw-close">✕</button>
        </div>
      </div>

      <div class="daw-palette">
        <span class="daw-pal-label">LOOPS</span>
        ${pats.length ? pats.map((p) => `<button class="daw-chip ${armed === p.id ? "armed" : ""}" data-id="${p.id}">${escapeHTML(p.name || "Loop")}<small>${clipBars(p)} bar${clipBars(p) > 1 ? "s" : ""}</small></button>`).join("")
          : `<span class="muted">No loops yet — record some in the SOUND app on your phone.</span>`}
      </div>

      <div class="daw-timeline-wrap">
        <div class="daw-timeline" style="width:${BARS * BARW + 8}px">
          <div class="daw-ruler">${Array.from({ length: BARS }, (_, b) => `<span class="daw-bar" style="width:${BARW}px">${b + 1}</span>`).join("")}</div>
          <div class="daw-tracks">
            ${draft.tracks.map((track, ti) => laneHTML(track, ti)).join("")}
          </div>
          <div class="daw-playhead" id="daw-playhead" style="left:0"></div>
        </div>
      </div>

      <div class="daw-foot">
        ${selected ? `<button class="btn daw-del" id="daw-del">Delete clip</button>` : `<span class="muted">Tap a loop, then tap a track to place it. Tap a clip to select.</span>`}
      </div>
    </div>`;

  bind();
}

function laneHTML(track, ti) {
  const clips = track.map((c, ci) => {
    const pat = patternById(c.patternId);
    if (!pat) return "";
    const w = clipBars(pat) * BARW;
    const sel = selected && selected.track === ti && selected.clip === ci ? "sel" : "";
    return `<div class="daw-clip ${sel}" data-track="${ti}" data-clip="${ci}"
      style="left:${c.startBar * BARW}px;width:${w - 3}px;background:${TRACK_COLORS[ti]}22;border-color:${TRACK_COLORS[ti]}">
      <span>${escapeHTML(pat.name || "Loop")}</span></div>`;
  }).join("");
  return `<div class="daw-lane" data-track="${ti}" style="width:${BARS * BARW}px;--lane:${TRACK_COLORS[ti]}">${clips}</div>`;
}

function bind() {
  overlay.querySelector("#daw-close").addEventListener("click", closeDAW);
  overlay.querySelector("#daw-play").addEventListener("click", play);
  overlay.querySelector("#daw-stop").addEventListener("click", stop);
  overlay.querySelector("#daw-save").addEventListener("click", saveSong);
  overlay.querySelector("#daw-new").addEventListener("click", () => { draft = newDraft(); selected = null; armed = null; persist(); render(); });
  overlay.querySelector("#daw-load").addEventListener("change", (e) => { if (e.target.value !== "") loadSong(parseInt(e.target.value, 10)); });
  overlay.querySelector("#daw-bpm").addEventListener("change", (e) => { draft.bpm = Math.max(50, Math.min(220, parseInt(e.target.value, 10) || 110)); persist(); });
  overlay.querySelector("#daw-metro").addEventListener("change", (e) => { draft.metroOn = e.target.checked; persist(); });

  overlay.querySelectorAll(".daw-chip").forEach((b) => b.addEventListener("click", () => { armed = (armed === b.dataset.id) ? null : b.dataset.id; render(); }));

  overlay.querySelectorAll(".daw-lane").forEach((lane) => lane.addEventListener("click", (e) => {
    if (e.target.closest(".daw-clip")) return; // clip handler deals with it
    if (!armed) { toast("Tap a loop above first.", "info"); return; }
    const rect = lane.getBoundingClientRect();
    const bar = Math.floor((e.clientX - rect.left) / BARW);
    placeClip(parseInt(lane.dataset.track, 10), Math.max(0, Math.min(BARS - 1, bar)));
  }));
  overlay.querySelectorAll(".daw-clip").forEach((c) => c.addEventListener("click", (e) => {
    e.stopPropagation();
    selected = { track: parseInt(c.dataset.track, 10), clip: parseInt(c.dataset.clip, 10) };
    render();
  }));
  const del = overlay.querySelector("#daw-del");
  if (del) del.addEventListener("click", deleteSelected);
}

// ---- editing ----
function placeClip(ti, bar) {
  const pat = patternById(armed); if (!pat) return;
  draft.tracks[ti].push({ id: "clip_" + Math.random().toString(36).slice(2, 7), patternId: armed, startBar: bar });
  persist();
  emit("clip:placed", { track: ti, bar });
  render();
}
function deleteSelected() {
  if (!selected) return;
  draft.tracks[selected.track].splice(selected.clip, 1);
  selected = null; persist(); render();
}

// ---- save / load ----
function saveSong() {
  const name = (prompt("Name this song:", draft.name || "Untitled Song") || "Untitled Song").trim();
  draft.name = name;
  const snap = JSON.parse(JSON.stringify(draft));
  snap.id = "song_" + Date.now();
  snap.createdAt = Date.now();
  getState().songs = getState().songs || [];
  getState().songs.push(snap);
  persist();
  emit("song:saved", { name });
  toast(`Saved song "${name}".`, "good");
  render();
}
function loadSong(i) {
  const song = (getState().songs || [])[i];
  if (!song) return;
  draft = JSON.parse(JSON.stringify(song));
  if (!Array.isArray(draft.tracks) || draft.tracks.length !== NTRACKS) draft = newDraft();
  selected = null; persist(); render();
  toast(`Loaded "${song.name}".`, "info");
}

// ---- playback (lookahead scheduler) ----
function buildEvents() {
  const secPerBeat = 60 / draft.bpm;
  const secPerBar = secPerBeat * BEATS_PER_BAR;
  const secPerStep = secPerBeat / 4;
  const evs = [];
  for (const track of draft.tracks) for (const clip of track) {
    const pat = patternById(clip.patternId); if (!pat) continue;
    const base = clip.startBar * secPerBar;
    for (const e of (pat.events || [])) evs.push({ t: base + e.step * secPerStep, code: e.code, oct: e.oct });
  }
  if (draft.metroOn) {
    const totalBeats = draft.lengthBars * BEATS_PER_BAR;
    for (let b = 0; b < totalBeats; b++) evs.push({ t: b * secPerBeat, click: b % BEATS_PER_BAR === 0 });
  }
  evs.sort((a, b) => a.t - b.t);
  return { evs, dur: draft.lengthBars * secPerBar, secPerBar };
}
function play() {
  stop();
  ensureAudio();
  const built = buildEvents();
  events = built.evs; songDur = built.dur; secPerBarCache = built.secPerBar;
  if (!events.length) { toast("Nothing to play — place some loops.", "info"); return; }
  playing = true; schedIdx = 0; startTime = audioNow() + 0.12;
  schedTimer = setInterval(scheduler, 25);
  rafPlayhead();
}
let secPerBarCache = 1;
function scheduler() {
  if (!playing) return;
  const now = audioNow();
  const lookahead = 0.13;
  while (schedIdx < events.length && events[schedIdx].t < (now - startTime) + lookahead) {
    const e = events[schedIdx++];
    const when = Math.max(0, startTime + e.t - now);
    if (e.click !== undefined) click(e.click, when);
    else playCode("guitar", e.code, when, { octave: e.oct });
  }
  if ((now - startTime) > songDur + 0.2) stop();
}
function rafPlayhead() {
  const head = overlay.querySelector("#daw-playhead");
  const step = () => {
    if (!playing) return;
    const pos = (audioNow() - startTime) / secPerBarCache;
    if (head) head.style.left = Math.max(0, pos * BARW) + "px";
    if (pos >= draft.lengthBars) { stop(); return; }
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}
function stop() {
  playing = false;
  if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  const head = overlay?.querySelector("#daw-playhead");
  if (head) head.style.left = "0";
}

function escapeHTML(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
