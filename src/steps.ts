/**
 * 刷步数的执行与管理接口（工具 · 刷步）。
 *
 * 从 worker.ts 拆出来：那里已经两千多行，而这一块是自成一块的业务
 * （Zepp 协议在 `data/zepp.ts`，条件语义在 `data/steps.ts`，这里只做编排）。
 *
 * 调用面：
 * - `/api/admin/steps-*`（登录后）：列表、增删改、手动跑、日志；
 * - `scheduled`（cron）：按条件自动跑。
 *
 * 账号密码只在 DO 里，接口永不回传密码或 token 原文。
 */
import {
  STEP_DEFAULTS,
  beijingDate,
  clampSteps,
  maskUser,
  ruleSentence,
  shouldBrush,
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

type RawAccount = StepAccount & { tokens?: ZeppTokens | Record<string, unknown> };

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

/** 后台增改。`id` 空则新建 */
export async function putAccount(
  env: EnvLike,
  body: Record<string, unknown>
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const user = String(body.user ?? '').trim();
  if (!user) return { ok: false, error: '账号不能为空' };
  const id = String(body.id ?? '').trim() || 's' + Date.now().toString(36);
  const payload = {
    id,
    user,
    pwd: typeof body.pwd === 'string' ? body.pwd : '',
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
  return { ok: true, id };
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
  await doFetch(env, '/step-log-add', {
    accountId: a.id,
    userMask: mask,
    steps,
    ok,
    msg,
    via,
  });
  // 更新账号上的最近状态；tokens 单独回写（含密码不变）
  const cur = ((await doFetch(env, '/step-accounts')).items as RawAccount[]) ?? [];
  const me = cur.find((x) => x.id === a.id);
  if (!me) return;
  await doFetch(env, '/step-account-put', {
    id: me.id,
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
}

/**
 * 尽力读今日步数：先问 Zepp，读不到再用 lastSteps 兜底。
 * 条件句里的「未达到 8000」按**真实今日**算，免得覆盖已经走够的步数。
 */
async function currentStepsOf(raw: {
  user: string;
  pwd: string;
  tokens?: unknown;
  lastSteps: number;
}): Promise<number> {
  const cached = (raw.tokens as ZeppTokens | undefined) ?? null;
  try {
    const tok = await ensureAppToken(raw.user, raw.pwd, cached);
    if (tok.ok) {
      const n = await getTodaySteps(tok.data.app_token, tok.data.user_id);
      if (n != null) return n;
    }
  } catch {
    /* 读不到就用记账值 */
  }
  return raw.lastSteps || 0;
}

/**
 * 手动 / 自动跑一个账号。
 * `force` 忽略条件句（后台「立刻刷一次」用目标区间随机值）。
 */
export async function runOne(
  env: EnvLike,
  id: string,
  opts: { force?: boolean; via?: 'auto' | 'manual'; steps?: number } = {}
): Promise<{ ok: boolean; steps?: number; error?: string }> {
  const me = await readRaw(env, id);
  if (!me) return { ok: false, error: '没有这个账号' };

  const via = opts.via ?? 'manual';
  const now = Date.now();

  // 自动路径先判条件（当前步数优先问 Zepp）
  if (via === 'auto' && !opts.force) {
    const current = await currentStepsOf(me);
    if (!shouldBrush(me, now, current)) {
      return { ok: true, steps: 0 };
    }
  }

  const target =
    typeof opts.steps === 'number' && Number.isFinite(opts.steps)
      ? clampSteps(opts.steps)
      : pickTarget(me.toMin, me.toMax);

  const cached = (me.tokens as ZeppTokens | undefined) ?? null;
  const r = await runBrush(me.user, me.pwd, cached, target);
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

/** 定时入口：扫全部 auto 账号，按条件刷 */
export async function runAuto(env: EnvLike): Promise<{ ran: number; skipped: number }> {
  const d = await doFetch(env, '/step-accounts');
  const ids = ((d.items as { id?: string }[]) ?? []).map((x) => String(x.id));
  let ran = 0;
  let skipped = 0;
  for (const id of ids) {
    const raw = await readRaw(env, id);
    if (!raw || !raw.enabled || !raw.auto) {
      skipped++;
      continue;
    }
    const current = await currentStepsOf(raw);
    if (!shouldBrush(raw, Date.now(), current)) {
      skipped++;
      continue;
    }
    const target = pickTarget(raw.toMin, raw.toMax);
    const r = await runBrush(raw.user, raw.pwd, (raw.tokens as ZeppTokens) || null, target);
    if (r.ok) {
      await writeRun(
        env,
        raw,
        r.data.steps,
        true,
        `已刷到 ${r.data.steps} 步`,
        'auto',
        r.data.tokens,
        beijingDate()
      );
      ran++;
    } else {
      await writeRun(env, raw, target, false, r.error, 'auto');
      skipped++;
    }
    // 账号之间隔一下，别把华米接口打急了
    await new Promise((r2) => setTimeout(r2, 800));
  }
  return { ran, skipped };
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
