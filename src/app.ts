/**
 * 步数管家 —— 面向用户的公开 API（`/api/app/*`）、自动任务执行器与后台管理接口。
 *
 * 与单人工具那套（`steps.ts` + `Worker 的 /api/admin/steps-*`）**完全分开**：
 * - 数据在独立的 `AppDB` DO（用户、会话、卡密、绑定账号、日志）；
 * - 这一层的入口只有 Worker 能调，前端拿到的是「脱敏账号 + 状态 + 结果」；
 * - 现有后台「刷步」面板与单人账号原样保留，互不影响。
 *
 * 角色分工：
 * - `app.ts`（本文件）：鉴权、加密、Zepp 调用编排、cron 批量执行、后台接口；
 * - `app-db.ts`：存储与原子校验（名额、卡密、唯一绑定）；
 * - `data/zepp.ts`：协议层（登录/换 token/读今日步数/提交）。
 *
 * 安全边界（写在这里是让后来改的人先看到）：
 * 1. 密码只在 Worker 内存里出现，落库前用 AES-GCM 加密（密钥从 `ADMIN_SECRET` 派生）；
 * 2. 会话是随机 token 的 SHA-256 摘要存在 DO 里，cookie HttpOnly + SameSite=Lax；
 * 3. 所有写接口都是 POST + 同源检查；频率限制在 DO 里做（单实例串行，计数准确）；
 * 4. 接口永不回传 Zepp 密码、token、密码哈希。
 */
import {
  beijingDate,
  clampSteps,
  maskUser,
  STEP_HARD_MAX,
} from './data/steps';
import { ensureAppToken, getTodaySteps, postSteps, runBrush, type ZeppTokens } from './data/zepp';

/* ==========================================================================
   类型与环境
   ========================================================================== */

interface Stub {
  fetch(req: Request): Promise<Response>;
}

export interface AppEnv {
  APP: {
    idFromName(name: string): unknown;
    get(id: unknown): Stub;
  };
  ADMIN_SECRET?: string;
}

type Row = Record<string, unknown>;

const APP_CFG_KEY = 'app';
const APP_COOKIE = 'bs_sess';
const SESSION_DAYS = 30;
const PASS_ITER = 20000;

const enc = new TextEncoder();

/* ==========================================================================
   小工具
   ========================================================================== */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown, dflt = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
};
const bool = (v: unknown) => v === true || v === 1 || v === '1';

/* ---- base64 / 恒定时间比较 ---------------------------------------------- */

