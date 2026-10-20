/**
 * `/api/tv/*` —— 影视聚合的同源只读接口。
 *
 * 六条 GET：
 *   /api/tv/sources                       源清单 + 调参（前端首屏拿一次）
 *   /api/tv/search?q=&src=&page=          聚合搜索（并发 + 融合 + 打分）
 *   /api/tv/detail?s=<源id>&id=<vod_id>   详情 + 剧集（线路已按可播性排序）
 *   /api/tv/live                          直播源解析结果
 *   /api/tv/hls?u=&ref=&proxy=            播放列表改写（只转发文本，不转发媒体）
 *   /api/tv/seg?u=&ref=                   分片兜底代理（**例外路径**，见 hls.ts 顶部）
 *
 * 缓存策略（Workers 的 Cache-Control 必须在这里设，`_headers` 不作用于 Worker 响应）：
 *   search 30s、detail 300s、live 600s、sources 3600s、hls 不缓存（播放列表随时变）。
 *
 * 写这个文件的几条硬规矩：
 *   - 每条路径都要兜底，抛异常也要变成一句中文人话，不能裸 500。
 *   - 入参全部要校验（url 走 assertPublicUrl，id 走白名单），因为这是公网接口。
 *   - 不引入任何 Node 内置模块 —— 这是 Workers 运行期。
 */

import {
  detail,
  search,
  type SearchResult,
  type Vod,
} from './cms';
import { assertPublicUrl, fetchPlaylist, rewritePlaylist } from './hls';
import { loadLivePlaylist, type LivePlaylistResult } from './live';
import { LIVE_SOURCES, TV_TUNING, VOD_SOURCES, type VodSource } from './sources';
import { currentUser, siteCall, type SiteEnv } from '../site-auth';

/** 按 id 找点播源；拿不到就是 404，绝不把用户传来的东西直接当 api */
function findSource(id: string | null): VodSource | null {
  if (!id) return null;
  return VOD_SOURCES.find((s) => s.id === id) ?? null;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
} as const;

function json(data: unknown, cacheSec: number, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control':
        cacheSec > 0 ? `public, max-age=${cacheSec}, stale-while-revalidate=${cacheSec * 4}` : 'no-store',
      ...CORS,
    },
  });
}

function fail(status: number, error: string): Response {
  return json({ ok: false, error }, 0, status);
}

/** 从 query 里取要搜哪些源（逗号分隔的 id），并过滤掉不存在的 */
function parseOnly(raw: string | null): string[] {
  if (!raw || raw === 'all') return [];
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.filter((id) => VOD_SOURCES.some((s) => s.id === id));
}

async function handleSearch(url: URL): Promise<Response> {
  const q = url.searchParams.get('q') ?? '';
  if (!q.trim()) return fail(400, '请输入关键词');
  const page = Number(url.searchParams.get('page') ?? '1') || 1;
  const only = parseOnly(url.searchParams.get('src'));

  const result: SearchResult = await search(VOD_SOURCES, q, { only, page });
  return json(result, TV_TUNING.searchCacheSec);
}

async function handleDetail(url: URL): Promise<Response> {
  const source = findSource(url.searchParams.get('s'));
  if (!source) return fail(400, '没有这个资源源');
  const vodId = url.searchParams.get('id') ?? '';
  if (!/^[0-9A-Za-z_-]{1,40}$/.test(vodId)) return fail(400, '影片 id 不合法');

  const vod: Vod = await detail(source, vodId);
  return json(vod, TV_TUNING.detailCacheSec);
}

async function handleLive(url: URL): Promise<Response> {
  const want = url.searchParams.get('ids');
  const picked = want
    ? LIVE_SOURCES.filter((s) => want.split(',').includes(s.id))
    : LIVE_SOURCES;

  const results: LivePlaylistResult[] = await Promise.all(
    picked.map((s) => loadLivePlaylist(s.id, s.name, s.url))
  );
  return json({ playlists: results }, 600);
}

async function handleHls(url: URL): Promise<Response> {
  const raw = url.searchParams.get('u');
  if (!raw) return fail(400, '缺少播放地址');
  const target = assertPublicUrl(raw);
  const ref = url.searchParams.get('ref') ?? undefined;
  const proxySegments = url.searchParams.get('proxy') === '1';

  const text = await fetchPlaylist(target.toString(), ref);
  const rewritten = rewritePlaylist(text, target.toString(), { proxySegments });

  return new Response(rewritten, {
    // 播放列表随时可能变（直播/新集），不缓存
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS,
    },
  });
}

/**
 * 分片兜底代理。**这是例外路径**：只给「分片不带 CORS」的源用（正常播放不经过这里）。
 * 保留 Range 透传，mp4 拖动进度条要靠它。
 */
