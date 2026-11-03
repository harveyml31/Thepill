'use strict';
/*
 * Shadow mode: learns how you work by recording, on this computer only:
 *  - what you type (rebuilt into text, with your edits applied), never in password managers,
 *    login pages or calls, and with password-like strings removed
 *  - which app / window / site is in front, and for how long
 *  - clicks, copy -> paste between apps
 *  - typing and mouse rhythm (speed, pauses, corrections, mouse distance)
 *  - a screen snapshot about once a minute when something changed (optional)
 */
const { EventEmitter } = require('events');
const { clipboard } = require('electron');
const { KEY, MODIFIERS, CURSOR_KEYS, layoutFor, charFor } = require('./keymap');
const { classifyContext, redactTyped, DEFAULT_NEVER_RECORD } = require('./privacy');
const { watchActiveWindow } = require('./activewin');
const { dayOf } = require('./vault');

const TYPING_IDLE_MS = 20000;

function emptyMinute() {
  return { keys: 0, chars: 0, bksp: 0, ikiSum: 0, ikiN: 0, dwellSum: 0, dwellN: 0, mouseDist: 0, clicks: 0, right: 0, dbl: 0, scroll: 0, shortcuts: {} };
}

class Shadow extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => object} o.getSettings
   * @param {import('./vault').Vault} o.vault
   * @param {() => Promise<{jpeg: Buffer, fp: Uint8Array}|null>} [o.captureFrame]
   * @param {(a: Uint8Array, b: Uint8Array) => number} [o.difference]
   * @param {object} [o.hook] uiohook (injectable for tests)
   * @param {Function} [o.watchWindow] (injectable for tests)
   * @param {string} [o.locale]
   */
  constructor(o) {
    super();
    this.getSettings = o.getSettings;
    this.vault = o.vault;
    this.captureFrame = o.captureFrame || (async () => null);
    this.difference = o.difference || (() => 1);
    this.hook = o.hook || null;
    this.watchWindow = o.watchWindow || watchActiveWindow;
    this.locale = o.locale || '';
    this.running = false;
    this.pausedUntil = 0;
    this.error = null;
    this.ctx = { app: '', title: '', url: '', kind: 'normal' };
    this._reset();
  }

  _reset() {
    this.buf = null;
    this.selectAll = false;
    this.caps = false;
    this.lastKeyAt = 0;
    this.downAt = new Map();
    this.mouse = null;
    this.minute = emptyMinute();
    this.lastCopy = null;
    this.lastFrameFp = null;
    this.today = { day: dayOf(), words: 0, sent: 0, clicks: 0, copies: 0, activeMin: 0, frames: 0, hidden: 0 };
  }

  // ---------------------------------------------------------------- lifecycle
  start() {
    if (this.running) return;
    this.error = null;
    if (!this.hook) this.hook = require('uiohook-napi').uIOhook;
    this.layout = layoutFor(this.getSettings().keyboardLayout, this.locale);
    this._on = {
      keydown: (e) => this._keydown(e),
      keyup: (e) => this._keyup(e),
      mousemove: (e) => this._move(e),
      click: (e) => this._click(e),
      wheel: (e) => this._wheel(e),
    };
    for (const [k, fn] of Object.entries(this._on)) this.hook.on(k, fn);
    try {
      this.hook.start();
    } catch (err) {
      for (const [k, fn] of Object.entries(this._on)) this.hook.removeListener(k, fn);
      this.error = err.message;
      this._status();
      throw err;
    }
    this.stopWindow = this.watchWindow((w) => this._window(w));
    this.timers = [
      setInterval(() => this._flushMinute(), 60000),
      setInterval(() => this._idleCheck(), 2000),
      setInterval(() => this._frame().catch(() => {}), 60000),
    ];
    this.running = true;
    this._log({ type: 'start' });
    this._status();
  }

  stop() {
    if (!this.running) return;
    this._flushTyping('stop');
    this._flushMinute();
    this._log({ type: 'stop' });
    for (const t of this.timers || []) clearInterval(t);
    if (this.stopWindow) this.stopWindow();
    for (const [k, fn] of Object.entries(this._on || {})) this.hook.removeListener(k, fn);
    try { this.hook.stop(); } catch { /* already stopped */ }
    this.running = false;
    this._status();
  }

  pause(ms) {
    this._flushTyping('pause');
    this.pausedUntil = ms ? Date.now() + ms : 0;
    if (ms) this._log({ type: 'pause', until: this.pausedUntil });
    this._status();
  }

  status() {
    const s = this.getSettings();
    let mode = 'off';
    if (this.error) mode = 'error';
    else if (this.running) {
      if (this._paused()) mode = 'paused';
      else if (this.ctx.kind === 'call') mode = 'call';
      else if (this.ctx.kind === 'private') mode = 'private';
      else mode = 'recording';
    }
    return { enabled: !!s.shadowEnabled, running: this.running, mode, pausedUntil: this.pausedUntil, error: this.error, today: { ...this.today } };
  }

  _status() {
    clearTimeout(this._statusT);
    this._statusT = setTimeout(() => this.emit('status', this.status()), 150);
  }

  _paused() { return this.pausedUntil && Date.now() < this.pausedUntil; }

  /** Is the window in front one we may record from at all? */
  _allowed() { return this.running && !this._paused() && this.ctx.kind !== 'call' && this.ctx.kind !== 'private'; }

  _log(ev) {
    const t = ev.t || Date.now();
    const day = dayOf(t);
    if (day !== this.today.day) this.today = { day, words: 0, sent: 0, clicks: 0, copies: 0, activeMin: 0, frames: 0, hidden: 0 };
    try { this.vault.append({ t, ...ev }); } catch (err) { this.error = `Couldn’t save: ${err.message}`; }
  }

  // ---------------------------------------------------------------- windows
  _window(w) {
    this._flushTyping('switch');
    const s = this.getSettings();
    const kind = classifyContext(w, Array.isArray(s.shadowNever) ? s.shadowNever : DEFAULT_NEVER_RECORD);
    this.ctx = { app: w.app || '', title: w.title || '', url: w.url || '', kind };
    this.selectAll = false;
    if (!this.running || this._paused()) return;
    if (kind === 'call') this._log({ type: 'focus', kind, app: 'Call', title: '' });
    else if (kind === 'private') this._log({ type: 'focus', kind, app: 'Private', title: '' });
    else this._log({ type: 'focus', kind, app: this.ctx.app, title: this.ctx.title, url: this.ctx.url });
    this._status();
  }

  // ---------------------------------------------------------------- keyboard
  _keydown(e) {
    const now = Date.now();
    if (!this._allowed()) return;
    const m = this.minute;
    if (this.lastKeyAt && now - this.lastKeyAt < 2000) { m.ikiSum += now - this.lastKeyAt; m.ikiN++; }
    this.lastKeyAt = now;
    this.downAt.set(e.keycode, now);
    m.keys++;

    if (e.keycode === KEY.CapsLock) { this.caps = !this.caps; return; }
    if (MODIFIERS.has(e.keycode)) return;

    if (e.ctrlKey || e.metaKey) {
      const name = this._shortcutName(e);
      m.shortcuts[name] = (m.shortcuts[name] || 0) + 1;
      if (e.keycode === KEY.C || e.keycode === KEY.X) setTimeout(() => this._copied(), 120);
      else if (e.keycode === KEY.V) this._pasted();
      else if (e.keycode === KEY.A) this.selectAll = true;
      else if (e.keycode === KEY.Backspace) this._deleteWord();
      else if (e.keycode === KEY.Z && this.buf) this.buf.edited = true;
      return;
    }
    if (e.altKey && e.keycode === KEY.Backspace) { this._deleteWord(); return; }

    if (e.keycode === KEY.Enter || e.keycode === KEY.NumpadEnter) {
      if (e.shiftKey) { this._type('\n'); return; }
      this._flushTyping('enter', true);
      return;
    }
    if (e.keycode === KEY.Tab) { this._flushTyping('tab', true); return; }
    if (e.keycode === KEY.Backspace) {
      m.bksp++;
      if (!this.buf) return;
      this.buf.bksp++;
      if (this.selectAll) { this.buf.text = ''; this.selectAll = false; } else this.buf.text = this.buf.text.slice(0, -1);
      this.buf.t1 = now;
      return;
    }
    if (e.keycode === KEY.Delete || CURSOR_KEYS.has(e.keycode)) { if (this.buf) this.buf.edited = true; this.selectAll = false; return; }
    if (e.keycode === KEY.Escape) return;

    const ch = charFor(this.layout, e.keycode, e.shiftKey, this.caps);
    if (ch) { m.chars++; this._type(ch); }
  }

  _keyup(e) {
    const t0 = this.downAt.get(e.keycode);
    if (t0) { this.downAt.delete(e.keycode); const d = Date.now() - t0; if (d < 1500) { this.minute.dwellSum += d; this.minute.dwellN++; } }
  }

  _shortcutName(e) {
    const mod = e.metaKey ? 'Cmd' : 'Ctrl';
    const names = { [KEY.C]: 'C', [KEY.V]: 'V', [KEY.X]: 'X', [KEY.A]: 'A', [KEY.Z]: 'Z', [KEY.Tab]: 'Tab', [KEY.Enter]: 'Enter', [KEY.Backspace]: 'Backspace' };
    const ch = names[e.keycode] || charFor(this.layout, e.keycode, false, false) || `#${e.keycode}`;
    return `${mod}${e.shiftKey ? '+Shift' : ''}+${String(ch).toUpperCase()}`;
  }

  _type(ch) {
    const now = Date.now();
    if (!this.buf) this.buf = { text: '', t0: now, t1: now, keys: 0, bksp: 0, edited: false, pasted: 0, ctx: { ...this.ctx } };
    if (this.selectAll) { this.buf.text = ''; this.selectAll = false; }
    this.buf.text += ch;
    this.buf.keys++;
    this.buf.t1 = now;
  }

  _deleteWord() {
    if (!this.buf) return;
    this.buf.text = this.buf.text.replace(/\S*\s*$/, '');
    this.buf.bksp++;
  }

  _copied() {
    if (!this._allowed() || this.ctx.kind === 'login') return;
    let text = '';
    try { text = clipboard.readText() || ''; } catch { /* clipboard busy */ }
    if (!text.trim()) return;
    const clean = redactTyped(text.slice(0, 300)).text;
    this.lastCopy = { t: Date.now(), app: this.ctx.app, title: this.ctx.title, url: this.ctx.url };
    this.today.copies++;
    this._log({ type: 'copy', app: this.ctx.app, title: this.ctx.title, url: this.ctx.url, len: text.length, text: clean });
  }

  _pasted() {
    if (this.ctx.kind === 'login') return;
    let len = 0;
    try { len = (clipboard.readText() || '').length; } catch { /* ignore */ }
    const from = this.lastCopy && Date.now() - this.lastCopy.t < 10 * 60000 ? this.lastCopy : null;
    this._log({ type: 'paste', app: this.ctx.app, title: this.ctx.title, url: this.ctx.url, len, fromApp: from ? from.app : null, fromTitle: from ? from.title : null });
    if (len) { this._type(`[pasted ${len} chars]`); this.buf.pasted += len; }
  }

  _flushTyping(via, submitted = false) {
    const b = this.buf;
    this.buf = null;
    this.selectAll = false;
    if (!b || !b.text.trim()) return;
    if (b.ctx.kind === 'login') { this.today.hidden++; this._log({ type: 'typed', t: b.t0, hidden: 'login', chars: b.text.length, app: b.ctx.app }); return; }
    if (b.ctx.kind === 'call' || b.ctx.kind === 'private') return;
    const { text, redacted } = redactTyped(b.text, { submitted });
    if (!text) { this.today.hidden++; this._log({ type: 'typed', t: b.t0, hidden: 'secret', chars: b.text.length, app: b.ctx.app }); return; }
    const words = (text.match(/[A-Za-z0-9’']+/g) || []).length;
    this.today.words += words;
    if (submitted && via === 'enter' && words >= 2) this.today.sent++;
    this._log({
      type: 'typed', t: b.t0, t1: b.t1, app: b.ctx.app, title: b.ctx.title, url: b.ctx.url,
      text, words, keys: b.keys, bksp: b.bksp, edited: b.edited, pasted: b.pasted, via, submitted, redacted,
    });
    this._status();
  }

  _idleCheck() {
    if (this.buf && Date.now() - this.buf.t1 > TYPING_IDLE_MS) this._flushTyping('pause');
    if (this.pausedUntil && Date.now() >= this.pausedUntil) { this.pausedUntil = 0; this._log({ type: 'resume' }); this._status(); }
  }

  // ---------------------------------------------------------------- mouse
  _move(e) {
    if (!this._allowed()) { this.mouse = null; return; }
    if (this.mouse) this.minute.mouseDist += Math.hypot(e.x - this.mouse.x, e.y - this.mouse.y);
    this.mouse = { x: e.x, y: e.y };
  }

  _click(e) {
    if (!this._allowed()) return;
    this._flushTyping('click');
    const right = e.button === 2;
    this.minute.clicks++;
    if (right) this.minute.right++;
    if (e.clicks >= 2) this.minute.dbl++;
    this.today.clicks++;
    this._log({ type: 'click', x: e.x, y: e.y, button: right ? 'right' : (e.button === 3 ? 'middle' : 'left'), n: e.clicks, app: this.ctx.app, title: this.ctx.title, url: this.ctx.url });
  }

  _wheel(e) { if (this._allowed()) this.minute.scroll += Math.abs((e.rotation || 1) * (e.amount || 1)); }

  // ---------------------------------------------------------------- per-minute rhythm + snapshots
  _flushMinute() {
    const m = this.minute;
    this.minute = emptyMinute();
    if (!m.keys && !m.clicks && m.mouseDist < 5 && !m.scroll) return;
    this.today.activeMin++;
    this._log({
      type: 'minute', app: this.ctx.kind === 'normal' || this.ctx.kind === 'login' ? this.ctx.app : this.ctx.kind,
      keys: m.keys, chars: m.chars, bksp: m.bksp,
      iki: m.ikiN ? Math.round(m.ikiSum / m.ikiN) : null, dwell: m.dwellN ? Math.round(m.dwellSum / m.dwellN) : null,
      mouse: Math.round(m.mouseDist), clicks: m.clicks, right: m.right, dbl: m.dbl, scroll: Math.round(m.scroll), shortcuts: m.shortcuts,
    });
    this._status();
  }

  async _frame() {
    if (!this.getSettings().shadowFrames || !this._allowed() || this.ctx.kind === 'login') return;
    const shot = await this.captureFrame();
    if (!shot) return;
    if (this.lastFrameFp && this.difference(this.lastFrameFp, shot.fp) < 0.003) return;
    this.lastFrameFp = shot.fp;
    const name = this.vault.saveFrame(shot.jpeg);
    this.today.frames++;
    this._log({ type: 'frame', name, app: this.ctx.app, title: this.ctx.title });
  }
}

module.exports = { Shadow };
