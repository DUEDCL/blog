/**
 * `/api/admin/site-*` —— 后台的「站点账号」管理：邀请码与用户。
 *
 * **鉴权不在这里做**：调用方（`src/worker.ts` 的 `admin()`）已经验过后台口令 cookie，
 * 只有 `logged` 为真才进来。这个文件只负责把请求转给 `SiteDB`，并做入参裁剪。
 *
 * 邀请码的几个语义（站主要求「有效期、使用次数手动可编辑」）：
 *   - `maxUses = 0` → 不限次数；`expiresAt = 0` → 永不过期；
 *   - 已用次数可以手动清零，方便复用同一个码；
 *   - 作废就是 `status = 0`，不删记录 —— 事后要能查到「这个码发过、被谁用了」。
 */

import { siteCall, type SiteEnv } from './site-auth';

interface Env extends SiteEnv {}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  return req
    .json()
    .then((v) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {}))
    .catch(() => ({}));
}

export async function adminSite(req: Request, env: Env, path: string): Promise<Response> {
  try {
    /* ---- 读 ---- */
    if (req.method === 'GET') {
      if (path === 'site-invites') return json(await siteCall(env, '/invite-list'));
      if (path === 'site-users') return json(await siteCall(env, '/user-list'));
      return json({ ok: false, error: '没有这个接口' }, 404);
    }

    if (req.method !== 'POST') return json({ ok: false, error: '只接 GET/POST' }, 405);
    const b = await body(req);
    const now = Date.now();

    switch (path) {
      /* 生成邀请码。count 一次最多 50 个；不填 code 就随机 */
      case 'site-invite-create': {
        const r = await siteCall(env, '/invite-create', {
          code: b.code,
          count: b.count ?? 1,
          maxUses: b.maxUses ?? 1,
          expiresAt: b.expiresAt ?? 0,
          note: b.note ?? '',
          now,
        });
        return json(r, r.ok ? 200 : 400);
      }

      /* 编辑：有效期 / 可用次数 / 备注 / 状态 / 已用次数清零 */
      case 'site-invite-update': {
        const r = await siteCall(env, '/invite-update', {
          code: b.code,
          maxUses: b.maxUses,
          expiresAt: b.expiresAt,
          note: b.note,
          status: b.status,
          usedCount: b.usedCount,
          now,
        });
        return json(r, r.ok ? 200 : 400);
      }

      case 'site-invite-delete': {
        const r = await siteCall(env, '/invite-delete', { code: b.code });
        return json(r, r.ok ? 200 : 400);
      }

      /* 停用/启用站点账号（停用会顺手清掉它的会话） */
      case 'site-user-status': {
        const r = await siteCall(env, '/user-set-status', {
          id: b.id,
          status: b.status,
          now,
        });
        return json(r, r.ok ? 200 : 400);
      }

      default:
        return json({ ok: false, error: '没有这个接口' }, 404);
    }
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : '站点账号服务异常' }, 502);
  }
}
