# duchenlin.top

沉麟的个人站点。Astro 静态生成，Markdown 写作，本地一条命令部署到 Cloudflare Workers。

线上：<https://duchenlin.top> · 备用 <https://duchenlin.eu.cc>（国内不可达，仅境外）

## 快速开始

```bash
npm install          # 首次或换电脑
npm run dev          # 本地预览 http://localhost:4321
```

| 命令 | 作用 |
| :--- | :--- |
| `npm run dev` | 本地预览，改文件自动刷新，草稿可见 |
| `npm run build` | 构建到 `dist/`，上线前自检 |
| `npm run preview` | 预览构建产物，最接近线上效果 |
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

站点已上线，三个域名均可访问。进行中与待办见 [需求台账](docs/需求台账.md)。

需要沉麟提供或决定的事项集中在
[需求台账 § 待沉麟决定的事](docs/需求台账.md#待沉麟决定的事)。
