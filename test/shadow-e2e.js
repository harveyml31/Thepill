'use strict';
// End-to-end check of Shadow mode: real global keyboard/mouse hook, real windows, real encrypted storage.
// Run: xvfb-run -a npx electron --no-sandbox test/shadow-e2e.js   (needs xdotool on Linux)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

process.env.PILL_CLAUDE_URL = 'file://' + path.join(__dirname, 'mock-claude.html');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'thepill-shadow-'));
app.setPath('userData', userData);
const main = require('../src/main.js');
const { dayOf } = require('../src/shadow/vault');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const type = (text) => execFileSync('xdotool', ['type', '--delay', '25', text]);
const key = (k) => execFileSync('xdotool', ['key', k]);

async function windowWithInput(title) {
  const w = new BrowserWindow({ x: 100, y: 100, width: 500, height: 300, title, show: true });
  await w.loadURL('data:text/html,' + encodeURIComponent(`<title>${title}</title><input id="i" style="font-size:20px;width:90%" autofocus>`));
  w.setTitle(title);
  w.focus();
  await w.webContents.executeJavaScript(`document.getElementById('i').focus(); true`);
  await sleep(1800); // let the window watcher notice the new window
  return w;
}

app.whenReady().then(async () => {
  await sleep(2500);
  const I = main._internals();
  try {
    I.store.set({ shadowFrames: false, keyboardLayout: 'us' }); // the test X server uses a US keymap
    const started = I.setShadow(true);
    check('Shadow mode starts', started && I.shadow().running, JSON.stringify(I.shadow().status()));

    // 1. Ordinary typing in a normal window, sent with Enter
    let w = await windowWithInput('Re: Systems Engineers - Zipline');
    type('Hi Sam, thanks for coming back to me. Are you free Tuesday at 3pm?'); key('Return');
    await sleep(300);
    // a typo fixed with Backspace, and a UK " symbol
    type('Speak sooon'); key('BackSpace'); type(' "soon"'); key('Return');
    await sleep(300);
    // a password-like token inside normal text
    type('the code is Zq8#pL2!vR thanks'); key('Return');
    await sleep(600);
    w.destroy();

    // 2. A login page: nothing typed is kept
    w = await windowWithInput('Sign in to Bullhorn');
    type('harvey.leech'); key('Tab'); type('Hunter2!xyz'); key('Return');
    await sleep(600);
    w.destroy();

    // 3. A call: nothing at all is kept
    w = await windowWithInput('Zoom Meeting');
    type('private call notes about salary'); key('Return');
    await sleep(600);
    w.destroy();

    // 4. Mouse: move and click in a normal window
    w = await windowWithInput('Pipeline dashboard');
    execFileSync('xdotool', ['mousemove', '150', '150', 'mousemove', '400', '300', 'click', '1']);
    await sleep(500);
    w.destroy();

    I.shadow()._flushMinute();
    await sleep(300);
    const events = I.vault().readDay(dayOf());
    const typed = events.filter((e) => e.type === 'typed' && e.text).map((e) => e.text);
    const all = JSON.stringify(events);
    check('typed message recorded with the window it was typed in',
      events.some((e) => e.type === 'typed' && e.text === 'Hi Sam, thanks for coming back to me. Are you free Tuesday at 3pm?' && /Zipline/.test(e.title) && e.submitted),
      JSON.stringify(typed));
    check('Backspace edits applied and symbols read correctly', typed.includes('Speak sooo "soon"'), JSON.stringify(typed));
    check('password-like text inside a message is hidden', typed.includes('the code is [hidden] thanks') && !all.includes('Zq8#pL2'));
    check('nothing typed on a login page is kept', !all.includes('Hunter2') && !all.includes('harvey.leech') && events.some((e) => e.hidden === 'login'));
    check('nothing typed during a call is kept', !all.includes('salary') && !all.includes('private call notes'));
    check('the call itself is noted without its title', events.some((e) => e.type === 'focus' && e.kind === 'call' && !e.title));
    check('clicks recorded with the window', events.some((e) => e.type === 'click' && /Pipeline/.test(e.title)));
    const minute = events.filter((e) => e.type === 'minute');
    check('typing and mouse rhythm recorded', minute.some((m) => m.keys > 50 && m.iki > 0 && m.mouse > 100), JSON.stringify(minute[0]));

    const raw = fs.readFileSync(path.join(userData, 'shadow', `${dayOf()}.log`), 'utf8');
    check('stored encrypted on disk (no readable text)', raw.length > 200 && !raw.includes('Sam') && !raw.includes('Zipline'));

    // 5. Pause stops recording
    I.shadowAction('pause', 60000);
    w = await windowWithInput('Notes');
    type('typed while paused'); key('Return');
    await sleep(500);
    w.destroy();
    check('pause stops recording', !JSON.stringify(I.vault().readDay(dayOf())).includes('while paused'));
    I.shadowAction('resume');

    // 6. Review with Claude: a fresh chat opens with the day's log attached and a prompt ready
    const r = await I.reviewWithClaude('day');
    await sleep(1200);
    const wc = I.claudeView.webContents;
    const thumbs = await wc.executeJavaScript(`[...document.querySelectorAll('#thumbs .doc')].map((d) => d.textContent)`);
    const prompt = await wc.executeJavaScript(`document.getElementById('ed').innerText`);
    check('review attaches the day log to a new chat', r.ok && thumbs.some((x) => /workday .*\.md/.test(x)), JSON.stringify({ r, thumbs }));
    check('review prompt asks about time, workflows and writing voice', /Where my time went/.test(prompt) && /How I write/.test(prompt));
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await sleep(1200);
    const md = await wc.executeJavaScript(`window.__docs && window.__docs[0] ? window.__docs[0].text() : ''`);
    check('the attached log contains what was typed, and no secrets', md.includes('Are you free Tuesday at 3pm?') && !md.includes('Hunter2') && !md.includes('salary'));
    fs.writeFileSync(path.join(__dirname, 'out', 'sample-workday.md'), md);

    // 6b. If the front window can't be read, typed text is never kept
    {
      const { EventEmitter } = require('events');
      const { Shadow } = require('../src/shadow/recorder');
      const { Vault } = require('../src/shadow/vault');
      const blindVault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'blind-')));
      const hook = Object.assign(new EventEmitter(), { start() {}, stop() {} });
      let reportError;
      const blind = new Shadow({ getSettings: () => ({ keyboardLayout: 'us', shadowFrames: false }), vault: blindVault, hook,
        watchWindow: (_onChange, _i, onError) => { reportError = onError; return () => {}; } });
      blind.start();
      for (const k of [25, 30, 31, 31, 17, 24, 19, 32]) { hook.emit('keydown', { keycode: k, shiftKey: false }); hook.emit('keyup', { keycode: k }); } // "password"
      hook.emit('keydown', { keycode: 28 });
      reportError('Can’t see which app is in front.');
      const st = blind.status();
      blind.stop();
      const ev = blindVault.readDay(dayOf());
      check('when the front app is unknown, typing is not kept', !JSON.stringify(ev).includes('password') && ev.some((x) => x.hidden === 'unknown-window'), JSON.stringify(ev.filter((x) => x.type === 'typed')));
      check('and settings say why', st.mode === 'blind' && /front/.test(st.windowError || ''), JSON.stringify(st));
    }

    // 7. Delete everything
    await I.shadowAction('delete-all');
    check('delete everything removes the data', I.vault().days().length === 0);
    I.setShadow(false);
    check('Shadow mode stops', !I.shadow().running);
  } catch (err) {
    check('no exceptions', false, err.stack);
  }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} Shadow checks passed`);
  app.exit(failed ? 1 : 0);
});
