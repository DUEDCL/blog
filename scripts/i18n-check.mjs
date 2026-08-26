/**
 * 多语言排版的断言 —— 把 R46 那套三语版面里「只读代码看不出来」的三件事量出来。
 *
 * 为什么值得有它（与 `measure.mjs` 同一条理由）：本工作区的设计规则要求每套视觉词汇
 * 至少有一个**可断言的几何量**，否则它会在下一次重构里静默漂走。多语言把这件事放大了
 * 一档 —— 同一套版面要同时容下「版次」（2 汉字）与 `Edition`（7 拉丁字母），
 * 而顶栏那一行是全站最挤的地方。
 *
 * 量三件事：
 *   ① 顶栏第一行在三种语言 × 三档视口下**有没有横向溢出**（英文的 Edition/Language
 *      比中文那两个词宽出一截，窄屏那一行最可能被挤破）；
 *   ② 竖排栏目标识在西文下是不是**整词侧躺**而不是逐字母正立
 *      （global.css 那条 `html[lang='en'] .vlabel`），以及它侧躺之后有多高；
 *   ③ 语言菜单展开后**朝左展开、不越出视口** —— 它 `right: 0` 对齐的是自己那枚键，
 *      而那枚键在版次键左边，320px 那一档最容易把菜单左边缘顶到视口外面去
 *      （首次实测就是 -31px，`.topmenu` 的 min-width 因此在 LangSwitch 里收到了 10rem）。
 *
 * 用法：`PORT=8788 node scripts/i18n-check.mjs`
 *   端口给 `wrangler dev`（8788，`npm run build` 之后）或 `astro dev`（4331）都行。
 *   非零退出码 = 有一项没过，输出里那一行末尾会标「← 有问题」。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/* 全局安装的 playwright（本项目不把它列为依赖：只在设计取证时用，与 shot.mjs 一致） */
const { chromium } = require('C:/Users/DUE/AppData/Roaming/npm/node_modules/playwright');

const PORT = process.env.PORT || '8788';
const browser = await chromium.launch({ channel: 'chrome' });

const PAGES = [
  { label: 'zh', path: '/posts/' },
  { label: 'en', path: '/en/posts/' },
  { label: 'ja', path: '/ja/posts/' },
];
const VIEWPORTS = [
  [1280, 900],
  [390, 844],
  [320, 640],
];

const rows = [];

for (const { label, path } of PAGES) {
  for (const [w, h] of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.waitForTimeout(500);

    const m = await page.evaluate(() => {
      const bar = document.querySelector('.bar__inner');
      const de = document.documentElement;
      const vl = document.querySelector('.vlabel');
      const vlb = vl?.getBoundingClientRect();
      const vlcs = vl ? getComputedStyle(vl) : null;

      /* 顶栏第一行占了多少：品牌 + 两枚下拉键（窄屏时导航折到第二行去了，
         所以只数那三个，用它们各自的右边缘算出「第一行最右到哪儿」） */
      const first = [...(bar?.children ?? [])]
        .map((el) => ({ cls: el.className, b: el.getBoundingClientRect() }))
        .filter((x) => x.b.width > 0 && x.b.height > 0);
      const rowTop = Math.min(...first.map((x) => x.b.top));
      const sameRow = first.filter((x) => x.b.top - rowTop < 4);

      return {
        docOverflow: de.scrollWidth - de.clientWidth,
        barOverflow: bar ? bar.scrollWidth - bar.clientWidth : null,
        rowRight: Math.round(Math.max(...sameRow.map((x) => x.b.right))),
        rowItems: sameRow.map((x) => `${x.cls}:${Math.round(x.b.width)}`),
        edKey: document.querySelector('#ed-key')?.textContent?.trim(),
        langKey: document.querySelector('#lang-key')?.textContent?.trim(),
        vlabel: vl
          ? {
              text: vl.textContent,
              orientation: vlcs.textOrientation,
              tracking: vlcs.letterSpacing,
              w: Math.round(vlb.width),
              h: Math.round(vlb.height),
            }
          : null,
        titleH: Math.round(
          document.querySelector('.head__title')?.getBoundingClientRect().height ?? 0
        ),
      };
    });

    /* 语言菜单展开：右边缘不许越出视口，左边缘不许被切掉 */
    await page.click('#lang-key');
    await page.waitForTimeout(120);
    const menu = await page.evaluate(() => {
      const el = document.querySelector('#lang-menu');
      if (!el || el.hidden) return null;
      const b = el.getBoundingClientRect();
      return {
        left: Math.round(b.left),
        right: Math.round(b.right),
        w: Math.round(b.width),
        items: [...el.querySelectorAll('.topopt__name')].map((e) => e.textContent),
        current: el.querySelector('[aria-current="true"] .topopt__name')?.textContent,
        overflowRight: Math.round(b.right - innerWidth),
        overflowLeft: Math.round(-b.left),
      };
    });

    rows.push({ label, w, h, ...m, menu });
    await page.close();
  }
}

