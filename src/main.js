'use strict';
/*
 * The Pill — a tiny always-on-top Claude that can see your screen.
 *
 *  - Pill window: a small draggable capsule that floats above everything.
 *  - Chat window: click the pill and it becomes the real claude.ai (your account, your chats),
 *    pinned on top so it doesn't vanish when you click elsewhere.
 *  - Sight: Off (Claude sees nothing unless you press Share screen) or Watching
 *    (every message you send carries a fresh screenshot, plus a short in-memory Rewind).
 */
const path = require('path');
const {
  app, BrowserWindow, WebContentsView, ipcMain, globalShortcut, screen, Tray, Menu,
  nativeImage, shell, clipboard, session, systemPreferences, powerMonitor, nativeTheme,
} = require('electron');
const { Store } = require('./store');
const { captureDisplays, Rewind, stamp, fingerprint, difference } = require('./capture');
const { Vault, dayOf } = require('./shadow/vault');
const { Shadow } = require('./shadow/recorder');
const digest = require('./shadow/digest');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const IS_WAYLAND = IS_LINUX && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

const OVERRIDE_URL = process.env.PILL_CLAUDE_URL || null; // for testing against a local page
const CLAUDE_ORIGIN = 'https://claude.ai';
const PARTITION = 'persist:claude';
const PROTOCOL = 'thepill';
const TOOLBAR_H = 48;
const SETTINGS_W = 372;
const PILL_W = 180;  // compact pill (capsule is 164x44; the rest is room for its shadow)
const BAR_W = 516;   // pill stretched into a prompt bar
const PILL_H = 60;
const CHAT_SIZE = { width: 440, height: 640 };

const SHORTCUTS = {
  toggleChat: 'CommandOrControl+Shift+Space',
  shareScreen: 'CommandOrControl+Shift+Alt+S',
  toggleWatching: 'CommandOrControl+Shift+Alt+W',
};

const ASSETS = path.join(__dirname, '..', 'assets');
const UI = path.join(__dirname, 'ui');

let store;
let rewind;
let pillWin = null;
let chatWin = null;
let claudeView = null;
let settingsView = null;
let settingsOpen = false;
let settingsHideTimer = null;
let tray = null;
let vault = null;
let shadow = null;
let quitting = false;
let overlayPx = 0;
let viewReady = false;
let pendingProtocolUrl = null;
let pillMode = 'pill'; // 'pill' | 'bar'
const shortcutStatus = {};

if (IS_LINUX) app.commandLine.appendSwitch('enable-transparent-visuals');

// ---------------------------------------------------------------- single instance + protocol
if (process.argv.includes('--self-test')) {
  // self-test runs alongside a normal copy
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) handleProtocolUrl(url); else expand();
  });
}
app.on('open-url', (e, url) => { e.preventDefault(); handleProtocolUrl(url); });

function registerProtocol() {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      return app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
    return app.setAsDefaultProtocolClient(PROTOCOL);
  } catch { return false; }
}

function handleProtocolUrl(raw) {
  if (!app.isReady() || !chatWin) { pendingProtocolUrl = raw; return; }
  let u;
  try { u = new URL(raw); } catch { return; }
  const action = (u.hostname || u.pathname.replace(/^\/+/, '')).toLowerCase();
  if (action === 'open') {
    const target = u.searchParams.get('url');
    if (target && openClaudeLink(target)) return;
    expand();
  } else if (action === 'share') {
    shareScreen();
  } else if (action === 'watch') {
    setWatching(true);
  } else {
    expand();
  }
}

// ---------------------------------------------------------------- helpers
function isClaudeUrl(u) {
  try {
    const url = new URL(u);
    if (OVERRIDE_URL && u.startsWith(new URL(OVERRIDE_URL).origin)) return true;
    return url.protocol === 'https:' && (url.hostname === 'claude.ai' || url.hostname.endsWith('.claude.ai'));
  } catch { return false; }
}

function isClaudeChatUrl(u) {
  return isClaudeUrl(u) && /\/(chat|project)\//.test(new URL(u).pathname);
}

function urlFor(kind) {
  if (OVERRIDE_URL) return OVERRIDE_URL;
  if (kind === 'recents') return `${CLAUDE_ORIGIN}/recents`;
  return `${CLAUDE_ORIGIN}/new`;
}

function startUrl() {
  if (OVERRIDE_URL) return OVERRIDE_URL;
  const last = store.get('lastUrl');
  if (store.get('restoreLastChat') && last && isClaudeUrl(last)) return last;
  return urlFor('new');
}

function trayImage(watching) {
  const img = nativeImage.createFromPath(path.join(ASSETS, watching ? 'tray-watching.png' : 'tray.png'));
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function displayOf(win) {
  if (!win) return screen.getPrimaryDisplay();
  return screen.getDisplayMatching(win.getBounds());
}

function onScreen(rect) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return rect.x + 40 > a.x && rect.y + 20 > a.y && rect.x < a.x + a.width - 20 && rect.y < a.y + a.height - 20;
  });
}

function prettyShortcut(acc) {
  return acc
    .replace('CommandOrControl', IS_MAC ? '⌘' : 'Ctrl')
    .replace('Shift', IS_MAC ? '⇧' : 'Shift')
    .replace('Alt', IS_MAC ? '⌥' : 'Alt')
    .replace(/\+/g, IS_MAC ? '' : '+');
}

