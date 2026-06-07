// ============================================================
// audio.js — the sound engine (Web Audio API).
//
// Per-instrument timbres (read from each instrument's JSON), a
// drum synth for percussion, sample fallback, a metronome click,
// and per-track EFFECT CHAINS (10-band EQ + reverb + lowpass) for
// the DAW mixer. Notes route to an optional output node so the
// DAW can send each track through its own effects.
// ============================================================

import { DATA } from "../engine/data.js";

let ctx = null;
const buffers = new Map();
let noiseBuf = null, impulseBuf = null;

const PC = { C: 0, Cs: 1, D: 2, Ds: 3, E: 4, F: 5, Fs: 6, G: 7, Gs: 8, A: 9, As: 10, B: 11 };
function midi(pc, octave) { return (octave + 1) * 12 + (PC[pc] ?? 0); }
function freq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

export const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

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
function noise() {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = ctx.createBufferSource(); s.buffer = noiseBuf; return s;
}

// ---- melodic synth ----
function tone(m, t0, dur, peak, out, wave) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = wave || "triangle"; o.frequency.value = freq(m);
  o.connect(g); g.connect(out);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
function synthMel(inst, kind, pitch, when, octave, out) {
  const syn = inst.synth || {};
  const wave = syn.wave || "triangle", offset = syn.octaveOffset || 0;
  const rel = syn.release || (kind === "chord" ? 0.9 : 0.5);
  const t0 = ctx.currentTime + Math.max(0, when);
  if (kind === "chord") {
    const root = midi(pitch, (octave ?? 3) + offset);
    [root, root + 4, root + 7, root + 12].forEach((m, i) => tone(m, t0, rel, i === 0 ? 0.16 : 0.11, out, wave));
  } else {
    tone(midi(pitch, (octave ?? 4) + offset), t0, rel, 0.2, out, wave);
  }
}

// ---- drum synth ----
function drumSynth(piece, when, out) {
  const t0 = ctx.currentTime + Math.max(0, when);
  const env = (node, peak, dur) => { const g = ctx.createGain(); node.connect(g); g.connect(out); g.gain.setValueAtTime(peak, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur); return g; };
  if (piece === "kick") { const o = ctx.createOscillator(); o.frequency.setValueAtTime(150, t0); o.frequency.exponentialRampToValueAtTime(50, t0 + 0.12); env(o, 0.7, 0.18); o.start(t0); o.stop(t0 + 0.2); }
  else if (piece === "snare") { const n = noise(), hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1200; n.connect(hp); env(hp, 0.4, 0.16); n.start(t0); n.stop(t0 + 0.18); const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = 180; env(o, 0.22, 0.12); o.start(t0); o.stop(t0 + 0.14); }
  else if (piece === "hihat" || piece === "openhat") { const dur = piece === "openhat" ? 0.3 : 0.05; const n = noise(), hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 7000; n.connect(hp); env(hp, 0.28, dur); n.start(t0); n.stop(t0 + dur + 0.02); }
  else if (piece === "tom") { const o = ctx.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(160, t0); o.frequency.exponentialRampToValueAtTime(90, t0 + 0.2); env(o, 0.4, 0.22); o.start(t0); o.stop(t0 + 0.24); }
  else if (piece === "clap") { const n = noise(), bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1500; n.connect(bp); env(bp, 0.4, 0.12); n.start(t0); n.stop(t0 + 0.14); }
  else if (piece === "crash") { const n = noise(), hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 5000; n.connect(hp); env(hp, 0.28, 0.6); n.start(t0); n.stop(t0 + 0.62); }
  else { const o = ctx.createOscillator(); o.frequency.value = 300; env(o, 0.3, 0.1); o.start(t0); o.stop(t0 + 0.12); }
}

