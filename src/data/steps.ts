/**
 * 刷步数工具的共享类型与默认条件。
 *
 * 页面、后台、Worker 三处共用这一份 —— 条件的语义只在这里定义一次。
 *
 * 规则（R52 改写成 A / B / C / D 四段，四段都可自定义）：
 *   A = 检测时刻（beforeHour:beforeMinute，北京时间）
 *   B = 中间阈值（threshold）
 *   C = 最终目标（toMin..toMax 的中点）
 *   D = 随机幅度（(toMax - toMin) / 2），实际提交 C ± D 内的一个随机数
 *
 * 判据：**A 点之后**才评估（早于 A 不动手）。评估时先读今日步数：
 *   ① 读得到且已 ≥ C 的下限 → 今天够了，跳过；
 *   ② 读得到但不足 → 刷到 C ± D；
 *   ③ **读不到**（Zepp 登录/接口出问题）→ 先刷到 B 附近探路，成功了再补到 C ± D。
 *      两段式的理由是「读不到」与「真的没走」在日志里长得一样，直接刷 C 会把
 *      「今天已经走了一万二」的人覆盖掉；先刷 B 再看返回，代价小得多。
 *
 * toMin / toMax 仍是落库字段（DO 的 step_account 表没有 target/jitter 两列，
 * 加列要动已有数据）。C 与 D 由这两个值反算，接口与后台表单负责换算 —— 单一事实源。
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
  const c = targetOf(r);
  const d = jitterOf(r);
  return `每天 ${hh}:${mm} 后，若不足 ${r.threshold} 步，刷到 ${c}±${d}；读不到步数先刷到 ${r.threshold} 再补`;
}

/** C：最终目标 = toMin/toMax 的中点（四舍五入） */
export function targetOf(r: { toMin: number; toMax: number }): number {
  const a = Math.min(r.toMin, r.toMax);
  const b = Math.max(r.toMin, r.toMax);
  return Math.round((a + b) / 2);
}

/** D：随机幅度 = 区间的一半 */
export function jitterOf(r: { toMin: number; toMax: number }): number {
  const a = Math.min(r.toMin, r.toMax);
  const b = Math.max(r.toMin, r.toMax);
  return Math.max(0, Math.round((b - a) / 2));
}

/** 由 C 与 D 反算落库用的 toMin / toMax */
export function rangeOf(target: number, jitter: number): { toMin: number; toMax: number } {
  const c = clampSteps(target);
  const d = Math.max(0, Math.trunc(jitter));
  return { toMin: Math.max(STEP_HARD_MIN, c - d), toMax: Math.min(STEP_HARD_MAX, c + d) };
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
  /** true 表示已经过了 A 点，属于补刷 */
  catchUp: boolean;
  /**
   * 两段式：读不到今日步数时先刷到 B 探路，成功了再补到 C ± D。
   * 调用方（runOne / runAuto）按这个标记走两趟 runBrush。
   */
  twoPhase?: boolean;
}

/**
 * 自动规则该不该刷（R52 的 A / B / C / D）。
 *
 * 判据顺序（前者命中就返回）：
 * ① 未启用 / 未开 auto；
 * ② 今天已经成功刷过；
 * ③ 还没到 A 点 → 不动（这条是 R52 改的：原来是「窗口内」，现在明确「A 点之后」）；
 * ④ 读不到步数 → 两段式（先 B 再 C）；
 * ⑤ 读得到且已 ≥ C 的下限 → 跳过；
 * ⑥ 其余（含 B ≤ 当前 < C 的补齐）→ 刷到 C ± D。
 */
export function evalBrush(
  a: Pick<
    StepAccount,
    'enabled' | 'auto' | 'beforeHour' | 'beforeMinute' | 'threshold' | 'brushedDate' | 'toMin' | 'toMax'
  >,
  now: number,
  currentSteps: number,
  readable = true
): BrushDecision {
  if (!a.enabled) return { brush: false, reason: '未启用', catchUp: false };
  if (!a.auto) return { brush: false, reason: '仅手动', catchUp: false };

  const p = beijingParts(now);
  if (a.brushedDate === p.date) {
    return { brush: false, reason: '今天已刷过', catchUp: false };
  }

  const hh = String(a.beforeHour).padStart(2, '0');
  const mm = String(a.beforeMinute).padStart(2, '0');
  const deadline = a.beforeHour * 60 + a.beforeMinute;
  const nowMin = p.hour * 60 + p.minute;
  const c = targetOf(a);
  const d = jitterOf(a);
  const floor = Math.min(a.toMin, a.toMax);
  const late = nowMin >= deadline + 60;

  if (nowMin < deadline) {
    return { brush: false, reason: `还没到 ${hh}:${mm}（A 点），今天先不动`, catchUp: false };
  }

  if (!readable) {
    return {
      brush: true,
      reason: `读不到今日步数，先刷到 ${a.threshold} 探路，成功再补到 ${c}±${d}`,
      catchUp: late,
      twoPhase: true,
    };
  }

  if (currentSteps >= floor) {
    return {
      brush: false,
      reason: `今日已有 ${currentSteps} 步（≥ ${floor}），不必刷`,
      catchUp: false,
    };
  }

  return {
    brush: true,
    reason:
      currentSteps < a.threshold
        ? `已过 ${hh}:${mm} 且不足 ${a.threshold} 步（现 ${currentSteps}），刷到 ${c}±${d}`
        : `已过 ${hh}:${mm}，已有 ${currentSteps} 步但未到 ${floor}，补到 ${c}±${d}`,
    catchUp: late,
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
