---
question: 为什么部署在 Cloudflare Workers 而不是 Pages？
aliases:
  - 站托管在哪
  - Workers 和 Pages 有什么区别
  - 为什么不用 Vercel 或者 Netlify
topic: 这个站
---

用的是 Workers 的静态资源模式 —— `wrangler.toml` 里只有 `[assets]`，没有 `main`，所以
没有一行服务端代码在跑，行为上跟纯静态托管一样。

选它而不是 Pages，主要是裸域绑定这件事。`[[routes]]` 写上 `custom_domain = true` 之后，
DNS 记录和证书都是自动生成的，不用手工加任何解析。裸域按 DNS 规范不能用 CNAME，
Cloudflare 用 CNAME 展平在内部绕开了这个限制，前提是 DNS 托管在它这里。

两者有个差异踩过一次：Workers 不会自动认 `404.html`，必须在 `[assets]` 里显式声明
`not_found_handling`，Pages 是自动的。另外面板上的 Cache Rules 对 Workers 完全不生效，
缓存只能靠响应头。
