/**
 * SiteDB —— 站点账号体系的存储（SQLite 后端 Durable Object）。
 *
 * **为什么另开一个 DO，而不是复用 `AppDB`**：`AppDB` 是步数管家（多用户商用版）的库，
 * 里面的 user/card 语义绑着 Zepp 账号与 VIP 天数。站点登录是另一码事（邀请码注册、
 * 站点级会话、影视记录），混进去会让两套业务互相牵连 —— 改站点登录不该有把
 * 步数管家的用户表一起动了的风险。所以独立一个库，照 `app-db.ts` 的写法重写一遍。
 *
 * 单实例：`idFromName('site')`，所有站点账号都在同一个实例里（量级是几十到几百用户，
 * 不需要分片；分片反而让「账号唯一」与「邀请码原子占用」没法在同一个事务语义里做）。
 *
 * 并发安全的关键一条：**邀请码占用必须是原子的**。
 *   错的写法：先 SELECT 判 used_count < max_uses，再 UPDATE —— 两个请求可以同时通过判断。
 *   这里的写法：一条带条件的 UPDATE，然后看 `rowsWritten` 是不是 1。
 * DO 对同一实例的请求是串行的，加上这条 WHERE，一个码绝不可能发出两个账号。
 */

interface Env0 {
  /** 预留：以后要读 secret 从这里取，现在这个库不依赖任何配置 */
  [k: string]: unknown;
}

type Sql = {
  exec(sql: string, ...bindings: unknown[]): {
    toArray(): Record<string, unknown>[];
    rowsWritten?: number;
    rowsRead?: number;
  };
};

