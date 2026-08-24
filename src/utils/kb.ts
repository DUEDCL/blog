/**
 * 知识库的读取与排序。三个消费者共用：`/kb.json`（喂给 Worker 里的 AI）、
 * `/llms.txt`（喂给别人的 AI）、以及将来监管页里的「一键存成 kb 条目」。
 *
 * **为什么 Worker 不直接读 `src/content/kb/`**：`astro:content` 只在 Astro 构建期存在，
 * `src/worker.ts` 是 wrangler 单独打包的，import 不到它。所以走这条路 ——
 * 构建时把 24 条烙成一张静态 `/kb.json`，Worker 用 `env.ASSETS.fetch('/kb.json')` 取。
 * 好处是知识库仍然只有一个来源（那些 .md 文件），不需要生成脚本、不需要第二份拷贝。
 */
import { getCollection } from 'astro:content';

export type KbItem = {
  /** 主问题 */
  q: string;
  /** 同一件事的其他问法，检索靠它们提高命中 */
  aliases: string[];
  /** 分类 */
  topic: string;
  /** 答案正文（Markdown 原文，第一人称） */
  a: string;
};

/**
 * 输出顺序。「我」排最前是给模型定坐标系用的：它先读到这个人是谁，
 * 后面那些关于站的技术条目才有归属。
 */
const TOPIC_ORDER = ['我', '这个站', '关于这个 AI'] as const;

const rank = (topic: string) => {
  const i = (TOPIC_ORDER as readonly string[]).indexOf(topic);
  return i < 0 ? TOPIC_ORDER.length : i;
};

/** 已定稿的知识库条目。`draft: true` 的一律不出去 —— 那是「还没定稿」的意思 */
export async function getKb(): Promise<KbItem[]> {
  const entries = await getCollection('kb', ({ data }) => data.draft !== true);

  return entries
    .map((e) => ({
      q: e.data.question,
      aliases: e.data.aliases ?? [],
      topic: e.data.topic ?? '',
      a: (e.body ?? '').trim(),
    }))
    .sort((a, b) => rank(a.topic) - rank(b.topic) || a.q.localeCompare(b.q, 'zh-CN'));
}
