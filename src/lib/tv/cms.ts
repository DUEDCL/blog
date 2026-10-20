/**
 * 苹果CMS（MacCMS V10）聚合层 —— 搜索融合、详情解析、线路可播性判定。
 *
 * ---------------------------------------------------------------------------
 * 搜索逻辑为什么要这么写（改之前先读这段）
 * ---------------------------------------------------------------------------
 * 1. **并发 + 单源死线**：十来个源同时发。每个源给一个硬死线（TV_TUNING.sourceTimeoutMs），
 *    到点 AbortController 掐断，只丢这一个源 —— 不能因为一个源慢就让整页转圈。
 *    用 Promise.allSettled 而不是 all：失败的源变成一行「不可用」的状态记录。
 *
 * 2. **按页数翻页**：MacCMS 的 `ac=videolist` 返回 `pagecount`。第一页回来后，
 *    如果 `pagecount > 1` 再并发抓第 2 页（上限 maxPagesPerSource）。
 *    为什么不一次翻到 20 页：搜索场景下第二页之后基本是「解说」「预告」这类噪声，
 *    收益远低于延迟代价。翻页与第一页**并发发起**（先发 pg=2，第一页说只有 1 页就丢弃）。
 *    这样多出来的延迟约等于 0。
 *
 * 3. **熔断**：源连续失败 failThreshold 次就在内存里冷却 cooldownMs。
 *    Worker isolate 生命周期内有效 —— 这不是持久化，只是让同一批并发访客
 *    不反复去撞一个已经挂掉的域名。冷却表按 api 存，热更新部署后自然清空。
 *
 * 4. **跨源融合**：不同源对同一部剧的标题有细微差别（「庆余年第二季」vs「庆余年 第二季」），
 *    用 normTitle() 去掉所有空白与标点后归并成一张卡。**年份不参与分组** ——
 *    同名不同季在源站本来就是不同 vod，靠标题里的「第二季」区分；
 *    把年份放进 key 会把「同剧不同源转录成年份不一致」的情况拆成两张卡。
 *    年份只用于显示与打分（见 scoreGroup）。
 *
 * 5. **打分排序**（scoreGroup）：相关性（精确 > 前缀 > 包含）为主，
 *    源命中数为辅，再给「有可直连 m3u8 线路」加分。这一项是本页最影响体感的地方：
 *    用户点开第一张卡就应该能播。
 *
 * 6. **组内候选排序**：可直连的源在前（hasHls），然后线路多、集数多的在前。
 *    详情页因此默认落在最可能播得起来的那个源上。
 */

import { TV_TUNING, type VodSource } from './sources';

/* ────────────────────────────── 类型 ────────────────────────────── */

/** 一条线路能否直接播 */
export type LineKind = 'hls' | 'file' | 'unknown' | 'page';

export interface Episode {
  name: string;
  url: string;
}

export interface PlayLine {
  from: string;
  kind: LineKind;
  episodes: Episode[];
}

export interface Vod {
  vodId: string;
  name: string;
  pic: string;
  remarks: string;
  typeName: string;
  year: string;
  area: string;
  actor: string;
  director: string;
  score: string;
  content: string;
  lines: PlayLine[];
  sourceId: string;
  sourceName: string;
}

export interface Candidate {
  sourceId: string;
  sourceName: string;
  vodId: string;
  remarks: string;
  hasHls: boolean;
  lineCount: number;
  episodeCount: number;
}

export interface Group {
  key: string;
  name: string;
  year: string;
  pic: string;
  typeName: string;
  area: string;
  remarks: string;
  score: number;
  candidates: Candidate[];
}

export interface SourceReport {
  id: string;
  name: string;
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
}

export interface SearchResult {
  q: string;
  page: number;
  tookMs: number;
  groups: Group[];
  sources: SourceReport[];
}

/* ────────────────────────────── 归一化 ────────────────────────────── */

