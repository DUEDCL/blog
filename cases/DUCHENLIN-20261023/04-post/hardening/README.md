# DUCHENLIN-20261023 — 加固交付

## 一条结论

**仍有 5 类可被外部直接利用的项，且全部不需要凭据即可复现。** 最高危两条是「邮件可伪造」和「登录口无限速」：
伪造 `From: *@duchenlin.top` 的钓鱼邮件今天就能进收件箱（无 SPF、无 DMARC）；`/api/site/login`、`/api/admin/login`、`/api/chat` 今天就能被脚本无限打（实测 200 请求 / 50 并发 → 200 个 200，零 429），其中 `/api/chat` 每次调用烧 Workers AI neurons，日配额可被单个 IP 打穿。
第二梯队：无 CAA（任意 CA 可签发本域证书）、TLS 1.0/1.1 仍被接受、无 XFO/CSP/nosniff（可被 iframe 嵌套钓鱼）。
**这五类在阶段 1/2 的脚本里都已就绪，缺的只是凭据那一步。**

## 交付物

| 文件 | 作用 |
|---|---|
| `hardening-audit.mjs` | 验收脚本。D1–D5 / H1–H7 / T1–T4 / S1 / R1，`--self-test` 自证判定非空转，`--json` 出机器可读结果 |
| `cf-apply.mjs` | 下发引擎。幂等、逐项 before/after 导出、WAF 默认 log、自动生成 `ROLLBACK-<UTC>.md`；无凭据时 `--dry-run` 打印完整 API 计划 |
| `nginx-hardened.conf` | 阶段 3 源站模板（当前生产无 nginx，见下）；已过 `nginx -t` |
| `csp.txt` / `csp-hashes.json` | 从 `dist/` 87 个页面重算的 9 个内联脚本 sha256，可直接 enforce 的 CSP |
| `CHANGELOG-hardening.md` | 变更清单：改前值 / 改后值 / 生效时间 / 回滚命令 |
| `RUNBOOK.md` | 变更窗口内的顺序、Log→Block 判定阈值、两条单向门（HSTS preload / DNSSEC） |
| `backups/external-baseline-before-20261023T122700Z.json` | 改前外部可观测基线（真实抓取） |

## 阶段 1 + 2 验收（原始输出）

改前基线 —— `node hardening-audit.mjs --domain duchenlin.top --mode all --base https://duchenlin.top`，exit=1：

```
== hardening-audit == 2026-10-23T12:29:48.399Z  domain=duchenlin.top  mode=all  base=https://duchenlin.top
  [raw] HTTP 200 https://duchenlin.top/
  [raw] date: Fri, 23 Oct 2026 12:29:48 GMT
  [raw] content-type: text/html
  [raw] cf-cache-status: HIT
  [raw] cache-control: public, max-age=60, stale-while-revalidate=604800
  [raw] server: cloudflare
  [raw] alt-svc: h3=":443"; ma=86400

id   status  check                                                      detail
D1   FAIL   SPF hard fail (v=spf1 -all)                              no v=spf1 TXT on duchenlin.top
D2   FAIL   DMARC p=reject + rua                                     no DMARC TXT on _dmarc.duchenlin.top
D3   FAIL   CAA pins issuance to LE + pki.goog                       no CAA on duchenlin.top
D4   PASS   No MX (domain cannot receive mail)                       no MX, consistent with v=spf1 -all
D5   WARN   DNSSEC enabled                                           needs registrar-side DS check
H1   FAIL   HSTS 1y + includeSubDomains + preload                    header missing
H2   FAIL   CSP enforced (default-src self, frame-ancestors none)    header missing
H3   FAIL   X-Frame-Options: DENY                                    header missing
H4   FAIL   X-Content-Type-Options: nosniff                          header missing
H5   FAIL   Referrer-Policy strict-origin-when-cross-origin          header missing
H6   FAIL   Permissions-Policy geo/mic/camera disabled               header missing
H7   PASS   Origin banner not leaked                                 server: cloudflare
T1   FAIL   TLS 1.0 rejected (raw ClientHello)                       ACCEPTED 0x301
T2   FAIL   TLS 1.1 rejected (raw ClientHello)                       ACCEPTED 0x302
T3   PASS   TLS 1.2 still served                                     TLSv1.2 / ECDHE-ECDSA-AES128-GCM-SHA256
T4   PASS   TLS 1.3 served                                           TLSv1.3 / TLS_AES_256_GCM_SHA384
S1   PASS   Origin not directly reachable                            every A record is Cloudflare edge (172.67.170.144,104.21.63.106); origin is a Worker, zero inbound ports
R1   FAIL   Rate limit returns 429 under 200 req / 50 conn           {"200":200}

SUMMARY pass=5 warn=1 fail=12  elapsed=7.0s
FAILED: D1, D2, D3, H1, H2, H3, H4, H5, H6, T1, T2, R1
```

