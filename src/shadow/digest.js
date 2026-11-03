'use strict';
// Turns a day of Shadow events into a compact Markdown log for Claude to read, plus the numbers
// shown in the app. Everything here runs locally.

const BROWSERS = /chrome|chromium|safari|firefox|edge|msedge|brave|arc|opera|vivaldi/i;
const KNOWN_SITES = [
  [/linkedin/i, 'LinkedIn'], [/bullhorn/i, 'Bullhorn'], [/sourcewhale/i, 'SourceWhale'], [/outlook|office365|owa/i, 'Outlook'],
  [/gmail|mail\.google/i, 'Gmail'], [/claude\.ai|claude —|the pill/i, 'Claude'], [/granola/i, 'Granola'], [/greenhouse/i, 'Greenhouse'],
  [/lever\.co/i, 'Lever'], [/apollo/i, 'Apollo'], [/teams/i, 'Teams'], [/slack/i, 'Slack'], [/calendar/i, 'Calendar'],
  [/docs\.google|google docs/i, 'Google Docs'], [/sheets\.google|google sheets/i, 'Google Sheets'], [/excel/i, 'Excel'], [/word/i, 'Word'],
];

function placeOf(e) {
  if (e.kind === 'call') return 'Call';
  if (e.kind === 'private') return 'Private';
  const hay = `${e.url || ''} ${e.title || ''} ${e.app || ''}`;
  for (const [re, name] of KNOWN_SITES) if (re.test(hay)) return name;
  if (e.url) { try { return new URL(e.url).hostname.replace(/^www\./, ''); } catch { /* fall through */ } }
  if (BROWSERS.test(e.app || '')) {
    const parts = String(e.title || '').split(/ [-–|] /);
    return (parts.length > 1 ? parts[parts.length - 2] : parts[0]).trim().slice(0, 40) || e.app;
  }
  return (e.app || 'Unknown').replace(/\.exe$/i, '');
}