/** 全角 ASCII → 半角；顺手压掉首尾空白。用户从中文输入法带出来的全角字符很常见 */
export function normalizeQuery(raw: string): string {
  let s = (raw ?? '').trim();
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, ' ');
  return s.replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * 标题归并用的键：去掉一切空白与标点，只留中日韩字符、字母、数字。
 * 「庆余年 第二季」「庆余年第二季」（空格差异）→ 同一个键；
 * 「流浪地球2」与「流浪地球 2」→ 同一个键。
 */
export function normTitle(title: string): string {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!-/:-@[-`{-~\u2000-\u206F\u3000-\u303F\uFF00-\uFFEF]/g, '')
    .trim();
}

/** 去 HTML 标签 + 解码最常见的几个实体（简介字段） */
function stripHtml(html: string): string {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ──────────────────────────── 线路可播性 ──────────────────────────── */

/**
 * 判断一条线路能否直接被浏览器播。
 *
 * 资源站常见的几类线路：
 *   - `xxxm3u8` / `xxxm3u8u`  → 直链 HLS（分片多数带 Access-Control-Allow-Origin: *）
 *   - `feifan` / `liangzi` / `dytt` / `gsyun` / `jsyun` → 播放器分享页（`/share/…`），
 *     要网页里的 JS 解析，<video> 拿不到，hls.js 也播不了
 *   - `qq` / `qiyi` / `youku` → **直接指向腾讯视频/爱奇艺/优酷的官网剧集页**。
 *     这类最坑：列表有、集数齐、看起来像正常线路，但地址是正版平台的网页，
 *     要登录+会员，`<video>` 一定播不出来。实测「红果资源」的两条线路就是这种，
 *     所以整个源被剔出清单（见 sources.ts 注释）。
 * 判错过一次的代价是用户点了「第1集」看半天转圈，所以这里按 URL 形态判而不是按名字猜，
 * 名字只作为最后兜底。
 */
export function classifyLine(from: string, episodes: Episode[]): LineKind {
  const first = episodes[0]?.url ?? '';
  if (/\.m3u8(\?|#|$)/i.test(first) || /m3u8/i.test(first)) return 'hls';
  if (/\.mp4(\?|#|$)/i.test(first)) return 'file';
  if (/\/share\//i.test(first)) return 'page';
  // 正版平台的网页播放页：v.qq.com / iqiyi.com / youku.com / mgtv / bilibili / tv.sohu.com …
  if (
    /^https?:\/\/([a-z0-9-]+\.)*(v\.qq\.com|qq\.com|iqiyi\.com|youku\.com|mgtv\.com|bilibili\.com|sohu\.com|le\.com|pptv\.com|miguvideo\.com|wasu\.cn)\//i.test(
      first
    )
  ) {
    return 'page';
  }
  if (/m3u8/i.test(from)) return 'hls';
  // `/play/<id>` 这种是播放器页，不是直链
  if (/^https?:\/\/[^/]+\/play\/[^/?#]+\/?$/i.test(first)) return 'page';
  return 'unknown';
}

const LINE_RANK: Record<LineKind, number> = { hls: 0, file: 1, unknown: 2, page: 3 };

/**
 * 解析 `vod_play_from` / `vod_play_url`。
 * 格式：多条线路用 `$$$` 分隔；线路内剧集用 `#` 分隔；单集是 `名称$地址`。
 * 返回按可播性排序（可直连的在前）。
 */
export function splitPlay(vodPlayFrom: string, vodPlayUrl: string): PlayLine[] {
  const froms = String(vodPlayFrom ?? '')
    .split('$$$')
    .map((s) => s.trim());
  const groups = String(vodPlayUrl ?? '').split('$$$');
  const lines: PlayLine[] = [];

  groups.forEach((group, gi) => {
    const label = froms[gi] || `线路${gi + 1}`;
    const episodes: Episode[] = [];
    for (const item of group.split('#')) {
      const piece = item.trim();
      if (!piece) continue;
      const sep = piece.indexOf('$');
      if (sep === -1) {
        if (/^https?:\/\//i.test(piece)) {
          episodes.push({ name: `第${episodes.length + 1}集`, url: piece });
        }
        continue;
      }
      const name = piece.slice(0, sep).trim() || `第${episodes.length + 1}集`;
      const url = piece.slice(sep + 1).trim();
      if (url) episodes.push({ name, url });
    }
    if (episodes.length) lines.push({ from: label, kind: classifyLine(label, episodes), episodes });
  });

  lines.sort((a, b) => LINE_RANK[a.kind] - LINE_RANK[b.kind]);
  return lines;
}

/* ───────────────────────────── 单条规范化 ───────────────────────────── */

interface RawVod {
  vod_id?: unknown;
  vod_name?: unknown;
  vod_pic?: unknown;
  vod_remarks?: unknown;
  type_name?: unknown;
  vod_year?: unknown;
  vod_area?: unknown;
  vod_actor?: unknown;
  vod_director?: unknown;
  vod_score?: unknown;
  vod_content?: unknown;
  vod_play_from?: unknown;
  vod_play_url?: unknown;
  [k: string]: unknown;
}

export function normalizeVod(item: RawVod, source: VodSource): Vod | null {
  const vodId = String(item.vod_id ?? '').trim();
  const name = String(item.vod_name ?? '').trim();
  if (!vodId || !name) return null;
  return {
    vodId,
    name,
    pic: String(item.vod_pic ?? '').trim(),
    remarks: String(item.vod_remarks ?? '').trim(),
    typeName: String(item.type_name ?? '').trim(),
    year: String(item.vod_year ?? '').trim(),
    area: String(item.vod_area ?? '').trim(),
    actor: String(item.vod_actor ?? '').trim(),
    director: String(item.vod_director ?? '').trim(),
    score: String(item.vod_score ?? '').trim(),
    content: stripHtml(String(item.vod_content ?? '')).slice(0, 600),
    lines: splitPlay(String(item.vod_play_from ?? ''), String(item.vod_play_url ?? '')),
    sourceId: source.id,
    sourceName: source.name,
  };
}

/* ──────────────────────────── 源健康度（熔断） ──────────────────────────── */

interface Health {
  fails: number;
  until: number;
}

const health = new Map<string, Health>();

function isCoolingDown(api: string, now: number): boolean {
  const h = health.get(api);
  return !!h && h.until > now;
}

function recordFail(api: string, now: number): void {
  const h = health.get(api) ?? { fails: 0, until: 0 };
  h.fails += 1;
  if (h.fails >= TV_TUNING.failThreshold) {
    h.until = now + TV_TUNING.cooldownMs;
    h.fails = 0;
  }
  health.set(api, h);
}

function recordOk(api: string): void {
  if (health.has(api)) health.delete(api);
}

/* ────────────────────────────── 网络 ────────────────────────────── */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 统一的上游抓取：UA、超时、JSON 解析。抛出的 message 都是能直接给访客看的中文 */
async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // 资源站挂掉时常常回一整页 HTML 或「暂不支持搜索」
    throw new Error(text.slice(0, 40).includes('<') ? '返回了网页而不是数据' : '返回内容不是 JSON');
  }
}

