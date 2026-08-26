/**
 * 构建期把 `src/content/` 下的原始 Markdown 打成一个 TS 模块，供 Worker 引入（R41②）。
 *
 * ## 为什么不做成一个 JSON 静态资源
 *
 * 后台的「文章编辑」与「图库管理」要读仓库里现有内容的**原文**。最省事的做法是让 Astro
 * 生成 `/admin-content.json`，Worker 用 `env.ASSETS.fetch` 去读 —— 点歌台的知识库
 * （`/kb.json`）就是这么做的。
 *
 * **但那条路会泄漏草稿。** `dist/` 里的每个文件都是公开可取的，`_headers` 只能加响应头、
 * 不能拦请求。而 `draft: true` 的条目恰恰是「他还没决定要不要公开」的东西 ——
 * 眼下 `notes/selective-truth.md` 就是他明确说了「发不发他定」的那一篇。
 * 把它的正文放进一个公开 URL，等于替他做了那个决定。
 *
 * 所以改成**编译进 Worker 包**：这个文件被 `src/worker.ts` 静态引入，
 * 由 esbuild 打进 Worker 的 bundle，**不是静态资源、没有 URL**，
 * 只能通过登录后的 `/api/admin/content` 读到。
 *
 * ## 刻意不解析 YAML
 *
 * frontmatter 原样当字符串存（`front` 字段）。两个理由：
 * 1. 本项目没有 YAML 依赖，为这一处引一个不值得；
 * 2. **写作工具里 frontmatter 就该是可编辑的文本** —— 解析再序列化会丢注释、
 *    改掉引号风格、把日期变成另一种写法。原样进、原样出，导出的 .md 与仓库里的一致。
 *
 * ## 生成的文件不进仓库
 *
 * `src/data/content.generated.ts` 在 `.gitignore` 里 —— 它是派生物，进仓库只会让
 * 每次改一篇文章都带出一个巨大的 diff。`npm run dev` 与 `npm run build` 都会先跑这个脚本，
 * 部署流程（`.claude/skills/deploy`）第一步就是 `npm run build`，所以线上不会缺。
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = join(ROOT, 'src', 'content');
const OUT = join(ROOT, 'src', 'data', 'content.generated.ts');

/**
 * 只收这几个集合 —— 与 `src/content.config.ts` 里 `collections` 的键一致。
 * `i18n` 是正文译文那一堆（R46，集合名 `translations`，目录名 `i18n`）：
 * 后台的「文章编辑」也该能改译文，所以它跟原文一起进这份索引。
 * 它的 `coll` 因此是 `i18n` 而不是 `translations` —— 这一列存的是**目录名**，
 * 后台照原样显示仓库里的真实路径。
 */
const COLLECTIONS = ['posts', 'notes', 'projects', 'photos', 'kb', 'i18n'];

/** 递归列出一个目录下的 Markdown。子目录也算（glob 的 pattern 是 `**\/*.md`） */
async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // 集合目录不存在就当空集合，不让构建失败
  }
  const out = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (/\.mdx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * 切开 frontmatter 与正文。**只认文件开头那一对 `---`**：
 * 正文里的分隔线（`---`）不能被当成 frontmatter 的结束，所以从第 4 个字符起找
 * 第一行独占的 `---`。没有 frontmatter 的文件整份都是正文。
 */
function split(raw) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { front: '', body: text.trim() };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { front: '', body: text.trim() };
  return {
    front: text.slice(4, end).trim(),
    body: text.slice(end + 4).replace(/^\n+/, '').trimEnd(),
  };
}

/** frontmatter 里挑一个顶层标量。给列表页显示用，解析不了就返回空串 —— 不猜 */
function field(front, key) {
  const m = front.match(new RegExp('^' + key + ':[ \\t]*(.*)$', 'm'));
  if (!m) return '';
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

const files = [];

for (const coll of COLLECTIONS) {
  for (const path of await walk(join(SRC, coll))) {
    const raw = await readFile(path, 'utf8');
    const { front, body } = split(raw);
    const rel = relative(join(SRC, coll), path).split(sep).join('/');
    files.push({
      coll,
      /** 与 Astro 的 entry.id 一致：去掉扩展名的相对路径 */
      slug: rel.replace(/\.mdx?$/, ''),
      /** 仓库里的真实位置，后台照原样显示给他，导出时也用这个路径 */
      path: 'src/content/' + coll + '/' + rel,
      title: field(front, 'title') || field(front, 'question') || rel,
      draft: field(front, 'draft') === 'true',
      pubDate: field(front, 'pubDate'),
      front,
      body,
    });
  }
}

files.sort((a, b) => (a.coll + a.slug < b.coll + b.slug ? -1 : 1));

const head = `/**
 * 自动生成，不要手改 —— 改了下一次 \`npm run build\` 就会被覆盖。
 * 生成脚本：\`scripts/gen-content.mjs\`（那里写了为什么它编译进 Worker 而不是做成 JSON）。
 * 生成时间：${new Date().toISOString()}
 */

/** 一个内容文件的原样快照。\`front\` 是 frontmatter 原文，没有被解析过 */
export interface ContentFile {
  coll: 'posts' | 'notes' | 'projects' | 'photos' | 'kb' | 'i18n';
  slug: string;
  path: string;
  title: string;
  draft: boolean;
  pubDate: string;
  front: string;
  body: string;
}

export const CONTENT: ContentFile[] = `;

await mkdir(join(ROOT, 'src', 'data'), { recursive: true });
await writeFile(OUT, head + JSON.stringify(files, null, 2) + ';\n', 'utf8');

const n = files.reduce((m, f) => ((m[f.coll] = (m[f.coll] ?? 0) + 1), m), {});
console.log(
  '内容索引：' +
    files.length +
    ' 个文件（' +
    Object.entries(n)
      .map(([k, v]) => k + ' ' + v)
      .join('、') +
    '）→ src/data/content.generated.ts'
);
