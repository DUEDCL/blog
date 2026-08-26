import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/**
 * 一条内容的**元数据译文**（R46）。
 *
 * 只管标题与摘要 —— 也就是列表页、归档、`<title>`、社交卡片会用到的那两样。
 * 正文的译文不在 frontmatter 里，它是独立的 `translations` 集合（见文件末尾）：
 * frontmatter 里塞一整篇文章会让原文那份 .md 变得没法读。
 *
 * **关键词刻意不在这里**。标签是索引键，一个键在三种语言下必须是同一个键，
 * 否则同一个概念会在英文标签页上分裂成两条。所以标签**原文进索引、显示时查译名**，
 * 译名表集中在 `i18n/*.ts` 的 `tagNames` 里 —— 一个标签只有一处译名，
 * 不会因为两篇文章各译一遍而对不上。
 *
 * 两条都是可选的：**没译就回落中文原文**，页面照旧能出，只是那一栏是中文。
 * 这是刻意的 —— 「先把架子搭起来，译文一篇篇填」比「等全译完才上线」更接近现实。
 * 回落发生在 `utils/content.ts` 的 `localized()` 里，只有那一处。
 */
const localizedMeta = z.object({
  title: z.string(),
  description: z.string().optional(),
});

const i18nMeta = z
  .object({
    en: localizedMeta.optional(),
    ja: localizedMeta.optional(),
  })
  .optional();

/** 文章与随笔共用的字段 */
const writingSchema = ({ image }: { image: () => any }) =>
  z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    cover: image().optional(),
    coverAlt: z.string().optional(),
    /** true 时不出现在列表页，也不会被构建成页面 */
    draft: z.boolean().default(false),
    i18n: i18nMeta,
  });

const posts = defineCollection({
  loader: glob({ base: './src/content/posts', pattern: '**/*.{md,mdx}' }),
  schema: writingSchema,
});

const notes = defineCollection({
  loader: glob({ base: './src/content/notes', pattern: '**/*.{md,mdx}' }),
  schema: writingSchema,
});

const photos = defineCollection({
  loader: glob({ base: './src/content/photos', pattern: '**/*.{md,mdx}' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string().optional(),
      pubDate: z.coerce.date(),
      location: z.string().optional(),
      /** 封面必填：相册网格靠它撑起版面 */
      cover: image(),
      coverAlt: z.string(),
      /** 组图。空数组时该组只显示封面 */
      images: z
        .array(
          z.object({
            src: image(),
            alt: z.string(),
            caption: z.string().optional(),
          })
        )
        .default([]),
      draft: z.boolean().default(false),
      i18n: i18nMeta,
    }),
});

const projects = defineCollection({
  loader: glob({ base: './src/content/projects', pattern: '**/*.{md,mdx}' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      pubDate: z.coerce.date(),
      tags: z.array(z.string()).default([]),
      cover: image().optional(),
      coverAlt: z.string().optional(),
      /** 线上地址与仓库地址，填了才显示对应链接 */
      link: z.string().url().optional(),
      repo: z.string().url().optional(),
      status: z.enum(['active', 'wip', 'archived']).default('active'),
      /** true 时出现在首页精选 */
      featured: z.boolean().default(false),
      draft: z.boolean().default(false),
      i18n: i18nMeta,
    }),
});

/**
 * AI 版沉麟的知识库（R6 阶段①）。一条一个问答，Markdown 正文就是答案，
 * 用第一人称写 —— 检索命中后正文会原样喂给模型当作回答依据，写的时候
 * 就当是在直接回答访客。
 *
 * 这个集合刻意**不生成任何页面**，也不进归档与标签索引：
 * `utils/content.ts` 的 Section 与 getAllEntries() 都是硬编码的四个栏目，
 * 加进来不会自动漏出去。知识库是喂给模型的原料，不是站上的内容。
 */
const kb = defineCollection({
  loader: glob({ base: './src/content/kb', pattern: '**/*.md' }),
  schema: z.object({
    /** 主问题。按访客真会怎么问来写，不要写成文章标题 */
    question: z.string(),
    /**
     * 同一件事的其他问法。检索靠语义相似度，问法给得越多命中越稳 ——
     * 「你用什么写代码」和「你的编辑器是啥」在向量空间里不一定挨着。
     */
    aliases: z.array(z.string()).default([]),
    /** 分类，给人自己整理用，不参与检索 */
    topic: z.string().optional(),
    /** true 表示这条还没定稿，不进知识库 */
    draft: z.boolean().default(false),
  }),
});

/**
 * 正文的译文（R46）。**一个文件一篇译文**，路径就是它的身份：
 *
 *   src/content/i18n/en/posts/astro-personal-site.md   → 那篇文章的英文正文
 *   src/content/i18n/ja/projects/vox.md                → 那个作品的日文正文
 *
 * 也就是 `entry.id` 天然是 `<语言>/<栏目>/<slug>`，详情页照这个键去找（`utils/content.ts`
 * 的 `translationOf()`）。**找不到就渲染中文原文**，并在标题下挂一条
 * 「这篇只有中文原文」的提示 —— 不假装有译文，也不因为没译就让页面 404。
 *
 * 为什么不做成 `posts/foo.en.md` 那种同目录后缀：那样译文会被 `posts` 集合自己的
 * glob（`**\/*.md`）收进去，于是列表页、归档、标签、RSS 里全都会多出一条重复的条目，
 * 得在每一处加过滤。单独一个集合，四个索引面一行都不用改。
 *
 * frontmatter 全是可选的：标题与摘要通常已经写在原文的 `i18n:` 段里，这边只写正文。
 * 两处都写了时**这边优先** —— 离正文最近的那份最可能是最新的。
 */
const translations = defineCollection({
  loader: glob({ base: './src/content/i18n', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    /** true 表示这份译文还没定稿，当作不存在（于是页面回落中文原文） */
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts, notes, photos, projects, kb, translations };
