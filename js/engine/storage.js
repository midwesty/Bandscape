// ============================================================
// storage.js — persistence. Save slots in localStorage +
// export/import a save file (your jump-drive / multi-device flow).
// ============================================================

import { allAudio, putAudio } from "./audiostore.js";

const KEY = (slot) => `bandscape.save.v1.slot${slot}`;

export function saveToSlot(slot, state) {
  state.meta.slot = slot;
  state.meta.lastSaved = Date.now();
  try {
    localStorage.setItem(KEY(slot), JSON.stringify(state));
    return true;
  } catch (e) {
    console.error("Save failed:", e);
    return false;
  }
}

export function loadFromSlot(slot) {
  try {
    const raw = localStorage.getItem(KEY(slot));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error("Load failed:", e);
    return null;
  }
}

export function slotSummary(slot) {
  const s = loadFromSlot(slot);
  if (!s) return null;
  return {
    slot,
    name: s.player?.name || "???",
    day: s.time?.day ?? 1,
    money: s.stats?.money ?? 0,
    lastSaved: s.meta?.lastSaved || null
  };
}

export function deleteSlot(slot) {
  localStorage.removeItem(KEY(slot));
}

// ---- export / import ----
export function exportSave(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `bandscape-${(state.player?.name || "save").replace(/\s+/g, "_")}-day${state.time?.day || 1}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function importSave(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(JSON.parse(reader.result)); }
      catch (e) { reject(e); }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

// ---- full backup (save + audio), free, for personal cross-device safety ----
export async function exportFull(state) {
  let audio = {};
  try { audio = await allAudio(); } catch {}
  const payload = { _bandscapeBackup: 1, savedAt: Date.now(), state, audio };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `bandscape-BACKUP-${(state.player?.name || "save").replace(/\s+/g, "_")}-day${state.time?.day || 1}-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Restore either a full backup (restores audio too) or a plain save file. Returns the state.
export async function importFull(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (data && data._bandscapeBackup && data.state) {
    if (data.audio) { for (const id in data.audio) { try { await putAudio(id, data.audio[id]); } catch {} } }
    return data.state;
  }
  return data; // plain save (old format)
}
