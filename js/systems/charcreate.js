// ============================================================
// charcreate.js — make your broke musician.
// Step 1: name, avatar color, and a starting "vibe" (flavor now,
// hooks into genre/fit later). The billboard sprite is a colored
// placeholder until you drop in character art.
// ============================================================

const COLORS = ["#ff3b6b", "#ffd23f", "#7CFC9B", "#4fc3f7", "#b388ff", "#ff8a3d"];
const VIBES = [
  { id: "punk",  label: "Punk",  blurb: "Three chords and a grudge." },
  { id: "indie", label: "Indie", blurb: "Sad in a marketable way." },
  { id: "lofi",  label: "Lo-fi", blurb: "Beats to be broke to." },
  { id: "metal", label: "Metal", blurb: "Loud. Unreasonably loud." }
];

let chosen = { name: "", avatar: { color: COLORS[0], shape: "circle" }, vibe: "punk" };
let onDoneCb = null;

export function startCharCreate(onDone) {
  onDoneCb = onDone;
  chosen = { name: "", avatar: { color: COLORS[0], shape: "circle" }, vibe: "punk" };

  const el = document.getElementById("charcreate");
  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="cc-wrap">
      <div class="cc-flyer">
        <h1 class="cc-title">WHO ARE YOU</h1>
        <p class="cc-sub">broke. talented-ish. dangerously hopeful.</p>

        <label class="cc-field">
          <span>NAME</span>
          <input id="cc-name" type="text" maxlength="24" placeholder="stage name or government name" autocomplete="off">
        </label>

        <div class="cc-field">
          <span>LOOK</span>
          <div class="cc-colors" id="cc-colors"></div>
        </div>

        <div class="cc-preview"><div class="cc-avatar" id="cc-avatar"></div></div>

        <div class="cc-field">
          <span>YOUR VIBE</span>
          <div class="cc-vibes" id="cc-vibes"></div>
        </div>

        <button class="btn btn-big" id="cc-go" disabled>START FROM NOTHING →</button>
        <div class="tape tape-1"></div><div class="tape tape-2"></div>
      </div>
    </div>`;

  const colors = el.querySelector("#cc-colors");
  colors.innerHTML = COLORS.map((c, i) =>
    `<button class="cc-swatch ${i === 0 ? "sel" : ""}" data-c="${c}" style="background:${c}"></button>`).join("");
  colors.querySelectorAll(".cc-swatch").forEach((b) => b.addEventListener("click", () => {
    chosen.avatar.color = b.dataset.c;
    colors.querySelectorAll(".cc-swatch").forEach((x) => x.classList.remove("sel"));
    b.classList.add("sel");
    paintAvatar();
  }));

  const vibes = el.querySelector("#cc-vibes");
  vibes.innerHTML = VIBES.map((v, i) =>
    `<button class="cc-vibe ${i === 0 ? "sel" : ""}" data-v="${v.id}"><strong>${v.label}</strong><small>${v.blurb}</small></button>`).join("");
  vibes.querySelectorAll(".cc-vibe").forEach((b) => b.addEventListener("click", () => {
    chosen.vibe = b.dataset.v;
    vibes.querySelectorAll(".cc-vibe").forEach((x) => x.classList.remove("sel"));
    b.classList.add("sel");
  }));

  const nameInput = el.querySelector("#cc-name");
  const go = el.querySelector("#cc-go");
  nameInput.addEventListener("input", () => {
    chosen.name = nameInput.value.trim();
    go.disabled = chosen.name.length === 0;
  });

  go.addEventListener("click", () => {
    el.classList.add("hidden");
    onDoneCb && onDoneCb({ ...chosen });
  });

  paintAvatar();
  nameInput.focus();
}

function paintAvatar() {
  const a = document.getElementById("cc-avatar");
  if (a) {
    a.style.background = chosen.avatar.color;
    a.style.boxShadow = `0 8px 0 rgba(0,0,0,.4), 0 0 0 4px #0b0b0f, 0 0 22px ${chosen.avatar.color}66`;
  }
}
