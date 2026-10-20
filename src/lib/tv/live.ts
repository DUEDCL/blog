/**
 * 直播源解析 —— 两种公开格式，按内容自动识别。
 *
 * 1. **M3U**（iptv-org、zbds 的 .m3u）
 *      #EXTINF:-1 tvg-logo="…" group-title="央视",CCTV-1
 *      http://…/cctv1.m3u8
 *
 * 2. **TVBOX 文本**（zbds 的 .txt）
 *      央视频道,#genre#
 *      CCTV-1,http://…/cctv1.m3u8
 *      卫视频道,#genre#
 *      湖南卫视,http://…/hunan.m3u8
 *    `名称,#genre#` 那一行开启一个新分组，`名称,地址` 是频道。
 *
 * 只做解析，不改写地址：直播流多数带 CORS，浏览器直连即可（不占 Worker 媒体配额）。
 * 少数不带 CORS 的由前端播放器报错后提示换台，不做兜底代理 —— 直播是长连接，
 * 中转一整路电视流的配额代价远高于点播的一段分片。
 */

export interface LiveChannel {
  name: string;
  url: string;
  group: string;
  logo: string;
}

export interface LivePlaylistResult {
  id: string;
  name: string;
  ok: boolean;
  channels: LiveChannel[];
  error?: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 解析 M3U */
export function parseM3U(text: string, fallbackGroup = '未分组'): LiveChannel[] {
  const out: LiveChannel[] = [];
  let pending: { name: string; group: string; logo: string } | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const name = (line.split(',').pop() ?? '').trim();
      const group = (line.match(/group-title="([^"]*)"/i)?.[1] ?? fallbackGroup) || fallbackGroup;
      const logo = line.match(/tvg-logo="([^"]*)"/i)?.[1] ?? '';
      pending = { name, group, logo };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!pending) continue;
    if (/^https?:\/\//i.test(line)) {
      out.push({ name: pending.name || '未命名', url: line, group: pending.group, logo: pending.logo });
    }
    pending = null;
  }
  return out;
}

/** 解析 TVBOX `#genre#` 文本 */
export function parseTvBoxTxt(text: string): LiveChannel[] {
  const out: LiveChannel[] = [];
  let group = '未分组';

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(',');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();
    if (rest === '#genre#') {
      group = name || '未分组';
      continue;
    }
    if (!name || !/^https?:\/\//i.test(rest)) continue;
    out.push({ name, url: rest, group, logo: '' });
  }
  return out;
}

/** 按内容自动识别格式 */
export function parsePlaylistText(text: string, fallbackGroup?: string): LiveChannel[] {
  if (/#EXTM3U|#EXTINF/i.test(text)) return parseM3U(text, fallbackGroup);
  return parseTvBoxTxt(text);
}

/** 抓取并解析一路直播源 */
export async function loadLivePlaylist(
  id: string,
  name: string,
  url: string,
  timeoutMs = 9000
): Promise<LivePlaylistResult> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const channels = parsePlaylistText(text, name);
    if (!channels.length) throw new Error('没解析出频道（格式不支持或内容为空）');
    return { id, name, ok: true, channels };
  } catch (e) {
    return {
      id,
      name,
      ok: false,
      channels: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