function send(win, channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function toast(text, kind = 'info', action = null) {
  send(chatWin, 'ui:toast', { text, kind, action });
  send(pillWin, 'ui:toast', { text, kind, action });
}

function flash(kind = 'capture') {
  send(chatWin, 'ui:flash', kind);
  send(pillWin, 'ui:flash', kind);
}

// ---------------------------------------------------------------- state
function uiState() {
  const s = store.all();
  const url = claudeView ? claudeView.webContents.getURL() : '';
  return {
    watching: s.watching,
    rewindEnabled: s.rewindEnabled,
    rewindCount: rewind ? rewind.frames.length : 0,
    pinned: s.pinned,
    docked: s.docked,
    settingsOpen,
    anchor: pillWin && cornerOf(pillWin.getBounds()).right ? 'right' : 'left',
    pillMode,
    shadow: shadow ? shadow.status() : { enabled: !!s.shadowEnabled, running: false, mode: 'off', today: null },
    opacity: s.opacity,
    chatOpen: !!(chatWin && chatWin.isVisible()),
    url,
    isChat: isClaudeChatUrl(url),
    canGoBack: !!(claudeView && claudeView.webContents.navigationHistory.canGoBack()),
    platform: process.platform,
    wayland: IS_WAYLAND,
    shortcuts: Object.fromEntries(Object.entries(SHORTCUTS).map(([k, v]) => [k, { keys: prettyShortcut(v), ok: shortcutStatus[k] !== false }])),
    settings: s,
    version: require('../package.json').version,
  };
}

function broadcastState() {
  const st = uiState();
  send(chatWin, 'ui:state', st);
  send(pillWin, 'ui:state', st);
  if (settingsView) settingsView.webContents.send('ui:state', st);
  if (claudeView) claudeView.webContents.send('pill:state', { watching: st.watching });
  if (tray) {
    tray.setImage(trayImage(st.watching));
    tray.setToolTip(st.watching ? 'The Pill — watching your screen' : 'The Pill — screen off');
    tray.setContextMenu(buildMenu());
  }
}

function applySettings(patch) {
  const before = store.all();
  store.set(patch);
  const s = store.all();

  if ('watching' in patch && patch.watching !== before.watching) {
    if (s.watching) {
      checkScreenPermission();
      if (s.rewindEnabled) rewind.start();
    } else {
      rewind.stop({ clear: true });
    }
  }
  if ('rewindEnabled' in patch) {
    if (s.rewindEnabled && s.watching) rewind.start(); else rewind.stop({ clear: !s.rewindEnabled });
  }
  if ('rewindIntervalSec' in patch) rewind.restart();
  if ('shadowEnabled' in patch && !!patch.shadowEnabled !== !!before.shadowEnabled) setShadow(!!patch.shadowEnabled);
  if ('keyboardLayout' in patch && shadow && shadow.running) { shadow.stop(); shadow.start(); }
  if ('shadowRetentionDays' in patch && vault) vault.prune(Number(s.shadowRetentionDays) || 14, 7);
  if ('pinned' in patch && chatWin) setChatOnTop(s.pinned);
  if ('opacity' in patch && chatWin && !IS_LINUX) chatWin.setOpacity(Math.min(1, Math.max(0.35, Number(s.opacity) || 1)));
  if ('hideSelfFromCapture' in patch) applyContentProtection();
  if ('launchAtLogin' in patch && !IS_LINUX) app.setLoginItemSettings({ openAtLogin: !!s.launchAtLogin });

  broadcastState();
}

function setWatching(on) {
  applySettings({ watching: !!on });
  toast(on ? 'Watching — every message now includes your screen' : 'Screen off — Claude can’t see anything', on ? 'watch' : 'info');
}

function checkScreenPermission() {
  if (!IS_MAC) return true;
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'granted') return true;
  toast('macOS needs Screen Recording permission for The Pill', 'warn', { label: 'Open settings', id: 'screen-settings' });
  return false;
}

function applyContentProtection() {
  const on = !!store.get('hideSelfFromCapture');
  for (const w of [pillWin, chatWin]) if (w && !w.isDestroyed()) w.setContentProtection(on);
}

// ---------------------------------------------------------------- windows
/**
 * The Pill hides from the Dock on macOS, so it has no visible Edit menu and Cmd+C/V/X/A/Z
 * may not reach the page. Handle them directly so copy and paste always work.
 */
function editShortcuts(wc) {
  if (!IS_MAC) return;
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.meta || input.control || input.alt) return;
    const k = String(input.key || '').toLowerCase();
    const action = { c: 'copy', x: 'cut', a: 'selectAll', v: input.shift ? 'pasteAndMatchStyle' : 'paste', z: input.shift ? 'redo' : 'undo' }[k];
    if (action) { wc[action](); e.preventDefault(); }
  });
}

function createPill() {
  const wa = screen.getPrimaryDisplay().workArea;
  let pos = store.get('pillPos');
  if (!pos || !onScreen({ ...pos, width: PILL_W, height: PILL_H })) {
    pos = { x: wa.x + wa.width - PILL_W - 24, y: wa.y + wa.height - PILL_H - 24 };
  }
  pillWin = new BrowserWindow({
    x: pos.x, y: pos.y, width: PILL_W, height: PILL_H,
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
    fullscreenable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false,
    backgroundColor: '#00000000', title: 'The Pill',
    webPreferences: { preload: path.join(__dirname, 'preload-ui.js'), contextIsolation: true, sandbox: true },
  });
  pillWin.setAlwaysOnTop(true, 'screen-saver');
  if (IS_MAC) pillWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pillWin.loadFile(path.join(UI, 'pill.html'));
  editShortcuts(pillWin.webContents);
  pillWin.on('close', (e) => { if (!quitting) e.preventDefault(); });
}

