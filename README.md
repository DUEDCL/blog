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

## 首次部署（只需做一次）

代码和 `wrangler.toml` 都已就绪，剩下四步需要你在浏览器里操作 —— 这几步涉及账号所有权和
域名注册商，命令行无法代做。**顺序不能颠倒**：第 4 步依赖域名在 Cloudflare 已生效。

**1. 把域名加进 Cloudflare**

登录 [dash.cloudflare.com](https://dash.cloudflare.com) → 右上 **Add** → **Existing domain** →
填 `duchenlin.eu.cc` → 选 **Free** 套餐。完成后 Cloudflare 会给你**两个域名服务器地址**，
形如 `xxx.ns.cloudflare.com`，记下它们。

**2. 在 julydns 换掉域名服务器**

回到 julydns 控制台，进**「DNS管理」**（不是「域名解析」），把原有的域名服务器改成上一步
拿到的那两个。

> 为什么必须换 NS：裸域（`duchenlin.eu.cc` 不带 `www`）按 DNS 规范不能用 CNAME 指向别处，
> 只有 Cloudflare 托管 DNS 时才能用它的 CNAME 展平（CNAME flattening）绕过这个限制。
> 留在 julydns 解析则做不到裸域访问。

**3. 等域名状态变成 Active**

Cloudflare 会自动检测。通常几分钟到几小时，最长 24 小时。状态没变 Active 之前不要做第 4 步。

**4. 连接仓库，开启自动部署**

Cloudflare 里进 **Workers & Pages** → **Create** → **Import a repository** → 授权 GitHub 并选
`DUEDCL/duchenlin-blog`（私有仓库需要在授权时勾选它），然后按下表填：

| 设置项                    | 填什么                                       |
| :------------------------ | :------------------------------------------- |
| Worker name               | `duchenlin-blog` —— **必须一字不差**         |
| Build command             | `npm run build`                              |
| Deploy command            | `npx wrangler deploy`（默认值，不用改）      |
| Root directory            | 留空                                         |
| API token                 | 选 **Create new token**，权限用默认          |

Worker 名字与 `wrangler.toml` 里的 `name` 不一致会导致构建直接失败，这是最常见的坑。

保存后会立刻触发一次构建。构建成功即上线，`wrangler.toml` 会自动把 `duchenlin.eu.cc` 绑到
这个 Worker 上，DNS 记录和 HTTPS 证书都由 Cloudflare 自动生成，你不需要手工加任何解析记录。

## 发布流程

首次部署完成后，日常发布只需要推送：

```bash
git add -A && git commit -m "post: 新文章标题" && git push
```

推送后 Cloudflare 自动构建，约一到两分钟上线。

## 需要你填的地方

`src/consts.ts` 里的社交链接目前只填了 GitHub，邮箱、X、微博、知乎留空（留空的不会渲染）。
`src/pages/about.astro` 里的「关于」正文是占位文字。
`src/content/photos/` 与 `src/content/projects/` 引用的配图是占位图，alt 文字写着「占位图，请替换」。

## 技术说明

- 不引用任何境外 CDN 资源。西文字体（Fraunces / IBM Plex Mono）随构建产物分发，中文走系统字体栈，
  KaTeX 样式和字体自托管。站点托管在境外，请求数比字节数更影响首屏速度。
- `.nvmrc` 固定 Node 版本，避免构建环境默认版本变动导致线上构建失败。
- 深色模式读取系统偏好，手动切换后记在 `localStorage`，刷新不闪白。
