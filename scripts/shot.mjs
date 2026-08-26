/**
 * 渲染取证：把本地 dev 站的若干页面截成图，供设计审计用。
 *
 * 存在的理由：本工作区的设计规则要求「只读代码不得给出 8 分以上」
 * （docs/design/ANTI_SLOP.md 第 2 节），而 Claude Code 的预览面板在
 * 未显示时不合成帧、截不了图。这个脚本用全局 playwright + 本机 Chrome
 * 绕开那个限制，产物落在 .tmpcolor/shots/（已被 gitignore）。
 *
 * 用法：
 *   node scripts/shot.mjs                     # 默认页面集，1280×900
 *   node scripts/shot.mjs /home /posts        # 指定路径
 *   PORT=4331 W=390 H=844 TAG=mobile node scripts/shot.mjs
 *   THEME=paper node scripts/shot.mjs         # 截图前把 data-theme 设成 paper
 *   SEL=.astro-code FULL=0 node scripts/shot.mjs /posts/x   # 滚到某元素再截视口
 *
 * ⚠ **Git Bash 下必须加 `MSYS_NO_PATHCONV=1`**：MSYS 会把看起来像路径的参数
 * （`/home`、`/posts`）改写成 Windows 路径，实测第一次跑出来的文件叫
 * `C:-Program Files-Git-home.png`，截的是一张 404 页。PowerShell 与 cmd 不受影响。
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// 全局安装的 playwright（本项目不把它列为依赖：只在设计取证时用）
const { chromium } = require('C:/Users/DUE/AppData/Roaming/npm/node_modules/playwright');

const PORT = process.env.PORT || '4331';
const W = Number(process.env.W || 1280);
const H = Number(process.env.H || 900);
const DPR = Number(process.env.DPR || 1);
const TAG = process.env.TAG || `${W}x${H}`;
const THEME = process.env.THEME || '';
const SEL = process.env.SEL || '';
const FULL = process.env.FULL !== '0';
const OUT = join(process.cwd(), '.tmpcolor', 'shots');

const paths = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['/home', '/posts', '/about', '/'];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: DPR,
});

for (const p of paths) {
  const url = `http://localhost:${PORT}${p}`;
  await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
  if (THEME) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, THEME);
  }
  // 字体与图片就位、入场动画跑完
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(900);
  if (SEL) {
    // 滚到指定元素（验证正文里某一段的渲染时用，配 FULL=0）
    await page
      .evaluate((s) => {
        document.querySelector(s)?.scrollIntoView({ block: 'center' });
      }, SEL)
      .catch(() => {});
    await page.waitForTimeout(400);
  }
  const name =
    (p === '/' ? 'gate' : p.replace(/^\//, '').replace(/\//g, '-')) +
    (THEME ? `.${THEME}` : '') +
    `.${TAG}.png`;
  await page.screenshot({ path: join(OUT, name), fullPage: FULL });
  console.log('shot', name);
}

await browser.close();
