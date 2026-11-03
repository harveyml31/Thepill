'use strict';
/*
 * Runs inside the real claude.ai page (isolated world — the page can't see this code).
 *
 * Jobs:
 *  1. Attach screenshots to the message composer (file input -> synthetic paste -> native paste).
 *  2. When "watching" is on, hold every message you send for a moment, attach a fresh
 *     screenshot, then send it — so Claude always sees what you're looking at.
 *  3. Small helpers: focus the composer, insert a text hint.
 *
 * claude.ai's markup can change at any time, so every selector has fallbacks and every
 * failure path still sends your message (just without the screenshot) and reports it.
 */
const { ipcRenderer, webFrame } = require('electron');

let state = { watching: false };
let bypass = false;
let busy = false;
let skipNextAutoCapture = false; // set after a manual share so we don't attach twice

const SEL = {
  editor: [
    '[data-testid="chat-input"][contenteditable="true"]',
    '[data-testid="chat-input"]',
    'div.ProseMirror[contenteditable="true"]',
    '[data-testid="chat-input"] [contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea[data-testid="chat-input"]',
    'textarea',
  ],
  send: [
    'button[aria-label="Send message"]',
    'button[aria-label="Send Message"]',
    'button[aria-label*="send" i]',
    'button[data-testid="send-button"]',
  ],
  file: [
    'input[data-testid="file-upload"]',
    'input#chat-input-file-upload-onpage',
    'input[type="file"][multiple]',
    'input[type="file"]',
  ],
};

const log = (...a) => ipcRenderer.send('claude:log', a.map(String).join(' '));
const status = (text, kind = 'info') => ipcRenderer.send('claude:status', { text, kind });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function visible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function findEditor() {
  const active = document.activeElement;
  if (active && (active.isContentEditable || active.tagName === 'TEXTAREA') && isMainComposer(active)) {
    return active.closest('[contenteditable="true"]') || active;
  }
  for (const s of SEL.editor) {
    const list = [...document.querySelectorAll(s)].filter(visible);
    const main = list.filter(isMainComposer);
    if (main.length) return main[main.length - 1];
  }
  for (const s of SEL.editor) {
    const list = [...document.querySelectorAll(s)].filter(visible);
    if (list.length) return list[list.length - 1];
  }
  return null;
}

/** The region around the composer (editor + buttons + file input). */
function composerRegion(editor) {
  if (!editor) return null;
  const fs = editor.closest('fieldset, form');
  if (fs) return fs;
  let el = editor;
  for (let i = 0; i < 8 && el.parentElement; i++) {
    el = el.parentElement;
    if (el.querySelector('input[type="file"]') && el.querySelectorAll('button').length >= 2) return el;
  }
  return editor.parentElement;
}

/**
 * The main composer is the one that can take attachments (editing an old message can't),
 * or — if claude.ai stops rendering a file input — the bottom-most rich-text editor on the page.
 */
