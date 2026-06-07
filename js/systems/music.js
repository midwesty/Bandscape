// ============================================================
// music.js — the Music app (phone, landscape).
//
// Plays whatever instrument you've equipped. Melodic instruments
// (guitar/bass/piano) use chord/note pads with key + per-octave
// settings; percussion (drums) uses drum-piece pads. An in-app
// instrument switcher lets you change instruments you've picked up
// without walking back to them — so you can layer loops. Mic
// (audio) recording is staged for the next build.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState } from "../engine/state.js";
import { emit, on } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { playCode, schedulePattern, stopPattern, ensureAudio, armAudio, click, decodeDataURL, playAudioBuffer } from "./audio.js";
import { ensureMic, recordClip, cancelClip, releaseMic, blobToDataURL, micSupported } from "./micrec.js";

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
let micState = "idle"; // idle | countin | recording
let micCancel = false;
const audioBufCache = new Map();

function MS() { const s = getState(); s.musicSettings = Object.assign({}, DEFAULTS, s.musicSettings || {}); return s.musicSettings; }
function setMS(k, v) { MS()[k] = v; persist(); }
const safe = (n) => n.replace("#", "s");
const mod = (n, m) => ((n % m) + m) % m;

function activeId() { return getState().equipped?.instrumentId || null; }
function activeInst() { return DATA.instruments[activeId()] || null; }
function owned() { return getState().owned || []; }

function majorScale(root) {
  let i = NOTE_ORDER.indexOf(root); const out = [NOTE_ORDER[i]];
  for (let s = 0; s < MAJOR.length - 1; s++) { i = (i + MAJOR[s]) % 12; out.push(NOTE_ORDER[i]); }
  return out;
}
function melodicPads() {
  const scale = majorScale(MS().key);
  return {
    chords: scale.map((n) => ({ label: n, code: "chord_" + safe(n), type: "chord" })),
    notes: scale.concat([scale[0]]).map((n) => ({ label: n, code: "note_" + safe(n), type: "note" }))
  };
}
function drumPads() { return (activeInst().pieces || []).map((p) => ({ label: p.label, code: p.code, type: "drum", key: p.key })); }
function isAccent(b, mode) { return mode === "all" ? true : mode === "none" ? false : mode === "b1_3" ? (b === 0 || b === 2) : b === 0; }

// ---- render ----
export function renderMusicApp(container) {
  screenEl = container;
  const inst = activeInst();
  if (!inst) {
    screenEl.innerHTML = `<h2 class="app-title">SOUND</h2><div class="stub"><div class="stub-glyph">♪</div>
      <p>You're not holding an instrument.</p><p class="muted">Pick one up in your apartment, then come back.</p></div>`;
    return;
  }
  const kind = inst.kind;                       // melodic | percussion | audio
  const melodic = kind === "melodic";
  const tabs = kind === "audio" ? ["record", "library"] : ["play", "record", "library"];
  if (!tabs.includes(tab)) tab = tabs[0];
  screenEl.innerHTML = `
    <div class="mus-top">
      <div class="mus-controls">
        ${instSwitcher()}
        ${melodic ? selCtl("KEY", "key", KEYS, MS().key) + selCtl("CH OCT", "chordOct", OCTS, MS().chordOct) + selCtl("NT OCT", "noteOct", OCTS, MS().noteOct) : ""}
      </div>
      <div class="mus-tabs">
        ${tabs.map((t) => `<button class="mus-tab ${t === tab ? "active" : ""}" data-tab="${t}">${t.toUpperCase()}</button>`).join("")}
      </div>
    </div>
    <div id="mus-body"></div>`;
  bindSwitcher();
  if (melodic) { bindSelect("key", true); bindSelect("chordOct", false); bindSelect("noteOct", false); }
  screenEl.querySelectorAll(".mus-tab").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; renderMusicApp(screenEl); }));

  const body = screenEl.querySelector("#mus-body");
  if (tab === "library") return renderLibrary(body);
  if (kind === "audio") return renderMic(body);
  if (melodic) renderMelodic(body, tab === "record");
  else renderDrums(body, tab === "record");
}

