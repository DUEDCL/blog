// 站点全局配置。
// ⚠️ 下面标了 TODO 的三项是占位值，需要你按自己的实际信息替换。
// 我没有替你猜真实姓名和简介 —— 猜错比留空更糟。

export const SITE_URL = 'https://duchenlin.eu.cc';

/** TODO: 换成你想显示的站点名 / 你的名字 */
export const SITE_TITLE = 'duchenlin';

/** TODO: 一句话介绍你自己，会出现在首页和搜索结果里 */
export const SITE_DESCRIPTION = '写技术、随笔与摄影的个人站点。';

/** TODO: 首页那段自我介绍，两三句话即可 */
export const BIO = [
  '这里是我的个人站点，用来存放技术笔记、日常随笔、做过的东西和拍过的照片。',
  '文章多是自己踩坑后的记录，写给未来的自己看，也顺便放出来。',
];

export const AUTHOR = SITE_TITLE;

/**
 * TODO: 页头印章里的那个字，通常用姓氏。
 * 我从域名猜是「杜」，但没把握 —— 改成你自己的字。留空则显示站名首字母。
 */
export const SEAL_CHAR = '杜';

/** 每页文章数 */
export const PAGE_SIZE = 10;

export const NAV = [
  { href: '/', label: '首页' },
  { href: '/posts', label: '文章' },
  { href: '/notes', label: '随笔' },
  { href: '/photos', label: '摄影' },
  { href: '/projects', label: '作品' },
  { href: '/about', label: '关于' },
] as const;

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
