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

let M = null, vol = 0.35, started = false, inited = false;
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

export function playWorldSfx(name, gain = 1) {
  if (!started || !M || !M.sfx) return;
  const src = M.sfx[name]; if (!src) return;
  const a = new Audio(src);
  a.volume = Math.max(0, Math.min(1, vol * gain));
  a.addEventListener("error", () => {});
  a.play().catch(() => {});
}