T1/T2 这条值得单独说：本机 Node 用 `minVersion:'TLSv1'` 会直接 `ERR_SSL_NO_PROTOCOLS_AVAILABLE`（客户端自己拒绝），Schannel 版 curl 的 `--tlsv1.0` 会静默升级。两个客户端都会骗人，所以审计改成**手搓 ClientHello + SNI** 发原始记录：收到 `ServerHello 0x0301 / 0x0302` 才算被接受。结论是**边缘真的还在接受 TLS 1.0/1.1**。

判定器自证 —— `node hardening-audit.mjs --self-test`，exit=0：

```
  SELFTEST ok   spf
  SELFTEST ok   dmarc
  SELFTEST ok   caa
  SELFTEST ok   hsts
  SELFTEST ok   csp
  SELFTEST ok   xfo
  SELFTEST ok   nosniff
  SELFTEST ok   referrer
  SELFTEST ok   permissions
SELFTEST: all 9 predicates discriminate good from bad
```

下发计划 —— `node cf-apply.mjs apply --dry-run`（无凭据时打印完整请求体，exit=0，逐条原文）：

```
[plan] POST  /zones/{zone}/dns_records  {"type":"TXT","name":"duchenlin.top","ttl":1,"content":"v=spf1 -all"}
[plan] POST  /zones/{zone}/dns_records  {"type":"TXT","name":"_dmarc.duchenlin.top","ttl":1,"content":"v=DMARC1; p=reject; rua=mailto:dmarc@duchenlin.top; adkim=s; aspf=s"}
[plan] POST  /zones/{zone}/dns_records  {"type":"CAA","name":"duchenlin.top","ttl":1,"data":{"flags":0,"tag":"issue","value":"letsencrypt.org"}}
[plan] POST  /zones/{zone}/dns_records  {"type":"CAA","name":"duchenlin.top","ttl":1,"data":{"flags":0,"tag":"issue","value":"pki.goog"}}
[plan] PATCH /zones/{zone}/settings/ssl {"value":"strict"}
[plan] PATCH /zones/{zone}/settings/min_tls_version {"value":"1.2"}
[plan] PATCH /zones/{zone}/settings/tls_1_3 {"value":"on"}
[plan] PATCH /zones/{zone}/settings/always_use_https {"value":"on"}
[plan] PATCH /zones/{zone}/settings/automatic_https_rewrites {"value":"on"}
[plan] PATCH /zones/{zone}/settings/opportunistic_encryption {"value":"on"}
[plan] PATCH /zones/{zone}/settings/security_header {"value":{"strict_transport_security":{"enabled":true,"max_age":31536000,"include_subdomains":true,"preload":true,"nosniff":true}}}
[plan] PUT   /zones/{zone}/rulesets/phases/http_response_headers_transform/entrypoint  {"rules":[ 5 条 set 规则，CSP 首日为 Content-Security-Policy-Report-Only ]}
[plan] PUT   /zones/{zone}/rulesets/phases/http_request_firewall_managed/entrypoint     {"rules":[{"action":"execute","action_parameters":{"id":"efb7b8c949ac4650a09736fc376e9aee","overrides":{"action":"log"}},"expression":"true"},{"action":"execute","action_parameters":{"id":"4814384a9e5d4991b9815dcfc25d2f1f","overrides":{"action":"log"}},"expression":"true"}]}
[plan] PUT   /zones/{zone}/rulesets/phases/http_request_firewall_custom/entrypoint      {"rules":[{"action":"log","expression":"not http.request.method in {\"GET\" \"HEAD\" \"POST\" \"PUT\" \"DELETE\" \"PATCH\" \"OPTIONS\"}"},{"action":"log","expression":"http.request.uri.path matches \"/(\\.git|\\.env|\\.svn|wp-admin|actuator|server-status|\\.DS_Store)\""},{"action":"managed_challenge","expression":"http.user_agent eq \"\" or http.user_agent matches \"(sqlmap|nikto|nmap|masscan|zgrab|nuclei)\""},{"action":"managed_challenge","expression":"(http.request.method eq \"POST\") and (http.request.uri.path eq \"/api/admin/login\" or http.request.uri.path eq \"/api/site/login\" or http.request.uri.path eq \"/api/site/register\")"}]}
[plan] PUT   /zones/{zone}/rulesets/phases/http_ratelimit/entrypoint                    {"rules":[ 5 条：/api/site/login 10/60s、/api/admin/login 5/60s、/api/site/register 5/60s、/api/* 100/60s、全站 300/60s，全部 action=log ]}
[plan] PATCH /zones/{zone}/settings/bot_fight_mode {"value":true}
```

