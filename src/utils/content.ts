import { getCollection, type CollectionEntry } from 'astro:content';
import { HIDDEN_SECTIONS } from '../consts';

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

/** 带标签的栏目，摄影没有 tags 字段 */
const TAGGED_SECTIONS = ['posts', 'notes', 'projects'] as const;

/**
 * 标签在标签页里的锚点 id。空白必须换掉 —— HTML 的 id 不允许含空白字符，
 * `Cloudflare Workers` 直接当 id 会让锚点失效（踩过）。中文可以原样用。
 */
export function tagAnchor(tag: string) {
  return `tag-${tag.trim().replace(/\s+/g, '-')}`;
}

/** 某个标签在标签页里的地址。格式只写在这一处，标签页与三处标签链接共用 */
export function tagHref(tag: string) {
  return `/tags#${encodeURIComponent(tagAnchor(tag))}`;
}

/** 全站标签统计。同一标签在不同栏目里的次数会合并 */
export async function getAllTagCounts() {
  const counts = new Map<string, number>();

  for (const section of TAGGED_SECTIONS) {
    for (const { tag, count } of await getTagCounts(section)) {
      counts.set(tag, (counts.get(tag) ?? 0) + count);
    }
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'));
}

/** 按标签取全站条目，用于标签页展开 */
export async function getEntriesByTag(tag: string) {
  const all = await getAllEntries();
  return all.filter((e) => e.tags.includes(tag));
}

/** 归档／统计用的统一条目形状，把四个栏目的差异拍平 */
export type FlatEntry = {
  href: string;
  title: string;
  description?: string;
  pubDate: Date;
  tags: string[];
  section: Section;
  sectionLabel: string;
};

const SECTION_LABEL: Record<Section, string> = {
  posts: '文章',
  notes: '随笔',
  photos: '摄影',
  projects: '作品',
};

/** 四个栏目合成一条时间线，按时间倒序。HIDDEN_SECTIONS 里的栏目不进索引 */
export async function getAllEntries(): Promise<FlatEntry[]> {
  const sections: Section[] = (
    ['posts', 'notes', 'photos', 'projects'] as Section[]
  ).filter((s) => !(HIDDEN_SECTIONS as readonly string[]).includes(s));
  const out: FlatEntry[] = [];

  for (const section of sections) {
    for (const item of await getPublished(section)) {
      const data = item.data as any;
      out.push({
        href: `/${section}/${item.id}`,
        title: data.title,
        description: data.description,
        pubDate: data.pubDate,
        tags: data.tags ?? [],
        section,
        sectionLabel: SECTION_LABEL[section],
      });
    }
  }

  return out.sort((a, b) => b.pubDate.valueOf() - a.pubDate.valueOf());
}

/** 按年份分组的时间线，年份从新到旧 */
export async function getEntriesByYear() {
  const groups = new Map<number, FlatEntry[]>();

  for (const entry of await getAllEntries()) {
    const year = entry.pubDate.getFullYear();
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year)!.push(entry);
  }

  return [...groups.entries()]
    .map(([year, entries]) => ({ year, entries }))
    .sort((a, b) => b.year - a.year);
}
