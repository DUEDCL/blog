/**
 * 刷步数的执行与管理接口（工具 · 刷步）。
 *
 * 从 worker.ts 拆出来：那里已经两千多行，而这一块是自成一块的业务
 * （Zepp 协议在 `data/zepp.ts`，条件语义在 `data/steps.ts`，这里只做编排）。
 *
 * 调用面：
 * - `/api/admin/steps-*`（登录后）：列表、增删改、手动跑、自动规则、日志；
 * - `scheduled`（cron）：按条件自动跑。
 *
 * 账号密码只在 DO 里，接口永不回传密码或 token 原文。
 *
 * **每一次评估都会落一条日志**（包括「跳过：今天已刷过」）——
 * 早先跳过时不写日志，于是「自动没跑」在后台看起来和「没人触发」一模一样。
 */
import {
  STEP_DEFAULTS,
  beijingDate,
  clampSteps,
  evalBrush,
  looksMasked,
  maskUser,
  ruleSentence,
  type StepAccount,
} from './data/steps';
import { runBrush, ensureAppToken, getTodaySteps, type ZeppTokens } from './data/zepp';

interface EnvLike {
  CHAT: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(req: Request): Promise<Response> };
  };
}

const cfgOf = (env: EnvLike) => env.CHAT.get(env.CHAT.idFromName('config'));

