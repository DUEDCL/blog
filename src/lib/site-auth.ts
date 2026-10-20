/**
 * 站点账号的认证层：口令哈希、会话 cookie、当前用户解析。
 *
 * 写法和 `src/app.ts`（步数管家）一致，**但库是分开的**（`SiteDB`）：
 *   - 口令：PBKDF2-SHA256，20000 次，存成 `pbkdf2$<迭代>$<saltB64>$<hashB64>`；
 *   - 会话：随机 token 只发给浏览器，**库里只存它的 SHA-256 摘要** ——
 *     库被读走也登不进任何人的号；
 *   - cookie：`HttpOnly` + `SameSite=Lax` + 生产环境 `Secure`。
 *
 * 迭代数沿用 20000 而不是 OWASP 几十万：Workers Free 是 10 ms CPU/请求，
 * 而这里每登录一次要做一次派生。哈希本身不落明文、不进仓库，
 * 离线爆破的前提不成立 —— 与 `ADMIN_HASH` 那条注释是同一个取舍。
 */

const enc = new TextEncoder();
const PASS_ITER = 20000;
export const SITE_COOKIE = 'dl_sess';
export const SESSION_DAYS = 30;

export interface SiteUser {
  id: string;
  account: string;
  nick: string;
}

export interface SiteEnv {
  SITE: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(req: Request): Promise<Response> };
  };
}

/* ────────────────────────── 编解码 ────────────────────────── */

function b64(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function sha256Hex(s: string): Promise<string> {
  const bits = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function pbkdf2(pass: string, salt: Uint8Array, iter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations: iter },
    key,
    256
  );
  return b64(bits);
}

/** 生成可落库的口令哈希 */
export async function hashPass(pass: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await pbkdf2(pass, salt, PASS_ITER);
  return `pbkdf2$${PASS_ITER}$${b64(salt)}$${h}`;
}

/** 校验口令；格式不对一律当「不匹配」 */
export async function passOk(pass: string, stored: string): Promise<boolean> {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = Number(parts[1]);
  if (!Number.isFinite(iter) || iter < 1000 || iter > 200000) return false;
  let salt: Uint8Array;
  try {
    salt = unb64(parts[2]!);
  } catch {
    return false;
  }
  const got = await pbkdf2(pass, salt, iter);
  // 先比长度再逐字符（避免整串比较的短路泄漏；两串都是 base64 定长，够用）
  const a = got;
  const c = parts[3]!;
  if (a.length !== c.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ c.charCodeAt(i);
  return diff === 0;
}

/* ────────────────────────── cookie ────────────────────────── */

export function readCookie(req: Request, name: string): string {
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

export function sessionCookie(req: Request, token: string, maxAge: number): string {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${SITE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/* ────────────────────────── DO 调用 ────────────────────────── */

function stub(env: SiteEnv) {
  return env.SITE.get(env.SITE.idFromName('site'));
}

export async function siteCall(
  env: SiteEnv,
  path: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  try {
    const res = await stub(env).fetch(
      new Request('https://site.do' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    );
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: '用户库返回异常' };
  }
}

/* ────────────────────────── 当前用户 ────────────────────────── */

/** 解析当前请求的登录用户；没有/失效返回 null（不抛错） */
export async function currentUser(env: SiteEnv, req: Request): Promise<SiteUser | null> {
  const token = readCookie(req, SITE_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const r = await siteCall(env, '/session-get', { tokenHash, now: Date.now() });
  const u = r.user as { id?: unknown; account?: unknown; nick?: unknown } | null;
  if (!u || typeof u.id !== 'string') return null;
  return { id: u.id, account: String(u.account ?? ''), nick: String(u.nick ?? '') };
}

/** 开一个会话，返回要写进响应的 Set-Cookie */
export async function startSession(
  env: SiteEnv,
  req: Request,
  userId: string
): Promise<string> {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, '');
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  await siteCall(env, '/session-create', {
    tokenHash,
    userId,
    now,
    expiresAt: now + SESSION_DAYS * 86400000,
  });
  return sessionCookie(req, token, SESSION_DAYS * 86400);
}

/** 注销：删库里的会话 + 让浏览器丢掉 cookie */
export async function endSession(
  env: SiteEnv,
  req: Request
): Promise<string> {
  const token = readCookie(req, SITE_COOKIE);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await siteCall(env, '/session-del', { tokenHash });
  }
  return sessionCookie(req, '', 0);
}
