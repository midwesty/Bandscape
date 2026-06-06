// ============================================================
// audio.js — the sound engine (Web Audio API).
//
// Upgrade over the old build's `new Audio().play()` per note:
// samples are decoded into buffers and scheduled on the audio
// clock, so recorded loops play back in tight time. If a sample
// file isn't present yet, we SYNTHESIZE the note/chord so the
// instrument is playable immediately — drop real mp3s into
// assets/audio/<instrument>/ later and they take over per-note,
// no code changes (the audio version of the art placeholders).
// ============================================================

import { DATA } from "../engine/data.js";

let ctx = null;
const buffers = new Map();   // "inst|code" -> AudioBuffer | "missing" | "loading"

const PC = { C: 0, Cs: 1, D: 2, Ds: 3, E: 4, F: 5, Fs: 6, G: 7, Gs: 8, A: 9, As: 10, B: 11 };
function midi(pc, octave) { return (octave + 1) * 12 + (PC[pc] ?? 0); }
function freq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

export function ensureAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// resume on first user gesture (mobile autoplay policy)
let armed = false;
export function armAudio() {
  if (armed) return;
  armed = true;
  const go = () => { ensureAudio(); window.removeEventListener("pointerdown", go); window.removeEventListener("keydown", go); };
  window.addEventListener("pointerdown", go);
  window.addEventListener("keydown", go);
}

function parseCode(code) {
  // "note_Cs" | "chord_G"
  const [kind, pitch] = code.split("_");
  return { kind, pitch };
}

// ---- synth fallback ----
function tone(m, t0, dur, gainPeak) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "triangle";
  o.frequency.value = freq(m);
  o.connect(g); g.connect(ctx.destination);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gainPeak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}
function synth(code, when) {
  const { kind, pitch } = parseCode(code);
  const t0 = ctx.currentTime + Math.max(0, when);
  if (kind === "chord") {
    const root = midi(pitch, 3);
    [root, root + 4, root + 7, root + 12].forEach((m, i) => tone(m, t0, 0.9, i === 0 ? 0.18 : 0.12));
  } else {
    tone(midi(pitch, 4), t0, 0.5, 0.22);
  }
}

// ---- sample playback ----
function playBuffer(buf, when) {
  const src = ctx.createBufferSource();
  const g = ctx.createGain();
  src.buffer = buf;
  src.connect(g); g.connect(ctx.destination);
  src.start(ctx.currentTime + Math.max(0, when));
}
async function loadSample(instId, code, key) {
  const inst = DATA.instruments[instId];
  const file = inst?.samples?.[code];
  if (!inst || !file) { buffers.set(key, "missing"); return; }
  try {
    const res = await fetch(inst.audioFolder + file);
    if (!res.ok) throw new Error("404");
    const ab = await res.arrayBuffer();
    const buf = await ensureAudio().decodeAudioData(ab);
    buffers.set(key, buf);
  } catch { buffers.set(key, "missing"); }
}

// play a note/chord code now (when=0) or scheduled (when seconds from now)
export function playCode(instId, code, when = 0) {
  ensureAudio();
  const key = instId + "|" + code;
  const b = buffers.get(key);
  if (b instanceof AudioBuffer) { playBuffer(b, when); return; }
  synth(code, when);                       // sound now via synth
  if (b === undefined) { buffers.set(key, "loading"); loadSample(instId, code, key); } // try real sample for next time
}

// ---- pattern playback ----
let stopTimer = null;
export function schedulePattern(pattern, onDone) {
  ensureAudio();
  stopPattern();
  const bpm = pattern.bpm || 120;
  const secPerStep = (60 / bpm) / 4;       // 16th notes
  const lead = 0.08;
  for (const ev of (pattern.events || [])) {
    playCode(pattern.instrument || "guitar", ev.code, lead + ev.step * secPerStep);
  }
  const dur = ((pattern.length || 32) * secPerStep + lead) * 1000;
  stopTimer = setTimeout(() => { stopTimer = null; onDone && onDone(); }, dur + 150);
}
export function stopPattern() { if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; } }
