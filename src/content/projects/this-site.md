---
title: duchenlin.top
description: 这个站本身。Astro 静态站，Markdown 写作，一条命令部署，全站不依赖境外 CDN。
pubDate: 2026-08-16
tags: ['Astro', 'Cloudflare Workers']
link: 'https://duchenlin.top'
repo: 'https://github.com/DUEDCL/duchenlin-blog'
status: 'active'
featured: true
---

我的个人站点，也是第一个作品条目。

## 做了什么

四个内容栏目：技术文章、随笔、摄影、作品。每类内容有各自的字段约束和排版 —— 文章走窄栏长阅读，摄影走宽幅网格，两者不共用一套布局。

## 技术选择

- **Astro**：零客户端 JS 的静态站生成器，内容站的最优解。
- **内容集合 + Zod**：frontmatter 字段在构建期校验，写错立刻报错而不是上线后看到空白。
- **构建期图片处理**：自动压缩、转 WebP、生成多尺寸 srcset。
- **Cloudflare Workers 静态资源**：一条命令部署，免费额度对个人站远远够用。

## 刻意做的取舍

不引任何境外 CDN 资源。中文字体走系统字体栈，西文字体随构建产物分发。原因是站点托管在境外，每一个额外的跨境请求都会拖慢首屏 —— 请求数比字节数更致命。

## 待办

- [ ] 全文搜索（文章超过五十篇再说）
- [ ] 摄影栏目的 EXIF 展示
- [ ] 评论（还没想清楚要不要）
