'use strict';
/* global browser, slopGetSettings */
(() => {
  // ------------------------------------------------------- site detection
  const isYouTube = /(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname);
  const isInvidious = !isYouTube && !!document.querySelector(
    'link[rel="search"][title="Invidious"], a[href*="github.com/iv-org/invidious"], link[href^="/css/default.css"][rel="stylesheet"] ~ link[href^="/css/carousel.css"]',
  );
  if (!isYouTube && !isInvidious) return;

  const VIDEO_LINKS = 'a[href*="/watch?"], a[href*="/shorts/"]';
  const YT_CARDS = [
    'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-compact-video-renderer',
    'ytd-grid-video-renderer', 'ytd-playlist-video-renderer', 'ytd-playlist-panel-video-renderer',
    'ytd-reel-item-renderer', 'ytd-rich-grid-media', 'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model', 'ytm-shorts-lockup-view-model-v2',
    'ytd-movie-renderer', 'ytd-radio-renderer',
    // mobile site
    'ytm-rich-item-renderer', 'ytm-video-with-context-renderer', 'ytm-compact-video-renderer',
  ].join(',');
  const NEVER_INSIDE = '#movie_player, .html5-video-player, #player, #player-container, .invslop-banner';
  const CLIMB_STOP = '.pure-g, main, [role="main"], #contents, #content, #items, ytd-app';
  const BADGE_TEXT = { block: 'AI slop', svc: 'Reported AI', warn: 'Likely AI', ai: 'AI-labelled' };

  let settings = null;
  let state = new WeakMap(); // card → { key, item }
  let lastHref = '';
  let scanTimer = 0;

  // ---------------------------------------------------------- url parsing
  const YT_HOST = /(^|\.)youtube(-nocookie)?\.com$/;
  const sameSite = (u) => u.origin === location.origin || YT_HOST.test(u.hostname);

  function videoIdOf(u) {
    let id = null;
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})(?:[/?]|$)/) || [])[1];
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }

  function channelOf(u) {
    let m = u.pathname.match(/^\/channel\/(UC[\w-]{22})(?:\/|$)/);
    if (m) return { uc: m[1] };
    m = u.pathname.match(/^\/(@[^/]+)/);
    if (m) return { h: m[1] };
    return null;
  }

  function linkUrl(a) {
    try {
      const u = new URL(a.href);
      return sameSite(u) ? u : null;
    } catch { return null; }
  }

  // ----------------------------------------------------------- card lookup
  function findCard(a, vid) {
    if (isYouTube) {
      let card = a.closest(YT_CARDS);
      if (card) {
        for (let outer; (outer = card.parentElement?.closest(YT_CARDS));) card = outer;
        return card;
      }
    }
    // Generic: the largest ancestor that still only talks about this one video.
    let el = a;
    for (let i = 0; i < 7; i++) {
      const p = el.parentElement;
      if (!p || p === document.body || p === document.documentElement || p.matches(CLIMB_STOP)) break;
      if (p.querySelector('video, iframe, h1, form, input')) break;
      let other = false;
      for (const l of p.querySelectorAll(VIDEO_LINKS)) {
        const u = linkUrl(l);
        const id = u && videoIdOf(u);
        if (id && id !== vid) { other = true; break; }
      }
      if (other) break;
      el = p;
    }
    return el === a ? null : el;
  }

  function cardChannel(card) {
    for (const a of card.querySelectorAll('a[href]')) {
      const u = linkUrl(a);
      const ch = u && channelOf(u);
      if (ch) return ch;
    }
    return null;
  }

  // -------------------------------------------------------------- marking
  function clearCard(card) {
    card.removeAttribute('data-invslop');
    card.removeAttribute('data-invslop-action');
    for (const b of card.querySelectorAll(':scope > .invslop-badge')) b.remove();
  }

  function applyVerdict(card, verdict) {
    const action = verdict.s ? settings[verdict.s] : 'off';
    if (!verdict.s || action === 'off') { clearCard(card); return; }
    card.setAttribute('data-invslop', verdict.s);
    card.setAttribute('data-invslop-action', action);
    let badge = card.querySelector(':scope > .invslop-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'invslop-badge';
      card.prepend(badge);
    }
    badge.textContent = BADGE_TEXT[verdict.s];
    badge.title = verdict.why;
  }

  function reportCount() {
    const n = document.querySelectorAll('[data-invslop]').length;
    browser.runtime.sendMessage({ type: 'count', n }).catch(() => {});
  }

  // Cards that need a network lookup are only resolved once they scroll near view.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const st = state.get(e.target);
      if (st) resolveCard(e.target, st);
    }
  }, { rootMargin: '400px' });

  async function resolveCard(card, st) {
    let verdict;
    try { verdict = await browser.runtime.sendMessage({ type: 'resolve', item: st.item }); } catch { return; }
    if (!verdict || state.get(card) !== st) return; // card was recycled meanwhile
    applyVerdict(card, verdict);
    reportCount();
  }

  // ----------------------------------------------------------------- scan
  async function scan() {
    if (!settings) return;
    checkPage();
    const pageVideo = videoIdOf(new URL(location.href));
    const pageChannel = channelOf(new URL(location.href));
    const found = new Map(); // card → video id

    for (const a of document.querySelectorAll(VIDEO_LINKS)) {
      const u = linkUrl(a);
      const vid = u && videoIdOf(u);
      if (!vid || vid === pageVideo || a.closest(NEVER_INSIDE)) continue;
      const card = findCard(a, vid);
      if (card && !found.has(card)) found.set(card, vid);
    }

    const fresh = [];
    for (const [card, v] of found) {
      const ch = cardChannel(card) || pageChannel || {};
      const key = `${v}|${ch.h || ''}|${ch.uc || ''}`;
      if (state.get(card)?.key === key) continue;
      clearCard(card);
      io.unobserve(card);
      const st = { key, item: { v, ...ch } };
      state.set(card, st);
      fresh.push([card, st]);
    }
    if (!fresh.length) return;

    let verdicts;
    try {
      verdicts = await browser.runtime.sendMessage({ type: 'check', items: fresh.map(([, st]) => st.item) });
    } catch { return; }
    fresh.forEach(([card, st], i) => {
      if (state.get(card) !== st || !verdicts?.[i]) return;
      applyVerdict(card, verdicts[i]);
      if (verdicts[i].pending) io.observe(card);
    });
    reportCount();
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 350);
  }

  // --------------------------------------- banner for the page being viewed
  function removeBanner() {
    document.querySelector('.invslop-banner')?.remove();
  }

  function showBanner(verdict) {
    removeBanner();
    const bar = document.createElement('div');
    bar.className = 'invslop-banner';
    bar.setAttribute('data-invslop-kind', verdict.s);
    const text = document.createElement('span');
    text.textContent = `${BADGE_TEXT[verdict.s]} — ${verdict.why}`;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Dismiss';
    close.addEventListener('click', () => bar.remove());
    bar.append(text, close);
    document.body.append(bar);
  }

  function checkPage() {
    if (location.href === lastHref) return;
    const href = (lastHref = location.href);
    removeBanner();
    const u = new URL(href);
    const v = videoIdOf(u);
    const item = v ? { v } : channelOf(u);
    if (!item) return;
    browser.runtime.sendMessage({ type: 'resolve', item }).then((verdict) => {
      if (location.href !== href || !verdict?.s || settings[verdict.s] === 'off') return;
      showBanner(verdict);
    }).catch(() => {});
  }

  // ----------------------------------------------------------------- wiring
  function resetAll() {
    for (const card of document.querySelectorAll('[data-invslop]')) clearCard(card);
    io.disconnect();
    state = new WeakMap();
    lastHref = '';
    scheduleScan();
  }

  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !(changes.settings || changes.listMeta || changes.svcMeta)) return;
    settings = await slopGetSettings();
    resetAll();
  });

  // --------------------------------------------- right-click menu support
  // The background script builds the menu; it asks us what was right-clicked.
  let lastTarget = null;
  document.addEventListener('contextmenu', (e) => { lastTarget = e.target; }, true);

  function contextItem() {
    for (let el = lastTarget; el && el.nodeType === 1; el = el.parentElement) {
      const st = state.get(el);
      if (st) return st.item;
    }
    // Not on a card: fall back to the video or channel this page is about.
    const u = new URL(location.href);
    const v = videoIdOf(u);
    return v ? { v } : channelOf(u);
  }

  // ------------------------------------------------------ report dialog
  // Lives in a shadow root so the site's CSS and ours cannot interfere.
  const TYPES = [['voice', 'AI voice / narration'], ['visual', 'AI visuals'], ['script', 'AI-written script'], ['music', 'AI music']];
  const LEVELS = [[1, 'Some AI'], [2, 'Mostly AI'], [3, 'Pure slop']];
  const DIALOG_CSS = `
    :host { all: initial; }
    .veil { position: fixed; inset: 0; z-index: 2147483600; display: grid; place-items: center; background: rgba(0,0,0,.55); font: 14px/1.45 system-ui, sans-serif; }
    form { box-sizing: border-box; width: min(92vw, 380px); max-height: 92vh; overflow: auto; padding: 18px; border-radius: 12px; background: #fbfbfd; color: #1c1b1f; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
    @media (prefers-color-scheme: dark) { form { background: #222126; color: #ebe9f0; } }
    h2 { margin: 0 0 4px; font-size: 16px; }
    p { margin: 0 0 10px; opacity: .8; font-size: 13px; }
    fieldset { margin: 0 0 12px; padding: 0; border: 0; }
    legend { padding: 0; margin-bottom: 4px; font-weight: 600; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; opacity: .7; }
    label { display: flex; align-items: center; gap: 8px; padding: 3px 0; cursor: pointer; }
    input { margin: 0; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    button { font: inherit; font-weight: 600; padding: 7px 12px; border-radius: 6px; border: 1px solid #b3261e; background: #b3261e; color: #fff; cursor: pointer; }
    button.plain { background: transparent; color: inherit; border-color: rgba(128,128,128,.5); }
    button:disabled { opacity: .5; cursor: default; }
    .msg { min-height: 1.4em; margin: 10px 0 0; font-weight: 600; }
  `;

  function el(tag, props, ...kids) {
    const node = Object.assign(document.createElement(tag), props || {});
    node.append(...kids);
    return node;
  }

  function closeReport() {
    document.querySelector('.invslop-report')?.remove();
  }

  function describeState(state) {
    if (!state || state.status === 'unknown') return 'Nobody has reported this video yet.';
    // The service withholds counts on undecided videos until you have voted.
    if (state.counts_hidden) return 'Reported, not settled yet.';
    const votes = `${state.n_yes} say slop, ${state.n_no} say not`;
    if (state.status === 'confirmed') return `Listed as AI slop (${votes}).`;
    if (state.status === 'rejected') return `Reviewed and not listed (${votes}).`;
    return `Reported, not settled yet (${votes}).`;
  }

  function openReport({ item, state, signedIn }) {
    closeReport();
    const host = el('div', { className: 'invslop-report' });
    const root = host.attachShadow({ mode: 'open' });
    const msg = el('p', { className: 'msg' });
    msg.setAttribute('role', 'status');
    const status = el('p', {}, describeState(state));
    const mine = state?.mine;

    const typeBoxes = TYPES.map(([value, text]) => {
      const box = el('input', { type: 'checkbox', value, checked: !!mine?.slop && mine.types.includes(value) });
      return [box, el('label', {}, box, text)];
    });
    const levelBoxes = LEVELS.map(([value, text]) => {
      const box = el('input', { type: 'radio', name: 'level', value: String(value), checked: (mine?.slop ? mine.level : 2) === value });
      return [box, el('label', {}, box, text)];
    });

    const slopBtn = el('button', { type: 'button' }, mine?.slop ? 'Update my report' : 'Report as AI slop');
    const notBtn = el('button', { type: 'button', className: 'plain' }, 'Not slop');
    const cancel = el('button', { type: 'button', className: 'plain' }, 'Close');
    const signIn = el('button', { type: 'button' }, 'Sign in to report');
    const actions = el('div', { className: 'row' });

    const setSignedIn = (yes) => {
      actions.replaceChildren(...(yes ? [slopBtn, notBtn, cancel] : [signIn, cancel]));
    };
    setSignedIn(signedIn);

    const busy = (on) => { for (const b of [slopBtn, notBtn, signIn]) b.disabled = on; };
    const send = async (message) => {
      busy(true);
      try {
        const res = await browser.runtime.sendMessage(message);
        if (!res?.ok) throw new Error(res?.error || 'Something went wrong.');
        return res.value;
      } finally { busy(false); }
    };

    const submit = async (slop) => {
      const types = typeBoxes.filter(([box]) => box.checked).map(([box]) => box.value);
      const level = Number(levelBoxes.find(([box]) => box.checked)?.[0].value || 0);
      if (slop && !types.length) { msg.textContent = 'Tick at least one kind of AI content.'; return; }
      msg.textContent = 'Sending…';
      try {
        const next = await send({ type: 'svc-assess', item, slop, types, level });
        status.textContent = describeState(next);
        msg.textContent = 'Recorded. Thank you.';
      } catch (e) { msg.textContent = e.message; }
    };
    slopBtn.addEventListener('click', () => submit(true));
    notBtn.addEventListener('click', () => submit(false));
    cancel.addEventListener('click', closeReport);
    signIn.addEventListener('click', async () => {
      msg.textContent = 'Complete sign-in in the window that opened…';
      try { await send({ type: 'svc-login' }); msg.textContent = ''; setSignedIn(true); } catch (e) { msg.textContent = e.message; }
    });

    const form = el('form', {},
      el('h2', {}, 'Report or rate this video'),
      status,
      el('fieldset', {}, el('legend', {}, 'What is AI-generated?'), ...typeBoxes.map(([, label]) => label)),
      el('fieldset', {}, el('legend', {}, 'How much?'), ...levelBoxes.map(([, label]) => label)),
      actions, msg);
    form.addEventListener('submit', (e) => e.preventDefault());
    const veil = el('div', { className: 'veil' }, form);
    veil.addEventListener('mousedown', (e) => { if (e.target === veil) closeReport(); });
    veil.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReport(); e.stopPropagation(); });
    root.append(el('style', {}, DIALOG_CSS), veil);
    document.documentElement.append(host);
    (signedIn ? typeBoxes[0][0] : signIn).focus();
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'report-open') {
      openReport(msg);
      return undefined;
    }
    if (msg?.type === 'ctx') {
      return Promise.resolve({
        item: contextItem(),
        hidden: document.querySelectorAll('[data-invslop-action="hide"]').length,
        reveal: document.documentElement.hasAttribute('data-invslop-reveal'),
      });
    }
    if (msg?.type === 'page-info') {
      const count = (kind) => document.querySelectorAll(`[data-invslop="${kind}"]`).length;
      return Promise.resolve({
        site: isYouTube ? 'YouTube' : 'Invidious',
        block: count('block'), svc: count('svc'), warn: count('warn'), ai: count('ai'),
        hidden: document.querySelectorAll('[data-invslop-action="hide"]').length,
        reveal: document.documentElement.hasAttribute('data-invslop-reveal'),
      });
    }
    if (msg?.type === 'reveal') {
      document.documentElement.toggleAttribute('data-invslop-reveal', !!msg.on);
    }
    return undefined;
  });

  slopGetSettings().then((s) => {
    settings = s;
    scan();
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['href'],
    });
    window.addEventListener('popstate', scheduleScan);
    document.addEventListener('yt-navigate-finish', scheduleScan);
  });
})();