function defaultChatBounds(display = displayOf(pillWin)) {
  const wa = display.workArea;
  const width = Math.min(460, Math.max(360, Math.round(wa.width * 0.28)));
  return { x: wa.x + wa.width - width - 10, y: wa.y + 10, width, height: wa.height - 20 };
}

/** Which corner of the screen a rect lives in — things grow away from that corner. */
function cornerOf(rect) {
  const wa = screen.getDisplayMatching(rect).workArea;
  return {
    right: rect.x + rect.width / 2 > wa.x + wa.width / 2,
    bottom: rect.y + rect.height / 2 > wa.y + wa.height / 2,
    wa,
  };
}

/** Resize `anchor` to `size` while keeping its screen-corner side fixed ("opens where it is"). */
function growFrom(anchor, size) {
  const { right, bottom, wa } = cornerOf(anchor);
  const width = Math.min(size.width, wa.width - 20);
  const height = Math.min(size.height, wa.height - 20);
  let x = right ? anchor.x + anchor.width - width : anchor.x;
  let y = bottom ? anchor.y + anchor.height - height : anchor.y;
  x = Math.min(Math.max(wa.x + 4, x), wa.x + wa.width - width - 4);
  y = Math.min(Math.max(wa.y + 4, y), wa.y + wa.height - height - 4);
  return { x: Math.round(x), y: Math.round(y), width, height };
}

function chatSize() {
  const s = store.get('chatSize');
  return s && s.width >= 340 && s.height >= 360 ? s : CHAT_SIZE;
}

function setPillMode(mode) {
  if (!pillWin) return;
  pillMode = mode === 'bar' ? 'bar' : 'pill';
  const b = pillWin.getBounds();
  const target = growFrom(b, { width: pillMode === 'bar' ? BAR_W : PILL_W, height: PILL_H });
  pillWin.setResizable(true);
  pillWin.setBounds(target);
  pillWin.setResizable(false);
  if (pillMode === 'bar') { pillWin.focus(); send(pillWin, 'ui:toast', { kind: 'focus-prompt' }); }
  broadcastState();
}

function createChat() {
  let b = store.get('chatBounds');
  if (!b || !onScreen(b)) b = store.get('docked') ? defaultChatBounds(screen.getPrimaryDisplay()) : null;
  chatWin = new BrowserWindow({
    ...(b || CHAT_SIZE),
    minWidth: 340, minHeight: 360, frame: false, show: false, title: 'Claude — The Pill',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5', roundedCorners: true, alwaysOnTop: !!store.get('pinned'), skipTaskbar: false,
    icon: path.join(ASSETS, 'icon-256.png'), fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload-ui.js'), contextIsolation: true, sandbox: true },
  });
  setChatOnTop(!!store.get('pinned'));
  if (!IS_LINUX) chatWin.setOpacity(Math.min(1, Math.max(0.35, Number(store.get('opacity')) || 1)));
  chatWin.loadFile(path.join(UI, 'chat.html'));

  claudeView = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload-claude.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
    },
  });
  chatWin.contentView.addChildView(claudeView);
  setupClaudeView();
  editShortcuts(claudeView.webContents);

  // Settings float over the chat in their own rounded view (added last, so it sits on top).
  settingsView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload-ui.js'), contextIsolation: true, sandbox: true },
  });
  settingsView.setBackgroundColor('#00000000');
  if (typeof settingsView.setBorderRadius === 'function') settingsView.setBorderRadius(18);
  settingsView.setVisible(false);
  chatWin.contentView.addChildView(settingsView);
  settingsView.webContents.loadFile(path.join(UI, 'settings.html'));
  editShortcuts(settingsView.webContents);
  claudeView.webContents.on('focus', () => { if (settingsOpen) toggleSettings(false); });
  layoutView();

  let saveTimer;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!chatWin || chatWin.isDestroyed() || !chatWin.isVisible()) return;
      const nb = chatWin.getBounds();
      const patch = { chatBounds: nb };
      if (store.get('docked')) {
        const d = defaultChatBounds(displayOf(chatWin));
        if (Math.abs(nb.x + nb.width - (d.x + d.width)) > 24 || Math.abs(nb.height - d.height) > 24) patch.docked = false;
      }
      if (!store.get('docked') && !patch.docked) patch.chatSize = { width: nb.width, height: nb.height };
      applySettings(patch);
    }, 400);
  };
  chatWin.on('resize', () => { layoutView(); saveBounds(); });
  chatWin.on('move', saveBounds);
  chatWin.on('close', (e) => { if (!quitting) { e.preventDefault(); collapse(); } });
  chatWin.on('show', broadcastState);
  chatWin.on('hide', broadcastState);
}

function setChatOnTop(on) {
  chatWin.setAlwaysOnTop(on, 'floating');
  if (IS_MAC) chatWin.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: on });
}

function layoutView() {
  if (!chatWin || !claudeView) return;
  const [w, h] = chatWin.getContentSize();
  const top = TOOLBAR_H + overlayPx;
  claudeView.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
  if (settingsOpen) layoutSettings();
}

function layoutSettings() {
  if (!chatWin || !settingsView) return;
  const [w, h] = chatWin.getContentSize();
  const width = Math.min(SETTINGS_W, w - 16);
  settingsView.setBounds({ x: w - width - 8, y: TOOLBAR_H + 4, width, height: Math.max(200, h - TOOLBAR_H - 12) });
}

