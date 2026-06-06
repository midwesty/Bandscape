// ============================================================
// stage.js — the room you see behind the HUD.
//
// STEP 1: a stylized placeholder apartment with clickable object
// hotspots read from data/locations/apartment.json. The bed lets
// you sleep (advance the day). Other objects tease later builds.
// STEP 2 replaces this whole module with the isometric renderer —
// the apartment.json data already describes tile positions for it.
// ============================================================

import { DATA } from "../engine/data.js";
import { getState } from "../engine/state.js";
import { sleep } from "./time.js";
import { applyArt } from "../ui/placeholder.js";
import { toast } from "../ui/toast.js";

export function renderStage() {
  const host = document.getElementById("stage");
  const loc = DATA.locations[getState().location] || DATA.locations.apartment;
  if (!host || !loc) return;

  const all = [...(loc.objects || []), ...(loc.exits || [])];
  host.innerHTML = `
    <div class="stage-room">
      <div class="stage-floor"></div>
      <div class="stage-label">${loc.name} · <span class="placeholder-note">placeholder room — isometric in Step 2</span></div>
      <div class="hotspots"></div>
    </div>`;

  const layer = host.querySelector(".hotspots");
  const w = loc.size?.w || 8, h = loc.size?.h || 6;

  all.forEach((obj) => {
    const btn = document.createElement("button");
    btn.className = "hotspot";
    btn.style.left = `${8 + (obj.tile.x / w) * 80}%`;
    btn.style.top  = `${22 + (obj.tile.y / h) * 60}%`;

    const img = document.createElement("img");
    img.className = "hotspot-img";
    applyArt(img, obj.sprite, obj.name);

    const lbl = document.createElement("span");
    lbl.className = "hotspot-label";
    lbl.textContent = obj.name;

    btn.appendChild(img);
    btn.appendChild(lbl);
    btn.addEventListener("click", () => interact(obj));
    layer.appendChild(btn);
  });
}

function interact(obj) {
  const kind = obj.interact || (obj.to ? "exit" : null);
  switch (kind) {
    case "sleep":
      if (confirm("Crash for the night? (advances to tomorrow and saves)")) sleep();
      break;
    case "container":
      toast("Storage opens up once you have an inventory — next build.", "info");
      break;
    case "daw":
      toast("The laptop is your studio. It boots up in a later build.", "info");
      break;
    case "equip":
      toast("That guitar's begging to be played. Picking up instruments comes next build.", "info");
      break;
    case "exit":
      toast("The town's out there waiting. That map opens up soon.", "info");
      break;
    default:
      toast(obj.name, "info");
  }
}
