'use strict';
/* global browser, getSettings, cacheSet, netChannel, netVideo, identify, slopNormHandle */

// Client for the community service (aislop.tikaydaes.dev): pulls the list of
// reported videos and channels, shares channel-handle lookups, and lets a
// signed-in user report videos.
//
// Pulling the list sends nothing about the user. Everything else in this
// file is switched off by the "contribute" setting.

const SVC_SYNC_MINUTES = 30;
const SVC_SPOT_CHECK = 0.02; // share of served handles re-checked against YouTube
const SVC_TYPE_NAMES = [[1, 'voice'], [2, 'visuals'], [4, 'script'], [8, 'music']];
const SVC_LEVELS = ['', 'some AI', 'mostly AI', 'pure slop'];

async function svcBase() {
  return String((await getSettings()).svcUrl || 'https://aislop.tikaydaes.dev').replace(/\/+$/, '');
}

// Every call to the service: no cookies, and never wait forever.
async function svcFetch(path, options = {}) {
  return fetch(`${await svcBase()}${path}`, { credentials: 'omit', signal: AbortSignal.timeout(15000), ...options });
}

// ------------------------------------------------------------------ list

let svcDataPromise = null; // { seq, videos: Map(id → [types, level]), chans: Map(uc → handle), handles: Set }

function svcLoad() {
  return (svcDataPromise ||= browser.storage.local.get('svc:data').then((st) => {
    const raw = st['svc:data'] || {};
    const chans = new Map(Object.entries(raw.channels || {}));
    return {
      seq: raw.seq || 0,
      videos: new Map(Object.entries(raw.videos || {})),
      chans,
      handles: new Set([...chans.values()].filter(Boolean)),
    };
  }));
}

let svcSyncing = null;

function svcSync(force) {
  return (svcSyncing ||= svcDoSync(force).finally(() => { svcSyncing = null; }));
}

async function svcDoSync(force) {
  const data = await svcLoad();
  const meta = { ...((await browser.storage.local.get('svcMeta')).svcMeta || {}) };
  let videos = Object.fromEntries(data.videos);
  let channels = Object.fromEntries(data.chans);
  let seq = data.seq;
  try {
    let full = force || !seq;
    if (!full) {
      const res = await svcFetch(`/v1/delta?since=${seq}`, { cache: 'no-store' });
      if (res.status === 410) {
        full = true;
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      } else {
        const d = await res.json();
        for (const [id, on, types, level] of d.videos || []) {
          if (on) videos[id] = [types, level]; else delete videos[id];
        }
        for (const [uc, on, handle] of d.channels || []) {
          if (on) channels[uc] = handle || ''; else delete channels[uc];
        }
        seq = d.seq;
      }
    }
    if (full) {
      const res = await svcFetch('/v1/snapshot', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      videos = Object.fromEntries((d.videos || []).map(([id, types, level]) => [id, [types, level]]));
      channels = Object.fromEntries((d.channels || []).map(([uc, handle]) => [uc, handle || '']));
      seq = d.seq || 0;
    }
    meta.syncedAt = Date.now();
    meta.error = '';
  } catch (e) {
    meta.error = String(e.message || e);
  }
  meta.seq = seq;
  meta.videos = Object.keys(videos).length;
  meta.channels = Object.keys(channels).length;
  svcDataPromise = null;
  await browser.storage.local.set({ 'svc:data': { seq, videos, channels }, svcMeta: meta });
  return meta;
}

// Why the service lists this video or its channel, or '' if it does not.
function svcVerdict(data, v, h, uc) {
  const hit = v && data.videos.get(v);
  if (hit) {
    const types = SVC_TYPE_NAMES.filter(([bit]) => hit[0] & bit).map(([, name]) => name).join(', ');
    return `Community reports: AI ${types || 'content'}${SVC_LEVELS[hit[1]] ? ` (${SVC_LEVELS[hit[1]]})` : ''}`;
  }
  if ((uc && data.chans.has(uc)) || (h && data.handles.has(h))) {
    return `${h || uc} is listed by community reports`;
  }
  return '';
}

// ---------------------------------------------------- channel handle sharing

const svcLookupWaiting = new Map(); // uc → [resolve, …]
let svcLookupTimer = 0;

// Ask the service for a channel's handle; lookups made close together are
// sent as one request. Resolves to { h, name } or null.
function svcLookup(uc) {
  return new Promise((resolve) => {
    if (!svcLookupWaiting.has(uc)) svcLookupWaiting.set(uc, []);
    svcLookupWaiting.get(uc).push(resolve);
    svcLookupTimer ||= setTimeout(svcFlushLookups, 120);
  });
}

async function svcFlushLookups() {
  svcLookupTimer = 0;
  const batch = [...svcLookupWaiting.entries()].slice(0, 200);
  for (const [uc] of batch) svcLookupWaiting.delete(uc);
  if (svcLookupWaiting.size) svcLookupTimer = setTimeout(svcFlushLookups, 120);
  let found = {};
  try {
    const res = await svcFetch('/v1/channels/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: batch.map(([uc]) => uc) }),
    });
    if (res.ok) found = (await res.json()).found || {};
  } catch { /* fall back to YouTube */ }
  for (const [uc, resolvers] of batch) {
    for (const resolve of resolvers) resolve(found[uc] || null);
  }
}

