/**
 * Anonymous, read-only music metadata and playback. No login cookies, paid-account
 * credentials, cross-song substitution or unlock services are used here.
 *
 * 2026-11-03 probes: both official hosts returned search/detail/lyrics/player JSON.
 * /api/v6/playlist/detail exposes all 315 public IDs for the default playlist but
 * only six expanded tracks; public song/detail fills those IDs in bounded batches.
 * The old /api/playlist/detail returned HTTP 200 + code 20001 for that playlist.
 *
 * Meting is a metadata-only fallback. injahow has no search operation; i-meto's
 * search/list were valid but its audio redirect returned 404. A list's URL field
 * is therefore NEVER accepted as evidence of playable audio.
 */
import { LIST_MAX_N, type JukeTrack } from '../../data/jukebox';

export type MusicFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface MusicOptions {
  fetch?: MusicFetch;
  timeoutMs?: number;
  totalTimeoutMs?: number;
}

const OFFICIAL = ['https://music.163.com', 'https://interface.music.163.com'] as const;
const METING = ['https://api.injahow.cn/meting/', 'https://api.i-meto.com/meting/api'] as const;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const HAS_STAMP = /\[\d{1,3}:\d{1,2}(?:[.:]\d+)?\]/;
const SIGN = 'netease-public-v1'; // Compatibility marker, NOT an authentication token.

export class MusicError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const broken = () => new MusicError(502, '曲库暂时连不上，请稍后重试；站内曲目仍可播放');
const unavailable = () => new MusicError(403, '这首歌暂不支持匿名播放，可能受会员、版权或地区限制；请在官方客户端收听');
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';

/** IDs are opaque decimal strings. Do not round large image IDs through Number. */
export function musicId(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value);
  return /^[1-9]\d{0,19}$/.test(id) ? id : '';
}

function checked(data: unknown): Record<string, unknown> {
  const root = object(data);
  if (root.code !== 200) throw broken();
  return root;
}

function track(raw: unknown): JukeTrack | null {
  const row = object(raw);
  const songId = musicId(row.id);
  const title = text(row.name).trim();
  const artists = row.ar ?? row.artists;
  const album = object(row.al ?? row.album);
  if (!songId || !title || !Array.isArray(artists)) return null;
  return {
    songId, title,
    artist: artists.map(a => text(object(a).name)).filter(Boolean).join(' / '),
    album: text(album.name),
    urlId: songId,
    lyricId: songId,
    // New records use songId here. The pic route resolves by `song`, so old image
    // IDs and old sign values in persisted queues remain compatible as well.
    picId: songId,
    source: 'netease',
    sign: SIGN,
  };
}

function tracks(raw: unknown, limit: number, allowEmpty: boolean): JukeTrack[] {
  if (!Array.isArray(raw)) throw broken();
  if (!raw.length) {
    if (allowEmpty) return [];
    throw broken();
  }
  const items = raw.map(track).filter((t): t is JukeTrack => t !== null);
  // A malformed 200 must not become a successful, cached empty list.
  if (!items.length) throw broken();
  return items.slice(0, limit);
}

/** Only official CDN locations can leave this adapter or be range-probed. */
export function mediaUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 4096) return '';
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return '';
    if (!/^[a-z0-9-]+\.music\.126\.net$/i.test(url.hostname)) return '';
    // Official API still returns HTTP links; this same CDN was tested over TLS.
    url.protocol = 'https:';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

function metingTracks(data: unknown, base: string, limit: number, allowEmpty: boolean): JukeTrack[] {
  if (!Array.isArray(data)) throw broken();
  const items: JukeTrack[] = [];
  for (const raw of data) {
    const row = object(raw);
    const title = text(row.name ?? row.title).trim();
    try {
      const link = new URL(text(row.url));
      const expected = new URL(base);
      if (link.origin !== expected.origin || link.pathname !== expected.pathname || link.username || link.password) continue;
      if (link.searchParams.get('server') !== 'netease' || link.searchParams.get('type') !== 'url') continue;
      const songId = musicId(link.searchParams.get('id'));
      if (!songId || !title) continue;
      items.push({
        songId, title, artist: text(row.artist ?? row.author), album: '',
        urlId: songId, lyricId: songId, picId: songId, source: 'netease', sign: SIGN,
      });
      if (items.length >= limit) break;
    } catch { /* Discard malformed records, never follow provider-supplied URLs. */ }
  }
  if (!items.length && (data.length || !allowEmpty)) throw broken();
  return items;
}

export interface MusicList {
  items: JukeTrack[];
  partial?: boolean;
  total?: number;
}

export interface MusicLink {
  url: string;
  bytes?: number;
  short?: boolean;
  preview?: boolean;
  /** True only when the Worker itself fetched a valid media prefix (see link()). */
  verified?: boolean;
}

