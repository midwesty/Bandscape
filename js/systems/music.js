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
import { getState, stampItem } from "../engine/state.js";
import { emit, on } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";
import { playCode, playNote, schedulePattern, stopPattern, ensureAudio, armAudio, click, decodeDataURL, playAudioBuffer } from "./audio.js";
import { currentDevice } from "./gear.js";
import { ensureMic, recordClip, cancelClip, releaseMic, blobToDataURL, micSupported } from "./micrec.js";
import { midiOf, noteLength, patternNotes } from "./notes.js";

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
let editPattern = null, editIndex = null, brushLen = 2, prPlaying = false, prRaf = null, prDirty = false, prScrollL = 0, prScrollT = 0;
const PR_CELL = 22, PR_ROW = 20;
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
  if (editPattern) { renderPianoRoll(container); return; }
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
  stampItem(pat, "loop");
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
  const aInst = activeInst();
  const composable = aInst && aInst.kind !== "audio";
  const composeBtn = composable ? `<button class="btn pr-compose" id="pr-compose">✎ Compose new loop (${escapeHTML(aInst.name || "instrument")})</button>` : "";
  if (!pats.length) { body.innerHTML = composeBtn + `<p class="muted" style="padding:14px 4px">No loops yet. Hit RECORD and make some noise — or compose one above.</p>`; bindCompose(body); return; }
  body.innerHTML = composeBtn + `<div class="loop-list">` + pats.map((p, i) => `
    <div class="loop-row">
      <div class="loop-info"><strong>${escapeHTML(p.name || "Untitled")}</strong>
        <small>${DATA.instruments[p.instrument]?.name || p.instrument} · ${p.bpm || 120} bpm · ${p.type === "audio" ? (Math.round(p.duration || 0) + "s clip") : (patternNotes(p).length + " notes")}${p.by ? " · by " + escapeHTML(p.by) : ""}</small></div>
      <div class="loop-btns"><button class="btn loop-act" data-act="play" data-i="${i}">▶</button>${p.type === "audio" ? "" : `<button class="btn loop-act" data-act="edit" data-i="${i}">✎</button>`}<button class="btn loop-act" data-act="del" data-i="${i}">✕</button></div>
    </div>`).join("") + `</div>`;
  bindCompose(body);
  body.querySelectorAll(".loop-act").forEach((b) => b.addEventListener("click", () => {
    const i = parseInt(b.dataset.i, 10);
    if (b.dataset.act === "play") playLoop(getState().patterns[i]);
    else if (b.dataset.act === "edit") openEditor(i);
    else { getState().patterns.splice(i, 1); persist(); renderMusicApp(screenEl); }
  }));
}
function bindCompose(body) { const c = body.querySelector("#pr-compose"); if (c) c.addEventListener("click", openCompose);
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
    const start = currentStep, bpm = currentPattern.bpm, spb = currentPattern.stepsPerBeat;
    if (pad.type === "drum") {
      currentPattern.notes.push({ start, length: 1, piece: pad.code });
    } else {
      const letter = pad.code.split("_")[1];
      if (pad.type === "chord") {
        const root = midiOf(letter, oct), L = noteLength("chord", bpm, spb);
        [0, 4, 7, 12].forEach((iv, i) => currentPattern.notes.push({ start, length: L, pitch: root + iv, vel: i === 0 ? 0.8 : 0.55 }));
      } else {
        currentPattern.notes.push({ start, length: noteLength("note", bpm, spb), pitch: midiOf(letter, oct), vel: 1 });
      }
    }
    markStep(currentStep);
  }
}
function startRecording() {
  if (!activeInst()) return;
  ensureAudio();
  const ms = MS(); const ts = TIME_SIGS[ms.timeSig];
  curBeatsPerBar = ts.bpb; curStepsPerBeat = ts.spb; curLength = ms.bars * ts.bpb * ts.spb;
  currentPattern = { name: "Untitled", instrument: activeId(), length: curLength, bpm: ms.bpm, stepsPerBeat: curStepsPerBeat, timeSig: ms.timeSig, notes: [], createdAt: Date.now() };
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
  const recorded = currentPattern?.notes || [];
  if (recorded.length) {
    const name = (prompt("Name this loop:", "Loop " + ((getState().patterns?.length || 0) + 1)) || "Untitled").trim();
    currentPattern.name = name;
    currentPattern.id = "pat_" + currentPattern.createdAt + "_" + Math.random().toString(36).slice(2, 6);
    getState().patterns = getState().patterns || [];
    stampItem(currentPattern, "loop");
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
function paintEvents() { if (currentPattern) for (const n of currentPattern.notes) markStep(n.start); }
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

// ============================================================
// PIANO ROLL (Step 12) — view / edit / compose a loop's notes
// on a grid. Melodic patterns use a pitch grid (MIDI rows);
// percussion patterns use a piece grid. Tap to add a note of
// the current length, tap a note to remove it. Operates on the
// canonical note model from notes.js.
// ============================================================
const PR_PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiLabel(m) { return PR_PITCH_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
function isBlack(m) { return [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12); }
function prGateLocked() {
  if (!(DATA.config.daw && DATA.config.daw.pianoRollRequiresDigital)) return false;
  if (currentDevice().type === "digital") return false;
  toast("Piano-roll editing needs a digital SoundPound (1200+). Upgrade at the pawn shop.", "warn");
  return true;
}
function openEditor(index) {
  if (prGateLocked()) return;
  const p = getState().patterns[index];
  if (!p || p.type === "audio") return;
  editPattern = JSON.parse(JSON.stringify(p));
  editPattern.notes = patternNotes(editPattern).map((n) => ({ ...n }));   // migrate legacy + own copy
  delete editPattern.events;
  editIndex = index; prDirty = false; prScrollL = 0; prScrollT = 0;
  brushLen = (DATA.instruments[editPattern.instrument]?.kind === "percussion") ? 1 : 2;
  renderMusicApp(screenEl);
}
function openCompose() {
  if (prGateLocked()) return;
  const ms = MS(); const ts = TIME_SIGS[ms.timeSig];
  editPattern = { name: "New Loop", instrument: activeId(), length: ms.bars * ts.bpb * ts.spb, bpm: ms.bpm, stepsPerBeat: ts.spb, timeSig: ms.timeSig, notes: [], createdAt: Date.now() };
  editIndex = null; prDirty = false; prScrollL = 0; prScrollT = 0;
  brushLen = (activeInst()?.kind === "percussion") ? 1 : 2;
  renderMusicApp(screenEl);
}
function prRows(p, inst) {
  if (inst.kind === "percussion") return (inst.pieces || []).map((pc) => ({ key: pc.code, label: pc.label || pc.code, black: false }));
  const ms = MS();
  let lo = midiOf("C", (ms.noteOct || 4) - 1), hi = midiOf("B", (ms.noteOct || 4) + 1);
  const pitches = p.notes.filter((n) => n.pitch != null).map((n) => n.pitch);
  if (pitches.length) { lo = Math.min(lo, ...pitches); hi = Math.max(hi, ...pitches); }
  lo = Math.max(12, lo); hi = Math.min(120, hi);
  const rows = [];
  for (let m = hi; m >= lo; m--) rows.push({ key: m, label: midiLabel(m), black: isBlack(m) });
  return rows;
}
function noteBars(p, rows, perc) {
  const idx = {}; rows.forEach((r, i) => (idx[r.key] = i));
  return p.notes.map((n) => {
    const key = perc ? n.piece : n.pitch;
    const ri = idx[key]; if (ri == null) return "";
    const len = perc ? 1 : (n.length || 1);
    return `<div class="pr-note" style="left:${n.start * PR_CELL}px;top:${ri * PR_ROW}px;width:${len * PR_CELL - 1}px;height:${PR_ROW - 1}px"></div>`;
  }).join("");
}
function renderPianoRoll(container) {
  const prev = container.querySelector(".pr-scroll");
  if (prev) { prScrollL = prev.scrollLeft; prScrollT = prev.scrollTop; }
  const p = editPattern;
  const inst = DATA.instruments[p.instrument] || {};
  const perc = inst.kind === "percussion";
  const steps = p.length || 32, spb = p.stepsPerBeat || 4;
  const rows = prRows(p, inst);
  const brushSel = perc ? "" : [1, 2, 4, 8].map((b) => `<button class="pr-brush ${brushLen === b ? "active" : ""}" data-brush="${b}">${b}</button>`).join("");
  container.innerHTML = `
    <div class="pr-bar">
      <button class="btn pr-mini" id="pr-back">‹ Back</button>
      <span class="pr-name" id="pr-name" title="Rename">${escapeHTML(p.name || "Loop")}</span>
      <button class="btn pr-mini" id="pr-play">${prPlaying ? "■" : "▶"}</button>
      <button class="btn pr-mini" id="pr-save">Save</button>
    </div>
    ${perc ? "" : `<div class="pr-tools"><span class="pr-tlabel">Note length</span>${brushSel}</div>`}
    <div class="pr-scroll">
      <div class="pr-inner">
        <div class="pr-gutter">${rows.map((r) => `<div class="pr-rl ${r.black ? "blk" : ""}">${escapeHTML(r.label)}</div>`).join("")}</div>
        <div class="pr-grid" id="pr-grid" style="width:${steps * PR_CELL}px;height:${rows.length * PR_ROW}px;background-size:${PR_CELL}px 100%, ${PR_CELL * spb}px 100%, 100% ${PR_ROW}px">
          ${rows.map((r, ri) => (r.black ? `<div class="pr-rowbg" style="top:${ri * PR_ROW}px;height:${PR_ROW}px"></div>` : "")).join("")}
          ${noteBars(p, rows, perc)}
          <div class="pr-playhead" id="pr-ph" style="display:none;height:${rows.length * PR_ROW}px"></div>
        </div>
      </div>
    </div>
    <p class="muted pr-foot">Tap to add · tap a note to remove · ${steps} steps${editIndex == null ? " · new loop" : ""}</p>`;
  const sc = container.querySelector(".pr-scroll"); if (sc) { sc.scrollLeft = prScrollL; sc.scrollTop = prScrollT; }
  container.querySelector("#pr-back").addEventListener("click", exitEditor);
  container.querySelector("#pr-save").addEventListener("click", savePattern);
  container.querySelector("#pr-play").addEventListener("click", togglePrPlay);
  container.querySelector("#pr-name").addEventListener("click", () => { const nm = (prompt("Loop name:", p.name || "") || "").trim(); if (nm) { p.name = nm; prDirty = true; renderMusicApp(screenEl); } });
  container.querySelectorAll(".pr-brush").forEach((b) => b.addEventListener("click", () => { brushLen = +b.dataset.brush; renderMusicApp(screenEl); }));
  const grid = container.querySelector("#pr-grid");
  grid.addEventListener("click", (e) => prGridTap(e, grid, rows, steps, perc));
}
function prGridTap(e, grid, rows, steps, perc) {
  const rect = grid.getBoundingClientRect();
  const col = Math.floor((e.clientX - rect.left) / PR_CELL);
  const ri = Math.floor((e.clientY - rect.top) / PR_ROW);
  if (col < 0 || col >= steps || ri < 0 || ri >= rows.length) return;
  const key = rows[ri].key, p = editPattern;
  const hit = p.notes.findIndex((n) => (perc ? n.piece === key : n.pitch === key) && n.start <= col && col < n.start + (perc ? 1 : (n.length || 1)));
  const secPerStep = (60 / (p.bpm || 120)) / (p.stepsPerBeat || 4);
  if (hit >= 0) { p.notes.splice(hit, 1); }
  else if (perc) { p.notes.push({ start: col, length: 1, piece: key }); playNote(p.instrument, { piece: key, length: 1 }, 0, secPerStep); }
  else { const len = Math.max(1, Math.min(brushLen, steps - col)); p.notes.push({ start: col, length: len, pitch: key, vel: 1 }); playNote(p.instrument, { pitch: key, length: len, vel: 1 }, 0, secPerStep); }
  prDirty = true;
  const sc = grid.closest(".pr-scroll"); if (sc) { prScrollL = sc.scrollLeft; prScrollT = sc.scrollTop; }
  renderMusicApp(screenEl);
}
function setPrPlayBtn() { const b = screenEl?.querySelector("#pr-play"); if (b) b.textContent = prPlaying ? "■" : "▶"; }
function togglePrPlay() {
  if (prPlaying) { stopPattern(); prStopPlayhead(); prPlaying = false; setPrPlayBtn(); return; }
  ensureAudio();
  prPlaying = true; setPrPlayBtn();
  schedulePattern(editPattern, () => { prPlaying = false; prStopPlayhead(); setPrPlayBtn(); });
  prStartPlayhead();
}
function prStartPlayhead() {
  const ph = screenEl?.querySelector("#pr-ph"); if (!ph) return;
  const steps = editPattern.length || 32;
  const secPerStep = (60 / (editPattern.bpm || 120)) / (editPattern.stepsPerBeat || 4);
  const total = steps * secPerStep * 1000 + 80;
  ph.style.display = "block";
  const t0 = performance.now();
  const tick = () => {
    if (!prPlaying) { ph.style.display = "none"; return; }
    const frac = Math.min(1, (performance.now() - t0) / total);
    ph.style.left = (frac * steps * PR_CELL) + "px";
    if (frac < 1) prRaf = requestAnimationFrame(tick); else ph.style.display = "none";
  };
  prRaf = requestAnimationFrame(tick);
}
function prStopPlayhead() { if (prRaf) { cancelAnimationFrame(prRaf); prRaf = null; } const ph = screenEl?.querySelector("#pr-ph"); if (ph) ph.style.display = "none"; }
function savePattern() {
  const p = editPattern;
  if (!p.notes.length) { toast("Nothing to save — add some notes first.", "warn"); return; }
  stopPattern(); prStopPlayhead(); prPlaying = false;
  getState().patterns = getState().patterns || [];
  stampItem(p, "loop");
  if (editIndex != null && getState().patterns[editIndex]) {
    p.id = getState().patterns[editIndex].id || ("pat_" + p.createdAt + "_" + Math.random().toString(36).slice(2, 6));
    getState().patterns[editIndex] = p;
  } else {
    if (p.name === "New Loop") { const nm = (prompt("Name this loop:", "Loop " + ((getState().patterns.length || 0) + 1)) || p.name).trim(); p.name = nm || p.name; }
    p.id = "pat_" + p.createdAt + "_" + Math.random().toString(36).slice(2, 6);
    getState().patterns.push(p);
  }
  persist(); emit("pattern:recorded", { name: p.name });
  toast(`Saved "${p.name}".`, "good");
  editPattern = null; editIndex = null; tab = "library"; renderMusicApp(screenEl);
}
function exitEditor() {
  if (prDirty && !confirm("Discard changes to this loop?")) return;
  stopPattern(); prStopPlayhead(); prPlaying = false;
  editPattern = null; editIndex = null; tab = "library"; renderMusicApp(screenEl);
}