// Fill the cache with a channel's handle: from the service if it knows,
// otherwise from YouTube (and then tell the service what we found).
async function channelHandle(uc) {
  const st = await getSettings();
  if (st.contribute) {
    const hit = await svcLookup(uc);
    if (hit) {
      cacheSet('c:' + uc, { h: slopNormHandle(hit.h) });
      // Occasionally check a served answer against YouTube, so renamed
      // channels and bad entries get caught by someone.
      if (st.net && Math.random() < SVC_SPOT_CHECK) netChannel(uc).catch(() => {});
      return;
    }
  }
  if (!st.net) throw new Error('no source available for channel handle');
  await netChannel(uc);
}

const svcClaims = new Map(); // uc → { uc, h, name }
let svcClaimTimer = 0;

// Called whenever this browser learns a channel's handle from YouTube itself.
async function svcQueueClaim(uc, h, name) {
  if (!uc || !(await getSettings()).contribute) return;
  svcClaims.set(uc, { uc, h: h || '', name: String(name || '').slice(0, 120) });
  if (svcClaims.size >= 100) {
    clearTimeout(svcClaimTimer);
    svcClaimTimer = 0;
    svcFlushClaims();
  } else {
    svcClaimTimer ||= setTimeout(svcFlushClaims, 8000);
  }
}

async function svcFlushClaims() {
  svcClaimTimer = 0;
  const claims = [...svcClaims.values()].slice(0, 200);
  for (const c of claims) svcClaims.delete(c.uc);
  if (!claims.length) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    const token = await svcToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    await svcFetch('/v1/channels/claims', { method: 'POST', headers, body: JSON.stringify({ claims }) });
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------- sign-in

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function svcAuth() {
  return (await browser.storage.local.get('svcAuth')).svcAuth || null;
}

async function svcTokenRequest(params) {
  const res = await svcFetch('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: 'invidioslop', ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `sign-in failed (HTTP ${res.status})`);
    err.rejected = res.status === 400;
    throw err;
  }
  return { access: data.access_token, refresh: data.refresh_token, exp: Date.now() + data.expires_in * 1000 };
}

let svcRefreshing = null;

// A valid access token, refreshed if needed, or null when signed out.
async function svcToken() {
  const auth = await svcAuth();
  if (!auth) return null;
  if (Date.now() < auth.exp - 60000) return auth.access;
  return (svcRefreshing ||= (async () => {
    try {
      const next = { ...auth, ...(await svcTokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh })) };
      await browser.storage.local.set({ svcAuth: next });
      return next.access;
    } catch (e) {
      // The server refused the refresh token: this sign-in is over.
      if (e.rejected) await browser.storage.local.remove('svcAuth');
      return null;
    }
  })().finally(() => { svcRefreshing = null; }));
}

