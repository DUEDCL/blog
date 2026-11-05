/**
 * Run after npm run build. No production auth, upstream mutation or account writes.
 * A real local HTTP server is required: Playwright routing disables the browser cache.
 * PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE may select existing local installations.
 * QA: cached old URL, positive/empty/error search, malformed local history, favorite
 * toggling, overlapping requests and ClientRouter navigation back to the TV page.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve('dist');
const html = await readFile(path.join(root, 'tv/index.html'), 'utf8');
const client = await readFile('public/tv/app.js', 'utf8');
const expectedHash = createHash('sha256').update(client).digest('hex').slice(0, 16);
assert.ok(html.includes(`/tv/app.js?v=${expectedHash}`), 'built HTML must reference content-versioned app.js');
const headerRules = await readFile('public/_headers', 'utf8');
assert.ok(!/^\/tv\/\*\.js\s*$/m.test(headerRules), 'overlapping TV cache rules must be removed');
assert.match(headerRules, /\/tv\/\*\r?\n\s+Cache-Control: no-cache, must-revalidate/);

const sources = [{ id: 'fixture', name: '测试源', api: 'https://example.invalid/' }];
const group = name => ({ name, key: name, rating: 0, score: 1, typeName: '测试', area: '', year: '', pic: '', remarks: '', candidates: [{ sourceId: 'fixture', sourceName: '测试源', vodId: '1', hasHls: false, hlsLabels: [], lineCount: 0, episodeCount: 0 }] });
let deployed = false;
let oldRequests = 0;
let newRequests = 0;
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/seed-old') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      return res.end('<!doctype html><script src="/tv/app.js"></script>');
    }
    if (u.pathname === '/tv/app.js') {
      if (!u.search) {
        oldRequests++;
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=604800' });
        return res.end(deployed ? client : 'window.__cachedLegacyTv = true;');
      }
      newRequests++;
      assert.equal(u.searchParams.get('v'), expectedHash);
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache, must-revalidate' });
      return res.end(client);
    }
    if (u.pathname === '/api/site/me') return json(res, { ok: true, user: null });
    if (u.pathname === '/api/tv/sources') return json(res, { sources, live: [] });
    if (u.pathname === '/api/tv/hist') return json(res, { ok: false, error: '需要登录' }, 401);
    if (u.pathname === '/api/tv/search') {
      const q = u.searchParams.get('q');
      if (q === '服务错误') return json(res, { error: '测试服务不可达' }, 502);
      if (q === '格式错误') return json(res, { groups: {}, sources: [] });
      if (q === '慢结果') await new Promise(resolve => setTimeout(resolve, 350));
      return json(res, { groups: q === '空结果' ? [] : [group(q), group(`${q}第二季`)], sources: [{ id: 'fixture', name: '测试源', ok: true }], tookMs: 1 });
    }
    if (u.pathname.startsWith('/api/')) return json(res, { error: 'fixture only' }, 404);
    let file = path.resolve(root, '.' + decodeURIComponent(u.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
    if (u.pathname.endsWith('/')) file = path.join(file, 'index.html');
    let bytes;
    try {
      bytes = await readFile(file);
    } catch (e) {
      // /home 这类无尾斜杠路径解析到目录，取它的 index.html
      if (e.code !== 'EISDIR') throw e;
      file = path.join(file, 'index.html');
      bytes = await readFile(file);
    }
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(bytes);
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/seed-old`);
  assert.equal(await page.evaluate(() => window.__cachedLegacyTv), true);
  assert.equal(oldRequests, 1);
  deployed = true;
  await page.goto(`${base}/seed-old`);
  assert.equal(await page.evaluate(() => window.__cachedLegacyTv), true, 'existing fixed-URL script really remains cached');
  assert.equal(oldRequests, 1, 'warm cache must not contact server for bare app.js');
  await page.goto(`${base}/tv/`);
  await page.locator('[data-src-id="fixture"]').waitFor();
  assert.equal(await page.evaluate(() => window.__cachedLegacyTv), undefined);
  assert.ok(newRequests > 0, 'versioned URL must fetch new code despite old cache');
  async function search(q) {
    await page.locator('[data-tv-q]').fill(q);
    await page.locator('.tv-search__btn').click();
    await page.waitForFunction(() => !document.querySelector('[data-tv-status]').textContent.includes('正在并发搜索'));
  }
  await search('缓存更新测试');
  assert.equal(await page.locator('[data-tv-grid] .tv-card:not(.tv-card--sk)').count(), 2);
  const star = page.locator('[data-tv-grid] [data-fav]').first();
  await star.click();
  assert.equal(await star.getAttribute('aria-pressed'), 'true');
  await star.click();
  assert.equal(await star.getAttribute('aria-pressed'), 'false');
  await search('空结果');
  assert.equal(await page.locator('[data-tv-grid] .tv-card').count(), 0);
  assert.match(await page.locator('[data-tv-empty]').innerText(), /没有找到/);
  await search('服务错误');
  assert.match(await page.locator('[data-tv-status]').innerText(), /搜索请求失败/);
  await search('格式错误');
  assert.match(await page.locator('[data-tv-status]').innerText(), /格式异常/);

  await page.evaluate(() => {
    localStorage.setItem('tv:q', '{"wrong":"shape"}');
    localStorage.setItem('tv:prog', 'null');
    localStorage.setItem('tv:fav', '[null]');
  });
  await page.reload();
  await page.locator('[data-src-id="fixture"]').waitFor();
  await search('损坏历史测试');
  assert.equal(await page.locator('[data-tv-grid] .tv-card').count(), 2);
  await page.locator('[data-tv-q]').fill('慢结果');
  await page.locator('.tv-search__btn').click();
  await page.locator('[data-tv-q]').fill('快结果');
  await page.locator('.tv-search__btn').click();
  await page.waitForFunction(() => document.querySelector('.tv-card__title')?.textContent === '快结果');
  await page.waitForTimeout(450); // deliberate out-of-order response completion
  assert.equal(await page.locator('.tv-card__title').first().innerText(), '快结果');

  // Use actual links for ClientRouter navigation, not a synthetic page-load event.
  // Real path into /tv: /home --nav--> /tools --link--> /tv. This is the risky case
  // (script must boot via astro:page-load after a client-side swap).
  await page.goto(`${base}/home/`);
  await page.locator('a[href="/tools"]').first().click();
  await page.waitForURL(/\/tools\/?$/);
  const toTv = page.locator('a[href="/tv"]').first();
  assert.ok(await toTv.count(), '/tools must keep its link to /tv');
  await toTv.click();
  await page.waitForURL(/\/tv\/?$/);
  await page.locator('[data-src-id="fixture"]').waitFor();
  await search('换页返回测试');
  assert.equal(await page.locator('[data-tv-grid] .tv-card').count(), 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: true, contentVersion: expectedHash, oldRequests, newRequests, checks: ['warm-browser-cache', 'search', 'favorite-on-off', 'empty', 'HTTP-error', 'invalid-payload', 'malformed-history', 'latest-request-wins', 'SPA-return'], pageErrors: errors }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
