'use strict';
// Encrypted, append-only storage for Shadow mode. Everything stays on this computer.
// Each line of a day file is AES-256-GCM encrypted; the key is protected by the OS keychain
// (Electron safeStorage) where available.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');

const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.log$/;
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

class Vault {
  constructor(dir) {
    this.dir = dir;
    this.framesDir = path.join(dir, 'frames');
    fs.mkdirSync(this.framesDir, { recursive: true });
    this.keyProtected = false;
    this.key = this._loadKey();
  }

  _loadKey() {
    const protectedFile = path.join(this.dir, 'key.bin');
    const plainFile = path.join(this.dir, 'key.local');
    const canProtect = (() => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } })();
    if (fs.existsSync(protectedFile) && canProtect) {
      this.keyProtected = true;
      return Buffer.from(safeStorage.decryptString(fs.readFileSync(protectedFile)), 'base64');
    }
    if (fs.existsSync(plainFile)) return fs.readFileSync(plainFile);
    const key = crypto.randomBytes(32);
    if (canProtect) {
      fs.writeFileSync(protectedFile, safeStorage.encryptString(key.toString('base64')), { mode: 0o600 });
      this.keyProtected = true;
    } else {
      // No OS keychain (some Linux setups): the key sits next to the data, readable only by you.
      fs.writeFileSync(plainFile, key, { mode: 0o600 });
    }
    return key;
  }

  _seal(buf) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(buf), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }

  _open(buf) {
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
  }

  append(event) {
    const line = this._seal(Buffer.from(JSON.stringify(event))).toString('base64') + '\n';
    fs.appendFileSync(path.join(this.dir, `${dayOf(event.t)}.log`), line, { mode: 0o600 });
  }

  saveFrame(jpeg, t = Date.now()) {
    const day = dayOf(t);
    const d = new Date(t);
    const dir = path.join(this.framesDir, day);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.jpg.enc`;
    fs.writeFileSync(path.join(dir, name), this._seal(jpeg), { mode: 0o600 });
    return name;
  }

  readFrame(day, name) { return this._open(fs.readFileSync(path.join(this.framesDir, day, name))); }

  listFrames(day) {
    try { return fs.readdirSync(path.join(this.framesDir, day)).filter((f) => f.endsWith('.jpg.enc')).sort(); } catch { return []; }
  }

  days() {
    return fs.readdirSync(this.dir).map((f) => (f.match(DAY_RE) || [])[1]).filter(Boolean).sort();
  }

  readDay(day) {
    const file = path.join(this.dir, `${day}.log`);
    if (!fs.existsSync(file)) return [];
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(this._open(Buffer.from(line, 'base64')).toString('utf8'))); } catch { /* skip damaged line */ }
    }
    return out;
  }

  deleteDay(day) {
    fs.rmSync(path.join(this.dir, `${day}.log`), { force: true });
    fs.rmSync(path.join(this.framesDir, day), { recursive: true, force: true });
  }

  deleteAll() { for (const d of this.days()) this.deleteDay(d); fs.rmSync(this.framesDir, { recursive: true, force: true }); fs.mkdirSync(this.framesDir, { recursive: true }); }

  /** Remove days older than keepDays, and screen snapshots older than frameDays. */
  prune(keepDays = 14, frameDays = 7) {
    const cutoff = (n) => dayOf(Date.now() - n * 86400000);
    for (const d of this.days()) if (d < cutoff(keepDays)) this.deleteDay(d);
    try {
      for (const d of fs.readdirSync(this.framesDir)) if (d < cutoff(frameDays)) fs.rmSync(path.join(this.framesDir, d), { recursive: true, force: true });
    } catch { /* nothing to prune */ }
  }

  sizeBytes() {
    let total = 0;
    const walk = (p) => { for (const f of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, f.name); if (f.isDirectory()) walk(q); else total += fs.statSync(q).size; } };
    try { walk(this.dir); } catch { /* ignore */ }
    return total;
  }
}

module.exports = { Vault, dayOf };
