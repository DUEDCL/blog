/**
 * 版次色板的对比度核算 —— WCAG 2.1 相对亮度公式，本地跑，无依赖。
 *
 * 为什么要有它：`src/styles/themes.css` 里每个色值后面都跟着一个「x:1」注释，
 * 而手写的对比度注释是最容易撒谎的一种注释 —— 改了色值忘了改注释，下一个人
 * 就按错的数字做判断。这个脚本把注释变成可复算的东西：解析那个文件、算出
 * 全部前景/背景组合、和判据比，不合格的行标 FAIL。
 *
 * 用法：node scripts/contrast.mjs        （退出码非 0 表示有 FAIL）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'src', 'styles', 'themes.css'), 'utf8');

/** 把 `[data-theme='x']` / `:root` 块拆成 { 主题名: {token: 值} } */
function parseThemes(src) {
  const out = {};
  // 去掉注释，免得注释里的 `#xxxxxx` 被当成色值
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const blockRe = /([^{}]+)\{([^{}]+)\}/g;
  let m;
  while ((m = blockRe.exec(clean))) {
    const selector = m[1].trim();
    const body = m[2];
    const names = [];
    if (/:root/.test(selector)) names.push('night'); // `:root, [data-theme='night']`
    for (const t of selector.matchAll(/\[data-theme=['"]?([\w-]+)['"]?\]/g)) {
      if (!names.includes(t[1])) names.push(t[1]);
    }
    if (!names.length) continue;
    const tokens = {};
    for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens[d[1]] = d[2].trim();
    }
    for (const n of names) out[n] = { ...(out[n] || {}), ...tokens };
  }
  return out;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** WCAG 相对亮度 */
function lum([r, g, b]) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(fg, bg) {
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/* 判据：承载真实信息的文字一律按 WCAG AA（4.5:1）以上要求。
   --ink-faint 是日期与页脚链接 —— 它是信息不是装饰，所以也要 4.5，
   不给「小字可以淡一点」的例外。正文墨色按 AAA（7:1）要求。 */
const CHECKS = [
  ['--ink', '--paper', 7],
  ['--ink', '--paper-raised', 7],
  ['--ink-soft', '--paper', 4.5],
  ['--ink-soft', '--paper-raised', 4.5],
  ['--ink-faint', '--paper', 4.5],
  ['--ink-faint', '--paper-raised', 4.5],
  ['--seal', '--paper', 4.5],
  ['--seal', '--paper-raised', 4.5],
  ['--press', '--paper', 4.5],
  ['--press', '--paper-raised', 4.5],
  // 反色件：.skip-link 与 ::selection 是 seal 底上印纸色
  ['--paper', '--seal', 4.5],
];

const themes = parseThemes(css);
let fails = 0;

for (const [name, tokens] of Object.entries(themes)) {
  console.log(`\n=== ${name} ===`);
  for (const [fgName, bgName, min] of CHECKS) {
    const fg = tokens[fgName];
    const bg = tokens[bgName];
    if (!fg?.startsWith('#') || !bg?.startsWith('#')) continue;
    const r = ratio(hexToRgb(fg), hexToRgb(bg));
    const ok = r >= min;
    if (!ok) fails++;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${fgName.padEnd(11)} on ${bgName.padEnd(15)} ` +
        `${r.toFixed(2).padStart(6)}:1  (需 ≥ ${min})`
    );
  }
}

console.log(fails ? `\n${fails} 项不合格` : '\n全部合格');
process.exit(fails ? 1 : 0);
