import { getCollection, type CollectionEntry } from 'astro:content';

type Section = 'posts' | 'notes' | 'photos' | 'projects';

/**
 * 取某个栏目下已发布的条目，按时间倒序。
 * draft: true 的条目在 `npm run dev` 下可见、在构建产物中排除，
 * 这样草稿能本地预览但不会意外上线。
 */
export async function getPublished<T extends Section>(
  section: T
): Promise<CollectionEntry<T>[]> {
  const items = await getCollection(section, ({ data }: any) =>
    import.meta.env.DEV ? true : data.draft !== true
  );

  return items.sort(
    (a: any, b: any) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf()
  );
}

/** 汇总所有标签及出现次数，按频次降序 */
export async function getTagCounts(section: Section) {
  const items = await getPublished(section);
  const counts = new Map<string, number>();

  for (const item of items) {
    const tags = (item.data as any).tags ?? [];
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'));
}
