'use strict';
// Tiny JSON settings store kept in the app's userData folder.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Sight
  watching: false,             // Off = Claude sees nothing unless you press "Share screen".
  captureDisplay: 'cursor',    // 'cursor' | 'primary' | 'all'
  captureMaxEdge: 1920,        // long edge of screenshots sent to Claude (px)
  jpegQuality: 82,
  hideSelfFromCapture: true,   // keep The Pill's own windows out of screenshots (macOS / Windows)
  rewindEnabled: true,         // keep a short in-memory history while watching
  rewindIntervalSec: 20,
  rewindFrames: 8,
  pauseWhenIdleSec: 180,       // stop recording rewind frames when you're away

  // Windows
  pillPos: null,
  chatBounds: null,
  chatSize: null,              // remembered chat size; it always opens where the pill is
  docked: false,               // true = classic side panel instead of opening in place
  pinned: true,                // chat stays on top of everything
  opacity: 1,

  // Chats
  restoreLastChat: true,
  lastUrl: null,

  // App
  launchAtLogin: false,
  firstRun: true,
};

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'thepill-settings.json');
    this.data = { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const k of Object.keys(DEFAULTS)) if (k in raw) this.data[k] = raw[k];
    } catch { /* first run or unreadable: use defaults */ }
    this._timer = null;
  }

  get(key) { return this.data[key]; }

  all() { return { ...this.data }; }

  set(patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS)) continue;
      if (JSON.stringify(this.data[k]) !== JSON.stringify(v)) { this.data[k] = v; changed = true; }
    }
    if (changed) this._scheduleSave();
    return changed;
  }

  _scheduleSave() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[thepill] could not save settings:', err.message);
    }
  }
}

module.exports = { Store, DEFAULTS };
