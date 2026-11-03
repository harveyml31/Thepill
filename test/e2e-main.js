'use strict';
// End-to-end check of The Pill against a local mock of claude.ai.
// Run: xvfb-run -a npx electron --no-sandbox test/e2e-main.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
process.env.PILL_CLAUDE_URL = 'file://' + path.join(__dirname, 'mock-claude.html');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'thepill-e2e-')));

const main = require('../src/main.js');
const { captureDisplays } = require('../src/capture.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra = '') { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); }

async function shot(name) {
  const [s] = await captureDisplays({ which: 'primary', maxEdge: 1600 });
  fs.writeFileSync(path.join(OUT, name), s.image.toPNG());
}

async function typeAndSend(wc, text, how = 'enter') {
  await wc.executeJavaScript(`document.getElementById('ed').focus(); true`);
  wc.insertText(text);
  await sleep(150);
  if (how === 'enter') {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    wc.sendInputEvent({ type: 'char', keyCode: 'Return' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  } else {
    const r = await wc.executeJavaScript(`(() => { const b = document.getElementById('send').getBoundingClientRect(); return { x: b.x + b.width/2, y: b.y + b.height/2 }; })()`);
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 });
  }
}

async function sent(wc) { return wc.executeJavaScript('window.__sent'); }
async function waitSent(wc, n, timeout = 8000) {
  const t = Date.now();
  while (Date.now() - t < timeout) { const s = await sent(wc); if (s.length >= n) return s; await sleep(150); }
  return sent(wc);
}

app.whenReady().then(async () => {
  await sleep(2500);
  const I = main._internals();
  const wc = I.claudeView.webContents;
  try {
    I.collapse();
    await sleep(600);
    check('pill visible when collapsed', I.pillWin.isVisible() && !I.chatWin.isVisible());
    fs.writeFileSync(path.join(OUT, 'pill-off.png'), (await I.pillWin.webContents.capturePage()).toPNG());

    I.setWatching(true);
    await sleep(500);
    fs.writeFileSync(path.join(OUT, 'pill-watching.png'), (await I.pillWin.webContents.capturePage()).toPNG());

    I.expand();
    await sleep(1200);
    check('chat visible, pill hidden after expand', I.chatWin.isVisible() && !I.pillWin.isVisible());
    check('chat is always on top', I.chatWin.isAlwaysOnTop());

    // 1. Watching on + Enter -> screenshot auto-attached
    await typeAndSend(wc, 'What is on my screen?');
    let s = await waitSent(wc, 1);
    check('watching: Enter sends with a screenshot', s[0] && s[0].images === 1 && s[0].text === 'What is on my screen?', JSON.stringify(s[0]));

    // 2. Watching on + click send button
    await typeAndSend(wc, 'And now?', 'click');
    s = await waitSent(wc, 2);
    check('watching: Send button sends with a screenshot', s[1] && s[1].images === 1, JSON.stringify(s[1]));

    // 3. Watching off -> no screenshot
    I.setWatching(false);
    await sleep(300);
    await typeAndSend(wc, 'Private message');
    s = await waitSent(wc, 3);
    check('screen off: message sent without screenshot', s[2] && s[2].images === 0, JSON.stringify(s[2]));

    // 4. Share screen now (works with watching off), then send -> exactly one image
    const r = await I.shareScreen();
    check('share screen now attaches', r.ok, JSON.stringify(r));
    await sleep(900);
    await typeAndSend(wc, 'Explain this');
    s = await waitSent(wc, 4);
    check('manual share: sent with exactly one screenshot', s[3] && s[3].images === 1, JSON.stringify(s[3]));

    // 5. Manual share while watching -> no duplicate screenshot on the next send
    I.setWatching(true);
    await sleep(300);
    await I.shareScreen();
    await sleep(900);
    await typeAndSend(wc, 'Only one image please');
    s = await waitSent(wc, 5);
    check('share while watching: no duplicate screenshot', s[4] && s[4].images === 1, JSON.stringify(s[4]));

    // 6. Rewind
    await I.rewind.tick();
    I.rewind.frames.forEach((f, i) => { f.at -= (3 - i) * 60000; });
    const frame = I.rewind.frames[0];
    if (frame) for (let i = 1; i < 4; i++) I.rewind.frames.unshift({ ...frame, at: frame.at - i * 40000 });
    const rr = await I.shareRewind();
    check('rewind grid attaches', rr.ok, JSON.stringify(rr));
    await sleep(900);
    const text = await wc.executeJavaScript(`document.getElementById('ed').innerText`);
    check('rewind inserts an explanatory hint', /Rewind:/.test(text), text.slice(0, 80));
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    s = await waitSent(wc, 6);
    check('rewind message sent with one grid image', s[5] && s[5].images === 1, JSON.stringify(s[5]));
    const grid = await wc.executeJavaScript(`(() => { const imgs = document.querySelectorAll('#log .msg img'); return imgs[imgs.length-1].src; })()`);
    const buf = await wc.executeJavaScript(`fetch(${JSON.stringify(grid)}).then(r=>r.arrayBuffer()).then(b=>Array.from(new Uint8Array(b)))`);
    fs.writeFileSync(path.join(OUT, 'rewind-grid.jpg'), Buffer.from(buf));

    // 6b. claude.ai without a file input -> falls back to a paste event
    await wc.loadURL(process.env.PILL_CLAUDE_URL + '?nofile=1');
    await sleep(1500);
    await typeAndSend(wc, 'Fallback path');
    s = await waitSent(wc, 1);
    const via = await wc.executeJavaScript('window.__attachVia');
    check('no file input: screenshot attached via paste fallback', s[0] && s[0].images === 1 && via[0] === 'paste', JSON.stringify({ s: s[0], via }));
    await wc.loadURL(process.env.PILL_CLAUDE_URL + '?fresh=1');
    await sleep(1200);

    // 6c. Editing an old message (a textarea, no attachments) is never hijacked
    await wc.executeJavaScript(`(() => { const t = document.createElement('textarea'); t.id = 'edit'; document.getElementById('log').appendChild(t);
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.__editEnter = true; }); t.focus(); })()`);
    wc.insertText('edited');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    await sleep(400);
    check('editing an old message is left alone', await wc.executeJavaScript('window.__editEnter === true && window.__sent.length === 0'));

    // 7. Settings persist
    I.store.flush();
    const saved = JSON.parse(fs.readFileSync(I.store.file, 'utf8'));
    check('settings persisted', saved.watching === true);

    // 8. Opens where it is: pill -> prompt bar -> chat, all anchored to the pill's corner
    I.setWatching(false);
    I.collapse(); await sleep(500);
    const p0 = I.pillWin.getBounds();
    await I.setPillMode('bar'); await sleep(400);
    const bar = I.pillWin.getBounds();
    check('click pill -> prompt bar grows in place', bar.width === 500 && bar.x + bar.width === p0.x + p0.width && bar.y === p0.y, JSON.stringify({ p0, bar }));
    await shot('desktop-bar.png');
    fs.writeFileSync(path.join(OUT, 'pill-bar.png'), (await I.pillWin.webContents.capturePage()).toPNG());
    const before = (await sent(wc)).length;
    const r1 = await I.submitPrompt('Hello from the bar', false);
    s = await waitSent(wc, before + 1);
    const cb = I.chatWin.getBounds();
    check('bar question is sent to Claude', r1.ok && s[before] && s[before].text === 'Hello from the bar' && s[before].images === 0, JSON.stringify({ r1, m: s[before] }));
    check('chat opens where the pill was (same corner)', cb.x + cb.width === bar.x + bar.width && cb.y + cb.height === bar.y + bar.height, JSON.stringify({ bar, cb }));
    await shot('desktop-inplace.png');
    const r2 = await I.submitPrompt('What do you see?', true);
    s = await waitSent(wc, before + 2);
    check('bar "include my screen" attaches a screenshot', r2.ok && s[before + 1] && s[before + 1].images === 1, JSON.stringify(s[before + 1]));
    I.chatWin.setPosition(cb.x - 300, cb.y - 100); await sleep(300);
    const moved = I.chatWin.getBounds();
    I.collapse(); await sleep(400);
    const p1 = I.pillWin.getBounds();
    check('collapse -> pill returns at the chat’s corner', p1.width === 172 && p1.x + p1.width === moved.x + moved.width && p1.y + p1.height === moved.y + moved.height, JSON.stringify({ moved, p1 }));

    // Screenshots of the whole desktop for visual review
    await shot('desktop-chat.png');
    I.expand(); await sleep(500);
    I.chatWin.webContents.send('ui:toast', { kind: 'open-settings' });
    await sleep(800);
    await shot('desktop-settings.png');
    I.chatWin.webContents.executeJavaScript(`document.getElementById('more').click()`);
    await sleep(300);
    I.toggleDock(); await sleep(500);
    await shot('desktop-floating.png');
    I.collapse(); await sleep(500);
    await shot('desktop-pill.png');
  } catch (err) {
    check('no exceptions', false, err.stack);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed ? 1 : 0);
});
