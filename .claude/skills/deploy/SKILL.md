---
name: deploy
description: 本站上线的固定流程：构建校验 → 提交 → wrangler deploy → curl 验线上 → push。沉麟说「部署」「提交」「上线」「发布」「推一下」时走这个，顺序、判据、验证清单、回滚办法与六个已知坑都写死在里面，不要临场自己拼命令。只做其中一段（只提交／只部署／只改文档）也看这里。
allowed-tools: Bash, Read, Grep
---

# 上线：构建 → 提交 → 部署 → 验线上 → 推送

## 顺序不能改

```
① npm run build + npx astro check   （不过判据就停下）
② git commit
③ npx wrangler deploy
④ curl 线上逐条验
⑤ git push origin main
```

**push 为什么排在 deploy 之后**：2026-08-23 与沉麟定的约定。线上是拿本地 `dist/` 部署的，
先把线上换过去、验通了再推，仓库里就不会出现「已推未上线」这种与线上不一致的中间态。
反向的理由记在 `docs/部署运维.md` 最后：Workers Builds 没接（**也别再提议接**），
远端落后本地时接上去会用旧代码覆盖线上。

## 开工前先确认三件事

```bash
git status -sb && git log --oneline -1 && git fetch --dry-run 2>&1 | tail -3
```

1. **在 `main` 上**，且与 `origin/main` 同步或本地领先。远端领先（别的机器推过）就先
   `git pull --rebase`，再从 ① 重新走 —— 否则 ⑤ 会被拒，而那时线上已经换了。
2. **工作区里没有临时改动**：为调试临时放慢的动画、注入的桩、`console.log` 之类。
   先 `grep -rn 'TEMP-' src/` 扫一遍自己留的标记。
3. **本轮的验证已经做完**。这份技能只管上线，不替代验收；`npm run build` 通过不等于功能对。

## ① 构建与类型检查

```bash
npm run build
```

判据：**`76 page(s) built`**（R32 删掉 /now 与两组占位相册、R35 加了 /admin 之后是 16；2026-08-26 补齐作品集与四篇技术文章之后 24；R46 扩到三种语言之后 70 —— 22 个页面 × 3 种语言 ＋ /admin ＋ /start 跳转页 ＋ 根 404 ＋ 3 份 RSS；2026-08-28 加了第七篇文章 orb-nine-revisions 之后 +3 ＝ 73；**2026-08-30 加了随笔 story-of-my-orb 之后再 +3（一篇 × 三种语言）＝ 这个数**）。页数变了先弄清为什么（本轮是否真的增删了页面、或增删了语言），别往下走。加一篇文章就是 +3，加一种语言是 +23。

**R41 起 `npm run build` 不只是 `astro build`**：它先跑 `scripts/gen-content.mjs`，
把 `src/content/` 打成 `src/data/content.generated.ts`（后台读仓库内容用的，`.gitignore` 里）。
第一行输出应该是 `内容索引：N 个文件（…）→ src/data/content.generated.ts`。
**这一步不能跳**：`src/worker.ts` 静态引入那个文件，只跑 `npx wrangler deploy` 会在打包时报
找不到 import。

```bash
npx astro check
```

判据：**0 errors、0 warnings**。（2026-08-23 之前这里长期只剩一条既有的
`about.astro:19 ts(2352)`，是「联系名片填真实账号」那一轮把它修掉的 —— 看到那一条也算过；
多出别的先修掉再提交。）

上面这两个数（70 页、错误数）是**会过期的判据**：本轮如果有意增删了页面、或修掉／引入了错误，
报告里要说清，并**顺手把这份技能里的数字改掉** —— 判据留着旧值就等于没有判据。
（`astro check` 眼下固定还剩 **2 个 hint**：`content.config.ts` 里两处 `z.string().url()`
的弃用提示，zod 那边的事，看到这两条也算过。）

`dist/`、`.wrangler/`、`node_modules/` 都在 `.gitignore` 里，不会被带进提交。

## ② 提交

- Conventional Commits，描述用中文：`feat|fix|docs|test|refactor|chore(scope): 描述`。
- 一轮需求一个提交；同一个文件里混着两轮改动时**不要**为了拆提交去做交互式 `git add -i`
  （本机不支持交互式 git），合成一个提交、在 body 里分轮次说清即可。
- body 分条写「哪一轮、改了什么、为什么」，末尾必须带：
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **用 heredoc 提交**，别把中文和换行塞进 `-m`：

```bash
git add -A && git status --short && git commit -F - <<'MSG'
feat(scope): 一句话说清这一轮做了什么

- 分条：改了什么、为什么
MSG
```