function b64(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(s: string): Promise<string> {
  const bits = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(bytes = 32): string {
  const u8 = crypto.getRandomValues(new Uint8Array(bytes));
  return [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---- 密码哈希 ------------------------------------------------------------ */

async function pbkdf2Hash(pass: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
    key,
    256
  );
  return b64(bits);
}

async function hashPass(pass: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await pbkdf2Hash(pass, salt as Uint8Array<ArrayBuffer>, PASS_ITER);
  return `pbkdf2$${PASS_ITER}$${b64(salt)}$${h}`;
}

async function verifyPass(pass: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = num(parts[1]);
  if (iter < 1000 || iter > 200000) return false;
  try {
    const got = await pbkdf2Hash(pass, unb64(parts[2]), iter);
    return timingEq(got, parts[3]);
  } catch {
    return false;
  }
}

/* ---- 绑定密码的对称加密（AES-256-GCM） ----------------------------------
   密钥从 `ADMIN_SECRET` 派生：不新增 secret，部署时少一步。
   **代价**：改后台口令（ADMIN_SECRET）会让已绑定用户的 Zepp 密码解不开，
   那时前端会提示「绑定信息失效，请重新绑定」—— 用户重绑一次即可。 */

async function aesKey(env: AppEnv): Promise<CryptoKey> {
  const src = 'bushu-enc-v1:' + (env.ADMIN_SECRET || 'bushu-local-dev');
  const bits = await crypto.subtle.digest('SHA-256', enc.encode(src));
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptStr(env: AppEnv, s: string): Promise<string> {
  const key = await aesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(s));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

async function decryptStr(env: AppEnv, s: string): Promise<string> {
  const parts = s.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('绑定信息格式不对');
  const key = await aesKey(env);
  const iv = unb64(parts[1]);
  const ct = unb64(parts[2]);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(plain);
}

/* ---- DO 调用 ------------------------------------------------------------- */

function appStub(env: AppEnv): Stub {
  return env.APP.get(env.APP.idFromName(APP_CFG_KEY));
}

async function call(env: AppEnv, path: string, body?: unknown): Promise<Row> {
  const res = await appStub(env).fetch(
    new Request('https://app.do' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  try {
    return (await res.json()) as Row;
  } catch {
    return { ok: false, error: '用户库返回异常' };
  }
}

/* 说明：`call()` 是底层的「拿到 DO 回包」，调用点各自判 ok ——
   这里不再包一层 `must()`，因为不同失败要映射成不同 HTTP 状态码。 */

/* ---- cookie -------------------------------------------------------------- */

function readCookie(req: Request, name: string): string {
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const s = part.trim();
    if (s.startsWith(name + '=')) return s.slice(name.length + 1);
  }
  return '';
}

function cookieHeader(req: Request, token: string, maxAge: number): string {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${APP_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function withCookie(data: unknown, cookie: string, status = 200): Response {
  const res = json(data, status);
  res.headers.set('set-cookie', cookie);
  return res;
}

/* ---- 时间 ---------------------------------------------------------------- */

/** 简单稳定散列，用来给每个用户一个固定的错峰分钟（0–44） */
function userJitter(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return h % 45;
}

/**
 * 下一次自动执行的时刻（真实 epoch 毫秒）。
 * `hh:mm` 按北京时间理解，再叠加这个用户的固定错峰分钟。
 *
 * 为什么要错峰：cron 每分钟一批只跑 6 个号（Workers 免费档 subrequest 50 的约束），
 * 500 个用户若都定在 22:00，需要将近一小时才能跑完。错峰后负载摊开，
 * 用户看到的时间仍是「约 22:00」。
 */
function nextRunAt(userId: string, hh: number, mm: number, now: number): number {
  const jitter = userJitter(userId);
  const d = new Date(now + 8 * 3600_000);
  let t =
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm) +
    jitter * 60_000 -
    8 * 3600_000;
  if (t <= now) t += 86400_000;
  return t;
}

/* ---- 频率限制 ------------------------------------------------------------ */

async function hitRate(
  env: AppEnv,
  key: string,
  windowMs: number,
  max: number,
  req: Request
): Promise<void> {
  const ip = req.headers.get('cf-connecting-ip') ?? 'local';
  const d = await call(env, '/rate', {
    key: `${key}:${ip}`,
    windowMs,
    max,
    now: Date.now(),
  });
  if (d.ok === false) {
    const retry = num(d.retryAfter, 60);
    throw new HttpError(429, `太频繁了，${retry} 秒后再试`);
  }
}

/* ==========================================================================
   视图
   ========================================================================== */

function userView(u: Row, now = Date.now()) {
  return {
    account: str(u.account),
    nick: str(u.nick) || str(u.account).split('@')[0],
    createdAt: num(u.createdAt ?? u.created_at),
    vipUntil: num(u.vipUntil ?? u.vip_until),
    isVip: num(u.vipUntil ?? u.vip_until) > now,
  };
}

function accountView(a: Row | null) {
  if (!a) return null;
  return {
    zeppUser: maskUser(str(a.zeppUser ?? a.zepp_user)),
    enabled: bool(a.enabled),
    auto: bool(a.auto),
    beforeHour: num(a.beforeHour ?? a.before_hour, 22),
    beforeMinute: num(a.beforeMinute ?? a.before_minute, 0),
    threshold: num(a.threshold, 8000),
    toMin: num(a.toMin ?? a.to_min, 10000),
    toMax: num(a.toMax ?? a.to_max, 12000),
    lastSteps: num(a.lastSteps ?? a.last_steps),
    lastRunAt: num(a.lastRunAt ?? a.last_run_at),
    lastRunOk: bool(a.lastRunOk ?? a.last_run_ok),
    lastRunMsg: str(a.lastRunMsg ?? a.last_run_msg),
    brushedDate: str(a.brushedDate ?? a.brushed_date),
    nextRunAt: num(a.nextRunAt ?? a.next_run_at),
    lastManualAt: num(a.lastManualAt ?? a.last_manual_at),
    manualDay: str(a.manualDay ?? a.manual_day),
    manualCount: num(a.manualCount ?? a.manual_count),
  };
}

function logView(items: unknown): Row[] {
  return Array.isArray(items) ? (items as Row[]) : [];
}

/* ---- 会话 ----------------------------------------------------------------- */

async function currentUser(req: Request, env: AppEnv): Promise<Row | null> {
  const token = readCookie(req, APP_COOKIE);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const d = await call(env, '/session-get', { tokenHash: hash, now: Date.now() });
  return d.ok && d.item ? (d.item as Row) : null;
}

async function startSession(req: Request, env: AppEnv, userId: string): Promise<string> {
  const token = randomToken();
  const hash = await sha256Hex(token);
  const now = Date.now();
  await call(env, '/session-create', {
    userId,
    tokenHash: hash,
    now,
    expiresAt: now + SESSION_DAYS * 86400_000,
  });
  return cookieHeader(req, token, SESSION_DAYS * 86400);
}

function requireAccountBody(account: string): string {
  const a = account.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._@-]{2,63}$/.test(a))
    throw new HttpError(400, '账号 3–64 位，只能用字母、数字与 . _ @ -');
  return a;
}

function requirePass(pass: string): string {
  if (pass.length < 6 || pass.length > 72) throw new HttpError(400, '密码 6–72 位');
  return pass;
}

/* ==========================================================================
   公开信息与状态
   ========================================================================== */

async function publicInfo(env: AppEnv): Promise<Row> {
  const d = await call(env, '/public');
  return {
    maxUsers: num(d.maxUsers, 500),
    userCount: num(d.userCount),
    open: d.open !== false,
    buyNote: str(d.buyNote),
    freeDaily: num(d.freeDaily, 50),
    freeInterval: num(d.freeInterval, 60),
  };
}

async function state(req: Request, env: AppEnv): Promise<Response> {
  const pub = await publicInfo(env);
  const user = await currentUser(req, env);
  return json({
    ok: true,
    logged: !!user,
    user: user ? userView(user) : null,
    public: pub,
    serverNow: Date.now(),
    today: beijingDate(),
  });
}

async function overview(req: Request, env: AppEnv): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, '请先登录');
  const uid = str(user.id);
  const acc = await call(env, `/account-get?uid=${encodeURIComponent(uid)}`);
  const logs = await call(env, `/logs?uid=${encodeURIComponent(uid)}&n=20`);
  return json({
    ok: true,
    user: userView(user),
    account: accountView((acc.item as Row) ?? null),
    logs: logView(logs.items),
    public: await publicInfo(env),
    serverNow: Date.now(),
    today: beijingDate(),
  });
}

/* ==========================================================================
   注册 / 登录 / 退出
   ========================================================================== */

async function register(req: Request, env: AppEnv): Promise<Response> {
  await hitRate(env, 'reg', 3600_000, 8, req);
  const b = (await req.json().catch(() => ({}))) as Row;
  const account = requireAccountBody(str(b.account));
  const pass = requirePass(str(b.pass));
  const nick = str(b.nick).trim().slice(0, 20);

  const pub = await publicInfo(env);
  if (pub.open === false) throw new HttpError(403, '注册暂未开放');
  if (num(pub.userCount) >= num(pub.maxUsers, 500))
    throw new HttpError(409, `名额已满（上限 ${num(pub.maxUsers, 500)} 人）`);

  const passHash = await hashPass(pass);
  const r = await call(env, '/user-create', { account, nick, passHash, now: Date.now() });
  if (r.ok === false) {
    const status = r.full ? 409 : 400;
    throw new HttpError(status, str(r.error) || '注册失败');
  }
  const user = r.user as Row;
  const cookie = await startSession(req, env, str(user.id));
  return withCookie({ ok: true, user: userView(user) }, cookie);
}

async function login(req: Request, env: AppEnv): Promise<Response> {
  await hitRate(env, 'login', 600_000, 30, req);
  const b = (await req.json().catch(() => ({}))) as Row;
  const account = requireAccountBody(str(b.account));
  const pass = str(b.pass);
  if (!pass) throw new HttpError(400, '请输入密码');

  const d = await call(env, '/user-login', { account });
  const item = (d.item as Row) ?? null;
  // 失败固定等一会儿：给短密码一点暴力破解的成本，同时不泄露「账号是否存在」
  if (!item || !(await verifyPass(pass, str(item.passHash)))) {
    await new Promise((r2) => setTimeout(r2, 500));
    throw new HttpError(401, '账号或密码不对');
  }
  const cookie = await startSession(req, env, str(item.id));
  await call(env, '/user-set', { id: str(item.id), lastLogin: Date.now() }).catch(() => ({}));
  return withCookie({ ok: true, user: userView(item) }, cookie);
}

async function logout(req: Request, env: AppEnv): Promise<Response> {
  const token = readCookie(req, APP_COOKIE);
  if (token) {
    const hash = await sha256Hex(token);
    await call(env, '/session-del', { tokenHash: hash }).catch(() => ({}));
  }
  return withCookie({ ok: true }, cookieHeader(req, '', 0));
}

/* ==========================================================================
   绑定 Zepp 账号 / 刷步 / 自动任务
   ========================================================================== */

async function bind(req: Request, env: AppEnv): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, '请先登录');
  await hitRate(env, 'bind', 600_000, 10, req);

  const b = (await req.json().catch(() => ({}))) as Row;
  const zeppUser = str(b.zeppUser).trim().slice(0, 120);
  const pwd = str(b.pwd);
  if (!zeppUser) throw new HttpError(400, '填 Zepp Life 的手机号或邮箱');
  if (pwd.length < 1 || pwd.length > 128) throw new HttpError(400, '密码不对');

  // 先真的登一次：密码错、账号不存在、上游连不上，都在这里拦住
  const tok = await ensureAppToken(zeppUser, pwd, null);
  if (!tok.ok) throw new HttpError(400, tok.error || 'Zepp 登录失败，检查账号密码');

  const uid = str(user.id);
  const pwdEnc = await encryptStr(env, pwd);
  const zeppKey = await sha256Hex('zepp:' + zeppUser.toLowerCase());
  const r = await call(env, '/account-put', {
    userId: uid,
    zeppUser,
    zeppKey,
    pwdEnc,
    tokens: JSON.stringify(tok.data),
    now: Date.now(),
  });
  if (r.ok === false) throw new HttpError(400, str(r.error) || '绑定失败');
  return json({ ok: true, account: accountView((r.item as Row) ?? null) });
}

