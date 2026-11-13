'use strict';
// Shared by the background script, the content script and the popup.

const SLOP_DEFAULTS = Object.freeze({
  block: 'hide', // channels on the AiSList blocklist: 'hide' | 'mark' | 'off'
  warn: 'mark',  // channels on the AiSList warnlist
  ai: 'mark',    // videos YouTube itself labels as altered / AI-generated
  svc: 'mark',   // videos / channels listed by the community service
  net: true,     // allow lookups against youtube.com (channel handles, AI label)
  contribute: true, // share channel-handle lookups and allow reporting; off = only download the list
  svcUrl: 'https://aislop.tikaydaes.dev',
  allow: '',     // user list: channels that are never flagged (one per line)
  extra: '',     // user list: additional channels to block (one per line)
});

async function slopGetSettings() {
  const { settings } = await browser.storage.local.get('settings');
  return { ...SLOP_DEFAULTS, ...(settings || {}) };
}

// Handles are case-insensitive and the list percent-encodes some non-ASCII ones.
function slopNormHandle(raw) {
  let s = String(raw || '').trim().replace(/^@/, '');
  if (!s) return '';
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  return '@' + s.normalize('NFC').toLowerCase();
}

// Accepts list lines, bare handles, channel IDs, or pasted channel URLs.
function slopParseEntry(line) {
  let s = String(line || '').trim();
  if (!s || s[0] === '!' || s[0] === '#') return '';
  const m = s.match(/(?:^|\/)(@[^/?#\s]+|UC[\w-]{22})(?:[/?#]|$)/);
  if (m) s = m[1];
  return /^UC[\w-]{22}$/.test(s) ? s : slopNormHandle(s);
}

function slopParseList(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const e = slopParseEntry(line);
    if (e) out.push(e);
  }
  return out;
}
