/* global pill */
const $ = (id) => document.getElementById(id);
const BOOKMARKLET = "javascript:(()=>{location.href='thepill://open?url='+encodeURIComponent(location.href)})()";
let state = null;

function placeThumb(seg) {
  const on = seg.querySelector('button[aria-pressed="true"]');
  if (!on) { seg.style.setProperty('--w', '0px'); return; }
  seg.style.setProperty('--x', `${on.offsetLeft}px`);
  seg.style.setProperty('--w', `${on.offsetWidth}px`);
}

function render(s) {
  state = s;
  for (const el of document.querySelectorAll('.switch[data-set]')) el.setAttribute('aria-checked', String(!!s.settings[el.dataset.set]));
  $('dockToggle').setAttribute('aria-checked', String(!!s.docked));
  for (const seg of document.querySelectorAll('.seg[data-set]')) {
    const v = String(s.settings[seg.dataset.set]);
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === v));
    placeThumb(seg);
  }
  if (document.activeElement !== $('opacity')) $('opacity').value = String(s.settings.opacity);
  const linux = s.platform === 'linux';
  $('opacityRow').hidden = linux;
  $('loginRow').hidden = linux;
  $('hideSelfRow').hidden = linux;
  $('sightNote').textContent = linux
    ? (s.wayland ? 'On Wayland your desktop may ask you to approve each screenshot.' : 'Linux can’t hide The Pill from its own screenshots, so the panel may appear in them.')
    : (s.platform === 'darwin' ? 'macOS asks once for Screen Recording permission (System Settings → Privacy & Security).' : '');
  const names = { toggleChat: 'Open or shrink Claude', shareScreen: 'Share screen now', toggleWatching: 'Watching on or off' };
  $('keys').replaceChildren(...Object.entries(s.shortcuts).map(([k, v]) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = names[k] || k;
    let right;
    if (v.ok) { right = document.createElement('kbd'); right.textContent = v.keys; }
    else { right = document.createElement('span'); right.className = 'bad'; right.textContent = `${v.keys} is used by another app`; }
    li.append(name, right);
    return li;
  }));
  $('version').textContent = `The Pill ${s.version}`;
}

// switches
document.addEventListener('click', (e) => {
  const sw = e.target.closest('.switch');
  if (sw) {
    const next = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(next));
    if (sw.id === 'dockToggle') pill.toggleDock();
    else pill.setSettings({ [sw.dataset.set]: next });
    return;
  }
  const segBtn = e.target.closest('.seg button');
  if (segBtn) {
    const seg = segBtn.parentElement;
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === segBtn));
    placeThumb(seg);
    const v = 'num' in seg.dataset ? Number(segBtn.dataset.v) : segBtn.dataset.v;
    pill.setSettings({ [seg.dataset.set]: v });
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act && acts[act.dataset.act]) acts[act.dataset.act](act);
});

const acts = {
  recents: () => { pill.recents(); pill.toggleSettings(false); },
  back: () => pill.back(),
  browser: () => pill.openInBrowser(),
  clip: async () => { if (await pill.linkFromClipboard()) pill.toggleSettings(false); },
  reload: () => pill.reload(),
  quit: () => pill.quit(),
  copyBookmarklet: async (btn) => {
    await pill.copyText(BOOKMARKLET);
    const was = btn.textContent;
    btn.textContent = 'Copied. Paste it as a bookmark’s address';
    setTimeout(() => { btn.textContent = was; }, 2600);
  },
};

$('opacity').addEventListener('input', (e) => pill.setSettings({ opacity: Number(e.target.value) }));
$('linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('linkInput');
  if (await pill.openLink(input.value)) { input.value = ''; pill.toggleSettings(false); }
  else { input.setCustomValidity('That isn’t a claude.ai link'); input.reportValidity(); setTimeout(() => input.setCustomValidity(''), 2000); }
});
$('close').addEventListener('click', () => pill.toggleSettings(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') pill.toggleSettings(false); });

pill.onSettingsAnim(({ open }) => {
  document.body.classList.toggle('open', !!open);
  if (open) {
    $('scroll').scrollTop = 0;
    requestAnimationFrame(() => document.querySelectorAll('.seg').forEach(placeThumb));
  }
});
pill.getState().then(render);
pill.onState(render);
window.addEventListener('resize', () => document.querySelectorAll('.seg').forEach(placeThumb));
