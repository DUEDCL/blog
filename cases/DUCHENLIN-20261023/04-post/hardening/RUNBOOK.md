# 执行手册 — 变更窗口内的顺序、验收与回滚

## 0. 前置（一次性）

```bash
export CF_API_TOKEN=<token>          # 权限：Zone:DNS:Edit, Zone:Settings:Edit, Zone:WAF:Edit, Zone:Firewall Services:Edit
export CF_ZONE_ID=<zone id>          # duchenlin.top 的 zone id
export CF_ZONE_NAME=duchenlin.top
node cf-apply.mjs snapshot           # 只导出，不改任何东西 -> backups/dns-records-before-<UTC>.json
```

确认凭据有效：`curl -s -H "Authorization: Bearer $CF_API_TOKEN" https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID | jq '.result.name'`

## 1. 顺序（严格按此序，每步跑完再下一步）

| 步 | 命令 | 验收 | 观察窗 |
|---|---|---|---|
| 1 | `node cf-apply.mjs apply --only dns` | `node hardening-audit.mjs --mode dns` → D1/D2/D3 PASS | 5 min（等 TTL） |
| 2 | `node cf-apply.mjs apply --only edge` | `node hardening-audit.mjs --mode tls` → T1/T2/T3/T4 PASS；`curl -sI https://duchenlin.top \| grep -i strict-transport` | 60 s |
| 3 | `node cf-apply.mjs apply --only headers` | `node hardening-audit.mjs --mode http` → H1–H6 PASS（H2 首日为 WARN/Report-Only，属预期） | 24 h |
| 4 | `node cf-apply.mjs apply --only waf` + `--only custom` | CF Dashboard → Security → Events 出现 `action=log` 命中；站点功能抽测 | 24 h |
| 5 | `node cf-apply.mjs apply --only ratelimit` | `node hardening-audit.mjs --mode ratelimit`（Log 模式下 R1 仍 FAIL，属预期） | 24 h |
| 6 | `node cf-apply.mjs apply --only bots` | `/api/*` 客户端（点歌台、影视、刷步）抽测不被挑战 | 24 h |
| 7 | `node cf-apply.mjs enforce --only waf`（含 custom） | 同上 + 确认无 403 误伤 | — |
| 8 | `node cf-apply.mjs enforce --only ratelimit` | `node hardening-audit.mjs --mode ratelimit` → R1 PASS（出现 429） | — |
| 9 | CSP 切强制（`--only headers --mode enforce`） | 浏览器控制台零 CSP 报错 | — |

## 2. Log → Block 的判定阈值（24h 观察期）

只有同时满足这三条才允许执行第 7/8 步：

1. Security Events 里 `action=log` 的命中记录，逐条抽样 20 条，**业务流量占比 0**（全是扫描器/空 UA/异常方法）。
2. 关键路径 24h 内 0 命中：`/`、`/login`、`/tools/*`、`/tv`、`/api/music/*`、`/api/chat`、`/api/site/*`。
3. 站点自身监控（如 CF Analytics 5xx 率、真实用户反馈）无异常抬升。

不满足就延长观察期，不要切 Block。这是本手册里唯一允许"不做完"的一步。

## 3. CSP：Report-Only → 强制

- 首日 `Content-Security-Policy-Report-Only`，值见 `csp.txt`（含 9 个内联脚本 sha256）。
- **报告去向未闭环**：CSP 违规报告需要一个收集端点（`report-uri`/`report-to`），本站没有。可选：
  - A：在 Worker 加 `/api/csp-report`（落 KV/DO）—— 属业务代码改动，需站主批准，本次未做；
  - B：不加端点，靠浏览器控制台人工抽查（本次采用）；
  - C：第三方收集器 —— 与站主"站上不体现第三方链路"的既有原则冲突，不采用。
- 切换前必须重算 hash：`node hardening-audit.mjs` 不覆盖这项，用下面这段（新增页面/改构建都会让 hash 变）：

```bash
node -e "const fs=require('fs'),c=require('crypto');const w=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?w(d+'/'+e.name):e.name.endsWith('.html')?[d+'/'+e.name]:[]);const s=new Set();for(const f of w('dist')){const h=fs.readFileSync(f,'utf8');for(const m of h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)){if(m[1].trim())s.add(c.createHash('sha256').update(m[1],'utf8').digest('base64'))}}console.log([...s].sort())"
```

## 4. 两条单向门，别急着走

**HSTS preload**：`includeSubDomains; preload` 一旦下发，浏览器缓存 1 年，且 `includeSubDomains` 覆盖所有未来子域（含 `*.duchenlin.top`）。建议：先只发 header（本手册第 2 步），**6 个月**稳定后再去 hstspreload.org 提交；提交后从列表移除要数月。
回滚（浏览器侧已缓存的部分不可撤回）：`PATCH /settings/security_header {"value":{"strict_transport_security":{"enabled":false}}}`。

**DNSSEC**：NS 已在 Cloudflare，开启是一键，但**必须确认注册商侧能加 DS**，否则链断=全站解析失败。
本次未做（需要变更窗口 + 注册商操作）。回滚：先在 CF 关 DNSSEC，再删注册商 DS（顺序反了会有一段不可解析）。

## 5. 通配符那条（提示词里要求"确认业务不需要再删"）

实测：`zzz-not-real-9f3k.duchenlin.top` **无 A 记录解析**，即**没有通配符 DNS 记录**，无需删除。
证书是 GTS WE1 通配符（覆盖 `*.duchenlin.top`），那是证书不是 DNS 记录，且被 CAA 收紧后只能由 LE/GTS 签发，属于预期形态。

## 6. 全量回滚

```bash
# 按变更时刻
node cf-apply.mjs rollback --stamp <UTC>      # 依赖 backups/*-before-<UTC>.json
# 或逐项：打开 ROLLBACK-<UTC>.md，里面每条都是可直接执行的 curl
```

DNS 回滚只删本次新建的 4 条记录，A/AAAA 与既有记录一律不动。