function isMainComposer(el) {
  if (el.closest && el.closest('[data-testid="chat-input"]')) return true;
  const EDITORS = '[contenteditable="true"], textarea';
  let node = el.parentElement;
  for (let i = 0; i < 6 && node && node !== document.body; i++) {
    if (node.querySelector('input[type="file"]')) {
      // The region must hold just this one editor, otherwise we've climbed too far.
      const editors = [...node.querySelectorAll(EDITORS)].filter((x) => !x.parentElement.closest('[contenteditable="true"]'));
      return editors.length === 1;
    }
    node = node.parentElement;
  }
  const editor = el.closest && el.closest('[contenteditable="true"]');
  if (!editor) return false;
  const all = [...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
  if (!all.length) return false;
  const lowest = all.reduce((a, b) => (b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a));
  return lowest === editor || lowest.contains(editor) || editor.contains(lowest);
}

function findSendButton(editor = findEditor()) {
  const region = composerRegion(editor);
  const roots = region ? [region, document] : [document];
  for (const root of roots) {
    for (const s of SEL.send) {
      const btn = [...root.querySelectorAll(s)].filter(visible).pop();
      if (btn) return btn;
    }
  }
  return null;
}

function isSendButton(btn) {
  if (!btn || btn.tagName !== 'BUTTON') return false;
  const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('data-testid') || ''}`;
  if (/send/i.test(label)) return true;
  if (btn.type === 'submit') {
    const region = btn.closest('fieldset, form');
    return !!(region && region.querySelector('[contenteditable="true"], textarea'));
  }
  return false;
}

function findFileInput(editor = findEditor()) {
  const region = composerRegion(editor);
  if (region) {
    for (const s of SEL.file) {
      const el = region.querySelector(s);
      if (el) return el;
    }
  }
  for (const s of SEL.file) {
    const list = [...document.querySelectorAll(s)];
    const imageOk = list.filter((i) => !i.accept || /image|\*/.test(i.accept));
    if (imageOk.length) return imageOk[imageOk.length - 1];
  }
  return null;
}

function editorText(editor = findEditor()) {
  if (!editor) return '';
  return (editor.tagName === 'TEXTAREA' ? editor.value : editor.innerText || '').trim();
}

function focusEditor(editor = findEditor()) {
  if (!editor) return false;
  editor.focus();
  if (editor.isContentEditable) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return true;
}

function insertText(text) {
  const editor = findEditor();
  if (!editor) return false;
  focusEditor(editor);
  if (editor.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(editor, (editor.value ? editor.value + '\n' : '') + text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  return document.execCommand('insertText', false, text);
}

const THUMBS = '[data-testid="file-thumbnail"], [data-testid*="attachment" i], button[aria-label="Remove"]';

/**
 * Resolve true if an attachment appears within `ms`: claude.ai's attachment card, or anything new
 * in the composer area other than typed text.
 */
function watchForAttachment(region, editor, ms = 2500) {
  return new Promise((resolve) => {
    const before = document.querySelectorAll(THUMBS).length;
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (obs) obs.disconnect(); clearInterval(poll); clearTimeout(t); resolve(v); };
    let obs = null;
    if (region) {
      obs = new MutationObserver((muts) => {
        for (const m of muts) {
          if (editor && editor.contains(m.target)) continue;
          for (const n of m.addedNodes) if (n.nodeType === 1) { finish(true); return; }
        }
      });
      obs.observe(region, { childList: true, subtree: true });
    }
    const poll = setInterval(() => { if (document.querySelectorAll(THUMBS).length > before) finish(true); }, 100);
    const t = setTimeout(() => finish(false), ms);
  });
}

/**
 * claude.ai is a React app: setting files on its hidden input doesn't always reach React's
 * handler. React's props live on the element in the page's own JavaScript world, which this
 * isolated script can't see, so ask the page world to call onChange directly.
 * Returns true if React's handler was found and called.
 */
async function reactFileChange(input) {
  const mark = `pill-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  input.setAttribute('data-pill-upload', mark);
  try {
    return await webFrame.executeJavaScript(`(() => {
      const inp = document.querySelector('[data-pill-upload="${mark}"]');
      if (!inp) return false;
      const key = Object.keys(inp).find((k) => k.startsWith('__reactProps$'));
      const onChange = key && inp[key] && inp[key].onChange;
      if (typeof onChange !== 'function') return false;
      const ev = { target: inp, currentTarget: inp, type: 'change', bubbles: true, nativeEvent: new Event('change'),
        preventDefault() {}, stopPropagation() {}, persist() {}, isDefaultPrevented: () => false, isPropagationStopped: () => false };
      onChange(ev);
      return true;
    })()`);
  } catch (err) {
    log('react onChange failed:', err.message);
    return false;
  } finally {
    input.removeAttribute('data-pill-upload');
  }
}

function makeFiles(files) {
  return files.map((f) => new File([f.data], f.name, { type: f.mime, lastModified: Date.now() }));
}

function dataTransferOf(fileObjs) {
  const dt = new DataTransfer();
  for (const f of fileObjs) dt.items.add(f);
  return dt;
}

