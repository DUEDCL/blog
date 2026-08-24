# duchenlin.top

沉麟的个人站点。Astro 生成，Markdown 写作，本地一条命令部署到 Cloudflare Workers。

页面绝大多数是构建时生成的静态 HTML，但**不再是纯静态站** —— 点歌台的 `/api/music/*`
四条只读接口在 Worker 里跑（`src/worker.ts`）；全站换页走 SPA（`<ClientRouter />`），
为的是「换页时音乐不断」。根路径 `/` 是起始页（一道门），正站首页在 `/home`。

线上：<https://duchenlin.top> · 备用 <https://duchenlin.eu.cc>（国内不可达，仅境外）

## 快速开始

```bash
npm install          # 首次或换电脑
npm run dev          # 本地预览 http://localhost:4321
```

| 命令 | 作用 |
| :--- | :--- |
| `npm run dev` | 本地预览，改文件自动刷新，草稿可见。**`/api/music/*` 与 `/api/chat` 在这里必然 404** |
| `npm run build` | 构建到 `dist/`，上线前自检 |
| `npm run preview` | 预览构建产物，最接近线上效果 |
| `npm run build && npx wrangler dev` | 带 Worker 的本地预览 —— 要调点歌台或对话接口只能用这个。对话的三个 secret 从 `.dev.vars` 读（那个文件不进仓库） |
| `npm run build && npx wrangler deploy` | 发布上线 |

## 文档

| 文档 | 看这个当你要… |
| :--- | :--- |
| [写作指南](docs/写作指南.md) | 发文章、填 frontmatter、放照片、用公式 |
| [部署运维](docs/部署运维.md) | 发布上线、加域名、排查部署失败 |
| [技术架构](docs/技术架构.md) | 了解选型理由、目录结构、设计系统 |
| [需求台账](docs/需求台账.md) | 查需求原文、当前进度、待决事项 |
| [开发约定](docs/开发约定.md) | 知道文件该放哪、怎么提交、怎么验证 |
| [AI 版沉麟方案](docs/AI版沉麟方案.md) | 看 R6（站内 AI 对话 + 实时监管）的分阶段路线与风险 |

## 当前状态

站点已上线，三个域名均可访问。

**这不是博客，是个人网站** —— R32（2026-08-24）定的口径，后面会往里放一些沉麟自己写、
自己真用得上的小工具。

眼下在做 R6「AI 版沉麟」：`src/content/kb/` 那 24 条问答**已全部定稿**（阶段①完成），
阶段② 也做完了 —— 左下角的浮动对话按钮、`POST /api/chat`（流式）、对话落库到
Durable Object。对话上游是一个**可配置的 OpenAI 兼容端点**（地址、模型、密钥三样都是
Worker secret，不进仓库），配不上或这一次失败就自动退回 Workers AI 绑定。
**本地已跑通，线上待验**（要验什么见 [需求台账 R34](docs/需求台账.md)）。
登录与实时监管页排在它后面。进行中与待办见 [需求台账](docs/需求台账.md)。

需要沉麟提供或决定的事项集中在
[需求台账 § 待沉麟决定的事](docs/需求台账.md#待沉麟决定的事)。
