'use strict';
// Bridge for The Pill's own UI (the pill and the chat toolbar). Exposes a small, explicit API.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('pill', {
  // state
  getState: () => ipcRenderer.invoke('ui:get-state'),
  onState: on('ui:state'),
  onToast: on('ui:toast'),
  onFlash: on('ui:flash'),
  setSettings: (patch) => ipcRenderer.invoke('ui:set-settings', patch),

  // sight
  toggleWatching: () => ipcRenderer.invoke('ui:toggle-watching'),
  shareScreen: () => ipcRenderer.invoke('ui:share-screen'),
  shareRewind: () => ipcRenderer.invoke('ui:share-rewind'),
  openScreenSettings: () => ipcRenderer.invoke('ui:open-screen-settings'),

  // chat
  newChat: () => ipcRenderer.invoke('ui:nav', 'new'),
  recents: () => ipcRenderer.invoke('ui:nav', 'recents'),
  back: () => ipcRenderer.invoke('ui:nav', 'back'),
  reload: () => ipcRenderer.invoke('ui:nav', 'reload'),
  openInBrowser: () => ipcRenderer.invoke('ui:open-in-browser'),
  openLink: (url) => ipcRenderer.invoke('ui:open-link', url),
  linkFromClipboard: () => ipcRenderer.invoke('ui:link-from-clipboard'),
  copyText: (text) => ipcRenderer.invoke('ui:copy', text),

  // windows
  expand: () => ipcRenderer.invoke('ui:expand'),
  collapse: () => ipcRenderer.invoke('ui:collapse'),
  toggleDock: () => ipcRenderer.invoke('ui:toggle-dock'),
  togglePin: () => ipcRenderer.invoke('ui:toggle-pin'),
  setOverlay: (px) => ipcRenderer.send('ui:overlay', px),
  pillMove: (x, y) => ipcRenderer.send('pill:move', { x, y }),
  pillDragEnd: () => ipcRenderer.send('pill:drag-end'),
  pillMenu: () => ipcRenderer.send('pill:menu'),
  setPillMode: (mode) => ipcRenderer.invoke('pill:mode', mode),
  submitPrompt: (text, withScreen) => ipcRenderer.invoke('pill:submit', { text, withScreen }),
  quit: () => ipcRenderer.invoke('ui:quit'),

  // rewind compositor (runs in the toolbar renderer because it has a <canvas>)
  onCompose: on('ui:compose'),
  composeDone: (id, dataUrl, error) => ipcRenderer.send('ui:compose:done', { id, dataUrl, error }),
});
