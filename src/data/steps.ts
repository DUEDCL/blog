/**
 * 刷步数工具的共享类型与默认条件。
 *
 * 页面、后台、Worker 三处共用这一份 —— 条件的语义只在这里定义一次。
 *
 * 规则（R47 修订）：
 * 「每天 hh:mm 前，若不足 threshold 步，刷到 toMin~toMax」——
 * **过了 hh:mm 仍会补刷**（今天还没刷过且仍不足就动手）。
 * 原因：用户要的是「当天步数到一万」，不是「只准在十点前提交」；
 * 原先过了 deadline 就静默跳过且不落日志，正是「没提交记录也没有刷」的根因。
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
  /** 条件：每天这个时刻之前（北京时间）是「正点窗口」 */
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
  /** 今天是否已经刷过（自动规则一天最多成功刷一次） */
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
  /** auto = 定时/自动规则，manual = 后台手动 */
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

/** 这串看起来像脱敏名（含 *），不能当真实账号写回去 */
export function looksMasked(user: string): boolean {
  return user.includes('*');
}

/**
 * 读条件句：「每天 10:00 前，若不足 8000 步，刷到 10000–12000；
 * 过点未刷则补刷」。后台与工具页共用这一句。
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
  return `每天 ${hh}:${mm} 前，若不足 ${r.threshold} 步，刷到 ${r.toMin}–${r.toMax}；过点未刷则补刷`;
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

/** 规则判定的结果 —— 带原因，方便落日志与在页面上说清「为什么没跑」 */
export interface BrushDecision {
  brush: boolean;
  reason: string;
  /** true 表示已经过了 hh:mm，属于补刷 */
  catchUp: boolean;
}

/**
 * 自动规则该不该刷。
 *
 * 判据顺序（前者命中就返回）：
 * ① 未启用 / 未开 auto；
 * ② 今天已经成功刷过；
 * ③ 今日步数已达标（≥ threshold）；
 * ④ 窗口内且不足 → 刷；
 * ⑤ 已过窗口但今天还没刷且仍不足 → **补刷**（原先这里直接 false，导致晚上测试永远没动作）。
 */
export function evalBrush(
  a: Pick<
    StepAccount,
    'enabled' | 'auto' | 'beforeHour' | 'beforeMinute' | 'threshold' | 'brushedDate'
  >,
  now: number,
  currentSteps: number
): BrushDecision {
  if (!a.enabled) return { brush: false, reason: '未启用', catchUp: false };
  if (!a.auto) return { brush: false, reason: '仅手动', catchUp: false };

  const p = beijingParts(now);
  if (a.brushedDate === p.date) {
    return { brush: false, reason: '今天已刷过', catchUp: false };
  }
  if (currentSteps >= a.threshold) {
    return {
      brush: false,
      reason: `今日已有 ${currentSteps} 步（≥${a.threshold}），不必刷`,
      catchUp: false,
    };
  }

  const hh = String(a.beforeHour).padStart(2, '0');
  const mm = String(a.beforeMinute).padStart(2, '0');
  const deadline = a.beforeHour * 60 + a.beforeMinute;
  const nowMin = p.hour * 60 + p.minute;

  if (nowMin < deadline) {
    return {
      brush: true,
      reason: `${hh}:${mm} 前且不足 ${a.threshold} 步（现 ${currentSteps}）`,
      catchUp: false,
    };
  }
  return {
    brush: true,
    reason: `已过 ${hh}:${mm} 仍不足 ${a.threshold} 步（现 ${currentSteps}），补刷`,
    catchUp: true,
  };
}

/** 兼容旧调用：只关心刷不刷 */
export function shouldBrush(
  a: Parameters<typeof evalBrush>[0],
  now: number,
  currentSteps: number
): boolean {
  return evalBrush(a, now, currentSteps).brush;
}