async function svcApi(path, body) {
  const token = await svcToken();
  if (!token) throw new Error('Sign in first.');
  const res = await svcFetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (HTTP ${res.status})`);
  return data;
}

async function svcLogin() {
  const base = await svcBase();
  const redirect = browser.identity.getRedirectURL();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = `${base}/oauth/authorize?${new URLSearchParams({
    client_id: 'invidioslop', response_type: 'code', redirect_uri: redirect,
    code_challenge: challenge, code_challenge_method: 'S256', state,
  })}`;
  const back = new URL(await browser.identity.launchWebAuthFlow({ url, interactive: true }));
  if (back.searchParams.get('state') !== state) throw new Error('Sign-in was interrupted; try again.');
  const code = back.searchParams.get('code');
  if (!code) throw new Error('Sign-in was cancelled.');
  const tokens = await svcTokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier });
  await browser.storage.local.set({ svcAuth: tokens });
  return svcProfile(true);
}

async function svcLogout() {
  const auth = await svcAuth();
  await browser.storage.local.remove('svcAuth');
  if (!auth) return;
  try {
    await svcFetch('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: auth.refresh }),
    });
  } catch { /* the tokens are gone locally either way */ }
}

// The signed-in user's name and reputation. Answers from the stored copy so
// the popup never waits on the network; `refresh` updates that copy.
async function svcProfile(refresh) {
  let auth = await svcAuth();
  if (!auth) return null;
  if (refresh) {
    try {
      const profile = await svcApi('/v1/me');
      auth = await svcAuth(); // tokens may have rotated meanwhile
      if (auth) await browser.storage.local.set({ svcAuth: { ...auth, profile } });
      return profile;
    } catch { /* keep the stored copy */ }
  }
  return (await svcAuth())?.profile || { name: 'Signed in' };
}

// Where a video stands on the service, for the report dialog.
async function svcVideoState(v) {
  const token = await svcToken();
  const res = await svcFetch(`/v1/videos/${encodeURIComponent(v)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function svcAssess({ item, slop, types, level }) {
  if (!(await getSettings()).contribute) throw new Error('Contributing is switched off in the extension settings.');
  let id = await identify(item, true);
  if (!id.uc && item.v && (await getSettings()).net) {
    // The service files reports under the channel ID; YouTube pages only
    // give us the handle, so look the video up once.
    await netVideo(item.v).catch(() => {});
    id = await identify(item, false);
  }
  const state = await svcApi('/v1/assessments', { video: item.v, uc: id.uc || '', slop, types, level });
  svcSync(false).catch(() => {}); // pick up the change if this settled it
  svcProfile(true).catch(() => {});
  return state;
}

// --------------------------------------------------------------- wiring

browser.alarms.onAlarm.addListener((a) => {
  if (a.name === 'svc-sync') svcSync(false);
});

function svcEnsureAlarm() {
  browser.alarms.create('svc-sync', { periodInMinutes: SVC_SYNC_MINUTES, delayInMinutes: 1 });
}
browser.runtime.onInstalled.addListener(() => { svcEnsureAlarm(); svcSync(true); });
browser.runtime.onStartup.addListener(() => { svcEnsureAlarm(); svcSync(false); });

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes['svc:data']) svcDataPromise = null;
  // Pointing at a different server makes the local copy meaningless.
  const before = changes.settings?.oldValue?.svcUrl;
  const after = changes.settings?.newValue?.svcUrl;
  if (changes.settings && before !== after) svcSync(true);
});

const asResult = (p) => p.then((value) => ({ ok: true, value }), (e) => ({ ok: false, error: String(e.message || e) }));

browser.runtime.onMessage.addListener((msg) => {
  switch (msg?.type) {
    case 'svc-status':
      svcProfile(true).catch(() => {}); // refresh in the background; the popup re-renders on change
      return (async () => ({
        meta: (await browser.storage.local.get('svcMeta')).svcMeta || {},
        profile: await svcProfile(false),
        redirect: browser.identity.getRedirectURL(),
      }))();
    case 'svc-sync': return svcSync(true);
    case 'svc-login': return asResult(svcLogin());
    case 'svc-logout': return asResult(svcLogout());
    case 'svc-assess': return asResult(svcAssess(msg));
    default: return undefined;
  }
});
