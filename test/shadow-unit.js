'use strict';
// Unit checks for Shadow mode's privacy rules, key mapping and digest. Run: node test/shadow-unit.js
const assert = require('assert');
const { classifyContext, redactTyped, looksSecret } = require('../src/shadow/privacy');
const { layoutFor, charFor } = require('../src/shadow/keymap');
const { dayMarkdown, analyse, placeOf } = require('../src/shadow/digest');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('PASS ', name); };

ok('login pages are recognised', () => {
  assert.equal(classifyContext({ app: 'Google Chrome', title: 'Sign in - Google Accounts' }), 'login');
  assert.equal(classifyContext({ app: 'Safari', title: 'Bullhorn', url: 'https://auth.bullhornstaffing.com/oauth/authorize' }), 'login');
  assert.equal(classifyContext({ app: 'Chrome', title: 'Enter verification code' }), 'login');
});
ok('calls are recognised', () => {
  assert.equal(classifyContext({ app: 'zoom.us', title: 'Zoom Meeting' }), 'call');
  assert.equal(classifyContext({ app: 'Microsoft Teams', title: 'Weekly sync | Microsoft Teams Meeting' }), 'call');
  assert.equal(classifyContext({ app: 'Google Chrome', title: 'Meet - abc-defg-hij', url: 'https://meet.google.com/abc-defg-hij' }), 'call');
});
ok('password managers and banks are private', () => {
  assert.equal(classifyContext({ app: '1Password', title: 'Vault' }), 'private');
  assert.equal(classifyContext({ app: 'Chrome', title: 'Monzo – Home' }), 'private');
  assert.equal(classifyContext({ app: 'Chrome', title: 'Holiday plans' }, ['holiday']), 'private');
});
ok('ordinary work is recorded', () => {
  assert.equal(classifyContext({ app: 'Google Chrome', title: '(3) Sam Carter | LinkedIn' }), 'normal');
  assert.equal(classifyContext({ app: 'OUTLOOK', title: 'Re: Systems Engineers - Zipline' }), 'normal');
});
ok('password-like words are hidden, normal text kept', () => {
  assert.equal(redactTyped('my key is Zq8#pL2!vR ok').text, 'my key is [hidden] ok');
  assert.equal(redactTyped('Hunter2!x', { submitted: true }).text, '');
  assert.equal(redactTyped('482913').text, '');
  assert.equal(redactTyped('Thanks', { submitted: true }).text, 'Thanks');
  assert.equal(redactTyped('Hi Sam, are you free Tuesday at 3pm?', { submitted: true }).text, 'Hi Sam, are you free Tuesday at 3pm?');
  assert.equal(redactTyped('sam.carter@gmail.com', { submitted: true }).text, 'sam.carter@gmail.com');
  assert.equal(looksSecret('Zipline'), false);
});
ok('UK and US keyboards map symbols differently', () => {
  const uk = layoutFor('uk'); const us = layoutFor('us');
  assert.equal(charFor(uk, 3, true, false), '"');
  assert.equal(charFor(us, 3, true, false), '@');
  assert.equal(charFor(uk, 40, true, false), '@');
  assert.equal(charFor(uk, 4, true, false), '£');
  assert.equal(charFor(us, 30, true, false), 'A');
  assert.equal(charFor(us, 30, true, true), 'a');
  assert.equal(layoutFor('auto', 'en-GB'), uk);
});
ok('places are named from titles and URLs', () => {
  assert.equal(placeOf({ app: 'Google Chrome', title: '(3) Sam Carter | LinkedIn - Google Chrome' }), 'LinkedIn');
  assert.equal(placeOf({ app: 'Google Chrome', title: 'x', url: 'https://app.sourcewhale.com/campaigns' }), 'SourceWhale');
  assert.equal(placeOf({ kind: 'call', app: 'Call' }), 'Call');
});
ok('digest finds time, workflows, copy-paste and writing', () => {
  const t0 = new Date('2026-11-03T09:00:00').getTime();
  const ev = [];
  const at = (m) => t0 + m * 60000;
  const loop = ['(1) Sam Carter | LinkedIn', 'Bullhorn - Candidates', 'SourceWhale - Campaigns'];
  for (let i = 0; i < 4; i++) {
    loop.forEach((title, j) => {
      const m = i * 9 + j * 3;
      ev.push({ t: at(m), type: 'focus', kind: 'normal', app: 'Google Chrome', title });
      ev.push({ t: at(m) + 1000, type: 'minute', keys: 40, chars: 30, bksp: 3, iki: 180, dwell: 90, mouse: 4000, clicks: 3, right: 0, dbl: 0, scroll: 2, shortcuts: { 'Ctrl+C': 1 } });
      ev.push({ t: at(m + 1) + 1000, type: 'minute', keys: 10, chars: 8, bksp: 0, mouse: 2000, clicks: 1, right: 0, dbl: 0, scroll: 0, shortcuts: {} });
    });
    ev.push({ t: at(i * 9) + 5000, type: 'copy', app: 'Google Chrome', title: loop[0], len: 10, text: 'Sam Carter' });
    ev.push({ t: at(i * 9 + 3) + 5000, type: 'paste', app: 'Google Chrome', title: loop[1], len: 10, fromApp: 'Google Chrome', fromTitle: loop[0] });
  }
  ev.push({ t: at(40), type: 'typed', app: 'OUTLOOK', title: 'Re: Systems Engineers', text: 'Hi Sam, thanks for coming back to me. When are you free for a call?', words: 14, submitted: true, via: 'enter' });
  const a = analyse(ev);
  assert.ok(a.timeBy.find(([k]) => k === 'LinkedIn'), 'LinkedIn time');
  assert.ok(a.workflows.some(([k, c]) => k.startsWith('LinkedIn → Bullhorn → SourceWhale') && c >= 3), JSON.stringify(a.workflows));
  assert.ok(a.flows.some(([k]) => k === 'LinkedIn → Bullhorn'), JSON.stringify(a.flows));
  const { markdown } = dayMarkdown('2026-11-03', ev);
  assert.ok(markdown.includes('When are you free for a call?'));
  assert.ok(markdown.includes('Sequences I repeated'));
});
console.log(`\n${n} unit checks passed`);