// ---- sample playback ----
function playBuffer(buf, when, rate, out) {
  const src = ctx.createBufferSource(); src.buffer = buf; if (rate && rate !== 1) src.playbackRate.value = rate;
  src.connect(out); src.start(ctx.currentTime + Math.max(0, when));
}
async function loadSample(instId, code, key) {
  const inst = DATA.instruments[instId]; const file = inst?.samples?.[code];
  if (!inst || !file) { buffers.set(key, "missing"); return; }
  try {
    const res = await fetch(inst.audioFolder + file); if (!res.ok) throw new Error("404");
    buffers.set(key, await ensureAudio().decodeAudioData(await res.arrayBuffer()));
  } catch { buffers.set(key, "missing"); }
}

// play a note/chord/drum-piece. opts.octave (melodic), opts.out (effect chain).
export function playCode(instId, code, when = 0, opts = {}) {
  ensureAudio();
  const out = opts.out || ctx.destination;
  const inst = DATA.instruments[instId] || {};
  const key = instId + "|" + code;
  const b = buffers.get(key);
  if (b instanceof AudioBuffer) {
    let rate = 1;
    if (inst.kind !== "percussion" && opts.octave) { const base = code.startsWith("chord") ? 3 : 4; rate = Math.pow(2, opts.octave - base); }
    playBuffer(b, when, rate, out); return;
  }
  if (inst.kind === "percussion") drumSynth(code, when, out);
  else { const { kind, pitch } = parseCode(code); synthMel(inst, kind, pitch, when, opts.octave, out); }
  if (b === undefined) { buffers.set(key, "loading"); loadSample(instId, code, key); }
}

// ---- metronome ----
export function click(accent = false, when = 0) {
  ensureAudio();
  const t0 = ctx.currentTime + Math.max(0, when);
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = "square"; o.frequency.value = accent ? 1800 : 1050;
  o.connect(g); g.connect(ctx.destination);
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(accent ? 0.28 : 0.16, t0 + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0004, t0 + 0.045);
  o.start(t0); o.stop(t0 + 0.06);
}

// ---- effects (DAW mixer) ----
function getImpulse() {
  if (impulseBuf) return impulseBuf;
  const rate = ctx.sampleRate, len = Math.floor(rate * 1.6);
  impulseBuf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) { const d = impulseBuf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2); }
  return impulseBuf;
}
// Build an effect chain; returns the INPUT node (connect sources here). Output goes to destination.
export function buildFXChain(fx) {
  ensureAudio();
  fx = fx || {};
  const input = ctx.createGain();
  let node = input;
  EQ_FREQS.forEach((f, i) => {
    const bq = ctx.createBiquadFilter(); bq.type = "peaking"; bq.frequency.value = f; bq.Q.value = 1.1;
    bq.gain.value = (fx.eq && fx.eq[i]) || 0; node.connect(bq); node = bq;
  });
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = fx.lowpass || 20000; node.connect(lp); node = lp;
  const rv = Math.max(0, Math.min(1, fx.reverb || 0));
  const dry = ctx.createGain(), wet = ctx.createGain(), conv = ctx.createConvolver(), outg = ctx.createGain();
  conv.buffer = getImpulse();
  dry.gain.value = 1 - rv * 0.55; wet.gain.value = rv;
  node.connect(dry); node.connect(conv); conv.connect(wet);
  dry.connect(outg); wet.connect(outg); outg.connect(ctx.destination);
  return input;
}

// ---- pattern playback (library preview, dry) ----
let stopTimer = null;
export function schedulePattern(pattern, onDone) {
  ensureAudio(); stopPattern();
  const bpm = pattern.bpm || 120, spb = pattern.stepsPerBeat || 4, secPerStep = (60 / bpm) / spb, lead = 0.08;
  for (const ev of (pattern.events || [])) playCode(pattern.instrument || "guitar", ev.code, lead + ev.step * secPerStep, { octave: ev.oct });
  const dur = ((pattern.length || 32) * secPerStep + lead) * 1000;
  stopTimer = setTimeout(() => { stopTimer = null; onDone && onDone(); }, dur + 150);
}
export function stopPattern() { if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; } }