async function unbind(req: Request, env: AppEnv): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, '请先登录');
  await call(env, '/account-del', { userId: str(user.id) });
  return json({ ok: true });
}

interface RawAccount extends Row {
  userId: string;
  zeppUser: string;
  pwdEnc: string;
  tokens: string;
  enabled: boolean;
  auto: boolean;
  beforeHour: number;
  beforeMinute: number;
  threshold: number;
  toMin: number;
  toMax: number;
  lastSteps: number;
  brushedDate: string;
  manualDay: string;
  manualCount: number;
  nextRunAt: number;
}

function rawAccount(a: Row): RawAccount {
  return {
    ...a,
    userId: str(a.userId ?? a.user_id),
    zeppUser: str(a.zeppUser ?? a.zepp_user),
    pwdEnc: str(a.pwdEnc ?? a.pwd_enc),
    tokens: str(a.tokens),
    enabled: bool(a.enabled),
    auto: bool(a.auto),
    beforeHour: num(a.beforeHour ?? a.before_hour, 22),
    beforeMinute: num(a.beforeMinute ?? a.before_minute, 0),
    threshold: num(a.threshold, 8000),
    toMin: num(a.toMin ?? a.to_min, 10000),
    toMax: num(a.toMax ?? a.to_max, 12000),
    lastSteps: num(a.lastSteps ?? a.last_steps),
    brushedDate: str(a.brushedDate ?? a.brushed_date),
    manualDay: str(a.manualDay ?? a.manual_day),
    manualCount: num(a.manualCount ?? a.manual_count),
    nextRunAt: num(a.nextRunAt ?? a.next_run_at),
  };
}

