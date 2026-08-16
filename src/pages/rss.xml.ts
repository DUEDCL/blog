import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { getPublished } from '../utils/content';
import { SITE_TITLE, SITE_DESCRIPTION } from '../consts';

/** 文章与随笔合并进一个订阅源，按时间倒序 */
export const GET: APIRoute = async (context) => {
  const posts = await getPublished('posts');
  const notes = await getPublished('notes');

  const items = [
    ...posts.map((p) => ({ entry: p, base: '/posts' })),
    ...notes.map((n) => ({ entry: n, base: '/notes' })),
  ].sort(
    (a, b) => b.entry.data.pubDate.valueOf() - a.entry.data.pubDate.valueOf()
  );

  return rss({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    site: context.site!,
    customData: '<language>zh-CN</language>',
    items: items.map(({ entry, base }) => ({
      title: entry.data.title,
      description: entry.data.description,
      pubDate: entry.data.pubDate,
      link: `${base}/${entry.id}/`,
      categories: entry.data.tags,
    })),
  });
};
