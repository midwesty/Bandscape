// ============================================================
// placeholder.js — the "drop in art later" system.
//
// applyArt(imgEl, path, label) tries to load the real file at `path`.
// If it's missing (404/not added yet), it swaps in a generated SVG
// placeholder labeled with `label`. So: reference assets by path in
// your JSON now, drop the real PNGs into the named slots whenever,
// and they appear automatically with zero code changes.
// ============================================================

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

export function placeholderDataURI(label = "?", size = 96) {
  const hue = hashHue(label);
  const initials = label.replace(/[^a-zA-Z0-9 ]/g, "").trim().split(/\s+/)
    .map((w) => w[0]).join("").slice(0, 3).toUpperCase() || "?";
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <pattern id="hatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
        <rect width="8" height="8" fill="hsl(${hue},55%,22%)"/>
        <line x1="0" y1="0" x2="0" y2="8" stroke="hsl(${hue},60%,30%)" stroke-width="3"/>
      </pattern>
    </defs>
    <rect width="${size}" height="${size}" fill="url(#hatch)"/>
    <rect x="3" y="3" width="${size - 6}" height="${size - 6}" fill="none"
          stroke="hsl(${hue},80%,65%)" stroke-width="3" stroke-dasharray="6 4"/>
    <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle"
          font-family="Impact, 'Arial Narrow', sans-serif" font-size="${size * 0.34}"
          fill="hsl(${hue},90%,80%)" letter-spacing="1">${initials}</text>
  </svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg.trim());
}

// Attach to an <img>: load real file, fall back to placeholder on error.
export function applyArt(imgEl, path, label) {
  if (!imgEl) return;
  imgEl.alt = label || "";
  imgEl.onerror = () => {
    imgEl.onerror = null;
    imgEl.src = placeholderDataURI(label || "?", 96);
    imgEl.dataset.placeholder = "1";
  };
  imgEl.src = path || placeholderDataURI(label || "?", 96);
}
