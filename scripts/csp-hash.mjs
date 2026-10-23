#!/usr/bin/env node
/**
 * csp-hash.mjs —— 把 dist 里真实的内联脚本 hash 写进 dist/_headers 的 CSP 行。
 *
 * 为什么必须自动算：站上有 9 段内联脚本（主题门、i18n 切换、账号菜单、滚动导航、
 * AI 组件、view transitions），它们由 Astro 内联产出，**内容一改 hash 就变**。
 * 手写死的 hash 会在下一次改版后静默失效，CSP 一 enforce 就是整站脚本全灭。
 *
 * 这个脚本挂在 npm run build 的末尾（astro build 之后），只改 dist/_headers，
 * 不回写 public/_headers —— 源文件里那一行保持「无 hash」的干净形态。
 *
 * 找不到 CSP 行就非零退出：那说明有人删了 _headers 里的全局块，
 * 静默通过等于让 CSP 悄悄消失。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIST = 'dist';
const HEADERS = path.join(DIST, '_headers');
const LINE_PREFIX = '  Content-Security-Policy-Report-Only: ';

function htmlFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) htmlFiles(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const hashes = new Set();
let inlineCount = 0;
for (const f of htmlFiles(DIST)) {
  const html = fs.readFileSync(f, 'utf8');
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = m[1];
    if (!body.trim()) continue;
    inlineCount++;
    hashes.add(crypto.createHash('sha256').update(body, 'utf8').digest('base64'));
  }
}

if (!fs.existsSync(HEADERS)) {
  console.error('csp-hash: 找不到 dist/_headers —— public/_headers 丢了吗？');
  process.exit(1);
}

const lines = fs.readFileSync(HEADERS, 'utf8').split('\n');
const i = lines.findIndex((l) => l.startsWith(LINE_PREFIX));
if (i < 0) {
  console.error('csp-hash: dist/_headers 里没有 ' + LINE_PREFIX.trim() + ' 这一行');
  process.exit(1);
}

const csp = lines[i].slice(LINE_PREFIX.length);
if (!csp.includes("script-src 'self'")) {
  console.error("csp-hash: CSP 里没有 script-src 'self'，无法定位插入点");
  process.exit(1);
}
const list = [...hashes].sort().map((h) => " 'sha256-" + h + "'").join('');
lines[i] = LINE_PREFIX + csp.replace("script-src 'self'", "script-src 'self'" + list);

fs.writeFileSync(HEADERS, lines.join('\n'));
console.log('CSP：' + inlineCount + ' 段内联脚本 → ' + hashes.size + ' 个 hash 已写入 dist/_headers');