function parseTokens(s: string): ZeppTokens | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s) as ZeppTokens;
    return o && o.app_token ? o : null;
  } catch {
    return null;
  }
}

async function getRawAccount(env: AppEnv, userId: string): Promise<RawAccount | null> {
  const d = await call(env, `/account-get?uid=${encodeURIComponent(userId)}`);
  const raw = (d.raw as Row) ?? null;
  return raw ? rawAccount(raw) : null;
}

function pickBetween(min: number, max: number): number {
  const a = clampSteps(min);
  const b = clampSteps(Math.max(min, max));
  return a + Math.floor(Math.random() * (b - a + 1));
}

async function brush(req: Request, env: AppEnv): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, '请先登录');
  const uid = str(user.id);
  const b = (await req.json().catch(() => ({}))) as Row;
  const steps = clampSteps(num(b.steps, -1));
  if (!Number.isFinite(Number(b.steps)) || Number(b.steps) < 0 || Number(b.steps) > STEP_HARD_MAX)
    throw new HttpError(400, `目标步数要在 0–${STEP_HARD_MAX} 之间`);

  const acc = await getRawAccount(env, uid);
  if (!acc) throw new HttpError(400, '还没有绑定 Zepp Life 账号');

  const pub = await publicInfo(env);
  const now = Date.now();
  const today = beijingDate(now);
  // 频率限制：短间隔 + 每天次数上限。手动刷步免费，但服务器与华米接口有成本
  if (now - num(acc.lastManualAt) < num(pub.freeInterval, 60) * 1000)
    throw new HttpError(429, `刷得太快了，${num(pub.freeInterval, 60)} 秒后再试`);
  const usedToday = acc.manualDay === today ? num(acc.manualCount) : 0;
  if (usedToday >= num(pub.freeDaily, 50))
    throw new HttpError(429, '今天的次数用完了（明天再来）');

  let pwd: string;
  try {
    pwd = await decryptStr(env, acc.pwdEnc);
  } catch {
    throw new HttpError(400, '绑定信息失效，请重新绑定一次 Zepp 账号');
  }

  const r = await runBrush(acc.zeppUser, pwd, parseTokens(acc.tokens), steps);
  const ts = Date.now();
  if (!r.ok) {
    await call(env, '/log-add', {
      userId: uid,
      steps,
      ok: false,
      msg: r.error,
      via: 'manual',
      ts,
    }).catch(() => ({}));
    throw new HttpError(502, r.error || '刷步失败');
  }

  await call(env, '/account-mark-run', {
    userId: uid,
    steps: r.data.steps,
    ok: true,
    msg: `手动刷到 ${r.data.steps} 步`,
    brushedDate: today,
    nextRunAt: acc.nextRunAt,
    tokens: JSON.stringify(r.data.tokens),
    now: ts,
  });
  await call(env, '/account-manual-mark', {
    userId: uid,
    at: ts,
    day: today,
    count: usedToday + 1,
  });
  await call(env, '/log-add', {
    userId: uid,
    steps: r.data.steps,
    ok: true,
    msg: `手动刷到 ${r.data.steps} 步`,
    via: 'manual',
    ts,
  });
  return json({
    ok: true,
    steps: r.data.steps,
    todayBefore: r.data.todayBefore,
    usedToday: usedToday + 1,
    dailyLimit: num(pub.freeDaily, 50),
  });
}

