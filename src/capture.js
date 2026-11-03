'use strict';
// Screen capture + the "Rewind" memory (a short, RAM-only history of your screen).
const { desktopCapturer, screen, powerMonitor } = require('electron');

function pickDisplays(which) {
  const all = screen.getAllDisplays();
  if (which === 'all') return all;
  if (which === 'primary') return [screen.getPrimaryDisplay()];
  return [screen.getDisplayNearestPoint(screen.getCursorScreenPoint())];
}

/**
 * Capture one image per selected display.
 * Returns [{ image: NativeImage, display, at }].
 */
async function captureDisplays({ which = 'cursor', maxEdge = 1920 } = {}) {
  const targets = pickDisplays(which);
  const all = screen.getAllDisplays();
  // Ask for thumbnails as large as the biggest physical display we need (capped).
  let w = 0; let h = 0;
  for (const d of targets) {
    w = Math.max(w, Math.round(d.size.width * d.scaleFactor));
    h = Math.max(h, Math.round(d.size.height * d.scaleFactor));
  }
  const scale = Math.min(1, (maxEdge * 1.5) / Math.max(w, h)); // a little headroom, resized below
  const thumbnailSize = { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };

  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  if (!sources.length) throw new Error('No screens available to capture');

  const at = Date.now();
  const out = [];
  for (const d of targets) {
    let src = sources.find((s) => s.display_id && s.display_id === String(d.id));
    if (!src) {
      // Some platforms leave display_id empty: fall back to ordering.
      const idx = all.findIndex((x) => x.id === d.id);
      src = sources[idx] || sources[0];
    }
    let image = src.thumbnail;
    if (image.isEmpty()) continue;
    const size = image.getSize();
    const long = Math.max(size.width, size.height);
    if (long > maxEdge) {
      const f = maxEdge / long;
      image = image.resize({ width: Math.round(size.width * f), height: Math.round(size.height * f), quality: 'best' });
    }
    out.push({ image, display: d, at });
  }
  if (!out.length) throw new Error('Screen capture returned an empty image (screen recording permission?)');
  return out;
}

function stamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

/**
 * Small greyscale fingerprint so Rewind only keeps frames where something changed.
 * 160x90 is fine enough to notice new text, a dialog or a different table, and coarse
 * enough that a ticking clock or a blinking cursor doesn't count.
 */
const FP_W = 160;
const FP_H = 90;
function fingerprint(image) {
  const tiny = image.resize({ width: FP_W, height: FP_H, quality: 'good' });
  const bmp = tiny.toBitmap();
  const out = new Uint8Array(bmp.length / 4);
  for (let i = 0, j = 0; i < bmp.length; i += 4, j++) out[j] = (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3;
  return out;
}

/** Share of the screen (0..1) that visibly changed between two fingerprints. */
function difference(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 12) changed++;
  return changed / a.length;
}
const MIN_CHANGE = 0.003; // ~0.3% of the screen: a new line of text, not a clock tick

class Rewind {
  constructor({ getSettings, onChange, beforeCapture, afterCapture }) {
    this.getSettings = getSettings;
    this.onChange = onChange || (() => {});
    this.beforeCapture = beforeCapture || (async () => {});
    this.afterCapture = afterCapture || (() => {});
    this.frames = []; // { jpeg: Buffer, at, fp }
    this.timer = null;
    this.paused = false;
    this.busy = false;
  }

  get running() { return !!this.timer; }

  start() {
    if (this.timer) return;
    const tick = () => this.tick().catch((err) => console.warn('[thepill] rewind:', err.message));
    const ms = Math.max(5, Number(this.getSettings().rewindIntervalSec) || 20) * 1000;
    this.timer = setInterval(tick, ms);
    setTimeout(tick, 1500);
  }

  stop({ clear = true } = {}) {
    clearInterval(this.timer);
    this.timer = null;
    if (clear && this.frames.length) { this.frames = []; this.onChange(this.frames.length); }
  }

  restart() { const was = this.running; this.stop({ clear: false }); if (was) this.start(); }

  async tick() {
    const s = this.getSettings();
    if (this.paused || this.busy) return;
    const idleLimit = Number(s.pauseWhenIdleSec) || 0;
    if (idleLimit > 0 && powerMonitor.getSystemIdleTime() >= idleLimit) return;
    this.busy = true;
    try {
      await this.beforeCapture();
      let shots;
      try {
        shots = await captureDisplays({ which: 'cursor', maxEdge: 1280 });
      } finally {
        this.afterCapture();
      }
      const shot = shots[0];
      const fp = fingerprint(shot.image);
      const last = this.frames[this.frames.length - 1];
      if (last && difference(last.fp, fp) < MIN_CHANGE) { last.seenAt = shot.at; return; }
      this.frames.push({ jpeg: shot.image.toJPEG(72), at: shot.at, seenAt: shot.at, fp });
      const max = Math.max(2, Number(s.rewindFrames) || 8);
      while (this.frames.length > max) this.frames.shift();
      this.onChange(this.frames.length);
    } finally {
      this.busy = false;
    }
  }

  snapshot() {
    return this.frames.map((f) => ({ jpeg: f.jpeg, at: f.at }));
  }
}

module.exports = { captureDisplays, Rewind, stamp, fingerprint, difference, MIN_CHANGE };
