---
title: duchenlin.top
description: 这个站本身。Astro 静态站，Markdown 写作，一条命令部署，全站不依赖境外 CDN；站上还有个照我的知识库回答的 AI 分身。
pubDate: 2026-08-16
tags: ['Astro', 'Cloudflare Workers']
link: 'https://duchenlin.top'
repo: 'https://github.com/DUEDCL/blog'
status: 'active'
featured: true
# 元数据的译文（R46）。正文仍是中文原文，详情页会在标题下挂一条说明 ——
# 正文也译好之后放到 src/content/i18n/<语言>/<栏目>/ 下，那时这一段可以留着，
# 两处都有时以译文文件里的为准（见 content.config.ts 的注释）。
i18n:
  en:
    title: "duchenlin.top"
    description: "This site itself. A static Astro site, written in Markdown, deployed with one command, with no dependency on any CDN outside China; it also carries a double of me that answers from my own knowledge base."
  ja:
    title: "duchenlin.top"
    description: "このサイトそのもの。Astro の静的サイト、Markdown で書き、コマンド一つで配備、国外 CDN に一切依存しない。私の知識ベースから答える分身も載っている。"
---

我的个人站点，也是第一个上线的东西。

## 做了什么

四个内容栏目：技术文章、随笔、摄影、作品。每类内容有各自的字段约束和排版 —— 文章走窄栏长阅读，摄影走宽幅网格，两者不共用一套布局。

站上还有个 AI 版的我。我把自己的答案一条条写成 Markdown 放进仓库（现在 26 条），访客提问时先检索相关条目，再照着条目回答。它会说清自己是程序不是我本人，也会说清哪一条我没说过。

另外两个不算栏目的东西：跨页不断的唱片机，和一个自己用的后台。

## 技术选择

- Astro：零客户端 JS 的静态站生成器，内容站的最优解。
- 内容集合 + Zod：frontmatter 字段在构建期校验，写错立刻报错而不是上线后看到空白。
- 构建期图片处理：自动压缩、转 WebP、生成多尺寸 srcset。
- Cloudflare Workers 静态资源：一条命令部署，免费额度对个人站远远够用。

## 刻意做的取舍

不引任何境外 CDN 资源。中文字体走系统字体栈，西文字体随构建产物分发。原因是站点托管在境外，每一个额外的跨境请求都会拖慢首屏 —— 请求数比字节数更致命。

## 待办

- [ ] 全文搜索（文章超过五十篇再说）
- [ ] 摄影栏目的 EXIF 展示
- [ ] 评论（还没想清楚要不要）
