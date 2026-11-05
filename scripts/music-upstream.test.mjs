/**
 * Run: node --test scripts/music-upstream.test.mjs
 * Optional bounded real probes: MUSIC_LIVE=1 node --test scripts/music-upstream.test.mjs
 * Uses the already-installed esbuild only; never installs dependencies or deploys.
 * A live URL + verified media prefix is NOT a claim of browser playback/completeness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/lib/music/index.ts'], bundle: true, write: false,
  format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
});
const { createMusicApi, MUSIC_CACHE_VERSION } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const url = (path, params = {}) => new URL('/api/music/' + path + '?' + new URLSearchParams(params), 'https://example.test');
const response = (data, init = {}) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' }, ...init });
const song = (id = 1330348068) => ({ id, name: '起风了', artists: [{ name: '歌手甲' }, { name: '歌手乙' }], album: { name: '专辑', picUrl: 'https://p1.music.126.net/cover.jpg' } });
const remote = (id = 1330348068, patch = {}) => ({ id, code: 200, url: 'http://m801.music.126.net/audio.mp3', freeTrialInfo: null, ...patch });
const mp3 = (init = {}) => {
  const bytes = new Uint8Array(512);
  bytes.set([0x49, 0x44, 0x33, 4]);
  return new Response(bytes, { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-511/5214920' }, ...init });
};
const stub = (callback, options) => {
  const calls = [];
  const api = createMusicApi({ ...options, fetch: async (raw, init) => {
    const request = { url: new URL(raw), init };
    calls.push(request);
    return callback(request, calls.length);
  } });
  return { api, calls };
};
const read = async (res, status = 200) => {
  assert.equal(res.status, status);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  if (status !== 200) assert.equal(res.headers.get('cache-control'), 'no-store');
  return res.json();
};
const old = { id: '1330348068', source: 'netease', sign: 'old-proxy-sign' };

/**
 * The `url` route now probes the relay (api.injahow.cn) BEFORE the official API,
 * because the official endpoint refuses Cloudflare's egress and its outer/url
 * shortcut 302s to /404 for many tracks. Tests that target the official path must
 * therefore answer the relay probe first. `relayAudio()` = relay says "playable".
 */
const RELAY_HOST = 'api.injahow.cn';
const relayAudio = (init = {}) => {
  const bytes = new Uint8Array(2048);
  bytes.set([0x49, 0x44, 0x33, 4]);
  return new Response(bytes, { status: 206, headers: { 'content-type': 'audio/mpeg', 'access-control-allow-origin': '*' }, ...init });
};
const relayMiss = () => new Response('', { status: 200, headers: { 'content-type': 'text/html' } });
const isRelay = u => u.hostname === RELAY_HOST;

// Existing frontend contract: JukeTrack, {url}, {lyric,tlyric}, and safe {error}.
test('official search normalizes old/new artist fields and clamps count', async () => {
  const { api, calls } = stub(() => response({ code: 200, result: { songs: [song(), { id: 2, name: '第二首', ar: [{ name: '乙' }], al: { name: '另一专辑' } }], songCount: 2 } }));
  const res = await api(url('search', { q: ' 起风了 & type=9 ', n: '99999' }));
  const data = await read(res);
  assert.equal(calls[0].url.searchParams.get('s'), '起风了 & type=9');
  assert.equal(calls[0].url.searchParams.get('type'), '1');
  assert.equal(calls[0].url.searchParams.get('limit'), '30');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(data.items[0].artist, '歌手甲 / 歌手乙');
  assert.equal(data.items[0].picId, '1330348068');
  assert.equal(data.items[0].urlId, data.items[0].songId);
  assert.equal(data.items[0].source, 'netease');
  assert.ok(data.items[0].sign);
  assert.equal(data.items[1].album, '另一专辑');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  assert.ok(MUSIC_CACHE_VERSION);
});

test('search respects n and explicit zero results without treating malformed 200 as empty', async () => {
  const good = stub(() => response({ code: 200, result: { songs: [song(1), song(2)], songCount: 2 } }));
  assert.equal((await read(await good.api(url('search', { q: '歌', n: '1' })))).items.length, 1);
  const empty = stub(() => response({ code: 200, result: { songCount: 0 } }));
  assert.deepEqual(await read(await empty.api(url('search', { q: '不存在' }))), { items: [] });
  assert.equal(empty.calls.length, 1);
});