> 上面每条 `POST/PUT/PATCH` 前后都自动落 `backups/<项>-before-<UTC>.json` 与 `<项>-after-<UTC>.json`，并追加一行回滚到 `ROLLBACK-<UTC>.md`。

## 阶段 3 验收（原始输出）

先纠正一个前提：**本站没有源站 IP，也没有 nginx。** `wrangler.toml` 写着 `name = "duchenlin-blog"`、`main = "src/worker.ts"`，三条自定义域都 `custom_domain = true`。所以 `curl -sI https://[源站IP]/ -k -H "Host: duchenlin.top"` 这条验收在物理上无处可打——这正好是 S1 PASS 的原因：

```
S1   PASS   Origin not directly reachable   every A record is Cloudflare edge (172.67.170.144,104.21.63.106); origin is a Worker, zero inbound ports
```

也就是说提示词里"更优方案：改用 Cloudflare Tunnel"这一步**已经天然达成**——Worker 本身就是零入站端口、无 IP 可泄漏的形态，比 Tunnel 更彻底（Tunnel 还留一个 `cloudflared` 进程和一条出站长连接）。

`nginx-hardened.conf` 作为迁移备件交付，并已在容器里过语法与结构校验（含负向对照，证明校验不是空转）：

```
$ docker run --rm -v ./.tmp-nginx:/etc/nginx-test --entrypoint /bin/sh nginx:alpine -c "nginx -t -c /etc/nginx-test/nginx.conf 2>&1; echo EXIT=$?"
2026/10/23 12:31:58 [warn] 7#7: "ssl_stapling" ignored, issuer certificate not found for certificate "/etc/nginx-test/certs/fullchain.pem"
nginx: [warn] "ssl_stapling" ignored, issuer certificate not found for certificate "/etc/nginx-test/certs/fullchain.pem"
nginx: the configuration file /etc/nginx-test/nginx.conf syntax is ok
nginx: configuration file /etc/nginx-test/nginx.conf test is successful
EXIT=0
```

```
# 负向对照：塞一行非法指令
2026/10/23 12:31:50 [emerg] 1#1: unknown directive "this_is_not_a_directive" in /etc/nginx-test/conf.d/99-broken.conf:1
nginx: configuration file /etc/nginx-test/nginx.conf test failed
EXIT=1
```

（那条 `ssl_stapling` warn 是自签测试证书没有 issuer 链导致的；真实 Let's Encrypt `fullchain.pem` 不会出现。）

限速压测（阶段 3 的 `ab -n 200 -c 50` 等价物，走审计的 R1）：

```
R1   FAIL   Rate limit returns 429 under 200 req / 50 conn    {"200":200}
```

即**当前零限速**。这条要等阶段 2 的 ratelimit 规则从 log 切到 enforce 才会翻成 PASS。

