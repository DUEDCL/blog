/**
 * 刷步数工具的共享类型与默认条件。
 *
 * 页面、后台、Worker 三处共用这一份 —— 条件的语义只在这里定义一次：
 * 「在 deadline 之前，若当前步数低于 threshold，就刷到 toMin~toMax 的随机值」。
 *
 * 账号与规则本体存在 Durable Object（`chat-log.ts` 的 step_* 表），
 * 这里只放形状、默认值与纯函数，不碰 I/O。
 */

/** 一条刷步账号。密码只在 DO 里，接口永不回传 */
export interface StepAccount {
  id: string;
  /** 小米运动 / Zepp Life 账号：手机号或邮箱 */
  user: string;
  /** 是否启用（总开关） */
  enabled: boolean;
  /** 是否走全自动规则 */
  auto: boolean;
  /** 条件：每天这个时刻之前（北京时间） */
  beforeHour: number;
  beforeMinute: number;
  /** 条件：当前步数低于这个数才刷 */
  threshold: number;
  /** 刷到的目标区间（闭区间，随机取） */
  toMin: number;
  toMax: number;
  /** 上次设置的步数（用于读不到 Zepp 时的兜底） */
  lastSteps: number;
  lastRunAt: number;
  lastRunOk: boolean;
  lastRunMsg: string;
  /** 今天是否已经刷过（自动规则一天最多主动刷一次成功） */
  brushedDate: string;
}

export interface StepRunLog {
  id: number;
  accountId: string;
  userMask: string;
  steps: number;
  ok: boolean;
  msg: string;
  ts: number;
  /** auto = 定时规则触发，manual = 后台手动 */
  via: 'auto' | 'manual';
}

/** 新建 / 更新账号时的入参 */
export interface StepAccountInput {
  user: string;
  pwd?: string;
  enabled?: boolean;
  auto?: boolean;
  beforeHour?: number;
  beforeMinute?: number;
  threshold?: number;
  toMin?: number;
  toMax?: number;
}

export const STEP_DEFAULTS = {
  enabled: true,
  auto: true,
  beforeHour: 10,
  beforeMinute: 0,
  threshold: 8000,
  toMin: 10000,
  toMax: 12000,
} as const;

/** 步数上限：Zepp 侧太大容易被拒，也假得离谱 */
export const STEP_HARD_MAX = 98000;
export const STEP_HARD_MIN = 0;

export function clampSteps(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(STEP_HARD_MIN, Math.min(STEP_HARD_MAX, Math.trunc(n)));
}

/** 账号脱敏。与 mimotion 同一规则，日志与后台列表都用它 */
export function maskUser(user: string): string {
  if (user.length <= 8) {
    const ln = Math.max(Math.floor(user.length / 3), 1);
    return `${user.slice(0, ln)}***${user.slice(-ln)}`;
  }
  return `${user.slice(0, 3)}****${user.slice(-4)}`;
}

/**
 * 读条件句：「每天 10:00 前，若不足 8000 步，刷到 10000–12000」。
 * 后台与工具页共用这一句 —— 表单字段多，这句话才是人读得懂的规格。
 */
export function ruleSentence(r: {
  beforeHour: number;
  beforeMinute: number;
  threshold: number;
  toMin: number;
  toMax: number;
}): string {
  const hh = String(r.beforeHour).padStart(2, '0');
  const mm = String(r.beforeMinute).padStart(2, '0');
  return `每天 ${hh}:${mm} 前，若不足 ${r.threshold} 步，刷到 ${r.toMin}–${r.toMax}`;
}

/** 北京时间（UTC+8）的「今天」YYYY-MM-DD */
export function beijingDate(ms = Date.now()): string {
  const d = new Date(ms + 8 * 3600_000);
  return d.toISOString().slice(0, 10);
}

export function beijingParts(ms = Date.now()): { hour: number; minute: number; date: string } {
  const d = new Date(ms + 8 * 3600_000);
  return {
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    date: d.toISOString().slice(0, 10),
  };
}

/**
 * 自动规则该不该刷。
 *
 * 返回 true 表示该刷。判据三条，缺一不可：
 * ① 总开关与 auto 都开着；
 * ② 现在还没过 deadline（过了就来不及「10 点前」，留给明天）；
 * ③ 今天还没成功刷过，且（当前步数 < threshold）。
 *
 * 「今天已经刷过」用 brushedDate 记账，不靠步数反推 —— 刷到 10000 之后
 * 条件自然不成立，但记账还能挡住「刷完又掉回 9000」时的重复提交。
 */
export function shouldBrush(
  a: Pick<
    StepAccount,
    'enabled' | 'auto' | 'beforeHour' | 'beforeMinute' | 'threshold' | 'brushedDate'
  >,
  now: number,
  currentSteps: number
): boolean {
  if (!a.enabled || !a.auto) return false;
  const p = beijingParts(now);
  if (a.brushedDate === p.date) return false;
  const deadline = a.beforeHour * 60 + a.beforeMinute;
  const nowMin = p.hour * 60 + p.minute;
  if (nowMin >= deadline) return false;
  return currentSteps < a.threshold;
}
