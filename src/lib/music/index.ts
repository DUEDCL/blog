/** Five existing /api/music/* response contracts; upstream details stay server-side. */
import { isChartId, SEARCH_MAX_N, SEARCH_MAX_Q } from '../../data/jukebox';
import { MusicError, MusicSession, musicId, type MusicOptions } from './upstream';

export const MUSIC_API_PREFIX = '/api/music/';
/** Bump the internal cache namespace when provider/record semantics change. */
export const MUSIC_CACHE_VERSION = 'official-anonymous-v1';

/**
 * Browser-fetchable audio endpoint for the datacenter-egress case.
 *
 * Why this exists: NetEase refuses `player/url` from Cloudflare's ranges, and the
 * official endpoint sends no CORS header, so the browser cannot call it either.
 * This public Meting gateway resolves the same NetEase song server-side and answers
 * with real audio bytes plus `access-control-allow-origin: *` — verified in a real
 * browser on 2026-11-03 (`currentTime` advanced, `readyState` 4).
 *
 * Scope: it is a *playback relay*, not an authorization bypass — it is offered only
 * after the provider already returned a playable row, and rights refusals from the
 * provider itself are still surfaced as 403. Only this one host is emitted.
 */
const DIRECT_AUDIO = 'https://api.injahow.cn/meting/?server=netease&type=url&id=';

/** Emit the relay URL for a validated song id; '' when the id is unusable. */
function directAudioUrl(id: string): string {
  return /^[1-9]\d{0,19}$/.test(id) ? DIRECT_AUDIO + id : '';
}

/**
 * Ask the relay for the first bytes and require real audio.
 *
 * The relay answers `text/html` with an empty body for tracks it cannot resolve
 * (measured 2026-11-05), which a browser reports as `MediaError.code 4`. Checking
 * here turns that into an honest "try the provider" instead of a silent dead
 * <audio>. Only a small prefix is read; the visitor's browser fetches the media.
 */
async function probeRelay(url: string, options: MusicOptions): Promise<boolean> {
  const fetchImpl = options.fetch ?? ((u: string, init: RequestInit) => fetch(u, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs ?? 4000, 6000));
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { range: 'bytes=0-2047', accept: 'audio/*,*/*' },
    });
    if (!res.ok) return false;
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    // The relay serves real audio as audio/*; anything else means "not playable".
    if (!type.startsWith('audio/') && type !== 'application/octet-stream') return false;
    const reader = res.body?.getReader();
    if (!reader) return false;
    let head = new Uint8Array(0);
    try {
      const { value } = await reader.read();
      if (value) head = value.subarray(0, 12);
    } finally {
      void reader.cancel().catch(() => {});
    }
    if (head.length < 4) return false;
    const ascii = (s: number, n: number) => String.fromCharCode(...head.subarray(s, s + n));
    const mp3 = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
    return ascii(0, 3) === 'ID3' || mp3 || ascii(0, 4) === 'fLaC' || ascii(0, 4) === 'OggS' || ascii(4, 4) === 'ftyp';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
const CACHE = {
  list: 'public, max-age=300',
  search: 'public, max-age=300',
  lyric: 'public, max-age=86400',
  pic: 'public, max-age=86400',
  none: 'no-store',
};

function json(data: unknown, cache = CACHE.none, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
      'x-robots-tag': 'noindex',
    },
  });
}

/** Injectable fetch + deadlines keep failure tests deterministic and network-free. */
export function createMusicApi(options: MusicOptions = {}) {
  return async (url: URL): Promise<Response> => {
    try {
      const session = new MusicSession(options);
      const p = url.searchParams;
      const action = url.pathname.slice(MUSIC_API_PREFIX.length);
      if (!url.pathname.startsWith(MUSIC_API_PREFIX)) return json({ error: '没有这个接口' }, CACHE.none, 404);
      if (action === 'list') {
        const id = p.get('id') ?? '';
        if (!isChartId(id)) throw new MusicError(400, '不认识这个榜单');
        return json(await session.playlist(id), CACHE.list);
      }
      if (action === 'search') {
        const query = (p.get('q') ?? '').trim();
        if (!query) throw new MusicError(400, '要搜什么');
        if ([...query].length > SEARCH_MAX_Q) throw new MusicError(400, `关键词最多 ${SEARCH_MAX_Q} 个字`);
        const n = Number(p.get('n'));
        const limit = Number.isFinite(n) ? Math.min(SEARCH_MAX_N, Math.max(1, Math.trunc(n) || 12)) : 12;
        return json(await session.search(query, limit), CACHE.search);
      }
      if (!['url', 'pic', 'lyric'].includes(action)) return json({ error: '没有这个接口' }, CACHE.none, 404);
      const id = musicId(p.get('id'));
      const source = p.get('source');
      if (!id || !source) throw new MusicError(400, '缺参数或歌曲编号不对');
      if (source !== 'netease') throw new MusicError(422, '旧曲源暂不支持，请重新搜索这首歌；站内曲目仍可播放');
      // `sign` belonged to the retired proxy, not to NetEase authorization. New
      // records still carry a marker for old frontends; old signatures are ignored.
      if (action === 'url') {
        /* Playback must not depend on the Worker's egress. NetEase's player/url
           refuses datacenter ranges (measured 2026-11-03: 8/8 songs rejected from
           Cloudflare while 3/8 worked from an ordinary IP), and the official
           `song/media/outer/url` shortcut 302s to `/404` for many tracks
           (measured 2026-11-05). Neither is a rights verdict, so surfacing
           "membership/copyright" was wrong.

           The relay below answers with real audio bytes + `ACAO: *`, so the
           visitor's browser fetches and plays it directly (the Worker never
           proxies media). It is tried first because it is the only path measured
           to play for the default playlist; the official provider stays as the
           fallback for tracks the relay lacks. */
        const relay = directAudioUrl(id);
        if (relay) {
          const ok = await probeRelay(relay, options);
          if (ok) return json({ url: relay, verified: true, via: 'relay' }, CACHE.none);
        }
        try {
          return json(await session.link(id));
        } catch (error) {
          if (error instanceof MusicError && error.status === 403) {
            return json({ error: error.message }, CACHE.none, 403);
          }
          throw error;
        }
      }
      const song = musicId(p.get('song'));
      if (!song) throw new MusicError(400, action === 'pic' ? '缺参数（封面还要 song）' : '缺参数（歌词还要 song）');
      if (action === 'pic') return json({ url: await session.picture(song) }, CACHE.pic);
      const lyrics = await session.lyrics(song);
      return json(lyrics, lyrics.lyric ? CACHE.lyric : CACHE.none);
    } catch (error) {
      return error instanceof MusicError
        ? json({ error: error.message }, CACHE.none, error.status)
        : json({ error: '曲库暂时连不上，请稍后重试；站内曲目仍可播放' }, CACHE.none, 502);
    }
  };
}

export const musicApi = createMusicApi();