async function sync(req: Request, env: AppEnv): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, '请先登录');
  const uid = str(user.id);
  const acc = await getRawAccount(env, uid);
  if (!acc) throw new HttpError(400, '还没有绑定 Zepp Life 账号');

  let pwd: string;
  try {
    pwd = await decryptStr(env, acc.pwdEnc);
  } catch {
    throw new HttpError(400, '绑定信息失效，请重新绑定一次 Zepp 账号');
  }
  const tok = await ensureAppToken(acc.zeppUser, pwd, parseTokens(acc.tokens));
  if (!tok.ok) throw new HttpError(502, tok.error || '读取失败');
  const n = await getTodaySteps(tok.data.app_token, tok.data.user_id);
  if (n == null) {
    /* Zepp 的读步接口偶尔会整个不可用（2026-10 实测 GET band_data 直接 400）。
       这时不要报错把用户挡在门外：显示上次记录，并标明「不是刚读的」。 */
    await call(env, '/account-patch', { userId: uid, tokens: JSON.stringify(tok.data) });
    return json({
      ok: true,
      steps: acc.lastSteps,
      stale: true,
      note: 'Zepp 暂时读不到今日步数，下面显示的是上次记录；刷步本身不受影响',
    });
  }
  await call(env, '/account-patch', {
    userId: uid,
    lastSteps: n,
    tokens: JSON.stringify(tok.data),
  });
  return json({ ok: true, steps: n, stale: false });
}

/** 管理自动任务配置。开自动必须 VIP —— 这就是付费点 */
async function autoConfig(req: Request, env: AppEnv): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, '请先登录');
  const uid = str(user.id);
  const acc = await getRawAccount(env, uid);
  if (!acc) throw new HttpError(400, '还没有绑定 Zepp Life 账号');

  const b = (await req.json().catch(() => ({}))) as Row;
  const auto = bool(b.auto);
  if (auto && !userView(user).isVip)
    throw new HttpError(403, '自动任务需要 VIP：先兑换卡密');

  const hh = Math.max(0, Math.min(23, num(b.beforeHour, acc.beforeHour)));
  const mm = Math.max(0, Math.min(59, num(b.beforeMinute, acc.beforeMinute)));
  const threshold = clampSteps(num(b.threshold, acc.threshold));
  let toMin = clampSteps(num(b.toMin, acc.toMin));
  let toMax = clampSteps(num(b.toMax, acc.toMax));
  if (toMin > toMax) [toMin, toMax] = [toMax, toMin];
  if (toMax <= toMin) toMax = Math.min(STEP_HARD_MAX, toMin + 1000);

  const next = auto ? nextRunAt(uid, hh, mm, Date.now()) : 0;
  await call(env, '/account-patch', {
    userId: uid,
    auto,
    enabled: auto ? true : bool(acc.enabled),
    beforeHour: hh,
    beforeMinute: mm,
    threshold,
    toMin,
    toMax,
    nextRunAt: next,
  });
  const fresh = await call(env, `/account-get?uid=${encodeURIComponent(uid)}`);
  return json({
    ok: true,
    account: accountView((fresh.item as Row) ?? null),
    nextRunAt: next,
  });
}

