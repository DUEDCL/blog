/**
 * 后台的公共零件（R41②）—— DOM 取值、接口调用、时间格式、以及那个「实时更新」的心跳。
 *
 * 后台从一页平铺改成五个 tab 之后，脚本按 tab 拆成了几个文件（`models` / `logs` /
 * `live` / `write` / `gallery`），这个文件是它们都要用的那一层。
 * 拆文件不是为了好看：原来那 320 行脚本混在 `admin.astro` 里，加一个 tab 就要在
 * 三处（markup、脚本、样式）来回跳，改一处忘一处。
 */

/** 必然存在的元素。后台的 markup 与脚本是一起改的，选不到就是写错了，早崩比静默好 */
export const q = <T extends HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel)!;

export const qa = <T extends HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel));

/** 造一个节点。脚本造出来的节点吃不到 scoped CSS，所以样式那边全用 `:global()` */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text = ''
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

export interface Res {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

/**
 * 打后台接口。`body === undefined` 走 GET，其余走 POST。
 * 非 JSON 一律当失败 —— 后台的每一条接口都回 JSON，回别的说明中间有人插手了。
 */
export const api = async (path: string, body?: unknown): Promise<Res> => {
  let res: Response;
  try {
    res = await fetch('/api/admin/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    // 断网／被拦：给一个形状一致的失败，调用方不必到处 try
    return { ok: false, status: 0, data: { error: '连不上后台' } };
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 非 JSON 一律当失败 */
  }
  return { ok: res.ok, status: res.status, data };
};

/** 绝对时刻。`toLocaleString` 的斜杠换成连字符，与站上其余地方的日期写法一致 */
export const when = (ms: number) =>
  ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-') : '';

/** 相对时刻。列表里「3 分钟前」比一串完整时间好扫 */
export function ago(ms: number): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return '刚刚';
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}

/** 中文按字算、西文按词算的字数。写作工具那一栏用它 */
export function words(text: string): number {
  const cjk = (text.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  const other = (text.replace(/[一-鿿㐀-䶿]/g, ' ').match(/[A-Za-z0-9_'-]+/g) ?? [])
    .length;
  return cjk + other;
}

/* ==========================================================================
   心跳 —— 他要的「这些都能实时更新」

   一个 500 ms 的总节拍器驱动所有轮询，而不是每个 tab 各起一个 setInterval。
   三个理由：
   ① **只有当前 tab 的任务在跑**。五个 tab 各自轮询的话，看着「模型」那一页也在
      每 1.5 秒拉一次对话记录，白烧 DO 请求（免费档 10 万/天）；
   ② **页面看不见时整体停掉**。切到别的浏览器标签、锁屏，`visibilitychange` 一到就停 ——
      后台开着过夜不会一直打接口；
   ③ 任务里抛异常不会把定时器搞死（下面 `run` 里吞掉了）。
   ========================================================================== */

interface Job {
  /** 间隔毫秒 */
  every: number;
  run: () => void | Promise<void>;
  /** 上一次开跑的时刻 */
  at: number;
  /** 上一次还没跑完 —— 慢接口不该被叠着打第二次 */
  busy: boolean;
  /** 属于哪个 tab；`'*'` 表示常驻（顶栏那几个数字） */
  tab: string;
}

const jobs: Job[] = [];
let active = '';

/** 注册一个轮询任务。`tab` 是它所属的面板名，`'*'` 常驻 */
export const every = (tab: string, ms: number, run: () => void | Promise<void>) => {
  jobs.push({ every: ms, run, at: 0, busy: false, tab });
};

/** 切换当前面板。切过去的那一刻立刻跑一遍它的任务，不等下一个间隔 */
export function activate(tab: string) {
  active = tab;
  for (const j of jobs) if (j.tab === tab) j.at = 0;
}

setInterval(() => {
  if (document.hidden) return;
  const now = Date.now();
  for (const j of jobs) {
    if (j.tab !== '*' && j.tab !== active) continue;
    if (j.busy || now - j.at < j.every) continue;
    j.at = now;
    j.busy = true;
    void (async () => {
      try {
        await j.run();
      } catch {
        /* 一个任务失败不该把节拍器带停 */
      } finally {
        j.busy = false;
      }
    })();
  }
}, 500);

/** 顶栏那盏「实时」灯的时间戳。每次有任务真的拉到数据就调一下 */
export const beat = () => {
  const dot = document.querySelector('[data-beat]');
  if (dot) dot.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
};
