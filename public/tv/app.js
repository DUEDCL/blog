/**
 * /tv 影视聚合页的客户端逻辑（v2）。
 *
 * 不参与构建（放在 public/ 里按原样发），所以这里不写 import —— 用全局的 Hls。
 *
 * 环境事实（改之前必须知道）：
 * 1. **ClientRouter（全站 SPA 换页）**。脚本只执行一次，入口挂 `astro:page-load`，
 *    并用 `data-tv-ready` 防重复绑定。
 * 2. **播放必须直连优先**。2026-10 上线实测：15 个源里 8 个的 m3u8 CDN 会拒绝
 *    Cloudflare 机房出口 IP（403/404/530），但访客自己的网络取得到，且这些 m3u8
 *    带 `ACAO: *`。所以播放走 `direct → hlsProxy → fullProxy` 三级降级。
 * 3. **清晰度只能实测**。资源站 API 里没有分辨率字段，唯一可信来源是 master 播放列表的
 *    `RESOLUTION=` / `BANDWIDTH=`。探测本身放在**浏览器**做（这些 CDN 对浏览器放行、
 *    对 Worker 机房 IP 不放行），所以探测不必经过 /api/tv/*。
 *
 * 本文件三块新东西：
 *   A. 清晰度探测 + 自动选源（最高清 → 最快）
 *   B. 播放器内清晰度切换（hls.js 的 levels）
 *   C. 本地记录：搜索历史、播放历史、断点续播
 */

