/**
 * 唱片机的单例状态机 —— 全站只有这一份，跨页面导航不重启。
 *
 * 为什么必须是单例：R14 要「在网站其他地方正在播放的音乐不会停止」。
 * 唯一能做到不留裂口的路径是 Astro 的 View Transitions ——
 * `<ClientRouter />` 把站变成 SPA，`transition:persist="jk"` 让 MiniPlayer 那棵
 * 子树（含 `<audio>`）在换页时被**原样搬进新文档**，音频流一帧都不断。
 * 存进度再续播那条路不行：声音会有可听见的裂口，那不叫「不会停止」。
 *
 * 于是有了两条硬约束：
 * ① 这个模块是 bundled module script，**全站只执行一次**。所有状态（队列、当前曲、
 *    播放方式、歌词、洗牌袋）活在 `mount()` 的闭包里，天然跨导航存活。
 * ② 视图分两种，寿命完全不同：
 *    - **mini**（悬浮窗）：被 persist，节点跨导航是同一个对象，所以只绑一次。
 *    - **stage**（`/music` 页那台大的）：每次导航都是**新节点**，必须在
 *      `astro:page-load` 重新接线。旧节点连同它上面的监听一起被丢弃，不会累积。
 *    所有 paint 都要同时喂这两个视图，且 stage 一律先判空 —— 别处的页面没有它。
 *
 * 别在 `astro:page-load` 里往 `window`/`document` 加监听：那会每导航一次累积一层。
 * 需要全局监听的（resize、page-load 本身）都留在模块顶层，只绑一次。
 */
import { TRACKS, parseLrc, segment, type LrcLine } from '../data/music';
import type { JukeTrack } from '../data/jukebox';

/** 点歌进来的曲目要靠这几个字段去取直链与歌词；本地那首《特别的人》没有 ref */
interface Ref {
  songId: string;
  urlId: string;
  lyricId: string;
  /** 取封面用的 id。上游偶有记录不带它，空串就一直用文字标签 */
  picId: string;
  source: string;
  sign: string;
  /** 择优选源要用它去搜同名候选。不能拿 subtitle 顶替 —— 那是「歌手 · 专辑」 */
  artist: string;
}

interface Row {
  id: string;
  title: string;
  subtitle: string;
  /** 点歌进来的一开始是空的，等 /api/music/url 回来才填 */
  src: string;
  /**
   * 专辑封面。本地那首在 data/music.ts 里直接写死；点歌进来的一开始是空的，
   * 等 /api/music/pic 回来才填 —— 空串就是「用唱片原来的文字标签」。
   */
  cover: string;
  /** 0 表示未知（点歌的曲目没有预知时长），靠 durationchange 回填 */
  duration: number;
  /**
   * 歌词**存在状态里而不是 DOM 里**。R14 之前它只活在 `/music` 页的 `<ol>` 上，
   * SPA 导航会把那棵树整个换掉 —— 走一趟别的页面再回来，取过的歌词就没了。
   */
  lines: LrcLine[];
  ref?: Ref;
  /** 歌词只取一次，失败也不重试 —— 否则每次切回这首都要打一遍上游 */
  lyricDone?: boolean;
  /** 封面同理，只取一次 */
  picDone?: boolean;
}
/**
 * 播放方式。0 顺序（播到队尾停下）／1 列表循环／2 单曲循环／3 随机。
 * 默认 1 —— 这一档就是 R14 之前的既有行为，所以默认档不改变任何人已习惯的观感。
 * 存的是数字而不是名字：它要直接当 `data-m` 用，CSS 靠它决定露哪个图标。
 */
export const MODES = ['顺序播放', '列表循环', '单曲循环', '随机播放'] as const;

