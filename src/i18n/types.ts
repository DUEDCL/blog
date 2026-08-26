/**
 * 界面词条的类型。三份词条表（`zh.ts` / `en.ts` / `ja.ts`）都声明成 `Strings`，
 * 于是**漏译一条就是一个编译错误** —— 这是整套多语言里唯一的完整性保障，
 * 没有它，漏掉的那条会在页面上静默显示成 `undefined`。
 *
 * ## 分工：这里只放「界面上的字」
 *
 * `consts.ts` 仍然是站点配置的唯一来源（栏目有哪些、社交账号、二维码路径、
 * 每页多少条）。它里面顺带带着的中文文案就是 **zh 那一份词条**——
 * `zh.ts` 直接引它，不抄第二遍。en / ja 各写全。
 *
 * 内容本身（文章正文、知识库）不在这里：那是 `src/content/`，
 * 元数据的译文写在各自 frontmatter 的 `i18n:` 段里。
 *
 * ## 为什么有些词条是函数
 *
 * 「共 8 篇」在英文里是 `8 posts`、日文里是「全 8 本」—— 数字的位置、量词、
 * 单复数三样都随语言变，拼字符串的活只能交给词条自己做。所以凡是带变量的
 * 一律写成函数，调用处不许自己拼。
 */

/** 三种语言。`zh` 是默认语言，它的页面不带路径前缀 */
export type Locale = 'zh' | 'en' | 'ja';

/** 四个内容栏目。与 `content.config.ts` 的集合名、`utils/content.ts` 的 Section 一致 */
export type Section = 'posts' | 'notes' | 'photos' | 'projects';

/** 顶栏七项的键。与 `consts.ts` 的 NAV 逐项对应（'home' 那项被 Header 滤掉） */
export type NavKey = 'home' | 'posts' | 'notes' | 'projects' | 'music' | 'photos' | 'about';

/** 首页底部那排目录条。'portal' 是根路径那道门 */
export type PortalKey = 'archive' | 'tags' | 'photos' | 'portal';

/** 四套版次。与 `styles/themes.css` 的 `[data-theme='…']` 逐字对应 */
export type EditionId = 'night' | 'paper' | 'film' | 'neon';

/** 名片上的六个平台。与 `consts.ts` 的 CONTACT 对应 */
export type ContactKey = 'wechat' | 'qq' | 'douyin' | 'telegram' | 'discord' | 'email';

/** 一个栏目的五句话。语义见 `consts.ts` 里 SECTIONS 的注释 */
export interface SectionStrings {
  label: string;
  title: string;
  description: string;
  note: string;
  empty: string;
}

export interface Strings {
  /** `<meta name="description">` 的站点级缺省 */
  siteDescription: string;

  /** 首页刊头那两行自述。第一句是沉麟自己的话，译文要保住那个语气 */
  bio: readonly string[];

  nav: Record<NavKey, string>;
  sections: Record<Section, SectionStrings>;
  portals: Record<PortalKey, { label: string; description: string }>;
  /** 版次名与它的物理参照物。`note` 是参照物，不是形容词 */
  editions: Record<EditionId, { name: string; note: string }>;

  /** 跨页面共用的零碎 */
  common: {
    skipToMain: string;
    mainNav: string;
    /** 头像那条链接的 aria-label，参数是站名 */
    brandCard: (site: string) => string;
    brandHome: (site: string) => string;
    avatarAlt: (site: string) => string;
    editionKey: string;
    editionMenu: string;
    langKey: string;
    langMenu: string;
    /** 语言切换菜单里每种语言的自称。三份词条里这一项**内容相同** */
    langNames: Record<Locale, string>;
    close: string;
    /** 页脚那三条站内索引 */
    footArchive: string;
    footTags: string;
    footPortal: string;
    /** 页脚与首页那排小链接里的邮箱 */
    email: string;
    /** 社交链接里需要翻的两个（GitHub / X / RSS 不翻） */
    weibo: string;
    zhihu: string;
  };

