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
  /**
   * localStorage 键。**记录类（q / prog / fav）必须按用户分开** —— R52 之前它们是
   * 全浏览器共用的，同一台电脑上换个人登录就会看到上一个人的搜索词、看到第几分钟，
   * 这就是站主报的「多用户共享搜索记录和观看记录」。偏好类（off / sort / qmode）
   * 是设备偏好，不按人分。
   */
  var LS = {
    off: 'tv:off',        // 访客关掉的源（设备偏好）
    q: 'tv:q',            // 搜索历史（按用户）
    prog: 'tv:prog',      // 播放进度 / 历史（按用户）
    fav: 'tv:fav',        // 追剧收藏（按用户）
    qual: 'tv:qual',      // 清晰度探测缓存（设备级，与谁登录无关）
    sort: 'tv:sort',      // 结果排序偏好（设备偏好）
    qmode: 'tv:qmode',    // 画质偏好：quality = 锁最高码率 / auto = 自适应
    boost: 'tv:boost',    // 长按加速的倍速档
    enh: 'tv:enh',        // 观感增强开关
  };
  /** 这三个键按用户分域；其余是设备偏好 */
  var SCOPED = { q: 1, prog: 1, fav: 1 };
  /** 当前登录用户 id；匿名时为空串。init() 里问 /api/site/me 拿到 */
  var SCOPE = '';
  function lsKey(k) { return SCOPED[k] ? k + (SCOPE ? ':' + SCOPE : '') : k; }
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
    holdingBoost: false,  // 是否处于「长按加速」的临时快放
    boostHeld: false,     // 加速键是否正被按住（按钮与键盘共用）
    fav: {},              // 追剧收藏：{ [片名]: rec }
    showAllCands: false,  // 详情页是否摊开全部源（默认只留测出来的最优那条）
    showAllLines: false,  // 是否显示「无法直连」的线路（默认藏起来）
    qmode: 'quality',     // quality = 锁最高码率；auto = 交给 hls.js 自适应
    enhance: true,        // 观感增强（轻微锐化观感，不改变实际分辨率）
    pendingLine: '',      // 从记录直接打开时要定位到的线路名
    pendingEp: '',        // 从记录直接打开时要定位到的集名
    pendingSeek: 0,       // 从记录直接打开时要跳到的秒数
  };

  var SORTS = [
    { id: 'rel', label: '推荐' },
    { id: 'rating', label: '评分' },
    { id: 'srcs', label: '源最多' },
    { id: 'name', label: '名称' },
  ];
  var RATES = [1, 1.5, 2, 3];
  /** 长按加速的倍速。默认 3×，可在播放器里改（存 localStorage） */
  var HOLD_RATE = 3;

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
      var raw = localStorage.getItem(lsKey(key));
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeLS(key, val) {
    try { localStorage.setItem(lsKey(key), JSON.stringify(val)); } catch (e) { /* 隐私模式忽略 */ }
  }
  function readRaw(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeRaw(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
  }
  function dropRaw(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(LS.off);
      state.off = new Set(raw ? JSON.parse(raw) : []);
    } catch (e) { state.off = new Set(); }
    var s = readLS(LS.sort, 'rel');
    state.sort = SORTS.some(function (x) { return x.id === s; }) ? s : 'rel';
    state.qmode = readLS(LS.qmode, 'quality') === 'auto' ? 'auto' : 'quality';
    state.enhance = readLS(LS.enh, true) !== false;
    var hr = Number(readLS(LS.boost, 3));
    HOLD_RATE = [2, 3, 4].indexOf(hr) >= 0 ? hr : 3;
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

  /* ══════════════ 追剧收藏（R52） ══════════════ */

  /** 收藏表：{ [片名]: {name,pic,srcId,vodId,srcName,lineIdx,lineFrom,epName,t,d,ts} } */
  function getFav() { return readLS(LS.fav, {}); }
  function setFav(all) { state.fav = all; writeLS(LS.fav, all); }
  function isFav(name) { return !!(state.fav && state.fav[name]); }

  /** 收藏 / 取消收藏。写本地一份，登录用户同时上云（失败不影响本地） */
  function toggleFav(rec) {
    var all = getFav();
    var name = rec.name;
    if (!name) return;
    if (all[name]) {
      delete all[name];
      toast('已取消追剧：' + name);
      if (authState.loggedIn) {
        fetch(BASE + '/hist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ unfav: { name: name } }),
        }).catch(function () {});
      }
    } else {
      all[name] = Object.assign({ ts: Date.now() }, rec);
      toast('已加入追剧：' + name);
      pushFav(all[name]);
    }
    setFav(all);
    renderContinue();
    paintFavButtons();
    if (state.detail && state.groups[state.detail.gi]) renderDetailFav();
  }

  function pushFav(rec) {
    if (!authState.loggedIn) return;
    fetch(BASE + '/hist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ fav: rec }),
    }).catch(function () {});
  }

  /** 卡片上的星标状态跟着 state.fav 重画（不重建 DOM，省得打断 hover） */
  function paintFavButtons() {
    $('[data-fav]').forEach(function (b) {
      var n = b.getAttribute('data-fav');
      var on = isFav(n);
      b.classList.toggle('is-on', on);
      b.textContent = on ? '★' : '☆';
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? '取消追剧' : '加入追剧';
    });
  }

  /**
   * 从记录直接打开（R52）。**不再搜一次** —— 这是站主点名要的那条：
   * 记录里已经存了 srcId + vodId + lineFrom + epName，直接问 detail 接口拿剧集，
   * 拼一个只有一个候选的分组塞进 state.groups，走正常的详情/播放路径。
   * 只有 detail 失败（源挂了、片下架了）才退回搜索，那是退路不是主路。
   */
  function openByRecord(rec) {
    if (!rec || !rec.name) return;
    if (!rec.srcId || !rec.vodId) { doSearch(rec.name); return; }

    var g0 = {
      name: rec.name,
      pic: rec.pic || '',
      rating: 0,
      score: 1000,
      candidates: [{
        sourceId: rec.srcId,
        sourceName: rec.srcName || ((srcById(rec.srcId) || {}).name || rec.srcId),
        vodId: rec.vodId,
        episodeCount: 0,
        lineCount: 0,
        hasHls: true,
        pic: rec.pic || '',
      }],
    };

    setStatus('正在打开「' + esc(rec.name) + '」上次的位置…');
    state.pendingLine = rec.lineFrom || '';
    state.pendingEp = rec.epName || '';
    state.groups = [g0];
    state.lastQ = rec.name;
    state.detail = { gi: 0 };
    state.candIdx = 0;
    state.lineIdx = Number(rec.lineIdx) || 0;
    state.epIdx = -1;
    state.autoPicked = true;   // 单候选，不要再探测换源
    state.showAllCands = false;
    state.showAllLines = false;
    $('[data-tv-mask]').hidden = false;
    $('[data-tv-drawer]').hidden = false;
    renderDetail();
    setStatus('已从记录打开，正在定位上次那一集');
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

    /* 先问「我是谁」。记录按用户分域（见 LS 那段注释），所以必须先拿到 id
       再读本地记录 —— 顺序反了就会先读一遍匿名键、再被覆盖一次。 */
    fetch('/api/site/me', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && d.user && d.user.id) {
          SCOPE = String(d.user.id);
          adoptLegacy();
        }
      })
      .catch(function () { /* 没登录 / 接口挂了：按匿名处理 */ })
      .then(loadSources);
  }

  /** 登录后把「全浏览器共享的旧键」迁进自己的命名空间，然后删掉旧键 ——
      不删的话换个人登录还是能看到上一个人的搜索词与进度。 */
  function adoptLegacy() {
    if (!SCOPE) return;
    ['q', 'prog', 'fav'].forEach(function (k) {
      var legacy = readRaw(LS[k]);
      if (legacy == null) return;
      if (readRaw(lsKey(k)) == null) {
        try { localStorage.setItem(lsKey(k), legacy); } catch (e) { /* 隐私模式 */ }
      }
      dropRaw(LS[k]);
    });
  }

  function loadSources() {
    state.fav = getFav();
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

  /**
   * 追剧 + 继续观看。
   *
   * 两块都挂在 `[data-tv-cont]` 里（追剧在上），**点一下就直接打开上次那一集** ——
   * 走 openByRecord()，不再先搜一次（R52 站主点名要的）。
   * 之前这里是「填关键词 → doSearch → 找同名分组」，等于每次续播都重新搜全网，
   * 既慢又会因为源站抖动而找不到。
   */
  function renderContinue() {
    var box = $('[data-tv-cont]');
    if (!box) return;
    box.innerHTML = '';

    var favAll = getFav();
    var favs = Object.keys(favAll)
      .map(function (k) { return favAll[k]; })
      .filter(function (r) { return r && r.name; })
      .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); })
      .slice(0, 12);

    var all = getProgress();
    var items = Object.keys(all)
      .map(function (k) { return all[k]; })
      .filter(function (r) { return r && r.name && (r.t || 0) > 5; })
      .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); })
      .slice(0, 8);

    if (!favs.length && !items.length) { box.hidden = true; return; }
    box.hidden = false;

    if (favs.length) box.appendChild(contSection('我的追剧', favs, true));
    if (items.length) box.appendChild(contSection('继续观看', items, false));
  }

  function contSection(title, rows, canUnfav) {
    var wrap = document.createElement('div');
    wrap.className = 'tv-cont__sec';

    var h = document.createElement('div');
    h.className = 'tv-cont__h';
    h.textContent = title;
    wrap.appendChild(h);

    var list = document.createElement('div');
    list.className = 'tv-cont__list';
    rows.forEach(function (r) {
      var pct = r.d > 0 ? Math.min(100, Math.round((r.t / r.d) * 100)) : 0;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tv-cont__item';
      b.title = r.epName ? '接着看：' + r.epName : '打开';
      b.innerHTML =
        '<span class="tv-cont__name">' + esc(r.name) + '</span>' +
        '<span class="tv-cont__ep">' + esc(r.epName || '还没开始') +
        (pct ? ' · 已看 ' + pct + '%' : '') + '</span>';
      b.addEventListener('click', function () { openByRecord(r); });

      /* 条目与「取消追剧」包一层：两个 <button> 不能嵌套，而它们又要看起来是一行 */
      var row = document.createElement('div');
      row.className = 'tv-cont__row';
      row.appendChild(b);

      if (canUnfav) {
        var x = document.createElement('button');
        x.type = 'button';
        x.className = 'tv-cont__x';
        x.textContent = '✕';
        x.title = '不再追这部剧';
        x.setAttribute('aria-label', '取消追剧 ' + r.name);
        x.addEventListener('click', function (e) {
          e.stopPropagation();
          toggleFav({ name: r.name });
        });
        row.appendChild(x);
      }
      list.appendChild(row);
    });
    wrap.appendChild(list);
    return wrap;
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

      /* 卡片右下角的星标：不进卡片点击区域（stopPropagation），点它就只收藏不打开 */
      var star = document.createElement('button');
      star.type = 'button';
      star.className = 'tv-fav tv-fav--card' + (isFav(g.name) ? ' is-on' : '');
      star.setAttribute('data-fav', g.name);
      star.setAttribute('aria-pressed', String(isFav(g.name)));
      star.textContent = isFav(g.name) ? '★' : '☆';
      star.title = isFav(g.name) ? '取消追剧' : '加入追剧';
      star.addEventListener('click', function (e) {
        e.stopPropagation();
        var pr = lastProgressOf(g.name);
        var c0 = g.candidates.filter(function (c) { return c.hasHls; })[0] || g.candidates[0] || {};
        toggleFav({
          name: g.name,
          pic: g.pic || '',
          srcId: (pr && pr.srcId) || c0.sourceId || '',
          vodId: (pr && pr.vodId) || c0.vodId || '',
          srcName: (pr && pr.srcName) || c0.sourceName || '',
          lineIdx: pr ? pr.lineIdx : 0,
          lineFrom: pr ? pr.lineFrom : '',
          epName: pr ? pr.epName : '',
          t: pr ? pr.t : 0,
          d: pr ? pr.d : 0,
        });
      });
      /* 挂进海报里（海报是 position: relative，星标要贴着它的角） */
      var poster = card.querySelector('.tv-card__poster');
      if (poster) poster.appendChild(star);

      card.addEventListener('click', function () { openDetail(i); });
      grid.appendChild(card);
    });
    paintFavButtons();
  }

  /* ══════════════ 详情 ══════════════ */

  function openDetail(groupIdx) {
    state.detail = { gi: groupIdx };
    state.candIdx = 0;
    state.lineIdx = 0;
    state.epIdx = -1;
    state.autoPicked = false;
    /* 每次打开都从「只显示最优源 + 只显示能播的线路」开始。
       上一次摊开过不该带到下一部片上。 */
    state.showAllCands = false;
    state.showAllLines = false;
    state.pendingLine = '';
    state.pendingEp = '';
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
      '<button type="button" class="tv-fav' + (isFav(g.name) ? ' is-on' : '') + '" data-detail-fav>' +
      (isFav(g.name) ? '★ 追剧中' : '☆ 追剧') + '</button>' +
      '<div class="tv-detail__desc">暂无简介</div>' +
      '</div></div>' +
      '<div class="tv-detail__sec">' +
      '<h3 class="tv-detail__h">来源线路（' + g.candidates.length + ' 个源）' +
      '<span class="tv-detail__probe" data-tv-probe>正在测清晰度…</span></h3>' +
      '<div class="tv-cands" data-tv-cands></div>' +
      '<div data-tv-extra><div class="tv-loading">正在读取剧集…</div></div>' +
      '</div>';

    bindCands(g);
    var favBtn = $('[data-detail-fav]');
    if (favBtn) {
      favBtn.addEventListener('click', function () {
        var pr = lastProgressOf(g.name);
        var c0 = g.candidates[state.candIdx] || g.candidates[0] || {};
        toggleFav({
          name: g.name,
          pic: g.pic || '',
          srcId: (pr && pr.srcId) || c0.sourceId || '',
          vodId: (pr && pr.vodId) || c0.vodId || '',
          srcName: (pr && pr.srcName) || c0.sourceName || '',
          lineIdx: pr ? pr.lineIdx : 0,
          lineFrom: pr ? pr.lineFrom : '',
          epName: pr ? pr.epName : '',
          t: pr ? pr.t : 0,
          d: pr ? pr.d : 0,
        });
      });
    }
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

  /** 详情页那颗「追剧」键的文案与状态 */
  function renderDetailFav() {
    var b = $('[data-detail-fav]');
    if (!b || !state.detail) return;
    var g = state.groups[state.detail.gi];
    if (!g) return;
    var on = isFav(g.name);
    b.classList.toggle('is-on', on);
    b.textContent = on ? '★ 追剧中' : '☆ 追剧';
    b.title = on ? '取消追剧' : '加入追剧，下次一点就回到这一集';
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
      if (e.target.closest('[data-cand-more]')) {
        state.showAllCands = !state.showAllCands;
        renderCands(g);
        return;
      }
      var b2 = e.target.closest('[data-cand]');
      if (!b2) return;
      state.candIdx = Number(b2.dataset.cand);
      state.lineIdx = 0;
      state.epIdx = -1;
      state.showAllCands = false;   // 手动选完就收回去，只留他选的那条
      renderCands(g);
      loadDetailFor(g, g.candidates[state.candIdx]);
    });
  }

  function candHtml(row) {
    var c = row.c;
    var p = row.p;
    var label = qualLabel(p);
    var speed = p && p.ok && p.ms ? p.ms + 'ms' : '';
    return (
      '<button type="button" class="tv-cand' + (row.i === state.candIdx ? ' is-on' : '') +
      '" data-cand="' + row.i + '">' +
      '<span class="tv-cand__n">' + esc(c.sourceName) +
      (label ? '<span class="tv-qbadge' + qualBadgeClass(p) + '">' + label + '</span>' : '') +
      '</span>' +
      '<span class="tv-cand__m">' + c.episodeCount + ' 集 · ' + c.lineCount + ' 线路' +
      (c.hasHls ? ' · 可直连' : ' · 仅网页') +
      (speed ? ' · ' + speed : '') +
      '</span></button>'
    );
  }

  /**
   * 播放源列表。
   *
   * **默认只显示一条**（R52）：站主要的是「提取到最佳播放源之后不要主动把其余源摊开」。
   * 其余收进「换源（还有 N 个）」，点了才摊。默认收起还有一个副作用是好事 ——
   * 手机上抽屉不用先滚过十几条源才看到剧集。
   */
  function renderCands(g, results) {
    var box = $('[data-tv-cands]');
    if (!box) return;
    var rows = g.candidates.map(function (c, i) {
      var p = results ? results[i] : state.probe[c.sourceId + ':' + c.vodId];
      return { c: c, i: i, p: p };
    });
    var keep = rows[state.candIdx] || rows[0];
    var rest = rows.filter(function (r) { return r !== keep; });

    var html = keep ? candHtml(keep) : '';
    if (rest.length) {
      html +=
        '<button type="button" class="tv-candmore' + (state.showAllCands ? ' is-on' : '') +
        '" data-cand-more>' +
        (state.showAllCands ? '收起其它源' : '换源（还有 ' + rest.length + ' 个）') +
        '</button>';
      if (state.showAllCands) html += rest.map(candHtml).join('');
    }
    box.innerHTML = html;
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

  /**
   * 剧集区。
   *
   * 两条 R52 的规矩：
   * ① **默认不显示播不了的线路**（kind === 'page' 的那些是资源站网页播放器地址，
   *    点开只有一句「无法直连」）。全部都不能直连时才照旧全列，不然抽屉会空着。
   * ② 从记录直接打开时（state.pendingLine / pendingEp），这里负责定位到上次那条线路
   *    与那一集 —— 定位完就把标记清掉，后面换线路不会又被拽回去。
   */
  function renderEps(vod) {
    var ex = $('[data-tv-extra]');
    if (!ex) return;

    if (!vod.lines || !vod.lines.length) {
      ex.innerHTML = '<div class="tv-loading">这个源没有可用播放地址，换一个源试试</div>';
      return;
    }

    /* 从记录打开：先按线路名定位（线路名比下标稳，源站重排线路时下标会变） */
    if (state.pendingLine) {
      var want = state.pendingLine;
      var hit = -1;
      vod.lines.forEach(function (l, i) { if (l.from === want) hit = i; });
      if (hit >= 0) state.lineIdx = hit;
      state.pendingLine = '';
    }

    var playable = [];
    vod.lines.forEach(function (l, i) { if (l.kind !== 'page') playable.push(i); });
    if (!playable.length) playable = vod.lines.map(function (_l, i) { return i; });

    state.lineIdx = Math.min(state.lineIdx, vod.lines.length - 1);
    // 当前停在一条播不了的线路上、又有能播的：自动挪过去
    if (playable.indexOf(state.lineIdx) < 0) state.lineIdx = playable[0];

    var line = vod.lines[state.lineIdx];
    state.eps = line.episodes;

    var last = lastProgressOf(vod.name);
    var shown = state.showAllLines ? vod.lines.map(function (_l, i) { return i; }) : playable;
    var hiddenN = vod.lines.length - playable.length;

    var linesHtml = shown.map(function (i) {
      var l = vod.lines[i];
      var page = l.kind === 'page';
      return (
        '<button type="button" class="tv-line' + (page ? ' tv-line--page' : '') +
        (i === state.lineIdx ? ' is-on' : '') + '" data-line="' + i + '" ' +
        'title="' + (page ? '网页播放器地址，无法直连' : '可直接播放') + '">' +
        esc(l.from) + ' <span class="tv-line__warn">' + l.episodes.length + '</span>' + (page ? ' ⚠' : '') +
        '</button>'
      );
    }).join('');

    var linesMore = hiddenN > 0
      ? '<button type="button" class="tv-linemore' + (state.showAllLines ? ' is-on' : '') +
        '" data-line-more>' +
        (state.showAllLines ? '隐藏无法直连的线路' : '显示 ' + hiddenN + ' 条无法直连的线路') +
        '</button>'
      : '';

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
      '<div class="tv-lines">' + linesHtml + '</div>' + linesMore + tip +
      '<h3 class="tv-detail__h">剧集 · ' + esc(line.from) + '</h3>' +
      '<div class="tv-eps">' + epsHtml + '</div>';

    paintEpNo();
    ex.onclick = function (e) {
      if (e.target.closest('[data-line-more]')) {
        state.showAllLines = !state.showAllLines;
        renderEps(vod);
        return;
      }
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
        var lr = last.lineIdx >= 0 ? last.lineIdx : state.lineIdx;
        if (lr < vod.lines.length) {
          state.lineIdx = lr;
          renderEps(vod);
          var idx = vod.lines[lr].episodes.findIndex(function (x) { return x.name === last.epName; });
          playEp(vod, idx >= 0 ? idx : 0);
        }
      }
    };

    /* 从记录打开：定位到上次那一集并直接播（state.pendingEp 只消费一次） */
    if (state.pendingEp) {
      var pe = state.pendingEp;
      state.pendingEp = '';
      var pi = line.episodes.findIndex(function (x) { return x.name === pe; });
      playEp(vod, pi >= 0 ? pi : 0);
    }
  }

  /* ══════════════ 播放器 ══════════════ */

  var TRIES = ['direct', 'hlsProxy', 'fullProxy'];
  var TRY_LABEL = {
    direct: '直连',
    hlsProxy: '改为经本站取播放列表',
    fullProxy: '改为连分片也走本站代理',
  };

  /**
   * 换集（R53）。
   *
   * 站主的原话是「在播放页面能直接切换上下集」—— 顶栏那两颗 ⏮ ⏭ 其实一直在，
   * 但手机上顶栏挤了标题、线路、画质、增强、倍速、上下集、关闭七样，
   * ⏮/⏭ 只剩 1.9rem，基本摸不到。所以底栏补一对大字号的「上一集 / 下一集」，
   * 中间显示「第 3 / 40 集」。键盘也接上：**← / →** 与 **P / N**。
   *
   * ⚠ 方向键原本是「长按加速」，现在改成了换集 —— 加速仍在：
   * 长按屏幕上的 ⏭ 键，或按住 Space 临时 3×（见 bindPlayer 里的 boost 段）。
   */
  function stepEp(delta) {
    var vod = state.detail && state.detail.vod;
    if (!vod || !state.eps || !state.eps.length) return;
    var next = state.epIdx + delta;
    if (next < 0) { toast('已经是第一集'); return; }
    if (next >= state.eps.length) { toast('已经是最后一集'); return; }
    playEp(vod, next);
    toast((delta > 0 ? '下一集' : '上一集') + '：' + (state.eps[next].name || ''));
  }

  /** 底栏那行「第 3 / 40 集」 */
  function paintEpNo() {
    var el = $('[data-tv-epno]');
    if (!el) return;
    var n = state.eps ? state.eps.length : 0;
    el.textContent = n && state.epIdx >= 0 ? state.epIdx + 1 + ' / ' + n : n ? '— / ' + n : '— / —';
    var prev = $('[data-tv-eprev]');
    var next = $('[data-tv-enext]');
    if (prev) prev.disabled = state.epIdx <= 0;
    if (next) next.disabled = !n || state.epIdx >= n - 1;
  }

  function bindPlayer() {
    $('[data-tv-pclose]').addEventListener('click', closePlayer);
    $('[data-tv-eprev]').addEventListener('click', function () { stepEp(-1); });
    $('[data-tv-enext]').addEventListener('click', function () { stepEp(1); });
    $('[data-tv-mask]').addEventListener('click', closeDetail);
    $('[data-tv-dclose]').addEventListener('click', closeDetail);

    // 倍速按钮：点按轮换常驻倍速
    var speedBtn = $('[data-tv-speedbtn]');
    if (speedBtn) speedBtn.addEventListener('click', cycleRate);

    /* ── 长按加速（R52 重做）─────────────────────────────────────────────
       站主报的两种现象指向同一个根因：**长按根本没有落在我们的手势上**。
       · 「有时会直接快进」——按住的是浏览器原生控件，或 <video> 有焦点时的方向键；
         原生行为就是 +5s 跳着走，冒泡阶段的 keydown 拦不住那一路。
       · 「有时会失效」——keyup 丢在窗口外（切标签、松手时焦点不在文档里），
         state.holdingBoost 卡在 true，之后再也不进加速分支。
       现在键盘与屏幕上的右箭头共用 boostOn/boostOff，且三条兜底复位。 */
    /* 长按加速挪到**倍速键**上：点按 = 轮换常驻倍速（原行为），长按 = 临时 3×。
       ⏭ 现在专职「下一集」，一个键只做一件事。 */
    var speedKey = $('[data-tv-speedbtn]');
    if (speedKey) {
      var holdTimer = 0;
      var heldBoost = false;
      speedKey.title = '点按切换倍速，长按临时加速';
      speedKey.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        heldBoost = false;
        clearTimeout(holdTimer);
        holdTimer = window.setTimeout(function () {
          heldBoost = true;
          state.boostHeld = true;
          boostOn();
        }, 260);
      });
      var endHold = function () {
        clearTimeout(holdTimer);
        if (state.boostHeld) {
          state.boostHeld = false;
          boostOff();
        }
      };
      speedKey.addEventListener('pointerup', endHold);
      speedKey.addEventListener('pointercancel', endHold);
      speedKey.addEventListener('pointerleave', endHold);
      // 长按成立后吞掉随后那一下 click，否则松手会顺带轮换倍速
      speedKey.addEventListener('click', function (e) {
        if (!heldBoost) return;
        heldBoost = false;
        // 同元素上还有一个 cycleRate 的冒泡监听：只 stopPropagation 不一定挡得住，
        // stopImmediatePropagation 才是「这一下谁都别处理」。
        e.preventDefault();
        e.stopImmediatePropagation();
      }, true);
    }

    /* 键盘（R53）：
       ← / → 与 P / N 换集（站主要的就是「播放页直接切上下集」）；
       **长按 Space 临时加速** —— 方向键让位给换集之后，加速挪到空格，
       既不与原生控件的「方向键快进」打架，也不需要按住某颗按钮。 */
    document.addEventListener('keydown', function (e) {
      var ov = $('[data-tv-player]');
      if (!ov || ov.hidden) return;
      var t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) return;

      if (e.key === 'ArrowLeft' || e.key === 'p' || e.key === 'P') {
        // capture 阶段拦：原生控件对方向键有「快进/快退」的默认动作
        e.preventDefault();
        if (!e.repeat) stepEp(-1);
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        if (!e.repeat) stepEp(1);
        return;
      }
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        boostOn();
      }
    }, true);

    document.addEventListener('keyup', function (e) {
      if (e.key === ' ' || e.code === 'Space') boostOff();
    }, true);

    /* 三条兜底：窗口失焦、切标签、指针捕获被系统收走 —— 任何一条都可能吞掉 keyup/pointerup */
    addEventListener('blur', boostOff);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) boostOff();
    });

    // 画质偏好 / 观感增强：两个开关，状态存本地
    var qmodeBtn = $('[data-tv-qmode]');
    if (qmodeBtn) {
      qmodeBtn.addEventListener('click', function () {
        state.qmode = state.qmode === 'quality' ? 'auto' : 'quality';
        writeLS(LS.qmode, state.qmode);
        paintQmode();
        if (state.hls) applyQualityMode(state.hls, state.hls.levels);
        toast(state.qmode === 'quality' ? '画质优先：锁最高码率' : '自动：按网速自适应');
      });
    }
    var enhBtn = $('[data-tv-enhance]');
    if (enhBtn) {
      enhBtn.addEventListener('click', function () {
        state.enhance = !state.enhance;
        writeLS(LS.enh, state.enhance);
        applyEnhance();
        toast(state.enhance ? '观感增强已开（不改变实际分辨率）' : '观感增强已关');
      });
    }
    paintQmode();
    applyEnhance();

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

  /** 开始长按加速。重复调用无害（键盘自动重复会一直喊） */
  function boostOn() {
    if (state.holdingBoost) return;
    state.holdingBoost = true;
    applyRate(HOLD_RATE);
    toast('加速 ' + HOLD_RATE + '×，松手恢复');
  }
  /** 结束长按加速。没在加速时直接返回 —— 兜底复位会反复调它 */
  function boostOff() {
    if (!state.holdingBoost) return;
    state.holdingBoost = false;
    applyRate(state.baseRate);
  }

  /** 画质偏好按钮的文案（两档：锁最高码率 / 自适应） */
  function paintQmode() {
    var b = $('[data-tv-qmode]');
    if (!b) return;
    b.textContent = state.qmode === 'quality' ? '画质优先' : '自动画质';
    b.classList.toggle('is-on', state.qmode === 'quality');
    b.title = state.qmode === 'quality'
      ? '已锁定最高码率，不会因网速波动掉到低清晰度（点一下改成自适应）'
      : '按网速自适应（点一下锁最高码率）';
  }

  /**
   * 观感增强。
   *
   * 说清它是什么：**不改变实际分辨率**，只是把对比度与饱和度各提一点，
   * 低码率片源的「灰蒙蒙」观感会好一些。真正的超分要 WASM/WebGL 逐帧跑，
   * 那是另一个量级的成本，而且免费档 Worker 与手机都吃不消 —— 所以这里不假装。
   */
  function applyEnhance() {
    var v = $('[data-tv-video]');
    if (v) v.style.filter = state.enhance ? 'contrast(1.06) saturate(1.06) brightness(1.02)' : '';
    var b = $('[data-tv-enhance]');
    if (b) {
      b.classList.toggle('is-on', state.enhance);
      b.textContent = state.enhance ? '增强开' : '增强关';
      b.title = '观感增强：对比度与饱和度各提一点，不改变实际分辨率';
    }
  }

  /** 最高那档的索引（同分辨率比码率） */
  function maxLevelIndex(levels) {
    var best = -1;
    var bestH = -1;
    var bestBw = -1;
    (levels || []).forEach(function (lv, i) {
      var h = lv.height || 0;
      var bw = lv.bitrate || 0;
      if (h > bestH || (h === bestH && bw > bestBw)) { best = i; bestH = h; bestBw = bw; }
    });
    return best;
  }

  /**
   * 按画质偏好决定 hls.js 的档位策略。
   *
   * `quality` 档两件事一起做：
   *   autoLevelCapping = 最高档 → ABR 想降也降不下去（这是「看着看着变糊」的根因）；
   *   currentLevel = 最高档 → 立刻切过去，不等 ABR 自己爬。
   * `auto` 档把两者复位成 -1，交回 hls.js。
   */
  function applyQualityMode(hls, levels) {
    if (!hls) return;
    var top = maxLevelIndex(levels);
    if (state.qmode === 'quality' && top >= 0) {
      hls.autoLevelCapping = top;
      hls.currentLevel = top;
    } else {
      hls.autoLevelCapping = -1;
      hls.currentLevel = -1;
    }
    renderQualityPicker(hls, levels);
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

    /* 追剧收藏里那一份也更新：不然「我的追剧」永远停在加入时的那一集，
       点「继续看」还是从旧位置起播。 */
    var fv = getFav();
    if (fv[rec.name]) {
      fv[rec.name] = Object.assign({}, fv[rec.name], {
        srcId: rec.srcId || fv[rec.name].srcId,
        vodId: rec.vodId || fv[rec.name].vodId,
        srcName: rec.srcName || fv[rec.name].srcName,
        lineIdx: rec.lineIdx,
        lineFrom: rec.lineFrom || fv[rec.name].lineFrom,
        epName: rec.epName,
        t: rec.t,
        d: rec.d,
        ts: rec.ts,
      });
      setFav(fv);
    }

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

        // 追剧收藏：云端的按 ts 覆盖本地同名片
        var fav = getFav();
        (d.fav || []).forEach(function (r) {
          var name = r.name || r.k;
          if (!name) return;
          var cur = fav[name];
          var ts = Number(r.ts) || 0;
          if (!cur || ts >= (cur.ts || 0)) {
            fav[name] = {
              name: name,
              pic: r.pic || '',
              srcId: r.src_id || '',
              vodId: r.vod_id || '',
              srcName: r.src_name || '',
              lineIdx: Number(r.line_idx) || 0,
              lineFrom: r.line_from || '',
              epName: r.ep_name || '',
              t: Number(r.t) || 0,
              d: Number(r.d) || 0,
              ts: ts,
            };
          }
        });
        setFav(fav);
        renderContinue();
        paintFavButtons();
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
    paintEpNo();
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
    state.boostHeld = false;
    tryPlayback(0);
    applyRate(state.baseRate);
    applyEnhance();
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

    /**
     * hls.js 的调参（R52）。
     *
     * 这几个值都是冲着「清晰度」去的，逐个说清代价：
     * · `capLevelToPlayerSize: false` —— 默认 true 会把码率上限压到播放器像素尺寸，
     *   手机小窗/半屏时等于主动降画质。关掉它才可能吃到源站的最高档。
     * · `abrEwmaDefaultEstimate: 8Mbps` —— 起播时的带宽先验。默认 500kbps 会让它
     *   第一段就挑最烂的档，然后再慢慢往上爬。
     * · `maxBufferLength: 45` / `maxMaxBufferLength: 300` —— 缓冲吃深一点，
     *   网速抖一下不会立刻触发降档（降档一次要重新下载分片，观感上就是「忽然糊了」）。
     * · `backBufferLength: 60` —— 回拖 60 秒内不用重新拉。
     */
    var hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
      capLevelToPlayerSize: false,
      abrEwmaDefaultEstimate: 8 * 1000 * 1000,
      maxBufferLength: 45,
      maxMaxBufferLength: 300,
      backBufferLength: 60,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 2,
      fragLoadingMaxRetry: 4,
      startLevel: -1,
    });
    state.hls = hls;

    hls.on(window.Hls.Events.MANIFEST_PARSED, function (_e, data) {
      playerMsg(null);
      applyQualityMode(hls, data && data.levels);
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