async function doFetch(env: EnvLike, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await cfgOf(env).fetch(
    new Request('https://chat.do' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  return (await res.json()) as Record<string, unknown>;
}

type RawAccount = StepAccount & { pwd?: string; tokens?: ZeppTokens | Record<string, unknown> };

function toView(a: RawAccount) {
  return {
    id: a.id,
    userMask: maskUser(a.user),
    enabled: a.enabled,
    auto: a.auto,
    beforeHour: a.beforeHour,
    beforeMinute: a.beforeMinute,
    threshold: a.threshold,
    toMin: a.toMin,
    toMax: a.toMax,
    lastSteps: a.lastSteps,
    lastRunAt: a.lastRunAt,
    lastRunOk: a.lastRunOk,
    lastRunMsg: a.lastRunMsg,
    brushedDate: a.brushedDate,
    rule: ruleSentence(a),
  };
}

export async function listAccounts(env: EnvLike): Promise<Record<string, unknown>[]> {
  const d = await doFetch(env, '/step-accounts');
  return ((d.items as RawAccount[]) ?? []).map(toView);
}

export async function listLog(env: EnvLike, n = 40) {
  const d = await doFetch(env, '/step-log?n=' + n);
  return (d.items as unknown[]) ?? [];
}

function asInt(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

/**
 * 后台增改。`id` 空则新建。
 *
 * **改账号时不会把脱敏名写回去**：列表只回 `userMask`（含 `*`），
 * 早先编辑规则会把 `138****8000` 存成登录名，之后 Zepp 必然登录失败。
 * 现在：新建必须给真实账号；更新时若传来的 user 含 `*` 或为空，原样保留。
 */
export async function putAccount(
  env: EnvLike,
  body: Record<string, unknown>
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const id = String(body.id ?? '').trim();
  const rawUser = String(body.user ?? '').trim();
  const creating = !id;

  if (creating && !rawUser) return { ok: false, error: '账号不能为空' };
  if (creating && looksMasked(rawUser))
    return { ok: false, error: '请填真实的手机号或邮箱，不要带 *' };

  const newId = id || 's' + Date.now().toString(36);

  // 更新时先读旧值，user/pwd 按「没给就不改」处理
  let prev: RawAccount | null = null;
  if (!creating) {
    const raw = await readRaw(env, newId);
    prev = raw;
    if (!prev) return { ok: false, error: '没有这个账号' };
  }

  const user = creating
    ? rawUser
    : rawUser && !looksMasked(rawUser)
      ? rawUser
      : (prev!.user ?? '');

  const payload = {
    id: newId,
    user,
    pwd: typeof body.pwd === 'string' && body.pwd ? body.pwd : '',
    enabled: body.enabled !== false,
    auto: body.auto !== false,
    beforeHour: asInt(body.beforeHour, STEP_DEFAULTS.beforeHour),
    beforeMinute: asInt(body.beforeMinute, STEP_DEFAULTS.beforeMinute),
    threshold: clampSteps(asInt(body.threshold, STEP_DEFAULTS.threshold)),
    toMin: clampSteps(asInt(body.toMin, STEP_DEFAULTS.toMin)),
    toMax: clampSteps(asInt(body.toMax, STEP_DEFAULTS.toMax)),
  };
  if (payload.toMin > payload.toMax) {
    const t = payload.toMin;
    payload.toMin = payload.toMax;
    payload.toMax = t;
  }
  const r = await doFetch(env, '/step-account-put', payload);
  if (r.ok === false) return { ok: false, error: String(r.error ?? '存不进去') };
  return { ok: true, id: newId };
}

export async function delAccount(env: EnvLike, id: string) {
  await doFetch(env, '/step-account-del', { id });
  return { ok: true };
}

/** 随机目标步数 */
function pickTarget(min: number, max: number): number {
  const a = clampSteps(min);
  const b = clampSteps(Math.max(min, max));
  return a + Math.floor(Math.random() * (b - a + 1));
}

async function writeRun(
  env: EnvLike,
  a: { id: string; user: string },
  steps: number,
  ok: boolean,
  msg: string,
  via: 'auto' | 'manual',
  tokens?: ZeppTokens,
  brushedDate?: string
) {
  const mask = maskUser(a.user);
  // 先落日志 —— 即使后面的账号回写失败，也得留下痕迹
  try {
    await doFetch(env, '/step-log-add', {
      accountId: a.id,
      userMask: mask,
      steps,
      ok,
      msg,
      via,
    });
  } catch {
    /* 日志写失败也不该把调用方带崩 */
  }

  try {
    const cur = ((await doFetch(env, '/step-accounts')).items as RawAccount[]) ?? [];
    const me = cur.find((x) => x.id === a.id);
    if (!me) return;
    await doFetch(env, '/step-account-put', {
      id: me.id,
      // 用真实 user（列表里就是原文），绝不用 mask
      user: me.user,
      enabled: me.enabled,
      auto: me.auto,
      beforeHour: me.beforeHour,
      beforeMinute: me.beforeMinute,
      threshold: me.threshold,
      toMin: me.toMin,
      toMax: me.toMax,
      tokens: tokens ?? me.tokens,
      lastSteps: ok ? steps : me.lastSteps,
      lastRunAt: Date.now(),
      lastRunOk: ok,
      lastRunMsg: msg.slice(0, 400),
      brushedDate: ok && brushedDate ? brushedDate : me.brushedDate,
    });
  } catch {
    /* 账号状态回写失败，日志已经在了 */
  }
}

/**
 * 尽力读今日步数：先问 Zepp，读不到再用 lastSteps 兜底。
 * 条件句里的「未达到 8000」按**真实今日**算，免得覆盖已经走够的步数。
 */
async function currentStepsOf(raw: {
  user: string;
  pwd?: string;
  tokens?: unknown;
  lastSteps: number;
}): Promise<{ steps: number; source: 'zepp' | 'local' }> {
  const pwd = String(raw.pwd ?? '');
  if (!pwd) return { steps: raw.lastSteps || 0, source: 'local' };
  const cached = (raw.tokens as ZeppTokens | undefined) ?? null;
  try {
    const tok = await ensureAppToken(raw.user, pwd, cached);
    if (tok.ok) {
      const n = await getTodaySteps(tok.data.app_token, tok.data.user_id);
      if (n != null) return { steps: n, source: 'zepp' };
    }
  } catch {
    /* 读不到就用记账值 */
  }
  return { steps: raw.lastSteps || 0, source: 'local' };
}

/**
 * 手动 / 自动跑一个账号。
 * `force` 忽略条件句（后台与工具页的「刷步」用目标区间随机值或指定步数）。
 */
export async function runOne(
  env: EnvLike,
  id: string,
  opts: { force?: boolean; via?: 'auto' | 'manual'; steps?: number } = {}
): Promise<{ ok: boolean; steps?: number; error?: string; skipped?: string }> {
  const me = await readRaw(env, id);
  if (!me) return { ok: false, error: '没有这个账号' };

  const via = opts.via ?? 'manual';
  const now = Date.now();

  // 自动路径先判条件（当前步数优先问 Zepp）
  if (via === 'auto' && !opts.force) {
    const cur = await currentStepsOf(me);
    const d = evalBrush(me, now, cur.steps);
    if (!d.brush) {
      // 跳过也落一条，不然「自动没跑」在后台等于没发生
      await writeRun(env, me, 0, true, `跳过：${d.reason}`, 'auto');
      return { ok: true, steps: 0, skipped: d.reason };
    }
  }

  const target =
    typeof opts.steps === 'number' && Number.isFinite(opts.steps)
      ? clampSteps(opts.steps)
      : pickTarget(me.toMin, me.toMax);

  const cached = (me.tokens as ZeppTokens | undefined) ?? null;
  let r;
  try {
    r = await runBrush(me.user, me.pwd ?? '', cached, target);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeRun(env, me, target, false, `异常：${msg}`, via);
    return { ok: false, error: msg };
  }
  if (!r.ok) {
    await writeRun(env, me, target, false, r.error, via);
    return { ok: false, error: r.error };
  }
  await writeRun(
    env,
    me,
    r.data.steps,
    true,
    `已刷到 ${r.data.steps} 步`,
    via,
    r.data.tokens,
    beijingDate(now)
  );
  return { ok: true, steps: r.data.steps };
}

/** 一条账号在自动规则下的评估结果（给 UI 与调试用） */
export interface AutoRow {
  id: string;
  userMask: string;
  brush: boolean;
  catchUp: boolean;
  reason: string;
  currentSteps: number;
  currentSource: 'zepp' | 'local';
  ran?: boolean;
  steps?: number;
  error?: string;
  skipped?: string;
}

/**
 * 扫全部 auto 账号，按条件刷。
 * 每个账号独立 try/catch —— 一个账号的异常不拖垮其余。
 * `dryRun` 只评估不提交，给「看看会怎样」用。
 */
export async function runAuto(
  env: EnvLike,
  opts: { dryRun?: boolean } = {}
): Promise<{ ran: number; skipped: number; rows: AutoRow[]; at: number }> {
  const at = Date.now();
  const d = await doFetch(env, '/step-accounts');
  const items = (d.items as { id?: string }[]) ?? [];
  const rows: AutoRow[] = [];
  let ran = 0;
  let skipped = 0;

  // 心跳：证明 cron / 手动触发真的进来了
  try {
    await doFetch(env, '/cfg-set', { steps_last_auto: String(at) });
  } catch {
    /* 心跳失败不影响主流程 */
  }

  for (const { id } of items) {
    const rid = String(id ?? '');
    if (!rid) continue;
    try {
      const raw = await readRaw(env, rid);
      if (!raw) {
        skipped++;
        rows.push({
          id: rid,
          userMask: '?',
          brush: false,
          catchUp: false,
          reason: '账号读不出来',
          currentSteps: 0,
          currentSource: 'local',
        });
        continue;
      }

      const cur = await currentStepsOf(raw);
      const dec = evalBrush(raw, at, cur.steps);
      const row: AutoRow = {
        id: raw.id,
        userMask: maskUser(raw.user),
        brush: dec.brush,
        catchUp: dec.catchUp,
        reason: dec.reason,
        currentSteps: cur.steps,
        currentSource: cur.source,
      };

      if (!dec.brush) {
        skipped++;
        if (!opts.dryRun) {
          await writeRun(env, raw, 0, true, `跳过：${dec.reason}`, 'auto');
        }
        rows.push(row);
        continue;
      }

      if (opts.dryRun) {
        row.ran = false;
        row.skipped = 'dry-run';
        rows.push(row);
        continue;
      }

      const target = pickTarget(raw.toMin, raw.toMax);
      try {
        const r = await runBrush(raw.user, raw.pwd ?? '', (raw.tokens as ZeppTokens) || null, target);
        if (r.ok) {
          await writeRun(
            env,
            raw,
            r.data.steps,
            true,
            `${dec.catchUp ? '补刷' : '自动'}已刷到 ${r.data.steps} 步（${dec.reason}）`,
            'auto',
            r.data.tokens,
            beijingDate(at)
          );
          row.ran = true;
          row.steps = r.data.steps;
          ran++;
        } else {
          await writeRun(env, raw, target, false, r.error, 'auto');
          row.ran = false;
          row.error = r.error;
          skipped++;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await writeRun(env, raw, target, false, `异常：${msg}`, 'auto');
        row.ran = false;
        row.error = msg;
        skipped++;
      }
      rows.push(row);
      // 账号之间隔一下，别把华米接口打急了
      await new Promise((r2) => setTimeout(r2, 800));
    } catch (e) {
      skipped++;
      rows.push({
        id: rid,
        userMask: '?',
        brush: false,
        catchUp: false,
        reason: e instanceof Error ? e.message : String(e),
        currentSteps: 0,
        currentSource: 'local',
      });
    }
  }
  return { ran, skipped, rows, at };
}

/** 读一行原始账号（含 pwd 与 tokens），只给执行路径用 */
async function readRaw(env: EnvLike, id: string): Promise<(RawAccount & { pwd: string }) | null> {
  const res = await cfgOf(env).fetch(
    new Request('https://chat.do/step-raw?id=' + encodeURIComponent(id))
  );
  const d = (await res.json()) as { item?: RawAccount & { pwd?: string } | null };
  if (!d.item) return null;
  return d.item as RawAccount & { pwd: string };
}

/** 心跳：上一次自动扫描的时刻（给 UI 显示「cron 到底跑没跑」） */
export async function lastAutoAt(env: EnvLike): Promise<number> {
  try {
    const d = await doFetch(env, '/cfg');
    const cfg = (d.cfg as Record<string, string> | undefined) ?? {};
    return Number(cfg.steps_last_auto || 0) || 0;
  } catch {
    return 0;
  }
}