`git status --short` 排在 `commit` 之前不是摆设：**它的输出要逐行看过**再让提交落下去 ——
别把素材、密钥、临时文件、调试用的临时改动带进去。文件多的时候先只 `git add` 该进去的那些。

## ③ 部署

```bash
npx wrangler deploy
```

- 没有 `npm run deploy` 这个脚本，就是这一条。
- 凭据走环境变量 `CLOUDFLARE_API_TOKEN`（本机已设）。wrangler config 里那个 `oauth_token`
  已失效（`9109 Invalid access token`），别去动它。
- 成功输出里要确认三样：`Uploaded N files`、**三个自定义域名**的触发器
  （duchenlin.top / www.duchenlin.top / duchenlin.eu.cc）、`Current Version ID`。
- Version ID 要写进收尾报告，也要写进 `docs/部署运维.md` 的实测记录。
- **这一轮新增了大批页面（几十个新资源）时，第一次 deploy 之后可能整批 404** ——
  输出会完全正常（文件数对得上、三个触发器都在），但线上新路径全是 404 而旧路径正常。
  资源清单没在边缘切过去。**原样再跑一次 `npx wrangler deploy` 即好**（R46 实测：
  第二次 15 秒后全部 200）。别回滚、别改代码、也别去 purge —— 排查过的排除项列在
  `docs/部署运维.md` 的 R46 那节，不用重走。
  **少量新增不会中招**（2026-08-28 实测：新增 3 个页面，第一次 deploy 就全 200），
  所以不必预先准备第二次 deploy，照常验、真 404 了再重跑。

## ④ 线上验证

域名固定用 `https://duchenlin.top`。**不要用 `*.workers.dev`** —— 本机连不上它，
而且那两个开关（`workers_dev` / `preview_urls`）已经关掉了。

```bash
node -e "
const B='https://duchenlin.top';
const g=async(p,o={})=>{const r=await fetch(B+p,o);return{s:r.status,cc:r.headers.get('cache-control'),len:r.headers.get('content-length'),r}};
(async()=>{
 const d=await g('/'); const h=await d.r.text();
 console.log('/ →',d.s,'| 起始页旗:',/<body[^>]*data-portal/.test(h),'| 状态栏:',/jk-mini/.test(h));
 const css=(h.match(/\/_astro\/index\.[A-Za-z0-9_-]+\.css/)||[])[0];
 if(css){const c=await(await fetch(B+css)).text();console.log(css,'→ 拿到',c.length,'字节');}
 for(const [p,want] of [['/api/music/list?id=12607934375&probe='+Date.now(),'max-age=300'],
   ['/api/music/pic?id=109951166341738895&source=netease&song=1808652335&sign=27sIktTHQwK1E','max-age=86400'],
   ['/api/music/url?id=1808652335&source=netease&sign=27sIktTHQwK1E','no-store']]){
  const r=await g(p); console.log(p.split('?')[0],'→',r.s,'|',r.cc,'| 期望含',want);}
 for(const [p,bytes] of [['/audio/te-bie-de-ren.mp3',10365431],['/audio/te-bie-de-ren.jpg',87364]]){
  const r=await g(p); console.log(p,'→',r.s,'|',r.len,'B | 期望',bytes);}
 for(const [p,mark] of [['/music/','jk-vinyl__cover'],['/home/','site-header']]){
  const r=await g(p); const t=await r.r.text(); console.log(p,'→',r.s,'| 含',mark+':',t.includes(mark));}
 for(const p of ['/api/music/nope','/no-such-page/','/audio/door-light.mp3','/api/music/pic?id=1&source=netease&sign=x']){
  const r=await g(p); console.log(p,'→',r.s,'（期望 404 / 404 / 404 / 400）');}
})().catch(e=>console.log('ERR',e.message))"
```

判据：五条接口的 `cache-control` 与代码里 `CACHE` 那张表对得上；素材字节数与本地一致；
删掉的素材必须 404；`/api/music/*` 的错误分支返回自己写的中文，不外泄上游文本。
**页面结构类的判据按本轮改了什么临场加**（本轮改了门就验门上的旗与那层光的 CSS 变量）。

**`/_astro/index.*.css` 那条探针时好时坏**，取决于首页那一批 CSS 的产物名（R44＋R45 那轮
空手，2026-08-28 又拿到 5870 字节）。**它不是硬判据** —— 空了不代表部署坏了，要验样式就
从页面 HTML 里正则出实际文件名再取。

**站上有三种语言（R46 起），所以每次上线都要顺带验两件事**，一整套判据抄在
`docs/部署运维.md` 的 R46 那节：

