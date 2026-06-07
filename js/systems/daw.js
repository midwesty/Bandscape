// ============================================================
// daw.js — the laptop STUDIO (Step 5 + 5.1).
//
// Arrange recorded loops (any instrument) on a 4-track timeline,
// play it back in sync, and mix it. LOAD LOOP opens a searchable /
// instrument-filtered browser. MIXER gives each track a 10-band
// EQ + reverb + lowpass (routed via Web Audio effect chains).
// More effects can be gated behind gear/laptop upgrades later.
// ============================================================

import { getState } from "../engine/state.js";
import { emit } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { DATA } from "../engine/data.js";
import { playCode, click, ensureAudio, audioNow, buildFXChain, EQ_FREQS, decodeDataURL, playAudioBuffer } from "./audio.js";
import { deviceTracks, deviceBars, deviceEffects, currentDevice } from "./gear.js";

const BARW = 54, BEATS_PER_BAR = 4;
const TRACK_COLORS = ["#ff3b6b", "#4fc3f7", "#7CFC9B", "#b388ff", "#ffd23f", "#ff8a3d", "#4fe0c0", "#e060ff"];
function trackColor(ti) { return TRACK_COLORS[ti % TRACK_COLORS.length]; }
const PALETTE_RECENT = 6;

let overlay = null, draft = null, armed = null, selected = null;
let playing = false, schedTimer = null, rafId = null, startTime = 0, events = [], songDur = 0, schedIdx = 0, secPerBarCache = 1, chains = [];
const dawAudioBuf = new Map();
let browseFilter = "all", browseQuery = "";

function ensurePatternIds() { (getState().patterns || []).forEach((p, i) => { if (!p.id) p.id = "pat_" + (p.createdAt || Date.now()) + "_" + i; }); }
function patternById(id) { return (getState().patterns || []).find((p) => p.id === id) || null; }
function clipBars(pat) { if (pat && pat.type === "audio") return Math.max(1, pat.bars || 2); return Math.max(1, Math.ceil((pat.length || 32) / 16)); }
function blankFX() { return { eq: Array(10).fill(0), reverb: 0, lowpass: 20000, volume: 1, pan: 0, mute: false, solo: false }; }
function newDraft() { const nt = deviceTracks(); return { name: "Untitled Song", bpm: 110, lengthBars: deviceBars(), metroOn: false, tracks: Array.from({ length: nt }, () => []), fx: Array.from({ length: nt }, blankFX) }; }
function ensureFx() { const nt = deviceTracks(); draft.fx = draft.fx || []; for (let i = 0; i < nt; i++) draft.fx[i] = Object.assign(blankFX(), draft.fx[i] || {}); }
function padDraft() { const nt = deviceTracks(); draft.tracks = draft.tracks || []; while (draft.tracks.length < nt) draft.tracks.push([]); ensureFx(); }
function instName(id) { return DATA.instruments[id]?.name || id; }
function persist() { const s = getState(); s.songDraft = draft; saveToSlot(s.meta.slot, s); }

export function initDAW() { overlay = document.getElementById("daw"); }

