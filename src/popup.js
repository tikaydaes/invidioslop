'use strict';
/* global browser, slopGetSettings */

const $ = (sel) => document.querySelector(sel);

async function initSettings() {
  const settings = await slopGetSettings();
  let timer = 0;
  const save = () => browser.storage.local.set({ settings });
  for (const el of document.querySelectorAll('[data-key]')) {
    const key = el.dataset.key;
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else el.value = settings[key];
    el.addEventListener(el.tagName === 'TEXTAREA' ? 'input' : 'change', () => {
      settings[key] = el.type === 'checkbox' ? el.checked : el.value;
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
  if (info.warn) parts.push(`${info.warn} warnlisted`);
  if (info.ai) parts.push(`${info.ai} AI-labelled`);
  $('#page-text').textContent = `${info.site}: ${parts.length ? parts.join(', ') : 'nothing flagged so far'}`;
  $('#reveal-row').hidden = !info.hidden && !info.reveal;
  $('#reveal').checked = info.reveal;
  $('#reveal').addEventListener('change', () => {
    browser.tabs.sendMessage(tab.id, { type: 'reveal', on: $('#reveal').checked });
  });
}

initSettings();
initList();
initPage();