function toggleSettings(open = !settingsOpen) {
  if (!settingsView) return;
  settingsOpen = !!open;
  clearTimeout(settingsHideTimer);
  if (settingsOpen) {
    layoutSettings();
    settingsView.setVisible(true);
    settingsView.webContents.focus();
    settingsView.webContents.send('ui:settings', { open: true });
  } else {
    settingsView.webContents.send('ui:settings', { open: false });
    settingsHideTimer = setTimeout(() => { if (!settingsOpen) settingsView.setVisible(false); }, 240);
  }
  broadcastState();
}

function setupClaudeView() {
  const wc = claudeView.webContents;
  const ses = session.fromPartition(PARTITION);

  // Look like the Chrome we are (some sign-in pages refuse "Electron").
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|thepill|The ?Pill)\/\S+/gi, ''));

  const allowedPerms = new Set(['clipboard-read', 'clipboard-sanitized-write', 'media', 'notifications', 'fullscreen']);
  ses.setPermissionRequestHandler((_wc, perm, cb, details) => {
    cb(allowedPerms.has(perm) && isClaudeUrl(details.requestingUrl || details.securityOrigin || ''));
  });
  ses.setPermissionCheckHandler((_wc, perm, origin) => allowedPerms.has(perm) && isClaudeUrl(origin || ''));

  const AUTH_HOSTS = /(^|\.)(claude\.ai|anthropic\.com|google\.com|googleusercontent\.com|apple\.com|microsoftonline\.com|okta\.com|auth0\.com)$/i;
  wc.setWindowOpenHandler(({ url }) => {
    let host = '';
    try { host = new URL(url).hostname; } catch { /* ignore */ }
    if (AUTH_HOSTS.test(host) && /accounts|appleid|login|oauth|auth|sso|signin/i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { parent: chatWin, width: 520, height: 700, autoHideMenuBar: true, alwaysOnTop: true },
      };
    }
    if (isClaudeUrl(url)) { wc.loadURL(url); return { action: 'deny' }; }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const onNav = () => {
    const url = wc.getURL();
    if (isClaudeUrl(url) && !OVERRIDE_URL) store.set({ lastUrl: url });
    broadcastState();
  };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  wc.on('did-start-loading', () => { viewReady = false; });
  wc.on('did-finish-load', () => {
    viewReady = true;
    wc.send('pill:state', { watching: store.get('watching') });
    broadcastState();
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) toast(`Couldn’t load Claude (${desc}). Check your connection.`, 'warn', { label: 'Retry', id: 'reload' });
  });
  wc.on('before-input-event', (e, input) => {
    // Escape while the composer is empty -> collapse back to the pill is too surprising; we only
    // support the global shortcut. Keep Cmd/Ctrl+R for reload.
    if (input.type === 'keyDown' && (input.control || input.meta) && input.key.toLowerCase() === 'r') { wc.reload(); e.preventDefault(); }
  });

  wc.loadURL(startUrl());
}

function waitForView(timeout = 20000) {
  if (viewReady && !claudeView.webContents.isLoading()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const wc = claudeView.webContents;
    const done = () => { clearTimeout(t); wc.removeListener('did-finish-load', done); setTimeout(() => resolve(true), 900); };
    const t = setTimeout(() => { wc.removeListener('did-finish-load', done); resolve(false); }, timeout);
    wc.once('did-finish-load', done);
  });
}

// ---------------------------------------------------------------- expand / collapse
function fadeInChat() {
  const target = IS_LINUX ? 1 : Math.min(1, Math.max(0.35, Number(store.get('opacity')) || 1));
  send(chatWin, 'ui:toast', { kind: 'shown' });
  if (IS_LINUX) { chatWin.show(); return; }
  chatWin.setOpacity(0);
  chatWin.show();
  const start = Date.now();
  const step = () => {
    const t = Math.min(1, (Date.now() - start) / 170);
    chatWin.setOpacity(target * (1 - Math.pow(1 - t, 3)));
    if (t < 1) setTimeout(step, 12);
  };
  step();
}

function expand({ focus = true } = {}) {
  if (!chatWin) return;
  if (!chatWin.isVisible()) {
    // Open right where the pill is, growing away from the nearest screen corner.
    const b = store.get('docked') ? defaultChatBounds(displayOf(pillWin)) : growFrom(pillWin.getBounds(), chatSize());
    chatWin.setBounds(b);
    layoutView();
    fadeInChat();
  }
  if (focus) {
    chatWin.focus();
    claudeView.webContents.focus();
    claudeView.webContents.send('pill:focus-composer');
  }
  if (pillWin && pillWin.isVisible()) pillWin.hide();
  broadcastState();
}

function collapse() {
  if (settingsOpen) { settingsOpen = false; settingsView.setVisible(false); }
  if (chatWin && chatWin.isVisible()) {
    if (!store.get('docked')) {
      // Shrink back into a pill at the chat's corner (so if you moved the chat, the pill follows).
      const cb = chatWin.getBounds();
      const p = growFrom(cb, { width: PILL_W, height: PILL_H });
      pillWin.setBounds(p);
      store.set({ pillPos: { x: p.x, y: p.y } });
    }
    chatWin.hide();
  }
  pillMode = 'pill';
  if (pillWin) {
    const b = pillWin.getBounds();
    if (b.width !== PILL_W) { pillWin.setResizable(true); pillWin.setBounds(growFrom(b, { width: PILL_W, height: PILL_H })); pillWin.setResizable(false); }
    pillWin.showInactive();
  }
  broadcastState();
}

