'use strict';
/* global browser, slopGetSettings */

const $ = (sel) => document.querySelector(sel);

async function initSettings() {
  const settings = await slopGetSettings();
  let timer = 0;
  let dirty = false;
  // Re-read before writing so a change made elsewhere while the popup was
  // open (the right-click menu edits the same lists) is not overwritten.
  const save = async () => {
    if (!dirty) return;
    dirty = false;
    const current = await slopGetSettings();
    await browser.storage.local.set({ settings: { ...current, ...changed } });
  };
  const changed = {};
  for (const el of document.querySelectorAll('[data-key]')) {
    const key = el.dataset.key;
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else el.value = settings[key];
    el.addEventListener(el.tagName === 'TEXTAREA' ? 'input' : 'change', () => {
      changed[key] = el.type === 'checkbox' ? el.checked : el.value;
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(save, el.tagName === 'TEXTAREA' ? 500 : 0);
    });
  }
  // Popups can close at any moment; don't lose a half-typed list.
  window.addEventListener('pagehide', () => { clearTimeout(timer); save(); });
}

function showStatus(meta) {
  const n = (kind) => (meta[kind]?.count ?? 0).toLocaleString();
  $('#list-text').textContent = meta.syncedAt
    ? `${n('block')} blocked · ${n('warn')} warned · synced ${new Date(meta.syncedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'Not synced yet';
  $('#error').textContent = meta.error ? `Last sync failed: ${meta.error}` : '';
}

async function initList() {
  showStatus(await browser.runtime.sendMessage({ type: 'status' }));
  $('#sync').addEventListener('click', async () => {
    $('#sync').disabled = true;
    $('#sync').textContent = 'Syncing…';
    try { showStatus(await browser.runtime.sendMessage({ type: 'sync' })); } finally {
      $('#sync').disabled = false;
      $('#sync').textContent = 'Sync now';
    }
  });
}

async function initPage() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  let info;
  try { info = await browser.tabs.sendMessage(tab.id, { type: 'page-info' }); } catch { return; }
  if (!info) return;
  const parts = [];
  if (info.block) parts.push(`${info.block} blocklisted`);
  if (info.svc) parts.push(`${info.svc} community-reported`);
  if (info.warn) parts.push(`${info.warn} warnlisted`);
  if (info.ai) parts.push(`${info.ai} AI-labelled`);
  $('#page-text').textContent = `${info.site}: ${parts.length ? parts.join(', ') : 'nothing flagged so far'}`;
  $('#reveal-row').hidden = !info.hidden && !info.reveal;
  $('#reveal').checked = info.reveal;
  $('#reveal').addEventListener('change', () => {
    browser.tabs.sendMessage(tab.id, { type: 'reveal', on: $('#reveal').checked });
  });
}

async function initService() {
  const user = $('#svc-user');
  const button = $('#svc-auth');
  const show = ({ meta, profile }) => {
    $('#svc-text').textContent = meta.error
      ? `Community list: last sync failed (${meta.error})`
      : `Community list: ${(meta.videos ?? 0).toLocaleString()} videos · ${(meta.channels ?? 0).toLocaleString()} channels`;
    user.textContent = profile
      ? `${profile.name}${profile.reputation != null ? ` · reputation ${profile.reputation}` : ''}`
      : 'Not signed in (needed only to report)';
    button.textContent = profile ? 'Sign out' : 'Sign in';
    button.dataset.action = profile ? 'svc-logout' : 'svc-login';
    button.hidden = false;
  };
  const refresh = async () => show(await browser.runtime.sendMessage({ type: 'svc-status' }));
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.svcAuth || changes.svcMeta)) refresh();
  });
  button.addEventListener('click', async () => {
    button.disabled = true;
    // Sign-in opens its own window, which closes this popup; the background
    // script finishes the job either way.
    const res = await browser.runtime.sendMessage({ type: button.dataset.action });
    button.disabled = false;
    if (res && !res.ok) user.textContent = res.error;
    else await refresh();
  });
  await refresh();
}

initSettings();
initList();
initPage();
initService();
