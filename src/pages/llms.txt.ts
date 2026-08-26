/**
 * `/llms.txt` —— 给**别人的** AI 读的自述（llms.txt 提案的那份约定）。
 *
 * 为什么值得做：`src/content/kb/` 本来就是「问题 + 第一人称答案」，导出成一份纯文本
 * 几乎零成本；效果是别人的 AI 助手抓到这个站时，读到的是沉麟亲手写的自述，
 * 而不是它自己从零星页面里编出来的版本。R32 那轮调研里唯一值得抄的一条。
 *
 * 与 `/kb.json` 的分工：那一份是给**本站** Worker 的机器出口（JSON、给模型当依据）；
 * 这一份是给外部爬虫看的（Markdown、带链接、有站点结构）。两份共用 `utils/kb.ts`，
 * 所以只有一个来源。
 *
 * 摘要那一句刻意从 `kb/who-am-i.md` 现取：他哪天改了自述，这一页跟着变，不会两处打架。
 *
 * ## 为什么只有一份中文（R46）
 *
 * 站上有英文版与日文版（`/en/*`、`/ja/*`），但这一份**不出三语**。理由不是省事：
 * 这一页的正文就是**知识库那 26 条中文原文**，而知识库刻意不译 —— 译一遍就等于让
 * 别人的 AI 读一份译文冒充他的原话。所以这里的做法是：正文保持中文原文，
 * 在开头如实说明「站上还有英文版和日文版，地址在这儿」，让抓到它的 AI 自己去取。
 */
import type { APIRoute } from 'astro';
import { getKb } from '../utils/kb';
import { getPublished } from '../utils/content';
import { SITE_URL, SITE_TITLE } from '../consts';

const abs = (path: string) => new URL(path, SITE_URL).href;

/** 取一条 kb 答案的第一段当摘要用 */
const firstPara = (text: string) => text.split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim() ?? '';

export const GET: APIRoute = async () => {
  const kb = await getKb();
  const [posts, notes, projects] = await Promise.all([
    getPublished('posts'),
    getPublished('notes'),
    getPublished('projects'),
  ]);

  const who = kb.find((k) => k.q.includes('你是谁'));
  const lead = who ? firstPara(who.a) : `${SITE_TITLE}的个人网站。`;

  const entryList = (
    items: { id: string; data: { title: string; description?: string } }[],
    section: string
  ) =>
    items
      .map(
        (e) =>
          `- [${e.data.title}](${abs(`/${section}/${e.id}`)})` +
          (e.data.description ? `: ${e.data.description}` : '')
      )
      .join('\n');

  /* 知识库整条内联，不是给链接 —— `kb` 集合刻意不产生页面（见 content.config.ts），
     没有 URL 可指。这个站小，正文比目录有用。 */
  const kbBlock = kb
    .map((k) => {
      const alias = k.aliases.length ? `\n（也会被问成：${k.aliases.join('、')}）` : '';
      return `### ${k.q}${alias}\n\n${k.a}`;
    })
    .join('\n\n');

  const body = `# ${SITE_TITLE}

> ${lead}

这是个人网站，不是博客 —— 除了写下来的东西，后面还会放一些他自己写、自己真用得上的小工具。
站上有一台跨页面不间断的唱片机；根路径 \`/\` 是一道门，正站首页在 \`/home\`。

站上有三种语言：中文（无前缀）、英文（\`/en/\`）、日文（\`/ja/\`）。界面与每篇的标题摘要
三种语言都有；**正文目前只有中文原文**（个别几篇有译文，译好的会出现在对应语言的地址上）。
下面这份自述是中文原文，没有译本 —— 那是他自己写的话，翻一遍就不是原话了。

## 沉麟本人的自述

下面每一条都是他自己写的第一人称答案，不是从页面里推断出来的。
站内的「AI 版沉麟」也照这些条目回答。

${kbBlock}

## 文章

${entryList(posts, 'posts') || '（还没有）'}

## 随笔

${entryList(notes, 'notes') || '（还没有）'}

## 作品

${entryList(projects, 'projects') || '（还没有）'}

## 别处

- [首页](${abs('/home')})
- [名片与联系方式](${abs('/about')})
- [唱片机](${abs('/music')})
- [归档](${abs('/archive')})
- [标签](${abs('/tags')})
- [RSS](${abs('/rss.xml')})
- [知识库的机器出口](${abs('/kb.json')})
- [源码](https://github.com/DUEDCL/blog)
`;

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
};