function toggleChat() {
  if (!chatWin) return;
  if (chatWin.isVisible() && chatWin.isFocused()) collapse();
  else expand();
}

function toggleDock() {
  const docked = !store.get('docked');
  if (docked) chatWin.setBounds(defaultChatBounds(displayOf(chatWin.isVisible() ? chatWin : pillWin)));
  else chatWin.setBounds(growFrom(pillWin.getBounds(), chatSize()));
  layoutView();
  applySettings({ docked, chatBounds: chatWin.getBounds() });
}

/** Prompt bar -> open the chat in place and send the question (with the screen if asked). */
async function submitPrompt(text, withScreen) {
  text = String(text || '').trim();
  if (!text) { expand(); return { ok: false }; }
  expand({ focus: true });
  await waitForView();
  const wc = claudeView.webContents;
  const id = ++attachSeq;
  const result = await new Promise((resolve) => {
    const t = setTimeout(() => { attachWaiters.delete(id); resolve({ ok: false, error: 'Claude didn’t respond in time' }); }, 45000);
    attachWaiters.set(id, (r) => { clearTimeout(t); resolve(r); });
    wc.send('pill:submit', { id, text, withScreen: !!withScreen });
  });
  if (!result.ok) toast(`Couldn’t send: ${result.error}`, 'warn');
  return result;
}

// ---------------------------------------------------------------- capture -> Claude
async function captureFiles() {
  const s = store.all();
  if (IS_MAC && systemPreferences.getMediaAccessStatus('screen') === 'denied') {
    checkScreenPermission();
    throw new Error('Screen Recording permission is off for The Pill');
  }
  const shots = await captureDisplays({ which: s.captureDisplay, maxEdge: Number(s.captureMaxEdge) || 1920 });
  flash('capture');
  const q = Math.min(95, Math.max(50, Number(s.jpegQuality) || 82));
  return shots.map((shot, i) => ({
    name: `screen ${stamp(shot.at)}${shots.length > 1 ? ` (display ${i + 1})` : ''}.jpg`,
    mime: 'image/jpeg',
    data: shot.image.toJPEG(q),
  }));
}

const attachWaiters = new Map();
let attachSeq = 0;
ipcMain.on('pill:attach:result', (_e, r) => {
  const w = attachWaiters.get(r.id);
  if (w) { attachWaiters.delete(r.id); w(r); }
});

async function attachToClaude(files, { hint = null, manual = true } = {}) {
  expand({ focus: true });
  await waitForView();
  const id = ++attachSeq;
  const result = await new Promise((resolve) => {
    const t = setTimeout(() => { attachWaiters.delete(id); resolve({ ok: false, error: 'Claude didn’t respond in time' }); }, 30000);
    attachWaiters.set(id, (r) => { clearTimeout(t); resolve(r); });
    claudeView.webContents.send('pill:attach', { id, files, hint, manual });
  });
  if (!result.ok) toast(`Couldn’t attach: ${result.error}`, 'warn');
  return result;
}

let sharing = false;
async function shareScreen() {
  if (sharing) return { ok: false, error: 'busy' };
  sharing = true;
  try {
    const files = await captureFiles();
    const r = await attachToClaude(files, { manual: true });
    if (r.ok) toast('Screenshot attached — ask away', 'capture');
    return r;
  } catch (err) {
    toast(err.message, 'warn');
    return { ok: false, error: err.message };
  } finally {
    sharing = false;
  }
}

const composeWaiters = new Map();
let composeSeq = 0;
ipcMain.on('ui:compose:done', (_e, r) => {
  const w = composeWaiters.get(r.id);
  if (w) { composeWaiters.delete(r.id); w(r); }
});

function composeGrid(frames) {
  const id = ++composeSeq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { composeWaiters.delete(id); reject(new Error('Rewind compositor timed out')); }, 15000);
    composeWaiters.set(id, (r) => {
      clearTimeout(t);
      if (r.error || !r.dataUrl) reject(new Error(r.error || 'Rewind compositor failed'));
      else resolve(Buffer.from(r.dataUrl.split(',')[1], 'base64'));
    });
    send(chatWin, 'ui:compose', {
      id,
      now: Date.now(),
      frames: frames.map((f) => ({ at: f.at, dataUrl: `data:image/jpeg;base64,${f.jpeg.toString('base64')}` })),
    });
  });
}

async function shareRewind() {
  if (sharing) return { ok: false, error: 'busy' };
  if (!store.get('watching')) { toast('Turn watching on to build up a Rewind', 'info'); return { ok: false, error: 'not watching' }; }
  sharing = true;
  try {
    const frames = rewind.snapshot();
    try {
      const [now] = await captureDisplays({ which: 'cursor', maxEdge: 1280 });
      frames.push({ jpeg: now.image.toJPEG(72), at: now.at });
    } catch (err) { console.warn('[thepill] rewind live frame:', err.message); }
    if (!frames.length) throw new Error('Nothing in Rewind yet');
    flash('capture');
    const grid = await composeGrid(frames.slice(-9));
    const mins = Math.max(1, Math.round((frames[frames.length - 1].at - frames[0].at) / 60000));
    const hint = `[Rewind: ${frames.length} snapshots of my screen over the last ~${mins} min, oldest top-left → newest bottom-right, each labelled with its time.] `;
    const r = await attachToClaude([{ name: `rewind ${stamp(Date.now())}.jpg`, mime: 'image/jpeg', data: grid }], { hint, manual: true });
    if (r.ok) toast('Rewind attached', 'capture');
    return r;
  } catch (err) {
    toast(err.message, 'warn');
    return { ok: false, error: err.message };
  } finally {
    sharing = false;
  }
}