/**
 * 立即按当前规则跑一次。给 VIP 的「测试一下」用，也方便验收。
 * 不改变下一次定时执行的时刻（跑一次不该打乱计划）。
 */
async function autoTest(req: Request, env: AppEnv): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, '请先登录');
  const uid = str(user.id);
  const uv = userView(user);
  if (!uv.isVip) throw new HttpError(403, '自动任务需要 VIP');
  const acc = await getRawAccount(env, uid);
  if (!acc) throw new HttpError(400, '还没有绑定 Zepp Life 账号');

  const r = await runAutoAccount(env, acc, { force: true });
  return json({ ...r });
}

/* ==========================================================================
   自动任务执行器（cron 每分钟一批）
   ========================================================================== */

interface AutoResult {
  ok: boolean;
  skipped?: string;
  steps?: number;
  error?: string;
  msg: string;
}

/**
 * 跑一个账号的自动规则。
 * 语义与单人工具一致：读今日真实步数 → 不足 threshold 才刷 → 刷到 toMin–toMax 的随机值。
 * 每个账号一天只跑一次（成功或跳过都记一笔，并把 next_run_at 推到明天）。
 */
async function runAutoAccount(
  env: AppEnv,
  acc: RawAccount,
  opts: { force?: boolean } = {}
): Promise<AutoResult> {
  const now = Date.now();
  const today = beijingDate(now);

  let pwd: string;
  try {
    pwd = await decryptStr(env, acc.pwdEnc);
  } catch {
    const msg = '绑定信息失效，请重新绑定 Zepp 账号';
    await finishAuto(env, acc, 0, false, msg, today);
    return { ok: false, error: msg, msg };
  }

  // 1. 读今日真实步数。读不到就用上次记账值（宁可少刷一次，不要盲目覆盖）
  const tok = await ensureAppToken(acc.zeppUser, pwd, parseTokens(acc.tokens));
  if (!tok.ok) {
    const msg = tok.error || 'Zepp 登录失败';
    await finishAuto(env, acc, 0, false, msg, today, acc.tokens);
    return { ok: false, error: msg, msg };
  }
  const freshTokens = JSON.stringify(tok.data);
  const current = await getTodaySteps(tok.data.app_token, tok.data.user_id);
  /* 读不到今日步数时用「今天已经刷过的值」兜底；**昨天的不算** ——
     否则昨天刷到 25000，今天一上来就被判成「已达标」而永远不刷。
     `brushedDate` 只有当天真的写入成功/手动刷成功才会更新成今天。 */
  const lastKnown = acc.brushedDate === today ? acc.lastSteps : 0;
  const currentSteps = current ?? lastKnown;

  if (currentSteps >= acc.threshold) {
    const msg = `已达标：今日 ${currentSteps} 步 ≥ ${acc.threshold}，不刷`;
    await finishAuto(env, acc, currentSteps, true, msg, acc.brushedDate, freshTokens);
    return { ok: true, skipped: msg, msg };
  }

  // 2. 未达标 → 刷到目标区间随机值
  const target = pickBetween(acc.toMin, acc.toMax);
  const post = await postSteps(tok.data.app_token, tok.data.user_id, target);
  if (!post.ok) {
    const msg = post.error || '提交步数失败';
    await finishAuto(env, acc, currentSteps, false, msg, acc.brushedDate, freshTokens);
    return { ok: false, error: msg, msg };
  }

  const msg = opts.force
    ? `自动测试：今日 ${currentSteps} 步，已刷到 ${post.data} 步`
    : `自动完成：今日 ${currentSteps} 步，已刷到 ${post.data} 步`;
  await finishAuto(env, acc, post.data, true, msg, today, freshTokens);
  return { ok: true, steps: post.data, msg };
}

async function finishAuto(
  env: AppEnv,
  acc: RawAccount,
  steps: number,
  ok: boolean,
  msg: string,
  brushedDate: string,
  tokens?: string
): Promise<void> {
  const now = Date.now();
  const next = nextRunAt(acc.userId, acc.beforeHour, acc.beforeMinute, now);
  await call(env, '/account-mark-run', {
    userId: acc.userId,
    steps,
    ok,
    msg,
    brushedDate,
    nextRunAt: next,
    tokens: tokens && tokens !== 'undefined' ? tokens : '',
    now,
  });
  await call(env, '/log-add', {
    userId: acc.userId,
    steps,
    ok,
    msg,
    via: 'auto',
    ts: now,
  });
}

