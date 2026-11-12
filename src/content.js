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
  const BADGE_TEXT = { block: 'AI slop', warn: 'Likely AI', ai: 'AI-labelled' };

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
    if (area !== 'local' || !(changes.settings || changes.listMeta)) return;
    settings = await slopGetSettings();
    resetAll();
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'page-info') {
      const count = (kind) => document.querySelectorAll(`[data-invslop="${kind}"]`).length;
      return Promise.resolve({
        site: isYouTube ? 'YouTube' : 'Invidious',
        block: count('block'), warn: count('warn'), ai: count('ai'),
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