// ---- microphone / vocals ----
function micBtnLabel() { return micState === "idle" ? "● RECORD" : micState === "countin" ? "■ CANCEL" : "■ STOP"; }
function renderMic(body) {
  const ms = MS();
  if (!micSupported()) {
    body.innerHTML = `<div class="stub"><div class="stub-glyph">🎤</div><p>Mic not available</p>
      <p class="muted">Your browser can't capture audio here. Try Chrome or Safari over https (or localhost).</p></div>`;
    return;
  }
  body.innerHTML = `
    <p class="mus-hint muted">Sing or play into your device mic. You'll be asked for permission the first time. Headphones recommended if you're playing along to a backing loop.</p>
    <div class="rec-opts">
      <label class="mus-sel">BPM <input class="rec-opt" data-ms="bpm" type="number" min="50" max="220" value="${ms.bpm}"></label>
      <label class="mus-sel">TIME ${selOptions("timeSig", Object.keys(TIME_SIGS), ms.timeSig)}</label>
      <label class="mus-sel">BARS ${selOptions("bars", BARS, ms.bars)}</label>
      <label class="mus-sel">COUNT-IN ${selOptions("countInBars", COUNTIN, ms.countInBars, (c) => c + " bar")}</label>
      <label class="mus-check"><input class="rec-opt" data-ms="metroOn" type="checkbox" ${ms.metroOn ? "checked" : ""}> Count-in clicks</label>
    </div>
    <div class="rec-bar"><button class="btn rec-btn ${micState === "recording" ? "recording" : ""}" id="mic-rec">${micBtnLabel()}</button><span id="rec-status" class="rec-status muted"></span></div>
    <p class="muted mic-foot">Clips record for the set bars at the set tempo, then save to your LIBRARY. The metronome only clicks during the count-in (so it won't bleed into your recording).</p>`;
  body.querySelectorAll(".rec-opt").forEach((el) => el.addEventListener("change", () => onRecOpt(el)));
  body.querySelector("#mic-rec").addEventListener("click", micButton);
}
function micButton() {
  if (micState === "idle") startMicRecord();
  else { micCancel = true; cancelClip(); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function startMicRecord() {
  const ms = MS(); const ts = TIME_SIGS[ms.timeSig];
  const secPerBeat = 60 / ms.bpm, beatsPerBar = ts.bpb;
  const recSec = ms.bars * beatsPerBar * secPerBeat;
  ensureAudio();
  try { await ensureMic(); } catch (e) { toast("Couldn't access the microphone. Check your browser's permission.", "bad"); return; }
  micCancel = false; micState = "countin"; renderMusicApp(screenEl);
  const countBeats = (ms.metroOn ? ms.countInBars : 0) * beatsPerBar;
  for (let b = 0; b < countBeats; b++) {
    if (micCancel) { micState = "idle"; renderMusicApp(screenEl); return; }
    click(isAccent(b % beatsPerBar, ms.accent), 0); setStatus("count-in… " + (countBeats - b)); await wait(secPerBeat * 1000);
  }
  if (micCancel) { micState = "idle"; renderMusicApp(screenEl); return; }
  micState = "recording"; renderMusicApp(screenEl);
  let remain = Math.ceil(recSec); setStatus("● recording… " + remain + "s");
  const statusTimer = setInterval(() => { remain--; if (remain >= 0) setStatus("● recording… " + remain + "s"); }, 1000);
  let blob = null;
  try { blob = await recordClip(recSec * 1000); }
  catch (e) { clearInterval(statusTimer); micState = "idle"; renderMusicApp(screenEl); if (String(e && e.message) !== "cancelled") toast("Recording failed.", "bad"); return; }
  clearInterval(statusTimer);
  await saveVocalClip(blob, ms, recSec);
  micState = "idle"; renderMusicApp(screenEl);
}
async function saveVocalClip(blob, ms, recSec) {
  let dataURL, duration = recSec;
  try { dataURL = await blobToDataURL(blob); } catch { toast("Couldn't process the recording.", "bad"); return; }
  try { const buf = await decodeDataURL(dataURL); duration = buf.duration; } catch {}
  const name = (prompt("Name this clip:", "Vocal " + ((getState().patterns?.length || 0) + 1)) || "Untitled").trim();
  const pat = { id: "pat_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6), name, instrument: activeId(), type: "audio", audio: dataURL, duration, bpm: ms.bpm, bars: ms.bars, createdAt: Date.now() };
  getState().patterns = getState().patterns || [];
  getState().patterns.push(pat);
  if (!persistSafe()) { getState().patterns.pop(); toast("Save is full — delete some loops to free space, then try again.", "bad"); return; }
  emit("pattern:recorded", { name }); toast(`Saved "${name}".`, "good"); tab = "library";
}
function persistSafe() { const s = getState(); return saveToSlot(s.meta.slot, s); }
async function playAudioPattern(pat) {
  try {
    let buf = audioBufCache.get(pat.id);
    if (!buf) { buf = await decodeDataURL(pat.audio); audioBufCache.set(pat.id, buf); }
    ensureAudio(); playAudioBuffer(buf, 0); toast(`Playing "${pat.name}".`, "info");
  } catch { toast("Couldn't play that clip.", "bad"); }
}

function instSwitcher() {
  const list = Array.from(new Set([...owned(), activeId()].filter((id) => id && DATA.instruments[id])));
  if (list.length <= 1) return `<span class="mus-inst">${activeInst().name}</span>`;
  return `<label class="mus-sel">INSTRUMENT
    <select data-inst>${list.map((id) => `<option value="${id}" ${id === activeId() ? "selected" : ""}>${DATA.instruments[id].name}</option>`).join("")}</select></label>`;
}
function bindSwitcher() {
  const el = screenEl.querySelector("select[data-inst]");
  if (!el) return;
  el.addEventListener("change", () => { stopRec(true); getState().equipped.instrumentId = el.value; persist(); tab = (tab === "library") ? "library" : tab; renderMusicApp(screenEl); });
}
function selCtl(label, key, opts, val) {
  return `<label class="mus-sel">${label}<select data-ms="${key}">${opts.map((o) => `<option ${o == val ? "selected" : ""}>${o}</option>`).join("")}</select></label>`;
}
function bindSelect(key, rerender) {
  const el = screenEl.querySelector(`select[data-ms="${key}"]`);
  if (!el) return;
  el.addEventListener("change", () => { let v = el.value; if (key.endsWith("Oct")) v = parseInt(v, 10); setMS(key, v); if (rerender || key.endsWith("Oct")) renderMusicApp(screenEl); });
}

function padRow(list, cls) {
  return `<div class="pad-row">${list.map((p, i) => `<button class="pad ${cls}" data-type="${p.type}" data-i="${i}"><span>${p.label}</span></button>`).join("")}</div>`;
}
function renderMelodic(body, recordMode) {
  const ms = MS(); const { chords, notes } = melodicPads();
  body.innerHTML = `
    ${recordMode ? recordOptionsHTML(ms) : `<p class="mus-hint muted">Tap to play. Keyboard: left hand = chords, right hand = notes.</p>`}
    <div class="pad-label">CHORDS <span class="muted">· oct ${ms.chordOct}</span></div>${padRow(chords, "pad-chord")}
    <div class="pad-label">NOTES <span class="muted">· oct ${ms.noteOct}</span></div>${padRow(notes, "pad-note")}`;
  wirePads(body, () => melodicPads().chords, () => melodicPads().notes, recordMode);
}
function renderDrums(body, recordMode) {
  const ms = MS(); const pieces = drumPads();
  body.innerHTML = `
    ${recordMode ? recordOptionsHTML(ms) : `<p class="mus-hint muted">Tap a drum pad. Keyboard keys are labeled on each pad.</p>`}
    <div class="pad-label">DRUMS</div>${padRow(pieces, "pad-drum")}`;
  body.querySelectorAll(".pad").forEach((b) => b.addEventListener("pointerdown", (e) => { e.preventDefault(); hit(drumPads()[parseInt(b.dataset.i, 10)], b); }));
  if (recordMode) { wireRecord(body); paintEvents(); }
}
function wirePads(body, getChords, getNotes, recordMode) {
  body.querySelectorAll(".pad").forEach((b) => b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const list = b.dataset.type === "chord" ? getChords() : getNotes();
    hit(list[parseInt(b.dataset.i, 10)], b);
  }));
  if (recordMode) { wireRecord(body); paintEvents(); }
}
function wireRecord(body) {
  body.querySelector("#rec-toggle").addEventListener("click", () => (isRecording ? stopRecording() : startRecording()));
  body.querySelectorAll(".rec-opt").forEach((el) => el.addEventListener("change", () => onRecOpt(el)));
}

function recordOptionsHTML(ms) {
  return `
    <div class="rec-opts">
      <label class="mus-sel">BPM <input class="rec-opt" data-ms="bpm" type="number" min="50" max="220" value="${ms.bpm}"></label>
      <label class="mus-sel">TIME ${selOptions("timeSig", Object.keys(TIME_SIGS), ms.timeSig)}</label>
      <label class="mus-sel">BARS ${selOptions("bars", BARS, ms.bars)}</label>
      <label class="mus-sel">COUNT-IN ${selOptions("countInBars", COUNTIN, ms.countInBars, (c) => c + " bar")}</label>
      <label class="mus-sel">ACCENT ${selOptions("accent", Object.keys(ACCENTS), ms.accent, (a) => ACCENTS[a])}</label>
      <label class="mus-check"><input class="rec-opt" data-ms="metroOn" type="checkbox" ${ms.metroOn ? "checked" : ""}> Metronome</label>
    </div>
    <div class="rec-bar"><button class="btn rec-btn ${isRecording ? "recording" : ""}" id="rec-toggle">${isRecording ? "■ STOP" : "● RECORD"}</button><span id="rec-status" class="rec-status muted"></span></div>
    <div class="step-strip" id="step-strip">${Array.from({ length: ms.bars * TIME_SIGS[ms.timeSig].bpb * TIME_SIGS[ms.timeSig].spb }, (_, i) => `<span class="step" data-s="${i}"></span>`).join("")}</div>`;
}
function selOptions(key, opts, val, fmt) { return `<select class="rec-opt" data-ms="${key}">${opts.map((o) => `<option value="${o}" ${o == val ? "selected" : ""}>${fmt ? fmt(o) : o}</option>`).join("")}</select>`; }
function onRecOpt(el) {
  const key = el.dataset.ms; let v;
  if (el.type === "checkbox") v = el.checked;
  else if (key === "bpm" || key === "bars" || key === "countInBars") v = parseInt(el.value, 10);
  else v = el.value;
  if (key === "bpm") v = Math.max(50, Math.min(220, v || 110));
  setMS(key, v);
  if (key !== "metroOn") renderMusicApp(screenEl);
}

function renderLibrary(body) {
  const pats = getState().patterns || [];
  if (!pats.length) { body.innerHTML = `<p class="muted" style="padding:14px 4px">No loops yet. Hit RECORD and make some noise.</p>`; return; }
  body.innerHTML = `<div class="loop-list">` + pats.map((p, i) => `
    <div class="loop-row">
      <div class="loop-info"><strong>${escapeHTML(p.name || "Untitled")}</strong>
        <small>${DATA.instruments[p.instrument]?.name || p.instrument} · ${p.bpm || 120} bpm · ${p.type === "audio" ? (Math.round(p.duration || 0) + "s clip") : ((p.events || []).length + " notes")}</small></div>
      <div class="loop-btns"><button class="btn loop-act" data-act="play" data-i="${i}">▶</button><button class="btn loop-act" data-act="del" data-i="${i}">✕</button></div>
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
  const inst = activeInst(); const ms = MS();
  let oct;
  if (pad.type === "drum") playCode(activeId(), pad.code);
  else { oct = pad.type === "chord" ? ms.chordOct : ms.noteOct; playCode(activeId(), pad.code, 0, { octave: oct }); }
  emit("note:played", { code: pad.code });
  if (el) { el.classList.add("hit"); setTimeout(() => el.classList.remove("hit"), 120); }
  if (isRecording && tickCount >= 0) {
    const ev = { step: currentStep, row: pad.type === "chord" ? 0 : 1, code: pad.code };
    if (oct !== undefined) ev.oct = oct;
    currentPattern.events.push(ev); markStep(currentStep);
  }
}
function startRecording() {
  if (!activeInst()) return;
  ensureAudio();
  const ms = MS(); const ts = TIME_SIGS[ms.timeSig];
  curBeatsPerBar = ts.bpb; curStepsPerBeat = ts.spb; curLength = ms.bars * ts.bpb * ts.spb;
  currentPattern = { name: "Untitled", instrument: activeId(), length: curLength, bpm: ms.bpm, stepsPerBeat: curStepsPerBeat, timeSig: ms.timeSig, events: [], createdAt: Date.now() };
  const countInSteps = ms.metroOn ? ms.countInBars * curBeatsPerBar * curStepsPerBeat : 0;
  tickCount = -countInSteps; currentStep = 0; isRecording = true;
  clearInterval(stepTimer);
  stepTimer = setInterval(tickFn, (60000 / ms.bpm) / curStepsPerBeat);
  renderMusicApp(screenEl);
}
function tickFn() {
  const ms = MS();
  if (ms.metroOn && mod(tickCount, curStepsPerBeat) === 0) click(isAccent(mod(Math.floor(tickCount / curStepsPerBeat), curBeatsPerBar), ms.accent), 0);
  if (tickCount >= 0) { currentStep = mod(tickCount, curLength); playhead(); setStatus("● recording"); }
  else setStatus("count-in… " + Math.ceil(-tickCount / curStepsPerBeat));
  tickCount++;
}
function stopRecording() {
  isRecording = false; clearInterval(stepTimer); stepTimer = null;
  const events = currentPattern?.events || [];
  if (events.length) {
    const name = (prompt("Name this loop:", "Loop " + ((getState().patterns?.length || 0) + 1)) || "Untitled").trim();
    currentPattern.name = name;
    currentPattern.id = "pat_" + currentPattern.createdAt + "_" + Math.random().toString(36).slice(2, 6);
    getState().patterns = getState().patterns || [];
    getState().patterns.push(currentPattern);
    persist(); emit("pattern:recorded", { name }); toast(`Saved "${name}".`, "good"); tab = "library";
  } else toast("Nothing recorded.", "info");
  currentPattern = null; renderMusicApp(screenEl);
}
function stopRec(silent) { if (isRecording) { isRecording = false; clearInterval(stepTimer); stepTimer = null; currentPattern = null; if (!silent) toast("Recording stopped.", "info"); } }
function playLoop(pattern) {
  if (libStop) { stopPattern(); libStop = null; }
  if (pattern.type === "audio") { playAudioPattern(pattern); return; }
  ensureAudio(); toast(`Playing "${pattern.name}".`, "info"); libStop = true;
  schedulePattern(pattern, () => { libStop = null; });
}

function markStep(s) { screenEl?.querySelector(`.step[data-s="${s}"]`)?.classList.add("on"); }
function paintEvents() { if (currentPattern) for (const ev of currentPattern.events) markStep(ev.step); }
function playhead() { if (!screenEl) return; screenEl.querySelectorAll(".step.ph").forEach((s) => s.classList.remove("ph")); screenEl.querySelector(`.step[data-s="${currentStep}"]`)?.classList.add("ph"); }
function setStatus(t) { const el = screenEl?.querySelector("#rec-status"); if (el) el.textContent = t; }
function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }
function escapeHTML(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---- keyboard + lifecycle ----
function onKey(e) {
  if (!musicActive || (tab !== "play" && tab !== "record")) return;
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  const inst = activeInst(); if (!inst || inst.kind === "audio") return;
  if (e.code === "Space" && tab === "record") { e.preventDefault(); isRecording ? stopRecording() : startRecording(); return; }
  const k = e.key.toLowerCase();
  if (inst.kind === "percussion") {
    const pieces = drumPads(); const idx = pieces.findIndex((p) => p.key === k);
    if (idx >= 0) { e.preventDefault(); return hit(pieces[idx], padEl("drum", idx)); }
    return;
  }
  const ui = inst.ui || {}; const left = (ui.leftKeys || []).slice(0, 7), right = (ui.rightKeys || []).slice(0, 8);
  const { chords, notes } = melodicPads();
  const li = left.indexOf(k); if (li >= 0) { e.preventDefault(); return hit(chords[li], padEl("chord", li)); }
  const ri = right.indexOf(k); if (ri >= 0) { e.preventDefault(); return hit(notes[ri], padEl("note", ri)); }
}
function padEl(type, i) { return screenEl?.querySelector(`.pad[data-type="${type}"][data-i="${i}"]`) || null; }
function deactivate() { musicActive = false; stopRec(true); if (libStop) { stopPattern(); libStop = null; } if (micState !== "idle") { micCancel = true; cancelClip(); micState = "idle"; } releaseMic(); }

armAudio();
window.addEventListener("keydown", onKey);
on("phone:appChanged", ({ app }) => { musicActive = app === "music"; if (!musicActive) deactivate(); });
on("phone:closed", deactivate);