function buildUrl(api: string, params: Record<string, string>): string {
  const u = new URL(api);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function pickList(payload: unknown): RawVod[] {
  const p = payload as { list?: unknown; data?: unknown } | null;
  const arr = Array.isArray(p?.list) ? p.list : Array.isArray(p?.data) ? p.data : [];
  return arr as RawVod[];
}

function pickPageCount(payload: unknown): number {
  const p = payload as { pagecount?: unknown; total?: unknown } | null;
  const n = Number(p?.pagecount ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/* ────────────────────────────── 搜索单源 ────────────────────────────── */

/**
 * 单源搜索：第一页 + （若还有页）第二页并发。
 * 返回该源的全部条目（已按 vod_id 去重、已截断）。
 *
 * `allowSecondPage=false` 时只抓第一页 —— 见 search() 里那段「subrequest 预算」。
 */
async function searchSource(
  source: VodSource,
  q: string,
  page: number,
  allowSecondPage: boolean
): Promise<Vod[]> {
  const deadline = TV_TUNING.sourceTimeoutMs;
  const nextPage = page + 1;
  const cap = TV_TUNING.maxItemsPerPage;

  const firstUrl = buildUrl(source.api, { ac: 'videolist', wd: q, pg: String(page) });
  const firstPromise = fetchJson(firstUrl, deadline);

  // 先手发出第二页：第一页回来若说只有 1 页，这个结果直接丢弃。
  // 代价是一次可能白跑的请求，换来的是「多页」场景下少一个 RTT 的串行等待。
  let secondPromise: Promise<unknown> | null = null;
  if (allowSecondPage) {
    const secondUrl = buildUrl(source.api, { ac: 'videolist', wd: q, pg: String(nextPage) });
    secondPromise = fetchJson(secondUrl, deadline).catch(() => null);
  }

  const firstPayload = await firstPromise;
  const items: Vod[] = [];
  const seen = new Set<string>();

  const take = (payload: unknown) => {
    for (const raw of pickList(payload)) {
      if (items.length >= cap) return;
      const v = normalizeVod(raw, source);
      if (!v || seen.has(v.vodId)) continue;
      seen.add(v.vodId);
      items.push(v);
    }
  };

  take(firstPayload);

  if (secondPromise && pickPageCount(firstPayload) > 1) {
    const second = await secondPromise;
    if (second) take(second);
  }

  return items;
}

/* ────────────────────────────── 融合与打分 ────────────────────────────── */

/** 标题对查询词的相关性：精确 100 / 前缀 80 / 包含 60 / 其它 20 */
function relevance(name: string, q: string): number {
  const n = normTitle(name);
  const k = normTitle(q);
  if (!k) return 20;
  if (n === k) return 100;
  if (n.startsWith(k)) return 80;
  if (n.includes(k)) return 60;
  return 20;
}

function scoreGroup(g: Group, q: string): number {
  const base = relevance(g.name, q);
  const srcBonus = Math.min(g.candidates.length, 8) * 5; // 最多 40
  const hlsBonus = g.candidates.some((c) => c.hasHls) ? 15 : 0;
  const picBonus = g.pic ? 3 : 0;
  // 条目里有「已完结 / 全36集 / 更新至」这类备注的，多半是正片而不是预告/解说
  const remarkBonus = /已完结|全集|全\d+集|更新至|完结/.test(g.remarks) ? 6 : 0;
  return base + srcBonus + hlsBonus + picBonus + remarkBonus;
}

function rankCandidates(cands: Candidate[]): Candidate[] {
  return cands.sort(
    (a, b) =>
      Number(b.hasHls) - Number(a.hasHls) ||
      b.lineCount - a.lineCount ||
      b.episodeCount - a.episodeCount ||
      a.sourceName.localeCompare(b.sourceName)
  );
}

/** 把多源条目融成卡片并排序 */
export function fuse(items: Vod[], q: string): Group[] {
  const map = new Map<string, Group>();

  for (const v of items) {
    const key = normTitle(v.name) || v.vodId;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        name: v.name,
        year: v.year,
        pic: v.pic,
        typeName: v.typeName,
        area: v.area,
        remarks: v.remarks,
        score: 0,
        candidates: [],
      };
      map.set(key, g);
    }
    // 元信息补全：先到先得，但缺的用后面的补
    if (!g.pic && v.pic) g.pic = v.pic;
    if (!g.year && v.year) g.year = v.year;
    if (!g.typeName && v.typeName) g.typeName = v.typeName;
    if (!g.area && v.area) g.area = v.area;
    if (!g.remarks && v.remarks) g.remarks = v.remarks;

    if (g.candidates.some((c) => c.sourceId === v.sourceId)) continue; // 同源同名只留第一条

    g.candidates.push({
      sourceId: v.sourceId,
      sourceName: v.sourceName,
      vodId: v.vodId,
      remarks: v.remarks,
      hasHls: v.lines.some((l) => l.kind === 'hls'),
      lineCount: v.lines.length,
      episodeCount: v.lines.reduce((n, l) => n + l.episodes.length, 0),
    });
  }

  const groups = [...map.values()];
  for (const g of groups) {
    g.candidates = rankCandidates(g.candidates);
    g.score = scoreGroup(g, q);
    // 卡片备注取「最可播那个候选」的备注
    if (!g.remarks) g.remarks = g.candidates[0]?.remarks ?? '';
  }

  groups.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return groups;
}

/* ────────────────────────────── 对外 API 层 ────────────────────────────── */

export interface SearchOptions {
  /** 只搜这些源 id；空 = 全部启用的源 */
  only?: string[];
  page?: number;
}

/** 聚合搜索：并发、熔断、融合、打分，一次完成 */
export async function search(
  sources: VodSource[],
  rawQ: string,
  opts: SearchOptions = {}
): Promise<SearchResult> {
  const q = normalizeQuery(rawQ);
  const page = Math.max(1, Math.min(20, opts.page ?? 1));
  if (!q) return { q, page, tookMs: 0, groups: [], sources: [] };

  const now = Date.now();
  const targets = sources.filter(
    (s) => (!opts.only?.length || opts.only.includes(s.id)) && !isCoolingDown(s.api, now)
  );

  const started = Date.now();

  /* subrequest 预算：Cloudflare Workers 免费档一次请求最多 50 个 subrequest。
     翻页是「每源多一次请求」，17 个源全翻两页就是 34 个，再加上重定向与并发源失效
     后的重试，离上限太近。所以源多的时候自动不翻页 —— 第一页已经能覆盖关键词搜索
     的绝大部分结果（第二页之后基本是解说与预告噪声）。源少的时候才翻，那时预算富余。 */
  const subrequestBudget = 40;
  const allowSecondPage =
    TV_TUNING.maxPagesPerSource > 1 && targets.length * TV_TUNING.maxPagesPerSource <= subrequestBudget;

  const settled = await Promise.allSettled(
    targets.map(async (s) => {
      try {
        const items = await searchSource(s, q, page, allowSecondPage);
        recordOk(s.api);
        return { source: s, items };
      } catch (e) {
        recordFail(s.api, Date.now());
        throw e;
      }
    })
  );

  const allItems: Vod[] = [];
  const report: SourceReport[] = [];

  settled.forEach((r, i) => {
    const s = targets[i];
    if (r.status === 'fulfilled') {
      allItems.push(...r.value.items);
      report.push({ id: s.id, name: s.name, ok: true, count: r.value.items.length, ms: 0 });
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      report.push({ id: s.id, name: s.name, ok: false, count: 0, ms: 0, error: msg });
    }
  });

  // 被熔断跳过的源也如实告知，别让用户以为「就这几个源」
  for (const s of sources) {
    if (targets.some((t) => t.id === s.id)) continue;
    if (opts.only?.length && !opts.only.includes(s.id)) continue;
    report.push({
      id: s.id,
      name: s.name,
      ok: false,
      count: 0,
      ms: 0,
      error: '暂时停用（近期连续失败）',
    });
  }

  const groups = fuse(allItems, q);
  return { q, page, tookMs: Date.now() - started, groups, sources: report };
}

/** 单源详情。返回的 lines 已按可播性排序 */
export async function detail(source: VodSource, vodId: string): Promise<Vod> {
  const url = buildUrl(source.api, { ac: 'detail', ids: vodId });
  const payload = await fetchJson(url, TV_TUNING.sourceTimeoutMs + 2500);
  const list = pickList(payload);
  const hit = list.find((it) => String(it.vod_id ?? '') === vodId) ?? list[0];
  if (!hit) throw new Error('资源站没有返回这部片子');
  const vod = normalizeVod(hit, source);
  if (!vod) throw new Error('资源站返回的数据不完整');
  return vod;
}