/** cron 入口：每分钟取到期任务，一批最多 6 个（免费档 subrequest 50 的约束） */
export async function appAutoTick(env: AppEnv): Promise<{ ran: number; skipped: number }> {
  const now = Date.now();
  const due = await call(env, '/due', { now, limit: 6 });
  const items = Array.isArray(due.items) ? (due.items as Row[]) : [];
  let ran = 0;
  let skipped = 0;
  for (const a of items) {
    const acc = rawAccount(a);
    try {
      const r = await runAutoAccount(env, acc);
      if (r.ok) ran++;
      else skipped++;
    } catch {
      skipped++;
    }
    await new Promise((r2) => setTimeout(r2, 250));
  }
  return { ran, skipped };
}

/* ==========================================================================
   卡密兑换
   ========================================================================== */

async function redeem(req: Request, env: AppEnv): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, '请先登录');
  await hitRate(env, 'redeem', 600_000, 15, req);
  const b = (await req.json().catch(() => ({}))) as Row;
  const code = str(b.code).trim().toUpperCase();
  if (!code) throw new HttpError(400, '填卡密');
  const r = await call(env, '/card-redeem', { code, userId: str(user.id), now: Date.now() });
  if (r.ok === false) throw new HttpError(400, str(r.error) || '兑换失败');
  return json({
    ok: true,
    days: num(r.days),
    vipUntil: num(r.vipUntil),
  });
}

/* ==========================================================================
   路由：/api/app/*
   ========================================================================== */

function pathOf(req: Request): string {
  const p = new URL(req.url).pathname;
  return p.startsWith('/api/app/') ? p.slice('/api/app/'.length).replace(/\/+$/, '') : '';
}

export async function appApi(req: Request, env: AppEnv): Promise<Response> {
  // 同源检查：与后台同口径。curl 不带这个头，本机验收不受影响
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return json({ ok: false, error: '只服务本站页面' }, 403);

  const p = pathOf(req);
  const method = req.method;

  try {
    switch (p) {
      case 'state':
        if (method !== 'GET') return json({ ok: false, error: '只接 GET' }, 405);
        return await state(req, env);

      case 'register':
        if (method !== 'POST') return json({ ok: false, error: '只接 POST' }, 405);
        return await register(req, env);

      case 'login':
        if (method !== 'POST') return json({ ok: false, error: '只接 POST' }, 405);
        return await login(req, env);

      case 'logout':
        return await logout(req, env);

      case 'overview':
        if (method !== 'GET') return json({ ok: false, error: '只接 GET' }, 405);
        return await overview(req, env);

      case 'bind':
        if (method !== 'POST') return json({ ok: false, error: '只接 POST' }, 405);
        return await bind(req, env);

      case 'unbind':
        if (method !== 'POST') return json({ ok: false, error: '只接 POST' }, 405);
        return await unbind(req, env);

      case 'brush':
        if (method !== 'POST') return json({ ok: false, error: '只接 POST' }, 405);
        return await brush(req, env);

      case 'sync':
        if (method !== 'POST') return json({ ok: false, error: '只接 POST' }, 405);
        return await sync(req, env);

      case 'auto-config':
        if (method !== 'POST') return json({ ok: false, error: '只接 POST' }, 405);
        return await autoConfig(req, env);

      case 'auto-test':
        if (method !== 'POST') return json({ ok: false, error: '只接 POST' }, 405);
        return await autoTest(req, env);

      case 'redeem':
        if (method !== 'POST') return json({ ok: false, error: '只接 POST' }, 405);
        return await redeem(req, env);

      default:
        return json({ ok: false, error: '没有这个接口' }, 404);
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status);
    return json(
      { ok: false, error: e instanceof Error ? e.message : '服务端出了点问题' },
      500
    );
  }
}

/* ==========================================================================
   后台接口（由 worker.ts 的 /api/admin/* 在登录后转进来）
   ========================================================================== */

function genCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 16; i++) {
    const b = crypto.getRandomValues(new Uint8Array(1))[0]!;
    s += alphabet[b % alphabet.length];
  }
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