async function handleSegment(request: Request, url: URL): Promise<Response> {
  const raw = url.searchParams.get('u');
  if (!raw) return fail(400, '缺少分片地址');
  const target = assertPublicUrl(raw);
  const ref = url.searchParams.get('ref') ?? undefined;

  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: '*/*',
  };
  if (ref) {
    try {
      const r = assertPublicUrl(ref);
      headers.Referer = r.toString();
      headers.Origin = r.origin;
    } catch {
      /* ignore */
    }
  }
  const range = request.headers.get('Range');
  if (range) headers.Range = range;

  const upstream = await fetch(target.toString(), {
    headers,
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  });

  const out = new Headers(CORS);
  out.set('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
  for (const key of ['content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(key);
    if (v) out.set(key, v);
  }
  // 分片内容不变，但 URL 是 query 形式，交给浏览器自己缓存一小会就够
  out.set('Cache-Control', 'public, max-age=120');

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/**
 * 每用户的影视记录（搜索关键词 + 播放进度）。
 *
 * GET  → 把该用户云端的记录全取回来（前端拿它和本地存量合并）
 * POST → 写一条：`{ q }` 或 `{ prog: {...} }`
 *
 * **必须登录**：这里不做「匿名也能写」的兜底 —— 匿名用户的记录仍走浏览器
 * localStorage（前端自己分得清），上云的一定是登录用户。
 */
async function handleHist(request: Request, env: SiteEnv, url: URL): Promise<Response> {
  const me = await currentUser(env, request);
  if (!me) return fail(401, '需要登录');

  if (request.method === 'GET') {
    const [qs, progs] = await Promise.all([
      siteCall(env, '/tv-q-list?userId=' + encodeURIComponent(me.id)),
      siteCall(env, '/tv-prog-list?userId=' + encodeURIComponent(me.id)),
    ]);
    return json(
      { ok: true, q: qs.rows ?? [], prog: progs.rows ?? [] },
      0
    );
  }

  if (request.method !== 'POST') return fail(405, '只接 GET/POST');

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const now = Date.now();

  if (typeof body.q === 'string' && body.q.trim()) {
    await siteCall(env, '/tv-q-put', { userId: me.id, q: body.q, now });
    return json({ ok: true }, 0);
  }

  const p = body.prog as Record<string, unknown> | undefined;
  if (p && typeof p === 'object') {
    const name = String(p.name ?? '');
    const epName = String(p.epName ?? '');
    if (!name || !epName) return fail(400, '记录缺少片名或集名');
    await siteCall(env, '/tv-prog-put', {
      userId: me.id,
      k: name + '||' + epName,
      name: name.slice(0, 120),
      epName: epName.slice(0, 120),
      t: p.t ?? 0,
      d: p.d ?? 0,
      srcId: p.srcId ?? '',
      vodId: p.vodId ?? '',
      srcName: p.srcName ?? '',
      lineIdx: p.lineIdx ?? 0,
      lineFrom: p.lineFrom ?? '',
      now,
    });
    return json({ ok: true }, 0);
  }

  return fail(400, '没有要写的记录');
}

/** `/api/tv/*` 的总入口 */
export async function tvApi(request: Request, env: SiteEnv, url: URL): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const sub = url.pathname.slice('/api/tv/'.length).replace(/\/+$/, '');

  /* 绝大多数接口是只读 GET；**只有 `hist` 允许 POST**（用户的搜索/播放记录要写）。
     其余一律 405 —— 这条闸是有意的，别为了图省事放宽成「什么方法都收」。 */
  if (request.method !== 'GET' && !(sub === 'hist' && request.method === 'POST')) {
    return fail(405, '只接 GET');
  }

  try {
    switch (sub) {
      case 'sources':
        return json(
          {
            sources: VOD_SOURCES,
            live: LIVE_SOURCES,
            tuning: {
              sourceTimeoutMs: TV_TUNING.sourceTimeoutMs,
              maxPagesPerSource: TV_TUNING.maxPagesPerSource,
            },
          },
          3600
        );
      case 'search':
        return await handleSearch(url);
      case 'detail':
        return await handleDetail(url);
      case 'live':
        return await handleLive(url);
      case 'hls':
        return await handleHls(url);
      case 'seg':
        return await handleSegment(request, url);
      case 'hist':
        return await handleHist(request, env, url);
      default:
        return fail(404, '没有这个接口');
    }
  } catch (e) {
    // 这里的 message 都在上面各模块里写成中文，可以直接给访客看
    return fail(502, e instanceof Error ? e.message : '影视聚合这边出了点问题');
  }
}
