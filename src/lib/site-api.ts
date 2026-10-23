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

import { clampSteps, maskUser, STEP_HARD_MAX } from '../data/steps';
import { runBrush, type ZeppTokens } from '../data/zepp';
import {
  currentUser,
  endSession,
  hashPass,
  passOk,
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

    /* 工具「帮您走走」的只读状态（R52）。**只回自己的**：账号按 user_id 取，
       密码一个字都不出去，返回的是脱敏名。自动刷步的情况不在这里 —— 那是后台的事。 */
    if (sub === 'steps' && request.method === 'GET') {
      const me = await currentUser(env, request);
      if (!me) return json({ ok: true, logged: false, account: null, log: [] });
      const [acc, lg] = await Promise.all([
        siteCall(env, '/step-user-get?userId=' + encodeURIComponent(me.id)),
        siteCall(env, '/step-user-log-list?userId=' + encodeURIComponent(me.id) + '&n=20'),
      ]);
      const row = acc.row as
        | { zepp_user?: string; enabled?: number; last_steps?: number; last_run_at?: number; last_ok?: number; last_msg?: string }
        | null;
      return json({
        ok: true,
        logged: true,
        account: row
          ? {
              userMask: maskUser(String(row.zepp_user ?? '')),
              enabled: Number(row.enabled ?? 1) === 1,
              lastSteps: Number(row.last_steps ?? 0),
              lastRunAt: Number(row.last_run_at ?? 0),
              lastOk: Number(row.last_ok ?? 0) === 1,
              lastMsg: String(row.last_msg ?? ''),
            }
          : null,
        log: (lg.rows as unknown[]) ?? [],
      });
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

    /* ── 工具「帮您走走」（R52）───────────────────────────────────────────
       这一套与后台的「刷步」是两件事：
       · 后台管的是站长自己的多个账号与**自动规则**；
       · 这里管的是**登录用户自己的那一个**账号（一人一个，主键就是 user_id），
         只有手动刷，没有自动 —— 自动的情况只在后台显示（站主要求）。
       密码只进不出：保存之后接口只回脱敏名，任何响应里都没有明文。 */

    if (sub === 'steps-save') {
      const me = await currentUser(env, request);
      if (!me) return fail(401, '需要登录');
      const b = await readBody(request);
      const zeppUser = String(b.user ?? '').trim();
      const pwd = String(b.pwd ?? '');
      if (!/^\S{3,120}$/.test(zeppUser)) return fail(400, '填 Zepp Life 的手机号或邮箱');
      if (pwd && (pwd.length < 6 || pwd.length > 72)) return fail(400, '密码要 6~72 位');

      const raw = await siteCall(env, '/step-user-raw', { userId: me.id });
      const row = raw.row as { zepp_pwd?: string } | null;
      if (!(row && row.zepp_pwd) && !pwd) return fail(400, '第一次保存要把密码填上');

      await siteCall(env, '/step-user-put', {
        userId: me.id,
        zeppUser,
        zeppPwd: pwd,
        enabled: b.enabled !== false,
        now: Date.now(),
      });
      return json({ ok: true });
    }

    if (sub === 'steps-del') {
      const me = await currentUser(env, request);
      if (!me) return fail(401, '需要登录');
      await siteCall(env, '/step-user-del', { userId: me.id });
      return json({ ok: true });
    }

    if (sub === 'steps-run' || sub === 'steps-quick') {
      const me = await currentUser(env, request);
      if (!me) return fail(401, '需要登录');
      const b = await readBody(request);

      let zeppUser = '';
      let zeppPwd = '';
      let lastRunAt = 0;

      if (sub === 'steps-quick') {
        /* 不保存，刷完就走 —— 站主要的「或直接输入账号密码进行手动刷取」 */
        zeppUser = String(b.user ?? '').trim();
        zeppPwd = String(b.pwd ?? '');
        if (!zeppUser || !zeppPwd) return fail(400, '填账号和密码');
      } else {
        const raw = await siteCall(env, '/step-user-raw', { userId: me.id });
        const row = raw.row as { zepp_user?: string; zepp_pwd?: string } | null;
        if (!row || !row.zepp_user || !row.zepp_pwd) return fail(400, '先保存你的 Zepp 账号');
        zeppUser = row.zepp_user;
        zeppPwd = row.zepp_pwd;
        const acc = await siteCall(env, '/step-user-get', { userId: me.id });
        lastRunAt = Number((acc.row as { last_run_at?: number } | null)?.last_run_at ?? 0);
      }

      /* 45 秒节流：这个接口会拿别人的 Zepp 账号去登录上游，不该被连点刷穿 */
      if (Date.now() - lastRunAt < 45_000) return fail(429, '刚刷过，等 45 秒再刷');

      const asked = Number(b.steps);
      const target = Number.isFinite(asked) && asked > 0
        ? clampSteps(asked)
        : 10000 + Math.floor(Math.random() * 2001); // 默认 10000–12000 随机

      const r = await runBrush(zeppUser, zeppPwd, null as ZeppTokens | null, target);
      const now = Date.now();
      const ok = r.ok;
      const steps = r.ok ? r.data.steps : 0;
      const msg = r.ok ? '已刷到 ' + r.data.steps + ' 步' : r.error;

      if (sub === 'steps-run') {
        await siteCall(env, '/step-user-put', {
          userId: me.id,
          zeppUser,
          zeppPwd: '',
          enabled: true,
          lastSteps: steps,
          lastRunAt: now,
          lastOk: ok,
          lastMsg: msg,
          now,
        });
      }
      await siteCall(env, '/step-user-log-add', {
        userId: me.id,
        steps,
        ok,
        msg,
        now,
      });

      if (!ok) return fail(502, msg);
      return json({ ok: true, steps, target, max: STEP_HARD_MAX });
    }

    return fail(404, '没有这个接口');
  } catch (e) {
    return fail(502, e instanceof Error ? e.message : '账号服务异常');
  }
}

export { SITE_COOKIE };
export type { SiteUser };