async function attachFiles(files) {
  const editor = findEditor();
  if (!editor) throw new Error('Could not find the message box (are you signed in to claude.ai?)');
  const region = composerRegion(editor);
  const fileObjs = makeFiles(files);

  // 1) Hidden <input type=file> that the paperclip button uses.
  const input = findFileInput(editor);
  if (input) {
    const seen = watchForAttachment(region, editor);
    let how = 'file-input';
    try {
      input.files = dataTransferOf(fileObjs).files;
      if (await reactFileChange(input)) how = 'react';
      else {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (err) { log('file-input attach failed:', err.message); }
    if (await seen) return how;
  }

  // 2) A paste event carrying the files, like pasting an image.
  {
    focusEditor(editor);
    const seen = watchForAttachment(region, editor);
    const ev = new ClipboardEvent('paste', { clipboardData: dataTransferOf(fileObjs), bubbles: true, cancelable: true });
    editor.dispatchEvent(ev);
    if (await seen) return 'paste-event';
  }

  // 3) A real paste through the OS clipboard (main process restores your clipboard after).
  for (const f of files) {
    focusEditor(editor);
    const seen = watchForAttachment(region, editor, 3000);
    await ipcRenderer.invoke('claude:native-paste-image', f);
    if (!(await seen)) throw new Error('claude.ai did not accept the screenshot');
  }
  return 'native-paste';
}

/** Wait until the upload is finished and the send button is usable. */
async function waitUntilSendable(timeout = 20000) {
  const start = Date.now();
  await sleep(500);
  while (Date.now() - start < timeout) {
    const btn = findSendButton();
    const region = composerRegion(findEditor());
    const uploading = region && region.querySelector('[aria-busy="true"], [role="progressbar"], .animate-spin');
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && !uploading) return true;
    await sleep(150);
  }
  return false;
}

function triggerSend() {
  bypass = true;
  try {
    const btn = findSendButton();
    if (btn && !btn.disabled) {
      btn.click();
    } else {
      const editor = findEditor();
      if (editor) {
        focusEditor(editor);
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      }
    }
  } finally {
    setTimeout(() => { bypass = false; }, 80);
  }
}

async function sendWithScreen({ force = false } = {}) {
  if (busy) return;
  busy = true;
  try {
    status('Looking at your screen…', 'capture');
    const files = await ipcRenderer.invoke('claude:capture-for-send', { force });
    if (files && files.length) {
      const how = await attachFiles(files);
      log('auto-attached via', how);
      const ready = await waitUntilSendable();
      if (!ready) status('Upload slow — sending anyway', 'warn');
    }
    status('', 'clear');
  } catch (err) {
    log('auto-attach failed:', err.message);
    status(`Sent without screenshot: ${err.message}`, 'warn');
  } finally {
    triggerSend();
    busy = false;
  }
}

function shouldAutoCapture() {
  if (bypass || !state.watching) return false;
  if (skipNextAutoCapture) return false;
  return true;
}

// ---- Send interception (capture phase on window: runs before the page's own handlers) ----
window.addEventListener('keydown', (e) => {
  if (bypass) return;
  if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return;
  const target = e.target;
  if (!target || !(target.isContentEditable || target.tagName === 'TEXTAREA')) return;
  if (!isMainComposer(target)) return;
  if (busy) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  if (!editorText()) return; // nothing typed: let claude.ai do whatever it does
  if (!shouldAutoCapture()) { skipNextAutoCapture = false; return; }
  e.preventDefault();
  e.stopImmediatePropagation();
  sendWithScreen();
}, true);

window.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('button') : null;
  if (bypass || !btn || !isSendButton(btn)) return;
  if (busy) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  if (!shouldAutoCapture()) { skipNextAutoCapture = false; return; }
  if (btn.disabled) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  sendWithScreen();
}, true);

// ---- Commands from The Pill ----
ipcRenderer.on('pill:state', (_e, s) => { state = { ...state, ...s }; });

ipcRenderer.on('pill:attach', async (_e, { id, files, hint, manual }) => {
  try {
    const how = await attachFiles(files);
    if (manual) skipNextAutoCapture = true;
    if (hint && !editorText()) insertText(hint);
    focusEditor();
    ipcRenderer.send('pill:attach:result', { id, ok: true, how });
  } catch (err) {
    ipcRenderer.send('pill:attach:result', { id, ok: false, error: err.message });
  }
});

// Question typed into the pill's prompt bar.
ipcRenderer.on('pill:submit', async (_e, { id, text, withScreen }) => {
  try {
    const editor = findEditor();
    if (!editor) throw new Error('Could not find the message box (are you signed in to claude.ai?)');
    focusEditor(editor);
    await ipcRenderer.invoke('claude:insert-text', text); // trusted typing, like a real keyboard
    await sleep(120);
    if (!editorText()) insertText(text);
    await sleep(80);
    const screen = withScreen || (state.watching && !skipNextAutoCapture);
    skipNextAutoCapture = false;
    if (screen) await sendWithScreen({ force: !!withScreen });
    else { await waitUntilSendable(5000); triggerSend(); }
    ipcRenderer.send('pill:attach:result', { id, ok: true });
  } catch (err) {
    ipcRenderer.send('pill:attach:result', { id, ok: false, error: err.message });
  }
});

ipcRenderer.on('pill:focus-composer', () => { focusEditor(); });

ipcRenderer.invoke('claude:get-state').then((s) => { if (s) state = { ...state, ...s }; }).catch(() => {});
