// ============================================================
// music.js — the Music app (on the phone, opens in LANDSCAPE).
//
// Play with pads (mobile) or keyboard (desktop: left=chords,
// right=notes). Separate octave for chords vs notes. Record with
// a metronome + count-in + time signature, then play loops back.
// Settings live in state.musicSettings so they persist.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState } from "../engine/state.js";
import { emit, on } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { playCode, schedulePattern, stopPattern, ensureAudio, armAudio, click } from "./audio.js";

const NOTE_ORDER = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MAJOR = [2, 2, 1, 2, 2, 2, 1];
const KEYS = ["C", "G", "D", "A", "E", "F"];
const OCTS = [2, 3, 4, 5];
const TIME_SIGS = { "4/4": { bpb: 4, spb: 4 }, "3/4": { bpb: 3, spb: 4 }, "2/4": { bpb: 2, spb: 4 }, "6/8": { bpb: 6, spb: 2 } };
const BARS = [1, 2, 4];
const COUNTIN = [1, 2];
const ACCENTS = { beat1: "Beat 1", b1_3: "1 & 3", all: "Every beat", none: "None" };

const DEFAULTS = { key: "C", bpm: 110, timeSig: "4/4", bars: 2, countInBars: 1, metroOn: true, accent: "beat1", chordOct: 3, noteOct: 4 };

let screenEl = null, musicActive = false, tab = "play";
let isRecording = false, currentPattern = null, stepTimer = null, currentStep = 0, tickCount = 0;
let curLength = 32, curStepsPerBeat = 4, curBeatsPerBar = 4;
let libStop = null;

function MS() { const s = getState(); s.musicSettings = Object.assign({}, DEFAULTS, s.musicSettings || {}); return s.musicSettings; }
function setMS(k, v) { MS()[k] = v; persist(); }
const safe = (n) => n.replace("#", "s");
const mod = (n, m) => ((n % m) + m) % m;

function majorScale(root) {
  let i = NOTE_ORDER.indexOf(root); const out = [NOTE_ORDER[i]];
  for (let s = 0; s < MAJOR.length - 1; s++) { i = (i + MAJOR[s]) % 12; out.push(NOTE_ORDER[i]); }
  return out;
}
function pads() {
  const scale = majorScale(MS().key);
  const chords = scale.map((n) => ({ label: n, code: "chord_" + safe(n), type: "chord" }));
  const notes = scale.concat([scale[0]]).map((n) => ({ label: n, code: "note_" + safe(n), type: "note" }));
  return { chords, notes };
}
function equipped() { return getState().equipped?.instrumentId === "guitar"; }
function isAccent(beatInBar, mode) {
  if (mode === "all") return true;
  if (mode === "none") return false;
  if (mode === "b1_3") return beatInBar === 0 || beatInBar === 2;
  return beatInBar === 0; // beat1
}

// ---- render ----
export function renderMusicApp(container) {
  screenEl = container;
  if (!equipped()) {
    screenEl.innerHTML = `<h2 class="app-title">SOUND</h2>
      <div class="stub"><div class="stub-glyph">♪</div><p>You're not holding an instrument.</p>
      <p class="muted">Pick up the guitar in your apartment, then come back.</p></div>`;
    return;
  }
  const ms = MS();
  const { chords, notes } = pads();
  screenEl.innerHTML = `
    <div class="mus-top">
      <div class="mus-controls">
        ${selCtl("KEY", "key", KEYS, ms.key)}
        ${selCtl("CH OCT", "chordOct", OCTS, ms.chordOct)}
        ${selCtl("NT OCT", "noteOct", OCTS, ms.noteOct)}
      </div>
      <div class="mus-tabs">
        ${["play", "record", "library"].map((t) => `<button class="mus-tab ${t === tab ? "active" : ""}" data-tab="${t}">${t.toUpperCase()}</button>`).join("")}
      </div>
    </div>
    <div id="mus-body"></div>`;

  bindSelect("key", true); bindSelect("chordOct", false); bindSelect("noteOct", false);
  screenEl.querySelectorAll(".mus-tab").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; renderMusicApp(screenEl); }));

  const body = screenEl.querySelector("#mus-body");
  if (tab === "library") return renderLibrary(body);
  renderInstrument(body, chords, notes, tab === "record");
}

function selCtl(label, key, opts, val) {
  return `<label class="mus-sel">${label}
    <select data-ms="${key}">${opts.map((o) => `<option ${o == val ? "selected" : ""}>${o}</option>`).join("")}</select></label>`;
}
function bindSelect(key, rerender) {
  const el = screenEl.querySelector(`select[data-ms="${key}"]`);
  if (!el) return;
  el.addEventListener("change", () => {
    let v = el.value; if (key.endsWith("Oct")) v = parseInt(v, 10);
    setMS(key, v); if (rerender || key.endsWith("Oct")) renderMusicApp(screenEl);
  });
}

