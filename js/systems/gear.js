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

// ---- instrument tiers (Step 19.0) — owned tier per instrument type feeds song quality ----
export function instrumentTiers(type) {
  const inst = (DATA.instruments && DATA.instruments[type]) || {};
  return inst.tiers || [{ id: "starter", name: inst.name || type, quality: 0.5, price: 0 }];
}
export function ownedInstrumentTier(type) { const s = getState(); return (s && s.gear && s.gear.instruments && s.gear.instruments[type]) || "starter"; }
export function instrumentTierObj(type) { const id = ownedInstrumentTier(type); return instrumentTiers(type).find((t) => t.id === id) || instrumentTiers(type)[0]; }
export function instrumentQuality(type) { const t = instrumentTierObj(type); return t && t.quality != null ? t.quality : 0.5; }
export function ownInstrumentTier(type, tierId) { const s = getState(); s.gear = s.gear || {}; s.gear.instruments = s.gear.instruments || {}; s.gear.instruments[type] = tierId; }
export function ensureGear() {
  const s = getState(); if (!s) return;
  s.gear = s.gear || {}; if (!s.gear.device) s.gear.device = "sp400";
  s.gear.instruments = s.gear.instruments || {};
  for (const type of Object.keys((DATA.instruments) || {})) { if (!s.gear.instruments[type]) s.gear.instruments[type] = "starter"; }
}

// quality of a specific tier of an instrument type (Step 19.2: per-object tiers)
export function instrumentTierQuality(type, tierId) {
  const t = instrumentTiers(type).find((x) => x.id === tierId);
  return t && t.quality != null ? t.quality : 0.5;
}