  /** 首页（对开大版的头版） */
  home: {
    /** 刊眉的期号。数字是全站条目总数 */
    issue: (n: number) => string;
    /** 栏目头右边那条「全部 N 篇 →」 */
    allCount: (n: number) => string;
    /** 同上，但不带数字（随笔与作品那两栏） */
    all: string;
    /** 首页底部目录条的 aria-label */
    elsewhere: string;
  };

  /** 文章 / 随笔列表页 */
  list: {
    /** 页头右边的计数 */
    count: (n: number) => string;
  };

  /** 文章 / 随笔 / 作品详情页 */
  article: {
    updated: (date: string) => string;
    /** 底部那条回链，参数是栏目名 */
    backTo: (section: string) => string;
    /**
     * 正文还是中文原文时挂在标题下的那条提示（zh 用不到，但类型上要有 ——
     * 缺了它 zh.ts 就得写成可选，en/ja 也跟着变成可选，漏译就查不出来了）。
     */
    onlyInChinese: string;
  };

  archive: {
    title: string;
    description: string;
    /** 页头下那句说明 */
    lead: string;
    searchPlaceholder: string;
    /**
     * 搜到了：命中数 / 总数。**参数是字符串不是数字** —— 这两条由归档页那段客户端
     * 脚本用，服务端渲染时先用 `{n}` / `{total}` 求值成模板串挂在 DOM 上，
     * 运行期再 replace。给成数字类型的话服务端就没法生成那个模板串。
     */
    hit: (n: string, total: string) => string;
    /** 一条都没搜到，参数是关键词原文 */
    miss: (q: string) => string;
    empty: string;
    /** 页头右边的计数（与列表页不同：归档合了三个栏目） */
    count: (n: number) => string;
  };

  tags: {
    title: string;
    description: string;
    lead: string;
    /** 页头右边「共 N 个」 */
    count: (n: number) => string;
    /** 每个标签下的条目数 */
    entryCount: (n: number) => string;
    empty: string;
  };

  notFound: {
    title: string;
    description: string;
    label: string;
    heading: string;
    hint: string;
    /** 出口那一组的小标 */
    ways: string;
  };

  projects: {
    status: Record<'active' | 'wip' | 'archived', string>;
    live: string;
    repo: string;
    count: (n: number) => string;
  };

  photos: {
    /** 相册组数 */
    count: (n: number) => string;
    /** 一组里有几张 */
    shots: (n: number) => string;
    zoom: string;
    /** 灯箱的 aria-label，参数是相册名 */
    lightbox: (album: string) => string;
    prev: string;
    next: string;
  };

  about: {
    title: string;
    /** `<meta name="description">`，参数是站名 */
    description: (site: string) => string;
    label: string;
    elsewhere: string;
    /** CONTACT 全空时那一句实话 */
    empty: string;
    zoom: string;
    copied: string;
    /** 灯箱里那颗复制键在拿不到卡片文案时的兜底 */
    copyFallback: string;
    qrOf: (label: string) => string;
    zoomQrOf: (label: string) => string;
    /** 六张卡各自的字。`action`/`copy` 是按钮文案，没有那颗键的平台留空 */
    contacts: Record<
      ContactKey,
      { label: string; action?: string; copy?: string; note: string }
    >;
  };