/**
 * 一个视图要实现的回调，**全部可选** —— 悬浮窗只关心前三个。
 * 单例不认识任何 DOM（除了那一个 `<audio>`），所有节点都归视图自己管。
 *
 * - `sync` 静态的那些变了：曲目、队列、播放态、模式、音量。视图自己从下面的
 *   读取函数重新取值，参数刻意不带 —— 带了就得为每种变化各开一个回调。
 * - `tick` 播放中每帧一次（rAF 在单例里，全站只有一份）。
 * - `lyric` 当前行下标 `k`（-1 = 还在前奏）与行内进度 `p`（0–1）。
 *   `changed` 为真表示换行了，视图这时才需要动 DOM 与滚动位置。
 */
export interface View {
  sync?(): void;
  tick?(): void;
  lyric?(k: number, p: number, changed: boolean): void;
  /** 点歌往队尾加了一首 */
  added?(i: number): void;
  /**
   * 搜索／榜单结果换了。刻意不复用 `sync` —— 那会让舞台白白重建队列与词表，
   * 而结果列表只有点歌台那一处在看。
   */
  res?(): void;
  /** 点歌台那一行状态字。空字符串是「清掉」 */
  say?(msg: string): void;
  /** 第 i 首取不到直链，why 是能直接显示的一句中文 */
  bad?(i: number, why: string): void;
}

/**
 * 逐段淡化的一行 —— 舞台与悬浮窗各持一个。
 *
 * 为什么按段拆而不在整行上铺一道渐变：background 的渐变按元素**盒子**的宽度铺，
 * 一行折成两个行盒时两个盒子共用同一道，第二行会跟着第一行同步点亮（第 18 轮报的
 * 「第二行跟着第一行滚动」就是这个）。切成一个个独立的 inline 盒子之后，
 * 每段自己一道渐变，与折不折行无关。
 *
 * 拉丁词不拆到字母（见 data/music.ts 的 segment），否则窄屏会在字母之间折行。
 */
export class WordRun {
  private host: HTMLElement | null = null;
  /** 这一行的原文：离开时要拿它把逐段 <span> 折回一个纯文本节点 */
  private raw = '';
  private words: HTMLElement[] = [];
  private at = -1;

  /** 接管一行。同一个元素同一段文字不重复拆 —— resize 后重挂也不会闪 */
  mount(el: HTMLElement, text: string) {
    if (this.host === el && this.raw === text) return;
    this.unmount();
    this.host = el;
    this.raw = text;
    this.words = segment(text).map((s) => {
      const w = document.createElement('span');
      w.className = 'jk-w';
      // 上游歌词是数据，一个字都不进 innerHTML
      w.textContent = s;
      return w;
    });
    this.at = -1;
    el.textContent = '';
    el.append(...this.words);
    el.classList.add('is-on');
  }

  /**
   * 交还这一行：撤掉高亮，把逐段 <span> 折回纯文本。
   * 必须还原 —— 不还原的话这一行会一直挂着上次唱到哪儿的 is-on／is-at，
   * 而且行里堆着几十个只在当前行有意义的节点。
   */
  unmount() {
    const el = this.host;
    if (!el) return;
    el.classList.remove('is-on');
    el.textContent = this.raw;
    this.host = null;
    this.raw = '';
    this.words = [];
    this.at = -1;
  }

  /**
   * 把整行的进度 p（0–1）画到段上：已唱的整段亮、未唱的整段暗、
   * 正在唱的那一段内部再走一道渐变（写它自己的 `--p`）。
   * 每帧只改 color 与 background-image，两个都不参与布局，所以不重排。
   * 跨段时把整行的 class 刷一遍（一行几十段、一秒最多跨几次），比维护增量便宜，
   * 而且往回拖进度条时也自然对齐，不会留下已亮的段。
   */
  paint(p: number) {
    const n = this.words.length;
    if (!n) return;
    const at = Math.min(n - 1, Math.floor(p * n));
    if (at !== this.at) {
      this.words.forEach((w, i) => {
        w.classList.toggle('is-on', i < at);
        w.classList.toggle('is-at', i === at);
      });
      this.at = at;
    }
    // 段内进度：整行的 p 落在这一段里的那一小截
    this.words[at].style.setProperty('--p', (p * n - at) * 100 + '%');
  }
}
/* ==========================================================================
   状态。全部是模块级变量 —— 这个模块全站只执行一次，所以它们天然跨导航存活。
   ========================================================================== */

