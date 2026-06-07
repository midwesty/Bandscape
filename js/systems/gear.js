// ============================================================
// gear.js — recording-device tiers (SoundPound) (Step 11.0).
//
// The owned device (state.gear.device) drives the DAW: how many
// tracks, max song length, which mixer effects are exposed, and
// FIDELITY — which feeds song quality and therefore show payouts.
// Buy upgrades at the pawn shop. Defaults to the SoundPound 400.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState } from "../engine/state.js";

export function deviceList() { return (DATA.devices && DATA.devices.devices) || []; }
const FALLBACK = { id: "sp400", name: "Studio", tracks: 4, maxBars: 16, fidelity: 0.5, effects: ["eq", "reverb", "lowpass"] };

export function currentDevice() {
  const id = getState()?.gear?.device || "sp400";
  return deviceList().find((d) => d.id === id) || deviceList()[0] || FALLBACK;
}
export function deviceIndex(id) { return deviceList().findIndex((d) => d.id === id); }
export function deviceTracks() { return currentDevice().tracks || 4; }
export function deviceBars() { return currentDevice().maxBars || 16; }
export function deviceFidelity() { const d = currentDevice(); return d.fidelity != null ? d.fidelity : (DATA.config.gear?.fidelity ?? 0.5); }
export function deviceEffects() { return currentDevice().effects || ["eq", "reverb", "lowpass"]; }
export function ownDevice(id) { const s = getState(); s.gear = s.gear || {}; s.gear.device = id; }
