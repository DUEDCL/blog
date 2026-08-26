// 站点全局配置。
//
// **这里不再放面向访客的中文**（R46 多语言化）。栏目有哪些、地址是什么、账号填了没有
// 留在这儿；标签、标题、介绍、空状态那些字搬去了 `src/i18n/{zh,en,ja}.ts`，
// 三种语言各一份，漏译一条就是一个编译错误。
// 唯一的例外是 `SITE_TITLE` —— 那两个字是刊名，是签名，三种语言下都不变。

export const SITE_URL = 'https://duchenlin.top';

/**
 * 刊名。**三种语言下都是这两个字**：首页那 120px 的大字是为两个汉字排的，
 * 换成 `Chenlin` 会让刊头的字距、行高、与题词的对齐全部失效。
 * 句子里提到他的时候用 `i18n` 的 `authorName`（英文那份是 `Chenlin`）。
 */
export const SITE_TITLE = '沉麟';

export const AUTHOR = SITE_TITLE;

/** 每页文章数 */
export const PAGE_SIZE = 10;

/**
 * 顶栏，六项（'/home' 那项被 Header.astro 滤掉，站名自己承担回首页）。
 *
 * R12 起不再是「只放栏目」：`/music` 是页面不是栏目，但它是站上唯一的常驻功能，
 * 需求原文要它「跟文章随笔作品并行」。
 *
 * **R29 加回第六项「名片」**（原话「添加『名片』栏」）：`/about` 那一页的自我介绍与
 * 建站说明都删掉了，剩下的就是名片，于是它值得一个顶栏入口 —— 头像仍然指向同一页，
 * 但那是个没有文字的入口，找不找得到全靠猜。
 *
 * 窄屏（≤46rem）nav 折成整行、`repeat(3, 1fr)` 的网格：五项时是 3+2 的破行，
 * 六项正好 3+3 —— 加这一项在窄屏上反而更齐。再加第七项前先回去看 Header.astro 那段。
 *
 * R14 阶段⑥ 把首页那项从 '/' 改成 '/home'：根路径现在是起始页。
 * 这一项仍然被 Header.astro 滤掉，留着是因为它还有两个用户 ——
 * 语义上「首页在哪」这件事写在这里，以及首页项的 label 供别处引用。
 *
 * 标签在 `i18n/*.ts` 的 `nav` 里（六项两字等宽那条约束也记在那儿）。
 * `href` 是**不带语言前缀**的站内路径，加前缀由 `i18n/index.ts` 的 `localePath()` 做。
 */
export const NAV = [
  { key: 'home', href: '/home' },
  { key: 'posts', href: '/posts' },
  { key: 'notes', href: '/notes' },
  { key: 'projects', href: '/projects' },
  { key: 'music', href: '/music' },
  { key: 'photos', href: '/photos' },
  { key: 'about', href: '/about' },
] as const;

/**
 * 版次（R44）—— 顶栏那枚切换键列出来的四套主题。
 *
 * `id` 必须与 `src/styles/themes.css` 里 `[data-theme='…']` 的名字逐字对应，
 * 也与 `components/ThemeBoot.astro` 那段 inline 脚本里的白名单对应（那份是运行期
 * 校验 localStorage 的，拿不到本模块的常量 —— 加一套版次要改的是这三处，
 * 再加 `i18n/*.ts` 的 `editions` 三份文案）。
 */
