import { getCollection, type CollectionEntry } from 'astro:content';
import { HIDDEN_SECTIONS } from '../consts';
import { DEFAULT_LOCALE, localePath, t, type Locale } from '../i18n';

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

/* ==========================================================================
   多语言（R46）
   ========================================================================== */

/**
 * 一条内容在某种语言下的标题与摘要。**全站取这两样只走这一处** ——
 * 回落规则集中在这里，页面不许自己写 `entry.data.i18n?.en?.title ?? …`。
 *
 * 回落顺序：译文集合的 frontmatter → 原文的 `i18n.<语言>` 段 → 中文原文。
 * 译文集合排在前面的理由见 `content.config.ts` 里 `translations` 的注释
 * （离正文最近的那份最可能是最新的）。
 */
export function localized(
  data: { title: string; description?: string; i18n?: any },
  locale: Locale,
  translation?: CollectionEntry<'translations'>
): { title: string; description?: string } {
  if (locale === DEFAULT_LOCALE) return { title: data.title, description: data.description };
  const meta = data.i18n?.[locale];
  return {
    title: translation?.data.title ?? meta?.title ?? data.title,
    description:
      translation?.data.description ?? meta?.description ?? data.description,
  };
}

/** 译文集合的索引。`entry.id` 是 `<语言>/<栏目>/<slug>`，一次读完存着 */
let transCache: Map<string, CollectionEntry<'translations'>> | null = null;

async function transMap() {
  if (!transCache) {
    const items = await getCollection('translations', ({ data }) =>
      import.meta.env.DEV ? true : data.draft !== true
    );
    transCache = new Map(items.map((e) => [e.id, e]));
  }
  return transCache;
}

/**
 * 找某条内容在某种语言下的正文译文。**没有就返回 undefined** ——
 * 详情页照旧渲染中文原文，只是标题下多一条「这篇只有中文原文」。
 */
export async function translationOf(
  section: Section,
  slug: string,
  locale: Locale
): Promise<CollectionEntry<'translations'> | undefined> {
  if (locale === DEFAULT_LOCALE) return undefined;
  return (await transMap()).get(`${locale}/${section}/${slug}`);
}

/** 标签的显示名。查不到就原样返回 —— 技术名不进译名表，那是设计（见 i18n/types.ts） */
export function tagName(tag: string, locale: Locale) {
  return t(locale).tagNames[tag] ?? tag;
}

/**
 * 某个栏目的列表项：**地址已带语言前缀、标题与摘要已按语言回落**。
 * 列表页、首页头版、作品索引都用它 —— 这三处从前各自 `entry.data.title` 一次，
 * 多语言之后那就是三处各写一遍回落规则。
 *
 * `data` 原样带出来，是因为调用方还要取各自关心的字段（首页要 `featured`、
 * 作品页要 `status`/`link`/`repo`、摄影要 `cover`）。这个函数不去猜它们。
 */
export async function getListItems<T extends Section>(
  section: T,
  locale: Locale = DEFAULT_LOCALE
) {
  const items = await getPublished(section);
  return Promise.all(
    items.map(async (item) => {
      const data = item.data as any;
      const meta = localized(
        data,
        locale,
        await translationOf(section, item.id, locale)
      );
      return {
        id: item.id,
        href: localePath(locale, `/${section}/${item.id}`),
        title: meta.title,
        description: meta.description,
        pubDate: data.pubDate as Date,
        data,
      };
    })
  );
}

/* ========================================================================== */

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
 *
 * **锚点用的是标签原文，三种语言下逐字相同**：英文页上显示的是 `Architecture`，
 * 锚点仍然是 `tag-架构`。这样从任何语言的文章页点关键词，落到的都是同一段，
 * 换语言时 `switchPath()` 生成的地址也仍然指向同一个锚。
 */
export function tagAnchor(tag: string) {
  return `tag-${tag.trim().replace(/\s+/g, '-')}`;
}

/** 某个标签在标签页里的地址。格式只写在这一处，标签页与三处标签链接共用 */
export function tagHref(tag: string, locale: Locale = DEFAULT_LOCALE) {
  return `${localePath(locale, '/tags')}#${encodeURIComponent(tagAnchor(tag))}`;
}

/** 全站标签统计。同一标签在不同栏目里的次数会合并 */
export async function getAllTagCounts(locale: Locale = DEFAULT_LOCALE) {
  const counts = new Map<string, number>();

  for (const section of TAGGED_SECTIONS) {
    for (const { tag, count } of await getTagCounts(section)) {
      counts.set(tag, (counts.get(tag) ?? 0) + count);
    }
  }

  /* 同频次时按**显示名**排 —— 英文页上按中文拼音排看起来是随机的。
     频次这一维仍然优先，所以三种语言的大致顺序是一致的 */
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count, name: tagName(tag, locale) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, locale));
}

/** 按标签取全站条目，用于标签页展开 */
export async function getEntriesByTag(tag: string, locale: Locale = DEFAULT_LOCALE) {
  const all = await getAllEntries(locale);
  return all.filter((e) => e.tags.includes(tag));
}

/** 归档／统计用的统一条目形状，把四个栏目的差异拍平 */
export type FlatEntry = {
  href: string;
  title: string;
  description?: string;
  pubDate: Date;
  /** 标签原文。显示时过 `tagName()` */
  tags: string[];
  section: Section;
  sectionLabel: string;
};

/**
 * 四个栏目合成一条时间线，按时间倒序。HIDDEN_SECTIONS 里的栏目不进索引。
 * `href` 带语言前缀、`title` 与 `description` 已经按语言回落过 —— 调用方直接用。
 */
export async function getAllEntries(
  locale: Locale = DEFAULT_LOCALE
): Promise<FlatEntry[]> {
  const sections: Section[] = (
    ['posts', 'notes', 'photos', 'projects'] as Section[]
  ).filter((s) => !(HIDDEN_SECTIONS as readonly string[]).includes(s));
  const out: FlatEntry[] = [];
  const strings = t(locale);

  for (const section of sections) {
    for (const item of await getPublished(section)) {
      const data = item.data as any;
      const meta = localized(
        data,
        locale,
        await translationOf(section, item.id, locale)
      );
      out.push({
        href: localePath(locale, `/${section}/${item.id}`),
        title: meta.title,
        description: meta.description,
        pubDate: data.pubDate,
        tags: data.tags ?? [],
        section,
        sectionLabel: strings.sections[section].label,
      });
    }
  }

  return out.sort((a, b) => b.pubDate.valueOf() - a.pubDate.valueOf());
}

/** 按年份分组的时间线，年份从新到旧 */
export async function getEntriesByYear(locale: Locale = DEFAULT_LOCALE) {
  const groups = new Map<number, FlatEntry[]>();

  for (const entry of await getAllEntries(locale)) {
    const year = entry.pubDate.getFullYear();
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year)!.push(entry);
  }

  return [...groups.entries()]
    .map(([year, entries]) => ({ year, entries }))
    .sort((a, b) => b.year - a.year);
}
