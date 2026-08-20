import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

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

export const collections = { posts, notes, photos, projects, kb };