  music: {
    title: string;
    description: string;
    note: string;
    /** 视觉隐藏的 h1 */
    heading: string;
    deck: string;
    lyrics: string;
    tracklist: string;
    prev: string;
    next: string;
    play: string;
    pause: string;
    progress: string;
    volume: string;
    /** 播放方式那颗键的 aria-label 前缀，参数是当前档位名 */
    modeLabel: (mode: string) => string;
    /** 四档播放方式。顺序与 `scripts/jukebox.ts` 的 MODES 一致 */
    modes: readonly [string, string, string, string];
    juke: {
      heading: string;
      lead: string;
      searchPlaceholder: string;
      searchLabel: string;
      searchGo: string;
      /** 状态行的初始值 */
      idle: string;
      playAll: string;
      playAllLabel: string;
      /** 搜索框空着就按了搜 */
      needKeyword: string;
      /** 正在取某个歌单 / 某个搜索词 */
      loading: (what: string) => string;
      /** 取回来是空的 */
      none: (what: string) => string;
      /**
       * 取到了几首。**两个参数都是字符串** —— 这一条由点歌台那段客户端脚本用，
       * 服务端先用 `{what}` / `{n}` 求值成模板串（见 `clientStrings()`）。
       */
      found: (what: string, n: string) => string;
      /** 上游没通 */
      offline: string;
      /** 这一首取不到直链 */
      unavailable: string;
      /** 只有试听片段 */
      partial: string;
      /** 正在取某一首的直链 */
      fetching: (title: string) => string;
      /** 搜索关键词在状态行里的引号形式 */
      quoted: (kw: string) => string;
      /**
       * 三个歌单 chip 上的字。**是标签不是实体名** —— 「沉麟推荐」不是那个歌单在
       * 网易云上的原名（见 `data/jukebox.ts` 的 CHARTS 注释），所以它要译。
       * 键与 `data/jukebox.ts` 的 `ChartKey` 逐项对应。
       */
      charts: Record<'mine' | 'hot' | 'original', string>;
      /** 歌单那颗键没有名字时的兜底 */
      chartFallback: string;
      /** 点歌加进队列的那一条在曲目表里的副标题兜底 */
      requested: string;
      /** 取不到、又没有具体原因时 */
      failed: string;
    };
    /** 歌词区两种空状态 */
    lyricsLoading: string;
    lyricsNone: string;
  };

  /** 全站那条状态栏（MiniPlayer）。它 persist，所以换语言必须整页刷新 */
  player: {
    /** 转盘键的 aria-label。展开态下它的意思是「收起」，吸附／药丸态下是「展开」 */
    collapse: string;
    expand: string;
    openDeck: string;
    prev: string;
    next: string;
    play: string;
    pause: string;
    progress: string;
    volume: string;
  };

  /** 「AI 版沉麟」浮窗。开场白与那三个起手问题在 `data/chat.ts` 里，也走这份词条 */
  chat: {
    /** 一次性引导纸条 */
    hintTitle: string;
    hintDesc: string;
    hintClose: string;
    /** 左下那枚键上的字 */
    key: string;
    keyShut: string;
    /** 面板标题 */
    who: string;
    tipsHead: string;
    placeholder: string;
    inputLabel: string;
    send: string;
    /** 上游给了错但读不出人话时 */
    errGeneric: string;
    /** 流式收完却是空的 */
    errEmpty: string;
    /** fetch 本身失败 */
    errNetwork: string;
    /** 开场白。他 2026-08-24 定的那一句，译文只翻不加料 */
    opening: string;
    /** 起手三问。措辞照抄知识库条目的 question（见 `data/chat.ts` 的注释） */
    starters: readonly [string, string, string];
  };

  /** 根路径那道门 */
  portal: {
    /** 这一页的 `<title>`，参数是站名 */
    title: (site: string) => string;
    description: string;
    /** 进站键的 aria-label，参数是站名 */
    enter: (site: string) => string;
  };

  /** 句子里提到作者时用的写法。刊头那两个字不走这里（那是刊名，不翻） */
  authorName: string;

  date: {
    /** 正文用：2026 年 8 月 16 日 */
    long: (y: number, m: number, d: number) => string;
    /** 列表用：2026.08.16。三种语言目前一致，留成函数是为了将来能各自改 */
    short: (y: number, m: number, d: number) => string;
  };

  /**
   * 标签的译名。**键是中文原文**，因为标签是索引键 —— 一个概念在三种语言下必须
   * 落在同一个键上，否则英文标签页会把「架构」和「Architecture」当成两条。
   *
   * 只列需要译的。`Astro`、`Python`、`SQLite` 这类技术名三种语言下都一样，
   * 不必进表：查不到就原样显示（`utils/content.ts` 的 `tagName()`）。
   * 也就是说这张表**可以是不全的**，那是设计而不是漏译。
   */
  tagNames: Record<string, string>;

  /** RSS 的 `<language>` */
  rssLanguage: string;
}