## 阶段 4 判定对照

| 判定项 | 现在 | 依据 |
|---|---|---|
| D1 SPF PASS | FAIL | 无 TXT |
| D2 DMARC PASS（p=reject） | FAIL | 无 `_dmarc` |
| D3 CAA PASS | FAIL | 无 CAA |
| H1–H6 全 PASS | 全 FAIL | 六个头一个都没有 |
| T1/T2 PASS | FAIL | 原始 ClientHello 收到 0x301 / 0x302 |
| S1 PASS | **PASS** | 源站是 Worker，无入站端口 |
| R1（提示词未列，本手册加） | FAIL | 200/200 无 429 |

## 未完成项与原因

1. **阶段 1/2 未下发**。原因：提示词里的 `[CF_API_TOKEN]`、`[CF_ZONE_ID]` 是占位符，本机 `npx wrangler whoami` 也返回 `You are not authenticated`。补上凭据后执行 `node cf-apply.mjs apply`（全部）或按 RUNBOOK 分步走即可，不需要改脚本。
2. **WAF / 限速的 24h Log 观察期**。硬约束 2 要求先 Log 后 Block，这一步需要真实流量与时间，今天无法完成。切 Block 的三条判定阈值写在 RUNBOOK 第 2 节。
3. **CSP 违规报告无收集端点**。站上没有 `/api/csp-report`，而加这个路由属于改业务代码（约束 3 禁止）。所以首日 Report-Only 的报告只能靠浏览器控制台人工看。已用"预算 9 个内联脚本 hash"把已知违规源提前消掉，风险可控。
4. **DMARC `rua` 是死信**。`rua=mailto:dmarc@duchenlin.top` 但本域**无 MX**（这正是 `v=spf1 -all` 的前提），聚合报告投不进来。要么在别处开个邮箱转发，要么 `cf-apply.mjs apply --only dns --rua mailto:dmarc@<有邮箱的域>`。不改也能挡住伪造，只是拿不到报告。
5. **DNSSEC**。需要注册商侧加 DS 且必须与 CF 侧同时到位，属变更窗口操作；顺序错会导致解析中断。RUNBOOK 第 4 节给了回滚顺序。
6. **HSTS preload 提交**。建议 header 稳定 6 个月后再去 hstspreload.org，因为 `includeSubDomains` 会永久覆盖未来子域、浏览器缓存 1 年。
7. **提示词里的 `[源站IP]` / `[源站目录]` 无对应实体**，阶段 3 的 `iptables`、`ufw`、geo 白名单在 Worker 架构下没有作用对象；模板留给将来迁真实源站。

## 剩余风险（按可利用性排序）

| 风险 | 利用路径 | 等级 |
|---|---|---|
| 邮件伪造 | 直接 `SMTP` 发 `From: admin@duchenlin.top`，无 SPF 无 DMARC → 收件方无校验，进收件箱；可用于冒充站主发钓鱼/收款 | **高** |
| 登录口无限速 | 对 `/api/site/login`、`/api/admin/login` 跑字典（邀请码/口令）；对 `/api/chat` 刷调用烧掉 Workers AI 日配额（10k neurons/天），成本型 DoS | **高** |
| 证书签发不受控 | 无 CAA，任何公共 CA 均可为 `duchenlin.top` 签发；配合 CA 误签发/被攻破可做中间人 | 中 |
| 点击劫持 + 内容嗅探 | 无 `X-Frame-Options`/`frame-ancestors`，可被恶意站 iframe 嵌套做点击劫持；无 `nosniff`，上传/回显类内容可被当脚本执行 | 中 |
| TLS 降级面 | 边缘接受 TLS 1.0/1.1（实测），可被降级到弱套件（实测 `ECDHE-RSA-AES128-SHA`） | 中低 |
| WAF 缺失 | 无 SQLi/XSS/RCE 特征拦截，Worker 是唯一防线；`/.env`、`/.git/config`、`/wp-admin` 目前返回 404 只是路由没命中，不是被拦 | 中低 |

前两条补完凭据即消；后四条同样在 `cf-apply.mjs` 的 edge / headers / waf 三个阶段里。