function padRow(list, cls) {
  return `<div class="pad-row">${list.map((p, i) =>
    `<button class="pad ${cls}" data-type="${p.type}" data-i="${i}"><span>${p.label}</span></button>`).join("")}</div>`;
}
function renderInstrument(body, chords, notes, recordMode) {
  const ms = MS();
  body.innerHTML = `
    ${recordMode ? recordOptionsHTML(ms) : `<p class="mus-hint muted">Tap to play. Keyboard: left hand = chords, right hand = notes.</p>`}
    <div class="pad-label">CHORDS <span class="muted">· oct ${ms.chordOct}</span></div>
    ${padRow(chords, "pad-chord")}
    <div class="pad-label">NOTES <span class="muted">· oct ${ms.noteOct}</span></div>
    ${padRow(notes, "pad-note")}
  `;
  body.querySelectorAll(".pad").forEach((b) => b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const list = b.dataset.type === "chord" ? chords : notes;
    hit(list[parseInt(b.dataset.i, 10)], b);
  }));
  if (recordMode) {
    body.querySelector("#rec-toggle").addEventListener("click", () => (isRecording ? stopRecording() : startRecording()));
    body.querySelectorAll(".rec-opt").forEach((el) => el.addEventListener("change", () => onRecOpt(el)));
    paintEvents();
  }
}

function recordOptionsHTML(ms) {
  return `
    <div class="rec-opts">
      <label class="mus-sel">BPM <input class="rec-opt" data-ms="bpm" type="number" min="50" max="220" value="${ms.bpm}"></label>
      <label class="mus-sel">TIME ${selOptions("timeSig", Object.keys(TIME_SIGS), ms.timeSig)}</label>
      <label class="mus-sel">BARS ${selOptions("bars", BARS, ms.bars)}</label>
      <label class="mus-sel">COUNT-IN ${selOptions("countInBars", COUNTIN.map((c) => c), ms.countInBars, (c) => c + " bar")}</label>
      <label class="mus-sel">ACCENT ${selOptions("accent", Object.keys(ACCENTS), ms.accent, (a) => ACCENTS[a])}</label>
      <label class="mus-check"><input class="rec-opt" data-ms="metroOn" type="checkbox" ${ms.metroOn ? "checked" : ""}> Metronome</label>
    </div>
    <div class="rec-bar">
      <button class="btn rec-btn ${isRecording ? "recording" : ""}" id="rec-toggle">${isRecording ? "■ STOP" : "● RECORD"}</button>
      <span id="rec-status" class="rec-status muted"></span>
    </div>
    <div class="step-strip" id="step-strip">${Array.from({ length: ms.bars * TIME_SIGS[ms.timeSig].bpb * TIME_SIGS[ms.timeSig].spb }, (_, i) => `<span class="step" data-s="${i}"></span>`).join("")}</div>`;
}
function selOptions(key, opts, val, fmt) {
  return `<select class="rec-opt" data-ms="${key}">${opts.map((o) => `<option value="${o}" ${o == val ? "selected" : ""}>${fmt ? fmt(o) : o}</option>`).join("")}</select>`;
}
function onRecOpt(el) {
  const key = el.dataset.ms;
  let v;
  if (el.type === "checkbox") v = el.checked;
  else if (key === "bpm" || key === "bars" || key === "countInBars") v = parseInt(el.value, 10);
  else v = el.value;
  if (key === "bpm") v = Math.max(50, Math.min(220, v || 110));
  setMS(key, v);
  if (key !== "metroOn") renderMusicApp(screenEl); // relayout step strip etc.
}

function renderLibrary(body) {
  const pats = getState().patterns || [];
  if (!pats.length) { body.innerHTML = `<p class="muted" style="padding:14px 4px">No loops yet. Hit RECORD and make some noise.</p>`; return; }
  body.innerHTML = `<div class="loop-list">` + pats.map((p, i) => `
    <div class="loop-row">
      <div class="loop-info"><strong>${escapeHTML(p.name || "Untitled")}</strong>
        <small>${p.bpm || 120} bpm · ${p.timeSig || "4/4"} · ${(p.events || []).length} notes</small></div>
      <div class="loop-btns">
        <button class="btn loop-act" data-act="play" data-i="${i}">▶</button>
        <button class="btn loop-act" data-act="del" data-i="${i}">✕</button>
      </div>
    </div>`).join("") + `</div>`;
  body.querySelectorAll(".loop-act").forEach((b) => b.addEventListener("click", () => {
    const i = parseInt(b.dataset.i, 10);
    if (b.dataset.act === "play") playLoop(getState().patterns[i]);
    else { getState().patterns.splice(i, 1); persist(); renderMusicApp(screenEl); }
  }));
}

