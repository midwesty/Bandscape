// ============================================================
// songplayer.js — play a finished song's arrangement OUTSIDE the DAW
// (Step 27.1). Used by the Streamr app now and the world radio later.
//
// It mirrors the DAW's lookahead scheduler exactly (same audio engine,
// same event model) but operates on any saved song object instead of
// the live edit-draft, so the DAW itself is left completely untouched.
//
// Audio isolation: only ONE song plays at a time here; the DAW/loop/
// metronome use their own playback path. Callers (radio) stop this
// when the DAW or a show opens.
// ============================================================

import { getState } from "../engine/state.js";
import { playNote, playAudioBuffer, ensureAudio, audioNow, buildFXChain, decodeDataURL } from "./audio.js";
import { getAudio } from "../engine/audiostore.js";
import { patternNotes } from "./notes.js";
import { emit } from "../engine/bus.js";

const BEATS_PER_BAR = 4;
const bufCache = new Map();
let playing = false, schedTimer = null, startTime = 0, events = [], songDur = 0, schedIdx = 0, chains = [];
let curId = null, curOpts = null, curSong = null, curSecPerStep = 0.13, curSource = null;

let _extPatternSrc = null;
export function registerPatternSource(fn) { _extPatternSrc = fn; } // Step 31: lets world-band songs supply regenerated patterns without persisting them
function patternById(id) { return (getState().patterns || []).find((p) => p.id === id) || (_extPatternSrc ? _extPatternSrc(id) : null) || null; }
function clipBars(pat) { if (pat && pat.type === "audio") return Math.max(1, pat.bars || 2); return Math.max(1, Math.ceil((pat.length || 32) / 16)); }
function blankFX() { return { eq: Array(10).fill(0), reverb: 0, lowpass: 20000, volume: 1, pan: 0, mute: false, solo: false }; }

function buildEvents(song) {
  const bpm = song.bpm || 110, secPerBeat = 60 / bpm, secPerBar = secPerBeat * BEATS_PER_BAR, secPerStep = secPerBeat / 4;
  const evs = []; let maxEnd = (song.lengthBars || 4) * secPerBar;
  (song.tracks || []).forEach((track, ti) => {
    for (const clip of (track || [])) {
      const pat = patternById(clip.patternId); if (!pat) continue;
      const base = (clip.startBar || 0) * secPerBar;
      if (pat.type === "audio") { evs.push({ t: base, audio: pat.id, track: ti }); maxEnd = Math.max(maxEnd, base + (pat.duration || clipBars(pat) * secPerBar)); continue; }
      for (const n of patternNotes(pat)) evs.push({ t: base + n.start * secPerStep, inst: pat.instrument || "guitar", note: n, track: ti });
    }
  });
  evs.sort((a, b) => a.t - b.t);
  return { evs, dur: maxEnd, bpm };
}

async function prepAudio(song) {
  const ids = new Set();
  (song.tracks || []).forEach((t) => (t || []).forEach((c) => { const p = patternById(c.patternId); if (p && p.type === "audio") ids.add(p.id); }));
  for (const id of ids) {
    if (bufCache.has(id)) continue;
    const p = patternById(id); let src = p && p.audio;
    if (!src) { try { src = await getAudio(id); } catch {} }
    try { bufCache.set(id, src ? await decodeDataURL(src) : null); } catch { bufCache.set(id, null); }
  }
}

export function isPlaying() { return playing; }
export function nowPlayingId() { return curId; }

// opts: { lofi:bool, volume:0..1, loop:bool, silent:bool }
export async function playSong(song, opts = {}) {
  if (!song) return false;
  _stop();            // silent: handing off between sources shouldn't fire stop/resume
  ensureAudio();
  await prepAudio(song);
  const built = buildEvents(song);
  if (!built.evs.length) return false;     // nothing recorded/arranged to play
  curSong = song; curOpts = opts;
  events = built.evs; songDur = built.dur; curSecPerStep = (60 / built.bpm) / 4;
  const fxArr = (song.fx && song.fx.length) ? song.fx : [];
  const trackCount = (song.tracks || []).length || 1;
  const anySolo = fxArr.some((f) => f && f.solo);
  chains = [];
  for (let i = 0; i < trackCount; i++) {
    let fx = Object.assign(blankFX(), fxArr[i] || {});
    if (opts.lofi) fx = Object.assign({}, fx, { lowpass: Math.min(fx.lowpass || 20000, 2600), reverb: Math.max(fx.reverb || 0, 0.12), volume: (fx.volume || 1) * (opts.volume != null ? opts.volume : 0.5) });
    else if (opts.volume != null) fx = Object.assign({}, fx, { volume: (fx.volume || 1) * opts.volume });
    chains[i] = buildFXChain(fx, fx.mute || (anySolo && !fx.solo));
  }
  playing = true; schedIdx = 0; startTime = audioNow() + 0.12; curId = song.id || null; curSource = opts.source || "phone";
  schedTimer = setInterval(scheduler, 25);
  emit("song:playing", { id: curId, source: curSource });
  return true;
}

function scheduler() {
  if (!playing) return;
  const now = audioNow(), lookahead = 0.13;
  while (schedIdx < events.length && events[schedIdx].t < (now - startTime) + lookahead) {
    const e = events[schedIdx++]; const when = Math.max(0, startTime + e.t - now);
    if (e.audio !== undefined) playAudioBuffer(bufCache.get(e.audio), when, chains[e.track]);
    else if (e.note) playNote(e.inst, e.note, when, curSecPerStep, { out: chains[e.track] });
  }
  if ((now - startTime) > songDur + 0.5) {
    if (curOpts && curOpts.loop && curSong) { const sg = curSong, op = curOpts; _stop(); playSong(sg, op); return; }
    const ended = curId, src = curSource; _stop(); emit("song:ended", { id: ended, source: src });
  }
}

function _stop() {            // clear playback state WITHOUT emitting (internal handoff)
  playing = false; curId = null; curSong = null; curOpts = null; curSource = null;
  if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
}
export function stopSong() {  // explicit stop (user/leaving) -> notifies listeners
  const was = playing, src = curSource;
  _stop();
  if (was) emit("song:stopped", { source: src });
}
export function currentSource() { return playing ? curSource : null; }
