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
 * 顶栏只放栏目，四项。摄影与此刻暂时下线 —— 摄影等真照片替掉占位图、
 * 此刻等内容能稳定更新，届时各加回一行即可（页面与内容都还在）。
 */
export const NAV = [
  { href: '/', label: '首页' },
  { href: '/posts', label: '文章' },
  { href: '/notes', label: '随笔' },
  { href: '/projects', label: '作品' },
  { href: '/about', label: '关于' },
] as const;

/**
 * 从归档、标签等全站索引面里排除的栏目。
 * 摄影现在全是程序生成的占位图，出现在时间线上会伤可信度；从 NAV 摘掉还不够，
 * getAllEntries() 也要过滤，否则归档页照样列出 5 条假相册。
 * 真照片进来后把这个数组清空，一处开关管住全部索引面。
 */
export const HIDDEN_SECTIONS = ['photos'] as const;

/**
 * 首页底部的入口区。两张卡都是自动生成的页面，不需要维护。
 * 想加新入口就往这里加一项，首页会自动多一张卡片。
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

/** 各内容区的元信息，列表页标题与空状态文案都取自这里 */
export const SECTIONS = {
  posts: {
    label: '文章',
    title: '技术文章',
    description: '踩坑记录、实现笔记与一些想明白了的事。',
    empty: '还没有文章。在 src/content/posts/ 下新建 .md 文件即可。',
  },
  notes: {
    label: '随笔',
    title: '随笔',
    description: '不成体系的观察、读到的东西和一些私人的念头。',
    empty: '还没有随笔。在 src/content/notes/ 下新建 .md 文件即可。',
  },
  photos: {
    label: '摄影',
    title: '摄影',
    description: '按组存放的照片。',
    empty: '还没有照片。在 src/content/photos/ 下新建 .md 并放入图片即可。',
  },
  projects: {
    label: '作品',
    title: '作品',
    description: '做过的一些东西。',
    empty: '还没有作品。在 src/content/projects/ 下新建 .md 文件即可。',
  },
} as const;
