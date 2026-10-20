/**
 * `/api/site/*` —— 站点账号的四个接口（注册 / 登录 / 注销 / 我是谁）。
 *
 * 准入的判定也放在这个文件（`needsLogin` / `loginRedirect`），因为它和账号是同一件事：
 * 哪些路径要登录，只有这里说得清。
 *
 * ⚠️ 本文件是**公开仓库**里的代码：口令明文不进日志、不进响应、不进任何报错文本。
 *    所有失败一律回「账号或密码不对」这一句，不区分「没这个号」和「密码错」——
 *    否则接口就成了账号枚举器。
 */

import {
  currentUser,
  endSession,
  hashPass,
  passOk,
  sessionCookie,
  siteCall,
  startSession,
  SITE_COOKIE,
  type SiteEnv,
  type SiteUser,
} from './site-auth';

interface Env extends SiteEnv {}

function json(data: unknown, status = 200, cookie?: string): Response {
  const h = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  if (cookie) h.set('Set-Cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers: h });
}

function fail(status: number, error: string): Response {
  return json({ ok: false, error }, status);
}

function readBody(req: Request): Promise<Record<string, unknown>> {
  return req
    .json()
    .then((v) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {}))
    .catch(() => ({}));
}

/* ─────────────────────── 哪些路径要登录 ─────────────────────── */

/**
 * 站主要求：**工具页与「问沉麟的分身」只有登录用户能用，内容（文章/随笔/摄影/音乐）保持公开。**
 *
 * 要注意的点：
 *   - `/tv` 下的 `app.js` / `hls.min.js` 是静态资源，**不能拦**，否则登录页之外的
 *     任何引用都会挂；所以这里只认 HTML 导航（精确路径 + index.html）。
 *   - `/bushu`（步数管家）**不在此列**：它自己有 `bs_sess` 登录 + 卡密体系，
 *     再套一层会变成双重登录。
 */
export function needsLogin(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/api/chat') return true;
  if (p === '/tv' || p === '/tv/index.html') return true;
  if (p === '/tools' || p.startsWith('/tools/')) return true;
  return false;
}

/** 未登录访问页面时跳登录页，带上原地址供登录后回跳 */
export function loginRedirect(req: Request): Response {
  const u = new URL(req.url);
  const next = u.pathname + u.search;
  const to = `/login?next=${encodeURIComponent(next)}`;
  return new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });
}

/* ─────────────────────── 接口 ─────────────────────── */

export async function siteApi(request: Request, env: Env, url: URL): Promise<Response> {
  const sub = url.pathname.slice('/api/site/'.length).replace(/\/+$/, '');

  try {
    /* 我是谁 —— 页面用来决定显示登录还是账号 */
    if (sub === 'me' && request.method === 'GET') {
      const u = await currentUser(env, request);
      return json({ ok: true, user: u });
    }

    if (request.method !== 'POST') return fail(405, '只接 GET/POST');

    /* 注册：邀请码 + 自设账号密码 */
    if (sub === 'register') {
      const b = await readBody(request);
      const invite = String(b.invite ?? '').trim().toUpperCase();
      const account = String(b.account ?? '').trim();
      const pass = String(b.pass ?? '');
      const nick = String(b.nick ?? '').trim();

      if (!/^[A-Za-z0-9_-]{3,24}$/.test(account)) {
        return fail(400, '账号要 3~24 位，只能用字母、数字、下划线、横线');
      }
      if (pass.length < 6 || pass.length > 72) return fail(400, '密码要 6~72 位');
      if (!invite) return fail(400, '需要邀请码');

      const passHash = await hashPass(pass);
      // 建用户与占邀请码在 DO 里是同一步（原子）
      const r = await siteCall(env, '/user-create', {
        account,
        nick,
        passHash,
        inviteCode: invite,
        now: Date.now(),
      });
      if (!r.ok) return fail(400, String(r.error ?? '注册失败'));

      const u = r.user as { id: string; account: string; nick: string };
      const cookie = await startSession(env, request, u.id);
      await siteCall(env, '/user-touch', { id: u.id, now: Date.now() });
      return json({ ok: true, user: { id: u.id, account: u.account, nick: u.nick } }, 200, cookie);
    }

    /* 登录 */
    if (sub === 'login') {
      const b = await readBody(request);
      const account = String(b.account ?? '').trim();
      const pass = String(b.pass ?? '');
      if (!account || !pass) return fail(400, '请填账号和密码');

      const r = await siteCall(env, '/user-get', { account });
      const u = r.user as
        | { id: string; account: string; nick: string; pass_hash: string; status: number }
        | null;

      // 统一失败文案 + 固定等一会儿：给短口令买时间，也避免用响应快慢判账号存在
      const bad = async () => {
        await new Promise((res) => setTimeout(res, 600));
        return fail(401, '账号或密码不对');
      };

      if (!u || Number(u.status) !== 1) return bad();
      if (!(await passOk(pass, String(u.pass_hash ?? '')))) return bad();

      const cookie = await startSession(env, request, u.id);
      await siteCall(env, '/user-touch', { id: u.id, now: Date.now() });
      return json({ ok: true, user: { id: u.id, account: u.account, nick: u.nick } }, 200, cookie);
    }

    /* 注销 */
    if (sub === 'logout') {
      const cookie = await endSession(env, request);
      return json({ ok: true }, 200, cookie);
    }

    return fail(404, '没有这个接口');
  } catch (e) {
    return fail(502, e instanceof Error ? e.message : '账号服务异常');
  }
}

export { SITE_COOKIE };
export type { SiteUser };