/**
 * 队列。开头是 data/music.ts 里那首本地曲目，点歌只往**尾部**追加、
 * 永不删除也永不重排 —— 视图靠这条不变量把下标当稳定 key 用。
 */
const tracks: Row[] = TRACKS.map((t) => ({
  id: t.id,
  title: t.title,
  subtitle: t.subtitle,
  src: t.src,
  cover: t.cover,
  duration: t.duration,
  lines: parseLrc(t.lrc),
}));

/** `<audio>` 实体在 MiniPlayer 里（被 transition:persist 保住），这里只持引用 */
let au: HTMLAudioElement | null = null;
let idx = 0;
let mode = 1;
let vol = 0.8;
/** 播过一次之后悬浮窗才出现 —— 没听过歌的人不该被塞一个空播放器 */
let ever = false;

/** 洗牌袋（打乱的下标数组 + 指针）。每次 Math.random() 会连着抽到同一首 */
let bag: number[] = [];
let bagAt = 0;

/** 取直链的竞态令牌：连点两首时，先回来的旧结果要丢掉 */
let want = 0;
/** 当前展示的搜索／榜单结果。视图按钮上只放下标，对象留在这里 */
let found: JukeTrack[] = [];
/** 点歌台那一行状态字。存着是为了 /music 重新挂载时能回填 */
let msg = '挑个歌单，或者搜一下。';

let raf = 0;
/** 当前歌词行。-1 = 还在前奏；-2 是 relayout() 用来强制下一次广播算「换行」的哨兵 */
let onIdx = -1;

const views = new Set<View>();

/* ==========================================================================
   读取口。视图只能读，写一律走下面的动作函数 —— 状态只有一个改写入口。
   ========================================================================== */

export const list = () => tracks;
export const at = () => idx;
export const now = () => tracks[idx];
export const getMode = () => mode;
export const getVol = () => vol;
export const hits = () => found;
export const message = () => msg;
export const everPlayed = () => ever;
export const playing = () => !!au && !au.paused;
export const time = () => au?.currentTime ?? 0;
/** 时长以配置值优先：点歌的曲目没有预知时长，才让 <audio> 说话 */
export const dur = () => tracks[idx].duration || au?.duration || 0;
export const lineAt = (k: number) => tracks[idx].lines[k]?.text ?? '';
/** 当前曲目的封面路径／URL。空串 = 退回文字标签 */
export const coverOf = () => tracks[idx].cover;
/* ==========================================================================
   广播
   ========================================================================== */

function syncAll() {
  for (const v of views) v.sync?.();
}

/** 算当前行与行内进度，只在换行时把 changed 置真 */
function emitLyric() {
  const lines = tracks[idx].lines;
  const t = time();

  let k = -1;
  for (const [n, ln] of lines.entries()) {
    if (ln.time <= t + 0.06) k = n;
    else break;
  }

  const changed = k !== onIdx;
  onIdx = k;

  let p = 0;
  if (k >= 0) {
    /* 逐字淡化：LRC 只有行级时间戳，所以按「这一行从 t[k] 到 t[k+1]」线性插值。
       最后一行没有下一行，用总时长收尾；连总时长也不知道时给 4 秒兜底，
       免得 span<=0 让最后一行永远停在 0%。 */
    const from = lines[k].time;
    const end = lines[k + 1]?.time ?? (dur() || from + 4);
    const span = end - from;
    p = span > 0 ? Math.min(1, Math.max(0, (t - from) / span)) : 1;
  }

  for (const v of views) v.lyric?.(k, p, changed);
}

/**
 * 手动画一帧。rAF 只在播放时转，所以暂停态下的跳播（点歌词行、拖进度条、换曲）
 * 都得自己叫一次，否则要等下次播放才看到跳过去了。
 */