1. **中文那 18 个旧地址全部 200** —— 这是回归，改了路由或 `_headers` 尤其要跑；
2. **`/en/…` 与 `/ja/…` 同一页也 200，且 `<html lang>` 是对的**。只验中文会漏掉
   「新页面忘了带 `getStaticPaths` 的三条 locale」这类错，那时英日版就是 404。

改动碰到 `src/i18n/`、`_headers`、或任何 `getStaticPaths` 时，还要验 hreflang 四条、
三份 RSS 的 `<language>`、sitemap 的 `xhtml:link`、以及语言切换那三条链接上的
`data-astro-reload`（少了它切语言会留下半个页面的旧语言）。
排版层面另有一条本机断言：`PORT=8788 node scripts/i18n-check.mjs`（三语 × 三档视口，
非零退出码 = 没过），它要 `wrangler dev` 起着。

两条趁手的工具（R42 那轮加的）：

- **`https://duchenlin.top/cdn-cgi/trace`** 在自定义域名上可用，返回 `ip=`
  （**Cloudflare 侧看到的**出口 IP）、`colo=`（接入机房，实测是 `LAX`）、`loc=`。
  比另找 IP 回显服务准 —— 那些会因为本机代理给出不同答案。
  会话号是 `SHA-256('ip:'+IP)` 前 16 字节，要算它就靠这一条。
- **验对话相关的改动时用「接管」当探针，不花模型额度**：后台开接管 → 发一句 →
  它会挂住等人工回复 → 后台回一句。整条路不调上游，而且能顺带验到会话号算对了没有。

## ⑤ 推送

```bash
git push origin main
```

凭据由 Windows 的 GCM 提供，不需要 token 环境变量。推完 `git status -sb` 确认与 origin 同步。

## 出了问题怎么退回去

线上坏了就先回滚，再慢慢查 —— 站是公开的，别让它带着 500 过夜。

```bash
npx wrangler deployments list        # 找上一个好版本的 Version ID
npx wrangler rollback <VERSION_ID>   # 回到那一版
```

**这两条我没在本机跑过**（还没遇到需要回滚的部署），所以第一次用要盯着输出；
真用过之后把实测结果补进 `docs/部署运维.md`，并把这行「没跑过」删掉。
兜底的另一条路是把代码改回去重新 `deploy`（这条一定能用，只是慢一点）。

## 七个已知坑（看到这些别当成 bug）

1. **HIT 的 `cache-control` 被抬成 `max-age=14400`** —— zone 的 Browser Cache TTL（4 小时）在
   `cf-cache-status: HIT` 时改写它，源头仍是 300。带一个不重复的 query 再打一次就看得到真值。
2. **静态资源不支持 Range** —— 带 `Range` 也回 200 + 整段，`/audio/*.mp3` 是一次下完的。
3. **`*.workers.dev` 本机连不上** —— DNS 解析到非 Cloudflare 段，直连超时、代理握手失败。
4. **不接 Workers Builds** —— 2026-08-23 已定。
5. **给沉麟手敲的命令要写 PowerShell 语法**（他的终端是 PowerShell，没有 `unset`、`&&`）；
   能我代跑的就别让他手敲。
6. **别把 8788 的本地结果当线上结果** —— `.claude/launch.json` 里那个 `worker` 预览跑的是
   `wrangler dev`，服务的是本地 `dist/`。线上判据一律走 `https://duchenlin.top`。
7. **`npm run build` 之后必须重启 `wrangler dev`，否则新资源 404 —— 而那个 404 会被缓存一年。**
   wrangler 的资源清单是**启动时**建的，构建产生的新哈希文件它不认，请求直接 404；
   而 `public/_headers` 给 `/_astro/*` 的是 `max-age=31536000, immutable`，于是浏览器把
   **那个 404 缓存了一年** —— 之后就算重启了服务器，同一个 URL 仍然拿回 404，页面表现为
   「HTML 是新的、样式与脚本却是旧的／根本没生效」。本轮为此白查了好几遍。
   顺序固定：**改代码 → build → 重启预览 → 再打开页面**；已经中招的话换个端口
   （`worker-8789`）起一个新 origin，或者等哈希再变一次。

## 只做其中一段时

- **只提交不部署**：跑 ①②，并明确告诉他「线上还是旧版本」。
- **只部署不提交**：先 `git status` 确认工作区干净，或者确认差异是有意的 ——
  部署的是 `dist/` 不是 `HEAD`，两者会脱钩。
- **改动只在 `docs/`**：不需要重新部署（文档不进 `dist/`），提交 + 推送即可。

## 收尾报告

对着判据逐条报：提交号、Version ID、线上验证结果、以及**这次新照出来的任何线上口径** ——
后者要写进 `docs/部署运维.md` 的坑表与实测段、必要时在台账里开一条待决，不能只说在聊天里。
