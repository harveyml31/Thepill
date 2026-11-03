'use strict';
// Cross-platform smoke test, run on real macOS, Windows and Linux machines in CI.
// Run: npx electron test/smoke.js   (add --no-sandbox when running as root on Linux)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

process.env.PILL_CLAUDE_URL = 'file://' + path.join(__dirname, 'mock-claude.html');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'thepill-smoke-')));
const main = require('../src/main.js');
const { captureDisplays } = require('../src/capture.js');
const { watchActiveWindow } = require('../src/shadow/activewin.js');
const { dayOf } = require('../src/shadow/vault');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const note = (name, extra = '') => console.log(`NOTE  ${name}${extra ? '  — ' + extra : ''}`);
const PLATFORM = `${process.platform}-${process.arch}`;
const pageErrors = [];

async function waitFor(fn, ms = 10000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}

app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (ev) => { if (ev.level === 'error' || ev.level === 3) pageErrors.push(String(ev.message || ev)); });
  wc.on('render-process-gone', (_ev, d) => pageErrors.push(`renderer gone: ${d.reason}`));
});

app.whenReady().then(async () => {
  console.log(`The Pill smoke test on ${PLATFORM}, Electron ${process.versions.electron}`);
  await sleep(3000);
  const I = main._internals();
  const wc = I.claudeView.webContents;
  try {
    // 1. Windows and pages load
    check('pill window loaded', I.pillWin && !I.pillWin.webContents.isLoading() && I.pillWin.webContents.getURL().endsWith('pill.html'));
    check('chat window loaded', I.chatWin && I.chatWin.webContents.getURL().endsWith('chat.html'));
    check('settings panel loaded', I.settingsView() && I.settingsView().webContents.getURL().endsWith('settings.html'));
    const hasState = await I.pillWin.webContents.executeJavaScript(`typeof window.pill === 'object' && typeof window.pill.getState === 'function'`);
    check('pill bridge available', hasState);

    // 2. Prompt bar -> question sent to Claude in place
    I.collapse(); await sleep(500);
    await I.setPillMode('bar'); await sleep(400);
    const r = await I.submitPrompt('Smoke test question', false);
    const sent = await waitFor(() => wc.executeJavaScript('window.__sent && window.__sent[0]'));
    check('question from the prompt bar reaches Claude', r.ok && sent && sent.text === 'Smoke test question', JSON.stringify({ r, sent }));
    check('chat opens in place over everything', I.chatWin.isVisible() && I.chatWin.isAlwaysOnTop());

    // 3. Settings panel opens and closes
    I.toggleSettings(true); await sleep(500);
    const open = await I.settingsView().webContents.executeJavaScript(`document.body.classList.contains('open')`);
    I.toggleSettings(false); await sleep(400);
    check('settings panel opens and closes', open);

    // 4. Screen capture (macOS CI machines have no Screen Recording permission, so this may be blank there)
    let capOk = false;
    try {
      const shots = await captureDisplays({ which: 'primary', maxEdge: 1280 });
      capOk = shots.length > 0 && !shots[0].image.isEmpty();
    } catch (err) { note('screen capture threw', err.message); }
    if (capOk) {
      check('screen capture works', true);
      const share = await I.shareScreen();
      await sleep(1200);
      check('share screen attaches a screenshot', share.ok, JSON.stringify(share));
    } else if (process.platform === 'darwin') note('screen capture skipped', 'CI Macs have no Screen Recording permission; on your Mac you allow it once');
    else check('screen capture works', false);

    // 5. Which app is in front (PowerShell on Windows, AppleScript on macOS, xdotool on Linux)
    const probe = new BrowserWindow({ width: 520, height: 260, x: 120, y: 120, title: 'Re: Smoke test - Zipline', show: true });
    await probe.loadURL('data:text/html,' + encodeURIComponent('<title>Re: Smoke test - Zipline</title><input id="i" autofocus style="font-size:20px">'));
    probe.setTitle('Re: Smoke test - Zipline');
    probe.show(); probe.focus(); probe.moveTop();
    await probe.webContents.executeJavaScript(`document.getElementById('i').focus(); true`);
    let seenWin = null;
    let winErr = null;
    const stop = watchActiveWindow((w) => { if (/Smoke test/.test(w.title)) seenWin = w; }, 800, (e) => { winErr = e; });
    await waitFor(() => seenWin || winErr, 15000);
    stop();
    if (process.platform === 'darwin' && !seenWin) note('front-window check skipped', `CI Macs can’t grant Automation permission (${winErr || 'no answer'})`);
    else check('sees which app and window is in front', !!seenWin, JSON.stringify(seenWin || winErr));

    // 6. Shadow mode with real key presses (Windows and Linux; macOS CI can't grant Input Monitoring)
    if (process.platform !== 'darwin') {
      // Keys must come from another program: the hook ignores keys its own process generates.
      const { execFileSync } = require('child_process');
      const typeOutside = (text) => {
        if (process.platform === 'win32') {
          const esc = text.replace(/'/g, "''").replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);
          execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${esc}{ENTER}')`]);
        } else {
          execFileSync('xdotool', ['type', '--delay', '30', text]);
          execFileSync('xdotool', ['key', 'Return']);
        }
      };
      I.store.set({ shadowFrames: false, keyboardLayout: 'us' });
      const on = I.setShadow(true);
      check('Shadow mode starts', on && I.shadow().running, JSON.stringify(I.shadow().status()));
      probe.focus();
      await waitFor(() => I.shadow().status().mode === 'recording', 8000);
      await sleep(800);
      typeOutside('hi sam, free tuesday?');
      await sleep(1500);
      const events = I.vault().readDay(dayOf());
      const typed = events.filter((e) => e.type === 'typed' && e.text);
      const got = typed.find((e) => /hi sam, free tuesday\?/i.test(e.text));
      check('typed text recorded from real key presses', !!got, JSON.stringify(typed.map((e) => [e.text, e.title])));
      if (got) {
        if (/Smoke test/.test(got.title)) check('typed text tagged with its window', true);
        else note('typed text window', `recorded against "${got.title}" (CI desktops don’t always let a window take focus)`);
      }
      const fieldValue = await probe.webContents.executeJavaScript(`document.getElementById('i').value`);
      note('text that reached the window', JSON.stringify(fieldValue));
      I.setShadow(false);
      check('Shadow mode stops', !I.shadow().running);
    } else {
      note('Shadow keyboard test skipped', 'CI Macs can’t grant Input Monitoring; on your Mac you allow it once');
    }
    probe.destroy();

    check('no errors in the app’s pages', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
  } catch (err) {
    check('no exceptions', false, err.stack);
  }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${PLATFORM}: ${results.length - failed}/${results.length} smoke checks passed`);
  app.exit(failed ? 1 : 0);
});