export function pulse() {
  for (const v of views) v.tick?.();
  emitLyric();
}

function tick() {
  if (!au || au.paused) {
    raf = 0;
    return;
  }
  for (const v of views) v.tick?.();
  // timeupdate 只有 4Hz，歌词会慢半拍，所以播放中走 rAF；暂停即停，不空转
  emitLyric();
  raf = requestAnimationFrame(tick);
}

/**
 * 视口变了：居中偏移与折行都要重算。把 onIdx 推到一个不可能的值，
 * 强制下一次广播认为「行变了」，视图于是重新拆段、重新对齐。
 */
export function relayout() {
  onIdx = -2;
  pulse();
}
/* ==========================================================================
   动作。视图只调这些，不直接碰 <audio>
   ========================================================================== */

function save(key: string, val: string) {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* 隐私模式下 localStorage 不可写：记不住而已，不该让播放器挂掉 */
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function reshuffle(exclude: number) {
  bag = tracks.map((_, i) => i);
  // Fisher-Yates
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  // 新一轮的头一首别正好是刚播完的那首，否则两轮交界处会连着响两遍同一首
  if (bag.length > 1 && bag[0] === exclude) [bag[0], bag[1]] = [bag[1], bag[0]];
  bagAt = 0;
}

function nextRandom(): number {
  // 长度不等说明点歌又加进来了。不重洗的话新加的那几首这一轮永远抽不到
  if (bagAt >= bag.length || bag.length !== tracks.length) reshuffle(idx);
  return bag[bagAt++];
}

export function load(i: number, play: boolean) {
  if (!au) return;
  idx = (i + tracks.length) % tracks.length;
  const t = tracks[idx];
  // 换歌就作废上一首还在路上的取直链请求 —— 连点两首时旧的会后回来
  const my = ++want;

  if (t.src) {
    // 同一首就别重设 src —— 重设会丢掉已缓冲的数据，重新发一次请求
    if (au.getAttribute('src') !== t.src) au.setAttribute('src', t.src);
  } else {
    // 点歌进来的还没有直链。先把上一首彻底卸掉：只 pause 的话，取直链失败时
    // 按一下播放会放出上一首的声音，而标题写着这一首
    au.pause();
    au.removeAttribute('src');
    au.load();
  }

  // 换歌回到词首。视图在 sync 里重建词表，再由 pulse 点亮当前行
  onIdx = -1;
  syncAll();
  pulse();

  if (t.src) {
    // 自动播放被策略拦掉就安静地停在暂停态，不弹任何东西
    if (play) void au.play().catch(() => {});
    return;
  }
  void resolve(my, idx, play);
}

export function toggle() {
  if (!au) return;
  if (au.paused) void au.play().catch(() => {});
  else au.pause();
}

export const prev = () => load(idx - 1, playing());
export const next = () => load(mode === 3 ? nextRandom() : idx + 1, playing());

export function seekTo(t: number) {
  if (!au) return;
  au.currentTime = t;
  if (au.paused) pulse();
}

export function cycleMode() {
  mode = (mode + 1) % MODES.length;
  if (au) au.loop = mode === 2;
  save('music:mode', String(mode));
  syncAll();
}

export function setVol(v: number) {
  vol = Math.min(1, Math.max(0, v));
  if (au) au.volume = vol;
  save('music:vol', String(vol));
  syncAll();
}
/* ==========================================================================
   点歌台。打的是自己的 Worker（src/worker.ts），不是上游
   ========================================================================== */

const txt = (v: unknown) => (typeof v === 'string' ? v : '');

/** 只写一处状态。空字符串就是清掉 */
function say(s: string) {
  msg = s;
  for (const v of views) v.say?.(s);
}

/**
 * 打自己的 Worker。抛出的 Error.message 一律是能直接显示给人看的一句中文 ——
 * Worker 的错误体就是 `{error:"…"}`，那些话都是我自己写的，可以原样转出来。
 */
async function api(path: string, params: Record<string, string>) {
  const u = new URL('/api/music/' + path, location.origin);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);

  let res: Response;
  try {
    // `cache: 'no-store'` —— 前端一律不吃 HTTP 缓存。Worker 给 list/search 的响应
    // 带着 `max-age=300`，那条头对浏览器同样生效：不关掉的话「改了歌单刷新看不到变化」
    // 会多出第二层原因（R23 报的就是这个，另一层在 Worker 的 caches.default）。
    // 命中与否从此只由边缘那 5 分钟决定，一处可控。
    res = await fetch(u, { headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch {
    throw new Error('网络没通，等会儿再试');
  }

  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new Error(txt(data?.error) || `没取到（${res.status}）`);
  if (!data) throw new Error('返回的不是 JSON');
  return data;
}

/** 拿直链。`my` 是进函数时的令牌，回来发现已经换歌了就整份丢掉 */
async function resolve(my: number, i: number, play: boolean) {
  const r = tracks[i].ref;
  if (!r || !au) return;

  // 歌词、封面与直链一起要，三条互不等待
  void loadLyric(i);
  void loadPic(i);
  say('正在取「' + tracks[i].title + '」…');

  try {
    const data = await api('url', {
      id: r.urlId,
      source: r.source,
      sign: r.sign,
      // 这两个是让 Worker 去同名候选里择优的。上游同一次搜索里完整版与几十秒的
      // 片段是并排的，不给这两个参数就只能听天由命 —— R14 的「VIP 播不全」
      // 就是这么来的，见 worker.ts 里「择优选源」那段注释
      name: tracks[i].title,
      artist: r.artist,
    });
    if (my !== want) return;

    // Worker 已经拦过「签名错误！」了，这里再确认一次形状，别把一句话塞进 <audio>
    const link = txt(data.url);
    if (!link.startsWith('https://')) throw new Error('这首现在拿不到，换一首');

    tracks[i].src = link;
    au.setAttribute('src', link);
    // 候选里最长的也偏短时 Worker 会标 short。如实说一句，不假装是完整版；
    // 时长本身由 durationchange 回填，显示的是真实长度
    say(data.short ? '上游这首只有片段，能播多少算多少' : '');
    if (play) void au.play().catch(() => {});
  } catch (e) {
    if (my !== want) return;
    const why = e instanceof Error ? e.message : '这首现在拿不到，换一首';
    for (const v of views) v.bad?.(i, why);
    say(why);
  }
}

/**
 * 歌词。取过就不再取 —— 失败也算取过，否则每次切回这首都要打一遍上游。
 * 取回来的行进的是 `tracks[i].lines`（状态），不是某个页面的 DOM：
 * R14 之前它只活在 /music 那棵树上，走一趟别的页面再回来就没了。
 */
async function loadLyric(i: number) {
  const t = tracks[i];
  if (!t.ref || t.lyricDone) return;
  t.lyricDone = true;

  try {
    const data = await api('lyric', {
      // song 漏了就永远只拿到「签名错误！」，见 data/jukebox.ts 顶部的坑 1
      id: t.ref.lyricId,
      source: t.ref.source,
      song: t.ref.songId,
      sign: t.ref.sign,
    });
    t.lines = parseLrc(txt(data.lyric));
  } catch {
    /* 没歌词只是不显示歌词，不影响听 */
  }

  if (i === idx) {
    onIdx = -1;
    syncAll();
    pulse();
  }
}
/**
 * 封面。**只在真的要播这一首时才取**，与 `url` 端点同一条既定原则 ——
 * 列表接口一个字不改，一屏 30 条搜索结果不会变成 30 次上游往返（列表里也没有封面位）。
 * 取过就不再取，取不到就一直用唱片原来的文字标签。
 */
async function loadPic(i: number) {
  const t = tracks[i];
  if (!t.ref?.picId || t.picDone) return;
  t.picDone = true;

  try {
    const data = await api('pic', {
      // song 漏了同样只会拿到「签名错误！」，见 data/jukebox.ts 顶部的坑 1
      id: t.ref.picId,
      source: t.ref.source,
      song: t.ref.songId,
      sign: t.ref.sign,
    });
    const url = txt(data.url);
    // Worker 已经校验过前缀，这里再确认一次 —— 这个值下一步就进 img.src
    if (!url.startsWith('https://')) return;
    t.cover = url;
    if (i === idx) syncAll();
  } catch {
    /* 没封面只是不换标签，不影响听 */
  }
}

/**
 * 纯入队，不广播。返回它在队列里的下标 —— 已经在队列里的就是原下标（不加重复行）。
 * 拆出来是给 addAll() 用的：整张歌单入队时不能一首一广播。
 */
function push(j: JukeTrack): number {
  const had = tracks.findIndex((t) => t.ref?.songId === j.songId);
  if (had >= 0) return had;

  const i = tracks.length;
  tracks.push({
    id: 'juke-' + j.songId,
    title: j.title,
    subtitle: [j.artist, j.album].filter(Boolean).join(' · ') || '点的歌',
    src: '',
    cover: '',
    duration: 0,
    lines: [],
    ref: {
      songId: j.songId,
      urlId: j.urlId,
      lyricId: j.lyricId,
      // 过一层 txt()：边缘缓存里可能还躺着 picId 上线前的列表响应（TTL 5 分钟），
      // 那些记录没有这个字段
      picId: txt(j.picId),
      source: j.source,
      sign: j.sign,
      artist: j.artist,
    },
  });
  return i;
}

/**
 * 点一首 = 往队列尾部加一项，返回它落在队列里的下标。
 * 只动状态，DOM 由视图在 `added` 里自己接 —— 悬浮窗根本不需要接。
 */
export function add(j: JukeTrack): number {
  const was = tracks.length;
  const i = push(j);
  // 命中去重时下标会小于原长度，那就没有新行要建，也不必广播
  if (i === was) for (const v of views) v.added?.(i);
  return i;
}

/**
 * 一键入队：把当前这批结果整个追加到队列尾，返回第一首的下标（没结果给 -1）。
 *
 * **不清空已有队列** —— 本地那首曲目和之前点的歌都留着，`push()` 本身去重，
 * 所以重复点两次不会长出两份。
 *
 * 全程只广播一次 `sync`，不走 `added`：「沉麟推荐」有 324 首，一首一广播就是 324 次
 * DOM append；而视图的 `sync()` 里有「行数与队列长度不一致就整块重铺」那一条，
 * 一次重铺正好接住整批。
 */
export function addAll(): number {
  if (!found.length) return -1;

  let first = -1;
  for (const j of found) {
    const i = push(j);
    if (first < 0) first = i;
  }

  syncAll();
  return first;
}

/** 取一批结果。`what` 只用来拼提示语 */
export async function ask(
  what: string,
  path: 'list' | 'search',
  params: Record<string, string>,
) {
  say('正在取' + what + '…');
  try {
    const data = await api(path, params);
    found = Array.isArray(data.items) ? (data.items as JukeTrack[]) : [];
    for (const v of views) v.res?.();
    say(
      found.length
        ? `${what}：${found.length} 首，点一首加到队列，或者全部播放。`
        : what + '：一首都没有。',
    );
  } catch (e) {
    found = [];
    for (const v of views) v.res?.();
    say(e instanceof Error ? e.message : '没取到');
  }
}

/* ==========================================================================
   接线。init 只跑一次，视图来来去去
   ========================================================================== */

/**
 * 时长回填。**必须听 `durationchange` 而不是 `loadedmetadata`**：
 * 流式 MP3 没有 XING/VBRI 头时，`loadedmetadata` 那一刻的 `au.duration`
 * 是浏览器按已下载部分外推的估算值（常见就是几十秒），随着数据到达会被
 * 多次修正 —— 只读一次就把时长钉死在 0:30，进度条也只能拖到 30 秒，
 * 看起来完全像「这首歌只有半分钟」（踩过，R14 就是这么误判成版权限制的）。
 *
 * 本地那首以 data/music.ts 的配置值为准（音频一个字节没下载时列表就要显示时长），
 * 所以只有点歌进来的（有 ref）才让 <audio> 说话。差值门限 1 秒：避开每次修正都重画。
 */
function syncDuration() {
  const t = tracks[idx];
  if (!au || !t.ref || !Number.isFinite(au.duration) || au.duration <= 0) return;
  if (Math.abs((t.duration || 0) - au.duration) < 1) return;
  t.duration = au.duration;
  syncAll();
}
/**
 * 一首放完了。**单曲循环走 `au.loop`，根本不会触发 `ended`**，所以这里没有它的分支。
 * 顺序档播到队尾就停在最后一首上（不跳回第一首，也不清空），
 * 只广播一次让播放键回到「播放」形态。
 */
function onEnded() {
  if (mode === 0 && idx >= tracks.length - 1) {
    syncAll();
    pulse();
    return;
  }
  // 列表循环靠 load() 里的取模回到第一首
  load(mode === 3 ? nextRandom() : idx + 1, true);
}

/**
 * 接上那一个 `<audio>`。由 MiniPlayer 的脚本在模块顶层调 ——
 * 那段脚本也是 bundled module，全站只执行一次，所以这里实际只跑一次。
 *
 * 仍然写成「换了元素才重接」而不是 `if (au) return`：万一 persist 没配对上
 * （名字打错、某个页面漏了 MiniPlayer），`au` 会指着一个已被丢弃的节点，
 * 播放键从此全部失灵且毫无线索。重接的代价只是几个监听。
 */
export function init(el: HTMLAudioElement) {
  if (au === el) return;
  const first = !au;
  au = el;

  if (first) {
    /* 把上次的偏好读回来。**必须先判 `!== null`**：`Number(null) === 0`，
       而 0 既是合法音量又是「顺序」档 —— 直接 Number() 会把「没存过」
       当成静音 + 顺序播放（踩过两次）。 */
    const m = read('music:mode');
    if (m !== null && Number.isFinite(Number(m))) {
      mode = Math.min(MODES.length - 1, Math.max(0, Math.trunc(Number(m))));
    }
    const v = read('music:vol');
    if (v !== null && Number.isFinite(Number(v))) {
      vol = Math.min(1, Math.max(0, Number(v)));
    }
  }

  el.volume = vol;
  el.loop = mode === 2;

  el.addEventListener('play', () => {
    // 播过一次悬浮窗才出现，所以这里要广播
    ever = true;
    syncAll();
    // rAF 只在播放时转；raf 非 0 说明上一轮还没停，别开第二条
    if (!raf) raf = requestAnimationFrame(tick);
  });
  el.addEventListener('pause', syncAll);
  el.addEventListener('durationchange', syncDuration);
  el.addEventListener('ended', onEnded);

  // 把第一首接上（`preload="none"`，这一步不会下载任何音频数据）
  load(idx, false);
}

/**
 * 视图上线。挂上就喂一次全量 —— 舞台每次 SPA 导航都是新节点，正要靠这一次把队列、
 * 词表、结果列表全部填满；悬浮窗也要借这次广播重新判断自己该不该露脸。
 *
 * 末尾用 `relayout()` 而不是 `pulse()`：`onIdx` 没变时广播出去的 `changed` 是假的，
 * 新视图于是不会去拆当前那一行，接下来整首歌都不会有逐字效果（换到下一行才恢复）。
 */
export function attach(v: View) {
  views.add(v);
  v.res?.();
  v.say?.(msg);
  syncAll();
  relayout();
}

/** 视图下线（SPA 导航把它那棵树换掉了）。舞台走了，悬浮窗要重新出现 */
export function detach(v: View) {
  views.delete(v);
  syncAll();
}

/* 视口变了：居中偏移与折行都要重算。这个监听**留在模块顶层**——
   放进 astro:page-load 会每导航一次累积一层。 */
window.addEventListener('resize', relayout);