function openClaudeLink(raw) {
  let url = String(raw || '').trim();
  if (url && !/^https?:\/\//i.test(url) && /^claude\.ai\//i.test(url)) url = `https://${url}`;
  if (!isClaudeUrl(url)) return false;
  claudeView.webContents.loadURL(url);
  expand();
  return true;
}

// ---------------------------------------------------------------- Shadow mode
function ensureShadow() {
  if (shadow) return shadow;
  vault = new Vault(path.join(app.getPath('userData'), 'shadow'));
  vault.prune(Number(store.get('shadowRetentionDays')) || 14, 7);
  shadow = new Shadow({
    getSettings: () => store.all(),
    vault,
    locale: app.getLocale(),
    difference,
    captureFrame: async () => {
      const [s] = await captureDisplays({ which: 'cursor', maxEdge: 1280 });
      return { jpeg: s.image.toJPEG(70), fp: fingerprint(s.image) };
    },
  });
  shadow.on('status', () => broadcastState());
  return shadow;
}

function setShadow(on, { quiet = false } = {}) {
  if (on) {
    if (IS_MAC && !systemPreferences.isTrustedAccessibilityClient(false)) {
      systemPreferences.isTrustedAccessibilityClient(true); // shows the macOS prompt
      store.set({ shadowEnabled: false });
      toast('Allow The Pill in Privacy & Security → Accessibility and Input Monitoring, then turn Shadow mode on again', 'warn', { label: 'Open settings', id: 'access-settings' });
      broadcastState();
      return false;
    }
    try {
      ensureShadow().start();
      store.set({ shadowEnabled: true });
      if (!quiet) toast('Shadow mode on: learning how you work. Passwords, login pages and calls are never recorded.', 'capture');
    } catch (err) {
      store.set({ shadowEnabled: false });
      toast(`Couldn’t start Shadow mode: ${err.message}`, 'warn');
    }
  } else {
    if (shadow) shadow.stop();
    store.set({ shadowEnabled: false });
    if (!quiet) toast('Shadow mode off. Nothing new is being recorded.', 'info');
  }
  broadcastState();
  return !!store.get('shadowEnabled');
}

/** Opens a fresh chat with the recorded day (or week) attached and a prompt ready to send. */
async function reviewWithClaude(kind = 'day') {
  ensureShadow();
  const days = kind === 'week' ? vault.days().slice(-7) : [dayOf()];
  const files = [];
  for (const d of days) {
    const events = vault.readDay(d);
    if (!events.length) continue;
    const { markdown } = digest.dayMarkdown(d, events, { maxTyped: kind === 'week' ? 20000 : 60000 });
    files.push({ name: `workday ${d}.md`, mime: 'text/markdown', data: Buffer.from(markdown, 'utf8') });
  }
  if (!files.length) {
    toast('Nothing recorded yet. Turn on Shadow mode and work as normal for a while.', 'info');
    return { ok: false, error: 'empty' };
  }
  viewReady = false;
  claudeView.webContents.loadURL(urlFor('new'));
  expand();
  await waitForView();
  const r = await attachToClaude(files, { hint: kind === 'week' ? digest.WEEK_PROMPT : digest.DAY_PROMPT, manual: true });
  if (r.ok) toast(kind === 'week' ? 'Your week is attached. Press Enter to build your playbook.' : 'Today’s log is attached. Press Enter to get the review.', 'capture');
  return r;
}

async function shadowAction(action, arg) {
  ensureShadow();
  switch (action) {
    case 'pause': shadow.pause(Number(arg) || 15 * 60000); break;
    case 'resume': shadow.pause(0); break;
    case 'summary': return digest.summaryForUi(vault.readDay(dayOf()));
    case 'review-day': return reviewWithClaude('day');
    case 'review-week': return reviewWithClaude('week');
    case 'delete-today': vault.deleteDay(dayOf()); shadow._reset(); toast('Today’s Shadow data deleted', 'info'); break;
    case 'delete-all': vault.deleteAll(); shadow._reset(); toast('All Shadow data deleted', 'info'); break;
    case 'open-folder': shell.openPath(vault.dir); break;
    case 'storage': return { bytes: vault.sizeBytes(), days: vault.days().length, keyProtected: vault.keyProtected };
    default: return null;
  }
  broadcastState();
  return true;
}

// ---------------------------------------------------------------- menu / tray
function buildMenu() {
  const s = store.all();
  const hasRewind = rewind && rewind.frames.length > 0;
  return Menu.buildFromTemplate([
    { label: chatWin && chatWin.isVisible() ? 'Collapse to pill' : 'Open Claude', accelerator: SHORTCUTS.toggleChat, click: () => (chatWin.isVisible() ? collapse() : expand()) },
    { type: 'separator' },
    { label: 'Watch my screen', type: 'checkbox', checked: !!s.watching, accelerator: SHORTCUTS.toggleWatching, click: (m) => setWatching(m.checked) },
    { label: 'Share screen now', accelerator: SHORTCUTS.shareScreen, click: () => shareScreen() },
    { label: `Share Rewind${hasRewind ? ` (${rewind.frames.length})` : ''}`, enabled: !!s.watching && hasRewind, click: () => shareRewind() },
    { type: 'separator' },
    { label: 'Learn how I work (Shadow mode)', type: 'checkbox', checked: !!s.shadowEnabled, click: (m) => setShadow(m.checked) },
    { label: 'Pause learning for 15 minutes', enabled: !!(shadow && shadow.running), click: () => shadowAction('pause', 15 * 60000) },
    { label: 'Review my day with Claude', click: () => reviewWithClaude('day') },
    { type: 'separator' },
    { label: 'New chat', click: () => { claudeView.webContents.loadURL(urlFor('new')); expand(); } },
    { label: 'Open Claude link from clipboard', click: () => { if (!openClaudeLink(clipboard.readText())) toast('Copy a claude.ai chat link first', 'info'); } },
    { label: 'Open this chat in browser', click: () => openInBrowser() },
    { type: 'separator' },
    { label: 'Keep chat on top', type: 'checkbox', checked: !!s.pinned, click: (m) => applySettings({ pinned: m.checked }) },
    ...(IS_LINUX ? [] : [{ label: 'Launch at login', type: 'checkbox', checked: !!s.launchAtLogin, click: (m) => applySettings({ launchAtLogin: m.checked }) }]),
    { label: 'Settings…', click: () => { expand(); toggleSettings(true); } },
    { type: 'separator' },
    { label: 'Quit The Pill', role: 'quit' },
  ]);
}

function createTray() {
  try {
    tray = new Tray(trayImage(store.get('watching')));
    tray.setToolTip('The Pill');
    tray.on('click', () => toggleChat());
    tray.setContextMenu(buildMenu());
  } catch (err) {
    console.warn('[thepill] tray unavailable:', err.message);
  }
}

function openInBrowser() {
  const url = claudeView.webContents.getURL();
  shell.openExternal(isClaudeUrl(url) && !OVERRIDE_URL ? url : `${CLAUDE_ORIGIN}/recents`);
}

function registerShortcuts() {
  const map = {
    toggleChat: () => toggleChat(),
    shareScreen: () => shareScreen(),
    toggleWatching: () => setWatching(!store.get('watching')),
  };
  for (const [k, fn] of Object.entries(map)) {
    try { shortcutStatus[k] = globalShortcut.register(SHORTCUTS[k], fn); } catch { shortcutStatus[k] = false; }
  }
}

// ---------------------------------------------------------------- IPC
function wireIpc() {
  ipcMain.handle('ui:get-state', () => uiState());
  ipcMain.handle('ui:set-settings', (_e, patch) => { applySettings(patch || {}); return uiState(); });
  ipcMain.handle('ui:toggle-watching', () => { setWatching(!store.get('watching')); return uiState(); });
  ipcMain.handle('ui:share-screen', () => shareScreen());
  ipcMain.handle('ui:share-rewind', () => shareRewind());
  ipcMain.handle('ui:shadow', (_e, action, arg) => shadowAction(action, arg));
  ipcMain.handle('ui:open-screen-settings', (_e, which) => {
    if (IS_MAC && which === 'access-settings') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    else if (IS_MAC) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    else if (IS_WIN) shell.openExternal('ms-settings:privacy');
  });
  ipcMain.handle('ui:nav', (_e, kind) => {
    const wc = claudeView.webContents;
    if (kind === 'back') { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); }
    else if (kind === 'reload') wc.reload();
    else wc.loadURL(urlFor(kind));
  });
  ipcMain.handle('ui:open-in-browser', () => openInBrowser());
  ipcMain.handle('ui:open-link', (_e, url) => openClaudeLink(url));
  ipcMain.handle('ui:link-from-clipboard', () => {
    const ok = openClaudeLink(clipboard.readText());
    if (!ok) toast('Copy a claude.ai chat link first, then press this again', 'info');
    return ok;
  });
  ipcMain.handle('ui:copy', (_e, text) => { clipboard.writeText(String(text)); return true; });
  ipcMain.handle('ui:expand', () => expand());
  ipcMain.handle('ui:collapse', () => collapse());
  ipcMain.handle('ui:toggle-dock', () => toggleDock());
  ipcMain.handle('ui:toggle-settings', (_e, open) => toggleSettings(open === undefined ? undefined : !!open));
  ipcMain.handle('ui:toggle-pin', () => applySettings({ pinned: !store.get('pinned') }));
  ipcMain.handle('ui:quit', () => { quitting = true; app.quit(); });
  ipcMain.on('ui:overlay', (_e, px) => { overlayPx = Math.max(0, Math.min(2000, Number(px) || 0)); layoutView(); });

  ipcMain.on('pill:move', (_e, { x, y }) => {
    if (!pillWin) return;
    const { width, height } = pillWin.getBounds();
    pillWin.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  });
  ipcMain.on('pill:drag-end', () => {
    if (!pillWin) return;
    const b = pillWin.getBounds();
    // Keep the pill fully on screen.
    const wa = screen.getDisplayMatching(b).workArea;
    const x = Math.min(Math.max(wa.x, b.x), wa.x + wa.width - b.width);
    const y = Math.min(Math.max(wa.y, b.y), wa.y + wa.height - b.height);
    pillWin.setBounds({ x, y, width: b.width, height: b.height });
    // Remember where the compact pill sits (its corner stays put when it grows into the bar).
    const p = growFrom({ x, y, width: b.width, height: b.height }, { width: PILL_W, height: PILL_H });
    store.set({ pillPos: { x: p.x, y: p.y } });
  });
  ipcMain.handle('pill:mode', (_e, mode) => setPillMode(mode));
  ipcMain.handle('pill:submit', (_e, { text, withScreen }) => submitPrompt(text, withScreen));
  ipcMain.on('pill:menu', () => buildMenu().popup({ window: pillWin }));

  // From the claude.ai page
  ipcMain.handle('claude:get-state', () => ({ watching: store.get('watching') }));
  ipcMain.handle('claude:capture-for-send', async (_e, opts = {}) => {
    if (!store.get('watching') && !(opts && opts.force)) return null;
    return captureFiles();
  });
  ipcMain.handle('claude:insert-text', (e, text) => { e.sender.insertText(String(text || '')); return true; });
  ipcMain.handle('claude:native-paste-image', async (e, f) => {
    const img = nativeImage.createFromBuffer(Buffer.from(f.data));
    const saved = { text: clipboard.readText(), html: clipboard.readHTML(), image: clipboard.readImage() };
    clipboard.writeImage(img);
    e.sender.paste();
    setTimeout(() => {
      if (!saved.image.isEmpty()) clipboard.writeImage(saved.image);
      else clipboard.write({ text: saved.text, html: saved.html });
    }, 1200);
    return true;
  });
  ipcMain.on('claude:status', (_e, { text, kind }) => send(chatWin, 'ui:toast', { text, kind }));
  ipcMain.on('claude:log', (_e, msg) => console.log('[claude.ai]', msg));
}

