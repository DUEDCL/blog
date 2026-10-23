# 变更清单 — DUCHENLIN-20261023 加固

基线快照：`backups/external-baseline-before-20261023T122700Z.json`（2026-10-23T12:29:48Z 实测，12 项 FAIL）
下发引擎：`cf-apply.mjs`（幂等；每项自动导出 `<项>-before-<UTC>` / `<项>-after-<UTC>`，并生成 `ROLLBACK-<UTC>.md`）
状态列含义：**READY** = 一条命令即可下发，前置条件已满足；**BLOCKED** = 缺凭据或需业务确认。

## 阶段 1 — DNS

| # | 项 | 改前值（实测） | 改后值 | 生效时间 | 状态 | 回滚 |
|---|---|---|---|---|---|---|
| 1 | `duchenlin.top TXT` | 无 TXT 记录（`dig +short TXT` 空） | `v=spf1 -all` | TTL auto=300s，全球 ≤5min | READY | `DELETE /zones/{zone}/dns_records/{id}` |
| 2 | `_dmarc.duchenlin.top TXT` | NXDOMAIN/无记录 | `v=DMARC1; p=reject; rua=mailto:dmarc@duchenlin.top; adkim=s; aspf=s` | 同上 | READY | 同上 |
| 3 | `duchenlin.top CAA issue` | 无 CAA（任何 CA 可签发） | `0 issue "letsencrypt.org"` | 同上 | READY | 同上 |
| 4 | `duchenlin.top CAA issue` | 无 | `0 issue "pki.goog"` | 同上 | READY | 同上 |

回滚一键：`node cf-apply.mjs` 生成的 `ROLLBACK-<UTC>.md` 里带 4 条 `curl -X DELETE .../dns_records/{id}`。
注意：A/AAAA 全程不动（约束 3）。

## 阶段 2 — 边缘

| # | 项 | 改前值（实测） | 改后值 | 生效时间 | 状态 | 回滚 |
|---|---|---|---|---|---|---|
| 5 | SSL 模式 | 未知（API 只读需要凭据）；源站是 Worker，无自签风险 | `strict` | 秒级 | READY | `PATCH /settings/ssl {"value":"<原值>"}` |
| 6 | 最低 TLS | **TLS 1.0 / 1.1 仍被接受**（审计 T1/T2 FAIL，原始 ClientHello 收到 ServerHello 0x301/0x302） | `1.2` | 秒级 | READY | `PATCH /settings/min_tls_version {"value":"1.0"}` |
| 7 | TLS 1.3 | 已开（T4 PASS，h3 Alt-Svc 存在） | `on` | — | READY（幂等） | `{"value":"on"}` 还原为原值 |
| 8 | Always Use HTTPS | 已生效（`http://` 返回 301 → https） | `on` | 秒级 | READY（幂等） | 原值 |
| 9 | Automatic HTTPS Rewrites | 未知 | `on` | 秒级 | READY | 原值 |
| 10 | Opportunistic Encryption | 未知 | `on` | 秒级 | READY | 原值 |
| 11 | HSTS | 无 `strict-transport-security` 头 | `max-age=31536000; includeSubDomains; preload` | 秒级（**浏览器侧 1 年不可撤**） | READY | `PATCH /settings/security_header {"value":{"strict_transport_security":{"enabled":false}}}` |
| 12 | 响应头 ×4 | 全部缺失（H3–H6 FAIL） | nosniff / DENY / strict-origin-when-cross-origin / Permissions-Policy | 秒级 | READY | 见 `ROLLBACK-<UTC>.md` 的 `PUT rulesets/{id}` |
| 13 | CSP | 无 | 首日 `Content-Security-Policy-Report-Only`，含 **9 个内联脚本 sha256**（`csp.txt`） | 秒级 | READY | 同上 |
| 14 | Managed WAF（CF Managed + OWASP CRS，PL1） | 未启用 | `execute` + `overrides.action=log` | 秒级 | READY（Log） | `DELETE .../http_request_firewall_managed/entrypoint` |
| 15 | 自定义 WAF ×4 | 无 | 方法白名单 / 敏感路径 / 空+扫描器 UA / 凭据端点挑战 | 秒级 | READY（前两条 Log，后两条 Managed Challenge） | `DELETE .../http_request_firewall_custom/entrypoint` |
| 16 | 限速 ×5 | 无（200 req/50 并发全 200，R1 FAIL） | 登录 10/60s、admin 登录 5/60s、注册 5/60s、`/api/*` 100/60s、全站 300/60s | 秒级 | READY（Log） | `DELETE .../http_ratelimit/entrypoint` |
| 17 | Bot Fight Mode | 未知 | `on` | 秒级 | READY | `{"value":false}` |

### 与提示词的两处有意偏离（均已核过线上真实路径）

- 提示词写 `/api/user/login`、`/api/user/register`。本站**不存在**这两条路径（`src/worker.ts` / `src/lib/site-api.ts` 实测）。真实凭据端点是 `/api/site/login`（GET 返回 405，存在）、`/api/site/register`（405）、`/api/admin/login`（405）。照抄提示词等于给不存在的路径建限速，登录口零保护。已改为真实路径，并补一条 `/api/admin/login` 5/60s。
- 提示词 CSP 是 `script-src 'self'`。本站构建产物含 **9 段内联脚本**（主题门、i18n 切换、账号菜单、滚动导航、AI 组件、view transitions）。原样 enforce 会直接打死这些功能。已把 9 个 sha256 追加进 `script-src`（`csp-hashes.json` / `csp.txt`，从 `dist/` 87 个页面重算得出）。
- 另外核实：构建产物无外链子资源（无外链 img/media/fetch），`default-src 'self'; img-src 'self' data:; connect-src 'self'` 与现状兼容。

## 阶段 3 — 源站

| # | 项 | 改前值 | 改后值 | 生效时间 | 状态 |
|---|---|---|---|---|---|
| 18 | 源站形态 | **Cloudflare Worker**（`wrangler.toml: name=duchenlin-blog`, `main=src/worker.ts`），零入站端口、无 IP、无 nginx | 无需改动；S1 已 PASS | — | 已达成（优于 Tunnel 方案） |
| 19 | Nginx 加固模板 | 不适用（无 nginx） | `nginx-hardened.conf`（迁移真实源站时直接套用） | — | READY（备件） |
| 20 | `nginx -t` 验证 | — | `syntax is ok / test is successful`（nginx:alpine 容器内实测，附负向对照） | — | 已验收 |
