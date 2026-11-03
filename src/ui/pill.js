/* global pill */
const capsule = document.getElementById('pill');
const sub = document.getElementById('sub');
const eye = document.getElementById('eye');
const cam = document.getElementById('cam');
const send = document.getElementById('send');
const prompt = document.getElementById('prompt');
const body = document.body;
const COMPACT_W = 164;
const MORPH_MS = 340;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let state = null;
let subTimer = null;
let includeScreen = false; // one-off "include my screen" for this question
let morphing = false;

const isBar = () => body.classList.contains('bar');

function baseSub() {
  if (!state) return '';
  const sh = state.shadow || {};
  if (!state.watching && sh.mode === 'recording') return 'Learning';
  if (!state.watching && sh.mode === 'paused') return 'Learning paused';
  if (!state.watching) return 'Screen off';
  return state.rewindCount ? `Watching · ${state.rewindCount}` : 'Watching';
}

function renderCam() {
  const watching = !!(state && state.watching);
  const on = watching || includeScreen;
  cam.setAttribute('aria-pressed', String(on));
  cam.disabled = watching;
  cam.title = watching ? 'Watching is on, so your screen is included'
    : (includeScreen ? 'Your screen will be included. Click to skip it' : 'Include my screen with this question');
  prompt.placeholder = on ? 'Ask Claude about your screen…' : 'Ask Claude…';
}

function render(s) {
  state = s;
  capsule.classList.toggle('watching', !!s.watching);
  capsule.classList.toggle('learning', !s.watching && !!(s.shadow && s.shadow.mode === 'recording'));
  body.classList.toggle('anchor-left', s.anchor === 'left');
  eye.title = s.watching ? 'Stop watching my screen' : 'Watch my screen';
  eye.setAttribute('aria-pressed', String(!!s.watching));
  if (!morphing) body.classList.toggle('bar', s.pillMode === 'bar');
  if (!subTimer) sub.textContent = baseSub();
  renderCam();
}

function say(text, ms = 2200) {
  clearTimeout(subTimer);
  sub.textContent = text;
  subTimer = setTimeout(() => { subTimer = null; sub.textContent = baseSub(); }, ms);
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));

// The window resizes instantly; the capsule animates its width inside the (transparent) window.
async function openBar() {
  if (isBar() || morphing) return;
  morphing = true;
  capsule.style.transition = 'none';
  capsule.style.width = `${COMPACT_W}px`;
  await pill.setPillMode('bar');
  await nextFrame();
  capsule.style.transition = '';
  body.classList.add('bar');
  capsule.style.width = '';
  prompt.focus();
  await wait(MORPH_MS);
  morphing = false;
}

async function closeBar() {
  if (!isBar() || morphing) return;
  morphing = true;
  capsule.style.width = `${COMPACT_W}px`;
  body.classList.remove('bar');
  await wait(MORPH_MS);
  await pill.setPillMode('pill');
  capsule.style.width = '';
  includeScreen = false;
  prompt.value = '';
  send.disabled = true;
  renderCam();
  morphing = false;
}

pill.getState().then(render);
pill.onState(render);
pill.onFlash(() => {
  capsule.classList.remove('flash'); void capsule.offsetWidth; capsule.classList.add('flash');
  say('Seeing your screen…', 1400);
});
pill.onToast((t) => {
  if (!t) return;
  if (t.kind === 'focus-prompt') { prompt.focus(); prompt.select(); return; }
  if (t.text && t.kind === 'watch') say('Watching on');
});

for (const b of [eye, cam, send, document.getElementById('open')]) b.addEventListener('pointerdown', (e) => e.stopPropagation());
eye.addEventListener('click', (e) => { e.stopPropagation(); pill.toggleWatching(); });
cam.addEventListener('click', (e) => { e.stopPropagation(); includeScreen = !includeScreen; renderCam(); prompt.focus(); });
document.getElementById('open').addEventListener('click', (e) => { e.stopPropagation(); pill.expand(); });
prompt.addEventListener('pointerdown', (e) => e.stopPropagation());
prompt.addEventListener('input', () => { send.disabled = !prompt.value.trim(); });

document.getElementById('ask').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = prompt.value.trim();
  if (!text) { pill.expand(); return; }
  body.classList.add('thinking');
  const withScreen = includeScreen;
  prompt.value = '';
  send.disabled = true;
  includeScreen = false;
  renderCam();
  try { await pill.submitPrompt(text, withScreen); } finally { body.classList.remove('thinking'); }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isBar()) closeBar(); });
// Clicking away from an empty bar folds it back into the pill.
window.addEventListener('blur', () => { setTimeout(() => { if (isBar() && !prompt.value.trim() && !document.hasFocus()) closeBar(); }, 120); });

// Drag to move (anywhere that isn't a button or the text box). Click opens the prompt bar.
let drag = null;
capsule.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  capsule.setPointerCapture(e.pointerId);
  drag = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY, moved: false };
});
capsule.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.sx;
  const dy = e.screenY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  capsule.classList.add('dragging');
  pill.pillMove(drag.wx + dx, drag.wy + dy);
});
capsule.addEventListener('pointerup', () => {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  capsule.classList.remove('dragging');
  if (moved) pill.pillDragEnd();
  else if (!isBar()) openBar();
  else prompt.focus();
});
capsule.addEventListener('dblclick', (e) => { if (!isBar()) { e.preventDefault(); pill.expand(); } });
capsule.addEventListener('contextmenu', (e) => { e.preventDefault(); pill.pillMenu(); });
capsule.tabIndex = 0;
capsule.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === capsule) { e.preventDefault(); openBar(); } });