// ---------------------------------------------------------------- app lifecycle
async function boot() {
  store = new Store(app.getPath('userData'));
  rewind = new Rewind({
    getSettings: () => store.all(),
    onChange: () => broadcastState(),
  });

  if (IS_MAC) app.dock.hide(); // live in the menu bar + the pill, not the Dock
  wireIpc();
  createPill();
  createChat();
  applyContentProtection();
  createTray();
  registerShortcuts();
  registerProtocol();

  powerMonitor.on('lock-screen', () => { rewind.paused = true; });
  powerMonitor.on('unlock-screen', () => { rewind.paused = false; });
  powerMonitor.on('suspend', () => { rewind.paused = true; });
  powerMonitor.on('resume', () => { rewind.paused = false; });

  if (store.get('watching') && store.get('rewindEnabled')) rewind.start();
  if (store.get('shadowEnabled')) setShadow(true, { quiet: true });

  pillWin.once('ready-to-show', () => {
    if (store.get('firstRun')) {
      store.set({ firstRun: false });
      expand();
      setTimeout(() => toast('Sign in to Claude once — The Pill remembers it. Click — to shrink me into a pill.', 'info'), 1500);
    } else {
      pillWin.showInactive();
    }
  });

  const argUrl = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (argUrl) pendingProtocolUrl = argUrl;
  if (pendingProtocolUrl) { const u = pendingProtocolUrl; pendingProtocolUrl = null; setTimeout(() => handleProtocolUrl(u), 500); }

  screen.on('display-removed', () => {
    const b = pillWin.getBounds();
    if (!onScreen(b)) { const wa = screen.getPrimaryDisplay().workArea; pillWin.setPosition(wa.x + wa.width - PILL_W - 24, wa.y + wa.height - PILL_H - 24); }
  });
}

