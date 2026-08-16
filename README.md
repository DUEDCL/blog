# duchenlin.eu.cc

个人站点。Astro 静态生成，Markdown 写作，推送到 GitHub 即自动部署。

## 常用命令

| 命令              | 作用                                  |
| :---------------- | :------------------------------------ |
| `npm install`     | 安装依赖（只需第一次，或换电脑后）    |
| `npm run dev`     | 本地预览，地址 http://localhost:4321  |
| `npm run build`   | 构建到 `dist/`，上线前自检用          |
| `npm run preview` | 预览构建产物，最接近线上效果          |

## 怎么写一篇新文章

在 `src/content/posts/` 下新建一个 `.md` 文件，文件名就是网址。例如
`src/content/posts/hello-world.md` → `https://duchenlin.eu.cc/posts/hello-world`。

文件顶部两条 `---` 之间的部分叫 frontmatter，是这篇文章的元信息：

```markdown
---
title: '文章标题'
description: '一句话摘要，会显示在列表页和搜索结果里'
pubDate: 2026-08-16
tags: ['标签一', '标签二']
draft: true
---

正文从这里开始，用 Markdown 写。
```

- `title`、`description`、`pubDate` 必填，漏了会在构建时立刻报错（而不是上线后才发现空白）。
- `draft: true` 表示草稿：本地能看见，构建上线时自动排除。写完删掉这一行，或改成 `false`。
- `updatedDate` 选填，填了会在文章里显示「修订于」。
- `cover: './图片名.jpg'` 选填，配图放在同目录下即可。

四个栏目对应四个目录，字段要求略有不同：

| 目录                    | 栏目     | 特殊字段                                        |
| :---------------------- | :------- | :---------------------------------------------- |
| `src/content/posts/`    | 技术文章 | 同上                                            |
| `src/content/notes/`    | 随笔     | 同上                                            |
| `src/content/photos/`   | 摄影     | `cover` 必填；`images` 数组放组图                |
| `src/content/projects/` | 作品集   | `status`（active/wip/archived）、`link`、`repo` |

摄影相册示例：

```markdown
---
title: 街头
description: 一句话说明
pubDate: 2026-08-16
cover: './01.jpg'
coverAlt: '图片描述，给读屏软件和搜索引擎看'
images:
  - src: './02.jpg'
    alt: '图片描述'
    caption: '图注，选填'
---
```

图片直接放进对应目录，构建时会自动压缩、转 WebP、生成多种尺寸，不用手动处理。

## 支持的写法

- **代码高亮**：三个反引号加语言名，如 ` ```python `。浅色/深色主题自动切换。
- **数学公式**：行内 `$E = mc^2$`，独立成行用 `$$...$$`。
- **表格、任务列表、脚注** 等标准 Markdown 语法。

## 发布流程

```bash
git add -A && git commit -m "post: 新文章标题" && git push
```

推送后 Cloudflare 自动构建，约一到两分钟上线。

## 需要你填的地方

`src/consts.ts` 里带 `TODO` 注释的项目——站名、简介、社交链接、页头印章的字。
`src/pages/about.astro` 里的「关于」正文也是占位文字。

## 技术说明

- 不引用任何境外 CDN 资源。西文字体（Fraunces / IBM Plex Mono）随构建产物分发，中文走系统字体栈，
  KaTeX 样式和字体自托管。站点托管在境外，请求数比字节数更影响首屏速度。
- `.nvmrc` 固定 Node 版本，避免构建环境默认版本变动导致线上构建失败。
- 深色模式读取系统偏好，手动切换后记在 `localStorage`，刷新不闪白。
