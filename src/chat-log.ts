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

/** 一条消息。`ip` 只有 user 那条有值；`model` 只有 ai 那条有值 */
export interface ChatRow {
  id: number;
  role: 'user' | 'ai';
  text: string;
  ip: string;
  model: string;
  /**
   * 这句是谁说的（R41②「聊天实时接管」）。`role` 回答的是「在对话里是哪一方」，
   * 这一列回答的是「那一方是模型还是人」：
   * - `ai` —— 模型生成的（默认，线上老数据全是这个）；
   * - `human` —— **沉麟本人在后台打的字**，访客当时看到的就是这一句。
   *
   * 两列不能合并：接管时的回复在对话里仍然是 `assistant` 那一方（喂给模型当历史也要按
   * assistant 算，否则下一轮它会以为自己没说过话），但它不是模型说的。
   */
  who: 'ai' | 'human';
  /**
   * 哪个浏览器窗口说的（R42）。
   *
   * R42 起**会话号是按访客 IP 派生的**（同一个 IP 永远落在同一个会话里，他要的），
   * 而一个 IP 后面可能有好几个人 —— 学校、公司、运营商 NAT，手机上的 CGNAT 更是常态。
   * 所以「会话」这一层管的是「后台看到几条线」，「窗口」这一层管的是
   * **喂给模型的上下文与接管时那句话发给谁**：
   * - `/history` 只取同一个窗口的消息 → 隔壁那个人说的话不会串进模型的上下文；
   * - `/wait` 与 `/reply` 按窗口配对 → 接管时回的话不会发给另一个人。
   *
   * 值就是前端 `sessionStorage` 里那个 uuid（关掉标签页就换新的）。
   * 空串是 R41 及之前的老数据 —— 那时它还是会话号本身。
   */
  tab: string;
  ts: number;
}

/** 后台里的一份草稿（R41②「文章编辑」／「图库管理」）。`front` 是 frontmatter 原文，没解析 */
export interface DraftRow {
  id: string;
  coll: string;
  slug: string;
  title: string;
  front: string;
  body: string;
  updated: number;
}

/**
 * 喂给模型的历史条数上限。**4 条 = 2 轮**（R39 从 6 降下来的）：
 * 每一轮都要把整个知识库连同历史一起送进去，历史每多一条就是几十到几百个 token
 * 乘以往后每一次对话。两轮足够接住「那你……」「刚才说的那个……」这类指代，
 * 再多就是拿钱买记忆了。
 */
const HISTORY_MAX = 4;

/** 一条消息最长存多少字符。截断而不是拒绝 —— 落库不该因为一条超长消息失败 */
const TEXT_MAX = 4000;

/**
 * 接管时访客最多等多久（毫秒）。这不是随手定的数：
 * - 太短（几秒）他来不及打字，等于接管永远不生效；
 * - 太长访客会以为站坏了，而且这条请求一直占着一个 Worker 调用。
 *
 * 25 秒是折中：够打一句短的，也在访客的耐心之内。**等待不计入 Workers 的 CPU 时间**
 * （免费档限的是 10 ms CPU／请求，等 I/O 不算），所以它不花 CPU 配额。
 * 超时之后 Worker 那边会退回模型生成 —— 访客不会空手，见 `worker.ts` 的 `chat()`。
 */
const WAIT_MAX_MS = 25000;

/** 草稿正文的上限。一篇长文两万字中文也就六万多字符，10 万留足余量 */
const DRAFT_MAX = 100000;

const clampNum = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/**
 * `ctx.storage.sql` 的最小形状。只声明用得到的 `exec().toArray()` ——
 * 完整类型在 `@cloudflare/workers-types` 里，而本项目不引它。
 */
interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export class ChatLog {
  #sql: Sql;

  /**
   * 正在等人工回复的访客（R41②）。**只在内存里**，不落库 ——
   * 它是一组「把这条 HTTP 请求放走」的回调，重启之后本来就没有意义。
   *
   * DO 有一个关键性质让这套写法成立：**同一个会话号永远落在同一个实例上**，
   * 而且实例在有未完成请求时不会被驱逐。所以访客的 `/wait` 与沉麟的 `/reply`
   * 一定见得到同一个 Set，不需要轮询数据库。
   *
   * R42 起每个等待者还带自己的**窗口号**：会话按 IP 合并之后，同一条会话下可能有
   * 两个不同的人同时在等，而沉麟打的那句话只该发给其中一个（见 `/reply`）。
   *
   * R43 起等待者有**两种**，都躺在这一个 Set 里（靠 `kind` 分）：
   * - `wait` —— 访客问了一句、正等人工回复（接管那条路）；
   * - `listen` —— 访客只是开着对话框，等沉麟**主动**说点什么。
   *   这一条是 R43 补的：在它出现之前，没人正在等的时候沉麟打的字只是往库里写一行，
   *   访客那边没有任何通道能收到它 —— 那些行的 `tab` 还是空的，成了永远送不出去的死信。
   *
   * **同一个窗口的这两种不能同时挂着**：那会让一句话被送出去两次（一次从对话的 SSE，
   * 一次从接收通道）—— 本地实测过，气泡真的出现了两条一样的。
   * 所以 `/wait` 挂起前会把同窗口的 `listen` 全部踢掉（见那一段）。
   */
  #waiters = new Set<{
    tab: string;
    kind: 'wait' | 'listen';
    done: (m: { id: number; text: string }) => void;
  }>();

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
       用 cfg 与 ses 两张表。这样不必新增第二个 DO 绑定，也不必给类改名
       （改名要走 rename migration，不值得）。代价是每个实例都多几张空表，各占几 KB。 */
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS cfg (
         k TEXT PRIMARY KEY,
         v TEXT NOT NULL
       )`
    );

    /**
     * 会话索引（R38）—— 后台要能列出「有哪些人聊过」。
     *
     * 为什么需要它：DO 是**按会话分实例**的，一个会话一个对象，
     * 彼此不知道对方存在，没有任何全局视图。所以必须在配置实例里单独记一份索引，
     * 每轮对话往这儿 upsert 一次。
     */
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS ses (
         id    TEXT PRIMARY KEY,
         first INTEGER NOT NULL,
         last  INTEGER NOT NULL,
         n     INTEGER NOT NULL DEFAULT 0,
         ip    TEXT    NOT NULL DEFAULT '',
         model TEXT    NOT NULL DEFAULT ''
       )`
    );

    /**
     * 后台里的草稿（R41②）。**只在配置实例上用**，与 `cfg`、`ses` 一样。
     *
     * 为什么草稿存在这儿而不是写回仓库：这个站是静态构建的，文章的真身是
     * `src/content/**\/*.md`，而 Worker 没有仓库的写权限（也不该有 —— 那意味着
     * 把一把能改代码的 token 放进线上环境）。所以后台的定位是**写作台**：
     * 在这儿写、在这儿改、多设备看得到同一份，定稿了导出 .md 放进仓库再部署。
     * 这条边界在后台页面上是明写出来的，不让他以为点了保存就上线了。
     */
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS draft (
         id      TEXT    PRIMARY KEY,
         coll    TEXT    NOT NULL,
         slug    TEXT    NOT NULL,
         title   TEXT    NOT NULL DEFAULT '',
         front   TEXT    NOT NULL DEFAULT '',
         body    TEXT    NOT NULL DEFAULT '',
         updated INTEGER NOT NULL
       )`
    );

    /* 线上那些实例的 msg 表是 R33 建的，没有 model 列（他 R38 要看「模型使用」）。
       SQLite 没有 `ADD COLUMN IF NOT EXISTS`，第二次跑必然抛「duplicate column」——
       所以吞掉异常就是这里的正确写法，不是偷懒。

       R41 又加了三列，同一套办法。**列名用 `who` 不用 `by`**：`BY` 在 SQLite 的
       关键字表里，不加引号当列名是在赌解析器的心情。 */
    for (const sql of [
      "ALTER TABLE msg ADD COLUMN model TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE msg ADD COLUMN who TEXT NOT NULL DEFAULT 'ai'",
      "ALTER TABLE msg ADD COLUMN tab TEXT NOT NULL DEFAULT ''",
      'ALTER TABLE ses ADD COLUMN takeover INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE ses ADD COLUMN wait INTEGER NOT NULL DEFAULT 0',
    ]) {
      try {
        this.#sql.exec(sql);
      } catch {
        /* 已经有这一列了 */
      }
    }
  }

  #rows(limit: number, asc = true, after = 0): ChatRow[] {
    const r = this.#sql
      .exec(
        `SELECT id, role, text, ip, model, who, tab, ts FROM msg
          WHERE id > ? ORDER BY id ${asc ? 'ASC' : 'DESC'} LIMIT ?`,
        after,
        limit
      )
      .toArray();

    return r.map((x) => ({
      id: Number(x.id),
      role: x.role === 'user' ? 'user' : 'ai',
      text: String(x.text ?? ''),
      ip: String(x.ip ?? ''),
      model: String(x.model ?? ''),
      who: x.who === 'human' ? 'human' : 'ai',
      tab: String(x.tab ?? ''),
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
            model?: string;
            who?: string;
            tab?: string;
          };
          const role = b.role === 'user' ? 'user' : 'ai';
          const text = String(b.text ?? '').slice(0, TEXT_MAX);
          if (!text) return Response.json({ ok: false, error: 'empty' }, { status: 400 });

          this.#sql.exec(
            'INSERT INTO msg (role, text, ip, model, who, tab, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
            role,
            text,
            String(b.ip ?? ''),
            String(b.model ?? '').slice(0, 80),
            b.who === 'human' ? 'human' : 'ai',
            String(b.tab ?? '').slice(0, 64),
            Date.now()
          );
          return Response.json({ ok: true });
        }

        /**
         * 沉麟本人的回复（R41②「聊天实时接管」）。做两件事，顺序要紧：
         * 先落库（这样即使没有人在等，这句话也不会丢），再放走正在等的那条访客请求。
         *
         * **发给哪个窗口，由调用方指定**（R43）。原来是「取最近一个开始等的窗口」，
         * 那在「访客正问着」的场合是对的，但它有两个洞：
         * ① 没人在等时取不到窗口号，落库的 `tab` 是空串 —— 那一行永远匹配不上任何窗口的
         *    查询，成了送不出去的死信（他实测到的「主动发消息没反应」就是这个）；
         * ② R43 起访客只要开着对话框就有一条 `/listen` 挂着，「最近一个」于是变成
         *    「谁最后重连的」—— 一个没有意义的顺序。
         *
         * 所以后台现在把窗口号一起传上来（它看得到每条消息属于哪个窗口）。
         * 三级兜底：调用方指定 → 最近一个等待者 → **最后一条访客消息的窗口**。
         * 最后那一级保证了「库里那一行一定属于某个真实窗口」，不会再有死信。
         */
        case '/reply': {
          const b = (await req.json()) as { text?: string; tab?: string };
          const text = String(b.text ?? '').slice(0, TEXT_MAX);
          if (!text) return Response.json({ ok: false, error: 'empty' }, { status: 400 });

          /* 复制成数组：回调里会把自己从 Set 里删掉，边遍历边删是未定义行为。
             Set 保持插入顺序，所以最后一个就是最近开始等的那个窗口。 */
          const list = [...this.#waiters];
          const asked = String(b.tab ?? '').slice(0, 64);
          const lastUser = this.#sql
            .exec("SELECT tab FROM msg WHERE role = 'user' ORDER BY id DESC LIMIT 1")
            .toArray();
          const target =
            asked || (list.length ? list[list.length - 1].tab : '') || String(lastUser[0]?.tab ?? '');

          this.#sql.exec(
            "INSERT INTO msg (role, text, ip, model, who, tab, ts) VALUES ('ai', ?, '', '', 'human', ?, ?)",
            text,
            target,
            Date.now()
          );
          const id = Number(this.#sql.exec('SELECT last_insert_rowid() AS v').toArray()[0]?.v ?? 0);

          let waiting = 0;
          for (const w of list) {
            if (w.tab !== target) continue;
            waiting++;
            w.done({ id, text });
          }
          return Response.json({ ok: true, waiting, tab: target, id });
        }

        /**
         * 访客侧的等待（R41②）。被接管的会话里，Worker 不去调模型，而是打这一条挂着 ——
         * 沉麟一按发送，上面那个 `/reply` 就把它放走。
         *
         * **先查一次库再挂起**：沉麟完全可能在访客这条请求到达 DO 之前就已经把回复写进去了
         * （他在后台看着上一句就开始打字）。判据是「有没有比这个窗口最后一条访客消息更新的
         * 人工回复」—— 访客那一句在 Worker 那边是 `await` 落库的，所以它一定已经在表里了，
         * 不需要调用方传游标进来（传游标反而会因为两次请求之间的时序错开而算错）。
         *
         * R42 起这两处都按**窗口**算：会话按 IP 合并之后，同一条会话里可能有别人的
         * 人工回复躺着，那一句不该被这个窗口取走。`tab` 为空是老前端（会话号还是它自己
         * 生成的那一版），那时退回按整条会话算 —— 与 R41 的行为一致。
         */
        case '/wait': {
          const ms = clampNum(url.searchParams.get('ms'), 1000, 55000, WAIT_MAX_MS);
          const tab = String(url.searchParams.get('tab') ?? '').slice(0, 64);

          const had = tab
            ? this.#sql
                .exec(
                  `SELECT id, text FROM msg
                     WHERE who = 'human' AND tab = ?
                       AND id > COALESCE(
                         (SELECT MAX(id) FROM msg WHERE role = 'user' AND tab = ?), 0)
                     ORDER BY id ASC LIMIT 1`,
                  tab,
                  tab
                )
                .toArray()
            : this.#sql
                .exec(
                  `SELECT id, text FROM msg
                     WHERE who = 'human'
                       AND id > COALESCE((SELECT MAX(id) FROM msg WHERE role = 'user'), 0)
                     ORDER BY id ASC LIMIT 1`
                )
                .toArray();
          if (had.length)
            return Response.json({ id: Number(had[0].id), text: String(had[0].text ?? '') });

          /* **先把同窗口的接收通道踢掉**（R43）。访客正在问一句，那条 `listen` 就该让位 ——
             两个都挂着的话，`/reply` 会把同一句话同时交给它们，访客那边出两条一样的气泡
             （本地实测过，就是这么发现的）。踢的方式是用空值 resolve，前端拿到空的会重挂。 */
          for (const w of [...this.#waiters]) {
            if (w.kind === 'listen' && w.tab === tab) w.done({ id: 0, text: '' });
          }

          const got = await new Promise<{ id: number; text: string }>((resolve) => {
            const entry = {
              tab,
              kind: 'wait' as const,
              done: (m: { id: number; text: string }) => {
                this.#waiters.delete(entry);
                resolve(m);
              },
            };
            this.#waiters.add(entry);
            setTimeout(() => entry.done({ id: 0, text: '' }), ms);
          });
          return Response.json(got);
        }

        /**
         * 访客侧的**主动接收**通道（R43）—— 他报的「接管后不能主动发送消息」就是缺这一条。
         *
         * R41／R42 的接管是**应答式**的：访客问一句 → 请求挂起 → 沉麟回一句 → 放走。
         * 访客那边除此之外没有任何常驻通道，所以他在「访客没发问」的时候打的字
         * 没地方送 —— 只在库里留下一行，而且那一行的 `tab` 还是空的，成了死信。
         *
         * 这一条把「访客开着对话框」本身变成一条挂着的连接（长轮询）：
         * 前端一进来先用 `after=-1` 拿一次游标（只要 id、不回放历史），然后反复打这一条；
         * 沉麟一按发送，`/reply` 就地把它放走 —— **零延迟，不是定时轮询**。
         *
         * 为什么不做成每几秒一次的定时轮询：那样一个开着对话框的访客每分钟要打十几次接口，
         * 而长轮询是每 25 秒一次。DO 的免费额度是 10 万请求/天，这个差别是一个量级。
         *
         * 代价与它的上限：挂着的请求会让这个 DO 实例一直活着（duration 计费，
         * 免费档 13,000 GB-s/天 ≈ 单人连续挂 27 小时）。所以**前端有硬上限** ——
         * 连续空转 40 轮（约 17 分钟没动静）就停下，访客再动一下才重新开始。
         */
        case '/listen': {
          const ms = clampNum(url.searchParams.get('ms'), 1000, 55000, WAIT_MAX_MS);
          const tab = String(url.searchParams.get('tab') ?? '').slice(0, 64);
          if (!tab) return Response.json({ id: 0, text: '' });

          const after = Math.trunc(Number(url.searchParams.get('after')));

          /* `after < 0`（或没传）＝**只要游标**：回这个窗口当前的最大 id，不回内容。
             第一次打开对话框走这一档 —— 那时页面上一个气泡都没有，
             把历史里的人工消息单方面回放出来只会让人看不懂（自己问的那些不在）。 */
          if (!Number.isFinite(after) || after < 0) {
            const max = this.#sql
              .exec('SELECT COALESCE(MAX(id), 0) AS v FROM msg WHERE tab = ?', tab)
              .toArray();
            return Response.json({ id: Number(max[0]?.v ?? 0), text: '' });
          }

          const had = this.#sql
            .exec(
              `SELECT id, text FROM msg
                 WHERE who = 'human' AND tab = ? AND id > ?
                 ORDER BY id ASC LIMIT 1`,
              tab,
              after
            )
            .toArray();
          if (had.length)
            return Response.json({ id: Number(had[0].id), text: String(had[0].text ?? '') });

          /* 同窗口正有一条 `/wait` 挂着（访客刚问了一句，在等人工回复）——
             那这条接收通道立刻让位，不挂。否则 `/reply` 会把同一句话交给两个通道，
             访客那边出两条一样的气泡。前端拿到空的会歇一下再挂。
             `/wait` 那一侧也会主动踢掉已经挂着的 listen —— 两边都堵一次，
             因为两条请求「谁先到 DO」是不确定的。 */
          if ([...this.#waiters].some((w) => w.kind === 'wait' && w.tab === tab)) {
            return Response.json({ id: after, text: '' });
          }

          const got = await new Promise<{ id: number; text: string }>((resolve) => {
            const entry = {
              tab,
              kind: 'listen' as const,
              done: (m: { id: number; text: string }) => {
                this.#waiters.delete(entry);
                resolve(m);
              },
            };
            this.#waiters.add(entry);
            // 超时回原游标：前端拿它接着挂下一轮，不会因为超时把游标丢了
            setTimeout(() => entry.done({ id: after, text: '' }), ms);
          });
          return Response.json(got);
        }

        /** 这个会话眼下有没有人在等人工回复。后台的「有人在等」灯靠它 */
        case '/waiting':
          return Response.json({ waiting: this.#waiters.size });

        /**
         * 喂给模型的近期上下文。**不含 IP** —— 模型不需要知道访客的地址。
         *
         * R42 起按**窗口**取：会话是按 IP 合并的，同一个 IP 后面可能有好几个人
         * （学校、公司、运营商 NAT，手机的 CGNAT 更是常态）。不按窗口过滤的话，
         * 隔壁那个人刚说的话会串进这个人的上下文里 —— 模型会答得莫名其妙，
         * 而这种错很难查。`tab` 为空是老数据／老前端，那时退回按整条会话取。
         */
        case '/history': {
          const tab = String(url.searchParams.get('tab') ?? '').slice(0, 64);
          const all = this.#rows(HISTORY_MAX * 8, false);
          const mine = tab ? all.filter((r) => r.tab === tab) : all;
          const rows = mine.reverse().slice(-HISTORY_MAX);
          return Response.json({
            items: rows.map((r) => ({ role: r.role, text: r.text })),
          });
        }

        /** 监管页用（阶段③）。带 IP，所以这条路径只能从受保护的 `/admin` 那侧调。
            `after` 给实时轮询用：只取比它更新的，一轮拉几条而不是每次拉四百条 */
        case '/all': {
          const n = clampNum(url.searchParams.get('n'), 1, 500, 200);
          const after = Number(url.searchParams.get('after')) || 0;
          const items = this.#rows(n, true, after);
          return Response.json({
            items,
            /* 库里最后一条的 id。前端拿它当下一轮的 `after`；这一轮没有新东西时
               也要能回一个正确的游标，所以取的是「有就用最后一条，没有就用传进来的」 */
            last: items.length ? items[items.length - 1].id : after,
          });
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

        /**
         * 会话索引的 upsert（只打在配置实例上）。每轮对话一次。
         * `n` 累加、`last` 覆盖、`first` 只在第一次写，`ip`/`model` 取最近一次的值。
         */
        case '/touch': {
          const b = (await req.json()) as {
            id?: string;
            ip?: string;
            model?: string;
            add?: number;
            /** 1 = 这个会话正等人工回复，0 = 不等了。不传就不动这一列 */
            wait?: number;
          };
          const id = String(b.id ?? '').slice(0, 64);
          if (!id) return Response.json({ ok: false, error: 'no id' }, { status: 400 });

          const now = Date.now();
          const add = Number(b.add) || 0;
          this.#sql.exec(
            `INSERT INTO ses (id, first, last, n, ip, model) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               last  = excluded.last,
               n     = ses.n + excluded.n,
               ip    = CASE WHEN excluded.ip    <> '' THEN excluded.ip    ELSE ses.ip    END,
               model = CASE WHEN excluded.model <> '' THEN excluded.model ELSE ses.model END`,
            id,
            now,
            now,
            add,
            String(b.ip ?? ''),
            String(b.model ?? '').slice(0, 80)
          );
          /* 「有人在等」单独一条 UPDATE：它与上面那个 upsert 的语义不同 ——
             upsert 里 `wait` 不出现，所以不传这个字段时这一列不受影响。
             存的是时间戳而不是布尔值：后台要显示「等了几秒」，而且进程被换掉时
             残留的旧时间戳一眼就能看出是陈的（超过 30 秒的一律当没人在等）。 */
          if (b.wait !== undefined) {
            this.#sql.exec('UPDATE ses SET wait = ? WHERE id = ?', b.wait ? now : 0, id);
          }
          return Response.json({ ok: true });
        }

        /**
         * 打开／关掉某个会话的人工接管（R41②）。存在配置实例的 `ses` 表里，
         * 而不是会话实例里 —— `/api/chat` 每一轮都要问一次「这个会话被接管了吗」，
         * 而它本来就已经在读配置实例（`loadCfg`）。放这儿省一次跨实例往返。
         */
        case '/takeover': {
          const b = (await req.json()) as { id?: string; on?: unknown };
          const id = String(b.id ?? '').slice(0, 64);
          if (!id) return Response.json({ ok: false, error: 'no id' }, { status: 400 });
          const now = Date.now();
          /* 会话还没进过索引也要能提前开（他可能想「下一个进来的人我自己接」）——
             所以是 upsert 不是 update */
          this.#sql.exec(
            `INSERT INTO ses (id, first, last, n, takeover) VALUES (?, ?, ?, 0, ?)
             ON CONFLICT(id) DO UPDATE SET takeover = excluded.takeover`,
            id,
            now,
            now,
            b.on ? 1 : 0
          );
          return Response.json({ ok: true, takeover: b.on ? 1 : 0 });
        }

        /** 单个会话的接管标记。`/api/chat` 每轮问一次，所以只回两个数，不回整行 */
        case '/flag': {
          const id = String(url.searchParams.get('id') ?? '').slice(0, 64);
          const r = this.#sql.exec('SELECT takeover FROM ses WHERE id = ?', id).toArray();
          /* `seen` 是**沉麟最后一次在后台刷新会话列表**的时刻（后台每 3 秒一次）。
             `/api/chat` 拿它判断「他现在人在不在」—— 接管开着但他早就离开了的时候，
             不该让每个访客都白等 25 秒。写在 cfg 表里，与接管标记一起一次读回。 */
          const s = this.#sql.exec("SELECT v FROM cfg WHERE k = 'seen'").toArray();
          return Response.json({
            takeover: Number(r[0]?.takeover ?? 0) === 1,
            seen: Number(s[0]?.v ?? 0),
          });
        }

        /** 会话列表（配置实例）。最近活跃的排前面 */
        case '/sessions': {
          const n = clampNum(url.searchParams.get('n'), 1, 200, 60);
          const rows = this.#sql
            .exec(
              `SELECT id, first, last, n, ip, model, takeover, wait
                 FROM ses ORDER BY last DESC LIMIT ?`,
              n
            )
            .toArray();
          const now = Date.now();
          return Response.json({
            items: rows.map((x) => ({
              id: String(x.id),
              first: Number(x.first),
              last: Number(x.last),
              n: Number(x.n),
              ip: String(x.ip ?? ''),
              model: String(x.model ?? ''),
              takeover: Number(x.takeover ?? 0) === 1,
              /* 「正在等」有时效：那条访客请求最多挂 25 秒，超过 30 秒的时间戳一定是陈的
                 （进程被换掉、或者 Worker 那边没来得及写回 0）。陈的一律当没人在等 ——
                 后台上亮着一颗永不熄的「有人在等」比不亮更糟。 */
              wait: Number(x.wait ?? 0) > 0 && now - Number(x.wait) < 30000,
            })),
          });
        }

        /* ---- 草稿（R41②）---------------------------------------------------
           只在配置实例上用。列表不带正文 —— 后台一进来就拉一次，
           几十篇的正文加起来是几十万字符，没必要每次都过一遍网络。 */

        case '/drafts': {
          const rows = this.#sql
            .exec(
              `SELECT id, coll, slug, title, updated, length(body) AS n
                 FROM draft ORDER BY updated DESC LIMIT 200`
            )
            .toArray();
          return Response.json({
            items: rows.map((x) => ({
              id: String(x.id),
              coll: String(x.coll ?? ''),
              slug: String(x.slug ?? ''),
              title: String(x.title ?? ''),
              updated: Number(x.updated ?? 0),
              chars: Number(x.n ?? 0),
            })),
          });
        }

        /** 一份草稿的全文 */
        case '/draft': {
          const id = String(url.searchParams.get('id') ?? '').slice(0, 200);
          const r = this.#sql
            .exec('SELECT id, coll, slug, title, front, body, updated FROM draft WHERE id = ?', id)
            .toArray();
          if (!r.length) return Response.json({ ok: false, error: 'no draft' }, { status: 404 });
          const x = r[0];
          return Response.json({
            ok: true,
            item: {
              id: String(x.id),
              coll: String(x.coll ?? ''),
              slug: String(x.slug ?? ''),
              title: String(x.title ?? ''),
              front: String(x.front ?? ''),
              body: String(x.body ?? ''),
              updated: Number(x.updated ?? 0),
            } satisfies DraftRow,
          });
        }

        /** 存一份草稿。`id` 由调用方拼成 `<集合>/<slug>`，所以改 slug 等于另存一份 */
        case '/draft-set': {
          const b = (await req.json()) as Record<string, unknown>;
          const id = String(b.id ?? '').slice(0, 200);
          if (!id) return Response.json({ ok: false, error: 'no id' }, { status: 400 });
          this.#sql.exec(
            `INSERT INTO draft (id, coll, slug, title, front, body, updated)
               VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               coll = excluded.coll, slug = excluded.slug, title = excluded.title,
               front = excluded.front, body = excluded.body, updated = excluded.updated`,
            id,
            String(b.coll ?? '').slice(0, 20),
            String(b.slug ?? '').slice(0, 160),
            String(b.title ?? '').slice(0, 200),
            String(b.front ?? '').slice(0, DRAFT_MAX),
            String(b.body ?? '').slice(0, DRAFT_MAX),
            Date.now()
          );
          return Response.json({ ok: true });
        }

        case '/draft-del': {
          const b = (await req.json()) as { id?: string };
          this.#sql.exec('DELETE FROM draft WHERE id = ?', String(b.id ?? '').slice(0, 200));
          return Response.json({ ok: true });
        }

        /** 后台顶栏那几个实时数字（R41②）。一次问完，省得为每个数字各打一条 */
        case '/stat': {
          const one = (sql: string) => Number(this.#sql.exec(sql).toArray()[0]?.v ?? 0);
          const now = Date.now();
          return Response.json({
            sessions: one('SELECT COUNT(*) AS v FROM ses'),
            msgs: one('SELECT COALESCE(SUM(n), 0) AS v FROM ses'),
            takeover: one('SELECT COUNT(*) AS v FROM ses WHERE takeover = 1'),
            waiting: one('SELECT COUNT(*) AS v FROM ses WHERE wait > ' + (now - 30000)),
            drafts: one('SELECT COUNT(*) AS v FROM draft'),
            /* 最近一次有人说话的时间。后台顶栏用它显示「刚刚有人在聊」 */
            lastSeen: one('SELECT COALESCE(MAX(last), 0) AS v FROM ses'),
          });
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
