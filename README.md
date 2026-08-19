# duchenlin.top

个人站点。Astro 静态生成，Markdown 写作，本地一条命令部署到 Cloudflare Workers。

线上地址：<https://duchenlin.top>（备用 <https://duchenlin.eu.cc>，国内被墙，仅境外可达）

## 常用命令

| 命令              | 作用                                  |
| :---------------- | :------------------------------------ |
| `npm install`     | 安装依赖（只需第一次，或换电脑后）    |
| `npm run dev`     | 本地预览，地址 http://localhost:4321  |
| `npm run build`   | 构建到 `dist/`，上线前自检用          |
| `npm run preview` | 预览构建产物，最接近线上效果          |

## 怎么写一篇新文章

在 `src/content/posts/` 下新建一个 `.md` 文件，文件名就是网址。例如
`src/content/posts/hello-world.md` → `https://duchenlin.top/posts/hello-world`。

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

## 部署现状

已上线，托管在 Cloudflare Workers（静态资源模式，不是 Pages）。

| 项目            | 值                                              |
| :-------------- | :---------------------------------------------- |
| Worker 名       | `duchenlin-blog`                                |
| 绑定的域名      | `duchenlin.top`、`www.duchenlin.top`、`duchenlin.eu.cc` |
| 证书            | Cloudflare 自动签发，两个 zone 都已 Active      |
| Always Use HTTPS| 两个 zone 均已开启                              |

DNS 记录和 HTTPS 证书都由 `wrangler.toml` 里的 `[[routes]] custom_domain = true` 自动生成，
不需要手工加任何解析记录 —— 裸域按 DNS 规范不能用 CNAME，Cloudflare 用 CNAME 展平
（CNAME flattening）在内部解决了这个限制，前提是 DNS 必须托管在 Cloudflare。

### 再加一个域名

1. 在 Cloudflare 加站点（Free 套餐），记下它给出的**两台 NS**。
2. 到域名注册商把 NS 改成那两台。
3. 等状态变 Active，然后在 `wrangler.toml` 加一段 `[[routes]]` 并重新部署。

> **NS 是按 zone 随机分配的，两个域名拿到的不是同一对。** 照抄另一个域名的 NS 会导致
> 永远激活不了：那两台服务器上没有你这个 zone 的数据。踩过一次 —— `duchenlin.top` 填了
> `duchenlin.eu.cc` 的 `alfred`/`itzel`，而它自己分到的是 `gloria`/`watson`。
>
> 另外：任何一个 `[[routes]]` 对应的 zone 还是 pending，**整个 `wrangler deploy` 都会失败**，
> 不是只跳过那一条。

### 关于 `duchenlin.eu.cc`

留着当第二入口，但国内访问不了 —— 有中间设备按主机名字符串匹配注入 TCP RST，换 IP、
换端口、换子域名都绕不过（判据是主机名本身）。境外可以正常访问。主域用 `duchenlin.top`。

## 发布流程

改完内容后本地跑一条命令：

```bash
npx wrangler deploy
```

它会先读 `dist/`，所以要先 `npm run build`（或者用 `npm run build && npx wrangler deploy`）。
部署需要 `CLOUDFLARE_API_TOKEN` 环境变量，或者 `npx wrangler login` 交互授权。

GitHub 自动构建（Workers Builds）**还没接上** —— 仓库推送当时被网络挡住了。想接的话在
Cloudflare 里进 **Workers & Pages** → 选 `duchenlin-blog` → **Settings** → **Builds** →
连接 `DUEDCL/duchenlin-blog`，构建命令 `npm run build`，部署命令 `npx wrangler deploy`。
接上之后就变成推送即部署。

## 需要你填的地方

`src/consts.ts` 里的社交链接目前只填了 GitHub，邮箱、X、微博、知乎留空（留空的不会渲染）。
`src/pages/about.astro` 里的「关于」正文是占位文字。
`src/content/photos/` 与 `src/content/projects/` 引用的配图是占位图，alt 文字写着「占位图，请替换」。

## 技术说明

- 不引用任何境外 CDN 资源。西文字体（Fraunces / IBM Plex Mono）随构建产物分发，中文走系统字体栈，
  KaTeX 样式和字体自托管。站点托管在境外，请求数比字节数更影响首屏速度。
- `.nvmrc` 固定 Node 版本，避免构建环境默认版本变动导致线上构建失败。
- 深色模式读取系统偏好，手动切换后记在 `localStorage`，刷新不闪白。
