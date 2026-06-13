// ============================================================
// worldaudio.js — ambient world sound (Step 24.2). A looping bed per
// outdoor scene plus one-shots the world triggers (cars passing, the
// dog). Fully data-driven by data/audio/world.json: drop your own files
// at the listed paths to replace the placeholders, no code changes. A
// missing file just plays silently. Audio unlocks on the first tap
// (browser autoplay rules).
// ============================================================

import { DATA } from "../engine/data.js";
import { getState } from "../engine/state.js";
import { on } from "../engine/bus.js";
import { saveToSlot } from "../engine/storage.js";

let M = null, vol = 0.35, started = false, inited = false;
function worldAudioOn() { const st = getState(); return !!(st && st.settings && st.settings.worldAudio); }
export function worldAudioEnabled() { return worldAudioOn(); }
let ambEl = null, ambSrc = null;

export function initWorldAudio() {
  if (inited) return;
  inited = true;
  M = DATA.worldaudio || null;
  if (M && typeof M.volume === "number") vol = M.volume;
  on("location:changed", ({ to }) => setScene(to));
  const unlock = () => { started = true; if (ambSrc && ambEl) ambEl.play().catch(() => {}); window.removeEventListener("pointerdown", unlock); };
  window.addEventListener("pointerdown", unlock);
  setScene(getState().location);   // prime the bed for the scene we loaded into
}

function setScene(scene) {
  if (!worldAudioOn()) { if (ambEl) { try { ambEl.pause(); } catch (e) {} ambEl = null; } ambSrc = null; return; }
  const src = (M && M.ambient && M.ambient[scene]) || null;
  if (src === ambSrc) return;
  ambSrc = src;
  if (ambEl) { try { ambEl.pause(); } catch (e) {} ambEl = null; }
  if (!src) return;
  ambEl = new Audio(src);
  ambEl.loop = true; ambEl.volume = vol;
  ambEl.addEventListener("error", () => { ambEl = null; });   // missing file -> silent
  if (started) ambEl.play().catch(() => {});
}

export function playWorldSfx(name, gain = 1, rate = 1) {
  if (!started || !worldAudioOn() || !M || !M.sfx) return;
  const src = M.sfx[name]; if (!src) return;
  const a = new Audio(src);
  a.volume = Math.max(0, Math.min(1, vol * gain));
  a.playbackRate = rate;
  a.addEventListener("error", () => {});
  a.play().catch(() => {});
}

// Settings toggle (default OFF). Only affects ambient world sound — never the
// DAW / loop / metronome playback (those use a separate Web Audio engine).
export function setWorldAudioEnabled(on) {
  const st = getState();
  st.settings = st.settings || {};
  st.settings.worldAudio = !!on;
  try { saveToSlot(st.meta.slot, st); } catch (e) {}
  if (on) { started = true; setScene(st.location); }
  else if (ambEl) { try { ambEl.pause(); } catch (e) {} ambEl = null; ambSrc = null; }
}
