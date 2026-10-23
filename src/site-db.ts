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
      /* 追剧收藏（R52）。k 是片名 —— 同一部片在不同源上是不同的 vod，
         收藏的是「这部剧」而不是「某个源上的这个 vod」，所以按片名归并。
         src_* / line_* / ep_* / t 是**最后一次看的位置**，点「继续看」时
         直接拿它去开详情，不必再搜一次（这正是站主要的那条）。 */
      `CREATE TABLE IF NOT EXISTS tv_fav (
         user_id   TEXT    NOT NULL,
         k         TEXT    NOT NULL,
         name      TEXT    NOT NULL DEFAULT '',
         pic       TEXT    NOT NULL DEFAULT '',
         src_id    TEXT    NOT NULL DEFAULT '',
         vod_id    TEXT    NOT NULL DEFAULT '',
         src_name  TEXT    NOT NULL DEFAULT '',
         line_idx  INTEGER NOT NULL DEFAULT 0,
         line_from TEXT    NOT NULL DEFAULT '',
         ep_name   TEXT    NOT NULL DEFAULT '',
         t         INTEGER NOT NULL DEFAULT 0,
         d         INTEGER NOT NULL DEFAULT 0,
         ts        INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_tvfav_ts ON tv_fav(user_id, ts DESC)`,
      /* 站点用户的 Zepp 账号（工具「帮您走走」）。**一人一个**：user_id 是主键，
         再存就是覆盖 —— 这条约束写在表结构里，不靠接口自觉。 */
      `CREATE TABLE IF NOT EXISTS step_user (
         user_id     TEXT    PRIMARY KEY,
         zepp_user   TEXT    NOT NULL DEFAULT '',
         zepp_pwd    TEXT    NOT NULL DEFAULT '',
         enabled     INTEGER NOT NULL DEFAULT 1,
         last_steps  INTEGER NOT NULL DEFAULT 0,
         last_run_at INTEGER NOT NULL DEFAULT 0,
         last_ok     INTEGER NOT NULL DEFAULT 0,
         last_msg    TEXT    NOT NULL DEFAULT '',
         created_at  INTEGER NOT NULL
       )`,
      /* 每人自己的刷步流水（手动）。自动刷步的流水只在后台那一套里，这里看不到。 */
      `CREATE TABLE IF NOT EXISTS step_user_log (
         id         INTEGER PRIMARY KEY AUTOINCREMENT,
         user_id    TEXT    NOT NULL,
         steps      INTEGER NOT NULL DEFAULT 0,
         ok         INTEGER NOT NULL DEFAULT 0,
         msg        TEXT    NOT NULL DEFAULT '',
         ts         INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_sul_user ON step_user_log(user_id, ts DESC)`,
      /* ── 实时内容层（R52）────────────────────────────────────────────────
         content_live：后台「发布」的文章/随笔/作品，Worker 用 /live/<coll>/<slug>
         直接渲染。status=1 才算发布；0 是留着的线上草稿。 */
      `CREATE TABLE IF NOT EXISTS content_live (
         coll       TEXT    NOT NULL,
         slug       TEXT    NOT NULL,
         title      TEXT    NOT NULL DEFAULT '',
         front      TEXT    NOT NULL DEFAULT '',
         body       TEXT    NOT NULL DEFAULT '',
         status     INTEGER NOT NULL DEFAULT 0,
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (coll, slug)
       )`,
      /* kb_live：分身知识库的线上稿。loadKb() 按 question 覆盖/追加静态那一份 */
      `CREATE TABLE IF NOT EXISTS kb_live (
         question   TEXT    PRIMARY KEY,
         answer     TEXT    NOT NULL DEFAULT '',
         topic      TEXT    NOT NULL DEFAULT '',
         aliases    TEXT    NOT NULL DEFAULT '',
         status     INTEGER NOT NULL DEFAULT 1,
         updated_at INTEGER NOT NULL
       )`,
      /* media：后台直接上传的图片。/api/media/<key> 直接吐字节 */
      `CREATE TABLE IF NOT EXISTS media (
         key        TEXT    PRIMARY KEY,
         mime       TEXT    NOT NULL DEFAULT 'application/octet-stream',
         size       INTEGER NOT NULL DEFAULT 0,
         bytes      BLOB    NOT NULL,
         created_at INTEGER NOT NULL
       )`,
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

    /* 取图：直接回字节。放在 switch 前面，因为它不是 JSON 接口。 */
    if (p === '/media-get') {
      const key = q('key') || asStr(b.key, 160);
      const rows = this.#sql
        .exec(`SELECT mime, bytes FROM media WHERE key = ?`, key)
        .toArray();
      const row = rows[0] as { mime?: string; bytes?: ArrayBuffer | Uint8Array } | undefined;
      if (!row || !row.bytes) return new Response('not found', { status: 404 });
      const buf = row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes);
      /* 切一段独立 ArrayBuffer 再交给 Response：Uint8Array 的泛型在这里不被认成 BodyInit，
         而它背后可能是一个更大的 buffer（切片保证不会多吐字节）。 */
      const body = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      return new Response(body, {
        headers: {
          'content-type': String(row.mime ?? 'application/octet-stream'),
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    }

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

        /* ══════════ 追剧收藏（R52） ══════════ */

        case '/tv-fav-put': {
          const userId = asStr(b.userId, 80);
          const name = asStr(b.name, 120);
          if (!userId || !name) return reply({ ok: false, error: '缺少用户或片名' });
          this.#sql.exec(
            `INSERT INTO tv_fav (user_id, k, name, pic, src_id, vod_id, src_name,
                                 line_idx, line_from, ep_name, t, d, ts)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, k) DO UPDATE SET
               name = excluded.name,
               pic = CASE WHEN excluded.pic != '' THEN excluded.pic ELSE tv_fav.pic END,
               src_id = CASE WHEN excluded.src_id != '' THEN excluded.src_id ELSE tv_fav.src_id END,
               vod_id = CASE WHEN excluded.vod_id != '' THEN excluded.vod_id ELSE tv_fav.vod_id END,
               src_name = CASE WHEN excluded.src_name != '' THEN excluded.src_name ELSE tv_fav.src_name END,
               line_idx = excluded.line_idx,
               line_from = CASE WHEN excluded.line_from != '' THEN excluded.line_from ELSE tv_fav.line_from END,
               ep_name = CASE WHEN excluded.ep_name != '' THEN excluded.ep_name ELSE tv_fav.ep_name END,
               t = excluded.t, d = excluded.d, ts = excluded.ts`,
            userId,
            name,
            name,
            asStr(b.pic, 500),
            asStr(b.srcId, 40),
            asStr(b.vodId, 60),
            asStr(b.srcName, 60),
            asInt(b.lineIdx, 0),
            asStr(b.lineFrom, 60),
            asStr(b.epName, 120),
            asInt(b.t, 0),
            asInt(b.d, 0),
            now
          );
          return reply({ ok: true });
        }

        case '/tv-fav-del': {
          const userId = asStr(b.userId, 80);
          const name = asStr(b.name, 120);
          if (!userId || !name) return reply({ ok: false, error: '缺少用户或片名' });
          this.#sql.exec(`DELETE FROM tv_fav WHERE user_id = ? AND k = ?`, userId, name);
          return reply({ ok: true });
        }

        case '/tv-fav-list': {
          const userId = q('userId');
          const rows = this.#sql
            .exec(
              `SELECT k, name, pic, src_id, vod_id, src_name, line_idx, line_from,
                      ep_name, t, d, ts
               FROM tv_fav WHERE user_id = ? ORDER BY ts DESC LIMIT 200`,
              userId
            )
            .toArray();
          return reply({ ok: true, rows });
        }

        /* ══════════ 站点用户的 Zepp 账号（工具「帮您走走」） ══════════ */

        case '/step-user-get': {
          const userId = asStr(b.userId, 80) || q('userId');
          if (!userId) return reply({ ok: false, error: '缺少用户' });
          const rows = this.#sql
            .exec(
              `SELECT user_id, zepp_user, enabled, last_steps, last_run_at, last_ok, last_msg
               FROM step_user WHERE user_id = ?`,
              userId
            )
            .toArray();
          /* 密码永不出库：这一条接口只回答「有没有绑、绑的是谁（脱敏）、上次怎样」 */
          return reply({ ok: true, row: rows[0] ?? null });
        }

        /** 内部用：带密码的那一份，只给 Worker 的执行路径（不经过任何接口直出） */
        case '/step-user-raw': {
          const userId = asStr(b.userId, 80) || q('userId');
          const rows = this.#sql
            .exec(`SELECT zepp_user, zepp_pwd, enabled FROM step_user WHERE user_id = ?`, userId)
            .toArray();
          return reply({ ok: true, row: rows[0] ?? null });
        }

        /** 一人一个：user_id 主键，重复保存就是覆盖（站主要的「只能保存一个」） */
        case '/step-user-put': {
          const userId = asStr(b.userId, 80);
          const zeppUser = asStr(b.zeppUser, 120);
          if (!userId || !zeppUser) return reply({ ok: false, error: '缺少用户或 Zepp 账号' });
          const pwd = asStr(b.zeppPwd, 200);
          const exists = this.#sql
            .exec(`SELECT user_id, zepp_pwd FROM step_user WHERE user_id = ?`, userId)
            .toArray()[0];
          if (exists) {
            this.#sql.exec(
              `UPDATE step_user SET zepp_user = ?, zepp_pwd = CASE WHEN ? != '' THEN ? ELSE zepp_pwd END,
                 enabled = ?, last_steps = ?, last_run_at = ?, last_ok = ?, last_msg = ?
               WHERE user_id = ?`,
              zeppUser,
              pwd,
              pwd,
              b.enabled === false ? 0 : 1,
              asInt(b.lastSteps, 0),
              asInt(b.lastRunAt, 0),
              b.lastOk ? 1 : 0,
              asStr(b.lastMsg, 400),
              userId
            );
          } else {
            this.#sql.exec(
              `INSERT INTO step_user (user_id, zepp_user, zepp_pwd, enabled,
                                      last_steps, last_run_at, last_ok, last_msg, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              userId,
              zeppUser,
              pwd,
              b.enabled === false ? 0 : 1,
              asInt(b.lastSteps, 0),
              asInt(b.lastRunAt, 0),
              b.lastOk ? 1 : 0,
              asStr(b.lastMsg, 400),
              now
            );
          }
          return reply({ ok: true });
        }

        case '/step-user-del': {
          const userId = asStr(b.userId, 80);
          this.#sql.exec(`DELETE FROM step_user WHERE user_id = ?`, userId);
          return reply({ ok: true });
        }

        case '/step-user-log-add': {
          const userId = asStr(b.userId, 80);
          this.#sql.exec(
            `INSERT INTO step_user_log (user_id, steps, ok, msg, ts) VALUES (?, ?, ?, ?, ?)`,
            userId,
            asInt(b.steps, 0),
            b.ok ? 1 : 0,
            asStr(b.msg, 400),
            now
          );
          // 每人只留最近 100 条，别让一张表无限长
          this.#sql.exec(
            `DELETE FROM step_user_log WHERE user_id = ? AND id NOT IN (
               SELECT id FROM step_user_log WHERE user_id = ? ORDER BY ts DESC LIMIT 100)`,
            userId,
            userId
          );
          return reply({ ok: true });
        }

        case '/step-user-log-list': {
          const userId = q('userId');
          const n = Math.min(100, Math.max(1, asInt(q('n'), 20)));
          const rows = this.#sql
            .exec(
              `SELECT id, steps, ok, msg, ts FROM step_user_log
               WHERE user_id = ? ORDER BY ts DESC LIMIT ` + n,
              userId
            )
            .toArray();
          return reply({ ok: true, rows });
        }

        /* ══════════ 实时内容层（R52） ══════════ */

        case '/content-live-put': {
          const coll = asStr(b.coll, 20);
          const slug = asStr(b.slug, 120);
          if (!['posts', 'notes', 'projects', 'photos', 'kb'].includes(coll))
            return reply({ ok: false, error: '不认识这个栏目' });
          if (!/^[a-z0-9][a-z0-9/-]{0,120}$/.test(slug))
            return reply({ ok: false, error: 'slug 只能用小写字母、数字、连字符与斜杠' });
          this.#sql.exec(
            `INSERT INTO content_live (coll, slug, title, front, body, status, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(coll, slug) DO UPDATE SET
               title = excluded.title, front = excluded.front, body = excluded.body,
               status = excluded.status, updated_at = excluded.updated_at`,
            coll,
            slug,
            asStr(b.title, 200),
            asStr(b.front, 4000),
            asStr(b.body, 400000),
            b.status === 0 || b.status === '0' ? 0 : 1,
            now
          );
          return reply({ ok: true });
        }

        case '/content-live-del': {
          this.#sql.exec(
            `DELETE FROM content_live WHERE coll = ? AND slug = ?`,
            asStr(b.coll, 20),
            asStr(b.slug, 120)
          );
          return reply({ ok: true });
        }

        case '/content-live-list': {
          const rows = this.#sql
            .exec(
              `SELECT coll, slug, title, status, updated_at, length(body) AS chars
               FROM content_live ORDER BY updated_at DESC LIMIT 200`
            )
            .toArray();
          return reply({ ok: true, rows });
        }

        case '/content-live-get': {
          const rows = this.#sql
            .exec(
              `SELECT coll, slug, title, front, body, status, updated_at
               FROM content_live WHERE coll = ? AND slug = ?`,
              asStr(b.coll, 20) || q('coll'),
              asStr(b.slug, 120) || q('slug')
            )
            .toArray();
          return reply({ ok: true, row: rows[0] ?? null });
        }

        case '/kb-live-put': {
          const question = asStr(b.question, 300).trim();
          if (!question) return reply({ ok: false, error: '缺问题' });
          this.#sql.exec(
            `INSERT INTO kb_live (question, answer, topic, aliases, status, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(question) DO UPDATE SET
               answer = excluded.answer, topic = excluded.topic,
               aliases = excluded.aliases, status = excluded.status,
               updated_at = excluded.updated_at`,
            question,
            asStr(b.answer, 20000),
            asStr(b.topic, 60),
            asStr(b.aliases, 500),
            b.status === 0 || b.status === '0' ? 0 : 1,
            now
          );
          return reply({ ok: true });
        }

        case '/kb-live-del': {
          this.#sql.exec(`DELETE FROM kb_live WHERE question = ?`, asStr(b.question, 300));
          return reply({ ok: true });
        }

        case '/kb-live-list': {
          const rows = this.#sql
            .exec(
              `SELECT question, answer, topic, aliases, status, updated_at
               FROM kb_live ORDER BY updated_at DESC LIMIT 300`
            )
            .toArray();
          return reply({ ok: true, rows });
        }

        /* ── 图片 ──────────────────────────────────────────────────────────
           base64 进、二进制出。DO 的 SQL 支持 BLOB，直接存字节，不转 data URL
           （data URL 会让每次取图都多 33% 体积，而且没法走浏览器缓存）。 */
        case '/media-put': {
          const key = asStr(b.key, 160);
          const b64 = typeof b.data === 'string' ? b.data : '';
          if (!key || !b64) return reply({ ok: false, error: '缺 key 或数据' });
          let bytes: Uint8Array;
          try {
            const raw = atob(b64);
            bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          } catch {
            return reply({ ok: false, error: '图片数据不是合法的 base64' });
          }
          if (bytes.byteLength > 3 * 1024 * 1024)
            return reply({ ok: false, error: '图太大了（上限 3MB）' });
          this.#sql.exec(
            `INSERT INTO media (key, mime, size, bytes, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET mime = excluded.mime, size = excluded.size,
               bytes = excluded.bytes, created_at = excluded.created_at`,
            key,
            asStr(b.mime, 80) || 'image/webp',
            bytes.byteLength,
            /* 绑 ArrayBuffer 而不是 Uint8Array：DO 的 SQL 接口对视图类型的支持
               依实现而定，ArrayBuffer 是最稳的那一种。 */
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            now
          );
          return reply({ ok: true, key, size: bytes.byteLength });
        }

        case '/media-del': {
          this.#sql.exec(`DELETE FROM media WHERE key = ?`, asStr(b.key, 160) || q('key'));
          return reply({ ok: true });
        }

        case '/media-list': {
          const rows = this.#sql
            .exec(`SELECT key, mime, size, created_at FROM media ORDER BY created_at DESC LIMIT 200`)
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
