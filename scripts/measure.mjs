/**
 * 版面度量 —— 把「对开大版」宣称的几个数字量出来，供断言用。
 *
 * 为什么要有它：本工作区的设计规则（VISUAL_VOCABULARY 第 0 节第 ⑤ 步）要求每套
 * 视觉词汇至少有一个**可断言的几何量**，理由是「设计如果只能靠肉眼比对，它就会在
 * 下一次重构里静默漂走」。这个脚本量的是：
 *   · 顶栏占位高度（宽屏 / 窄屏）—— global.css 的 --header-offset 依赖它，
 *     两处一旦不一致，锚点跳转就会把标题藏到顶栏底下
 *   · 两栏的实际像素宽与天沟宽 —— home.astro 那条 2.1:1 的注释算过账，这里复核
 *   · 字号跨度 —— 「层级由字号跨度承担」这句宣称要能量出来
 *
 * 用法：node scripts/measure.mjs     （dev server 要先起来）
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/DUE/AppData/Roaming/npm/node_modules/playwright');

const PORT = process.env.PORT || '4331';
const URL = `http://localhost:${PORT}/home`;

const browser = await chromium.launch({ channel: 'chrome' });

async function measure(w, h, label) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(600); // 入场动画（rise 四档 delay 最长 .3s）跑完再量

  const out = await page.evaluate(() => {
    const px = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
    const fs = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : null;
    };
    const header = document.querySelector('.site-header');
    const main = document.querySelector('.front__main');
    const side = document.querySelector('.front__side');
    const cs = getComputedStyle(document.documentElement);

    return {
      headerH: header ? Math.round(header.getBoundingClientRect().height) : null,
      headerOffset: cs.getPropertyValue('--header-offset').trim(),
      wrap: px(document.querySelector('main.wrap')),
      main: px(main),
      side: px(side),
      gutter:
        main && side
          ? Math.round(
              side.getBoundingClientRect().left - main.getBoundingClientRect().right
            )
          : null,
      /* 视觉天沟：左栏内容右沿到右栏**内容**左沿。上面那个 gutter 是 border box
         之间的距离，因为右栏用负 margin 把分栏线推到了天沟正中，两者差一个 padding */
      gutterVisual:
        main && side
          ? Math.round(
              side.getBoundingClientRect().left -
                main.getBoundingClientRect().right +
                parseFloat(getComputedStyle(side).paddingLeft)
            )
          : null,
      type: {
        masthead: fs('.mast__name'),
        headline: fs('.lead__title'),
        brief: fs('.brief__title'),
        meta: fs('.mast__meta'),
      },
    };
  });

  console.log(`\n=== ${label} (${w}×${h}) ===`);
  console.log(`顶栏占位   ${out.headerH}px   （--header-offset = ${out.headerOffset}）`);
  console.log(`版心       ${out.wrap}px`);
  const single = out.gutterVisual !== null && out.gutterVisual < 0;
  console.log(
    single
      ? `左栏/右栏  ${out.main} / ${out.side}px   单列（窄屏塌成一栏，分栏线转横线）`
      : `左栏/右栏  ${out.main} / ${out.side}px   天沟 ${out.gutterVisual}px（线位 +${out.gutter}px）`
  );
  console.log(
    `字号跨度   刊名 ${out.type.masthead} → 头条 ${out.type.headline} → ` +
      `条目 ${out.type.brief} → 刊眉 ${out.type.meta}  ` +
      `（${(out.type.masthead / out.type.meta).toFixed(1)} 倍）`
  );
  await page.close();
  return out;
}

const wide = await measure(1280, 900, '宽屏');
const narrow = await measure(390, 844, '窄屏');

await browser.close();

/* 判据：--header-offset 必须 ≥ 顶栏实测高度，否则锚点跳转后标题被顶栏盖住。
   两档分别验（窄屏顶栏会折行，高度完全不同）。 */
let bad = 0;
for (const [label, m] of [
  ['宽屏', wide],
  ['窄屏', narrow],
]) {
  const offset = parseFloat(m.headerOffset) * 16; // rem → px
  if (!(offset >= m.headerH)) {
    console.log(
      `\nFAIL ${label}：--header-offset ${Math.round(offset)}px < 顶栏 ${m.headerH}px`
    );
    bad++;
  }
}
console.log(bad ? `\n${bad} 项不合格` : '\n锚点偏移两档都够');
process.exit(bad ? 1 : 0);
