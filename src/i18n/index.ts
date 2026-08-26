/**
 * 多语言的路由与取词入口（R46）。
 *
 * ## 路由：默认语言不带前缀
 *
 * `/posts/foo` 是中文，`/en/posts/foo` 是英文，`/ja/posts/foo` 是日文。
 * 中文不带前缀这件事**不是审美选择，是硬约束** —— 站上现有的每个地址都可能已经
 * 被收录、被别处链接过（`astro.config.mjs` 里为 `/start` 留的那张跳转页就是同一条
 * 顾虑的产物）。给中文也加前缀等于一次性废掉全站所有旧链接。
 *
 * 实现靠 `src/pages/[...locale]/` 这一层目录：rest 参数取 `undefined` 时落在无前缀
 * 路径上，取 `'en'` / `'ja'` 时落在带前缀的路径上。**实测过**才敢这么用 ——
 * 一条路由里同时出现两个 rest 参数（`[...locale]/posts/[...slug]`）在 Astro 7.2.2
 * 上生成的是 `/posts/a/`、`/en/posts/a/`、`/ja/posts/a/b/`，三样都对。
 *
 * ## 语言切换必须整页刷新
 *
 * 全站走 SPA 导航（`ClientRouter`），而状态栏与对话框是 `transition:persist` 的 ——
 * 它们**不会**在 swap 时重新渲染。SPA 切语言的结果是页面换了语言、播放器和对话框
 * 还留着上一种语言的字。所以语言切换的那几条链接一律带 `data-astro-reload`。
 */
import type { Locale, Strings } from './types';
import { zh } from './zh';
import { en } from './en';
import { ja } from './ja';

export type { Locale, Strings, Section, NavKey, PortalKey, EditionId, ContactKey, SectionStrings } from './types';

/** 三种语言。顺序就是语言菜单里的顺序 */
export const LOCALES = ['zh', 'en', 'ja'] as const satisfies readonly Locale[];

/** 默认语言。它的页面不带路径前缀 */
export const DEFAULT_LOCALE: Locale = 'zh';

const TABLES: Record<Locale, Strings> = { zh, en, ja };

/** 取某种语言的词条表 */
export function t(locale: Locale): Strings {
  return TABLES[locale];
}

/**
 * `<html lang>` 与 hreflang 用的语言标签。
 * 中文写 `zh-CN` 而不是 `zh`：站上是简体，繁体读者的浏览器不该被当成命中。
 */
export const HTML_LANG: Record<Locale, string> = {
  zh: 'zh-CN',
  en: 'en',
  ja: 'ja',
};

/** Open Graph 的 locale（下划线，带地区） */
export const OG_LOCALE: Record<Locale, string> = {
  zh: 'zh_CN',
  en: 'en_US',
  ja: 'ja_JP',
};

/** `[...locale]` 的三种取值。所有页面的 getStaticPaths 都从这里出发 */
export const LOCALE_PARAMS: { locale: string | undefined }[] = [
  { locale: undefined },
  { locale: 'en' },
  { locale: 'ja' },
];

/** `Astro.params.locale` → Locale。缺省与不认识的值都算中文 */
export function toLocale(param?: string): Locale {
  return param === 'en' || param === 'ja' ? param : DEFAULT_LOCALE;
}

/**
 * 从路径上摘掉语言前缀，顺带认出是哪种语言。
 * 只看第一段，且必须整段相等 —— 一篇 slug 叫 `enigma` 的文章不能被认成英文。
 */
export function stripLocale(pathname: string): { locale: Locale; rest: string } {
  const m = /^\/(en|ja)(?=\/|$)/.exec(pathname);
  if (!m) return { locale: DEFAULT_LOCALE, rest: pathname || '/' };
  return { locale: m[1] as Locale, rest: pathname.slice(m[0].length) || '/' };
}

/** 当前页面是哪种语言。组件不必层层传 locale，各自从 `Astro.url.pathname` 认 */
export function localeOf(pathname: string): Locale {
  return stripLocale(pathname).locale;
}

