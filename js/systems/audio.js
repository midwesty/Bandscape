// ============================================================
// audio.js — the sound engine (Web Audio API).
//
// Samples are decoded into buffers and scheduled on the audio
// clock; missing samples are synthesized so the instrument is
// playable immediately (drop real mp3s into assets/audio/<inst>/
// later and they take over per-note). Now octave-aware, plus a
// metronome click.
// ============================================================

import { DATA } from "../engine/data.js";

let ctx = null;
const buffers = new Map();   // "inst|code" -> AudioBuffer | "missing" | "loading"

const PC = { C: 0, Cs: 1, D: 2, Ds: 3, E: 4, F: 5, Fs: 6, G: 7, Gs: 8, A: 9, As: 10, B: 11 };
function midi(pc, octave) { return (octave + 1) * 12 + (PC[pc] ?? 0); }
function freq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

export function ensureAudio() {
  if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; ctx = new AC(); }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}
export function audioNow() { return ensureAudio().currentTime; }
let armed = false;
export function armAudio() {
  if (armed) return; armed = true;
  const go = () => { ensureAudio(); window.removeEventListener("pointerdown", go); window.removeEventListener("keydown", go); };
  window.addEventListener("pointerdown", go);
  window.addEventListener("keydown", go);
}

function parseCode(code) { const [kind, pitch] = code.split("_"); return { kind, pitch }; }

// ---- synth fallback ----
function tone(m, t0, dur, gainPeak) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = "triangle"; o.frequency.value = freq(m);
  o.connect(g); g.connect(ctx.destination);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gainPeak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
function synth(kind, pitch, when, octave) {
  const t0 = ctx.currentTime + Math.max(0, when);
  if (kind === "chord") {
    const root = midi(pitch, octave ?? 3);
    [root, root + 4, root + 7, root + 12].forEach((m, i) => tone(m, t0, 0.9, i === 0 ? 0.18 : 0.12));
  } else {
    tone(midi(pitch, octave ?? 4), t0, 0.5, 0.22);
  }
}

// ---- sample playback ----
function playBuffer(buf, when, rate) {
  const src = ctx.createBufferSource(), g = ctx.createGain();
  src.buffer = buf; if (rate && rate !== 1) src.playbackRate.value = rate;
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
    const buf = await ensureAudio().decodeAudioData(await res.arrayBuffer());
    buffers.set(key, buf);
  } catch { buffers.set(key, "missing"); }
}

// play a note/chord. opts.octave overrides default (note=4, chord=3).
export function playCode(instId, code, when = 0, opts = {}) {
  ensureAudio();
  const { kind, pitch } = parseCode(code);
  const octave = opts.octave;
  const key = instId + "|" + code;
  const b = buffers.get(key);
  if (b instanceof AudioBuffer) {
    const base = kind === "chord" ? 3 : 4;
    const rate = octave ? Math.pow(2, octave - base) : 1;
    playBuffer(b, when, rate); return;
  }
  synth(kind, pitch, when, octave);
  if (b === undefined) { buffers.set(key, "loading"); loadSample(instId, code, key); }
}

// ---- metronome click ----
export function click(accent = false, when = 0) {
  ensureAudio();
  const t0 = ctx.currentTime + Math.max(0, when);
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = "square"; o.frequency.value = accent ? 1800 : 1050;
  o.connect(g); g.connect(ctx.destination);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(accent ? 0.28 : 0.16, t0 + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0004, t0 + 0.045);
  o.start(t0); o.stop(t0 + 0.06);
}

// ---- pattern playback ----
let stopTimer = null;
export function schedulePattern(pattern, onDone) {
  ensureAudio(); stopPattern();
  const bpm = pattern.bpm || 120;
  const spb = pattern.stepsPerBeat || 4;
  const secPerStep = (60 / bpm) / spb;
  const lead = 0.08;
  for (const ev of (pattern.events || [])) {
    playCode(pattern.instrument || "guitar", ev.code, lead + ev.step * secPerStep, { octave: ev.oct });
  }
  const dur = ((pattern.length || 32) * secPerStep + lead) * 1000;
  stopTimer = setTimeout(() => { stopTimer = null; onDone && onDone(); }, dur + 150);
}
export function stopPattern() { if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; } }