for (const [name, bad] of [
  ['HTTP failure', () => response({ secret: 'upstream internals' }, { status: 503 })],
  ['HTML 200', () => new Response('<html>private traceback</html>', { headers: { 'content-type': 'text/html' } })],
  ['truncated JSON', () => new Response('{"code":200,"result":')],
  ['business error 200', () => response({ code: 20001, msg: 'private traceback' })],
  ['malformed array 200', () => response({ code: 200, result: { songs: [{ name: 'no ID' }], songCount: 1 } })],
  ['network exception', () => { throw new Error('https://private.invalid?secret=private'); }],
]) {
  test(`official fallback handles ${name}`, async () => {
    const { api, calls } = stub((_, count) => count === 1 ? bad() : response({ code: 200, result: { songs: [song()], songCount: 1 } }));
    assert.equal((await read(await api(url('search', { q: '起风了' })))).items.length, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(c => c.url.hostname), ['music.163.com', 'interface.music.163.com']);
  });
}

test('Meting search fallback uses only validated IDs, never its untrusted audio URL', async () => {
  const { api, calls } = stub(({ url: u }) => u.hostname === 'api.i-meto.com'
    ? response([
      { title: 'valid', author: '歌手', url: 'https://api.i-meto.com/meting/api?server=netease&type=url&id=123&auth=old' },
      { title: 'bad host', url: 'https://evil.invalid/?server=netease&type=url&id=4' },
      { title: 'other source', url: 'https://api.i-meto.com/meting/api?server=tencent&type=url&id=9' },
    ])
    : response({ code: 503 }));
  const data = await read(await api(url('search', { q: '测试' })));
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].songId, '123');
  assert.ok(!JSON.stringify(data).includes('auth=old'));
  assert.ok(!calls.some(c => c.url.hostname === 'api.injahow.cn'));
});

test('default playlist fills 315 public IDs in <=100 batches and preserves original order', async () => {
  const ids = Array.from({ length: 315 }, (_, i) => i + 1);
  const { api, calls } = stub(({ url: u }) => {
    if (u.pathname.endsWith('/playlist/detail')) return response({ code: 200, playlist: { id: 12607934375, trackCount: ids.length, trackIds: ids.map(id => ({ id })), tracks: ids.slice(0, 6).map(song) } });
    const batch = JSON.parse(u.searchParams.get('ids'));
    assert.ok(batch.length <= 100);
    return response({ code: 200, songs: batch.reverse().map(song) });
  });
  const data = await read(await api(url('list', { id: '12607934375' })));
  assert.deepEqual(data.items.map(item => item.songId), ids.map(String));
  assert.equal(calls.length, 5);
  assert.equal(data.partial, undefined);
});

test('playlist caps at 330 and reports truncation instead of claiming complete', async () => {
  const ids = Array.from({ length: 400 }, (_, i) => i + 1);
  const { api } = stub(({ url: u }) => u.pathname.endsWith('/playlist/detail')
    ? response({ code: 200, playlist: { id: 3778678, trackCount: ids.length, trackIds: ids.map(id => ({ id })), tracks: ids.map(song) } })
    : assert.fail('no detail hydration needed'));
  const data = await read(await api(url('list', { id: '3778678' })));
  assert.equal(data.items.length, 330);
  assert.equal(data.partial, true);
  assert.equal(data.total, 400);
});

test('valid empty playlist stays empty, incomplete official listing falls back to metadata only', async () => {
  const empty = stub(() => response({ code: 200, playlist: { id: 3778678, trackCount: 0, trackIds: [], tracks: [] } }));
  assert.deepEqual(await read(await empty.api(url('list', { id: '3778678' }))), { items: [] });
  const fallback = stub(({ url: u }) => u.hostname === 'api.injahow.cn'
    ? response([{ name: '回退曲目', artist: '歌手', url: 'https://api.injahow.cn/meting/?server=netease&type=url&id=1330348068' }])
    : response({ code: 200, playlist: { id: 3778678, trackCount: 315, trackIds: [{ id: 1 }], tracks: [song(1)] } }));
  const data = await read(await fallback.api(url('list', { id: '3778678' })));
  assert.equal(data.items[0].title, '回退曲目');
  assert.equal(fallback.calls.length, 3);
});

test('last metadata fallback rejects fake successful objects and reports no-store errors', async () => {
  const { api, calls } = stub(() => response({ error: 'private signature text' }));
  const data = await read(await api(url('list', { id: '3778678' })), 502);
  assert.equal(calls.length, 4);
  assert.ok(!data.error.includes('private'));
  assert.ok(data.error.includes('站内曲目'));
});