/**
 * 给站内路径加上语言前缀。**所有站内链接都要过这一道** ——
 * 漏一个就是「点一下从英文页掉回中文页」。
 */
export function localePath(locale: Locale, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (locale === DEFAULT_LOCALE) return p;
  /* 门在 `/en/`：根路径加前缀之后如果写成 `/en`，canonical 与 sitemap 里会是
     一个「没有尾斜杠的目录」，Cloudflare 送出去之前还要补一次 301 */
  return p === '/' ? `/${locale}/` : `/${locale}${p}`;
}

/** 把当前地址换成另一种语言的同一页。语言切换器用 */
export function switchPath(pathname: string, to: Locale): string {
  return localePath(to, stripLocale(pathname).rest);
}

/**
 * 三条 hreflang + 一条 x-default，给 `<head>` 用。
 * `x-default` 指中文那份 —— 它是原文，也是唯一保证有正文的一份。
 */
export function alternates(pathname: string): { hreflang: string; path: string }[] {
  const { rest } = stripLocale(pathname);
  return [
    ...LOCALES.map((l) => ({ hreflang: HTML_LANG[l], path: localePath(l, rest) })),
    { hreflang: 'x-default', path: localePath(DEFAULT_LOCALE, rest) },
  ];
}

/**
 * 客户端脚本要用的那一小把文案。
 *
 * ## 为什么要有这么一层
 *
 * 播放器与点歌台的状态文字是**运行期**才写进 DOM 的（「正在取…」「这首没有歌词」
 * 「暂停」），而那些脚本是 bundled module —— 它们 `import` 不到当前页面的语言。
 * 三条路：
 *   ① 脚本里再抄一份三语词条 → 词条从此有两个来源，改一处忘一处；
 *   ② 脚本 import 整张词条表，按 `document.documentElement.lang` 挑 → 客户端
 *      bundle 里多带三份语言的全表（名片那六条 note、四套版次的参照物…… 全是
 *      运行期用不到的字）；
 *   ③ **服务端把当前语言这几条投影成一个纯字符串对象，序列化挂在 DOM 上**，
 *      脚本读一次。词条只有一个来源，bundle 里一个字都不多带。
 *
 * 这里是第 ③ 条。投影点只有一个：`MiniPlayer` 的根节点（它在**每一页**都渲染，
 * 包括不走 BaseLayout 的那道门），所以 `/music` 上那台唱盘台也读它，不另挂一份。
 *
 * ## 占位符
 *
 * 带参数的词条在这里就用 `{xxx}` 求值成模板串，脚本 `replace()` 掉。
 * 这几条的参数类型因此都得是 `string`（见 types.ts 里 `archive.hit` 那条注释）。
 */
export function clientStrings(locale: Locale) {
  const s = t(locale);
  return {
    play: s.player.play,
    pause: s.player.pause,
    collapse: s.player.collapse,
    expand: s.player.expand,
    /** 四档播放方式的名字。下标与 `scripts/jukebox.ts` 的 `MODES` 对应 */
    modes: s.music.modes,
    modeLabel: s.music.modeLabel('{mode}'),
    lyricsLoading: s.music.lyricsLoading,
    lyricsNone: s.music.lyricsNone,
    juke: {
      idle: s.music.juke.idle,
      needKeyword: s.music.juke.needKeyword,
      loading: s.music.juke.loading('{what}'),
      none: s.music.juke.none('{what}'),
      found: s.music.juke.found('{what}', '{n}'),
      offline: s.music.juke.offline,
      unavailable: s.music.juke.unavailable,
      partial: s.music.juke.partial,
      fetching: s.music.juke.fetching('{title}'),
      quoted: s.music.juke.quoted('{kw}'),
      chartFallback: s.music.juke.chartFallback,
      requested: s.music.juke.requested,
      failed: s.music.juke.failed,
    },
  };
}

/** `clientStrings()` 的形状。客户端那边照这个类型读，不用 any */
export type ClientStrings = ReturnType<typeof clientStrings>;
