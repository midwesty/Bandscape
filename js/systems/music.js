// ============================================================
// music.js — the Music app (lives on the phone).
//
// Play the guitar with on-screen pads (mobile) or the keyboard
// (desktop: left hand = chords, right hand = notes), record what
// you play into a loop, and play loops back from your library.
// Loop format is the ported {name,instrument,bpm,length,events[]}
// so old/new data stays compatible. Sound comes from audio.js.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState } from "../engine/state.js";
import { emit, on } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { playCode, schedulePattern, stopPattern, ensureAudio, armAudio } from "./audio.js";

const NOTE_ORDER = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MAJOR = [2, 2, 1, 2, 2, 2, 1];
const KEYS = ["C", "G", "D", "A", "E", "F"];
const MAX_STEPS = 32;

let screenEl = null;
let musicActive = false;
let tab = "play";
let curKey = "C";
let isRecording = false, currentPattern = null, stepTimer = null, currentStep = 0;
let libStop = null;

const safe = (n) => n.replace("#", "s");
function majorScale(root) {
  let i = NOTE_ORDER.indexOf(root);
  const out = [NOTE_ORDER[i]];
  for (let s = 0; s < MAJOR.length - 1; s++) { i = (i + MAJOR[s]) % 12; out.push(NOTE_ORDER[i]); }
  return out;
}
function pads() {
  const scale = majorScale(curKey);
  const chords = scale.map((n) => ({ label: n, code: "chord_" + safe(n), type: "chord" }));
  const notes = scale.concat([scale[0]]).map((n) => ({ label: n, code: "note_" + safe(n), type: "note" }));
  return { chords, notes };
}
function equipped() { return getState().equipped?.instrumentId === "guitar"; }
function secPerStepMs(bpm) { return (60000 / bpm) / 4; }

// ---- render ----
export function renderMusicApp(container) {
  screenEl = container;
  if (!equipped()) {
    screenEl.innerHTML = `
      <h2 class="app-title">SOUND</h2>
      <div class="stub"><div class="stub-glyph">♪</div>
        <p>You're not holding an instrument.</p>
        <p class="muted">Pick up the guitar in your apartment, then come back.</p></div>`;
    return;
  }
  const { chords, notes } = pads();
  screenEl.innerHTML = `
    <h2 class="app-title">SOUND</h2>
    <div class="mus-bar">
      <label class="mus-key">KEY
        <select id="mus-key">${KEYS.map((k) => `<option ${k === curKey ? "selected" : ""}>${k}</option>`).join("")}</select>
      </label>
      <div class="mus-tabs">
        ${["play", "record", "library"].map((t) => `<button class="mus-tab ${t === tab ? "active" : ""}" data-tab="${t}">${t.toUpperCase()}</button>`).join("")}
      </div>
    </div>
    <div id="mus-body"></div>`;

  screenEl.querySelector("#mus-key").addEventListener("change", (e) => { curKey = e.target.value; renderMusicApp(screenEl); });
  screenEl.querySelectorAll(".mus-tab").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; renderMusicApp(screenEl); }));

  const body = screenEl.querySelector("#mus-body");
  if (tab === "library") return renderLibrary(body);
  renderInstrument(body, chords, notes, tab === "record");
}

function padRow(list, cls) {
  return `<div class="pad-row">${list.map((p, i) =>
    `<button class="pad ${cls}" data-type="${p.type}" data-i="${i}"><span>${p.label}</span></button>`).join("")}</div>`;
}
function renderInstrument(body, chords, notes, recordMode) {
  body.innerHTML = `
    ${recordMode ? `
      <div class="rec-bar">
        <label class="mus-bpm">BPM <input id="rec-bpm" type="number" min="50" max="220" value="${currentPattern?.bpm || 110}"></label>
        <button class="btn rec-btn ${isRecording ? "recording" : ""}" id="rec-toggle">${isRecording ? "■ STOP" : "● RECORD"}</button>
      </div>
      <div class="step-strip" id="step-strip">${Array.from({ length: MAX_STEPS }, (_, i) => `<span class="step" data-s="${i}"></span>`).join("")}</div>
    ` : `<p class="mus-hint muted">Tap to play. On a keyboard: left hand = chords, right hand = notes.</p>`}
    <div class="pad-label">CHORDS</div>
    ${padRow(chords, "pad-chord")}
    <div class="pad-label">NOTES</div>
    ${padRow(notes, "pad-note")}
  `;

  body.querySelectorAll(".pad").forEach((b) => {
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const list = b.dataset.type === "chord" ? chords : notes;
      hit(list[parseInt(b.dataset.i, 10)], b);
    });
  });

  if (recordMode) {
    body.querySelector("#rec-toggle").addEventListener("click", () => (isRecording ? stopRecording() : startRecording()));
    body.querySelector("#rec-bpm").addEventListener("change", (e) => { if (currentPattern) currentPattern.bpm = clampBpm(e.target.value); });
    paintEvents();
  }
}
function clampBpm(v) { return Math.max(50, Math.min(220, parseInt(v, 10) || 110)); }

