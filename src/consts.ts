// 站点全局配置。

export const SITE_URL = 'https://duchenlin.top';

export const SITE_TITLE = '沉麟';

export const SITE_DESCRIPTION = '沉麟的个人站点 —— 技术文章、随笔、摄影与作品。';

/** 首页自我介绍。想改成更像你的话，直接编辑这两句。 */
export const BIO = [
  '写代码，也写字。这里存放技术笔记、日常随笔、做过的东西和拍过的照片。',
  '文章多是踩坑后的记录，写给未来的自己，也顺便放出来。',
];

export const AUTHOR = SITE_TITLE;

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
