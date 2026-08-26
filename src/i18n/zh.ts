/**
 * 中文词条 —— 也是三份词条里的**基准**：`en.ts` 与 `ja.ts` 按这一份逐条译。
 *
 * 这些字原来散在 `consts.ts` 与各个页面里。搬过来的时候把「为什么这么写」的注释
 * 一起搬了：那些是决策，不是装饰，改文案之前先读它。结构性的注释（哪些栏目、
 * 顶栏为什么是六项、窄屏怎么折行）留在 `consts.ts` 没动。
 */
import type { Strings } from './types';

export const zh: Strings = {
  siteDescription: '沉麟的个人站点 —— 技术文章、随笔、摄影与作品。',

  /**
   * 首页刊头那两行自述。
   *
   * 第一句是**沉麟自己的话**（R32 那场采访的第一句回答），也是 `kb/who-am-i.md`
   * 的开头 —— 两处是同一句，改一处记得改另一处。原来这里是两句模板腔
   * （「对细节挑剔，对『差不多』没耐心」），换掉的理由就是它不是他说的。
   *
   * 为什么放首页而不是名片页：R29 他亲手圈掉了名片页上的自我介绍块（原话「将图示
   * 圈起来的地方全部删掉，添加『名片』栏」），那一页现在的定位是「页面本身就是名片」。
   */
  bio: [
    '我就是一个在努力尝试和自己做朋友的人。',
    '这里存放做过的东西，和把它们做对的过程。',
  ],

  /**
   * 顶栏六项。用「音乐」「图库」而不是页面自己的 h1「唱片机」「摄影」——
   * 顶栏是导航不是标题，**六项都是 2 字才等宽**。
   * 英日两份没有这条等宽约束（拉丁字母本来就不等宽），但仍要短：
   * 窄屏那个 `repeat(3, 1fr)` 的格子塞不下长词。
   */
  nav: {
    home: '首页',
    posts: '文章',
    notes: '随笔',
    projects: '作品',
    music: '音乐',
    photos: '图库',
    about: '名片',
  },

  /**
   * 四个栏目各五句话。
   *
   * `description` 与 `note` 是**两个不同用途**，R19 起分开：
   * - `description` 只进 `<meta name="description">` 与社交卡片，页面上不再渲染。
   *   R19 之前它同时是页头卡里那段大字介绍（`.head__desc`），需求逐字是「将文章、
   *   随笔、作品、图库这几个页面中的第一个介绍删掉」，于是那个 `<p>` 整块删了，
   *   但 meta 不能跟着删 —— 搜索结果里每一页总得有一句话。
   * - `note` 是页脚版权行右边那句小字，走 BaseLayout 的 footerNote。参照物是
   *   `/music` 的「听一点音乐吧，让时间慢下来。」五句合起来是一组：都是十来个字的
   *   邀请式短句，不介绍栏目「是什么」，只说「怎么看它」。
   *
   * `label` 是竖排栏目标识用的短名，**中文必须是两个字** —— 竖排标识的高度等于
   * 字数×字号，「技术文章」四个字竖起来比标题本身还高（渲染实测 72px vs 44px）。
   */
  sections: {
    posts: {
      label: '文章',
      title: '技术文章',
      description: '踩坑记录、实现笔记与一些想明白了的事。',
      note: '慢慢读吧，想明白比读完重要。',
      empty: '还没有文章。在 src/content/posts/ 下新建 .md 文件即可。',
    },
    notes: {
      label: '随笔',
      title: '随笔',
      description: '不成体系的观察、读到的东西和一些私人的念头。',
      note: '随便翻翻，不成体系也没关系。',
      empty: '还没有随笔。在 src/content/notes/ 下新建 .md 文件即可。',
    },
    photos: {
      label: '摄影',
      title: '摄影',
      description: '按组存放的照片。',
      note: '慢慢看，光和影自己会说话。',
      /* R32 起两组占位相册都标了 draft，这一页现在是真空的，所以这句会被访客看见 ——
         其余四个栏目的 empty 仍是给开发者看的「在 src/content/xxx 下新建 .md」，
         它们有内容、露不出来。这一条不能照那个写法。 */
      empty: '照片还没整理好，等拍够一组再放上来。',
    },
    projects: {
      label: '作品',
      title: '作品',
      description: '做过的一些东西。',
      note: '都在这儿了，挑一个看看。',
      empty: '还没有作品。在 src/content/projects/ 下新建 .md 文件即可。',
    },
  },

  /** 首页底部那排目录条。「启动页」不叫「首页」—— 正站首页在 /home，两条都叫首页
      只会让人不知道该点哪条（R14 阶段⑥ 之后那道门在根路径） */
  portals: {
    archive: { label: '归档', description: '全站内容按年排成一条时间线。' },
    tags: { label: '标签', description: '按主题横着翻，看写得最多的是什么。' },
    photos: { label: '图库', description: '按组存放的照片，一组一页。' },
    portal: { label: '启动页', description: '回到进站前那道门，随时可以再看一眼。' },
  },

  /**
   * 四套版次。`note` 是那套配色的**物理参照物**一句话版，不是形容词 ——
   * 设计规则要求每套配色说得出参照的是什么真实存在的东西（themes.css 每一节顶部
   * 有完整推导）：「深夜印厂刚下机的那一版」是参照物，「酷炫深色」不是。
   */
  editions: {
    night: { name: '夜刊', note: '深夜印厂刚下机的那一版' },
    paper: { name: '晨版', note: '清早送到门口的新闻纸' },
    film: { name: '胶片', note: '过期卷洗出来的暖褐' },
    neon: { name: '霓虹', note: '荧光油墨印在黑纸上' },
  },

  common: {
    skipToMain: '跳到主内容',
    mainNav: '主导航',
    brandCard: (site) => `${site} 的名片`,
    brandHome: (site) => `${site} 首页`,
    avatarAlt: (site) => `${site}的头像`,
    editionKey: '版次',
    editionMenu: '选择版次',
    langKey: '语言',
    langMenu: '选择语言',
    /* 每种语言的**自称**，所以三份词条里这一项内容完全相同 ——
       让一个只读日语的人在中文页面上也认得出哪一项是日语 */
    langNames: { zh: '简体中文', en: 'English', ja: '日本語' },
    close: '关闭',
    footArchive: '归档',
    footTags: '标签',
    footPortal: '启动页',
    email: '邮箱',
    weibo: '微博',
    zhihu: '知乎',
  },

  home: {
    /* 期号用全站条目总数：报纸期号单调递增，而「发一篇 +1」正好也是单调递增的
       真实数字，数得出来。刻意不用建站天数 —— 那个每天都变，而这是静态站，
       不重新构建就会撒谎 */
    issue: (n) => `第 ${n} 号`,
    allCount: (n) => `全部 ${n} 篇 →`,
    all: '全部 →',
    elsewhere: '别处',
  },

  list: {
    count: (n) => `共 ${n} 篇`,
  },

  article: {
    updated: (date) => `更新于 ${date}`,
    backTo: (section) => `← 回到${section}`,
    /* zh 用不上（中文页面的正文本来就是中文），但类型上必须有 —— 见 types.ts 的注释 */
    onlyInChinese: '',
  },

  archive: {
    title: '归档',
    description: '沉麟站内全部内容的时间线，按年份分组。',
    lead: '文章、随笔与作品合成一条时间线。',
    searchPlaceholder: '搜标题',
    hit: (n, total) => `命中 ${n} / ${total}`,
    miss: (q) => `没有匹配「${q}」的标题`,
    empty: '还没有内容。',
    count: (n) => `共 ${n} 篇`,
  },

  tags: {
    title: '标签',
    description: '沉麟站内全部标签，以及每个标签下的内容。',
    lead: '文章、随笔与作品共用这一套标签。',
    count: (n) => `共 ${n} 个`,
    entryCount: (n) => `${n} 篇`,
    empty: '还没有标签。给文章的 frontmatter 加 tags 就会出现在这里。',
  },

  /* 报纸的**更正栏**。「更正」是报刊里勘误那一栏的名字，用在这儿正好，
     不用另造一个词 */
  notFound: {
    title: '页面不存在',
    description: '没有找到这个页面。',
    label: '更正',
    heading: '这里没有东西',
    hint: '地址可能拼错了，或者这篇内容已经被我删掉了。',
    ways: '回哪儿去',
  },

  projects: {
    status: { active: '在用', wip: '进行中', archived: '已归档' },
    live: '线上 ↗',
    repo: '源码 ↗',
    count: (n) => `共 ${n} 个`,
  },

  photos: {
    count: (n) => `共 ${n} 组`,
    shots: (n) => `${n} 张`,
    zoom: '放大',
    lightbox: (album) => `${album} 大图`,
    prev: '上一张',
    next: '下一张',
  },

  /**
   * 名片页。六张卡的按钮文案各不相同，因为**六个平台能做到的事差得很远** ——
   * 能力核实结论全在 `consts.ts` 的 CONTACT 注释里，改这些字之前先读那一段。
   * 一条铁律：**不许下做不到的承诺**。QQ 那颗键写「在 QQ 里打开」而不是「加好友」，
   * 就是因为它只是尝试唤起本机 APP，装了才有反应。
   */
  about: {
    title: '名片',
    description: (site) => `联系 ${site}`,
    label: '名片',
    elsewhere: '别处',
    empty: '联系方式还没整理好。',
    zoom: '点开放大',
    copied: '已复制',
    copyFallback: '复制',
    qrOf: (label) => `${label}二维码`,
    zoomQrOf: (label) => `放大${label}二维码`,
    contacts: {
      wechat: {
        label: '微信',
        /* 给的是昵称不是微信号，所以按钮写「复制昵称」，文案里也说清搜昵称不一定搜得到 */
        copy: '复制昵称',
        note: '微信没有加好友链接，扫码是唯一稳的办法。点二维码放大，手机扫屏幕上这张就行。',
      },
      qq: {
        label: 'QQ',
        action: '在 QQ 里打开',
        copy: '复制号码',
        note: '腾讯已经不让网页发起临时会话了，只能加好友。复制号码去 QQ 里搜最稳；装了 QQ 的话上一颗键能直接跳过去。',
      },
      douyin: {
        label: '抖音',
        action: '打开主页',
        copy: '复制抖音号',
        note: '抖音没有加好友链接：点开二维码用 APP 扫，或复制抖音号去搜。',
      },
      telegram: {
        label: 'Telegram',
        action: '打开对话',
        copy: '复制用户名',
        note: '点开就是对话框，不用先加好友。也可以扫码或复制用户名去搜。',
      },
      discord: {
        label: 'Discord',
        copy: '复制用户名',
        note: '只能在客户端里搜用户名添加，没有可点的链接。',
      },
      email: {
        label: '邮箱',
        action: '写邮件',
        copy: '复制地址',
        note: '最慢也最稳的一条，不依赖任何 APP，我都会看。',
      },
    },
  },

  music: {
    title: '唱片机',
    description: '在听什么 —— 一台自己写的播放器，随片文字跟着走。',
    note: '听一点音乐吧，让时间慢下来。',
    heading: '唱片机',
    deck: '播放器',
    lyrics: '随片文字',
    tracklist: '曲目',
    prev: '上一首',
    next: '下一首',
    play: '播放',
    pause: '暂停',
    progress: '播放进度',
    volume: '音量',
    modeLabel: (mode) => `播放方式：${mode}`,
    modes: ['顺序播放', '列表循环', '单曲循环', '随机播放'],
    juke: {
      heading: '点歌',
      lead: '挑个歌单，或者搜歌名、歌手。点一首就加到上面的曲目里，接着往下放；「全部播放」把整批都加进队列，从第一首开始。',
      searchPlaceholder: '搜歌名或歌手',
      searchLabel: '搜索歌曲',
      searchGo: '搜',
      idle: '挑个歌单，或者搜一下。',
      playAll: '全部播放',
      playAllLabel: '全部加入队列并播放',
      needKeyword: '要搜什么',
      loading: (what) => `正在取${what}…`,
      none: (what) => `${what}：一首都没有。`,
      found: (what, n) => `${what}：${n} 首，点一首加到队列，或者全部播放。`,
      offline: '网络没通，等会儿再试',
      unavailable: '这首现在拿不到，换一首',
      partial: '上游这首只有片段，能播多少算多少',
      fetching: (title) => `正在取「${title}」…`,
      quoted: (kw) => `「${kw}」`,
      charts: { mine: '沉麟推荐', hot: '热歌榜', original: '原创榜' },
      chartFallback: '歌单',
      requested: '点的歌',
      failed: '没取到',
    },
    lyricsLoading: '（正在取歌词…）',
    lyricsNone: '（这首没有歌词）',
  },

  player: {
    collapse: '收起播放器',
    expand: '展开播放器',
    openDeck: '打开唱片机',
    prev: '上一首',
    next: '下一首',
    play: '播放',
    pause: '暂停',
    progress: '播放进度',
    volume: '音量',
  },

  chat: {
    hintTitle: '沉麟的分身',
    hintDesc: '关于我、这个站、我在做的东西，问它。',
    hintClose: '不看了',
    key: '问沉麟的分身',
    keyShut: '收起',
    who: '沉麟的分身',
    tipsHead: '可以这样问',
    placeholder: '回车发送',
    inputLabel: '想问什么',
    send: '发送',
    /* 三条都不许出现状态码：访客要的是「现在能不能问」，不是 502 */
    errGeneric: '我这会儿答不上来，等一下再问',
    errEmpty: '这个我答不上来。',
    errNetwork: '网络断了，等一下再问',
    /**
     * 开场白 —— 他 2026-08-24 定的这一句：「你好，我是沉麟，你想和我聊些什么」。
     *
     * ⚠ **这一句里不再有隐私告知**。原来那版是「他能看到，也会存下来 —— 不是私聊」，
     * 依据是 R32「告知当成 AI 的开场白」那条决议；同一天他要求改成纯问候，
     * 并且把面板上那行小字也去掉了（原话「去掉小字解释」）。
     * R38 他进一步要求**分身不许透露他能看到聊天记录**（原话「我才是站长」）。
     *
     * 所以现在的口径是：**对话照旧全存**（内容、时间、IP，永久，见 `chat-log.ts`），
     * **站上不主动告知，被问也不提站长**；但 `kb/is-chat-private.md` 仍然留着
     * 「这儿不是加密私聊、别说要紧的事」——**不透露 ≠ 谎称私密**，那一条是底线。
     */
    opening: '你好，我是沉麟，你想和我聊些什么',
    /**
     * 开场那三个可点的问题（R45）。措辞**照抄知识库条目的 `question` 原文**，
     * 不自己另写一遍 —— `pickKb()` 按字面重叠打分，抄原文命中的一定是那一条。
     * 三条各对一个 topic：`what-i-do.md`（我）· `site-stack.md`（这个站）·
     * `what-im-learning.md`（当下）。改之前先去 `src/content/kb/` 确认对应文件里的
     * `question` 还是这个字。
     *
     * 英日两份没有这个约束（知识库只有中文，模型读中文答外语），所以那两份按
     * 「访客真会怎么问」译，不必逐字对上文件里的中文。
     */
    starters: ['你平时做什么？', '这个站是用什么做的？', '你最近在学什么？'],
  },

  /* 门。R14 阶段⑥ 之后这是根路径的标题，也就是搜到本站时排在最前的那一行。
     「· 入口」留着是如实描述 —— 这一页是门，不是正站首页。
     页面上那两个字（刊名）与那句题词不进词条：题词是他指名要加的中文对句
     （「沉舟莫断鹏程路，金鳞岂为池中物」），译过去就不是那句诗了。 */
  portal: {
    title: (site) => `${site} · 入口`,
    description:
      '对细节挑剔，对「差不多」没耐心。这里存放做过的东西，和把它们做对的过程。',
    enter: (site) => `进入 ${site} 的站内`,
  },

  authorName: '沉麟',

  date: {
    long: (y, m, d) => `${y} 年 ${m} 月 ${d} 日`,
    short: (y, m, d) => `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}`,
  },

  /* 中文页面显示的就是原文，所以这张表是空的 —— 留着是为了三份词条同构
     （少了它就得把类型改成可选，en/ja 漏译也查不出来了） */
  tagNames: {},

  rssLanguage: 'zh-CN',
};
