/* global pill */
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const drawer = $('drawer');
const banner = $('banner');
let state = null;
let statusTimer = null;

const BOOKMARKLET = "javascript:(()=>{location.href='thepill://open?url='+encodeURIComponent(location.href)})()";

function baseStatus() {
  if (!state) return '';
  if (!state.watching) return 'Screen off · Claude sees only what you share';
  return state.rewindCount ? `Watching your screen · Rewind ${state.rewindCount}` : 'Watching your screen';
}

function setStatus(text, kind = 'info', ms = 3500) {
  clearTimeout(statusTimer);
  statusEl.className = 'status';
  if (!text) { statusTimer = null; statusEl.textContent = baseStatus(); return; }
  statusEl.textContent = text;
  statusEl.title = text;
  statusEl.classList.add(kind);
  statusTimer = setTimeout(() => { statusTimer = null; statusEl.className = 'status'; statusEl.textContent = baseStatus(); }, ms);
}

function syncOverlay() {
  let h = 0;
  if (!banner.hidden) h += banner.offsetHeight;
  if (!drawer.hidden) h += drawer.offsetHeight;
  pill.setOverlay(h);
}

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
  $('rewindCount').textContent = s.watching && s.rewindCount ? String(s.rewindCount) : '';
  if (!statusTimer) statusEl.textContent = baseStatus();

  for (const input of document.querySelectorAll('[data-set]')) {
    const v = s.settings[input.dataset.set];
    if (input.type === 'checkbox') input.checked = !!v;
    else if (document.activeElement !== input) input.value = String(v);
  }
  $('dockToggle').checked = !!s.docked;
  $('opacityRow').hidden = s.platform === 'linux';
  $('loginRow').hidden = s.platform === 'linux';
  $('hideSelfRow').hidden = s.platform === 'linux';
  $('sightNote').textContent = s.platform === 'linux'
    ? (s.wayland ? 'Wayland: your desktop may ask you to approve each screenshot. An X11 session avoids that.' : 'Linux can’t exclude The Pill from screenshots, so the panel may appear in them.')
    : (s.platform === 'darwin' ? 'macOS asks once for Screen Recording permission (System Settings → Privacy & Security).' : '');
  const names = { toggleChat: 'Open / shrink Claude', shareScreen: 'Share screen now', toggleWatching: 'Watching on / off' };
  $('keys').replaceChildren(...Object.entries(s.shortcuts).map(([k, v]) => {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.textContent = names[k] || k;
    const kbd = document.createElement('kbd'); kbd.textContent = v.keys;
    li.append(name, v.ok ? kbd : Object.assign(document.createElement('span'), { className: 'bad', textContent: `${v.keys} (taken by another app)` }));
    return li;
  }));
  $('version').textContent = `v${s.version}`;
}

function toggleDrawer(open = drawer.hidden) {
  drawer.hidden = !open;
  $('more').setAttribute('aria-expanded', String(open));
  syncOverlay();
}

// toolbar
$('watch').onclick = () => pill.toggleWatching();
$('share').onclick = () => { setStatus('Taking a screenshot…', 'capture'); pill.shareScreen(); };
$('rewind').onclick = () => { setStatus('Building Rewind…', 'capture'); pill.shareRewind(); };
$('newChat').onclick = () => pill.newChat();
$('more').onclick = () => toggleDrawer();
$('collapse').onclick = () => { toggleDrawer(false); pill.collapse(); };
$('bannerClose').onclick = () => { banner.hidden = true; syncOverlay(); };
$('bannerAction').onclick = () => {
  const id = $('bannerAction').dataset.id;
  if (id === 'screen-settings') pill.openScreenSettings();
  if (id === 'reload') pill.reload();
  banner.hidden = true; syncOverlay();
};

// drawer
const acts = {
  recents: () => { pill.recents(); toggleDrawer(false); },
  back: () => pill.back(),
  browser: () => pill.openInBrowser(),
  clip: async () => { if (await pill.linkFromClipboard()) toggleDrawer(false); },
  reload: () => pill.reload(),
  quit: () => pill.quit(),
  copyBookmarklet: async () => { await pill.copyText(BOOKMARKLET); setStatus('Bookmarklet copied — add it as a bookmark’s URL', 'capture'); },
};
drawer.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && acts[b.dataset.act]) acts[b.dataset.act]();
});
drawer.addEventListener('change', (e) => {
  const input = e.target;
  if (input.id === 'dockToggle') { pill.toggleDock(); return; }
  const key = input.dataset.set;
  if (!key) return;
  let v = input.type === 'checkbox' ? input.checked : input.value;
  if ('num' in input.dataset) v = Number(v);
  pill.setSettings({ [key]: v });
});
$('opacityRow').querySelector('input').addEventListener('input', (e) => pill.setSettings({ opacity: Number(e.target.value) }));
$('linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = await pill.openLink($('linkInput').value);
  if (ok) { $('linkInput').value = ''; toggleDrawer(false); } else setStatus('That isn’t a claude.ai link', 'warn');
});
const bm = $('bookmarklet');
bm.href = BOOKMARKLET;
bm.addEventListener('click', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) toggleDrawer(false); });
new ResizeObserver(() => syncOverlay()).observe(drawer);

// main -> ui
pill.getState().then(render);
pill.onState(render);
pill.onToast((t) => {
  if (!t) return;
  if (t.kind === 'open-settings') { toggleDrawer(true); return; }
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
      g.font = `600 ${Math.round(cw / 34)}px system-ui, sans-serif`;
      const tw = g.measureText(label).width;
      const pad = Math.round(cw / 80);
      const lh = Math.round(cw / 34) + pad * 2;
      g.fillStyle = 'rgba(0,0,0,0.72)';
      g.fillRect(x, y, tw + pad * 2, lh);
      g.fillStyle = '#fff';
      g.textBaseline = 'middle';
      g.fillText(label, x + pad, y + lh / 2);
    });
    pill.composeDone(id, c.toDataURL('image/jpeg', 0.85));
  } catch (err) {
    pill.composeDone(id, null, err.message);
  }
});
