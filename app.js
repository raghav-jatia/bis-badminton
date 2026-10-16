// ── BIS INTERHOUSE BADMINTON — shared page helpers ───────────────────
// Data flow: Google Sheet → Apps Script web app (config.js API_URL) → here
// → BADM.build() (engine.js) → each page's render().
var APP = (function () {
  'use strict';
  var C = window.BADM_CONFIG || {};
  var CACHE_KEY = 'bisbad_last_v1';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── storage (never trusted, never required) ────────────────────────
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  // ── fetching ───────────────────────────────────────────────────────
  function apiUrl(params) {
    var u = C.API_URL;
    var q = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    return u + (u.indexOf('?') === -1 ? '?' : '&') + q;
  }

  function fetchJSON() {
    return fetch(apiUrl({ action: 'data', _: Date.now() }), { cache: 'no-store', redirect: 'follow' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  // Fallback if fetch is blocked on some network: JSONP via a script tag.
  function fetchJSONP() {
    return new Promise(function (resolve, reject) {
      var cb = 'badmcb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      var s = document.createElement('script');
      var done = false;
      var timer = setTimeout(function () { finish(); reject(new Error('timeout')); }, 15000);
      function finish() { done = true; clearTimeout(timer); try { delete window[cb]; } catch (e) { window[cb] = undefined; } if (s.parentNode) s.parentNode.removeChild(s); }
      window[cb] = function (d) { if (done) return; finish(); resolve(d); };
      s.onerror = function () { if (done) return; finish(); reject(new Error('network')); };
      s.src = apiUrl({ action: 'data', callback: cb, _: Date.now() });
      document.head.appendChild(s);
    });
  }

  // Returns { data, source: 'live'|'cache'|'built-in', error? }
  function load() {
    if (!C.API_URL) return Promise.resolve({ data: window.BADM_SEED, source: 'built-in' });
    return fetchJSON().catch(function () { return fetchJSONP(); })
      .then(function (d) {
        if (!d || d.ok !== true) throw new Error((d && d.error) || 'Bad data');
        lsSet(CACHE_KEY, JSON.stringify(d));
        return { data: d, source: 'live' };
      })
      .catch(function (err) {
        var cached = null;
        try { cached = JSON.parse(lsGet(CACHE_KEY) || 'null'); } catch (e) { cached = null; }
        return { data: cached || window.BADM_SEED, source: cached ? 'cache' : 'built-in', error: err };
      });
  }

  function cachedNow() {
    if (!C.API_URL) return null;
    try { return JSON.parse(lsGet(CACHE_KEY) || 'null'); } catch (e) { return null; }
  }

  // ── auto refresh (pauses when the tab is hidden) ───────────────────
  function autoRefresh(render) {
    var ms = Math.max(10000, Number(C.REFRESH_MS) || 20000);
    var busy = false, timer = null;
    function tick() {
      if (busy) return;
      busy = true;
      load().then(function (res) {
        busy = false;
        render(res);
      }, function () { busy = false; });
    }
    // Instant first paint from the last copy, then fetch live.
    var c = cachedNow();
    if (c) { try { render({ data: c, source: 'cache', first: true }); } catch (e) { /* ignore */ } }
    tick();
    timer = setInterval(function () { if (!document.hidden) tick(); }, ms);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    return timer;
  }

  function stamp(res) {
    var el = document.getElementById('stamp');
    var dot = document.getElementById('live-dot');
    if (!el) return;
    var t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    if (res.source === 'live') { el.textContent = 'Live · updated ' + t; if (dot) dot.className = 'live-dot'; }
    else if (res.source === 'cache' && res.first) { el.textContent = 'Connecting…'; if (dot) dot.className = 'live-dot off'; }
    else if (res.source === 'cache') { el.textContent = 'Reconnecting… showing the last results received'; if (dot) dot.className = 'live-dot err'; }
    else if (!C.API_URL) { el.textContent = 'Draws · live results start soon'; if (dot) dot.className = 'live-dot off'; }
    else { el.textContent = 'Reconnecting…'; if (dot) dot.className = 'live-dot err'; }
  }

  // ── nav + header ───────────────────────────────────────────────────
  function mountNav(model) {
    var page = location.pathname.split('/').pop() || 'index.html';
    var cfg = model ? model.config : null;
    var links = [['index.html', 'Home'], ['draws.html', 'Draws'], ['winners.html', 'Winners']];
    var html =
      '<header class="site-header"><div class="header-inner">' +
      '<a class="header-logo" href="index.html">BIS Badminton<span>Interhouse Championship — 2026–27</span></a>' +
      '<span class="header-date" id="hdr-date">' + esc(cfg && cfg.date ? cfg.date.replace(/^\w+,\s*/, '') : '17 October 2026') +
      '<br>' + esc(cfg && cfg.venue ? cfg.venue : 'NSCI, Worli') + '</span>' +
      '</div></header>' +
      '<nav class="site-nav"><div class="nav-inner">' +
      links.map(function (l) {
        return '<a class="nav-link' + (page === l[0] ? ' active' : '') + '" href="' + l[0] + '">' + l[1] + '</a>';
      }).join('') +
      '</div></nav>';
    var ph = document.getElementById('nav-placeholder');
    if (ph) ph.innerHTML = html;
  }

  // ── Google Analytics (public pages only) ───────────────────────────
  function analytics() {
    var id = String(C.GA_ID || '').trim();
    if (!/^G-[A-Z0-9]{4,}$/i.test(id)) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', id);
  }

  // ── display helpers ────────────────────────────────────────────────
  function hcls(house) { return house ? 'h-' + house : 'h-none'; }
  function pname(p) {
    if (!p) return '';
    return '<span class="' + hcls(p.house) + '">' + esc(p.name) + '</span>';
  }
  function houseTag(house) {
    return '<span class="house-tag ht-' + (house || 'none') + '">' + (house ? esc(house) : 'House?') + '</span>';
  }
  function medal(pos) { return { 1: '🥇', 2: '🥈', 3: '🥉' }[pos] || ''; }
  function ordinal(pos) { return { 1: '1st', 2: '2nd', 3: '3rd' }[pos] || pos + 'th'; }

  function catSlug(name) { return String(name).replace(/\s+/g, '-'); }
  function catFromSlug(model, slug) {
    var k = decodeURIComponent(String(slug || '')).replace(/-/g, ' ').toLowerCase();
    return model.byName[k] || null;
  }

  function stateBadge(c) {
    if (c.state === 'complete') return '<span class="status-badge st-completed">' + (c.kind === 'single' ? 'Single entry' : 'Completed') + '</span>';
    if (c.state === 'progress') return '<span class="status-badge st-progress">● In progress</span>';
    if (c.state === 'postponed') return '<span class="status-badge st-postponed">Postponed</span>';
    if (c.state === 'single') return '<span class="status-badge st-single">Single entry</span>';
    return '<span class="status-badge st-upcoming">Upcoming</span>';
  }

  function roundRule(rk) {
    return { r1: 'to 11', r2: 'to 11', qf: 'to 11', sf: 'to 15', f: 'to 15 · setting to 17', '3p': '' }[rk] || '';
  }

  // "2026-10-17 10:42:13.512" → "10:42 AM"
  function clock(ts) {
    var m = String(ts || '').match(/(\d{1,2}):(\d{2})/);
    if (!m) return '';
    var h = parseInt(m[1], 10), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + m[2] + ' ' + ap;
  }

  // Player row inside a match card (shared by Home, Draws and Admin).
  function prow(m, sideKey) {
    var s = m[sideKey];
    var isWin = m.decided && m.winSide === sideKey;
    var isLose = m.decided && !isWin && m.how !== 'double' && m.how !== 'empty';
    var cls = m.decided ? (isWin ? 'win' : 'lose') : 'idle';
    if (m.how === 'double' || m.how === 'empty') cls = 'lose';
    var name;
    if (s.type === 'player') name = pname(s);
    else if (s.type === 'pending') name = '<span class="pend">' + esc(s.label) + '</span>';
    else name = '<span class="pend">' + esc(s.label) + '</span>';
    var sc = '';
    if (m.wPts !== null && m.wPts !== undefined && m.decided) sc = isWin ? m.wPts : (isLose ? m.lPts : '');
    var tag = '';
    if (isWin && m.how === 'walkover') tag = '<span class="wo-tag">W/O</span>';
    if (isWin && m.how === 'auto') tag = '<span class="wo-tag">' + (m[sideKey === 'a' ? 'b' : 'a'].why === 'bye' ? 'BYE' : 'W/O') + '</span>';
    return '<div class="prow ' + cls + '">' +
      (isWin ? '<span class="tick">✓</span>' : '') +
      '<span class="nm">' + name + '</span>' + tag +
      (sc !== '' ? '<span class="sc">' + esc(sc) + '</span>' : '') +
      '</div>';
  }

  function matchCard(m, opts) {
    opts = opts || {};
    var right = '';
    if (m.how === 'double') right = 'Both absent';
    else if (m.how === 'empty') right = 'No players';
    else if (m.decided && m.hasStored && m.updatedAt) right = clock(m.updatedAt);
    else if (!m.decided && m.status === 'ready') right = 'Up next';
    var meta = (opts.showCat ? '<span class="cat">' + esc(m.category) + '</span> · ' : '') +
      '<span>' + esc(m.label) + (opts.showCat && m.rk !== '3p' && m.rk !== 'f' ? ' · ' + esc(m.round) : '') + '</span>';
    return '<div class="mcard ' + (m.decided ? 'done' : m.status) + '">' +
      '<div class="mcard-meta">' + meta + (right ? '<span class="right">' + esc(right) + '</span>' : '') + '</div>' +
      prow(m, 'a') + prow(m, 'b') +
      '</div>';
  }

  function warningsHTML(res, model) {
    var out = [];
    if (C.API_URL && res.source !== 'live' && !res.first) {
      out.push('<div class="data-warning"><strong>Live results are reconnecting.</strong> ' +
        (res.source === 'cache' ? 'Showing the last results received.' : 'Showing the draws only.') + ' This page retries on its own.</div>');
    }
    var pending = [];
    if (res.source !== 'built-in') {
      model.categories.forEach(function (c) {
        if (c.state !== 'complete') return;
        c.podium.forEach(function (p) { if (p.noHouse) pending.push(p.player.name + ' (' + c.name + ', ' + ordinal(p.pos) + ')'); });
      });
    }
    if (pending.length) {
      out.push('<div class="notice"><b>Points pending:</b> house not recorded yet for ' + esc(pending.join(', ')) +
        '. These points will be added once confirmed.</div>');
    }
    if (/[?&]debug/.test(location.search)) {
      out.push('<div class="data-warning"><strong>Debug (' + model.issues.length + '):</strong><br>' +
        (model.issues.map(function (i) { return esc('[' + i.level + '] ' + (i.category ? i.category + ': ' : '') + i.msg); }).join('<br>') || 'No issues') + '</div>');
    }
    return out.join('');
  }

  return {
    C: C, esc: esc, load: load, autoRefresh: autoRefresh, stamp: stamp, mountNav: mountNav, analytics: analytics,
    pname: pname, houseTag: houseTag, medal: medal, ordinal: ordinal, hcls: hcls,
    catSlug: catSlug, catFromSlug: catFromSlug, stateBadge: stateBadge, roundRule: roundRule, clock: clock,
    prow: prow, matchCard: matchCard, warningsHTML: warningsHTML,
    lsGet: lsGet, lsSet: lsSet, lsDel: lsDel, apiUrl: apiUrl
  };
})();