export function openDAW() {
  overlay = overlay || document.getElementById("daw");
  ensurePatternIds();
  draft = getState().songDraft || newDraft();
  if (!Array.isArray(draft.tracks)) draft = newDraft();
  if (!draft.lengthBars) draft.lengthBars = deviceBars();
  padDraft();
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

// ---- main render ----
function render() {
  const pats = getState().patterns || [];
  const recent = pats.slice(-PALETTE_RECENT).reverse();
  const songs = getState().songs || [];
  overlay.innerHTML = `
    <div class="daw-modal">
      <div class="daw-head">
        <span class="daw-title">STUDIO</span><span class="daw-dev">${currentDevice().name}</span>
        <div class="daw-transport">
          <label class="mus-sel">BPM <input id="daw-bpm" type="number" min="50" max="220" value="${draft.bpm}"></label>
          <label class="mus-check"><input id="daw-metro" type="checkbox" ${draft.metroOn ? "checked" : ""}> Click</label>
          <button class="btn daw-t" id="daw-play">▶ PLAY</button>
          <button class="btn daw-t" id="daw-stop">■ STOP</button>
          <button class="btn daw-t" id="daw-mixer">MIXER</button>
          <button class="btn daw-t" id="daw-save">SAVE</button>
          <select id="daw-load" class="daw-load"><option value="">Load song…</option>${songs.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join("")}</select>
          <button class="btn daw-t" id="daw-new">NEW</button>
          <button class="phone-nav" id="daw-close">✕</button>
        </div>
      </div>

      <div class="daw-palette">
        <span class="daw-pal-label">LOOPS</span>
        ${recent.length ? recent.map((p) => chipHTML(p)).join("") : `<span class="muted">No loops yet — record some in the SOUND app.</span>`}
        <button class="btn daw-loadloop" id="daw-loadloop">+ LOAD LOOP</button>
      </div>

      <div class="daw-timeline-wrap">
        <div class="daw-timeline" style="width:${draft.lengthBars * BARW + 8}px">
          <div class="daw-ruler">${Array.from({ length: draft.lengthBars }, (_, b) => `<span class="daw-bar" style="width:${BARW}px">${b + 1}</span>`).join("")}</div>
          <div class="daw-tracks">${draft.tracks.map((t, ti) => laneHTML(t, ti)).join("")}</div>
          <div class="daw-playhead" id="daw-playhead" style="left:0"></div>
        </div>
      </div>

      <div class="daw-foot">${selected ? `<button class="btn daw-del" id="daw-del">Delete clip</button>` : `<span class="muted">Tap a loop, then tap a track to place it. Tap a clip to select.</span>`}</div>
      <div id="daw-sub" class="hidden"></div>
    </div>`;
  bind();
}
function chipHTML(p) {
  const col = TRACK_COLORS[0];
  return `<button class="daw-chip ${armed === p.id ? "armed" : ""}" data-id="${p.id}">${esc(p.name || "Loop")}<small>${instName(p.instrument)} · ${clipBars(p)}b</small></button>`;
}
function laneHTML(track, ti) {
  const clips = track.map((c, ci) => {
    const pat = patternById(c.patternId); if (!pat) return "";
    const w = clipBars(pat) * BARW;
    const sel = selected && selected.track === ti && selected.clip === ci ? "sel" : "";
    return `<div class="daw-clip ${sel}" data-track="${ti}" data-clip="${ci}" style="left:${c.startBar * BARW}px;width:${w - 3}px;background:${trackColor(ti)}22;border-color:${trackColor(ti)}"><span>${esc(pat.name || "Loop")}</span></div>`;
  }).join("");
  return `<div class="daw-lane" data-track="${ti}" style="width:${draft.lengthBars * BARW}px">${clips}</div>`;
}

function bind() {
  const q = (id) => overlay.querySelector(id);
  q("#daw-close").addEventListener("click", closeDAW);
  q("#daw-play").addEventListener("click", play);
  q("#daw-stop").addEventListener("click", stop);
  q("#daw-mixer").addEventListener("click", openMixer);
  q("#daw-save").addEventListener("click", saveSong);
  q("#daw-loadloop").addEventListener("click", openBrowser);
  q("#daw-new").addEventListener("click", () => { draft = newDraft(); selected = null; armed = null; persist(); render(); });
  q("#daw-load").addEventListener("change", (e) => { if (e.target.value !== "") loadSong(parseInt(e.target.value, 10)); });
  q("#daw-bpm").addEventListener("change", (e) => { draft.bpm = Math.max(50, Math.min(220, parseInt(e.target.value, 10) || 110)); persist(); });
  q("#daw-metro").addEventListener("change", (e) => { draft.metroOn = e.target.checked; persist(); });

  overlay.querySelectorAll(".daw-chip").forEach((b) => b.addEventListener("click", () => { armed = armed === b.dataset.id ? null : b.dataset.id; render(); }));
  overlay.querySelectorAll(".daw-lane").forEach((lane) => lane.addEventListener("click", (e) => {
    if (e.target.closest(".daw-clip")) return;
    if (!armed) { toast("Tap a loop first (or LOAD LOOP).", "info"); return; }
    const rect = lane.getBoundingClientRect();
    const bar = Math.max(0, Math.min(draft.lengthBars - 1, Math.floor((e.clientX - rect.left) / BARW)));
    placeClip(parseInt(lane.dataset.track, 10), bar);
  }));
  overlay.querySelectorAll(".daw-clip").forEach((c) => c.addEventListener("click", (e) => { e.stopPropagation(); selected = { track: +c.dataset.track, clip: +c.dataset.clip }; render(); }));
  const del = overlay.querySelector("#daw-del"); if (del) del.addEventListener("click", deleteSelected);
}

// ---- editing ----
function placeClip(ti, bar) {
  const pat = patternById(armed); if (!pat) return;
  draft.tracks[ti].push({ id: "clip_" + Math.random().toString(36).slice(2, 7), patternId: armed, startBar: bar });
  persist(); emit("clip:placed", { track: ti, bar }); render();
}
function deleteSelected() { if (!selected) return; draft.tracks[selected.track].splice(selected.clip, 1); selected = null; persist(); render(); }

// ---- sub-panels (browser / mixer) ----
function showSub(html) { const sub = overlay.querySelector("#daw-sub"); sub.innerHTML = html; sub.classList.remove("hidden"); return sub; }
function closeSub() { const sub = overlay.querySelector("#daw-sub"); if (sub) sub.classList.add("hidden"); }

function openBrowser() {
  const pats = getState().patterns || [];
  const insts = ["all", ...Array.from(new Set(pats.map((p) => p.instrument)))];
  const matches = pats.filter((p) => (browseFilter === "all" || p.instrument === browseFilter) && (p.name || "").toLowerCase().includes(browseQuery.toLowerCase()));
  const sub = showSub(`
    <div class="daw-sub-card">
      <div class="daw-sub-head"><span class="daw-title">LOAD LOOP</span><button class="phone-nav" id="sub-close">✕</button></div>
      <input id="browse-q" class="browse-q" placeholder="Search loops…" value="${esc(browseQuery)}">
      <div class="browse-filters">${insts.map((id) => `<button class="browse-filter ${browseFilter === id ? "active" : ""}" data-f="${id}">${id === "all" ? "All" : instName(id)}</button>`).join("")}</div>
      <div class="browse-list">${matches.length ? matches.map((p) => `<button class="browse-row" data-id="${p.id}"><strong>${esc(p.name)}</strong><small>${instName(p.instrument)} · ${p.bpm}bpm · ${clipBars(p)}b</small></button>`).join("") : `<p class="muted" style="padding:10px">No loops match.</p>`}</div>
    </div>`);
  sub.querySelector("#sub-close").addEventListener("click", closeSub);
  const qEl = sub.querySelector("#browse-q");
  qEl.addEventListener("input", () => { browseQuery = qEl.value; openBrowser(); requestAnimationFrame(() => { const n = overlay.querySelector("#browse-q"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); });
  sub.querySelectorAll(".browse-filter").forEach((b) => b.addEventListener("click", () => { browseFilter = b.dataset.f; openBrowser(); }));
  sub.querySelectorAll(".browse-row").forEach((b) => b.addEventListener("click", () => { armed = b.dataset.id; closeSub(); render(); toast("Armed — tap a track to place it.", "info"); }));
}

function openMixer() {
  ensureFx();
  const sub = showSub(`
    <div class="daw-sub-card">
      <div class="daw-sub-head"><span class="daw-title">MIXER</span><button class="phone-nav" id="sub-close">✕</button></div>
      <p class="muted mix-note">Effects apply on playback. Available effects depend on your device — upgrade for more.</p>
      <div class="mix-tracks">${draft.fx.map((fx, ti) => mixTrackHTML(fx, ti)).join("")}</div>
    </div>`);
  sub.querySelector("#sub-close").addEventListener("click", closeSub);
  sub.querySelectorAll("[data-fx]").forEach((el) => el.addEventListener("input", () => {
    const ti = +el.dataset.track, kind = el.dataset.fx;
    if (kind === "reverb") draft.fx[ti].reverb = +el.value / 100;
    else if (kind === "lowpass") draft.fx[ti].lowpass = +el.value;
    else if (kind === "eq") draft.fx[ti].eq[+el.dataset.band] = +el.value;
    const lab = el.parentElement.querySelector(".mix-val"); if (lab) lab.textContent = el.dataset.fx === "eq" ? (el.value + "dB") : el.dataset.fx === "lowpass" ? (el.value + "Hz") : (el.value + "%");
    persist();
  }));
  sub.querySelectorAll(".knob").forEach(bindKnob);
  sub.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => { const ti = +b.dataset.m; draft.fx[ti].mute = !draft.fx[ti].mute; persist(); openMixer(); }));
  sub.querySelectorAll("[data-s]").forEach((b) => b.addEventListener("click", () => { const ti = +b.dataset.s; draft.fx[ti].solo = !draft.fx[ti].solo; persist(); openMixer(); }));
}
function mixTrackHTML(fx, ti) {
  const eff = deviceEffects();
  const revHTML = eff.includes("reverb") ? `<label class="mix-knob">Reverb <input type="range" min="0" max="100" value="${Math.round((fx.reverb || 0) * 100)}" data-fx="reverb" data-track="${ti}"><span class="mix-val">${Math.round((fx.reverb || 0) * 100)}%</span></label>` : "";
  const lpHTML = eff.includes("lowpass") ? `<label class="mix-knob">Lowpass <input type="range" min="500" max="20000" step="100" value="${fx.lowpass || 20000}" data-fx="lowpass" data-track="${ti}"><span class="mix-val">${fx.lowpass || 20000}Hz</span></label>` : "";
  const eqHTML = eff.includes("eq") ? `<div class="mix-eq-label">10-BAND EQ</div><div class="mix-eq">${EQ_FREQS.map((f, i) => `
    <label class="eq-band"><span>${f >= 1000 ? (f / 1000) + "k" : f}</span>
      <input type="range" min="-12" max="12" step="1" value="${fx.eq[i] || 0}" data-fx="eq" data-track="${ti}" data-band="${i}" class="eq-slider" orient="vertical"></label>`).join("")}</div>` : "";
  const vol = fx.volume == null ? 1 : fx.volume;
  const stripHTML = `
    <div class="mix-strip">
      <div class="knob-wrap">
        <div class="knob" data-fx="volume" data-track="${ti}" data-val="${vol}" data-min="0" data-max="1"><div class="knob-ind" style="transform:rotate(${knobAngle(vol, 0, 1)}deg)"></div></div>
        <span class="knob-lbl">VOL</span><span class="knob-val">${Math.round(vol * 100)}%</span>
      </div>
      <div class="knob-wrap">
        <div class="knob" data-fx="pan" data-track="${ti}" data-val="${fx.pan || 0}" data-min="-1" data-max="1"><div class="knob-ind" style="transform:rotate(${knobAngle(fx.pan || 0, -1, 1)}deg)"></div></div>
        <span class="knob-lbl">PAN</span><span class="knob-val">${panLabel(fx.pan || 0)}</span>
      </div>
      <div class="mix-ms">
        <button class="ms-btn ${fx.mute ? "on-m" : ""}" data-m="${ti}">M</button>
        <button class="ms-btn ${fx.solo ? "on-s" : ""}" data-s="${ti}">S</button>
      </div>
    </div>`;
  return `
    <div class="mix-track" style="border-color:${trackColor(ti)}">
      <div class="mix-th" style="color:${trackColor(ti)}">TRACK ${ti + 1}</div>
      ${stripHTML}
      ${revHTML}${lpHTML}${eqHTML}
    </div>`;
}
function knobAngle(v, min, max) { return -135 + ((v - min) / (max - min)) * 270; }
function panLabel(v) { return v < -0.05 ? "L" + Math.round(-v * 100) : v > 0.05 ? "R" + Math.round(v * 100) : "C"; }
function bindKnob(el) {
  let startY = 0, startVal = 0;
  const min = +el.dataset.min, max = +el.dataset.max;
  const onMove = (e) => {
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    let v = startVal + ((startY - y) / 130) * (max - min);
    v = Math.max(min, Math.min(max, v));
    setKnob(el, v);
  };
  const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); persist(); };
  el.addEventListener("pointerdown", (e) => { e.preventDefault(); startY = e.clientY; startVal = +el.dataset.val; window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp); });
}
function setKnob(el, v) {
  el.dataset.val = v;
  const ti = +el.dataset.track, kind = el.dataset.fx, min = +el.dataset.min, max = +el.dataset.max;
  if (kind === "volume") draft.fx[ti].volume = v; else if (kind === "pan") draft.fx[ti].pan = v;
  const ind = el.querySelector(".knob-ind"); if (ind) ind.style.transform = `rotate(${knobAngle(v, min, max)}deg)`;
  const lab = el.parentElement.querySelector(".knob-val"); if (lab) lab.textContent = kind === "pan" ? panLabel(v) : Math.round(v * 100) + "%";
}

