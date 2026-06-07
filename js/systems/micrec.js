// ============================================================
// micrec.js — device-microphone capture (getUserMedia +
// MediaRecorder). Used by the SOUND app to record vocal/audio
// clips. The browser picks the codec (webm/opus on Chrome,
// mp4/aac on Safari) so clips decode on the same device.
//
// Requires a secure context: https, or http://localhost.
// ============================================================

let stream = null, rec = null, chunks = [], stopTimer = null, cancelled = false;

export function micSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

export async function ensureMic() {
  if (stream && stream.active) return stream;
  if (!micSupported()) throw new Error("unsupported");
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return stream;
}

// Record for durationMs, then auto-stop. Resolves with a Blob.
// Rejects with Error("cancelled") if cancelClip() is called first.
export function recordClip(durationMs) {
  return new Promise(async (resolve, reject) => {
    try { await ensureMic(); } catch (e) { return reject(e); }
    cancelled = false; chunks = [];
    try { rec = new MediaRecorder(stream); } catch (e) { return reject(e); }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec && rec.mimeType ? rec.mimeType : "audio/webm" });
      const wasCancelled = cancelled;
      cleanup();
      if (wasCancelled) reject(new Error("cancelled"));
      else resolve(blob);
    };
    rec.start();
    stopTimer = setTimeout(() => { try { rec.stop(); } catch {} }, durationMs);
  });
}

export function cancelClip() {
  cancelled = true;
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  if (rec && rec.state !== "inactive") { try { rec.stop(); } catch {} }
}

export function releaseMic() {
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}

function cleanup() { if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; } rec = null; chunks = []; }

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
