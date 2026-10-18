/**
 * 步数管家的用户库 —— 独立的 Durable Object（AppDB）。
 *
 * 为什么不塞进 `ChatLog`：站上那套刷步是**单人工具**（账号在后台手加），
 * 这一套要做成 500 人上限的商用形态（注册、会话、绑定、VIP、卡密、任务日志）。
 * 两套数据混在一个 DO 里，改任何一边都得在 45 KB 的 `chat-log.ts` 里翻找，
 * 出事时也分不清是谁把谁带崩了。R48 起按「一套业务一个 DO」拆开：
 * - `ChatLog`：对话、后台、单人版刷步账号（原样不动）；
 * - `AppDB`：本文件 —— 用户、会话、卡密、用户绑定的 Zepp 账号与任务日志。
 *
 * 存储用 SQLite 后端（Workers Free 只支持 SQLite 的 DO，见 `wrangler.toml`）。
 * 免费档配额（官方 2026-08 核实）：10 万请求/天、行读 500 万/天、**行写 10 万/天**、
 * 存储 5 GB —— 500 用户每天每人几次读写，离限额很远。
 *
 * 这个类刻意不用 `cloudflare:workers` 的 `DurableObject` 基类：
 * 项目没引 `@cloudflare/workers-types`（理由见 `chat-log.ts` 顶部），
 * 所以继续走经典的 `fetch()` 风格，调用方 `stub.fetch()`。
 *
 * **密码与 token 不在这里加密。** 加密/解密在 Worker 侧（`app.ts`）完成后才送进来；
 * DO 里存的是密文（`pwd_enc`）或原始 token JSON。这个类只做存储与原子性校验。
 */

/** SQL 的最小形状。只声明用得到的 `exec().toArray()` */
interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const asBool = (v: unknown) => Number(v ?? 0) === 1;
const asInt = (v: unknown, dflt = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
};

/** 用户对外可回的形状（不含密码哈希） */
function toUser(x: Record<string, unknown>) {
  return {
    id: String(x.id ?? ''),
    account: String(x.account ?? ''),
    nick: String(x.nick ?? ''),
    createdAt: Number(x.created_at ?? 0),
    lastLoginAt: Number(x.last_login_at ?? 0),
    vipUntil: Number(x.vip_until ?? 0),
    status: asInt(x.status, 1),
  };
}

/** 绑定账号对外可回的形状（不含密码与 token） */
function toAccount(x: Record<string, unknown>) {
  return {
    userId: String(x.user_id ?? ''),
    zeppUser: String(x.zepp_user ?? ''),
    enabled: asBool(x.enabled),
    auto: asBool(x.auto),
    beforeHour: Number(x.before_hour ?? 22),
    beforeMinute: Number(x.before_minute ?? 0),
    threshold: Number(x.threshold ?? 8000),
    toMin: Number(x.to_min ?? 10000),
    toMax: Number(x.to_max ?? 12000),
    lastSteps: Number(x.last_steps ?? 0),
    lastRunAt: Number(x.last_run_at ?? 0),
    lastRunOk: asBool(x.last_run_ok),
    lastRunMsg: String(x.last_run_msg ?? ''),
    brushedDate: String(x.brushed_date ?? ''),
    nextRunAt: Number(x.next_run_at ?? 0),
    lastManualAt: Number(x.last_manual_at ?? 0),
    manualDay: String(x.manual_day ?? ''),
    manualCount: Number(x.manual_count ?? 0),
    createdAt: Number(x.created_at ?? 0),
  };
}

/** 卡密对外形状 */
function toCard(x: Record<string, unknown>) {
  return {
    code: String(x.code ?? ''),
    days: Number(x.days ?? 0),
    note: String(x.note ?? ''),
    createdAt: Number(x.created_at ?? 0),
    usedAt: Number(x.used_at ?? 0),
    usedBy: String(x.used_by ?? ''),
  };
}

/** 一条后台可见的用户行：用户 + 绑定状态 + 最近步数 */
function toAdminUser(
  u: Record<string, unknown>,
  a: Record<string, unknown> | null
) {
  return {
    ...toUser(u),
    bound: !!a,
    zeppUser: a ? String(a.zepp_user ?? '') : '',
    auto: a ? asBool(a.auto) : false,
    enabled: a ? asBool(a.enabled) : false,
    lastSteps: a ? Number(a.last_steps ?? 0) : 0,
    lastRunAt: a ? Number(a.last_run_at ?? 0) : 0,
    lastRunOk: a ? asBool(a.last_run_ok) : false,
    nextRunAt: a ? Number(a.next_run_at ?? 0) : 0,
  };
}

