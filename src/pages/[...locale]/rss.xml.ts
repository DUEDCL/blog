import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { getListItems } from '../../utils/content';
import { SITE_TITLE } from '../../consts';
import { LOCALE_PARAMS, t, toLocale } from '../../i18n';

/**
 * 三份订阅源（R46）：`/rss.xml`（中文，地址没变）、`/en/rss.xml`、`/ja/rss.xml`。
 *
 * 为什么分三份而不是一份带 `xml:lang` 的混合源：阅读器按源订阅，一个只读英文的人
 * 订了混合源会收到三倍的条目、其中两份看不懂。三份各自只出自己那种语言的标题与摘要，
 * `<language>` 也各自对。
 *
 * 条目链接带语言前缀 —— `getListItems()` 给出来的 `href` 已经是带前缀的了。
 */
export function getStaticPaths() {
  return LOCALE_PARAMS.map((params) => ({ params }));
}

/** 文章与随笔合并进一个订阅源，按时间倒序 */
export const GET: APIRoute = async (context) => {
  const locale = toLocale(context.params.locale as string | undefined);
  const strings = t(locale);

  const items = [
    ...(await getListItems('posts', locale)),
    ...(await getListItems('notes', locale)),
  ].sort((a, b) => b.pubDate.valueOf() - a.pubDate.valueOf());

  return rss({
    title: SITE_TITLE,
    description: strings.siteDescription,
    site: context.site!,
    customData: `<language>${strings.rssLanguage}</language>`,
    items: items.map((entry) => ({
      title: entry.title,
      description: entry.description,
      pubDate: entry.pubDate,
      /* `href` 已带语言前缀。补一个尾斜杠与站上的真实地址对齐 */
      link: `${entry.href}/`,
      categories: entry.data.tags,
    })),
  });
};