(function () {
  'use strict';

  var BASE = '/api/tv';
  var LS = {
    off: 'tv:off',        // 访客关掉的源
    q: 'tv:q',            // 搜索历史
    prog: 'tv:prog',      // 播放进度 / 历史
    qual: 'tv:qual',      // 清晰度探测缓存
    sort: 'tv:sort',      // 结果排序偏好
  };
  var HOT = ['庆余年', '流浪地球', '繁花', '狂飙', '三体', '沙丘', '阿凡达', '抓娃娃'];
  var MAX_Q_HIST = 12;
  var MAX_PROG = 30;
  var QUAL_TTL = 7 * 86400 * 1000;   // 清晰度缓存 7 天
  var PROBE_TOP_N = 10;              // 探测前 N 个候选源；16 个源里探 10 个，兼顾覆盖与延迟

  /** @type {any} */
  var state = {
    sources: [],
    live: [],
    off: new Set(),
    groups: [],
    lastQ: '',
    activeSrc: 'all',
    detail: null,
    candIdx: 0,
    lineIdx: 0,
    epIdx: -1,
    eps: [],
    hls: null,
    tryIdx: 0,
    pendingPlay: null,
    probe: {},            // `${srcId}:${vodId}` → {w,h,bw,ms} 本次会话的探测结果
    autoPicked: false,    // 详情页是否已按探测结果自动换源
    sort: 'rel',          // 结果排序：rel 推荐 / rating 评分 / srcs 源数 / name 名称
    baseRate: 1,          // 常驻倍速（点倍速按钮轮换）
    holdingBoost: false,  // 是否处于「长按右箭头」的临时快放
  };

  var SORTS = [
    { id: 'rel', label: '推荐' },
    { id: 'rating', label: '评分' },
    { id: 'srcs', label: '源最多' },
    { id: 'name', label: '名称' },
  ];
  var RATES = [1, 1.5, 2, 3];
  var HOLD_RATE = 3;      // 长按右箭头时的临时倍速

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function getJson(p) {
    return fetch(p).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error((d && d.error) || 'HTTP ' + r.status);
        return d;
      });
    });
  }

  /* ══════════════ 本地存储 ══════════════ */

  function readLS(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeLS(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 隐私模式忽略 */ }
  }

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(LS.off);
      state.off = new Set(raw ? JSON.parse(raw) : []);
    } catch (e) { state.off = new Set(); }
    var s = readLS(LS.sort, 'rel');
    state.sort = SORTS.some(function (x) { return x.id === s; }) ? s : 'rel';
  }
  function saveOff() { writeLS(LS.off, Array.from(state.off)); }

  /** 搜索历史：[{q, t}] 新的在前 */
  function getQueryHistory() { return readLS(LS.q, []); }
  function pushQueryHistory(q) {
    var list = getQueryHistory().filter(function (x) { return x.q !== q; });
    list.unshift({ q: q, t: Date.now() });
    writeLS(LS.q, list.slice(0, MAX_Q_HIST));
    renderQueryHistory();
    // 登录用户的记录同时上云（失败不影响本地可用）
    if (authState.loggedIn) {
      fetch(BASE + '/hist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ q: q }),
      }).catch(function () {});
    }
  }
  function clearQueryHistory() {
    writeLS(LS.q, []);
    renderQueryHistory();
  }

  /** 播放进度：{ [key]: {t,d,ts,name,epName,srcId,vodId,srcName,lineIdx,lineFrom} } */
  function getProgress() { return readLS(LS.prog, {}); }
  function progKey(name, epName) { return name + '||' + epName; }

  function saveProgress(rec) {
    var all = getProgress();
    all[progKey(rec.name, rec.epName)] = rec;
    // 按时间倒序截断
    var keys = Object.keys(all).sort(function (a, b) { return (all[b].ts || 0) - (all[a].ts || 0); });
    var out = {};
    keys.slice(0, MAX_PROG).forEach(function (k) { out[k] = all[k]; });
    writeLS(LS.prog, out);
  }
  function findProgress(name, epName) {
    return getProgress()[progKey(name, epName)] || null;
  }
  /** 某部片最后一次看到第几集（用于详情页「继续观看」） */
  function lastProgressOf(title) {
    var all = getProgress();
    var best = null;
    Object.keys(all).forEach(function (k) {
      var r = all[k];
      if (r.name !== title) return;
      if (!best || (r.ts || 0) > (best.ts || 0)) best = r;
    });
    return best;
  }

  /* ══════════════ 清晰度探测 ══════════════ */

  var QUAL_CACHE = readLS(LS.qual, {});

  function cacheGet(srcId, vodId) {
    var k = srcId + ':' + vodId;
    var hit = QUAL_CACHE[k];
    if (hit && Date.now() - (hit.ts || 0) < QUAL_TTL) return hit;
    return null;
  }
  function cachePut(srcId, vodId, val) {
    QUAL_CACHE[srcId + ':' + vodId] = Object.assign({ ts: Date.now() }, val);
    // 简单裁剪，别让 localStorage 无限涨
    var keys = Object.keys(QUAL_CACHE);
    if (keys.length > 200) {
      keys.sort(function (a, b) { return (QUAL_CACHE[a].ts || 0) - (QUAL_CACHE[b].ts || 0); })
        .slice(0, keys.length - 200)
        .forEach(function (k) { delete QUAL_CACHE[k]; });
    }
    writeLS(LS.qual, QUAL_CACHE);
  }

  /**
   * 探测一个 m3u8 的清晰度与延迟。
   * - 只有 master 列表（含 `#EXT-X-STREAM-INF`）才有 `RESOLUTION`，媒体列表拿不到分辨率，
   *   此时把 width 记 0，由上层按「未知」处理。
   * - 耗时用整段播放列表的下载时间当**测速代理**：播放列表只有几 KB，
   *   这个时间约等于首字节延迟，比去拉一个分片轻得多。
   */
  function probeOne(url, timeoutMs) {
    var started = performance.now();
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, timeoutMs || 7000);
    return fetch(url, { signal: ac.signal, cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (text) {
        clearTimeout(timer);
        var ms = Math.round(performance.now() - started);
        var widths = [];
        var heights = [];
        var bws = [];
        var re = /RESOLUTION=(\d+)x(\d+)/gi;
        var m;
        while ((m = re.exec(text)) !== null) {
          widths.push(Number(m[1]));
          heights.push(Number(m[2]));
        }
        var re2 = /BANDWIDTH=(\d+)/gi;
        while ((m = re2.exec(text)) !== null) bws.push(Number(m[1]));
        var master = /#EXT-X-STREAM-INF/i.test(text);
        return {
          ok: true,
          master: master,
          w: widths.length ? Math.max.apply(null, widths) : 0,
          h: heights.length ? Math.max.apply(null, heights) : 0,
          bw: bws.length ? Math.max.apply(null, bws) : 0,
          ms: ms,
        };
      })
      .catch(function (e) {
        clearTimeout(timer);
        return { ok: false, error: String(e && e.message || e) };
      });
  }

  /** 并发探测前 N 个候选；有缓存的直接用 */
  function probeCandidates(group) {
    var cands = group.candidates.slice(0, PROBE_TOP_N);
    var jobs = cands.map(function (c) {
      var hit = cacheGet(c.sourceId, c.vodId);
      if (hit) return Promise.resolve(hit);
      if (!c.firstHlsUrl) return Promise.resolve({ ok: false, error: '无直连线路' });
      return probeOne(c.firstHlsUrl).then(function (r) {
        if (r.ok) cachePut(c.sourceId, c.vodId, r);
        return r;
      });
    });
    return Promise.all(jobs).then(function (results) {
      cands.forEach(function (c, i) { state.probe[c.sourceId + ':' + c.vodId] = results[i]; });
      return results;
    });
  }

  /** 分辨率 → 展示标签 */
  function qualLabel(p) {
    if (!p || !p.ok) return '';
    if (p.w >= 3800 || p.h >= 2100) return '4K';
    if (p.w >= 2500 || p.h >= 1400) return '2K';
    if (p.w >= 1900 || p.h >= 1000) return '1080P';
    if (p.w >= 1200 || p.h >= 700) return '720P';
    if (p.w > 0) return p.h + 'P';
    return '未知清晰度';
  }
  /** 排序权重：分辨率优先，其次带宽，最后延迟（越小越好） */
  function qualScore(p) {
    if (!p || !p.ok) return -1;
    return (p.w || 0) * 1e6 + (p.bw || 0) / 1e3 - (p.ms || 0);
  }

  function qualBadgeClass(p) {
    if (!p || !p.ok) return '';
    if (p.w >= 2500) return ' tv-qbadge--4k';
    if (p.w >= 1900) return ' tv-qbadge--1080';
    return '';
  }

  /* ══════════════ 初始化 ══════════════ */

  function init() {
    var root = $('[data-tv]');
    if (!root || root.dataset.tvReady === '1') return;
    root.dataset.tvReady = '1';

    loadPrefs();
    bindTabs();
    bindSearch();
    bindPlayer();
    renderHot();
    renderQueryHistory();

    getJson(BASE + '/sources')
      .then(function (d) {
        state.sources = d.sources || [];
        state.live = d.live || [];
        renderSrcBar();
        renderSrcList();
        updateCount();
        renderContinue();

        // 登录用户在云端有记录：合并进来（匿名时这里是 401，静默跳过）
        syncHistory();

        try {
          var sp = new URLSearchParams(location.search);
          var q = (sp.get('q') || '').trim();
          if (q) { $('[data-tv-q]').value = q; doSearch(q); }
          if (sp.get('tab') === 'live') {
            var lb = $('[data-tv-tab="live"]');
            if (lb) lb.click();
          }
        } catch (e) { /* 老浏览器忽略 */ }
      })
      .catch(function (e) { setStatus('读取源清单失败：' + e.message); });
  }

  function updateCount() {
    var el = $('[data-tv-count]');
    if (el) el.textContent = enabledSources().length + ' 源';
  }
  function setStatus(html) {
    var el = $('[data-tv-status]');
    if (el) el.innerHTML = html;
  }
  function enabledSources() {
    return state.sources.filter(function (s) { return !state.off.has(s.id); });
  }
  function srcById(id) {
    for (var i = 0; i < state.sources.length; i++) if (state.sources[i].id === id) return state.sources[i];
    return null;
  }
  function originOf(api) {
    try { return new URL(api).origin; } catch (e) { return ''; }
  }

  function bindTabs() {
    $$('[data-tv-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.dataset.tvTab;
        $$('[data-tv-tab]').forEach(function (b) { b.classList.toggle('is-on', b === btn); });
        $$('[data-tv-view]').forEach(function (v) {
          v.classList.toggle('is-on', v.dataset.tvView === name);
        });
        if (name === 'live') loadLive();
      });
    });
  }

  function bindSearch() {
    var form = $('[data-tv-form]');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = $('[data-tv-q]').value.trim();
      if (q) doSearch(q);
    });

    var input = $('[data-tv-q]');
    // 聚焦时把历史摊开（有历史才开）
    input.addEventListener('focus', renderQueryHistory);
  }

  function renderHot() {
    var box = $('[data-tv-hot]');
    if (!box) return;
    box.innerHTML = '';
    HOT.forEach(function (w) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tv-chip';
      b.textContent = w;
      b.addEventListener('click', function () { $('[data-tv-q]').value = w; doSearch(w); });
      box.appendChild(b);
    });
  }

  /** 搜索框下方的历史条：点一下直接搜，右侧可清空 */
  function renderQueryHistory() {
    var box = $('[data-tv-qhist]');
    if (!box) return;
    var list = getQueryHistory();
    box.innerHTML = '';
    if (!list.length) { box.hidden = true; return; }
    box.hidden = false;

    var label = document.createElement('span');
    label.className = 'tv-qhist__label';
    label.textContent = '最近搜过';
    box.appendChild(label);

    list.forEach(function (item) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tv-qhist__item';
      b.textContent = item.q;
      b.title = '再搜一次：' + item.q;
      b.addEventListener('click', function () {
        $('[data-tv-q]').value = item.q;
        doSearch(item.q);
      });
      box.appendChild(b);
    });

    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'tv-qhist__clear';
    clear.textContent = '清空';
    clear.addEventListener('click', clearQueryHistory);
    box.appendChild(clear);
  }

  /** 继续观看：按播放历史列出最近看过的片子 */
  function renderContinue() {
    var box = $('[data-tv-cont]');
    if (!box) return;
    var all = getProgress();
    var items = Object.keys(all).map(function (k) { return all[k]; })
      .filter(function (r) { return r && r.name && (r.t || 0) > 5; })
      .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); })
      .slice(0, 8);

    box.innerHTML = '';
    if (!items.length) { box.hidden = true; return; }
    box.hidden = false;

    var h = document.createElement('div');
    h.className = 'tv-cont__h';
    h.textContent = '继续观看';
    box.appendChild(h);

    var list = document.createElement('div');
    list.className = 'tv-cont__list';
    items.forEach(function (r) {
      var pct = r.d > 0 ? Math.min(100, Math.round((r.t / r.d) * 100)) : 0;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tv-cont__item';
      b.innerHTML =
        '<span class="tv-cont__name">' + esc(r.name) + '</span>' +
        '<span class="tv-cont__ep">' + esc(r.epName || '') +
        (pct ? ' · 已看 ' + pct + '%' : '') + '</span>';
      b.addEventListener('click', function () {
        $('[data-tv-q]').value = r.name;
        doSearch(r.name).then(function () {
          // 找到同名分组后自动打开（不保证一定命中，命中才开）
          var gi = state.groups.findIndex(function (g) { return g.name === r.name; });
          if (gi >= 0) openDetail(gi);
        });
      });
      list.appendChild(b);
    });
    box.appendChild(list);
  }

  /* ══════════════ 源筛选 ══════════════ */

  function renderSrcBar() {
    var bar = $('[data-tv-srcbar]');
    if (!bar) return;
    bar.innerHTML = '';

    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'tv-chip' + (state.activeSrc === 'all' ? ' is-on' : '');
    all.textContent = '全部';
    all.addEventListener('click', function () {
      state.activeSrc = 'all';
      renderSrcBar();
      if (state.lastQ) doSearch(state.lastQ);
    });
    bar.appendChild(all);

    state.sources.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tv-chip' + (state.off.has(s.id) ? '' : ' is-ok') +
        (state.activeSrc === s.id ? ' is-on' : '');
      b.dataset.srcId = s.id;
      b.innerHTML = '<span class="tv-chip__dot"></span>' + esc(s.name);
      b.addEventListener('click', function () {
        state.activeSrc = state.activeSrc === s.id ? 'all' : s.id;
        renderSrcBar();
        if (state.lastQ) doSearch(state.lastQ);
      });
      bar.appendChild(b);
    });
  }

  function paintSrcHealth(report) {
    (report || []).forEach(function (r) {
      var chip = $('[data-tv-srcbar] [data-src-id="' + r.id + '"]');
      if (!chip) return;
      chip.classList.toggle('is-ok', !!r.ok);
      chip.classList.toggle('is-bad', !r.ok);
    });
  }

  /* ══════════════ 搜索 ══════════════ */

  function skeletons(n) {
    var grid = $('[data-tv-grid]');
    grid.innerHTML = '';
    for (var i = 0; i < n; i++) {
      var d = document.createElement('div');
      d.className = 'tv-card tv-card--sk';
      d.innerHTML = '<div class="tv-card__poster"></div><div class="tv-card__title"></div><div class="tv-card__meta"></div>';
      grid.appendChild(d);
    }
  }

  function doSearch(q) {
    state.lastQ = q;
    var empty = $('[data-tv-empty]');
    if (empty) empty.hidden = true;
    var cont = $('[data-tv-cont]');
    if (cont) cont.hidden = true;
    setStatus('正在并发搜索 <b>' + esc(q) + '</b> …');
    skeletons(12);

    var params = '?q=' + encodeURIComponent(q);
    if (state.activeSrc !== 'all') params += '&src=' + encodeURIComponent(state.activeSrc);

    return getJson(BASE + '/search' + params)
      .then(function (d) {
        state.groups = d.groups || [];
        pushQueryHistory(q);
        var okN = (d.sources || []).filter(function (s) { return s.ok; }).length;
        var allN = (d.sources || []).length;
        var fails = (d.sources || []).filter(function (s) { return !s.ok; });
        setStatus(
          '<b>' + okN + '/' + allN + '</b> 个源响应 · 共 <b>' + state.groups.length +
            '</b> 部 · ' + d.tookMs + 'ms' +
            (fails.length ? ' · 未响应：' + fails.map(function (f) { return esc(f.name); }).join('、') : '')
        );
        paintSrcHealth(d.sources);
        renderCards();
      })
      .catch(function (e) {
        $('[data-tv-grid]').innerHTML = '';
        setStatus('搜索失败：' + esc(e.message));
      });
  }

  /** 按当前排序偏好返回 [{g, idx}]；idx 是它在 state.groups 里的原始下标（开详情要用） */
  function sortedView() {
    var items = state.groups.map(function (g, idx) { return { g: g, idx: idx }; });
    var mode = state.sort;
    items.sort(function (a, b) {
      if (mode === 'rating') {
        return (b.g.rating || 0) - (a.g.rating || 0) || b.g.score - a.g.score;
      }
      if (mode === 'srcs') {
        return b.g.candidates.length - a.g.candidates.length || b.g.score - a.g.score;
      }
      if (mode === 'name') {
        return String(a.g.name).localeCompare(String(b.g.name), 'zh');
      }
      return b.g.score - a.g.score; // 推荐：服务端算好的相关性打分
    });
    return items;
  }

  /** 排序条：只在有结果时出现 */
  function renderSortBar() {
    var bar = $('[data-tv-sortbar]');
    if (!bar) return;
    if (!state.groups.length) { bar.hidden = true; return; }
    bar.hidden = false;
    // 只重建按钮，保留「排序」这个标签节点
    $$('.tv-sort', bar).forEach(function (b) { b.remove(); });
    SORTS.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tv-sort' + (state.sort === s.id ? ' is-on' : '');
      b.textContent = s.label;
      b.addEventListener('click', function () {
        state.sort = s.id;
        writeLS(LS.sort, s.id);
        renderSortBar();
        renderCards();
      });
      bar.appendChild(b);
    });
  }

  function renderCards() {
    var grid = $('[data-tv-grid]');
    grid.innerHTML = '';

    if (!state.groups.length) {
      var empty = $('[data-tv-empty]');
      empty.hidden = false;
      empty.innerHTML =
        '<span class="tv-empty__big">🍿</span>' +
        '<div class="tv-empty__msg">没有找到相关影片</div>' +
        '<div class="tv-empty__sub">换个关键词，或到「资源」页确认源是否可用</div>';
      return;
    }
    $('[data-tv-empty]').hidden = true;

    renderSortBar();

    sortedView().forEach(function (item, order) {
      var g = item.g;
      var i = item.idx;
      var card = document.createElement('div');
      card.className = 'tv-card';
      card.style.animationDelay = Math.min(order * 16, 320) + 'ms';

      var n = g.candidates.length;
      var best = g.candidates.filter(function (c) { return c.hasHls; }).length;
      card.innerHTML =
        '<div class="tv-card__poster">' +
        (g.pic
          ? '<img src="' + esc(g.pic) + '" alt="' + esc(g.name) + '" loading="lazy" ' +
            'onerror="this.style.display=\'none\';this.nextElementSibling.hidden=false">' +
            '<div class="tv-card__ph" hidden>' + esc(g.name) + '</div>'
          : '<div class="tv-card__ph">' + esc(g.name) + '</div>') +
        (n > 1 ? '<span class="tv-card__n">' + n + ' 源</span>' : '') +
        (g.remarks ? '<div class="tv-card__rem">' + esc(g.remarks) + '</div>' : '') +
        '</div>' +
        '<div class="tv-card__title">' + esc(g.name) + '</div>' +
        '<div class="tv-card__meta">' +
        (g.rating > 0 ? '<span class="tv-rate">★ ' + g.rating + '</span> ' : '') +
        esc([g.typeName, g.area, g.year].filter(Boolean).join(' · ') || '—') +
        (best ? ' · ' + best + ' 可直连' : '') +
        '</div>';

      card.addEventListener('click', function () { openDetail(i); });
      grid.appendChild(card);
    });
  }

  /* ══════════════ 详情 ══════════════ */

  function openDetail(groupIdx) {
    state.detail = { gi: groupIdx };
    state.candIdx = 0;
    state.lineIdx = 0;
    state.epIdx = -1;
    state.autoPicked = false;
    $('[data-tv-mask]').hidden = false;
    $('[data-tv-drawer]').hidden = false;
    renderDetail();
  }

  function closeDetail() {
    $('[data-tv-mask]').hidden = true;
    $('[data-tv-drawer]').hidden = true;
  }

  function renderDetail() {
    var g = state.groups[state.detail.gi];
    if (!g) return;
    var body = $('[data-tv-dbody]');
    var cand = g.candidates[state.candIdx] || g.candidates[0];

    body.innerHTML =
      '<div class="tv-detail__hero">' +
      '<div class="tv-detail__poster">' + (g.pic ? '<img src="' + esc(g.pic) + '" alt="' + esc(g.name) + '">' : '') + '</div>' +
      '<div class="tv-detail__head">' +
      '<h2 class="tv-detail__title">' + esc(g.name) + '</h2>' +
      '<div class="tv-detail__tags">' + tagsHtml(g) + '</div>' +
      '<div class="tv-detail__desc">暂无简介</div>' +
      '</div></div>' +
      '<div class="tv-detail__sec">' +
      '<h3 class="tv-detail__h">来源线路（' + g.candidates.length + ' 个源）' +
      '<span class="tv-detail__probe" data-tv-probe>正在测清晰度…</span></h3>' +
      '<div class="tv-cands" data-tv-cands></div>' +
      '<div data-tv-extra><div class="tv-loading">正在读取剧集…</div></div>' +
      '</div>';

    bindCands(g);
    loadDetailFor(g, cand);

    // 逐源探测清晰度；测出比当前更好的就自动切过去（只自动切一次，不跟用户抢）
    probeCandidates(g).then(function (results) {
      renderCands(g, results);
      var probeEl = $('[data-tv-probe]');
      var ranked = g.candidates.slice(0, PROBE_TOP_N).map(function (c, i) {
        return { c: c, p: results[i], s: qualScore(results[i]) };
      }).filter(function (x) { return x.p && x.p.ok; });

      if (probeEl) {
        probeEl.textContent = ranked.length
          ? '已测 ' + ranked.length + ' 源 · 最高 ' + qualLabel(ranked.reduce(function (a, b) { return b.s > a.s ? b : a; }).p)
          : '清晰度未知（源未提供多码率列表）';
      }

      ranked.sort(function (a, b) { return b.s - a.s; });
      if (ranked.length && !state.autoPicked) {
        state.autoPicked = true;
        var bestIdx = g.candidates.findIndex(function (c) { return c.sourceId === ranked[0].c.sourceId; });
        if (bestIdx >= 0 && bestIdx !== state.candIdx) {
          state.candIdx = bestIdx;
          state.lineIdx = 0;
          state.epIdx = -1;
          renderCands(g, results);
          loadDetailFor(g, g.candidates[bestIdx], true);
        }
      }
    });
  }

  function tagsHtml(g, vod) {
    var out = [];
    var type = (vod && vod.typeName) || g.typeName;
    var year = (vod && vod.year) || g.year;
    var area = (vod && vod.area) || g.area;
    var rem = (vod && vod.remarks) || g.remarks;
    if (type) out.push('<span class="tv-tag tv-tag--seal">' + esc(type) + '</span>');
    if (year) out.push('<span class="tv-tag">' + esc(year) + '</span>');
    if (area) out.push('<span class="tv-tag">' + esc(area) + '</span>');
    if (rem) out.push('<span class="tv-tag">' + esc(rem) + '</span>');
    if (vod && vod.director) out.push('<span class="tv-tag">导演 ' + esc(vod.director) + '</span>');
    if (vod && vod.actor) out.push('<span class="tv-tag">主演 ' + esc(vod.actor.slice(0, 30)) + '</span>');
    return out.join('');
  }

  function bindCands(g) {
    var box = $('[data-tv-cands]');
    if (!box) return;
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-cand]');
      if (!b) return;
      state.candIdx = Number(b.dataset.cand);
      state.lineIdx = 0;
      state.epIdx = -1;
      renderCands(g);
      loadDetailFor(g, g.candidates[state.candIdx]);
    });
  }

  function renderCands(g, results) {
    var box = $('[data-tv-cands]');
    if (!box) return;
    box.innerHTML = g.candidates.map(function (c, i) {
      var p = results ? results[i] : state.probe[c.sourceId + ':' + c.vodId];
      var label = qualLabel(p);
      var speed = p && p.ok && p.ms ? p.ms + 'ms' : '';
      return (
        '<button type="button" class="tv-cand' + (i === state.candIdx ? ' is-on' : '') + '" data-cand="' + i + '">' +
        '<span class="tv-cand__n">' + esc(c.sourceName) +
        (label ? '<span class="tv-qbadge' + qualBadgeClass(p) + '">' + label + '</span>' : '') +
        '</span>' +
        '<span class="tv-cand__m">' + c.episodeCount + ' 集 · ' + c.lineCount + ' 线路' +
        (c.hasHls ? ' · 可直连' : ' · 仅网页') +
        (speed ? ' · ' + speed : '') +
        '</span></button>'
      );
    }).join('');
  }

  function loadDetailFor(g, cand, isAuto) {
    if (!cand) return;
    var extra = $('[data-tv-extra]');
    if (extra && !isAuto) extra.innerHTML = '<div class="tv-loading">正在读取剧集…</div>';

    getJson(BASE + '/detail?s=' + encodeURIComponent(cand.sourceId) + '&id=' + encodeURIComponent(cand.vodId))
      .then(function (vod) {
        state.detail.vod = vod;
        var desc = $('.tv-detail__desc');
        if (desc) desc.textContent = vod.content || '暂无简介';
        var tags = $('.tv-detail__tags');
        if (tags) tags.innerHTML = tagsHtml(g, vod);
        renderEps(vod);
      })
      .catch(function (e) {
        var ex = $('[data-tv-extra]');
        if (ex) ex.innerHTML = '<div class="tv-loading">读取失败：' + esc(e.message) + '<br>可点上面别的源重试</div>';
      });
  }

  function renderEps(vod) {
    var ex = $('[data-tv-extra]');
    if (!ex) return;

    if (!vod.lines || !vod.lines.length) {
      ex.innerHTML = '<div class="tv-loading">这个源没有可用播放地址，换一个源试试</div>';
      return;
    }

    state.lineIdx = Math.min(state.lineIdx, vod.lines.length - 1);
    var line = vod.lines[state.lineIdx];
    state.eps = line.episodes;

    // 该片在这个源上的播放进度（用于「继续观看第 X 集」提示）
    var last = lastProgressOf(vod.name);

    var linesHtml = vod.lines.map(function (l, i) {
      var page = l.kind === 'page';
      return (
        '<button type="button" class="tv-line' + (page ? ' tv-line--page' : '') +
        (i === state.lineIdx ? ' is-on' : '') + '" data-line="' + i + '" ' +
        'title="' + (page ? '网页播放器地址，无法直连' : '可直接播放') + '">' +
        esc(l.from) + ' <span class="tv-line__warn">' + l.episodes.length + '</span>' + (page ? ' ⚠' : '') +
        '</button>'
      );
    }).join('');

    var epsHtml = line.episodes.map(function (ep, i) {
      var pr = findProgress(vod.name, ep.name);
      var mark = pr && pr.t > 5 ? '<i class="tv-ep__dot"></i>' : '';
      return (
        '<button type="button" class="tv-ep' + (i === state.epIdx ? ' is-on' : '') + '" data-ep="' + i +
        '" title="' + esc(ep.name) + '">' + esc(ep.name) + mark + '</button>'
      );
    }).join('');

    var tip = line.kind === 'page'
      ? '<p class="tv-tip">这条线路是资源站的网页播放器地址，浏览器拿不到直链。请选带 m3u8 的线路，或换一个源。</p>'
      : '';

    var resumeBar = last && last.t > 5
      ? '<div class="tv-resume"><span>上次看到「' + esc(last.epName) + '」' +
        (last.d > 0 ? '（' + Math.round((last.t / last.d) * 100) + '%）' : '') + '</span>' +
        '<button type="button" class="tv-resume__go" data-tv-resume="1">继续播放</button></div>'
      : '';

    ex.innerHTML =
      resumeBar +
      '<div class="tv-lines">' + linesHtml + '</div>' + tip +
      '<h3 class="tv-detail__h">剧集 · ' + esc(line.from) + '</h3>' +
      '<div class="tv-eps">' + epsHtml + '</div>';

    ex.onclick = function (e) {
      var lb = e.target.closest('[data-line]');
      if (lb) {
        state.lineIdx = Number(lb.dataset.line);
        state.epIdx = -1;
        renderEps(vod);
        return;
      }
      var eb = e.target.closest('[data-ep]');
      if (eb) { playEp(vod, Number(eb.dataset.ep)); return; }
      if (e.target.closest('[data-tv-resume]')) {
        // 继续播放：切到上次那条线路，找同名剧集
        var lr = last.lineIdx >= 0 ? last.lineIdx : state.lineIdx;
        if (lr < vod.lines.length) {
          state.lineIdx = lr;
          renderEps(vod);
          var idx = vod.lines[lr].episodes.findIndex(function (x) { return x.name === last.epName; });
          playEp(vod, idx >= 0 ? idx : 0);
        }
      }
    };
  }

  /* ══════════════ 播放器 ══════════════ */

  var TRIES = ['direct', 'hlsProxy', 'fullProxy'];
  var TRY_LABEL = {
    direct: '直连',
    hlsProxy: '改为经本站取播放列表',
    fullProxy: '改为连分片也走本站代理',
  };

  function bindPlayer() {
    $('[data-tv-pclose]').addEventListener('click', closePlayer);
    $('[data-tv-pprev]').addEventListener('click', function () {
      if (state.epIdx > 0) playEp(state.detail.vod, state.epIdx - 1);
    });
    $('[data-tv-pnext]').addEventListener('click', function () {
      if (state.detail && state.detail.vod && state.epIdx < state.eps.length - 1) {
        playEp(state.detail.vod, state.epIdx + 1);
      }
    });
    $('[data-tv-mask]').addEventListener('click', closeDetail);
    $('[data-tv-dclose]').addEventListener('click', closeDetail);

    // 倍速按钮：点按轮换常驻倍速
    var speedBtn = $('[data-tv-speedbtn]');
    if (speedBtn) speedBtn.addEventListener('click', cycleRate);

    /* 长按右箭头 = 临时 HOLD_RATE 快放，松手回到常驻倍速。
       **必须 preventDefault**：浏览器对 ArrowRight 的原生行为是「快进 5 秒」，
       不拦的话按住会变成一路跳着走，而不是快放。 */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight') return;
      var ov = $('[data-tv-player]');
      if (!ov || ov.hidden) return;
      var t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) return;
      e.preventDefault();
      if (state.holdingBoost) return; // 忽略键盘自动重复
      state.holdingBoost = true;
      applyRate(HOLD_RATE);
      toast('长按快放 ' + HOLD_RATE + '×，松手恢复');
    });
    document.addEventListener('keyup', function (e) {
      if (e.key !== 'ArrowRight' || !state.holdingBoost) return;
      state.holdingBoost = false;
      applyRate(state.baseRate);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('[data-tv-player]').hidden) { closePlayer(); return; }
      if (!$('[data-tv-drawer]').hidden) closeDetail();
    });

    // 进度落盘：每 5 秒 + 暂停/结束时
    var v = $('[data-tv-video]');
    setInterval(function () {
      if (!v || v.paused || !v.duration || !state.cur) return;
      persistProgress();
    }, 5000);
    v.addEventListener('pause', persistProgress);
    v.addEventListener('ended', persistProgress);
  }

  /** 设置播放倍速并同步按钮文案 */
  function applyRate(r) {
    var v = $('[data-tv-video]');
    var btn = $('[data-tv-speedbtn]');
    var wrap = $('[data-tv-speed]');
    if (v) { try { v.playbackRate = r; } catch (e) { /* 某些容器不允许 */ } }
    if (btn) btn.textContent = (Math.round(r * 10) / 10) + '×';
    if (wrap) wrap.classList.toggle('is-boost', r > state.baseRate + 0.01);
  }

  /** 点按轮换常驻倍速：1× → 1.5× → 2× → 3× */
  function cycleRate() {
    var i = RATES.indexOf(state.baseRate);
    state.baseRate = RATES[(i + 1) % RATES.length];
    applyRate(state.baseRate);
    toast('倍速 ' + state.baseRate + '×');
  }

  function persistProgress() {
    var v = $('[data-tv-video]');
    var c = state.cur;
    if (!v || !c || !v.duration || !isFinite(v.duration)) return;
    var rec = {
      name: c.name,
      epName: c.epName,
      t: Math.round(v.currentTime),
      d: Math.round(v.duration),
      ts: Date.now(),
      srcId: c.srcId,
      vodId: c.vodId,
      srcName: c.srcName,
      lineIdx: state.lineIdx,
      lineFrom: c.lineFrom,
    };
    saveProgress(rec);
    if (authState.loggedIn) {
      fetch(BASE + '/hist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ prog: rec }),
      }).catch(function () {});
    }
  }

  /* ══════════════ 云端记录（登录用户） ══════════════ */

  var authState = { loggedIn: false };

  /**
   * 拉云端记录并与本地合并。**本地不被覆盖丢数据**：
   * 搜索历史按关键词去重、按时间排序取前 N；播放进度按 ts 取较新的那条。
   * 未登录（401）时什么都不做 —— 匿名照旧用 localStorage。
   */
  function syncHistory() {
    return fetch(BASE + '/hist', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) return null;
        return r.json();
      })
      .then(function (d) {
        if (!d || !d.ok) return;
        authState.loggedIn = true;

        // 搜索历史
        var seen = {};
        var merged = [];
        (d.q || []).map(function (x) { return { q: x.q, t: Number(x.ts) || 0 }; })
          .concat(getQueryHistory())
          .forEach(function (x) {
            if (!x.q || seen[x.q]) return;
            seen[x.q] = 1;
            merged.push(x);
          });
        merged.sort(function (a, b) { return b.t - a.t; });
        writeLS(LS.q, merged.slice(0, MAX_Q_HIST));
        renderQueryHistory();

        // 播放进度
        var all = getProgress();
        (d.prog || []).forEach(function (r) {
          var cur = all[r.k];
          var ts = Number(r.ts) || 0;
          if (!cur || ts > (cur.ts || 0)) {
            all[r.k] = {
              name: r.name,
              epName: r.ep_name,
              t: Number(r.t) || 0,
              d: Number(r.d) || 0,
              ts: ts,
              srcId: r.src_id,
              vodId: r.vod_id,
              srcName: r.src_name,
              lineIdx: Number(r.line_idx) || 0,
              lineFrom: r.line_from,
            };
          }
        });
        writeLS(LS.prog, all);
        renderContinue();
      })
      .catch(function () { /* 离线就只用本地 */ });
  }

  function playerMsg(html) {
    var el = $('[data-tv-pmsg]');
    if (!html) { el.hidden = true; el.innerHTML = ''; return; }
    el.innerHTML = html;
    el.hidden = false;
  }

  function teardownVideo() {
    var v = $('[data-tv-video]');
    if (state.hls) { try { state.hls.destroy(); } catch (e) { /* ignore */ } state.hls = null; }
    v.pause();
    v.removeAttribute('src');
    v.load();
    var q = $('[data-tv-quality]');
    if (q) q.innerHTML = '';
  }

  function closePlayer() {
    persistProgress();
    $('[data-tv-player]').hidden = true;
    teardownVideo();
  }

  function playlistUrl(epUrl, api, useProxy) {
    return (
      BASE + '/hls?u=' + encodeURIComponent(epUrl) +
      '&ref=' + encodeURIComponent(originOf(api)) +
      (useProxy ? '&proxy=1' : '')
    );
  }

  function playEp(vod, idx) {
    var g = state.groups[state.detail.gi];
    var c = g.candidates[state.candIdx];
    var src = srcById(c.sourceId);
    var line = vod.lines[state.lineIdx];
    var ep = line.episodes[idx];
    if (!ep) return;

    var ov = $('[data-tv-player]');
    ov.hidden = false;
    state.epIdx = idx;
    state.tryIdx = 0;
    state.cur = {
      name: vod.name,
      epName: ep.name,
      srcId: c.sourceId,
      srcName: c.sourceName,
      vodId: c.vodId,
      lineFrom: line.from,
    };

    $('[data-tv-ptitle]').textContent = (vod.name || g.name) + ' · ' + ep.name;
    $('[data-tv-pline]').textContent = c.sourceName + ' / ' + line.from;

    var strip = $('[data-tv-peps]');
    strip.innerHTML = '';
    line.episodes.forEach(function (e2, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tv-ep' + (i === idx ? ' is-on' : '');
      b.textContent = e2.name;
      b.title = e2.name;
      b.addEventListener('click', function () { playEp(vod, i); });
      strip.appendChild(b);
    });
    var onBtn = strip.querySelector('.is-on');
    if (onBtn && onBtn.scrollIntoView) onBtn.scrollIntoView({ inline: 'center', block: 'nearest' });

    $$('[data-tv-extra] .tv-ep').forEach(function (b, i) {
      b.classList.toggle('is-on', i === idx);
    });

    if (line.kind === 'page') {
      playerMsg('<b>这条线路无法直连</b><br>「' + esc(line.from) +
        '」是资源站的网页播放器地址。<br><code>请换一条带 m3u8 的线路，或换一个源。</code>');
      teardownVideo();
      return;
    }
    if (!/^https?:\/\//i.test(ep.url)) {
      playerMsg('<b>这不是直链播放地址</b><br>换一条线路或换一个源试试。');
      teardownVideo();
      return;
    }

    startPlayback(ep.url, src ? src.api : '');
  }

  function startPlayback(epUrl, api) {
    teardownVideo();
    state.pendingPlay = { epUrl: epUrl, api: api };
    // 换集/换源后倍速回到常驻档（而不是沿用上一次长按的临时快放）
    state.holdingBoost = false;
    tryPlayback(0);
    applyRate(state.baseRate);
  }

  function tryPlayback(i) {
    var p = state.pendingPlay;
    if (!p) return;
    if (i >= TRIES.length) {
      playerMsg('<b>三种方式都播不了</b><br><code>建议换一条线路，或换一个源。</code>');
      return;
    }
    state.tryIdx = i;
    var mode = TRIES[i];
    var v = $('[data-tv-video]');
    var isHls = /\.m3u8(\?|#|$)/i.test(p.epUrl);

    if (isHls && window.Hls && window.Hls.isSupported()) {
      attachHls(mode, v);
      return;
    }
    v.src = mode === 'direct' ? p.epUrl
      : BASE + '/seg?u=' + encodeURIComponent(p.epUrl) + '&ref=' + encodeURIComponent(originOf(p.api));
    playerMsg(mode === 'direct' ? null : TRY_LABEL[mode] + '…');
    v.onerror = function () { tryPlayback(i + 1); };
    v.play().catch(function () {});
  }

  function attachHls(mode, video) {
    var p = state.pendingPlay;
    if (!p) return;
    if (state.hls) { try { state.hls.destroy(); } catch (e) { /* ignore */ } }

    var hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 30,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 2,
      fragLoadingMaxRetry: 4,
    });
    state.hls = hls;

    hls.on(window.Hls.Events.MANIFEST_PARSED, function (_e, data) {
      playerMsg(null);
      renderQualityPicker(hls, data && data.levels);
      resumeIfAny(video);
      video.play().catch(function () {});
    });

    hls.on(window.Hls.Events.LEVEL_SWITCHED, function () {
      highlightQuality(hls);
    });

    hls.on(window.Hls.Events.ERROR, function (_evt, data) {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        playerMsg('解码失败，正在尝试恢复…');
        try { hls.recoverMediaError(); } catch (e) { tryPlayback(state.tryIdx + 1); }
        return;
      }
      var next = state.tryIdx + 1;
      if (next < TRIES.length) {
        playerMsg('播放失败，' + TRY_LABEL[TRIES[next]] + '…');
        try { hls.destroy(); } catch (e) { /* ignore */ }
        state.hls = null;
        tryPlayback(next);
        return;
      }
      playerMsg('<b>播放失败</b><br><code>' + esc(data.details || '') + '</code>');
    });

    hls.loadSource(mode === 'direct' ? p.epUrl : playlistUrl(p.epUrl, p.api, mode === 'fullProxy'));
    hls.attachMedia(video);
  }

  /** 播放器里的清晰度切换（hls.js 的 levels） */
  function renderQualityPicker(hls, levels) {
    var box = $('[data-tv-quality]');
    if (!box) return;
    box.innerHTML = '';
    if (!levels || levels.length < 2) { box.hidden = true; return; }
    box.hidden = false;

    var auto = document.createElement('button');
    auto.type = 'button';
    auto.className = 'tv-qbtn is-on';
    auto.textContent = '自动';
    auto.dataset.level = '-1';
    auto.addEventListener('click', function () {
      hls.currentLevel = -1;
      highlightQuality(hls);
    });
    box.appendChild(auto);

    // 高 → 低
    levels.slice().sort(function (a, b) { return (b.height || 0) - (a.height || 0); }).forEach(function (lv, i) {
      var real = levels.indexOf(lv);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tv-qbtn';
      b.textContent = lv.height ? lv.height + 'P' : (Math.round(lv.bitrate / 1000) + 'k');
      b.title = (lv.height || '?') + 'P · ' + Math.round(lv.bitrate / 1000) + ' kbps';
      b.dataset.level = String(real);
      b.addEventListener('click', function () {
        hls.currentLevel = real;
        highlightQuality(hls);
      });
      box.appendChild(b);
      void i;
    });
  }

  function highlightQuality(hls) {
    var box = $('[data-tv-quality]');
    if (!box) return;
    var cur = hls.currentLevel;
    $$('.tv-qbtn', box).forEach(function (b) {
      b.classList.toggle('is-on', Number(b.dataset.level) === cur);
    });
  }

  /** 有进度记录就自动续播（同一集），并提示 */
  function resumeIfAny(video) {
    var c = state.cur;
    if (!c) return;
    var pr = findProgress(c.name, c.epName);
    if (!pr || !pr.t || pr.t < 5) return;
    var onLoaded = function () {
      if (!video.duration || !isFinite(video.duration)) return;
      // 已经快看完了就别续了，从头更合理
      if (pr.t > video.duration - 15) return;
      try { video.currentTime = pr.t; } catch (e) { return; }
      toast('已从 ' + fmtTime(pr.t) + ' 继续播放');
      video.removeEventListener('loadedmetadata', onLoaded);
    };
    if (video.readyState >= 1) onLoaded();
    else video.addEventListener('loadedmetadata', onLoaded);
  }

  function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    var m = Math.floor(s / 60);
    var ss = s % 60;
    return (m > 0 ? m + ' 分 ' : '') + ss + ' 秒';
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('[data-tv-toast]');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(function () { el.classList.add('is-on'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('is-on');
      setTimeout(function () { el.hidden = true; }, 250);
    }, 2400);
  }

  /* ══════════════ 直播 ══════════════ */

  var liveLoaded = false;

  function loadLive() {
    if (liveLoaded) return;
    liveLoaded = true;
    var box = $('[data-tv-livebody]');
    var status = $('[data-tv-livestatus]');
    status.textContent = '正在拉取直播源…';
    box.innerHTML = '';

    getJson(BASE + '/live')
      .then(function (d) {
        var ok = (d.playlists || []).filter(function (p) { return p.ok && p.channels.length; });
        if (!ok.length) { status.textContent = '没有可用的直播源'; return; }
        var total = ok.reduce(function (n, p) { return n + p.channels.length; }, 0);
        status.textContent = ok.length + ' 个源 · ' + total + ' 个频道';
        state.live = ok;
        renderLive('');
      })
      .catch(function (e) { status.textContent = '拉取失败：' + e.message; });
  }

  function renderLive(q) {
    var box = $('[data-tv-livebody]');
    if (!box) return;
    box.innerHTML = '';
    var key = (q || '').toLowerCase();
    var shown = 0;

    state.live.forEach(function (p) {
      var groups = {};
      p.channels.forEach(function (ch) {
        if (key && (ch.name || '').toLowerCase().indexOf(key) < 0 &&
            (ch.group || '').toLowerCase().indexOf(key) < 0) return;
        var g = ch.group || '未分组';
        (groups[g] = groups[g] || []).push(ch);
      });

      Object.keys(groups).forEach(function (gname) {
        var chs = groups[gname];
        var sec = document.createElement('div');
        sec.className = 'tv-livegroup';
        var h = document.createElement('h4');
        h.className = 'tv-livegroup__h';
        h.textContent = p.name + ' · ' + gname + '（' + chs.length + '）';
        sec.appendChild(h);
        var list = document.createElement('div');
        list.className = 'tv-chlist';
        sec.appendChild(list);

        function addRange(from, to) {
          chs.slice(from, to).forEach(function (ch) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'tv-ch';
            b.innerHTML = (ch.logo ? '<img class="tv-ch__logo" src="' + esc(ch.logo) + '" alt="" loading="lazy">' : '') +
              '<span class="tv-ch__n">' + esc(ch.name) + '</span>';
            b.addEventListener('click', function () { playLive(ch); });
            list.appendChild(b);
            shown++;
          });
        }

        var PAGE = 96;
        addRange(0, Math.min(PAGE, chs.length));
        if (chs.length > PAGE) {
          var more = document.createElement('button');
          more.type = 'button';
          more.className = 'tv-ch tv-ch--more';
          more.textContent = '展开其余 ' + (chs.length - PAGE) + ' 个';
          more.addEventListener('click', function () { addRange(PAGE, chs.length); more.remove(); });
          list.appendChild(more);
        }
        box.appendChild(sec);
      });
    });

    if (!shown) {
      box.innerHTML = '<div class="tv-empty"><span class="tv-empty__big">📺</span><div class="tv-empty__msg">没有匹配的频道</div></div>';
    }
  }

  function playLive(ch) {
    var ov = $('[data-tv-player]');
    ov.hidden = false;
    state.eps = [];
    state.cur = null;
    $('[data-tv-ptitle]').textContent = ch.name;
    $('[data-tv-pline]').textContent = '直播';
    $('[data-tv-peps]').innerHTML = '';
    var q = $('[data-tv-quality]');
    if (q) { q.innerHTML = ''; q.hidden = true; }

    var v = $('[data-tv-video]');
    teardownVideo();
    playerMsg('正在连接直播流…');

    var attempts = [ch.url, playlistUrl(ch.url, '', true)];
    var i = 0;
    function tryLive() {
      if (i >= attempts.length) { playerMsg('<b>直播流不可用</b><br>换一个频道试试。'); return; }
      var url = attempts[i];
      if (i > 0) playerMsg('直连失败，正在改走本站代理…');
      if (window.Hls && window.Hls.isSupported()) {
        if (state.hls) { try { state.hls.destroy(); } catch (e) { /* ignore */ } }
        var hls = new window.Hls({ enableWorker: true, liveSyncDurationCount: 3, manifestLoadingTimeOut: 20000, fragLoadingMaxRetry: 6 });
        state.hls = hls;
        hls.on(window.Hls.Events.MANIFEST_PARSED, function () { playerMsg(null); v.play().catch(function () {}); });
        hls.on(window.Hls.Events.ERROR, function (_e, data) {
          if (!data.fatal) return;
          try { hls.destroy(); } catch (e) { /* ignore */ }
          state.hls = null;
          i++;
          tryLive();
        });
        hls.loadSource(url);
        hls.attachMedia(v);
      } else {
        v.src = url;
        v.onerror = function () { i++; tryLive(); };
        v.play().catch(function () {});
      }
    }
    tryLive();
  }

  /* ══════════════ 源列表 ══════════════ */

  function renderSrcList() {
    var ul = $('[data-tv-srclist]');
    if (!ul) return;
    ul.innerHTML = '';
    state.sources.forEach(function (s) {
      var li = document.createElement('li');
      li.className = 'tv-srcitem';
      var on = !state.off.has(s.id);
      li.innerHTML =
        '<button type="button" class="tv-srcitem__box' + (on ? ' is-on' : '') + '" aria-label="启用/停用"></button>' +
        '<div class="tv-srcitem__main">' +
        '<div class="tv-srcitem__n">' + esc(s.name) + '</div>' +
        '<div class="tv-srcitem__url">' + esc(s.api) + '</div>' +
        '</div>' +
        '<div class="tv-srcitem__note">' + esc(s.note || '') + '</div>';
      li.querySelector('.tv-srcitem__box').addEventListener('click', function (e) {
        if (state.off.has(s.id)) state.off.delete(s.id); else state.off.add(s.id);
        saveOff();
        e.currentTarget.classList.toggle('is-on', !state.off.has(s.id));
        renderSrcBar();
        updateCount();
      });
      ul.appendChild(li);
    });
  }

  var liveSearchBound = false;
  function bindLiveSearch() {
    var el = $('[data-tv-liveq]');
    if (!el || liveSearchBound) return;
    liveSearchBound = true;
    var timer = null;
    el.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { renderLive(el.value.trim()); }, 180);
    });
  }

  /* ══════════════ 入口 ══════════════ */

  function boot() {
    init();
    bindLiveSearch();
  }

  document.addEventListener('astro:page-load', boot);
  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
