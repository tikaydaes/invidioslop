'use strict';
/* global browser, slopGetSettings, slopNormHandle, slopParseList */

const LIST_BASE = 'https://raw.githubusercontent.com/Override92/AiSList/main/AiSList/';
const LIST_URLS = {
  block: LIST_BASE + 'aislist_blocklist.txt',
  warn: LIST_BASE + 'aislist_warnlist.txt',
};
const SYNC_MINUTES = 6 * 60;
const DAY = 24 * 60 * 60 * 1000;
const TTL = { c: 30 * DAY, v: 14 * DAY }; // channel-id→handle, video→label/owner
const MAX_PARALLEL = 4;
const EXT_ORIGIN = browser.runtime.getURL('');

// ---------------------------------------------------------------- list sync

let listsPromise = null; // { block:Set, warn:Set, allow:Set, extra:Set }
let settingsPromise = null;
let syncing = null;

function getSettings() {
  return (settingsPromise ||= slopGetSettings());
}

function getLists() {
  return (listsPromise ||= (async () => {
    let st = await browser.storage.local.get(['list:block', 'list:warn', 'listMeta']);
    if (st['list:block'] == null) {
      await syncLists(false).catch(() => {});
      st = await browser.storage.local.get(['list:block', 'list:warn', 'listMeta']);
    } else if (Date.now() - (st.listMeta?.checkedAt || 0) > 2 * SYNC_MINUTES * 60000) {
      syncLists(false).catch(() => {}); // missed alarms (browser was closed)
    }
    const settings = await getSettings();
    return {
      block: new Set((st['list:block'] || '').split('\n')),
      warn: new Set((st['list:warn'] || '').split('\n')),
      allow: new Set(slopParseList(settings.allow)),
      extra: new Set(slopParseList(settings.extra)),
    };
  })());
}

function syncLists(force) {
  return (syncing ||= doSync(force).finally(() => { syncing = null; }));
}

async function doSync(force) {
  const { listMeta } = await browser.storage.local.get('listMeta');
  const meta = { ...(listMeta || {}) };
  const update = {};
  try {
    for (const kind of Object.keys(LIST_URLS)) {
      const headers = {};
      if (!force && meta[kind]?.etag) headers['If-None-Match'] = meta[kind].etag;
      const res = await fetch(LIST_URLS[kind], { headers, cache: 'no-store', credentials: 'omit' });
      if (res.status === 304) continue;
      if (!res.ok) throw new Error(`${kind}list: HTTP ${res.status}`);
      const entries = slopParseList(await res.text());
      // Never replace a good copy with an obviously broken download.
      if (kind === 'block' && entries.length < 1000) throw new Error('blocklist looks truncated');
      update['list:' + kind] = entries.join('\n');
      meta[kind] = { etag: res.headers.get('ETag') || '', count: entries.length };
    }
    meta.syncedAt = Date.now();
    meta.error = '';
  } catch (e) {
    meta.error = String(e.message || e);
  }
  meta.checkedAt = Date.now();
  await browser.storage.local.set({ ...update, listMeta: meta });
  if (Object.keys(update).length) listsPromise = null;
  return meta;
}

function ensureAlarms() {
  browser.alarms.create('sync', { periodInMinutes: SYNC_MINUTES, delayInMinutes: 1 });
  browser.alarms.create('prune', { periodInMinutes: 24 * 60, delayInMinutes: 30 });
}

browser.runtime.onInstalled.addListener(() => { ensureAlarms(); createMenus(); syncLists(true); });
browser.runtime.onStartup.addListener(() => { ensureAlarms(); createMenus(); syncLists(false); });
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === 'sync') syncLists(false);
  if (a.name === 'prune') pruneCache();
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) { settingsPromise = null; listsPromise = null; }
});

// -------------------------------------------------------------------- cache
// 'c:<UC id>' → { h, t }            'v:<video id>' → { ai, label, h, uc, t }

const mem = new Map();
const loaded = new Set();

async function cacheLoad(keys) {
  const missing = keys.filter((k) => k && !loaded.has(k));
  if (!missing.length) return;
  const got = await browser.storage.local.get(missing);
  const now = Date.now();
  for (const k of missing) {
    loaded.add(k);
    const val = got[k];
    if (val && now - val.t < TTL[k[0]] && !mem.has(k)) mem.set(k, val);
  }
}

function cacheSet(key, val, persist = true) {
  val.t = Date.now();
  mem.set(key, val);
  loaded.add(key);
  if (persist) browser.storage.local.set({ [key]: val });
}

