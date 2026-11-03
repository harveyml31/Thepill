/* global pill */
const el = document.getElementById('pill');
const sub = document.getElementById('sub');
const eye = document.getElementById('eye');
const cam = document.getElementById('cam');
const prompt = document.getElementById('prompt');
let state = null;
let subTimer = null;
let includeScreen = false; // one-off "include my screen" for this question

function baseSub() {
  if (!state) return '';
  if (!state.watching) return 'Screen off';
  return state.rewindCount ? `Watching · ${state.rewindCount}` : 'Watching';
}

function renderCam() {
  const on = !!(state && state.watching) || includeScreen;
  cam.setAttribute('aria-pressed', String(on));
  cam.disabled = !!(state && state.watching);
  cam.title = state && state.watching
    ? 'Watching is on — your screen is included'
    : (includeScreen ? 'Your screen will be included — click to skip' : 'Include my screen with this question');
  prompt.placeholder = on ? 'Ask Claude about your screen…' : 'Ask Claude…';
}

function render(s) {
  state = s;
  el.classList.toggle('watching', !!s.watching);
  eye.title = s.watching ? 'Stop watching my screen' : 'Watch my screen';
  eye.setAttribute('aria-pressed', String(!!s.watching));
  document.body.classList.toggle('bar', s.pillMode === 'bar');
  if (!subTimer) sub.textContent = baseSub();
  renderCam();
}

function say(text, ms = 2200) {
  clearTimeout(subTimer);
  sub.textContent = text;
  subTimer = setTimeout(() => { subTimer = null; sub.textContent = baseSub(); }, ms);
}

function openBar() {
  document.body.classList.add('bar');
  pill.setPillMode('bar');
  setTimeout(() => prompt.focus(), 30);
}
function closeBar() {
  document.body.classList.remove('bar');
  includeScreen = false; renderCam();
  pill.setPillMode('pill');
}

pill.getState().then(render);
pill.onState(render);
pill.onFlash(() => {
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  say('Seeing screen…', 1400);
});
pill.onToast((t) => {
  if (!t) return;
  if (t.kind === 'focus-prompt') { prompt.focus(); prompt.select(); return; }
  if (t.text && t.kind === 'watch') say('Watching on');
});

for (const b of [eye, cam, document.getElementById('open'), document.getElementById('close')]) {
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
}
eye.addEventListener('click', (e) => { e.stopPropagation(); pill.toggleWatching(); });
cam.addEventListener('click', (e) => { e.stopPropagation(); includeScreen = !includeScreen; renderCam(); prompt.focus(); });
document.getElementById('open').addEventListener('click', (e) => { e.stopPropagation(); pill.expand(); });
document.getElementById('close').addEventListener('click', (e) => { e.stopPropagation(); closeBar(); });
prompt.addEventListener('pointerdown', (e) => e.stopPropagation());

document.getElementById('ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = prompt.value.trim();
  if (!text) { pill.expand(); return; }
  pill.submitPrompt(text, includeScreen);
  prompt.value = '';
  includeScreen = false;
  renderCam();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('bar')) closeBar();
});

// Drag to move (anywhere that isn't a button / the text box). Click opens the prompt bar.
let drag = null;
el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  el.setPointerCapture(e.pointerId);
  drag = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY, moved: false };
});
el.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.sx;
  const dy = e.screenY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  el.classList.add('dragging');
  pill.pillMove(drag.wx + dx, drag.wy + dy);
});
el.addEventListener('pointerup', () => {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  el.classList.remove('dragging');
  if (moved) pill.pillDragEnd();
  else if (!document.body.classList.contains('bar')) openBar();
  else prompt.focus();
});
el.addEventListener('dblclick', (e) => { if (!document.body.classList.contains('bar')) { e.preventDefault(); pill.expand(); } });
el.addEventListener('contextmenu', (e) => { e.preventDefault(); pill.pillMenu(); });