/* ---- 语言切换的端到端 ----------------------------------------------------
   点菜单里的另一种语言，看两件事：

   ① **落在同一页的另一种语言**（`switchPath()` 的活）——「点一下从英文页掉回中文首页」
      是这类站最常见的坏法。
   ② **状态栏的文案跟着换了**。这一条其实是在验 `data-astro-reload`：状态栏
      （MiniPlayer）是 `transition:persist` 的，SPA swap 时它**不重新渲染** ——
      少了那个属性，切换之后正文是新语言、播放器上还写着旧语言的「播放」。
      这里读的是它根节点上的 `data-jk-t`（服务端投影进去的那份客户端文案），
      它变了才说明这次导航是真的整页刷新。 */
const CASES = [
  { from: '/posts/', pick: 'English', want: '/en/posts/', wantLabel: 'Play' },
  { from: '/en/posts/', pick: '日本語', want: '/ja/posts/', wantLabel: '再生' },
  { from: '/ja/about/', pick: '简体中文', want: '/about/', wantLabel: '播放' },
];
const switches = [];

for (const c of CASES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://localhost:${PORT}${c.from}`, { waitUntil: 'networkidle' });
  await page.click('#lang-key');
  await page.waitForTimeout(100);
  await page.click(`#lang-menu .topopt__name >> text=${c.pick}`);
  /* `waitForURL` 而不是 `waitForNavigation`（后者在 Playwright 里已弃用）。
     catch 掉超时：落错地址时也要把实际落点报出来，而不是在这儿抛栈 */
  await page
    .waitForURL(`**${c.want}`, { waitUntil: 'networkidle', timeout: 8000 })
    .catch(() => {});
  await page.waitForTimeout(300);

  const got = await page.evaluate(() => {
    const raw = document.querySelector('[data-jk-t]')?.dataset.jkT;
    let play = '(没有 data-jk-t)';
    try {
      play = JSON.parse(raw ?? '{}').play ?? '(没有 play)';
    } catch {
      play = '(JSON 坏了)';
    }
    return { path: location.pathname, play };
  });

  switches.push({ ...c, landed: got.path, playLabel: got.play });
  await page.close();
}

await browser.close();

let bad = 0;
for (const r of rows) {
  const over = r.docOverflow > 0 || r.barOverflow > 0;
  const menuOver = r.menu ? r.menu.overflowRight > 0 || r.menu.overflowLeft > 0 : true;
  if (over || menuOver) bad += 1;
  console.log(
    `${r.label} ${String(r.w).padStart(4)}×${r.h}  ` +
      `doc溢出=${r.docOverflow} bar溢出=${r.barOverflow} ` +
      `第一行右边缘=${r.rowRight}/${r.w} [${r.rowItems.join(' ')}] ` +
      `键=[${r.langKey} | ${r.edKey}] ` +
      `vlabel=${r.vlabel ? `${r.vlabel.text}/${r.vlabel.orientation}/${r.vlabel.tracking}/${r.vlabel.w}×${r.vlabel.h}` : 'none'} ` +
      `标题高=${r.titleH} ` +
      `菜单=${r.menu ? `${r.menu.left}→${r.menu.right}(w${r.menu.w}) 当前=${r.menu.current} 溢出 右${r.menu.overflowRight}/左${r.menu.overflowLeft}` : '未展开'}` +
      (over || menuOver ? '   ← 有问题' : '')
  );
}

console.log('');
for (const s of switches) {
  const ok = s.landed === s.want && s.playLabel === s.wantLabel;
  if (!ok) bad += 1;
  console.log(
    `切换 ${s.from} → 菜单里点「${s.pick}」：落在 ${s.landed}（应为 ${s.want}）` +
      `／状态栏文案=${s.playLabel}（应为 ${s.wantLabel}）` +
      (ok ? '' : '   ← 有问题')
  );
}

console.log(
  bad === 0
    ? '\n全部通过：无横向溢出，菜单全部在视口内，语言切换整页换语言。'
    : `\n${bad} 项有问题。`
);
process.exit(bad === 0 ? 0 : 1);