export async function adminAppGet(env: AppEnv, path: string, url: URL): Promise<Response | null> {
  if (path === 'app-users') {
    const q = url.searchParams.get('q') ?? '';
    const d = await call(env, `/users?q=${encodeURIComponent(q)}&limit=300`);
    const items = Array.isArray(d.items) ? (d.items as Row[]) : [];
    return json({
      ok: true,
      items: items.map((x) => ({
        id: str(x.id),
        account: str(x.account),
        nick: str(x.nick),
        createdAt: num(x.createdAt),
        vipUntil: num(x.vipUntil),
        isVip: num(x.vipUntil) > Date.now(),
        status: num(x.status, 1),
        bound: !!x.bound,
        zeppUser: str(x.zeppUser),
        lastSteps: num(x.lastSteps),
        lastRunAt: num(x.lastRunAt),
        lastRunOk: !!x.lastRunOk,
        nextRunAt: num(x.nextRunAt),
      })),
      total: num(d.total),
      vip: num(d.vip),
      bound: num(d.bound),
    });
  }

  if (path === 'app-cards') {
    const q = url.searchParams.get('q') ?? '';
    const d = await call(env, `/cards?q=${encodeURIComponent(q)}&limit=300`);
    return json({
      ok: true,
      items: Array.isArray(d.items) ? d.items : [],
      unused: num(d.unused),
      used: num(d.used),
    });
  }

  if (path === 'app-config') {
    const pub = await publicInfo(env);
    return json({ ok: true, config: pub });
  }

  if (path === 'app-stats') {
    return json(await call(env, '/stats'));
  }

  return null;
}

export async function adminAppPost(
  env: AppEnv,
  path: string,
  body: Record<string, unknown>
): Promise<Response | null> {
  const strv = (v: unknown) => (typeof v === 'string' ? v : '');
  const numv = (v: unknown, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : d;
  };

  if (path === 'app-user-vip') {
    const id = strv(body.id);
    if (!id) return json({ ok: false, error: '缺 id' }, 400);
    if (body.vipUntil !== undefined) {
      const r = await call(env, '/user-vip-set', {
        id,
        vipUntil: Math.max(0, numv(body.vipUntil)),
      });
      return json(r, r.ok === false ? 400 : 200);
    }
    const days = Math.max(1, Math.min(3650, numv(body.days, 30)));
    const r = await call(env, '/user-vip-add', { id, days, now: Date.now() });
    return json(r, r.ok === false ? 400 : 200);
  }

  if (path === 'app-user-set') {
    const id = strv(body.id);
    if (!id) return json({ ok: false, error: '缺 id' }, 400);
    const patch: Row = { id };
    if (body.nick !== undefined) patch.nick = strv(body.nick);
    if (body.status !== undefined) patch.status = body.status ? 1 : 0;
    const r = await call(env, '/user-set', patch);
    return json(r, r.ok === false ? 400 : 200);
  }

  if (path === 'app-user-del') {
    const id = strv(body.id);
    if (!id) return json({ ok: false, error: '缺 id' }, 400);
    return json(await call(env, '/user-del', { id }));
  }

  if (path === 'app-card-gen') {
    const count = Math.max(1, Math.min(100, numv(body.count, 10)));
    const days = Math.max(1, Math.min(3650, numv(body.days, 30)));
    const note = strv(body.note).slice(0, 120);
    const codes: string[] = [];
    const seen = new Set<string>();
    while (codes.length < count) {
      const c = genCode();
      if (seen.has(c)) continue;
      seen.add(c);
      codes.push(c);
    }
    const r = await call(env, '/card-create', { codes, days, note, now: Date.now() });
    return json({ ok: r.ok !== false, codes, days, added: num(r.added) });
  }

  if (path === 'app-card-del') {
    const code = strv(body.code).trim().toUpperCase();
    if (!code) return json({ ok: false, error: '缺卡密' }, 400);
    return json(await call(env, '/card-del', { code }));
  }

  if (path === 'app-config-save') {
    const patch: Row = {};
    if (body.maxUsers !== undefined) patch.max_users = String(Math.max(1, Math.min(5000, numv(body.maxUsers, 500))));
    if (body.buyNote !== undefined) patch.buy_note = strv(body.buyNote).slice(0, 1000);
    if (body.freeDaily !== undefined) patch.free_daily = String(Math.max(1, Math.min(500, numv(body.freeDaily, 50))));
    if (body.freeInterval !== undefined) patch.free_interval = String(Math.max(10, Math.min(600, numv(body.freeInterval, 60))));
    if (body.open !== undefined) patch.register_open = body.open ? '1' : '0';
    const r = await call(env, '/cfg-set', patch);
    return json({ ok: r.ok !== false, saved: r.saved ?? [] });
  }

  if (path === 'app-auto-run') {
    const r = await appAutoTick(env);
    return json({ ...r, ok: true });
  }

  return null;
}