test('legacy picId/sign use songId and matching official album cover', async () => {
  const { api, calls } = stub(() => response({ code: 200, songs: [song(1808652335)] }));
  const data = await read(await api(url('pic', { id: '109951166341738895', song: '1808652335', source: 'netease', sign: 'old-sign' })));
  assert.equal(data.url, 'https://p1.music.126.net/cover.jpg');
  assert.deepEqual(JSON.parse(calls[0].url.searchParams.get('ids')), ['1808652335']);
  assert.equal(calls[0].url.searchParams.has('sign'), false);
});

test('lyric timestamps are required; explicit absent lyrics are valid and not cached', async () => {
  const full = stub(() => response({ code: 200, lrc: { lyric: '[00:00.00] 一行歌词' }, tlyric: { lyric: '签名错误' } }));
  const res = await full.api(url('lyric', { ...old, song: old.id }));
  assert.deepEqual(await read(res), { lyric: '[00:00.00] 一行歌词', tlyric: '' });
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
  const empty = stub(() => response({ code: 200, nolyric: true }));
  const absent = await empty.api(url('lyric', { ...old, song: old.id }));
  assert.deepEqual(await read(absent), { lyric: '', tlyric: '' });
  assert.equal(absent.headers.get('cache-control'), 'no-store');
  const errorLyric = stub(() => response({ code: 200, lrc: { lyric: '签名错误' } }));
  assert.deepEqual(await read(await errorLyric.api(url('lyric', { ...old, song: old.id }))), { lyric: '', tlyric: '' });
});

test('URL prefers the relay when it serves real audio, without touching the official API', async () => {
  for (const params of [old, { id: old.id, source: 'netease' }]) {
    const { api, calls } = stub(({ url: u }) => isRelay(u) ? relayAudio() : response({ code: 200, data: [remote()] }));
    const res = await api(url('url', params));
    assert.deepEqual(await read(res), {
      url: 'https://api.injahow.cn/meting/?server=netease&type=url&id=1330348068',
      verified: true,
      via: 'relay',
    });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls.map(c => c.url.hostname), [RELAY_HOST]);
    assert.equal(calls[0].url.searchParams.has('sign'), false);
  }
});