/** One session per public request; its deadline covers headers AND body reads. */
export class MusicSession {
  private readonly fetcher: MusicFetch;
  private readonly timeoutMs: number;
  private readonly deadline: number;

  constructor(options: MusicOptions = {}) {
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.deadline = Date.now() + (options.totalTimeoutMs ?? 15000);
  }

  private async request<T>(url: string, read: (res: Response) => Promise<T>, headers?: HeadersInit): Promise<T> {
    const ms = Math.min(this.timeoutMs, this.deadline - Date.now());
    if (ms <= 0) throw broken();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(broken()); }, ms);
    });
    try {
      return await Promise.race([
        (async () => {
          const res = await this.fetcher(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
          try { return await read(res); }
          finally { if (!res.bodyUsed) void res.body?.cancel().catch(() => {}); }
        })(),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof MusicError) throw error;
      throw broken(); // Never expose provider text, raw URLs or network exception messages.
    } finally {
      clearTimeout(timer!);
      controller.abort();
    }
  }

  private async json(base: string, path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.request(url.href, async res => {
      if (!res.ok || !res.body) throw broken();
      if (/text\/html/i.test(res.headers.get('content-type') ?? '')) throw broken();
      const declared = Number(res.headers.get('content-length'));
      if (declared > MAX_JSON_BYTES) throw broken();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let body = '';
      let count = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          count += value.byteLength;
          if (count > MAX_JSON_BYTES) throw broken();
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
        return JSON.parse(body) as unknown;
      } finally { void reader.cancel().catch(() => {}); }
    }, { accept: 'application/json' });
  }

  private async official<T>(path: string, params: Record<string, string>, parse: (data: unknown) => T): Promise<T> {
    for (const base of OFFICIAL) {
      try { return parse(await this.json(base, path, params)); }
      catch (error) {
        // Explicit rights denial is final, not a reason to hunt for an unlock mirror.
        if (error instanceof MusicError && error.status !== 502) throw error;
      }
    }
    throw broken();
  }

  async search(query: string, limit: number): Promise<MusicList> {
    try {
      const items = await this.official('/api/search/get', { s: query, type: '1', offset: '0', limit: String(limit) }, data => {
        const result = object(checked(data).result);
        if (result.songCount === 0 && (result.songs === undefined || (Array.isArray(result.songs) && !result.songs.length))) return [];
        return tracks(result.songs, limit, result.songCount === 0);
      });
      return { items };
    } catch {
      // Only i-meto supports search. injahow returned HTTP 200 + unknown type.
      const base = METING[1];
      const data = await this.json(base, base, { server: 'netease', type: 'search', id: query });
      return { items: metingTracks(data, base, limit, true) };
    }
  }

  async playlist(id: string): Promise<MusicList> {
    try {
      const playlist = await this.official('/api/v6/playlist/detail', { id, n: String(LIST_MAX_N) }, data => {
        const row = object(checked(data).playlist);
        if (musicId(row.id) !== id || !Array.isArray(row.tracks) || !Array.isArray(row.trackIds)) throw broken();
        const ids = row.trackIds.map(it => musicId(object(it).id));
        if (ids.some(value => !value)) throw broken();
        const total = row.trackCount;
        if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) throw broken();
        // Do not mistake a valid partial response for the entire requested playlist.
        if (ids.length < Math.min(total, LIST_MAX_N)) throw broken();
        if (total > 0 && !ids.length) throw broken();
        return { row, ids: ids.slice(0, LIST_MAX_N), total };
      });
      const byId = new Map<string, JukeTrack>();
      for (const raw of playlist.row.tracks as unknown[]) {
        const t = track(raw);
        if (t) byId.set(t.songId, t);
      }
      const missing = playlist.ids.filter(songId => !byId.has(songId));
      // At most four bounded requests; preserve the published playlist order.
      for (let i = 0; i < missing.length; i += 100) {
        const ids = missing.slice(i, i + 100);
        const found = await this.official('/api/song/detail', { ids: JSON.stringify(ids) }, data => tracks(checked(data).songs, ids.length, false));
        for (const t of found) byId.set(t.songId, t);
      }
      const items = playlist.ids.map(songId => byId.get(songId)).filter((t): t is JukeTrack => !!t);
      if (items.length !== playlist.ids.length) throw broken();
      return {
        items,
        ...(playlist.total > items.length ? { partial: true, total: playlist.total } : {}),
      };
    } catch {
      for (const base of METING) {
        try {
          const data = await this.json(base, base, { server: 'netease', type: 'playlist', id });
          const items = metingTracks(data, base, LIST_MAX_N, false);
          return { items, ...(Array.isArray(data) && data.length > items.length ? { partial: true, total: data.length } : {}) };
        } catch { /* Try the next metadata service; audio is never delegated. */ }
      }
      throw broken();
    }
  }

  async lyrics(id: string): Promise<{ lyric: string; tlyric: string }> {
    return this.official('/api/song/lyric', { id, lv: '-1', tv: '-1' }, data => {
      const root = checked(data);
      const lyric = text(object(root.lrc).lyric);
      const tlyric = text(object(root.tlyric).lyric);
      // Explicit instrumental / absent lyrics is valid; HTML/error-shaped JSON is not.
      if (!root.nolyric && !root.uncollected && typeof object(root.lrc).lyric !== 'string') throw broken();
      return { lyric: HAS_STAMP.test(lyric) ? lyric : '', tlyric: HAS_STAMP.test(tlyric) ? tlyric : '' };
    });
  }

  async picture(id: string): Promise<string> {
    return this.official('/api/song/detail', { ids: JSON.stringify([id]) }, data => {
      const root = checked(data);
      if (!Array.isArray(root.songs)) throw broken();
      const row = root.songs.map(object).find(song => musicId(song.id) === id);
      if (!row) throw new MusicError(404, '这首歌暂时没有封面');
      const url = mediaUrl(object(row.al ?? row.album).picUrl);
      if (!url) throw broken();
      return url;
    });
  }

  async link(id: string): Promise<MusicLink> {
    const result = await this.official('/api/song/enhance/player/url', { ids: JSON.stringify([id]), br: '128000' }, data => {
      const root = checked(data);
      if (!Array.isArray(root.data)) throw broken();
      const row = root.data.map(object).find(song => musicId(song.id) === id);
      if (!row || typeof row.code !== 'number') throw broken();
      if ([-110, 403, 404, 451].includes(row.code) || (row.code === 200 && (row.url === null || row.url === ''))) throw unavailable();
      if (row.code !== 200) throw broken();
      const url = mediaUrl(row.url);
      if (!url) throw broken();
      return { url, preview: row.freeTrialInfo != null };
    });
    /* The Worker's own egress is a *datacenter* IP, while playback happens in the
       visitor's browser. This CDN rejects many datacenter ranges (the same class of
       problem already recorded for /tv), so a failed probe says nothing about whether
       the visitor can play it. The provider already returned code 200 + a URL above,
       and only that provider verdict may become a 403. Probing is therefore
       best-effort: a valid prefix adds `verified` + exact bytes, any refusal or
       abort returns the provider-issued URL unverified rather than hiding a song. */
    const base: MusicLink = { url: result.url, ...(result.preview ? { short: true, preview: true } : {}) };
    try {
      const probe = await this.probeAudio(result.url);
      return { ...base, url: probe.url, ...(probe.bytes ? { bytes: probe.bytes } : {}), verified: true };
    } catch {
      return base;
    }
  }

  private async probeAudio(link: string): Promise<{ url: string; bytes: number }> {
    let url = link;
    for (let redirects = 0; redirects <= 2; redirects++) {
      const response = await this.request(url, async res => {
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const next = mediaUrl(res.headers.get('location'));
          if (!next) throw broken();
          return { next };
        }
        if ([401, 403, 404, 451].includes(res.status)) throw unavailable();
        if (![200, 206].includes(res.status) || !res.body) throw broken();
        const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (!contentType.startsWith('audio/') && contentType !== 'application/octet-stream') throw broken();
        const reader = res.body.getReader();
        const prefix = new Uint8Array(512);
        let length = 0;
        try {
          while (length < prefix.length) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = value.subarray(0, prefix.length - length);
            prefix.set(chunk, length);
            length += chunk.length;
          }
        } finally { void reader.cancel().catch(() => {}); }
        const ascii = (start: number, count: number) => String.fromCharCode(...prefix.subarray(start, start + count));
        const mp3Frame = length >= 4 && prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0 && (prefix[1] & 0x06) !== 0;
        if (length < 12 || !(ascii(0, 3) === 'ID3' || mp3Frame || ascii(0, 4) === 'fLaC' || ascii(0, 4) === 'OggS' || ascii(4, 4) === 'ftyp')) throw broken();
        const range = /^bytes 0-\d+\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
        if (res.status === 206 && !range) throw broken();
        const bytes = Number(range?.[1] ?? (res.status === 200 ? res.headers.get('content-length') : 0));
        return { url, bytes: Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0 };
      }, { range: 'bytes=0-511' });
      if ('next' in response && response.next) { url = response.next; continue; }
      if ('url' in response && response.url) return { url: response.url, bytes: response.bytes ?? 0 };
      throw broken();
    }
    throw broken();
  }
}
