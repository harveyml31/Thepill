'use strict';
// What Shadow mode must never keep: passwords, one-time codes, password managers, login pages and calls.

const DEFAULT_NEVER_RECORD = [
  '1Password', 'Bitwarden', 'LastPass', 'Dashlane', 'KeePass', 'KeePassXC', 'Keychain Access', 'Enpass', 'Proton Pass',
  'bank', 'banking', 'PayPal', 'Revolut', 'Monzo', 'Starling', 'Wise', 'Coinbase',
];

// Pages and dialogs where you type credentials.
const LOGIN_CONTEXT = /\b(log ?in|sign[ -]?in|sign[ -]?on|password|passcode|passphrase|pin code|verify|verification|two[- ]factor|2fa|mfa|one[- ]time|otp|authenticat|security code|okta|onelogin|auth0|duo security|sso)\b/i;

// Calls and meetings: nothing at all is recorded while one of these is in front.
const CALL_CONTEXT = /\b(zoom\.us|zoom meeting|zoom workplace|webex|facetime|gotomeeting|whereby|ringcentral video|skype)\b|(microsoft teams|teams).*(meeting|call|\| ?call)|^meet [–-] |google meet|slack.*huddle|discord.*(voice|stage)/i;

function listMatches(list, haystack) {
  const h = haystack.toLowerCase();
  return list.some((w) => w && h.includes(String(w).toLowerCase().trim()));
}

/**
 * How to treat the window in front:
 *  'call'    -> record nothing except that a call happened (and how long)
 *  'private' -> record nothing except time spent
 *  'login'   -> record activity and clicks, never typed text
 *  'normal'  -> record everything
 */
function classifyContext({ app = '', title = '', url = '' }, neverRecord = DEFAULT_NEVER_RECORD) {
  const all = `${app} ${title} ${url}`;
  if (CALL_CONTEXT.test(app) || CALL_CONTEXT.test(title) || /meet\.google\.com|zoom\.us\/(j|wc)|teams\.microsoft\.com\/.*(meetup|call)/i.test(url)) return 'call';
  if (listMatches(neverRecord, all)) return 'private';
  if (LOGIN_CONTEXT.test(title) || /\/(login|signin|sign-in|auth|oauth|sso|account\/verify)/i.test(url)) return 'login';
  return 'normal';
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URLISH = /^(https?:\/\/|www\.)/i;

/** Looks like a password or key: long, no spaces, a mix of character kinds. */
function looksSecret(token) {
  if (token.length < 8 || EMAIL.test(token) || URLISH.test(token)) return false;
  let kinds = 0;
  if (/[a-z]/.test(token)) kinds++;
  if (/[A-Z]/.test(token)) kinds++;
  if (/[0-9]/.test(token)) kinds++;
  if (/[^A-Za-z0-9]/.test(token)) kinds++;
  return kinds >= 3;
}

/**
 * Clean a typed segment before it is stored.
 * Returns { text, redacted } where text may be '' if the whole thing should be dropped.
 */
function redactTyped(text, { submitted = false } = {}) {
  const trimmed = text.trim();
  if (!trimmed) return { text: '', redacted: false };
  // A single word sent with Enter/Tab that has digits or symbols is almost always a password or code.
  if (!/\s/.test(trimmed) && submitted && trimmed.length >= 6 && /[0-9]|[^A-Za-z0-9'’.,!?-]/.test(trimmed) && !EMAIL.test(trimmed) && !URLISH.test(trimmed)) {
    return { text: '', redacted: true };
  }
  // A bare 4-8 digit number on its own is usually a one-time code.
  if (/^\d{4,8}$/.test(trimmed)) return { text: '', redacted: true };
  let redacted = false;
  const out = text.replace(/\S+/g, (tok) => {
    if (looksSecret(tok)) { redacted = true; return '[hidden]'; }
    return tok;
  });
  return { text: out, redacted };
}

module.exports = { DEFAULT_NEVER_RECORD, classifyContext, redactTyped, looksSecret, LOGIN_CONTEXT, CALL_CONTEXT };