const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const mins = (ms) => Math.round(ms / 60000);
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`);

function analyse(events) {
  const ev = [...events].sort((a, b) => a.t - b.t);
  const focus = ev.filter((e) => e.type === 'focus');
  const minutes = ev.filter((e) => e.type === 'minute');
  const activeSet = new Set(minutes.map((m) => Math.floor(m.t / 60000)));
  const lastT = ev.length ? ev[ev.length - 1].t : 0;

  // Time per place: each focus lasts until the next one, capped, counting only minutes with activity.
  const timeBy = {};
  const blocks = [];
  focus.forEach((f, i) => {
    const end = Math.min(i + 1 < focus.length ? focus[i + 1].t : lastT, f.t + 30 * 60000);
    let active = 0;
    for (let m = Math.floor(f.t / 60000); m <= Math.floor(end / 60000); m++) if (activeSet.has(m)) active++;
    // Calls count in full; elsewhere only minutes where you were actually typing, clicking or moving.
    const dur = f.kind === 'call' ? end - f.t : Math.min(end - f.t, active * 60000);
    const place = placeOf(f);
    timeBy[place] = (timeBy[place] || 0) + Math.max(0, dur);
    const prev = blocks[blocks.length - 1];
    if (prev && prev.place === place && f.t - prev.end < 3 * 60000) { prev.end = end; prev.titles.add(f.title || ''); }
    else blocks.push({ place, start: f.t, end, titles: new Set([f.title || '']) });
  });

  // Repeated workflows: sequences of places you move through.
  const seq = blocks.map((b) => b.place).filter((p) => p !== 'Private');
  const grams = {};
  for (const n of [3, 4]) {
    for (let i = 0; i + n <= seq.length; i++) {
      const g = seq.slice(i, i + n);
      if (new Set(g).size < 2) continue;
      const k = g.join(' → ');
      grams[k] = (grams[k] || 0) + 1;
    }
  }
  const workflows = Object.entries(grams).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 12);

  // Copy -> paste between places.
  const flows = {};
  for (const p of ev.filter((e) => e.type === 'paste' && e.fromApp != null)) {
    const from = placeOf({ app: p.fromApp, title: p.fromTitle });
    const to = placeOf(p);
    if (from === to) continue;
    const k = `${from} → ${to}`;
    flows[k] = (flows[k] || 0) + 1;
  }

  const typed = ev.filter((e) => e.type === 'typed' && e.text);
  const hidden = ev.filter((e) => e.type === 'typed' && e.hidden).length;
  const words = typed.reduce((s, e) => s + (e.words || 0), 0);
  const sent = typed.filter((e) => e.submitted && e.via === 'enter' && (e.words || 0) >= 2).length;

  const sum = (k) => minutes.reduce((s, m) => s + (m[k] || 0), 0);
  const typingMins = minutes.filter((m) => m.chars > 20).length || 1;
  const ikis = minutes.filter((m) => m.iki).map((m) => m.iki);
  const dwells = minutes.filter((m) => m.dwell).map((m) => m.dwell);
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const shortcuts = {};
  for (const m of minutes) for (const [k, v] of Object.entries(m.shortcuts || {})) shortcuts[k] = (shortcuts[k] || 0) + v;

  const rhythm = {
    activeMinutes: minutes.length,
    wpm: Math.round(sum('chars') / 5 / typingMins),
    backspaceRate: sum('keys') ? Math.round((sum('bksp') / sum('keys')) * 100) : 0,
    medianGapMs: median(ikis),
    medianHoldMs: median(dwells),
    mouseMetres: Math.round((sum('mouse') * 0.00026) * 10) / 10,
    clicks: sum('clicks'),
    rightClicks: sum('right'),
    scroll: sum('scroll'),
    topShortcuts: Object.entries(shortcuts).sort((a, b) => b[1] - a[1]).slice(0, 8),
  };

  return {
    first: ev.length ? ev[0].t : null, last: lastT || null,
    timeBy: Object.entries(timeBy).filter(([, v]) => v >= 30000).map(([k, v]) => [k, Math.max(1, mins(v))]).sort((a, b) => b[1] - a[1]),
    blocks, workflows, flows: Object.entries(flows).sort((a, b) => b[1] - a[1]).slice(0, 10),
    typed, words, sent, hidden, rhythm,
    frames: ev.filter((e) => e.type === 'frame').length,
    calls: blocks.filter((b) => b.place === 'Call').reduce((s, b) => s + mins(b.end - b.start), 0),
  };
}

const DAY_PROMPT = `This file is a log of one of my working days, recorded on my own computer by The Pill (I'm a recruiter). Read all of it, then tell me:
1. Where my time went, and what surprised you.
2. Workflows I repeat: the steps, how often, roughly how long each takes, and which could be automated.
3. How I write: tone, length, greetings and sign-offs, phrases I use, and how that changes between candidates, clients and colleagues. Quote real examples.
4. Decisions I make again and again, and the rule I seem to be following.
5. The three changes that would save me the most time tomorrow.
Be specific and use the evidence in the log.`;

const WEEK_PROMPT = `These files are logs of my working week, recorded on my own computer by The Pill (I'm a recruiter). Build my operating playbook:
1. A "write like me" guide: my tone, structure, greetings, sign-offs and favourite phrases for each kind of message, with real examples, written so an assistant could draft replies I'd send unchanged.
2. Step-by-step procedures for each workflow I repeat, written so an assistant or automation could follow them.
3. The rules behind my decisions (who I contact, who I skip, how I prioritise).
4. An automation plan ranked by hours saved per week, saying what each needs (connectors, data, approvals).
Use the evidence in the logs and quote it.`;

function dayMarkdown(day, events, { maxTyped = 60000 } = {}) {
  const a = analyse(events);
  const L = [];
  L.push(`# Workday log: ${day}`);
  if (!a.first) { L.push('', 'Nothing was recorded on this day.'); return { markdown: L.join('\n'), a }; }
  L.push('', `Recorded ${hhmm(a.first)}–${hhmm(a.last)} · active ${fmtMin(a.rhythm.activeMinutes)} · ${a.words} words typed · ${a.sent} messages sent with Enter · ${a.rhythm.clicks} clicks${a.calls ? ` · ${fmtMin(a.calls)} on calls (not recorded)` : ''}`);
  L.push('', '## Time by app or site');
  for (const [k, m] of a.timeBy) L.push(`- ${k}: ${fmtMin(m)}`);
  L.push('', '## Timeline');
  for (const b of a.blocks) {
    if (b.end - b.start < 45000 && b.place !== 'Call') continue;
    const titles = [...b.titles].filter(Boolean).slice(0, 3).map((t) => t.slice(0, 90)).join(' / ');
    L.push(`- ${hhmm(b.start)}–${hhmm(b.end)} ${b.place}${titles && b.place !== 'Call' && b.place !== 'Private' ? `: ${titles}` : ''}`);
  }
  if (a.workflows.length) {
    L.push('', '## Sequences I repeated');
    for (const [k, c] of a.workflows) L.push(`- ${k} (${c}×)`);
  }
  if (a.flows.length) {
    L.push('', '## Copy → paste between apps');
    for (const [k, c] of a.flows) L.push(`- ${k} (${c}×)`);
  }
  L.push('', '## What I typed', '(Passwords, codes and anything typed on login pages, in password managers or during calls were never recorded. [pasted N chars] marks a paste.)');
  let budget = maxTyped;
  for (const e of a.typed) {
    if ((e.words || 0) < 2 && !e.submitted) continue;
    const line = `- ${hhmm(e.t)} · ${placeOf(e)}${e.title ? ` (${e.title.slice(0, 60)})` : ''}${e.submitted ? ` · sent with ${e.via}` : ''}: ${e.text.replace(/\n/g, ' ⏎ ')}`;
    if (budget - line.length < 0) { L.push('- …more typing not included to keep this file small'); break; }
    budget -= line.length;
    L.push(line);
  }
  const r = a.rhythm;
  L.push('', '## Typing and mouse rhythm');
  L.push(`- Typing speed while typing: about ${r.wpm} words per minute; corrections: ${r.backspaceRate}% of keys were Backspace`);
  if (r.medianGapMs) L.push(`- Typical gap between keys: ${r.medianGapMs} ms${r.medianHoldMs ? `; typical key hold: ${r.medianHoldMs} ms` : ''}`);
  L.push(`- Mouse: about ${r.mouseMetres} m travelled, ${r.clicks} clicks (${r.rightClicks} right-clicks), scroll ${r.scroll}`);
  if (r.topShortcuts.length) L.push(`- Shortcuts used most: ${r.topShortcuts.map(([k, v]) => `${k} ×${v}`).join(', ')}`);
  return { markdown: L.join('\n'), a };
}

function summaryForUi(events) {
  const a = analyse(events);
  return {
    activeMinutes: a.rhythm.activeMinutes, words: a.words, sent: a.sent, clicks: a.rhythm.clicks, wpm: a.rhythm.wpm,
    backspaceRate: a.rhythm.backspaceRate, mouseMetres: a.rhythm.mouseMetres, hidden: a.hidden,
    topPlaces: a.timeBy.slice(0, 5), topWorkflow: a.workflows[0] || null, frames: a.frames,
  };
}

module.exports = { analyse, dayMarkdown, summaryForUi, placeOf, DAY_PROMPT, WEEK_PROMPT };