test('URL falls back to the official API when the relay answers HTML instead of audio', async () => {
  let cancelled = false;
  const { api, calls } = stub(({ url: u, init }) => {
    if (isRelay(u)) return relayMiss();
    if (u.hostname === 'music.163.com') return response({ code: 200, data: [remote()] });
    assert.equal(init.headers.range, 'bytes=0-511');
    const bytes = new Uint8Array(512); bytes.set([0x49, 0x44, 0x33]);
    return new Response(new ReadableStream({ start(ctrl) { ctrl.enqueue(bytes); }, cancel() { cancelled = true; } }), { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-511/5214920' } });
  });
  const res = await api(url('url', old));
  assert.deepEqual(await read(res), { url: 'https://m801.music.126.net/audio.mp3', bytes: 5214920, verified: true });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(cancelled, true);
  assert.deepEqual(calls.map(c => c.url.hostname), [RELAY_HOST, 'music.163.com', 'm801.music.126.net']);
});

for (const code of [-110, 403, 404, 451]) {
  test(`explicit rights/unavailable code ${code} is reported only after the relay also misses`, async () => {
    // The relay answering HTML = "this track is not available here"; the official
    // row then supplies the authoritative rights verdict. Neither is guessed.
    const { api, calls } = stub(({ url: u }) => isRelay(u) ? relayMiss() : response({ code: 200, data: [remote(undefined, { code, url: null, fee: 1 })] }));
    const data = await read(await api(url('url', { ...old, name: '特别的人', artist: '方大同' })), 403);
    assert.match(data.error, /会员、版权或地区/);
    assert.deepEqual(calls.map(c => c.url.hostname), [RELAY_HOST, 'music.163.com']);
  });
}

test('player row 500 retries official host, explicit preview gets short marker without size guesses', async () => {
  const { api, calls } = stub(({ url: u }, n) => isRelay(u) ? relayMiss()
    : u.hostname.endsWith('.music.126.net') ? mp3()
      : response({ code: 200, data: [remote(undefined, n === 2 ? { code: 500 } : { freeTrialInfo: { start: 10, end: 40 } })] }));
  const data = await read(await api(url('url', old)));
  assert.equal(data.short, true);
  assert.equal(data.preview, true);
  assert.equal(calls.length, 4);
});

for (const badUrl of ['https://127.0.0.1/audio.mp3', 'https://music.126.net.evil.invalid/a', 'https://user:pw@m801.music.126.net/a', 'http://169.254.169.254/', 'javascript:alert(1)', 'https://m801.music.126.net:8080/a']) {
  test(`unsafe upstream URL is rejected before media fetch: ${badUrl}`, async () => {
    const { api, calls } = stub(({ url: u }) => isRelay(u) ? relayMiss() : response({ code: 200, data: [remote(undefined, { url: badUrl })] }));
    await read(await api(url('url', old)), 502);
    assert.deepEqual(calls.map(c => c.url.hostname), [RELAY_HOST, 'music.163.com', 'interface.music.163.com']);
  });
}

for (const [name, media, note] of [
  ['HTML 200', () => new Response('<html>private page</html>', { headers: { 'content-type': 'text/html' } }), 'html'],
  ['fake audio MIME', () => new Response('Not actually an audio file', { headers: { 'content-type': 'audio/mpeg' } }), 'fake'],
  ['dead resource', () => new Response(null, { status: 404 }), 'dead'],
  ['datacenter refusal', () => new Response(null, { status: 403 }), 'dead'],
  ['unsafe redirect', () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }), 'redirect'],
  ['noninitial partial range', () => mp3({ status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 100-611/12345' } }), 'range'],
]) {
  test(`unverifiable official media (${name}) still returns the provider URL, marked unverified`, async () => {
    // Relay missed, provider issued code 200 + a URL, then the Worker's own probe
    // failed. That is a datacenter artifact (the visitor's browser fetches the CDN
    // itself), so it must NOT become 403.
    const { api, calls } = stub(({ url: u }) => isRelay(u) ? relayMiss()
      : u.hostname === 'music.163.com' ? response({ code: 200, data: [remote()] }) : media());
    const res = await api(url('url', old));
    assert.equal(res.status, 200, `${note}: probe failure must not hide a playable song`);
    const data = await read(res);
    assert.equal(data.url, 'https://m801.music.126.net/audio.mp3');
    assert.equal(data.verified, undefined);
    assert.ok(!JSON.stringify(data).includes('private'));
    assert.equal(calls.length, 3);
  });
}

test('only validated official redirects are followed, and a redirect loop degrades unverified', async () => {
  const safe = stub(({ url: u }) => isRelay(u) ? relayMiss() : u.hostname === 'music.163.com' ? response({ code: 200, data: [remote()] }) : u.hostname === 'm801.music.126.net' ? new Response(null, { status: 302, headers: { location: 'http://m701.music.126.net/song.mp3' } }) : mp3());
  const data = await read(await safe.api(url('url', old)));
  assert.equal(data.url, 'https://m701.music.126.net/song.mp3');
  assert.equal(data.verified, true);
  const loop = stub(({ url: u }) => isRelay(u) ? relayMiss() : u.hostname === 'music.163.com' ? response({ code: 200, data: [remote()] }) : new Response(null, { status: 302, headers: { location: 'https://m801.music.126.net/audio.mp3' } }));
  const degraded = await read(await loop.api(url('url', old)));
  // Bounded retries, then fall back to the provider URL rather than failing the song.
  assert.equal(degraded.url, 'https://m801.music.126.net/audio.mp3');
  assert.equal(degraded.verified, undefined);
  assert.equal(loop.calls.length, 5);
});

test('request timeout aborts first provider and continues to valid official metadata', async () => {
  let signal;
  const { api, calls } = stub(({ init }, n) => {
    if (n === 1) { signal = init.signal; return new Promise(() => {}); }
    return response({ code: 200, result: { songs: [song()], songCount: 1 } });
  }, { timeoutMs: 20 });
  await read(await api(url('search', { q: '歌' })));
  assert.equal(signal.aborted, true);
  assert.equal(calls.length, 2);
});

test('timeout also bounds stalled response body and total request budget', async () => {
  let aborted = false;
  const { api, calls } = stub(({ init }) => {
    const stream = new ReadableStream({ start(ctrl) {
      init.signal.addEventListener('abort', () => { aborted = true; ctrl.error(new Error('aborted')); }, { once: true });
    } });
    return new Response(stream, { headers: { 'content-type': 'application/json' } });
  }, { timeoutMs: 100, totalTimeoutMs: 25 });
  const start = Date.now();
  await read(await api(url('search', { q: '歌' })), 502);
  assert.equal(aborted, true);
  assert.ok(Date.now() - start < 500);
  assert.ok(calls.length <= 2);
});

test('oversized declared or streamed JSON is rejected and its body canceled', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const { api } = stub(() => new Response(new ReadableStream({
      start(ctrl) { ctrl.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }), { headers: declared ? { 'content-length': String(3 * 1024 * 1024) } : {} }));
    await read(await api(url('search', { q: '歌' })), 502);
    assert.equal(cancelled, true);
  }
});

test('input guards run before network; missing old signatures are no longer errors', async () => {
  const { api, calls } = stub(() => assert.fail('validation must not fetch'));
  for (const [path, params, status] of [
    ['list', { id: '999' }, 400], ['search', { q: ' ' }, 400], ['search', { q: '😀'.repeat(41) }, 400],
    ['url', { id: '../1', source: 'netease' }, 400], ['url', { id: '1', source: 'tencent' }, 422],
    ['pic', { id: '1', source: 'netease' }, 400], ['lyric', { id: '1', source: 'netease' }, 400], ['missing', {}, 404],
  ]) await read(await api(url(path, params)), status);
  assert.equal(calls.length, 0);
});

test('Worker integration retains GET/same-origin guards, cache version, safe failures and local asset fallback', async () => {
  const output = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
  const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
  const beforeFetch = globalThis.fetch;
  const beforeCaches = globalThis.caches;
  const cached = new Map();
  const keys = [];
  const writes = [];
  const pending = [];
  let fetched = 0;
  try {
    globalThis.caches = { default: {
      match: async req => { keys.push(req.url); return cached.get(req.url)?.clone(); },
      put: async (req, res) => { writes.push(req.url); cached.set(req.url, res); },
    } };
    globalThis.fetch = async raw => {
      fetched++;
      return new URL(raw).pathname.includes('/search/')
        ? response({ code: 200, result: { songs: [song()], songCount: 1 } })
        : response({ code: 200, data: [remote(1808652335, { code: -110, url: null })] });
    };
    const env = { ASSETS: { fetch: async () => new Response('local audio preserved') } };
    const ctx = { waitUntil: promise => pending.push(promise) };
    const request = (path, init) => new Request('https://example.test' + path, init);
    await read(await worker.fetch(request('/api/music/search?q=a', { method: 'POST' }), env, ctx), 405);
    await read(await worker.fetch(request('/api/music/search?q=a', { headers: { 'sec-fetch-site': 'cross-site' } }), env, ctx), 403);
    await read(await worker.fetch(request('/api/music/search?q=a'), env, ctx));
    await Promise.all(pending);
    await read(await worker.fetch(request('/api/music/search?q=a'), env, ctx));
    assert.equal(fetched, 1);
    assert.ok(keys.every(key => key.includes('__music_schema=' + MUSIC_CACHE_VERSION)));
    await read(await worker.fetch(request('/api/music/url?id=1808652335&source=netease&sign=legacy'), env, ctx), 403);
    assert.equal(writes.length, 1);
    await read(await worker.fetch(request('/api/music/nope'), env, ctx), 404);
    assert.equal(await (await worker.fetch(request('/audio/te-bie-de-ren.mp3'), env, ctx)).text(), 'local audio preserved');
  } finally {
    await Promise.all(pending);
    globalThis.fetch = beforeFetch;
    if (beforeCaches === undefined) delete globalThis.caches;
    else globalThis.caches = beforeCaches;
  }
});

test('LIVE: official playlist/search/cover/lyrics and one audio prefix, not browser playback', { skip: process.env.MUSIC_LIVE !== '1' }, async () => {
  const api = createMusicApi();
  const list = await read(await api(url('list', { id: '12607934375' })));
  assert.ok(list.items.length > 6);
  const search = await read(await api(url('search', { q: '特别的人', n: '3' })));
  assert.ok(search.items.some(t => t.title.includes('特别的人')));
  const pic = await read(await api(url('pic', { id: '109951166341738895', song: '1808652335', source: 'netease', sign: 'legacy' })));
  assert.match(pic.url, /^https:\/\/[^/]+\.music\.126\.net\//);
  const lyric = await read(await api(url('lyric', { id: '1808652335', song: '1808652335', source: 'netease' })));
  assert.match(lyric.lyric, /\[\d+:\d+/);
  const media = await read(await api(url('url', old)));
  assert.ok(media.bytes > 0);
  console.log(JSON.stringify({ kind: 'live-metadata-and-audio-prefix-only', playlist: list.items.length, search: search.items.length, lyricChars: lyric.lyric.length, mediaBytes: media.bytes, browserPlayback: 'not-tested' }));
});
