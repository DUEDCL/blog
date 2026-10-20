/**
 * HLS 播放列表改写 + 上游地址守门（SSRF 防护）。
 *
 * ---------------------------------------------------------------------------
 * 为什么不在这里中转媒体字节（本文件最重要的设计约束）
 * ---------------------------------------------------------------------------
 * 本站 Worker 的原则是「媒体字节一个都不进配额」——`src/worker.ts` 顶部那段注释写着。
 * 实测（2026-10，8 个点播源）：
 *
 *   源              m3u8 的 ACAO      分片 .ts 的 ACAO
 *   极速/量子/电影天堂/光速/暴风/百度   *                  *
 *   最大资源        *                  **无** ← 唯一例外
 *
 * 也就是说绝大多数源的分片本来就带 `Access-Control-Allow-Origin: *`，
 * 浏览器可以直接去 CDN 拉。所以这一层的做法是：
 *
 *   1. Worker 只取**播放列表文本**（几 KB），
 *   2. 把里面所有相对 URI 解析成**绝对的上游地址**，
 *   3. 原样返还给 hls.js，由浏览器直连 CDN 取分片。
 *
 * 只有 `proxy=1` 时才把分片 URI 改写成 `/api/tv/seg?u=…`（给「最大资源」这类
 * 分片不带 CORS 的源兜底）。前端在 hls.js 报致命网络错误时会自动降级重试一次，
 * 属例外路径，正常播放不消耗媒体配额。
 *
 * 另一个必须做的改写：**m3u8 里的路径几乎全是相对的**，而播放列表被代理到
 * `/api/tv/hls` 之后，浏览器的解析基准就变成了本站 —— 不改写的话
 * `index.m3u8` 里的 `2000k/hls/mixed.m3u8` 会被解析成
 * `https://本站/api/tv/2000k/hls/mixed.m3u8`，必然 404。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 本机 / 内网地址一律不放行 —— 这个接口的入参来自 query，必须自己守门 */
const PRIVATE_RE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1$|\[::1\]|fe80:|f[cd][0-9a-f]{2}:)/i;
const PRIVATE_172_RE = /^172\.(1[6-9]|2\d|3[01])\./;

export function assertPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('地址格式不对');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https 地址');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_RE.test(host) || PRIVATE_172_RE.test(host)) {
    throw new Error('内网地址不允许');
  }
  return u;
}

/** 取播放列表文本（只取文本，不取媒体） */
export async function fetchPlaylist(
  playlistUrl: string,
  referer: string | undefined,
  timeoutMs = 8000
): Promise<string> {
  const u = assertPublicUrl(playlistUrl);
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: '*/*' };
  if (referer) {
    try {
      const ref = assertPublicUrl(referer);
      headers.Referer = ref.toString();
      headers.Origin = ref.origin;
    } catch {
      /* referer 不合法就忽略，不影响主流程 */
    }
  }
  const res = await fetch(u.toString(), {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('#EXTM3U') && !text.includes('#EXTINF')) {
    throw new Error('上游返回的不是 m3u8 播放列表');
  }
  return text;
}

export interface RewriteOptions {
  /** 分片是否也走本站代理（只给分片不带 CORS 的源兜底用） */
  proxySegments: boolean;
  /** 代理分片时的同源前缀 */
  segPrefix?: string;
}

function encodeSeg(prefix: string, abs: string): string {
  return `${prefix}?u=${encodeURIComponent(abs)}`;
}

/**
 * 把播放列表里所有 URI 改写成绝对地址。
 *
 * 需要处理的三种位置：
 *   - 裸 URI 行（分片 / 子播放列表）
 *   - 标签属性 `URI="…"`（`EXT-X-KEY` 的密钥、`EXT-X-MAP` 的初始化段、
 *     `EXT-X-MEDIA` 的音轨、`EXT-X-I-FRAME-STREAM-INF` 的 I 帧列表）
 * 密钥（AES-128）也必须改写，否则浏览器会去本站取 `key.key` —— 同样 404。
 * 密钥同样带 CORS 时浏览器能直接解，所以默认也走绝对地址。
 */
export function rewritePlaylist(
  text: string,
  playlistUrl: string,
  opts: RewriteOptions
): string {
  const prefix = opts.segPrefix ?? '/api/tv/seg';

  const toTarget = (raw: string): string | null => {
    let abs: string;
    try {
      abs = new URL(raw, playlistUrl).toString();
    } catch {
      return null;
    }
    return opts.proxySegments ? encodeSeg(prefix, abs) : abs;
  };

  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      out.push('');
      continue;
    }
    if (line.startsWith('#')) {
      // 只改写带 URI="…" 的标签；其余标签原样保留
      out.push(
        line.replace(/URI="([^"]*)"/g, (whole, uri: string) => {
          const t = toTarget(uri);
          return t ? `URI="${t}"` : whole;
        })
      );
      continue;
    }
    const t = toTarget(line);
    out.push(t ?? line);
  }
  return out.join('\n');
}

/** 判读这份播放列表是不是多码率母列表 */
export function isMasterPlaylist(text: string): boolean {
  return text.includes('#EXT-X-STREAM-INF');
}