function renderLibrary(body) {
  const pats = getState().patterns || [];
  if (!pats.length) { body.innerHTML = `<p class="muted" style="padding:14px 4px">No loops yet. Hit RECORD and make some noise.</p>`; return; }
  body.innerHTML = pats.map((p, i) => `
    <div class="loop-row">
      <div class="loop-info"><strong>${escapeHTML(p.name || "Untitled")}</strong>
        <small>${p.bpm || 120} bpm · ${(p.events || []).length} notes</small></div>
      <div class="loop-btns">
        <button class="btn loop-act" data-act="play" data-i="${i}">▶</button>
        <button class="btn loop-act" data-act="del" data-i="${i}">✕</button>
      </div>
    </div>`).join("");
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
  playCode("guitar", pad.code);
  emit("note:played", { code: pad.code });
  if (el) { el.classList.add("hit"); setTimeout(() => el.classList.remove("hit"), 120); }
  if (isRecording && currentPattern) {
    currentPattern.events.push({ step: currentStep, row: pad.type === "chord" ? 0 : 1, code: pad.code });
    markStep(currentStep);
  }
}
function startRecording() {
  if (!equipped()) return;
  ensureAudio();
  const bpmInput = screenEl.querySelector("#rec-bpm");
  const bpm = clampBpm(bpmInput?.value || 110);
  currentPattern = { name: "Untitled", instrument: "guitar", bpm, length: MAX_STEPS, events: [], createdAt: Date.now() };
  currentStep = 0; isRecording = true;
  clearInterval(stepTimer);
  stepTimer = setInterval(() => { currentStep = (currentStep + 1) % MAX_STEPS; playhead(); }, secPerStepMs(bpm));
  renderMusicApp(screenEl);
}
function stopRecording() {
  isRecording = false;
  clearInterval(stepTimer); stepTimer = null;
  const events = currentPattern?.events || [];
  if (events.length) {
    const name = (prompt("Name this loop:", "Loop " + ((getState().patterns?.length || 0) + 1)) || "Untitled").trim();
    currentPattern.name = name;
    getState().patterns = getState().patterns || [];
    getState().patterns.push(currentPattern);
    persist();
    emit("pattern:recorded", { name });
    toast(`Saved "${name}".`, "good");
    tab = "library";
  } else {
    toast("Nothing recorded.", "info");
  }
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

// ---- step strip helpers ----
function markStep(s) { screenEl?.querySelector(`.step[data-s="${s}"]`)?.classList.add("on"); }
function paintEvents() {
  if (!currentPattern) return;
  for (const ev of currentPattern.events) markStep(ev.step);
}
function playhead() {
  if (!screenEl) return;
  screenEl.querySelectorAll(".step.ph").forEach((s) => s.classList.remove("ph"));
  screenEl.querySelector(`.step[data-s="${currentStep}"]`)?.classList.add("ph");
}

function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }
function escapeHTML(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---- keyboard + lifecycle ----
function onKey(e) {
  if (!musicActive || (tab !== "play" && tab !== "record")) return;
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === "Space" && tab === "record") { e.preventDefault(); isRecording ? stopRecording() : startRecording(); return; }
  const ui = DATA.instruments.guitar?.ui || {};
  const left = (ui.leftKeys || []).slice(0, 7);
  const right = (ui.rightKeys || []).slice(0, 8);
  const k = e.key.toLowerCase();
  const { chords, notes } = pads();
  let li = left.indexOf(k); if (li >= 0) { e.preventDefault(); return hit(chords[li], padEl("chord", li)); }
  let ri = right.indexOf(k); if (ri >= 0) { e.preventDefault(); return hit(notes[ri], padEl("note", ri)); }
}
function padEl(type, i) { return screenEl?.querySelector(`.pad[data-type="${type}"][data-i="${i}"]`) || null; }

function deactivate() {
  musicActive = false;
  if (isRecording) { isRecording = false; clearInterval(stepTimer); stepTimer = null; currentPattern = null; }
  if (libStop) { stopPattern(); libStop = null; }
}

// bind once at module load
armAudio();
window.addEventListener("keydown", onKey);
on("phone:appChanged", ({ app }) => { musicActive = app === "music"; if (!musicActive) deactivate(); });
on("phone:closed", deactivate);