// ---- play / record ----
function hit(pad, el) {
  if (!pad) return;
  ensureAudio();
  const ms = MS();
  const oct = pad.type === "chord" ? ms.chordOct : ms.noteOct;
  playCode("guitar", pad.code, 0, { octave: oct });
  emit("note:played", { code: pad.code });
  if (el) { el.classList.add("hit"); setTimeout(() => el.classList.remove("hit"), 120); }
  if (isRecording && tickCount >= 0) {
    currentPattern.events.push({ step: currentStep, row: pad.type === "chord" ? 0 : 1, code: pad.code, oct });
    markStep(currentStep);
  }
}
function startRecording() {
  if (!equipped()) return;
  ensureAudio();
  const ms = MS(); const ts = TIME_SIGS[ms.timeSig];
  curBeatsPerBar = ts.bpb; curStepsPerBeat = ts.spb; curLength = ms.bars * ts.bpb * ts.spb;
  currentPattern = { name: "Untitled", instrument: "guitar", bpm: ms.bpm, length: curLength, stepsPerBeat: curStepsPerBeat, timeSig: ms.timeSig, events: [], createdAt: Date.now() };
  const countInSteps = ms.metroOn ? ms.countInBars * curBeatsPerBar * curStepsPerBeat : 0;
  tickCount = -countInSteps; currentStep = 0; isRecording = true;
  clearInterval(stepTimer);
  stepTimer = setInterval(tickFn, (60000 / ms.bpm) / curStepsPerBeat);
  renderMusicApp(screenEl);
}
function tickFn() {
  const ms = MS();
  if (ms.metroOn && mod(tickCount, curStepsPerBeat) === 0) {
    const beatIndex = Math.floor(tickCount / curStepsPerBeat);
    click(isAccent(mod(beatIndex, curBeatsPerBar), ms.accent), 0);
  }
  if (tickCount >= 0) { currentStep = mod(tickCount, curLength); playhead(currentStep); setStatus("● recording"); }
  else { setStatus("count-in… " + Math.ceil(-tickCount / curStepsPerBeat)); }
  tickCount++;
}
function stopRecording() {
  isRecording = false; clearInterval(stepTimer); stepTimer = null;
  const events = currentPattern?.events || [];
  if (events.length) {
    const name = (prompt("Name this loop:", "Loop " + ((getState().patterns?.length || 0) + 1)) || "Untitled").trim();
    currentPattern.name = name;
    getState().patterns = getState().patterns || [];
    getState().patterns.push(currentPattern);
    persist(); emit("pattern:recorded", { name });
    toast(`Saved "${name}".`, "good");
    tab = "library";
  } else { toast("Nothing recorded.", "info"); }
  currentPattern = null;
  renderMusicApp(screenEl);
}
function playLoop(pattern) {
  if (libStop) { stopPattern(); libStop = null; }
  ensureAudio();
  toast(`Playing "${pattern.name}".`, "info");
  libStop = true;
  schedulePattern(pattern, () => { libStop = null; });
}

// ---- step strip ----
function markStep(s) { screenEl?.querySelector(`.step[data-s="${s}"]`)?.classList.add("on"); }
function paintEvents() { if (currentPattern) for (const ev of currentPattern.events) markStep(ev.step); }
function playhead() {
  if (!screenEl) return;
  screenEl.querySelectorAll(".step.ph").forEach((s) => s.classList.remove("ph"));
  screenEl.querySelector(`.step[data-s="${currentStep}"]`)?.classList.add("ph");
}
function setStatus(t) { const el = screenEl?.querySelector("#rec-status"); if (el) el.textContent = t; }

function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }
function escapeHTML(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---- keyboard + lifecycle ----
function onKey(e) {
  if (!musicActive || (tab !== "play" && tab !== "record")) return;
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === "Space" && tab === "record") { e.preventDefault(); isRecording ? stopRecording() : startRecording(); return; }
  const ui = DATA.instruments.guitar?.ui || {};
  const left = (ui.leftKeys || []).slice(0, 7), right = (ui.rightKeys || []).slice(0, 8);
  const k = e.key.toLowerCase();
  const { chords, notes } = pads();
  const li = left.indexOf(k); if (li >= 0) { e.preventDefault(); return hit(chords[li], padEl("chord", li)); }
  const ri = right.indexOf(k); if (ri >= 0) { e.preventDefault(); return hit(notes[ri], padEl("note", ri)); }
}
function padEl(type, i) { return screenEl?.querySelector(`.pad[data-type="${type}"][data-i="${i}"]`) || null; }
function deactivate() {
  musicActive = false;
  if (isRecording) { isRecording = false; clearInterval(stepTimer); stepTimer = null; currentPattern = null; }
  if (libStop) { stopPattern(); libStop = null; }
}

armAudio();
window.addEventListener("keydown", onKey);
on("phone:appChanged", ({ app }) => { musicActive = app === "music"; if (!musicActive) deactivate(); });
on("phone:closed", deactivate);