/** 邀请码字母表：去掉 0/O/1/I/L 这些念出来容易混淆的字符 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 10;

function genCode(): string {
  const buf = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[buf[i]! % CODE_ALPHABET.length];
  return out;
}

function asInt(v: unknown, dflt = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}
function asStr(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export class SiteDB {
  #sql: Sql;

  constructor(state: { storage: { sql: Sql } }, _env: Env0) {
    this.#sql = state.storage.sql;
    this.#init();
  }

  #init(): void {
    const ddl = [
      `CREATE TABLE IF NOT EXISTS site_user (
         id            TEXT    PRIMARY KEY,
         account       TEXT    NOT NULL UNIQUE,
         nick          TEXT    NOT NULL DEFAULT '',
         pass_hash     TEXT    NOT NULL,
         created_at    INTEGER NOT NULL,
         last_login_at INTEGER NOT NULL DEFAULT 0,
         status        INTEGER NOT NULL DEFAULT 1,
         invite        TEXT    NOT NULL DEFAULT ''
       )`,
      `CREATE TABLE IF NOT EXISTS site_session (
         token_hash TEXT    PRIMARY KEY,
         user_id    TEXT    NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_ss_user ON site_session(user_id)`,
      /* 邀请码。`max_uses = 0` 表示不限次数；`expires_at = 0` 表示永不过期。
         `used_count` 是已成功注册的人数，与 `max_uses` 比较决定还能不能用。 */
      `CREATE TABLE IF NOT EXISTS invite (
         code       TEXT    PRIMARY KEY,
         max_uses   INTEGER NOT NULL DEFAULT 1,
         used_count INTEGER NOT NULL DEFAULT 0,
         expires_at INTEGER NOT NULL DEFAULT 0,
         note       TEXT    NOT NULL DEFAULT '',
         created_at INTEGER NOT NULL,
         status     INTEGER NOT NULL DEFAULT 1
       )`,
      `CREATE INDEX IF NOT EXISTS idx_invite_created ON invite(created_at)`,
      /* 影视搜索记录：一人一条关键词，重搜只更新 ts */
      `CREATE TABLE IF NOT EXISTS tv_q (
         user_id TEXT    NOT NULL,
         q       TEXT    NOT NULL,
         ts      INTEGER NOT NULL,
         PRIMARY KEY (user_id, q)
       )`,
      /* 影视播放进度：k 是 `片名||集名` */
      `CREATE TABLE IF NOT EXISTS tv_prog (
         user_id   TEXT    NOT NULL,
         k         TEXT    NOT NULL,
         name      TEXT    NOT NULL DEFAULT '',
         ep_name   TEXT    NOT NULL DEFAULT '',
         t         INTEGER NOT NULL DEFAULT 0,
         d         INTEGER NOT NULL DEFAULT 0,
         ts        INTEGER NOT NULL,
         src_id    TEXT    NOT NULL DEFAULT '',
         vod_id    TEXT    NOT NULL DEFAULT '',
         src_name  TEXT    NOT NULL DEFAULT '',
         line_idx  INTEGER NOT NULL DEFAULT 0,
         line_from TEXT    NOT NULL DEFAULT '',
         PRIMARY KEY (user_id, k)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_tvprog_ts ON tv_prog(user_id, ts DESC)`,
    ];
    for (const sql of ddl) this.#sql.exec(sql);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    let b: Record<string, unknown> = {};
    if (req.method === 'POST') {
      try {
        b = (await req.json()) as Record<string, unknown>;
      } catch {
        b = {};
      }
    }
    const q = (k: string) => url.searchParams.get(k) ?? '';
    const now = asInt(b.now) || Date.now();

    const reply = (o: unknown): Response =>
      new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });

    try {
      switch (p) {
        /* ══════════ 邀请码 ══════════ */

        /* 生成：可以不指定 code（自动随机），也可以指定；count 控制一次生成几个 */
        case '/invite-create': {
          const count = Math.min(50, Math.max(1, asInt(b.count, 1)));
          const maxUses = Math.max(0, asInt(b.maxUses, 1)); // 0 = 不限
          const expiresAt = Math.max(0, asInt(b.expiresAt, 0));
          const note = asStr(b.note, 80);
          const wanted = asStr(b.code, 64).trim().toUpperCase();

          const made: string[] = [];
          for (let i = 0; i < count; i++) {
            // 前几个用调用方给的码（只对 count=1 有意义），其余随机；撞了就重试
            let code = i === 0 && wanted ? wanted : genCode();
            let tries = 0;
            while (true) {
              const exists = this.#sql
                .exec(`SELECT code FROM invite WHERE code = ?`, code)
                .toArray();
              if (exists.length === 0) break;
              if (++tries > 5) throw new Error('邀请码重复，换个码再试');
              code = genCode();
            }
            this.#sql.exec(
              `INSERT INTO invite (code, max_uses, used_count, expires_at, note, created_at, status)
               VALUES (?, ?, 0, ?, ?, ?, 1)`,
              code,
              maxUses,
              expiresAt,
              note,
              now
            );
            made.push(code);
          }
          return reply({ ok: true, codes: made });
        }

        case '/invite-list': {
          const rows = this.#sql
            .exec(
              `SELECT code, max_uses, used_count, expires_at, note, created_at, status
               FROM invite ORDER BY created_at DESC LIMIT 500`
            )
            .toArray();
          return reply({ ok: true, rows });
        }

        /* 手动编辑：有效期 / 可用次数 / 备注 / 启用停用 */
        case '/invite-update': {
          const code = asStr(b.code, 64).toUpperCase();
          if (!code) return reply({ ok: false, error: '缺少 code' });
          const sets: string[] = [];
          const vals: unknown[] = [];
          if (b.maxUses !== undefined) {
            sets.push('max_uses = ?');
            vals.push(Math.max(0, asInt(b.maxUses, 1)));
          }
          if (b.expiresAt !== undefined) {
            sets.push('expires_at = ?');
            vals.push(Math.max(0, asInt(b.expiresAt, 0)));
          }
          if (b.note !== undefined) {
            sets.push('note = ?');
            vals.push(asStr(b.note, 80));
          }
          if (b.status !== undefined) {
            sets.push('status = ?');
            vals.push(asInt(b.status, 1) ? 1 : 0);
          }
          if (b.usedCount !== undefined) {
            // 允许站长手动清零（比如想复用同一个码）
            sets.push('used_count = ?');
            vals.push(Math.max(0, asInt(b.usedCount, 0)));
          }
          if (!sets.length) return reply({ ok: false, error: '没有要改的字段' });
          const cur = this.#sql.exec(
            `UPDATE invite SET ${sets.join(', ')} WHERE code = ?`,
            ...vals,
            code
          );
          return reply({ ok: (cur.rowsWritten ?? 0) > 0 });
        }

        case '/invite-delete': {
          const code = asStr(b.code, 64).toUpperCase();
          const cur = this.#sql.exec(`DELETE FROM invite WHERE code = ?`, code);
          return reply({ ok: (cur.rowsWritten ?? 0) > 0 });
        }

        /* ══════════ 用户 ══════════ */

        /*
         * 注册 = 「原子占用邀请码」+「建用户」两件事。
         * 邀请码那一步是一条带条件的 UPDATE，`rowsWritten === 1` 才算抢到；
         * 抢不到就直接回错误，绝不建用户。
         */
        case '/user-create': {
          const account = asStr(b.account, 40).trim();
          const nick = asStr(b.nick, 20).trim();
          const passHash = asStr(b.passHash, 300);
          const invite = asStr(b.inviteCode, 64).trim().toUpperCase();
          if (!account || !passHash) return reply({ ok: false, error: '账号或密码为空' });

          // 账号已存在？
          const dup = this.#sql.exec(`SELECT id FROM site_user WHERE account = ?`, account).toArray();
          if (dup.length) return reply({ ok: false, error: '这个账号名已被使用' });

          if (invite) {
            const claim = this.#sql.exec(
              `UPDATE invite SET used_count = used_count + 1
               WHERE code = ? AND status = 1
                 AND (max_uses = 0 OR used_count < max_uses)
                 AND (expires_at = 0 OR expires_at > ?)`,
              invite,
              now
            );
            if ((claim.rowsWritten ?? 0) !== 1) {
              return reply({ ok: false, error: '邀请码无效、已用尽或已过期' });
            }
          } else if (!asInt(b.allowNoInvite, 0)) {
            return reply({ ok: false, error: '需要邀请码' });
          }

          const id = crypto.randomUUID();
          this.#sql.exec(
            `INSERT INTO site_user (id, account, nick, pass_hash, created_at, last_login_at, status, invite)
             VALUES (?, ?, ?, ?, ?, 0, 1, ?)`,
            id,
            account,
            nick || account,
            passHash,
            now,
            invite
          );
          return reply({ ok: true, user: { id, account, nick: nick || account } });
        }

        case '/user-get': {
          const account = asStr(b.account, 40).trim();
          const rows = this.#sql
            .exec(
              `SELECT id, account, nick, pass_hash, status, invite FROM site_user WHERE account = ?`,
              account
            )
            .toArray();
          return reply({ ok: true, user: rows[0] ?? null });
        }

        case '/user-by-id': {
          const id = asStr(b.id, 64);
          const rows = this.#sql
            .exec(
              `SELECT id, account, nick, status FROM site_user WHERE id = ?`,
              id
            )
            .toArray();
          return reply({ ok: true, user: rows[0] ?? null });
        }

        case '/user-list': {
          const rows = this.#sql
            .exec(
              `SELECT u.id, u.account, u.nick, u.created_at, u.last_login_at, u.status, u.invite,
                      (SELECT COUNT(*) FROM tv_prog p WHERE p.user_id = u.id) AS prog_count
               FROM site_user u ORDER BY u.created_at DESC LIMIT 500`
            )
            .toArray();
          return reply({ ok: true, rows });
        }

        case '/user-set-status': {
          const id = asStr(b.id, 64);
          const st = asInt(b.status, 1) ? 1 : 0;
          const cur = this.#sql.exec(`UPDATE site_user SET status = ? WHERE id = ?`, st, id);
          // 停用顺手清会话，避免「已停用但还能用」
          if (st === 0) this.#sql.exec(`DELETE FROM site_session WHERE user_id = ?`, id);
          return reply({ ok: (cur.rowsWritten ?? 0) > 0 });
        }

        case '/user-touch': {
          const id = asStr(b.id, 64);
          this.#sql.exec(`UPDATE site_user SET last_login_at = ? WHERE id = ?`, now, id);
          return reply({ ok: true });
        }

        /* ══════════ 会话 ══════════ */

        case '/session-create': {
          const tokenHash = asStr(b.tokenHash, 64);
          const userId = asStr(b.userId, 64);
          const expiresAt = asInt(b.expiresAt, now + 86400000);
          if (!tokenHash || !userId) return reply({ ok: false, error: '参数不全' });
          this.#sql.exec(
            `INSERT OR REPLACE INTO site_session (token_hash, user_id, created_at, expires_at)
             VALUES (?, ?, ?, ?)`,
            tokenHash,
            userId,
            now,
            expiresAt
          );
          return reply({ ok: true });
        }

        case '/session-get': {
          const tokenHash = asStr(b.tokenHash, 64);
          const rows = this.#sql
            .exec(`SELECT user_id, expires_at FROM site_session WHERE token_hash = ?`, tokenHash)
            .toArray();
          const hit = rows[0];
          if (!hit) return reply({ ok: true, user: null });
          if (asInt(hit.expires_at) <= now) {
            this.#sql.exec(`DELETE FROM site_session WHERE token_hash = ?`, tokenHash);
            return reply({ ok: true, user: null });
          }
          const u = this.#sql
            .exec(`SELECT id, account, nick, status FROM site_user WHERE id = ?`, asStr(hit.user_id, 64))
            .toArray()[0];
          if (!u || asInt(u.status) !== 1) return reply({ ok: true, user: null });
          return reply({ ok: true, user: u });
        }

        case '/session-del': {
          const tokenHash = asStr(b.tokenHash, 64);
          this.#sql.exec(`DELETE FROM site_session WHERE token_hash = ?`, tokenHash);
          return reply({ ok: true });
        }

        /* ══════════ 影视记录（按用户） ══════════ */

        case '/tv-q-put': {
          const userId = asStr(b.userId, 64);
          const kw = asStr(b.q, 60).trim();
          if (!userId || !kw) return reply({ ok: false, error: '参数不全' });
          this.#sql.exec(
            `INSERT INTO tv_q (user_id, q, ts) VALUES (?, ?, ?)
             ON CONFLICT(user_id, q) DO UPDATE SET ts = excluded.ts`,
            userId,
            kw,
            now
          );
          // 只留最近 30 条
          this.#sql.exec(
            `DELETE FROM tv_q WHERE user_id = ? AND q NOT IN (
               SELECT q FROM tv_q WHERE user_id = ? ORDER BY ts DESC LIMIT 30)`,
            userId,
            userId
          );
          return reply({ ok: true });
        }

        case '/tv-q-list': {
          const userId = q('userId');
          const rows = this.#sql
            .exec(`SELECT q, ts FROM tv_q WHERE user_id = ? ORDER BY ts DESC LIMIT 30`, userId)
            .toArray();
          return reply({ ok: true, rows });
        }

        case '/tv-prog-put': {
          const userId = asStr(b.userId, 64);
          const k = asStr(b.k, 200);
          if (!userId || !k) return reply({ ok: false, error: '参数不全' });
          this.#sql.exec(
            `INSERT INTO tv_prog (user_id, k, name, ep_name, t, d, ts, src_id, vod_id, src_name, line_idx, line_from)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, k) DO UPDATE SET
               name = excluded.name, ep_name = excluded.ep_name,
               t = excluded.t, d = excluded.d, ts = excluded.ts,
               src_id = excluded.src_id, vod_id = excluded.vod_id,
               src_name = excluded.src_name, line_idx = excluded.line_idx,
               line_from = excluded.line_from`,
            userId,
            k,
            asStr(b.name, 120),
            asStr(b.epName, 120),
            Math.max(0, asInt(b.t, 0)),
            Math.max(0, asInt(b.d, 0)),
            now,
            asStr(b.srcId, 40),
            asStr(b.vodId, 40),
            asStr(b.srcName, 40),
            Math.max(0, asInt(b.lineIdx, 0)),
            asStr(b.lineFrom, 40)
          );
          // 只留最近 60 条
          this.#sql.exec(
            `DELETE FROM tv_prog WHERE user_id = ? AND k NOT IN (
               SELECT k FROM tv_prog WHERE user_id = ? ORDER BY ts DESC LIMIT 60)`,
            userId,
            userId
          );
          return reply({ ok: true });
        }

        case '/tv-prog-list': {
          const userId = q('userId');
          const rows = this.#sql
            .exec(
              `SELECT k, name, ep_name, t, d, ts, src_id, vod_id, src_name, line_idx, line_from
               FROM tv_prog WHERE user_id = ? ORDER BY ts DESC LIMIT 60`,
              userId
            )
            .toArray();
          return reply({ ok: true, rows });
        }

        default:
          return reply({ ok: false, error: '没有这个操作' });
      }
    } catch (e) {
      return reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