export const EDITIONS = [
  { id: 'night' },
  { id: 'paper' },
  { id: 'film' },
  { id: 'neon' },
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
 * 首页底部的入口区。四张都是自动生成的页面，不需要维护。
 * 想加新入口就往这里加一项，首页会自动多一条 —— 同时要去三份 `i18n/*.ts` 的
 * `portals` 里各加一条文案（漏了就是编译错误，不会静默出个 undefined）。
 * 图库同时在顶栏与这里 —— 归档、标签本来也是「页脚 + 首页」两处，不是新模式。
 *
 * 最后那一项的 `href` 是根路径：R14 阶段⑥ 之后那道门就在 `/`。
 */
export const PORTALS = [
  { key: 'archive', href: '/archive' },
  { key: 'tags', href: '/tags' },
  { key: 'photos', href: '/photos' },
  { key: 'portal', href: '/' },
] as const;

/**
 * 联系名片。R26 填入真实账号（此前六轮一直是空骨架）。
 * 规则没变：**填了才渲染，空的整项不出现**，所以留空就是下线一张卡。
 *
 * 六个平台能做到的事差得很远，卡片上的按钮也就不一样（能力核实见 R7 台账）：
 * - QQ：**网页版临时会话已经被腾讯关掉**（R41④ 实测）。原来这里写的是「唯一真能一键弹出
 *   加好友页的平台」，那条 `wpa.qq.com/msgrd` 现在 302 到企点的 wpa-link 页并显示
 *   「抱歉，无法发起临时会话」。改成唤起本机 QQ 的加好友入口（桌面 `tencent://AddContact`、
 *   手机 `mqqapi://card/show_pslcard`，拼法见 about.astro 那张卡的注释），
 *   **它们不保证有反应** —— 所以真正稳的那条是复制号码。
 *   `qqQr` 仍是空的（他没给 QQ 码）；给了的话这张卡就和微信一样有第三条腿了。
 * - 微信：**没有可用的加好友链接**。官方 URL Scheme 文档只覆盖小程序且限非个人主体，
 *   网上流传的个人加好友链接未能核实。只能出示二维码。
 *   `wechat` 填的是**昵称不是微信号**（他给的名片图上只有昵称）—— 微信搜昵称经常搜不到，
 *   所以卡片文案必须说清「扫码最稳」，别让复制按钮许下做不到的承诺。
 * - 抖音：**没有加好友链接**，只有主页地址，而他给的是 APP 里的二维码图（没给主页链接），
 *   所以 `douyin` 仍是空的、不出「打开主页」按钮；`douyinId` 是二维码图上印的抖音号，
 *   访客复制它去 APP 里搜是第二条路。
 * - Telegram：`t.me/<用户名>` 是官方公开链接，点开直接进对话框 —— 这是第二个真能一键的平台。
 * - Discord：**没有按用户名加好友的链接**。`discord.com/users/<id>` 要的是纯数字 ID，
 *   不是用户名，所以这张卡只能复制用户名，不给按钮。
 * - 邮箱：`mailto:` 谁都能点，也是唯一不依赖任何 APP 的一条。
 *
 * 二维码图片放 `public/contact/` 下，这里填站内绝对路径。三张都是 1024×1024 无损 webp、
 * **背景透明**，合计 12KB。图只提供形状：about 页把它当 CSS `mask` 用，颜色由 `--ink` 给，
 * 所以码跟着主题走（深色主题亮模块、浅色主题墨模块），模块之间是真透明。
 * **这三张不是平台给的原图**：微信与 Telegram 是解出 payload 后本站自己重画的 QR
 * （所以没有平台边框、没有头像、没有那行大写用户名）；抖音码不是 QR、重画不了，
 * 只把位图裁圆后二值化，**比例一点没动**，但重新取了框（环占画面 71% → 94%，
 * 同一个显示尺寸下线宽涨三成）—— 沉麟实测抖音那张扫不出，圆形码的短线本来就比 QR 的
 * 方块细。它也是唯一一张**加纸底**的（`paper: true`，缩略图与放大后都加）：
 * 实测非白底扫不出，私有解码器不吃反相码。配方与回读校验记在台账 R26。
 * 名片上只显示 140px 缩略图，点开才是原图（R26 的「点击展示」）。
 */
export const CONTACT = {
  qq: '2822994119',
  qqQr: '',
  telegram: 'duchenlin123', // 不带 @，链接与显示各自拼
  telegramQr: '/contact/telegram-qr.webp',
  wechat: '沉麟', // 昵称，不是微信号
  wechatQr: '/contact/wechat-qr.webp',
  douyin: '', // 主页链接仍然没有，见上
  douyinId: 'zhangyuaichi81',
  douyinQr: '/contact/douyin-qr.webp',
  discord: 'chenlin111',
  email: 'duchenlin321@gmail.com',
} as const;

/**
 * 留空的项会自动不显示，按需填写。
 * `email` 与 `CONTACT.email` 是同一个地址的两个出口：这里管页脚与首页那排小链接，
 * `CONTACT` 管关于页的名片。关于页的「别处」会把邮箱滤掉，避免同一页出现两次。
 */
export const SOCIAL = {
  github: 'https://github.com/DUEDCL',
  email: 'duchenlin321@gmail.com',
  x: '',
  weibo: '',
  zhihu: '',
  rss: '/rss.xml',
} as const;

/* 各内容区的元信息（标签、标题、介绍、页脚小字、空状态）搬去了 `src/i18n/*.ts`
   的 `sections`，三种语言各一份 —— 那五句话全是给访客看的字。
   `description` 与 `note` 的分工、以及摄影那条 empty 为什么和别的四条不一样，
   都跟着搬到了 `i18n/zh.ts` 对应位置。 */