export class AppDB {
  #sql: Sql;

  constructor(state: { storage: { sql: Sql } }, _env: unknown) {
    this.#sql = state.storage.sql;
    this.#init();
  }

  #init() {
    const ddl = [
      `CREATE TABLE IF NOT EXISTS user (
         id            TEXT    PRIMARY KEY,
         account       TEXT    NOT NULL UNIQUE,
         nick          TEXT    NOT NULL DEFAULT '',
         pass_hash     TEXT    NOT NULL,
         created_at    INTEGER NOT NULL,
         last_login_at INTEGER NOT NULL DEFAULT 0,
         vip_until     INTEGER NOT NULL DEFAULT 0,
         status        INTEGER NOT NULL DEFAULT 1
       )`,
      `CREATE TABLE IF NOT EXISTS session (
         token_hash TEXT    PRIMARY KEY,
         user_id    TEXT    NOT NULL,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id)`,
      `CREATE TABLE IF NOT EXISTS account (
         user_id     TEXT    PRIMARY KEY,
         zepp_user   TEXT    NOT NULL,
         zepp_key    TEXT    NOT NULL UNIQUE,
         pwd_enc     TEXT    NOT NULL,
         tokens      TEXT    NOT NULL DEFAULT '',
         enabled     INTEGER NOT NULL DEFAULT 1,
         auto        INTEGER NOT NULL DEFAULT 0,
         before_hour INTEGER NOT NULL DEFAULT 22,
         before_minute INTEGER NOT NULL DEFAULT 0,
         threshold   INTEGER NOT NULL DEFAULT 8000,
         to_min      INTEGER NOT NULL DEFAULT 10000,
         to_max      INTEGER NOT NULL DEFAULT 12000,
         last_steps  INTEGER NOT NULL DEFAULT 0,
         last_run_at INTEGER NOT NULL DEFAULT 0,
         last_run_ok INTEGER NOT NULL DEFAULT 0,
         last_run_msg TEXT   NOT NULL DEFAULT '',
         brushed_date TEXT   NOT NULL DEFAULT '',
         next_run_at INTEGER NOT NULL DEFAULT 0,
         last_manual_at INTEGER NOT NULL DEFAULT 0,
         manual_day  TEXT    NOT NULL DEFAULT '',
         manual_count INTEGER NOT NULL DEFAULT 0,
         created_at  INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS card (
         code       TEXT    PRIMARY KEY,
         days       INTEGER NOT NULL,
         note       TEXT    NOT NULL DEFAULT '',
         created_at INTEGER NOT NULL,
         used_at    INTEGER NOT NULL DEFAULT 0,
         used_by    TEXT    NOT NULL DEFAULT ''
       )`,
      `CREATE INDEX IF NOT EXISTS idx_card_used ON card(used_at)`,
      `CREATE TABLE IF NOT EXISTS log (
         id      INTEGER PRIMARY KEY AUTOINCREMENT,
         user_id TEXT NOT NULL,
         steps   INTEGER NOT NULL DEFAULT 0,
         ok      INTEGER NOT NULL DEFAULT 0,
         msg     TEXT NOT NULL DEFAULT '',
         via     TEXT NOT NULL DEFAULT 'manual',
         ts      INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_log_user ON log(user_id, id)`,
      `CREATE TABLE IF NOT EXISTS cfg (
         k TEXT PRIMARY KEY,
         v TEXT NOT NULL DEFAULT ''
       )`,
      `CREATE TABLE IF NOT EXISTS rate (
         k  TEXT PRIMARY KEY,
         n  INTEGER NOT NULL DEFAULT 0,
         ts INTEGER NOT NULL DEFAULT 0
       )`,
    ];
    for (const sql of ddl) {
      try {
        this.#sql.exec(sql);
      } catch {
        /* 表已存在、索引已存在之类的迁移噪音一律忽略；真错了会在下面的读写里暴露 */
      }
    }
  }

  #one(sql: string, ...bindings: unknown[]): Record<string, unknown> | null {
    const rows = this.#sql.exec(sql, ...bindings).toArray();
    return rows[0] ?? null;
  }

  #all(sql: string, ...bindings: unknown[]): Record<string, unknown>[] {
    return this.#sql.exec(sql, ...bindings).toArray();
  }

  #count(sql: string, ...bindings: unknown[]): number {
    return Number(this.#one(sql, ...bindings)?.n ?? 0);
  }

  #cfg(k: string): string {
    return String(this.#one('SELECT v FROM cfg WHERE k = ?', k)?.v ?? '');
  }

  #cfgNum(k: string, dflt: number): number {
    const n = Number(this.#cfg(k));
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : dflt;
  }

  #cfgSet(k: string, v: string) {
    this.#sql.exec(
      `INSERT INTO cfg (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      k,
      v
    );
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
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const q = (k: string) => url.searchParams.get(k) ?? '';

    try {
      switch (p) {
        /* ---- 用户 ---------------------------------------------------------- */

        case '/user-create': {
          const account = str(b.account).slice(0, 80);
          const nick = str(b.nick).slice(0, 40);
          const passHash = str(b.passHash);
          const now = asInt(b.now) || Date.now();
          if (!account || !passHash) return json({ ok: false, error: '缺参数' }, 400);

          const max = this.#cfgNum('max_users', 500);
          const total = this.#count('SELECT COUNT(*) AS n FROM user');
          if (total >= max) return json({ ok: false, error: '名额已满', full: true });
          if (this.#one('SELECT id FROM user WHERE account = ?', account))
            return json({ ok: false, error: '账号已存在' });

          const id = crypto.randomUUID();
          this.#sql.exec(
            `INSERT INTO user (id, account, nick, pass_hash, created_at, vip_until, status)
             VALUES (?, ?, ?, ?, ?, 0, 1)`,
            id,
            account,
            nick,
            passHash,
            now
          );
          return json({ ok: true, user: toUser(this.#one('SELECT * FROM user WHERE id = ?', id)!) });
        }

        /** 登录用：把账号对应的密码哈希与状态交给 Worker 校验 */
        case '/user-login': {
          const account = str(b.account).slice(0, 80);
          const u = this.#one('SELECT * FROM user WHERE account = ?', account);
          if (!u) return json({ ok: false, error: '账号或密码不对' });
          if (asInt(u.status, 1) !== 1) return json({ ok: false, error: '账号已停用' });
          return json({
            ok: true,
            item: { ...toUser(u), passHash: String(u.pass_hash ?? '') },
          });
        }

        case '/user-get': {
          const id = str(b.id) || q('id');
          const u = this.#one('SELECT * FROM user WHERE id = ?', id);
          return json({ ok: true, item: u ? toUser(u) : null });
        }

        case '/user-set': {
          const id = str(b.id);
          if (!id) return json({ ok: false, error: '缺 id' }, 400);
          const u = this.#one('SELECT * FROM user WHERE id = ?', id);
          if (!u) return json({ ok: false, error: '没有这个用户' }, 404);
          const nick = b.nick === undefined ? String(u.nick ?? '') : str(b.nick).slice(0, 40);
          const status = b.status === undefined ? asInt(u.status, 1) : b.status ? 1 : 0;
          this.#sql.exec('UPDATE user SET nick = ?, status = ? WHERE id = ?', nick, status, id);
          return json({ ok: true, item: toUser(this.#one('SELECT * FROM user WHERE id = ?', id)!) });
        }

        /** 加 VIP 天数。从「现在」或「现有到期时间」里取较晚的那个往后加，不吞掉剩余时长 */
        case '/user-vip-add': {
          const id = str(b.id);
          const days = Math.max(0, Math.min(3650, asInt(b.days)));
          const now = asInt(b.now) || Date.now();
          if (!id || !days) return json({ ok: false, error: '缺参数' }, 400);
          const u = this.#one('SELECT * FROM user WHERE id = ?', id);
          if (!u) return json({ ok: false, error: '没有这个用户' }, 404);
          const base = Math.max(Number(u.vip_until ?? 0), now);
          const until = base + days * 86400_000;
          this.#sql.exec('UPDATE user SET vip_until = ? WHERE id = ?', until, id);
          return json({ ok: true, vipUntil: until, item: toUser(this.#one('SELECT * FROM user WHERE id = ?', id)!) });
        }

        /** 直接改到期时间（后台「改到期」用） */
        case '/user-vip-set': {
          const id = str(b.id);
          const until = Math.max(0, asInt(b.vipUntil));
          if (!id) return json({ ok: false, error: '缺 id' }, 400);
          this.#sql.exec('UPDATE user SET vip_until = ? WHERE id = ?', until, id);
          return json({ ok: true });
        }

        case '/user-del': {
          const id = str(b.id);
          if (!id) return json({ ok: false, error: '缺 id' }, 400);
          this.#sql.exec('DELETE FROM user WHERE id = ?', id);
          this.#sql.exec('DELETE FROM session WHERE user_id = ?', id);
          this.#sql.exec('DELETE FROM account WHERE user_id = ?', id);
          this.#sql.exec('DELETE FROM log WHERE user_id = ?', id);
          return json({ ok: true });
        }

        /** 后台用户列表。`q` 同时搜账号与备注；按注册时间倒序 */
        case '/users': {
          const kw = q('q').trim().slice(0, 40).toLowerCase();
          const limit = Math.max(1, Math.min(500, asInt(q('limit'), 200)));
          const rows = kw
            ? this.#all(
                `SELECT * FROM user WHERE lower(account) LIKE ? OR lower(nick) LIKE ?
                 ORDER BY created_at DESC LIMIT ?`,
                `%${kw}%`,
                `%${kw}%`,
                limit
              )
            : this.#all('SELECT * FROM user ORDER BY created_at DESC LIMIT ?', limit);
          const items = rows.map((u) => {
            const a = this.#one('SELECT * FROM account WHERE user_id = ?', String(u.id ?? ''));
            return toAdminUser(u, a);
          });
          return json({
            ok: true,
            items,
            total: this.#count('SELECT COUNT(*) AS n FROM user'),
            vip: this.#count('SELECT COUNT(*) AS n FROM user WHERE vip_until > ?', Date.now()),
            bound: this.#count('SELECT COUNT(*) AS n FROM account'),
          });
        }

        /* ---- 会话 ---------------------------------------------------------- */

        case '/session-create': {
          const userId = str(b.userId);
          const tokenHash = str(b.tokenHash);
          const now = asInt(b.now) || Date.now();
          const expiresAt = asInt(b.expiresAt) || now + 30 * 86400_000;
          if (!userId || !tokenHash) return json({ ok: false, error: '缺参数' }, 400);
          this.#sql.exec('DELETE FROM session WHERE expires_at <= ?', now);
          this.#sql.exec(
            `INSERT OR REPLACE INTO session (token_hash, user_id, created_at, expires_at)
             VALUES (?, ?, ?, ?)`,
            tokenHash,
            userId,
            now,
            expiresAt
          );
          return json({ ok: true });
        }

        case '/session-get': {
          const tokenHash = str(b.tokenHash) || q('hash');
          const now = asInt(b.now) || Date.now();
          const s = this.#one('SELECT * FROM session WHERE token_hash = ?', tokenHash);
          if (!s) return json({ ok: true, item: null });
          if (Number(s.expires_at ?? 0) <= now) {
            this.#sql.exec('DELETE FROM session WHERE token_hash = ?', tokenHash);
            return json({ ok: true, item: null });
          }
          const u = this.#one('SELECT * FROM user WHERE id = ?', String(s.user_id ?? ''));
          if (!u || asInt(u.status, 1) !== 1) return json({ ok: true, item: null });
          return json({ ok: true, item: { ...toUser(u), expiresAt: Number(s.expires_at ?? 0) } });
        }

        case '/session-del': {
          const tokenHash = str(b.tokenHash);
          if (tokenHash) this.#sql.exec('DELETE FROM session WHERE token_hash = ?', tokenHash);
          return json({ ok: true });
        }

        case '/session-del-user': {
          const userId = str(b.userId);
          if (userId) this.#sql.exec('DELETE FROM session WHERE user_id = ?', userId);
          return json({ ok: true });
        }

        /* ---- 用户绑定的 Zepp 账号 ------------------------------------------ */

        case '/account-get': {
          const uid = str(b.userId) || q('uid');
          const a = this.#one('SELECT * FROM account WHERE user_id = ?', uid);
          return json({ ok: true, item: a ? toAccount(a) : null, raw: a ?? null });
        }

        /** 绑定时写整行；`zepp_key` 唯一，防止同一个 Zepp 账号被两个用户绑 */
        case '/account-put': {
          const uid = str(b.userId);
          const zeppUser = str(b.zeppUser).slice(0, 120);
          const zeppKey = str(b.zeppKey).slice(0, 80);
          const pwdEnc = str(b.pwdEnc);
          const tokens = str(b.tokens);
          const now = asInt(b.now) || Date.now();
          if (!uid || !zeppUser || !zeppKey || !pwdEnc)
            return json({ ok: false, error: '缺参数' }, 400);
          const other = this.#one(
            'SELECT user_id FROM account WHERE zepp_key = ? AND user_id <> ?',
            zeppKey,
            uid
          );
          if (other) return json({ ok: false, error: '这个 Zepp 账号已被其他用户绑定' });
          this.#sql.exec(
            `INSERT INTO account (
               user_id, zepp_user, zepp_key, pwd_enc, tokens,
               enabled, auto, before_hour, before_minute, threshold, to_min, to_max,
               last_steps, last_run_at, last_run_ok, last_run_msg, brushed_date,
               next_run_at, last_manual_at, manual_day, manual_count, created_at
             ) VALUES (?, ?, ?, ?, ?, 1, 0, 22, 0, 8000, 10000, 12000,
               0, 0, 0, '', '', 0, 0, '', 0, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               zepp_user = excluded.zepp_user, zepp_key = excluded.zepp_key,
               pwd_enc = excluded.pwd_enc, tokens = excluded.tokens`,
            uid,
            zeppUser,
            zeppKey,
            pwdEnc,
            tokens,
            now
          );
          return json({ ok: true, item: toAccount(this.#one('SELECT * FROM account WHERE user_id = ?', uid)!) });
        }

        /** 局部更新。白名单字段，避免调用方顺手改到 user_id 之类的主键 */
        case '/account-patch': {
          const uid = str(b.userId);
          if (!uid) return json({ ok: false, error: '缺 userId' }, 400);
          const map: Record<string, string> = {
            zeppUser: 'zepp_user',
            zeppKey: 'zepp_key',
            pwdEnc: 'pwd_enc',
            tokens: 'tokens',
            enabled: 'enabled',
            auto: 'auto',
            beforeHour: 'before_hour',
            beforeMinute: 'before_minute',
            threshold: 'threshold',
            toMin: 'to_min',
            toMax: 'to_max',
            lastSteps: 'last_steps',
            lastRunAt: 'last_run_at',
            lastRunOk: 'last_run_ok',
            lastRunMsg: 'last_run_msg',
            brushedDate: 'brushed_date',
            nextRunAt: 'next_run_at',
            lastManualAt: 'last_manual_at',
            manualDay: 'manual_day',
            manualCount: 'manual_count',
          };
          const sets: string[] = [];
          const vals: unknown[] = [];
          for (const [k, col] of Object.entries(map)) {
            if (!(k in b)) continue;
            let v = b[k];
            if (k === 'enabled' || k === 'auto' || k === 'lastRunOk') v = v ? 1 : 0;
            else if (typeof v === 'number') v = Math.trunc(v);
            else v = String(v ?? '');
            sets.push(`${col} = ?`);
            vals.push(v);
          }
          if (!sets.length) return json({ ok: true });
          this.#sql.exec(`UPDATE account SET ${sets.join(', ')} WHERE user_id = ?`, ...vals, uid);
          return json({ ok: true });
        }

        case '/account-del': {
          const uid = str(b.userId);
          if (uid) this.#sql.exec('DELETE FROM account WHERE user_id = ?', uid);
          return json({ ok: true });
        }

        /** cron 取到期任务。VIP 过期 / 账号停用 / 没开自动的一律不取 */
        case '/due': {
          const now = asInt(b.now) || Date.now();
          const limit = Math.max(1, Math.min(30, asInt(b.limit, 6)));
          const rows = this.#all(
            `SELECT a.*, u.vip_until AS vip_until, u.account AS account, u.nick AS nick
               FROM account a JOIN user u ON u.id = a.user_id
              WHERE a.enabled = 1 AND a.auto = 1
                AND a.next_run_at > 0 AND a.next_run_at <= ?
                AND u.status = 1 AND u.vip_until > ?
              ORDER BY a.next_run_at ASC LIMIT ?`,
            now,
            now,
            limit
          );
          return json({ ok: true, items: rows });
        }

        case '/account-mark-run': {
          const uid = str(b.userId);
          if (!uid) return json({ ok: false, error: '缺 userId' }, 400);
          const now = asInt(b.now) || Date.now();
          this.#sql.exec(
            `UPDATE account SET last_steps = ?, last_run_at = ?, last_run_ok = ?,
               last_run_msg = ?, brushed_date = ?, next_run_at = ?, tokens = COALESCE(NULLIF(?, ''), tokens)
             WHERE user_id = ?`,
            asInt(b.steps),
            now,
            b.ok ? 1 : 0,
            str(b.msg).slice(0, 500),
            str(b.brushedDate),
            asInt(b.nextRunAt),
            str(b.tokens),
            uid
          );
          return json({ ok: true });
        }

        case '/account-manual-mark': {
          const uid = str(b.userId);
          if (!uid) return json({ ok: false, error: '缺 userId' }, 400);
          this.#sql.exec(
            'UPDATE account SET last_manual_at = ?, manual_day = ?, manual_count = ? WHERE user_id = ?',
            asInt(b.at) || Date.now(),
            str(b.day),
            asInt(b.count),
            uid
          );
          return json({ ok: true });
        }

        /* ---- 日志 ---------------------------------------------------------- */

        case '/log-add': {
          const uid = str(b.userId);
          if (!uid) return json({ ok: false, error: '缺 userId' }, 400);
          this.#sql.exec(
            'INSERT INTO log (user_id, steps, ok, msg, via, ts) VALUES (?, ?, ?, ?, ?, ?)',
            uid,
            asInt(b.steps),
            b.ok ? 1 : 0,
            str(b.msg).slice(0, 500),
            str(b.via) === 'auto' ? 'auto' : 'manual',
            asInt(b.ts) || Date.now()
          );
          return json({ ok: true });
        }

        case '/logs': {
          const uid = q('uid') || str(b.userId);
          const n = Math.max(1, Math.min(100, asInt(q('n'), 20)));
          const rows = this.#all(
            'SELECT * FROM log WHERE user_id = ? ORDER BY id DESC LIMIT ?',
            uid,
            n
          );
          return json({
            ok: true,
            items: rows.map((x) => ({
              id: Number(x.id ?? 0),
              steps: Number(x.steps ?? 0),
              ok: asBool(x.ok),
              msg: String(x.msg ?? ''),
              via: String(x.via ?? 'manual'),
              ts: Number(x.ts ?? 0),
            })),
          });
        }

        /* ---- 卡密 ---------------------------------------------------------- */

        case '/card-create': {
          const codes = Array.isArray(b.codes) ? b.codes.map((c) => String(c).slice(0, 32)) : [];
          const days = Math.max(1, Math.min(3650, asInt(b.days, 30)));
          const note = str(b.note).slice(0, 120);
          const now = asInt(b.now) || Date.now();
          if (!codes.length) return json({ ok: false, error: '缺卡密' }, 400);
          let added = 0;
          for (const code of codes) {
            if (!code) continue;
            try {
              this.#sql.exec(
                'INSERT INTO card (code, days, note, created_at) VALUES (?, ?, ?, ?)',
                code,
                days,
                note,
                now
              );
              added++;
            } catch {
              /* 撞码：跳过。批量生成时极罕见，不值得为它整体失败 */
            }
          }
          return json({ ok: true, added, days });
        }

        case '/cards': {
          const kw = q('q').trim().slice(0, 40).toUpperCase();
          const limit = Math.max(1, Math.min(500, asInt(q('limit'), 200)));
          const rows = kw
            ? this.#all(
                'SELECT * FROM card WHERE code LIKE ? ORDER BY used_at ASC, created_at DESC LIMIT ?',
                `%${kw}%`,
                limit
              )
            : this.#all('SELECT * FROM card ORDER BY used_at ASC, created_at DESC LIMIT ?', limit);
          const unused = this.#count('SELECT COUNT(*) AS n FROM card WHERE used_at = 0');
          const used = this.#count('SELECT COUNT(*) AS n FROM card WHERE used_at > 0');
          return json({ ok: true, items: rows.map(toCard), unused, used });
        }

        case '/card-del': {
          const code = str(b.code);
          if (!code) return json({ ok: false, error: '缺卡密' }, 400);
          this.#sql.exec('DELETE FROM card WHERE code = ? AND used_at = 0', code);
          return json({ ok: true });
        }

        /**
         * 兑卡。**卡密标记与 VIP 延长在同一个 DO 请求里完成** ——
         * DO 对同一实例串行执行，所以不存在「卡被标记了 VIP 没加上」的半截状态。
         */
        case '/card-redeem': {
          const code = str(b.code).toUpperCase().slice(0, 32);
          const userId = str(b.userId);
          const now = asInt(b.now) || Date.now();
          if (!code || !userId) return json({ ok: false, error: '缺参数' }, 400);
          const c = this.#one('SELECT * FROM card WHERE code = ?', code);
          if (!c) return json({ ok: false, error: '卡密不存在' });
          if (Number(c.used_at ?? 0) > 0) return json({ ok: false, error: '这张卡已经被用过了' });
          const u = this.#one('SELECT * FROM user WHERE id = ?', userId);
          if (!u) return json({ ok: false, error: '用户不存在' });
          const days = Math.max(1, Math.min(3650, Number(c.days ?? 0)));
          const until = Math.max(Number(u.vip_until ?? 0), now) + days * 86400_000;
          this.#sql.exec('UPDATE card SET used_at = ?, used_by = ? WHERE code = ?', now, userId, code);
          this.#sql.exec('UPDATE user SET vip_until = ? WHERE id = ?', until, userId);
          return json({ ok: true, days, vipUntil: until });
        }

        /* ---- 频率限制 ------------------------------------------------------ */

        /**
         * 固定窗口计数。key 由调用方拼（如 `login:<ip>`）。
         * 返回 ok=false 时 retryAfter 是窗口剩余秒数 —— 够前端说人话。
         */
        case '/rate': {
          const key = str(b.key).slice(0, 120);
          const windowMs = Math.max(1000, asInt(b.windowMs, 60_000));
          const max = Math.max(1, asInt(b.max, 10));
          const now = asInt(b.now) || Date.now();
          if (!key) return json({ ok: true });
          const row = this.#one('SELECT * FROM rate WHERE k = ?', key);
          let n = 1;
          let ts = now;
          if (row && now - Number(row.ts ?? 0) < windowMs) {
            n = Number(row.n ?? 0) + 1;
            ts = Number(row.ts ?? now);
          }
          this.#sql.exec(
            `INSERT INTO rate (k, n, ts) VALUES (?, ?, ?)
             ON CONFLICT(k) DO UPDATE SET n = excluded.n, ts = excluded.ts`,
            key,
            n,
            ts
          );
          return json({
            ok: n <= max,
            n,
            max,
            retryAfter: n <= max ? 0 : Math.ceil((windowMs - (now - ts)) / 1000),
          });
        }

        /* ---- 配置与公开信息 ------------------------------------------------ */

        case '/cfg': {
          const rows = this.#all('SELECT k, v FROM cfg');
          const out: Record<string, string> = {};
          for (const r of rows) out[String(r.k ?? '')] = String(r.v ?? '');
          return json({ ok: true, cfg: out });
        }

        case '/cfg-set': {
          const entries = Object.entries(b).filter(([k]) => /^[a-z0-9_]{1,40}$/.test(k));
          for (const [k, v] of entries) this.#cfgSet(k, String(v ?? '').slice(0, 2000));
          return json({ ok: true, saved: entries.map(([k]) => k) });
        }

        case '/public': {
          const total = this.#count('SELECT COUNT(*) AS n FROM user');
          return json({
            ok: true,
            maxUsers: this.#cfgNum('max_users', 500),
            userCount: total,
            open: this.#cfg('register_open') !== '0',
            buyNote: this.#cfg('buy_note'),
            freeDaily: this.#cfgNum('free_daily', 50),
            freeInterval: this.#cfgNum('free_interval', 60),
          });
        }

        case '/stats': {
          const now = Date.now();
          return json({
            ok: true,
            users: this.#count('SELECT COUNT(*) AS n FROM user'),
            vip: this.#count('SELECT COUNT(*) AS n FROM user WHERE vip_until > ?', now),
            bound: this.#count('SELECT COUNT(*) AS n FROM account'),
            cardsUnused: this.#count('SELECT COUNT(*) AS n FROM card WHERE used_at = 0'),
            tasksToday: this.#count(
              'SELECT COUNT(*) AS n FROM log WHERE ts > ? AND via = ?',
              now - 86400_000,
              'auto'
            ),
          });
        }

        default:
          return json({ ok: false, error: '没有这个接口' }, 404);
      }
    } catch (e) {
      /* DO 里抛异常会把整条请求带成 500；返回结构化错误，调用方好说人话 */
      return json(
        { ok: false, error: e instanceof Error ? e.message : String(e) },
        500
      );
    }
  }
}