async function pruneCache() {
  const all = await browser.storage.local.get(null);
  const now = Date.now();
  const dead = Object.keys(all).filter((k) => TTL[k[0]] && k[1] === ':' && now - (all[k]?.t || 0) > TTL[k[0]]);
  if (dead.length) await browser.storage.local.remove(dead);
}

// ---------------------------------------------------------- YouTube lookups

// YouTube rejects API calls carrying a moz-extension:// Origin, so drop that
// header from this extension's own background requests (and only those).
browser.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    if (d.tabId !== -1 || !(d.originUrl || d.documentUrl || '').startsWith(EXT_ORIGIN)) return {};
    return { requestHeaders: d.requestHeaders.filter((h) => h.name.toLowerCase() !== 'origin') };
  },
  { urls: ['https://www.youtube.com/youtubei/v1/*'] },
  ['blocking', 'requestHeaders'],
);

const queue = [];
const inflight = new Map();
let active = 0;

function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    active++;
    queue.shift()();
  }
}

function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject).finally(() => { active--; inflight.delete(key); pump(); }));
    pump();
  });
  inflight.set(key, p);
  return p;
}

async function innertube(endpoint, body) {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: '2.20261101.00.00', hl: 'en', gl: 'US' } },
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`youtube ${endpoint}: HTTP ${res.status}`);
  return res.json();
}

// Every value in a JSON tree whose key satisfies `test`.
function findAll(root, test) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    for (const [k, v] of Object.entries(node)) {
      if (!Array.isArray(node) && test(k)) out.push(v);
      else if (v && typeof v === 'object') stack.push(v);
    }
  }
  return out;
}

const findKey = (root, test) => findAll(root, test)[0] || null;

// "Auto-dubbed — Audio tracks for some languages were automatically generated."
// A machine-translated audio track on an otherwise ordinary video is not AI slop.
function isDubOnly(text) {
  return /auto-?dubbed|audio tracks?[^.]*automatically generated/i.test(text);
}

function textOf(node) {
  if (!node) return '';
  if (typeof node.content === 'string') return node.content;
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('');
  return '';
}

