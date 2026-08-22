// 站点全局配置。

export const SITE_URL = 'https://duchenlin.top';

export const SITE_TITLE = '沉麟';

export const SITE_DESCRIPTION = '沉麟的个人站点 —— 技术文章、随笔、摄影与作品。';

/** 首页自我介绍。想改成更像你的话，直接编辑这两句。 */
export const BIO = [
  '对细节挑剔，对「差不多」没耐心。',
  '这里存放做过的东西，和把它们做对的过程。',
];

export const AUTHOR = SITE_TITLE;

/** 每页文章数 */
export const PAGE_SIZE = 10;

/**
 * 顶栏，五项（'/home' 那项被 Header.astro 滤掉，站名自己承担回首页）。
 *
 * R12 起不再是「只放栏目」：`/music` 是页面不是栏目，但它是站上唯一的常驻功能，
 * 需求原文要它「跟文章随笔作品并行」。「关于」从顶栏摘掉，改成点头像进 /about。
 * 标签用「音乐」「图库」而不是页面自己的 h1「唱片机」「摄影」—— 顶栏是导航不是标题，
 * 五项都是 2 字才等宽。
 *
 * 窄屏（≤46rem）五项一行放不下（238px 只够四项），Header.astro 里折成两行，
 * 加第六项前先回去看那段算式。`/now` 仍不挂入口（整页是占位内容，第 9 轮决议）。
 *
 * R14 阶段⑥ 把首页那项从 '/' 改成 '/home'：根路径现在是起始页。
 * 这一项仍然被 Header.astro 滤掉（顶栏就是五项），留着是因为它还有两个用户 ——
 * 语义上「首页在哪」这件事写在这里，以及首页项的 label 供别处引用。
 */
export const NAV = [
  { href: '/home', label: '首页' },
  { href: '/posts', label: '文章' },
  { href: '/notes', label: '随笔' },
  { href: '/projects', label: '作品' },
  { href: '/music', label: '音乐' },
  { href: '/photos', label: '图库' },
] as const;

/**
 * 从归档、标签等全站索引面里排除的栏目。
 * 摄影现在全是程序生成的占位图，出现在时间线上会伤可信度；导航面给了入口
 * （R12 已把「图库」加回顶栏与首页）也不代表索引面要跟着开 —— 归档页一旦列出
 * 那 5 条假相册，就会出现「占位图，请替换」的 alt。这两面是分开的。
 * 真照片进来后把这个数组清空，一处开关管住全部索引面。
 */
export const HIDDEN_SECTIONS = ['photos'] as const;

/**
 * 首页底部的入口区。四张卡都是自动生成的页面，不需要维护。
 * 想加新入口就往这里加一项，首页会自动多一张卡片。
 * 图库同时在顶栏与这里 —— 归档、标签本来也是「页脚 + 首页」两处，不是新模式。
 */
export const PORTALS = [
  {
    href: '/archive',
    label: '归档',
    description: '全站内容按年排成一条时间线。',
  },
  {
    href: '/tags',
    label: '标签',
    description: '按主题横着翻，看写得最多的是什么。',
  },
  {
    href: '/photos',
    label: '图库',
    description: '按组存放的照片，一组一页。',
  },
  {
    // R14 阶段⑥ 之后这道门就是根路径。label 仍叫「启动页」而不是「首页」——
    // 正站首页在 /home，两张卡都叫首页只会让人不知道该点哪张
    href: '/',
    label: '启动页',
    description: '回到进站前那道门，随时可以再看一眼。',
  },
] as const;

/**
 * 联系名片。**全部留空**，填了才渲染，空的整项不出现。
 *
 * 三个平台的能力差得很远，别指望一视同仁（已核实）：
 * - QQ：唯一真能一键弹出加好友页的平台。填号码即可。
 *   （链接格式来自多个社区来源且互相一致，非腾讯官方文档）
 *   qqQr 是退路：链接在部分浏览器与国内定制机上会静默失效，
 *   所以三条腿都给 —— 链接、二维码、复制号码。二维码可留空。
 * - 微信：**没有可用的加好友链接**。官方 URL Scheme 文档只覆盖小程序，
 *   且限非个人主体；网上流传的加好友链接未能核实。只能出示二维码。
 *   把二维码图片放进 public/，这里填 '/wechat-qr.png' 这样的站内路径。
 * - 抖音：**没有加好友链接**，只有个人主页地址。访客打开后要自己点关注。
 */
export const CONTACT = {
  qq: '',
  qqQr: '',
  wechatQr: '',
  douyin: '',
} as const;

/** 留空的项会自动不显示，按需填写 */
export const SOCIAL = {
  github: 'https://github.com/DUEDCL',
  email: '',
  x: '',
  weibo: '',
  zhihu: '',
  rss: '/rss.xml',
} as const;

/**
 * 各内容区的元信息，列表页标题与空状态文案都取自这里。
 *
 * `description` 与 `note` 是**两个不同用途**，R19 起分开：
 * - `description` 只进 `<meta name="description">` 与社交卡片，页面上不再渲染。
 *   R19 之前它同时是页头卡里那段大字介绍（`.head__desc`），需求逐字是
 *   「将文章、随笔、作品、图库这几个页面中的第一个介绍删掉」，于是那个 `<p>` 整块删了，
 *   但 meta 不能跟着删 —— 搜索结果里每一页总得有一句话。
 * - `note` 是页脚版权行右边那句小字，走 BaseLayout 的 footerNote。
 *   参照物是 `/music` 的「听一点音乐吧，让时间慢下来。」（那句仍写在 music.astro 自己身上，
 *   因为音乐不是内容集合、不在这张表里）。五句合起来是一组：都是十来个字的邀请式短句，
 *   不介绍栏目「是什么」，只说「怎么看它」。
 */
export const SECTIONS = {
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
    empty: '还没有照片。在 src/content/photos/ 下新建 .md 并放入图片即可。',
  },
  projects: {
    label: '作品',
    title: '作品',
    description: '做过的一些东西。',
    note: '都在这儿了，挑一个看看。',
    empty: '还没有作品。在 src/content/projects/ 下新建 .md 文件即可。',
  },
} as const;