/**
 * `--self-test`: start, check the parts that can break on a new machine, print a report and quit.
 * Run it from a terminal, e.g. "/Applications/The Pill.app/Contents/MacOS/The Pill" --self-test
 */
async function selfTest() {
  const report = { version: app.getVersion(), platform: `${process.platform}-${process.arch}`, electron: process.versions.electron };
  try { require('uiohook-napi'); report.keyboardHook = 'loaded'; } catch (err) { report.keyboardHook = `failed: ${err.message}`; }
  try { const shots = await captureDisplays({ which: 'primary', maxEdge: 640 }); report.screenCapture = shots[0].image.isEmpty() ? 'blank (permission?)' : 'ok'; } catch (err) { report.screenCapture = `failed: ${err.message}`; }
  if (IS_MAC) {
    report.screenPermission = systemPreferences.getMediaAccessStatus('screen');
    report.accessibility = systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'not granted';
  }
  const { watchActiveWindow } = require('./shadow/activewin');
  report.frontWindow = await new Promise((resolve) => {
    let stop = () => {};
    const t = setTimeout(() => { stop(); resolve('no answer in 8 s'); }, 8000);
    stop = watchActiveWindow((w) => { clearTimeout(t); stop(); resolve(`${w.app} — ${w.title}`); }, 700, (e) => { if (e) { clearTimeout(t); stop(); resolve(`failed: ${e}`); } });
  });
  try { const v = new Vault(path.join(app.getPath('temp'), `thepill-selftest-${Date.now()}`)); v.append({ t: Date.now(), type: 'test' }); report.encryptedStorage = v.readDay(dayOf()).length === 1 ? `ok (${v.keyProtected ? 'keychain' : 'local key'})` : 'failed'; } catch (err) { report.encryptedStorage = `failed: ${err.message}`; }
  console.log(`THE PILL SELF-TEST ${JSON.stringify(report, null, 2)}`);
  app.exit(0);
}

if (process.argv.includes('--self-test')) app.whenReady().then(selfTest);
else app.whenReady().then(() => (IS_LINUX ? new Promise((r) => setTimeout(r, 300)) : null)).then(boot);
app.on('before-quit', () => { quitting = true; if (shadow) shadow.stop(); if (store) store.flush(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => { if (!quitting) e.preventDefault(); });

module.exports = {
  _internals: () => ({ setShadow, shadowAction, reviewWithClaude, shadow: () => shadow, vault: () => vault, toggleSettings, settingsView: () => settingsView, submitPrompt, setPillMode, pillMode: () => pillMode, pillWin, chatWin, claudeView, store, rewind, expand, collapse, shareScreen, shareRewind, setWatching, uiState, toggleDock }),
};
