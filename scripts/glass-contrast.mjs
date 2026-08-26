/**
 * 玻璃浮层上的字 —— 渲染出来逐像素量对比度。
 *
 * 为什么 `scripts/contrast.mjs` 顶不了：那一份比的是**不透明色对**（`--ink-x` 对
 * `--paper`），而浮层是玻璃 —— `--glass-under`（62% 纸色）+ `--glass-bg` 两层半透
 * 加 `backdrop-filter`，底下的正文会透上来把背景提亮一档。深色版次上这一档足以让
 * `--ink-faint` 从标注的 5.1:1 掉到 4.2 上下（R45 实测）。玻璃底只有渲染出来才知道。
 *
 * 怎么量：把目标文字临时 `visibility: hidden`，截它中心 **1×1 像素**得到真正的
 * 合成背景（含模糊、含底下压着什么），再与 computed color 按 WCAG 2.1 算比值。
 * 前景取 computed color 就够 —— 四套版次的 `--ink-*` / `--seal` 都是不透明 hex。
 *
 * 用法（dev server 要先起来）：
 *   PORT=4331 node scripts/glass-contrast.mjs        # 非零退出码 = 有新的不合格
 *   PORT=4331 SHOTS=1 node scripts/glass-contrast.mjs  # 顺带存左下角裁图
 *
 * 加新的浮层：往下面 STAGES 里加一项。`need` 不写按文字判（≥24px 或 ≥18.66px 粗体
 * 算大字 3:1，其余 4.5:1）；图标要显式写 `need: 3`（WCAG 1.4.11 非文本判据）。
 * `known` 填 DESIGN_SYSTEM_STATUS 里的问题编号 —— 那一项照旧打印，但不拉红退出码。
 */
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// 全局安装的 playwright（本项目不把它列为依赖：只在设计取证时用）
const { chromium } = require('C:/Users/DUE/AppData/Roaming/npm/node_modules/playwright');

const PORT = process.env.PORT || '4331';
const SHOTS = process.env.SHOTS === '1';
const THEMES = (process.env.THEMES || 'night,paper,film,neon').split(',');
const OUT = join(process.cwd(), '.tmpcolor', 'shots');

/** 解 1×1 PNG：单像素图无论哪种逐行滤波，参照像素都是 0，所以原值即实值 */
function pngPixel(buf) {
  let i = 8;
  const idat = [];
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    if (type === 'IEND') break;
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)); // [filter, R, G, B, (A)]
  return [raw[1], raw[2], raw[3]];
}

const lin = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/**
 * 分阶段的量测清单。`act` 是进入这一阶段要做的事（默认什么都不做）。
 * 目前只有左下角的对话入口（ChatDock）—— 顶栏与播放器的字都是 `--ink` / `--ink-soft`，
 * 那两档余量大；等哪天它们上了更淡的字，往这儿加。
 */
const STAGES = [
  {
    name: '提示纸条',
    wait: 3400, // 首访 2.6s 后才弹
    items: [
      { sel: '.ai__label', label: '键上的字 --ink' },
      { sel: '.ai__hint-t', label: '纸条标题 --ink' },
      { sel: '.ai__hint-d', label: '纸条说明 --ink-soft' },
      { sel: '.ai__hint-x', label: '纸条关闭 × 图标', need: 3 },
    ],
  },
  {
    name: '面板打开',
    act: async (p) => {
      await p.click('.ai__key');
    },
    wait: 500,
    items: [
      { sel: '.ai__who', label: '面板标题 --ink', known: 'B6' },
      { sel: '.ai__msg--ai', label: '开场白气泡 --ink-soft' },
      { sel: '.ai__tips-h', label: '三问小标 --ink-soft' },
      { sel: '.ai__tip', label: '三问 --seal' },
      { sel: '.ai__tip', label: '三问 hover --seal-hover', hover: true },
    ],
  },
  {
    /* dev 下没有 Worker，`/api/chat` 必然 404 —— 点一句正好拿到错误分支的真实渲染 */
    name: '问过一句',
    act: async (p) => {
      await p.click('.ai__tip');
    },
    wait: 1200,
    items: [
      { sel: '.ai__msg--me', label: '我说的那条 --ink' },
      { sel: '.ai__msg.is-bad', label: '出错气泡 --ink-faint', known: 'B6' },
      { sel: '.ai__in', label: '输入框的字 --ink' },
    ],
  },
];

