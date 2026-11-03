'use strict';
// Turns physical key codes (from uiohook) back into characters, for UK and US keyboards.

const LETTERS = { 30: 'a', 48: 'b', 46: 'c', 32: 'd', 18: 'e', 33: 'f', 34: 'g', 35: 'h', 23: 'i', 36: 'j', 37: 'k', 38: 'l', 50: 'm',
  49: 'n', 24: 'o', 25: 'p', 16: 'q', 19: 'r', 31: 's', 20: 't', 22: 'u', 47: 'v', 17: 'w', 45: 'x', 21: 'y', 44: 'z' };

const COMMON = {
  2: ['1', '!'], 3: ['2', '@'], 4: ['3', '#'], 5: ['4', '$'], 6: ['5', '%'], 7: ['6', '^'], 8: ['7', '&'], 9: ['8', '*'], 10: ['9', '('], 11: ['0', ')'],
  12: ['-', '_'], 13: ['=', '+'], 26: ['[', '{'], 27: [']', '}'], 39: [';', ':'], 40: ["'", '"'], 41: ['`', '~'], 43: ['\\', '|'],
  51: [',', '<'], 52: ['.', '>'], 53: ['/', '?'], 57: [' ', ' '],
  // numpad
  82: ['0', '0'], 79: ['1', '1'], 80: ['2', '2'], 81: ['3', '3'], 75: ['4', '4'], 76: ['5', '5'], 77: ['6', '6'], 71: ['7', '7'], 72: ['8', '8'], 73: ['9', '9'],
  55: ['*', '*'], 78: ['+', '+'], 74: ['-', '-'], 83: ['.', '.'], 3637: ['/', '/'],
};

const UK = { ...COMMON, 3: ['2', '"'], 4: ['3', '£'], 40: ["'", '@'], 41: ['`', '¬'], 43: ['#', '~'], 86: ['\\', '|'] };
const US = { ...COMMON, 86: ['\\', '|'] };

const KEY = {
  Backspace: 14, Tab: 15, Enter: 28, NumpadEnter: 3612, CapsLock: 58, Escape: 1, Delete: 3667,
  Ctrl: 29, CtrlRight: 3613, Alt: 56, AltRight: 3640, Shift: 42, ShiftRight: 54, Meta: 3675, MetaRight: 3676,
  ArrowLeft: 57419, ArrowUp: 57416, ArrowRight: 57421, ArrowDown: 57424, Home: 3655, End: 3663, PageUp: 3657, PageDown: 3665,
  A: 30, C: 46, V: 47, X: 45, Z: 44,
};
const MODIFIERS = new Set([KEY.Ctrl, KEY.CtrlRight, KEY.Alt, KEY.AltRight, KEY.Shift, KEY.ShiftRight, KEY.Meta, KEY.MetaRight, KEY.CapsLock]);
const CURSOR_KEYS = new Set([KEY.ArrowLeft, KEY.ArrowUp, KEY.ArrowRight, KEY.ArrowDown, KEY.Home, KEY.End, KEY.PageUp, KEY.PageDown]);

function layoutFor(name, locale = '') {
  if (name === 'us') return US;
  if (name === 'uk') return UK;
  return /^en-(GB|IE)/i.test(locale) ? UK : US;
}

/** Character for a key press, or null when the key doesn't type anything. */
function charFor(layout, keycode, shift, capsLock) {
  const letter = LETTERS[keycode];
  if (letter) return (shift !== capsLock) ? letter.toUpperCase() : letter;
  const pair = layout[keycode];
  if (!pair) return null;
  return shift ? pair[1] : pair[0];
}

module.exports = { KEY, MODIFIERS, CURSOR_KEYS, layoutFor, charFor };