function handleFromPath(path) {
  const m = String(path || '').match(/\/(@[^/?#]+)/);
  return m ? slopNormHandle(m[1]) : '';
}

// The watch page's "How this was made" section is where YouTube discloses
// altered / synthetic content. It is also used for "captured with a camera"
// provenance, so the text has to actually talk about AI or alteration.
function netVideo(v) {
  return once('v:' + v, async () => {
    const data = await innertube('next', { videoId: v });
    let ai = 0;
    let label = '';
    for (const how of findAll(data.engagementPanels, (k) => k.startsWith('howThisWasMadeSection'))) {
      const head = textOf(how.bodyHeader);
      const body = textOf(how.bodyText).replace(/\s*Learn more\s*$/i, '');
      if (isDubOnly(head + ' ' + body)) continue;
      if (/\bAI\b|altered|synthetic|generated/i.test(head + ' ' + body)) {
        ai = 1;
        label = [head, body].filter(Boolean).join(' — ');
        break;
      }
    }
    const owner = findKey(data.contents, (k) => k === 'videoOwnerRenderer');
    const be = owner?.navigationEndpoint?.browseEndpoint || {};
    const uc = /^UC[\w-]{22}$/.test(be.browseId || '') ? be.browseId : '';
    const h = handleFromPath(be.canonicalBaseUrl);
    cacheSet('v:' + v, { ai, label, h, uc });
    if (uc) cacheSet('c:' + uc, { h });
  });
}

function netChannel(uc) {
  return once('c:' + uc, async () => {
    const data = await innertube('browse', { browseId: uc });
    const md = data.metadata?.channelMetadataRenderer || {};
    cacheSet('c:' + uc, { h: handleFromPath(md.vanityChannelUrl) });
  });
}

// ---------------------------------------------------------------- verdicts

function listVerdict(lists, h, uc) {
  const has = (set) => (h && set.has(h)) || (uc && set.has(uc));
  if (has(lists.allow)) return 'allow';
  if (has(lists.extra)) return 'extra';
  if (has(lists.block)) return 'block';
  if (has(lists.warn)) return 'warn';
  return '';
}

// item: { v?: videoId, h?: '@handle', uc?: 'UC…' }
// → { s: ''|'block'|'warn'|'ai', why, pending }
async function evaluate(item, allowNet) {
  const [st, lists] = await Promise.all([getSettings(), getLists()]);
  const v = /^[\w-]{11}$/.test(item.v || '') ? item.v : '';
  let uc = /^UC[\w-]{22}$/.test(item.uc || '') ? item.uc : '';
  let h = slopNormHandle(item.h);
  let vc = null;
  let lv = '';

  const settle = async () => {
    await cacheLoad([v && 'v:' + v]);
    vc = (v && mem.get('v:' + v)) || null;
    // Entries cached before auto-dubbed notices were told apart from AI labels.
    if (vc?.ai && isDubOnly(vc.label)) vc = { ...vc, ai: 0 };
    if (vc) { h ||= vc.h; uc ||= vc.uc; }
    await cacheLoad([uc && 'c:' + uc]);
    if (!h && uc) h = mem.get('c:' + uc)?.h || '';
    lv = listVerdict(lists, h, uc);
  };
  await settle();

  const wantAi = st.ai !== 'off' && !!v;
  const decided = lv === 'allow' || lv === 'block' || lv === 'extra';
  const needAi = wantAi && !vc;
  const needHandle = !h && !vc && (v || (uc && !mem.has('c:' + uc)));
  let pending = false;

  if (!decided && st.net && (needAi || needHandle)) {
    if (!allowNet) {
      pending = true;
    } else {
      try {
        if (v && (needAi || !uc)) await netVideo(v);
        else await netChannel(uc);
      } catch (e) {
        console.warn('[InvidioSlop]', e.message || e);
        // Remember the failure for this session so a broken lookup isn't retried per card.
        if (v && !mem.has('v:' + v)) cacheSet('v:' + v, { ai: 0, label: '', h: '', uc: '' }, false);
        else if (uc && !mem.has('c:' + uc)) cacheSet('c:' + uc, { h: '' }, false);
      }
      await settle();
    }
  }

  const who = h || uc || 'This channel';
  if (lv === 'allow') return { s: '', why: '', pending: false };
  if (lv === 'extra') return { s: 'block', why: `${who} is on your own block list`, pending: false };
  if (lv === 'block') return { s: 'block', why: `${who} is on the AiSList blocklist`, pending: false };
  if (wantAi && vc?.ai) return { s: 'ai', why: `YouTube label: ${vc.label || 'altered or synthetic content'}`, pending: false };
  if (lv === 'warn' && st.warn !== 'off') return { s: 'warn', why: `${who} is on the AiSList warnlist (likely AI content)`, pending };
  return { s: '', why: '', pending };
}

// ------------------------------------------------------ right-click menu

const MENU_CONTEXTS = ['page', 'link', 'image', 'video', 'selection'];
const MENU_IDS = ['slop-block', 'slop-copy', 'slop-sep', 'slop-reveal'];

function createMenus() {
  browser.menus.removeAll().then(() => {
    const base = { contexts: MENU_CONTEXTS, visible: false };
    browser.menus.create({ ...base, id: 'slop-block', title: 'Block this channel' });
    browser.menus.create({ ...base, id: 'slop-copy', title: 'Copy channel handle' });
    browser.menus.create({ ...base, id: 'slop-sep', type: 'separator' });
    browser.menus.create({ ...base, id: 'slop-reveal', title: 'Show hidden videos on this page' });
  });
}

// Best known identity of the channel behind an item: { h: '@handle', uc: 'UC…' }.
async function identify(item, allowNet) {
  const v = /^[\w-]{11}$/.test(item?.v || '') ? item.v : '';
  let uc = /^UC[\w-]{22}$/.test(item?.uc || '') ? item.uc : '';
  let h = slopNormHandle(item?.h);
  const fill = async () => {
    await cacheLoad([v && 'v:' + v]);
    const vc = v && mem.get('v:' + v);
    if (vc) { h ||= vc.h; uc ||= vc.uc; }
    await cacheLoad([uc && 'c:' + uc]);
    if (!h && uc) h = mem.get('c:' + uc)?.h || '';
  };
  await fill();
  if (!h && allowNet && (uc || v) && (await getSettings()).net) {
    try {
      if (uc) await netChannel(uc); else await netVideo(v);
    } catch (e) { console.warn('[InvidioSlop]', e.message || e); }
    await fill();
  }
  return { h, uc };
}

// Is this channel currently treated as blocked, and through which lists?
function blockState(id, st, userAllow, userExtra, lists) {
  const has = (set) => !!((id.h && set.has(id.h)) || (id.uc && set.has(id.uc)));
  const onList = has(lists.block) || (has(lists.warn) && st.warn !== 'off');
  return { has, onList, blocked: !has(userAllow) && (has(userExtra) || onList) };
}

// "Block" adds the channel to the user's own block list; "Unblock" removes it
// from there and, if AiSList is what flags it, adds it to the never-flag list.
async function toggleBlock(item) {
  const id = await identify(item, true);
  const key = id.h || id.uc;
  if (!key) return;
  const [st, lists] = await Promise.all([slopGetSettings(), getLists()]);
  const allow = new Set(slopParseList(st.allow));
  const extra = new Set(slopParseList(st.extra));
  const { has, onList, blocked } = blockState(id, st, allow, extra, lists);
  const drop = (set) => { set.delete(id.h); set.delete(id.uc); };
  if (blocked) {
    drop(extra);
    if (onList) allow.add(key);
  } else {
    drop(allow);
    if (!has(lists.block)) extra.add(key);
  }
  await browser.storage.local.set({
    settings: { ...st, allow: [...allow].join('\n'), extra: [...extra].join('\n') },
  });
}

async function askTab(tabId) {
  try { return (await browser.tabs.sendMessage(tabId, { type: 'ctx' }, { frameId: 0 })) || null; } catch { return null; }
}

let menuSeq = 0;

browser.menus.onShown.addListener(async (info, tab) => {
  const seq = ++menuSeq;
  const ctx = tab?.id != null ? await askTab(tab.id) : null;
  let updates;
  if (!ctx) {
    updates = MENU_IDS.map((id) => [id, { visible: false }]);
  } else {
    let id = { h: '', uc: '' };
    let blocked = false;
    if (ctx.item) {
      const [st, lists] = await Promise.all([getSettings(), getLists()]);
      id = await identify(ctx.item, false);
      blocked = blockState(id, st, lists.allow, lists.extra, lists).blocked;
    }
    const who = id.h || 'this channel';
    updates = [
      ['slop-block', { visible: !!ctx.item, title: `${blocked ? 'Unblock' : 'Block'} ${who}` }],
      ['slop-copy', { visible: !!ctx.item, title: id.h ? `Copy handle ${id.h}` : 'Copy channel handle' }],
      ['slop-sep', { visible: !!ctx.item }],
      ['slop-reveal', {
        visible: true,
        title: ctx.reveal ? 'Hide flagged videos again' : `Show hidden videos on this page (${ctx.hidden})`,
      }],
    ];
  }
  if (seq !== menuSeq) return; // menu was closed or reopened while we were working
  await Promise.all(updates.map(([id, props]) => browser.menus.update(id, props)));
  if (seq === menuSeq) browser.menus.refresh();
});

browser.menus.onHidden.addListener(() => { menuSeq++; });

browser.menus.onClicked.addListener(async (info, tab) => {
  if (tab?.id == null) return;
  const ctx = await askTab(tab.id);
  if (!ctx) return;
  if (info.menuItemId === 'slop-reveal') {
    browser.tabs.sendMessage(tab.id, { type: 'reveal', on: !ctx.reveal }, { frameId: 0 }).catch(() => {});
  } else if (info.menuItemId === 'slop-block' && ctx.item) {
    await toggleBlock(ctx.item);
  } else if (info.menuItemId === 'slop-copy' && ctx.item) {
    const { h } = await identify(ctx.item, true);
    if (h) await navigator.clipboard.writeText(h);
  }
});

// ---------------------------------------------------------------- messages

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg?.type) {
    case 'check': // local-only, batched
      return (async () => {
        const keys = [];
        for (const it of msg.items) { if (it.v) keys.push('v:' + it.v); if (it.uc) keys.push('c:' + it.uc); }
        await cacheLoad(keys);
        return Promise.all(msg.items.map((it) => evaluate(it, false)));
      })();
    case 'resolve': // may hit the network
      return evaluate(msg.item, true);
    case 'count':
      if (sender.tab?.id != null) {
        browser.action.setBadgeBackgroundColor({ color: '#b3261e', tabId: sender.tab.id });
        browser.action.setBadgeText({ text: msg.n ? String(msg.n) : '', tabId: sender.tab.id });
      }
      return undefined;
    case 'status':
      return browser.storage.local.get('listMeta').then((s) => s.listMeta || {});
    case 'sync':
      return syncLists(true);
    default:
      return undefined;
  }
});
