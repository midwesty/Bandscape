// ============================================================
// admin.js — password-gated cheat panel for testing (Step 19.7).
// Unlocked via Settings with the password in config.admin.password
// (default "Noodles77", change it there). Session-only unlock.
// Add freely — these are dev tools, easy to lock down/remove later.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState, addStat, setFlag, setPropertyStatus, activeBand } from "../engine/state.js";
import { emit } from "../engine/bus.js";
import { giveItem } from "./inventory.js";
import { ownDevice, deviceList, instrumentTiers, instrItemId } from "./gear.js";
import { travelTo } from "./stage.js";
import { closePhone } from "./phone.js";
import { saveToSlot } from "../engine/storage.js";
import { toast } from "../ui/toast.js";

let unlocked = false;
export function isAdminUnlocked() { return unlocked; }
export function tryUnlock(pw) {
  const pass = (DATA.config.admin && DATA.config.admin.password) || "Noodles77";
  if (pw === pass) { unlocked = true; return true; }
  return false;
}

function persist() { const s = getState(); saveToSlot(s.meta.slot, s); }
const NEEDS = ["health", "energy", "hunger", "thirst", "mood"];

function cheat(action) {
  const s = getState();
  switch (action) {
    case "money1k":   addStat("money", 1000); break;
    case "money10k":  addStat("money", 10000); break;
    case "money100k": addStat("money", 100000); break;
    case "refill":    NEEDS.forEach((k) => addStat(k, 100)); addStat("inebriation", -100); toast("Needs refilled.", "good"); break;
    case "fame":      addStat("fame", 10); toast("+10 fame.", "good"); break;
    case "unlockrock": setFlag("rocktroit_unlocked", true); toast("Rocktroit unlocked.", "good"); break;
    case "bestrec": { const list = deviceList(); if (list.length) ownDevice(list[list.length - 1].id); toast("Top recorder equipped.", "good"); break; }
    case "giveinstr":
      Object.keys(DATA.instruments || {}).forEach((type) => {
        const tiers = instrumentTiers(type); const top = tiers[tiers.length - 1];
        if (top) giveItem("inventory", instrItemId(type, top.id), 1);
      });
      toast("Top-tier instruments in your pockets.", "good"); break;
    case "tapes":     giveItem("inventory", "blank_tape", 5); toast("+5 blank tapes.", "good"); break;
    case "grantloft": setPropertyStatus("apt_nice", "owned"); toast("The Loft is yours.", "good"); break;
    case "grantunit": setPropertyStatus("apt_rock", "owned"); toast("Unit 7 is yours.", "good"); break;
    case "bandfans":  { const b = activeBand(); if (b) { b.fans = (b.fans || 0) + 500; toast("+500 band fans.", "good"); } break; }
    case "bandfame":  { const b = activeBand(); if (b) { b.fame = (b.fame || 0) + 50; toast("+50 band fame.", "good"); } break; }
    case "bandchem":  { const b = activeBand(); if (b) { b.chemistry = 100; toast("Band chemistry maxed.", "good"); } break; }
    case "clearowed": (s.musicians || []).forEach((m) => { m.owed = 0; }); toast("All IOUs cleared.", "good"); break;
    case "jumphome":  closePhone(); travelTo("apartment", null); return;
    case "jumptown":  closePhone(); travelTo("town", null); return;
    case "jumprock":  closePhone(); travelTo("rocktroit", null); return;
    case "jumpstore": closePhone(); travelTo("musicstore", null); return;
    default: return;
  }
  persist();
  emit("renderAll");
}

export function adminPanelHTML() {
  const b = (action, text) => `<button class="btn adm-cheat" data-cheat="${action}">${text}</button>`;
  const grp = (label, btns) => `<div class="adm-grp"><div class="adm-grp-label">${label}</div><div class="adm-btns">${btns}</div></div>`;
  return `<div class="adm-panel">
    ${grp("Money", b("money1k", "+$1k") + b("money10k", "+$10k") + b("money100k", "+$100k"))}
    ${grp("Needs & Fame", b("refill", "Refill needs") + b("fame", "+10 fame"))}
    ${grp("World", b("unlockrock", "Unlock Rocktroit"))}
    ${grp("Gear", b("giveinstr", "Give top instruments") + b("bestrec", "Top recorder") + b("tapes", "+5 tapes"))}
    ${grp("Property", b("grantloft", "Grant The Loft") + b("grantunit", "Grant Unit 7"))}
    ${grp("Your band", b("bandfans", "+500 fans") + b("bandfame", "+50 fame") + b("bandchem", "Max chemistry") + b("clearowed", "Clear all IOUs"))}
    ${grp("Teleport", b("jumphome", "Apartment") + b("jumptown", "Town") + b("jumprock", "Rocktroit") + b("jumpstore", "Store"))}
  </div>`;
}

export function bindAdminPanel(root, refresh) {
  root.querySelectorAll(".adm-cheat").forEach((btn) => btn.addEventListener("click", () => {
    cheat(btn.dataset.cheat);
    if (refresh) refresh();
  }));
}
