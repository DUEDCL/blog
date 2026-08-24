/**
 * 对话落库 —— 一个会话一个 Durable Object（R32 决议：**改成落库、永久保留**）。
 *
 * 为什么是 DO 而不是 D1／KV：R32 问他「存哪」时他说「你定」。选 DO 的理由是
 * **存与推是同一个对象** —— 阶段③ 的实时监管页要 WebSocket，那正是 DO 的本职；
 * 用 D1 就得再配一套推送，多一个组件、多一个故障点。
 *
 * 免费档硬约束（官方 pricing 页 2026-08-24 核实）：
 * - **Workers Free 只能用 SQLite 后端的 DO**（KV 后端要 Paid）。所以 `wrangler.toml` 里
 *   必须写 `storage = "sqlite"`，写错了部署就报错；
 * - 请求 10 万/天、计算 13,000 GB-s/天、行读 500 万/天、**行写 10 万/天**、SQL 存储 5 GB；
 * - 任何一项超额，**该类型的后续操作直接报错**（不是降级、不是自动计费）。
 *   一次对话写 2 行，离 10 万很远。
 *
 * 刻意不用 `cloudflare:workers` 的 `DurableObject` 基类与 RPC：那需要
 * `@cloudflare/workers-types`，而本项目刻意不引它（它的全局 `Request`/`Response`
 * 会和 Astro 的 `lib.dom` 打架，见 `worker.ts` 顶部）。所以这里是经典的
 * `fetch()` 风格 DO，调用方用 `stub.fetch()` —— 零类型依赖。
 */

/** 一条消息。`ip` 只有 user 那条有值（R32 他定了要存 IP） */
export interface ChatRow {
  id: number;
  role: 'user' | 'ai';
  text: string;
  ip: string;
  ts: number;
}

/** 喂给模型的历史条数上限。6 条 = 3 轮，再多就是拿 token 换记忆 */
const HISTORY_MAX = 6;

/** 一条消息最长存多少字符。截断而不是拒绝 —— 落库不该因为一条超长消息失败 */
const TEXT_MAX = 4000;

/**
 * `ctx.storage.sql` 的最小形状。只声明用得到的 `exec().toArray()` ——
 * 完整类型在 `@cloudflare/workers-types` 里，而本项目不引它。
 */
interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export class ChatLog {
  #sql: Sql;

  constructor(state: { storage: { sql: Sql } }) {
    this.#sql = state.storage.sql;

    /* 建表放构造函数里：DO 每次被唤醒都会跑，IF NOT EXISTS 让它幂等。
       AUTOINCREMENT 的 id 同时充当时间顺序 —— ts 是毫秒，同一毫秒内的两条也要能排序。 */
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS msg (
         id   INTEGER PRIMARY KEY AUTOINCREMENT,
         role TEXT    NOT NULL,
         text TEXT    NOT NULL,
         ip   TEXT    NOT NULL DEFAULT '',
         ts   INTEGER NOT NULL
       )`
    );

    /* 后台那份可改的配置（端点、模型候选、密钥、开关）。
       **同一个 class、不同实例**：会话实例只用 msg 表，配置实例（`idFromName('config')`）
       只用 cfg 表。这样不必新增第二个 DO 绑定，也不必给类改名
       （改名要走 rename migration，不值得）。代价是两张空表各占几 KB。 */
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS cfg (
         k TEXT PRIMARY KEY,
         v TEXT NOT NULL
       )`
    );
  }

  #rows(limit: number, asc = true): ChatRow[] {
    const r = this.#sql
      .exec(
        `SELECT id, role, text, ip, ts FROM msg ORDER BY id ${asc ? 'ASC' : 'DESC'} LIMIT ?`,
        limit
      )
      .toArray();

    return r.map((x) => ({
      id: Number(x.id),
      role: x.role === 'user' ? 'user' : 'ai',
      text: String(x.text ?? ''),
      ip: String(x.ip ?? ''),
      ts: Number(x.ts),
    }));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    try {
      switch (url.pathname) {
        /** 追加一条。调用方（Worker）保证 role 与 text 已经校验过 */
        case '/append': {
          const b = (await req.json()) as {
            role?: string;
            text?: string;
            ip?: string;
          };
          const role = b.role === 'user' ? 'user' : 'ai';
          const text = String(b.text ?? '').slice(0, TEXT_MAX);
          if (!text) return Response.json({ ok: false, error: 'empty' }, { status: 400 });

          this.#sql.exec(
            'INSERT INTO msg (role, text, ip, ts) VALUES (?, ?, ?, ?)',
            role,
            text,
            String(b.ip ?? ''),
            Date.now()
          );
          return Response.json({ ok: true });
        }

        /** 喂给模型的近期上下文。**不含 IP** —— 模型不需要知道访客的地址 */
        case '/history': {
          const rows = this.#rows(HISTORY_MAX * 4, false).reverse().slice(-HISTORY_MAX);
          return Response.json({
            items: rows.map((r) => ({ role: r.role, text: r.text })),
          });
        }

        /** 监管页用（阶段③）。带 IP，所以这条路径只能从受保护的 `/admin` 那侧调 */
        case '/all': {
          const n = Math.min(500, Math.max(1, Number(url.searchParams.get('n')) || 200));
          return Response.json({ items: this.#rows(n, true) });
        }

        /** 后台读配置。**这条只从受保护的 `/api/admin/*` 那侧调** */
        case '/cfg': {
          const rows = this.#sql.exec('SELECT k, v FROM cfg').toArray();
          const out: Record<string, string> = {};
          for (const r of rows) out[String(r.k)] = String(r.v ?? '');
          return Response.json({ cfg: out });
        }

        /**
         * 后台写配置。只覆盖传进来的键，**空字符串表示删除这一项**
         * （删掉就回落到 secret 里的默认值，所以「清空」是一个有意义的动作）。
         */
        case '/cfg-set': {
          const b = (await req.json()) as Record<string, unknown>;
          for (const [k, v] of Object.entries(b)) {
            if (!/^[a-z][a-z0-9_]{0,23}$/.test(k)) continue;
            const val = typeof v === 'string' ? v.slice(0, 2000) : '';
            if (val) {
              this.#sql.exec(
                'INSERT INTO cfg (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
                k,
                val
              );
            } else {
              this.#sql.exec('DELETE FROM cfg WHERE k = ?', k);
            }
          }
          return Response.json({ ok: true });
        }

        default:
          return Response.json({ ok: false, error: 'no route' }, { status: 404 });
      }
    } catch {
      /* DO 里抛异常会把整条请求带成 500。落库失败不该让访客的对话失败 ——
         调用方那边是 waitUntil，看不到这个响应，但至少不留下未捕获异常 */
      return Response.json({ ok: false, error: 'log failed' }, { status: 500 });
    }
  }
}