/** 量一处：前景取 computed color，背景靠「藏起它再截 1×1」拿真实合成值 */
async function measure(page, item) {
  const meta = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cs = getComputedStyle(el);
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      color: cs.color,
      fs: parseFloat(cs.fontSize),
      fw: cs.fontWeight,
    };
  }, item.sel);
  if (!meta) return { ...item, miss: true };

  await page.evaluate((s) => {
    document.querySelector(s).style.setProperty('visibility', 'hidden', 'important');
  }, item.sel);
  await page.waitForTimeout(60);
  const buf = await page.screenshot({ clip: { x: meta.x, y: meta.y, width: 1, height: 1 } });
  await page.evaluate((s) => {
    document.querySelector(s).style.removeProperty('visibility');
  }, item.sel);

  const bg = pngPixel(buf);
  const fg = meta.color.match(/[\d.]+/g).slice(0, 3).map(Number);
  const large = meta.fs >= 24 || (meta.fs >= 18.66 && Number(meta.fw) >= 700);
  const need = item.need ?? (large ? 3 : 4.5);
  const got = +ratio(fg, bg).toFixed(2);
  return {
    ...item,
    fg: meta.color,
    bg: `rgb(${bg.join(', ')})`,
    px: `${meta.fs}px/${meta.fw}`,
    got,
    need,
    ok: got >= need,
  };
}

if (SHOTS) mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const rows = [];

for (const theme of THEMES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://localhost:${PORT}/home`, { waitUntil: 'networkidle' });
  // 开发工具条会拦掉 pointer events（Playwright 原话），先摘掉
  await page.evaluate(() => document.querySelector('astro-dev-toolbar')?.remove());
  await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
  await page.evaluate(() => document.fonts?.ready).catch(() => {});

  for (const stage of STAGES) {
    if (stage.act) await stage.act(page);
    await page.waitForTimeout(stage.wait ?? 300);
    if (SHOTS) {
      await page.screenshot({
        path: join(OUT, `glass.${theme}.${stage.name}.png`),
        clip: { x: 0, y: 380, width: 460, height: 520 },
      });
    }
    for (const item of stage.items) {
      // hover 之后要等一拍：色变有 .2s 的 transition，立刻量到的还是旧色
      if (item.hover) {
        await page.hover(item.sel).catch(() => {});
        await page.waitForTimeout(260);
      }
      rows.push({ theme, stage: stage.name, ...(await measure(page, item)) });
    }
  }
  await page.close();
}
await browser.close();

let bad = 0;
let known = 0;
for (const theme of THEMES) {
  console.log(`\n=== ${theme} ===`);
  for (const r of rows.filter((x) => x.theme === theme)) {
    if (r.miss) {
      console.log(`  ??   ${r.label}  <量不到，选择器过期了？>`);
      bad++;
      continue;
    }
    const tag = r.ok ? 'ok  ' : r.known ? `${r.known}  ` : 'FAIL';
    if (!r.ok) r.known ? known++ : bad++;
    console.log(
      `  ${tag} ${r.label.padEnd(22)} ${String(r.got).padStart(6)}:1  (需 ≥ ${r.need})` +
        `  ${r.px}  ${r.fg} on ${r.bg}`
    );
  }
}
console.log(
  `\n${bad ? `${bad} 处不合格` : '全部合格'}` +
    (known ? `（另有 ${known} 处已在 DESIGN_SYSTEM_STATUS 留档的存量，不计入退出码）` : '')
);
process.exit(bad ? 1 : 0);
