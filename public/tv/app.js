/**
 * /tv 影视聚合页的客户端逻辑。
 *
 * 不参与构建（放在 public/ 里按原样发），所以这里不写 import —— 用全局的 Hls。
 *
 * 两个必须自己处理的环境事实：
 * 1. **ClientRouter（全站 SPA 换页）**。这一页被进来、离开、再进来，
 *    脚本不会重新执行。所以入口挂在 `astro:page-load` 上（首次加载和每次换页都会触发），
 *    并且用 `data-tv-ready` 防重复绑定。
 * 2. **播放地址是跨域的**。m3u8 与分片多数带 `Access-Control-Allow-Origin: *`，
 *    但**播放列表里的路径是相对的**，直接交给 hls.js 会以本站为基准解析而 404。
 *    所以播放列表一律先过 `/api/tv/hls` 换回绝对地址（只转发几 KB 文本），
 *    分片由浏览器直连 CDN —— 媒体字节不进 Worker 配额。
 *    只有 hls.js 报致命网络错误时才降级到 `&proxy=1`（分片也走代理），
 *    这条路是给「分片不带 CORS」的源兜底的。
 */

(function () {
  'use strict';

  var BASE = '/api/tv';
  var LS_OFF = 'tv:off';        // 被访客手动关掉的源 id
  var HOT = ['庆余年', '流浪地球', '繁花', '狂飙', '三体', '沙丘', '抓娃娃', '与凤行'];

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
    proxyTried: false,
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getJson(path) {
    return fetch(path).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error((d && d.error) || 'HTTP ' + r.status);
        return d;
      });
    });
  }

  function loadOff() {
    try {
      var raw = localStorage.getItem(LS_OFF);
      state.off = new Set(raw ? JSON.parse(raw) : []);
    } catch (e) {
      state.off = new Set();
    }
  }

  function saveOff() {
    try {
      localStorage.setItem(LS_OFF, JSON.stringify(Array.from(state.off)));
    } catch (e) {
      /* 隐私模式写不进去，不影响本次会话 */
    }
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

  /* ══════════════════ 初始化 ══════════════════ */

  function init() {
    var root = $('[data-tv]');
    if (!root || root.dataset.tvReady === '1') return;
    root.dataset.tvReady = '1';

    loadOff();
    bindTabs();
    bindSearch();
    bindPlayer();
    renderHot();

    getJson(BASE + '/sources')
      .then(function (d) {
        state.sources = d.sources || [];
        state.live = d.live || [];
        renderSrcBar();
        renderSrcList();
        updateCount();

        // 深链：/tv?q=片名 直接出结果（可分享）；?tab=live 直进直播
        try {
          var sp = new URLSearchParams(location.search);
          var q = (sp.get('q') || '').trim();
          if (q) {
            $('[data-tv-q]').value = q;
            doSearch(q);
          }
          if (sp.get('tab') === 'live') {
            var lb = $('[data-tv-tab="live"]');
            if (lb) lb.click();
          }
        } catch (e) {
          /* 老浏览器没有 URLSearchParams，忽略 */
        }
      })
      .catch(function (e) {
        setStatus('读取源清单失败：' + e.message);
      });
  }

  function updateCount() {
    var el = $('[data-tv-count]');
    if (el) el.textContent = enabledSources().length + ' 源';
  }

  function setStatus(text) {
    var el = $('[data-tv-status]');
    if (el) el.innerHTML = text;
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
      b.addEventListener('click', function () {
        $('[data-tv-q]').value = w;
        doSearch(w);
      });
      box.appendChild(b);
    });
  }

  /* ══════════════════ 源筛选 ══════════════════ */

  function renderSrcBar() {
    var bar = $('[data-tv-srcbar]');
    if (!bar) return;
    bar.innerHTML = '';

    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'tv-chip is-on';
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
      b.className = 'tv-chip' + (state.off.has(s.id) ? '' : ' is-ok');
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
    $$('[data-tv-srcbar] .tv-chip').forEach(function (c) {
      if (!c.dataset.srcId) return;
      c.classList.toggle('is-on', state.activeSrc === c.dataset.srcId);
    });
  }

  /* ══════════════════ 搜索 ══════════════════ */

  function skeletons(n) {
    var grid = $('[data-tv-grid]');
    grid.innerHTML = '';
    for (var i = 0; i < n; i++) {
      var d = document.createElement('div');
      d.className = 'tv-card tv-card--sk';
      d.innerHTML = '<div class="tv-card__poster"></div><div class="tv-card__title"></div>' +
        '<div class="tv-card__meta"></div>';
      grid.appendChild(d);
    }
  }

  function doSearch(q) {
    state.lastQ = q;
    var empty = $('[data-tv-empty]');
    if (empty) empty.hidden = true;
    setStatus('正在并发搜索 <b>' + esc(q) + '</b> …');
    skeletons(12);

    var params = '?q=' + encodeURIComponent(q);
    if (state.activeSrc !== 'all') params += '&src=' + encodeURIComponent(state.activeSrc);

    getJson(BASE + '/search' + params)
      .then(function (d) {
        state.groups = d.groups || [];
        var okN = (d.sources || []).filter(function (s) { return s.ok; }).length;
        var allN = (d.sources || []).length;
        var fails = (d.sources || []).filter(function (s) { return !s.ok; });
        setStatus(
          '<b>' + okN + '/' + allN + '</b> 个源响应 · 共 <b>' + state.groups.length +
            '</b> 部 · ' + d.tookMs + 'ms' +
            (fails.length
              ? ' · 未响应：' + fails.map(function (f) { return esc(f.name); }).join('、')
              : '')
        );
        paintSrcHealth(d.sources);
        renderCards();
      })
      .catch(function (e) {
        $('[data-tv-grid]').innerHTML = '';
        setStatus('搜索失败：' + esc(e.message));
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

    state.groups.forEach(function (g, i) {
      var card = document.createElement('div');
      card.className = 'tv-card';
      card.style.animationDelay = Math.min(i * 16, 320) + 'ms';

      var n = g.candidates.length;
      var inner =
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
        esc([g.typeName, g.area, g.year].filter(Boolean).join(' · ') || '—') +
        '</div>';

      card.innerHTML = inner;
      card.addEventListener('click', function () { openDetail(i); });
      grid.appendChild(card);
    });
  }

  /* ══════════════════ 详情 ══════════════════ */

  function openDetail(groupIdx) {
    state.detail = { gi: groupIdx };
    state.candIdx = 0;
    state.lineIdx = 0;
    state.epIdx = -1;
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
      '<div class="tv-detail__poster">' +
      (g.pic ? '<img src="' + esc(g.pic) + '" alt="' + esc(g.name) + '">' : '') +
      '</div>' +
      '<div class="tv-detail__head">' +
      '<h2 class="tv-detail__title">' + esc(g.name) + '</h2>' +
      '<div class="tv-detail__tags">' + tagsHtml(g) + '</div>' +
      '<div class="tv-detail__desc">暂无简介</div>' +
      '</div></div>' +
      '<div class="tv-detail__sec">' +
      '<h3 class="tv-detail__h">来源线路（' + g.candidates.length + ' 个源）</h3>' +
      '<div class="tv-cands">' + candsHtml(g) + '</div>' +
      '<div data-tv-extra><div class="tv-loading">正在读取剧集…</div></div>' +
      '</div>';

    bindDetailEvents(g);

    if (!cand) return;
    getJson(BASE + '/detail?s=' + encodeURIComponent(cand.sourceId) + '&id=' + encodeURIComponent(cand.vodId))
      .then(function (vod) {
        state.detail.vod = vod;
        // 简介与元信息以详情为准补全
        var desc = $('.tv-detail__desc');
        if (desc) desc.textContent = vod.content || '暂无简介';
        var tags = $('.tv-detail__tags');
        if (tags) tags.innerHTML = tagsHtml(g, vod);
        renderEps(vod);
      })
      .catch(function (e) {
        var ex = $('[data-tv-extra]');
        if (ex) {
          ex.innerHTML = '<div class="tv-loading">读取失败：' + esc(e.message) +
            '<br>可点上面别的源重试</div>';
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

  function candsHtml(g) {
    return g.candidates
      .map(function (c, i) {
        return (
          '<button type="button" class="tv-cand' + (i === state.candIdx ? ' is-on' : '') +
          '" data-cand="' + i + '">' +
          '<span class="tv-cand__n">' + esc(c.sourceName) + '</span>' +
          '<span class="tv-cand__m">' + c.episodeCount + ' 集 · ' + c.lineCount + ' 线路' +
          (c.hasHls ? ' · 可直连' : '') + '</span></button>'
        );
      })
      .join('');
  }

  function bindDetailEvents(g) {
    var cands = $('.tv-cands');
    if (cands) {
      cands.addEventListener('click', function (e) {
        var b = e.target.closest('[data-cand]');
        if (!b) return;
        state.candIdx = Number(b.dataset.cand);
        state.lineIdx = 0;
        state.epIdx = -1;
        renderDetail();
      });
    }
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

    var linesHtml = vod.lines
      .map(function (l, i) {
        var page = l.kind === 'page';
        return (
          '<button type="button" class="tv-line' + (page ? ' tv-line--page' : '') +
          (i === state.lineIdx ? ' is-on' : '') + '" data-line="' + i + '" ' +
          'title="' + (page ? '网页播放器地址，无法直连' : '可直接播放') + '">' +
          esc(l.from) + ' <span class="tv-line__warn">' + l.episodes.length + '</span>' +
          (page ? ' ⚠' : '') + '</button>'
        );
      })
      .join('');

    var epsHtml = line.episodes
      .map(function (ep, i) {
        return (
          '<button type="button" class="tv-ep' + (i === state.epIdx ? ' is-on' : '') +
          '" data-ep="' + i + '" title="' + esc(ep.name) + '">' + esc(ep.name) + '</button>'
        );
      })
      .join('');

    var tip =
      line.kind === 'page'
        ? '<p class="tv-tip">这条线路是资源站的网页播放器地址，浏览器拿不到直链。' +
          '请选上面带 m3u8 的线路，或换一个源。</p>'
        : '';

    ex.innerHTML =
      '<div class="tv-lines">' + linesHtml + '</div>' + tip +
      '<h3 class="tv-detail__h">剧集 · ' + esc(line.from) + '</h3>' +
      '<div class="tv-eps">' + epsHtml + '</div>';

    ex.addEventListener('click', function (e) {
      var lb = e.target.closest('[data-line]');
      if (lb) {
        state.lineIdx = Number(lb.dataset.line);
        state.epIdx = -1;
        renderEps(vod);
        return;
      }
      var eb = e.target.closest('[data-ep]');
      if (eb) playEp(vod, Number(eb.dataset.ep));
    });
  }

  /* ══════════════════ 播放器 ══════════════════ */

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
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('[data-tv-player]').hidden) { closePlayer(); return; }
      if (!$('[data-tv-drawer]').hidden) closeDetail();
    });
  }

  function playerMsg(html) {
    var el = $('[data-tv-pmsg]');
    if (!html) { el.hidden = true; el.innerHTML = ''; return; }
    el.innerHTML = html;
    el.hidden = false;
  }

  function teardownVideo() {
    var v = $('[data-tv-video]');
    if (state.hls) {
      try { state.hls.destroy(); } catch (e) { /* ignore */ }
      state.hls = null;
    }
    v.pause();
    v.removeAttribute('src');
    v.load();
  }

  function closePlayer() {
    $('[data-tv-player]').hidden = true;
    teardownVideo();
  }

  /** 拼播放列表代理地址（只转发文本；分片由浏览器直连 CDN） */
  function playlistUrl(epUrl, api, useProxy) {
    var ref = originOf(api);
    return (
      BASE + '/hls?u=' + encodeURIComponent(epUrl) +
      '&ref=' + encodeURIComponent(ref) +
      (useProxy ? '&proxy=1' : '')
    );
  }

  function playEp(vod, idx) {
    var cand = state.detail.candidates || null;
    var g = state.groups[state.detail.gi];
    var c = g.candidates[state.candIdx];
    var src = srcById(c.sourceId);
    var line = vod.lines[state.lineIdx];
    var ep = line.episodes[idx];
    if (!ep) return;

    var ov = $('[data-tv-player]');
    ov.hidden = false;
    state.epIdx = idx;
    state.proxyTried = false;

    $('[data-tv-ptitle]').textContent =
      (vod.name || g.name) + ' · ' + ep.name;
    $('[data-tv-pline]').textContent = c.sourceName + ' / ' + line.from;

    // 底部剧集条
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

    // 同步详情里剧集高亮
    $$('[data-tv-extra] .tv-ep').forEach(function (b, i) {
      b.classList.toggle('is-on', i === idx);
    });

    void cand;
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

    startPlayback(ep.url, src ? src.api : '', line, ep.name);
  }

  function startPlayback(epUrl, api, line, epName) {
    var v = $('[data-tv-video]');
    teardownVideo();
    playerMsg('正在解析播放地址…');

    var isHlsUrl = /\.m3u8(\?|#|$)/i.test(epUrl) || line.kind === 'hls';

    if (isHlsUrl && window.Hls && window.Hls.isSupported()) {
      attachHls(playlistUrl(epUrl, api, false), epUrl, api, v, epName);
      return;
    }

    // mp4 / 原生 HLS（Safari）
    v.src = BASE + '/seg?u=' + encodeURIComponent(epUrl) + '&ref=' + encodeURIComponent(originOf(api));
    playerMsg(null);
    v.play().catch(function () { /* 自动播放被拦，等用户点 */ });
    v.onerror = function () {
      playerMsg('<b>无法播放该地址</b><br>' + esc(epName) + ' 可能已失效，换源试试。');
    };
  }

  function attachHls(playUrl, epUrl, api, video, epName) {
    var hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 30,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 2,
      fragLoadingMaxRetry: 4,
    });
    state.hls = hls;

    hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
      playerMsg(null);
      video.play().catch(function () { /* 等用户手势 */ });
    });

    hls.on(window.Hls.Events.ERROR, function (_evt, data) {
      if (!data.fatal) return;

      var netErr = data.type === window.Hls.ErrorTypes.NETWORK_ERROR;

      // 分片/列表跨域失败：降级成「分片也走本站代理」重试一次
      if (netErr && !state.proxyTried) {
        state.proxyTried = true;
        playerMsg('直连失败，正在改走代理重试…');
        try { hls.destroy(); } catch (e) { /* ignore */ }
        state.hls = null;
        attachHls(playlistUrl(epUrl, api, true), epUrl, api, video, epName);
        return;
      }

      if (netErr) {
        playerMsg('<b>网络错误</b><br>这个源可能已失效或被限流。<br>' +
          '<code>' + esc(data.details || '') + '</code>');
        return;
      }
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        playerMsg('解码失败，正在尝试恢复…');
        try { hls.recoverMediaError(); } catch (e) { playerMsg('<b>解码失败</b>，换源试试。'); }
        return;
      }
      playerMsg('<b>播放失败</b><br><code>' + esc(data.details || '') + '</code>');
    });

    hls.loadSource(playUrl);
    hls.attachMedia(video);
  }

  /* ══════════════════ 直播 ══════════════════ */

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
        if (!ok.length) {
          status.textContent = '没有可用的直播源';
          return;
        }
        var total = ok.reduce(function (n, p) { return n + p.channels.length; }, 0);
        status.textContent = ok.length + ' 个源 · ' + total + ' 个频道';
        state.live = ok;
        renderLive('');
      })
      .catch(function (e) {
        status.textContent = '拉取失败：' + e.message;
      });
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
            b.innerHTML =
              (ch.logo ? '<img class="tv-ch__logo" src="' + esc(ch.logo) + '" alt="" loading="lazy">' : '') +
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
          more.addEventListener('click', function () {
            addRange(PAGE, chs.length);
            more.remove();
          });
          list.appendChild(more);
        }

        box.appendChild(sec);
      });
    });

    if (!shown) {
      box.innerHTML = '<div class="tv-empty"><span class="tv-empty__big">📺</span>' +
        '<div class="tv-empty__msg">没有匹配的频道</div></div>';
    }
  }

  function playLive(ch) {
    var ov = $('[data-tv-player]');
    ov.hidden = false;
    state.eps = [];
    $('[data-tv-ptitle]').textContent = ch.name;
    $('[data-tv-pline]').textContent = '直播';
    $('[data-tv-peps]').innerHTML = '';

    var v = $('[data-tv-video]');
    teardownVideo();
    playerMsg('正在连接直播流…');
    state.proxyTried = false;

    if (window.Hls && window.Hls.isSupported()) {
      var hls = new window.Hls({
        enableWorker: true,
        liveSyncDurationCount: 3,
        manifestLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 6,
      });
      state.hls = hls;
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
        playerMsg(null);
        v.play().catch(function () {});
      });
      hls.on(window.Hls.Events.ERROR, function (_e, data) {
        if (!data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && !state.proxyTried) {
          state.proxyTried = true;
          try { hls.destroy(); } catch (e) { /* ignore */ }
          state.hls = null;
          playerMsg('直连失败，正在改走代理重试…');
          var h2 = new window.Hls({ enableWorker: true, liveSyncDurationCount: 3 });
          state.hls = h2;
          h2.on(window.Hls.Events.MANIFEST_PARSED, function () {
            playerMsg(null);
            v.play().catch(function () {});
          });
          h2.on(window.Hls.Events.ERROR, function () {
            playerMsg('<b>直播流不可用</b><br>换一个频道试试。');
          });
          h2.loadSource(playlistUrl(ch.url, '', true));
          h2.attachMedia(v);
          return;
        }
        playerMsg('<b>直播流不可用</b><br>换一个频道试试。');
      });
      hls.loadSource(playlistUrl(ch.url, '', false));
      hls.attachMedia(v);
    } else {
      v.src = BASE + '/seg?u=' + encodeURIComponent(ch.url);
      v.play().catch(function () {});
    }
  }

  /* ══════════════════ 源列表 ══════════════════ */

  function renderSrcList() {
    var ul = $('[data-tv-srclist]');
    if (!ul) return;
    ul.innerHTML = '';

    state.sources.forEach(function (s) {
      var li = document.createElement('li');
      li.className = 'tv-srcitem';
      var on = !state.off.has(s.id);
      li.innerHTML =
        '<button type="button" class="tv-srcitem__box' + (on ? ' is-on' : '') +
        '" aria-label="启用/停用"></button>' +
        '<div class="tv-srcitem__main">' +
        '<div class="tv-srcitem__n">' + esc(s.name) + '</div>' +
        '<div class="tv-srcitem__url">' + esc(s.api) + '</div>' +
        '</div>' +
        '<div class="tv-srcitem__note">' + esc(s.note || '') + '</div>';

      li.querySelector('.tv-srcitem__box').addEventListener('click', function (e) {
        if (state.off.has(s.id)) state.off.delete(s.id);
        else state.off.add(s.id);
        saveOff();
        e.currentTarget.classList.toggle('is-on', !state.off.has(s.id));
        renderSrcBar();
        updateCount();
      });

      ul.appendChild(li);
    });
  }

  /* ══════════════════ 直播搜索 ══════════════════ */

  function bindLiveSearch() {
    var el = $('[data-tv-liveq]');
    if (!el || el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    var timer = null;
    el.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { renderLive(el.value.trim()); }, 180);
    });
  }

  /* ══════════════════ 入口 ══════════════════ */

  function boot() {
    init();
    bindLiveSearch();
  }

  // ClientRouter：首次加载与每次换页都会发这个事件。没有它（老浏览器/独立打开）就退回 DOMContentLoaded
  document.addEventListener('astro:page-load', boot);
  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