// ---- save / load ----
function saveSong() {
  const name = (prompt("Name this song:", draft.name || "Untitled Song") || "Untitled Song").trim();
  draft.name = name;
  const snap = JSON.parse(JSON.stringify(draft)); snap.id = "song_" + Date.now(); snap.createdAt = Date.now();
  getState().songs = getState().songs || []; getState().songs.push(snap);
  persist(); emit("song:saved", { name }); toast(`Saved song "${name}".`, "good"); render();
}
function loadSong(i) {
  const song = (getState().songs || [])[i]; if (!song) return;
  draft = JSON.parse(JSON.stringify(song));
  if (!Array.isArray(draft.tracks)) draft = newDraft();
  if (!draft.lengthBars) draft.lengthBars = deviceBars();
  padDraft(); selected = null; persist(); render(); toast(`Loaded "${song.name}".`, "info");
}

// ---- playback (lookahead scheduler w/ per-track FX) ----
function buildEvents() {
  const secPerBeat = 60 / draft.bpm, secPerBar = secPerBeat * BEATS_PER_BAR, secPerStep = secPerBeat / 4;
  const evs = []; let maxEnd = draft.lengthBars * secPerBar;
  draft.tracks.forEach((track, ti) => {
    for (const clip of track) {
      const pat = patternById(clip.patternId); if (!pat) continue;
      const base = clip.startBar * secPerBar;
      if (pat.type === "audio") { evs.push({ t: base, audio: pat.id, track: ti }); maxEnd = Math.max(maxEnd, base + (pat.duration || clipBars(pat) * secPerBar)); continue; }
      for (const e of (pat.events || [])) evs.push({ t: base + e.step * secPerStep, inst: pat.instrument || "guitar", code: e.code, oct: e.oct, track: ti });
    }
  });
  if (draft.metroOn) { const tb = draft.lengthBars * BEATS_PER_BAR; for (let b = 0; b < tb; b++) evs.push({ t: b * secPerBeat, click: b % BEATS_PER_BAR === 0 }); }
  evs.sort((a, b) => a.t - b.t);
  return { evs, dur: maxEnd, secPerBar };
}
async function play() {
  stop(); ensureAudio(); ensureFx();
  await prepareAudio();
  const built = buildEvents();
  events = built.evs; songDur = built.dur; secPerBarCache = built.secPerBar;
  if (!events.length) { toast("Nothing to play — place some loops.", "info"); return; }
  const anySolo = draft.fx.some((f) => f.solo);
  chains = draft.fx.map((fx) => buildFXChain(fx, fx.mute || (anySolo && !fx.solo)));
  playing = true; schedIdx = 0; startTime = audioNow() + 0.12;
  schedTimer = setInterval(scheduler, 25);
  rafPlayhead();
}
async function prepareAudio() {
  const ids = new Set();
  draft.tracks.forEach((t) => t.forEach((c) => { const p = patternById(c.patternId); if (p && p.type === "audio") ids.add(p.id); }));
  for (const id of ids) { if (!dawAudioBuf.has(id)) { const p = patternById(id); try { dawAudioBuf.set(id, await decodeDataURL(p.audio)); } catch { dawAudioBuf.set(id, null); } } }
}
function scheduler() {
  if (!playing) return;
  const now = audioNow(), lookahead = 0.13;
  while (schedIdx < events.length && events[schedIdx].t < (now - startTime) + lookahead) {
    const e = events[schedIdx++]; const when = Math.max(0, startTime + e.t - now);
    if (e.click !== undefined) click(e.click, when);
    else if (e.audio !== undefined) playAudioBuffer(dawAudioBuf.get(e.audio), when, chains[e.track]);
    else playCode(e.inst, e.code, when, { octave: e.oct, out: chains[e.track] });
  }
  if ((now - startTime) > songDur + 0.5) stop();
}
function rafPlayhead() {
  const head = overlay.querySelector("#daw-playhead");
  const step = () => {
    if (!playing) return;
    const pos = Math.min(draft.lengthBars, (audioNow() - startTime) / secPerBarCache);
    if (head) head.style.left = Math.max(0, pos * BARW) + "px";
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}
function stop() {
  playing = false;
  if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  const head = overlay?.querySelector("#daw-playhead"); if (head) head.style.left = "0";
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
