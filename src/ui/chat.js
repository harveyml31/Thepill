/* global pill */
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const banner = $('banner');
let state = null;
let statusTimer = null;
let shownText = '';

function baseStatus() {
  if (!state) return '';
  if (!state.watching) return 'Screen off · Claude sees only what you share';
  return state.rewindCount ? `Watching your screen · Rewind ${state.rewindCount}` : 'Watching your screen';
}

/** Swap the status line with a short slide so changes are noticed but quiet. */
function showStatus(text, kind = '') {
  if (text === shownText && statusEl.dataset.kind === kind) return;
  shownText = text;
  statusEl.dataset.kind = kind;
  statusEl.classList.add('out');
  setTimeout(() => {
    statusEl.textContent = text;
    statusEl.title = text;
    statusEl.className = `status in ${kind}`;
    requestAnimationFrame(() => requestAnimationFrame(() => { statusEl.className = `status ${kind}`; }));
  }, 140);
}

function setStatus(text, kind = 'info', ms = 3500) {
  clearTimeout(statusTimer);
  if (!text) { statusTimer = null; showStatus(baseStatus()); return; }
  showStatus(text, kind);
  statusTimer = setTimeout(() => { statusTimer = null; showStatus(baseStatus()); }, ms);
}

function syncOverlay() { pill.setOverlay(banner.hidden ? 0 : banner.offsetHeight + 10); }

function showBanner(text, action) {
  $('bannerText').textContent = text;
  $('bannerAction').textContent = action ? action.label : '';
  $('bannerAction').dataset.id = action ? action.id : '';
  banner.hidden = false;
  syncOverlay();
}

function render(s) {
  state = s;
  document.body.classList.toggle('watching', !!s.watching);
  const w = $('watch');
  w.classList.toggle('on', !!s.watching);
  w.setAttribute('aria-pressed', String(!!s.watching));
  w.title = s.watching ? 'Stop watching my screen' : 'Watch my screen (every message includes a screenshot)';
  $('watchLabel').textContent = s.watching ? 'Watching' : 'Screen off';
  $('rewind').hidden = !s.rewindEnabled;
  $('rewind').disabled = !s.watching || !s.rewindCount;
  const count = s.watching && s.rewindCount ? String(s.rewindCount) : '';
  if ($('rewindCount').textContent !== count) $('rewindCount').textContent = count;
  $('more').setAttribute('aria-expanded', String(!!s.settingsOpen));
  if (!statusTimer) showStatus(baseStatus());
}

// toolbar
$('watch').onclick = () => pill.toggleWatching();
$('share').onclick = () => { setStatus('Taking a screenshot…', 'capture'); pill.shareScreen(); };
$('rewind').onclick = () => { setStatus('Building Rewind…', 'capture'); pill.shareRewind(); };
$('newChat').onclick = () => pill.newChat();
$('more').onclick = () => pill.toggleSettings();
$('collapse').onclick = () => pill.collapse();
$('bannerClose').onclick = () => { banner.hidden = true; syncOverlay(); };
$('bannerAction').onclick = () => {
  const id = $('bannerAction').dataset.id;
  if (id === 'screen-settings') pill.openScreenSettings();
  if (id === 'reload') pill.reload();
  banner.hidden = true; syncOverlay();
};

// main -> ui
pill.getState().then(render);
pill.onState(render);
pill.onToast((t) => {
  if (!t) return;
  if (t.kind === 'open-settings') { pill.toggleSettings(true); return; }
  if (t.kind === 'shown') {
    document.body.classList.remove('enter'); void document.body.offsetWidth; document.body.classList.add('enter');
    setTimeout(() => document.body.classList.remove('enter'), 700);
    return;
  }
  if (t.kind === 'clear') { setStatus(''); return; }
  if (t.action) showBanner(t.text, t.action);
  else setStatus(t.text, t.kind, t.kind === 'warn' ? 6000 : 3500);
});
pill.onFlash(() => {
  document.body.classList.remove('flash'); void document.body.offsetWidth; document.body.classList.add('flash');
});

// Rewind compositor: frames -> one labelled grid image.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('bad frame'));
    img.src = src;
  });
}
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'now';
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s ago` : `${s}s ago`;
}
pill.onCompose(async ({ id, frames, now }) => {
  try {
    const imgs = await Promise.all(frames.map((f) => loadImage(f.dataUrl)));
    const n = imgs.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
    const rows = Math.ceil(n / cols);
    const gap = 8;
    const cw = n === 1 ? 1280 : cols === 2 ? 900 : 640;
    const ch = Math.round(cw * (imgs[0].naturalHeight / imgs[0].naturalWidth));
    const c = $('compositor');
    c.width = cols * cw + (cols + 1) * gap;
    c.height = rows * ch + (rows + 1) * gap;
    const g = c.getContext('2d');
    g.fillStyle = '#1f1e1d';
    g.fillRect(0, 0, c.width, c.height);
    imgs.forEach((img, i) => {
      const x = gap + (i % cols) * (cw + gap);
      const y = gap + Math.floor(i / cols) * (ch + gap);
      const r = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
      const w = img.naturalWidth * r; const h = img.naturalHeight * r;
      g.drawImage(img, x + (cw - w) / 2, y + (ch - h) / 2, w, h);
      const t = new Date(frames[i].at);
      const label = `${i + 1}/${n} · ${t.toLocaleTimeString()} · ${i === n - 1 ? 'now' : ago(now - frames[i].at)}`;
      const fs = Math.round(cw / 40);
      g.font = `600 ${fs}px system-ui, sans-serif`;
      const pad = Math.round(fs * 0.55);
      const tw = g.measureText(label).width;
      const lh = fs + pad * 2;
      g.fillStyle = 'rgba(20,20,19,0.78)';
      g.beginPath();
      g.roundRect(x + pad, y + pad, tw + pad * 2, lh, lh / 2);
      g.fill();
      g.fillStyle = '#fff';
      g.textBaseline = 'middle';
      g.fillText(label, x + pad * 2, y + pad + lh / 2);
    });
    pill.composeDone(id, c.toDataURL('image/jpeg', 0.85));
  } catch (err) {
    pill.composeDone(id, null, err.message);
  }
});
