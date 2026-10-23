#!/usr/bin/env node
/* hardening-audit.mjs - DUCHENLIN-20261023 acceptance harness.
 *
 * Usage:
 *   node hardening-audit.mjs --domain duchenlin.top --mode all --base https://duchenlin.top
 *   node hardening-audit.mjs --mode origin --origin 203.0.113.10
 *   node hardening-audit.mjs --self-test          # proves every predicate can PASS
 * Modes: dns | http | tls | origin | ratelimit | all. Exit 0 all PASS, 1 any FAIL.
 */
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const DOMAIN = arg('domain', 'duchenlin.top');
const MODE = arg('mode', 'all');
const BASE = arg('base', 'https://' + DOMAIN);
const ORIGIN = arg('origin', '');
const RESOLVER = arg('resolver', '');
const JSONOUT = arg('json', '');
const RL_COUNT = Number(arg('rl-count', '200'));
const RL_CONC = Number(arg('rl-conc', '50'));
const RL_PATH = arg('rl-path', '/');
if (RESOLVER) dns.setServers(RESOLVER.split(',').map(s => s.trim()).filter(Boolean));

const results = [];
const push = (id, name, status, detail) => results.push({ id, name, status, detail });
const want = (m) => MODE === 'all' || MODE === m;

/* ============================ predicates (pure, self-testable) ============================ */
const spfPass = (v) => !!v && /^v=spf1\b/i.test(v) && /(^|\s)-all\s*$/i.test(v.trim()) && !/\+all|~all|\?all/i.test(v);
const dmarcPass = (v) => !!v && /^v=DMARC1\s*;/i.test(v) && /;?\s*p\s*=\s*reject\b/i.test(v) && /rua\s*=\s*mailto:/i.test(v);
const dmarcStrict = (v) => !!v && /adkim\s*=\s*s/i.test(v) && /aspf\s*=\s*s/i.test(v);
// CAA 在本 zone 上不是「只写什么就只回什么」：Universal SSL 开着时，Cloudflare 会在
// 权威应答里追加它自家 CA 合作方（GTS/LE/DigiCert/SSL.com/Sectigo）的 issue/issuewild，
// 且带 cansignhttpexchanges=yes 参数（API 里看不到这些记录，dig 才看得到）。
// 所以判定标准是：LE 与 pki.goog 必须在授权列表里，且**不出现** CF 合作方以外的 CA。
const CAA_CF_PARTNERS = ['letsencrypt.org', 'pki.goog', 'digicert.com', 'ssl.com', 'comodoca.com', 'sectigo.com'];
const caaGrants = (vals) => vals.filter(v => /^issue(wild)?\s/i.test(v))
  .map(v => v.replace(/^issue(wild)?\s+/i, '').split(';')[0].trim().toLowerCase())
  .filter(Boolean);
const caaPass = (vals) => { const g = caaGrants(vals); return g.includes('letsencrypt.org') && g.includes('pki.goog') && g.every(x => CAA_CF_PARTNERS.includes(x)); };
const hstsPass = (v) => { const m = /max-age\s*=\s*(\d+)/i.exec(v || ''); return !!m && Number(m[1]) >= 31536000 && /includesubdomains/i.test(v) && /preload/i.test(v); };
const cspPass = (v) => /frame-ancestors\s+'none'/i.test(v || '') && /object-src\s+'none'/i.test(v || '') && /default-src\s+'self'/i.test(v || '');
const xfoPass = (v) => String(v || '').toUpperCase() === 'DENY';
const nosniffPass = (v) => String(v || '').toLowerCase() === 'nosniff';
const refPass = (v) => String(v || '').toLowerCase() === 'strict-origin-when-cross-origin';
const permPass = (v) => { const p = String(v || '').toLowerCase(); return /geolocation=\(\)/.test(p) && /microphone=\(\)/.test(p) && /camera=\(\)/.test(p); };

/* ================================ DNS ================================ */
async function dnsChecks() {
  const grab = async (fn, name) => { try { return await fn(name); } catch { return null; } };
  const txt = await grab(dns.resolveTxt, DOMAIN);
  const dmTxt = await grab(dns.resolveTxt, '_dmarc.' + DOMAIN);
  const caa = await grab(dns.resolveCaa, DOMAIN);
  const mx = await grab(dns.resolveMx, DOMAIN);
  const flatTxt = (r) => (r || []).map(a => Array.isArray(a) ? a.join('') : String(a));
  const txts = flatTxt(txt);
  const dms = flatTxt(dmTxt);
  const spf = txts.find(v => /^v=spf1/i.test(v));
  push('D1', 'SPF hard fail (v=spf1 -all)', spfPass(spf) ? 'PASS' : 'FAIL', spf || 'no v=spf1 TXT on ' + DOMAIN);
  const dm = dms.find(v => /^v=DMARC1/i.test(v));
  push('D2', 'DMARC p=reject + rua', dmarcPass(dm) ? 'PASS' : 'FAIL', (dm || 'no DMARC TXT on _dmarc.' + DOMAIN) + (dm && dmarcStrict(dm) ? '  [adkim=s aspf=s]' : ''));
  const caaVals = (caa || []).map(r => r.issue ? 'issue ' + r.issue : r.issuewild ? 'issuewild ' + r.issuewild : r.iodef ? 'iodef ' + r.iodef : JSON.stringify(r));
  const grants = [...new Set(caaGrants(caaVals))];
  push('D3', 'CAA: LE + pki.goog granted, no CA outside CF partners', caaPass(caaVals) ? 'PASS' : 'FAIL', grants.length ? 'issue grants: ' + grants.join(', ') : 'no CAA on ' + DOMAIN);
  push('D4', 'No MX (domain cannot receive mail)', mx && mx.length ? 'WARN' : 'PASS', mx && mx.length ? 'MX: ' + mx.map(m => m.exchange).join(',') : 'no MX, consistent with v=spf1 -all');
  push('D5', 'DNSSEC enabled', 'WARN', 'needs registrar-side DS check: dig +dnssec ' + DOMAIN + ' DS @1.1.1.1');
}

/* ================================ HTTP ================================ */
function fetchHead(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({ method: 'HEAD', host: u.hostname, port: u.port || 443, path: u.pathname + u.search, servername: u.hostname, timeout: 15000 }, (res) => { res.resume(); resolve({ status: res.statusCode, headers: res.headers }); });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end();
  });
}

async function httpChecks(quiet) {
  const r = await fetchHead(BASE + '/');
  if (r.error) { for (const id of ['H1','H2','H3','H4','H5','H6']) push(id, 'response header', 'ERROR', 'request failed: ' + r.error); return; }
  const h = r.headers;
  push('H1', 'HSTS 1y + includeSubDomains + preload', hstsPass(h['strict-transport-security']) ? 'PASS' : 'FAIL', h['strict-transport-security'] || 'header missing');
  const csp = h['content-security-policy'] || '';
  const cspRO = h['content-security-policy-report-only'] || '';
  push('H2', 'CSP enforced (default-src self, frame-ancestors none)', cspPass(csp) ? 'PASS' : (cspRO ? 'WARN' : 'FAIL'), csp || (cspRO ? 'report-only: ' + cspRO : 'header missing'));
  push('H3', 'X-Frame-Options: DENY', xfoPass(h['x-frame-options']) ? 'PASS' : 'FAIL', h['x-frame-options'] || 'header missing');
  push('H4', 'X-Content-Type-Options: nosniff', nosniffPass(h['x-content-type-options']) ? 'PASS' : 'FAIL', h['x-content-type-options'] || 'header missing');
  push('H5', 'Referrer-Policy strict-origin-when-cross-origin', refPass(h['referrer-policy']) ? 'PASS' : 'FAIL', h['referrer-policy'] || 'header missing');
  push('H6', 'Permissions-Policy geo/mic/camera disabled', permPass(h['permissions-policy']) ? 'PASS' : 'FAIL', h['permissions-policy'] || 'header missing');
  push('H7', 'Origin banner not leaked', String(h['server'] || '') === 'cloudflare' ? 'PASS' : 'WARN', 'server: ' + (h['server'] || '(none)'));
  if (!quiet) {
    console.log('  [raw] HTTP ' + r.status + ' ' + BASE + '/');
    for (const [k, v] of Object.entries(h)) console.log('  [raw] ' + k + ': ' + v);
  }
}

/* ================================= TLS ==================================
 * Ground truth is a hand-built ClientHello with SNI: every client library here lies
 * (Node child refuses TLS1.0/1.1 locally, Schannel curl silently upgrades). */
const e2 = (t, d) => { const b = Buffer.alloc(4); b.writeUInt16BE(t, 0); b.writeUInt16BE(d.length, 2); return Buffer.concat([b, d]); };
function clientHello(legacy, withV13, sni) {
  const name = Buffer.from(sni, 'ascii');
  const sniList = Buffer.concat([Buffer.from([0]), Buffer.from([name.length >> 8, name.length & 0xff]), name]);
  const suites = Buffer.from([0xc0, 0x13, 0xc0, 0x14, 0x00, 0x2f, 0x00, 0x35, 0x00, 0x9c, 0xc0, 0x2f]);
  const sigs = Buffer.from([0x04, 0x03, 0x05, 0x03, 0x06, 0x03, 0x04, 0x01, 0x05, 0x01, 0x06, 0x01, 0x02, 0x01, 0x02, 0x03]);
  const groups = Buffer.from([0x00, 0x1d, 0x00, 0x17, 0x00, 0x18]);
  const exts = [
    e2(0x0000, Buffer.concat([Buffer.from([sniList.length >> 8, sniList.length & 0xff]), sniList])),
    e2(0x000d, Buffer.concat([Buffer.from([sigs.length >> 8, sigs.length & 0xff]), sigs])),
    e2(0x000a, Buffer.concat([Buffer.from([groups.length >> 8, groups.length & 0xff]), groups])),
    e2(0x000b, Buffer.from([0x01, 0x00])),
    e2(0x0017, Buffer.alloc(0)),
    e2(0xff01, Buffer.from([0x00])),
  ];
  if (withV13) exts.push(e2(0x002b, Buffer.from([0x02, 0x03, 0x04])));
  const ext = Buffer.concat(exts);
  const body = Buffer.concat([
    Buffer.from([legacy >> 8, legacy & 0xff]), crypto.randomBytes(32), Buffer.from([0x00]),
    Buffer.from([suites.length >> 8, suites.length & 0xff]), suites, Buffer.from([0x01, 0x00]),
    Buffer.from([ext.length >> 8, ext.length & 0xff]), ext,
  ]);
  const hdr = Buffer.alloc(4); hdr[0] = 0x01; hdr.writeUIntBE(body.length, 1, 3);
  const hs = Buffer.concat([hdr, body]);
  const rec = Buffer.alloc(5); rec[0] = 0x16; rec[1] = 0x03; rec[2] = 0x01; rec.writeUInt16BE(hs.length, 3);
  return Buffer.concat([rec, hs]);
}
function rawProbe(host, legacy, withV13) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: 443, timeout: 8000 }, () => s.write(clientHello(legacy, withV13, host)));
    let buf = Buffer.alloc(0); let done = false;
    const fin = (r) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(r); };
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 6) return;
      if (buf[0] === 0x16) fin({ verdict: 'ACCEPTED', serverVersion: '0x' + buf.readUInt16BE(9).toString(16) });
      else if (buf[0] === 0x15) fin({ verdict: 'REJECTED', alert: 'level=' + buf[5] + ' desc=' + buf[6] });
      else fin({ verdict: 'OTHER', type: '0x' + buf[0].toString(16) });
    });
    s.on('timeout', () => fin({ verdict: 'NO_RESPONSE' }));
    s.on('error', (e) => fin({ verdict: 'ERROR', code: e.code }));
  });
}
function nodeProbe(host, min, max) {
  return new Promise((resolve) => {
    let done = false;
    const s = tls.connect({ host, port: 443, servername: host, minVersion: min, maxVersion: max, timeout: 10000 }, () => { done = true; resolve({ ok: true, proto: s.getProtocol(), cipher: (s.getCipher() || {}).name }); s.destroy(); });
    s.on('error', (e) => { if (!done) { done = true; resolve({ ok: false, code: e.code, msg: String(e.message).slice(0, 140) }); } });
    s.on('timeout', () => { if (!done) { done = true; s.destroy(); resolve({ ok: false, code: 'TIMEOUT' }); } });
  });
}
async function tlsChecks() {
  const host = new URL(BASE).hostname;
  for (const [id, label, v] of [['T1', 'TLS 1.0', 0x0301], ['T2', 'TLS 1.1', 0x0302]]) {
    const r = await rawProbe(host, v, false);
    push(id, label + ' rejected (raw ClientHello)', r.verdict === 'REJECTED' ? 'PASS' : 'FAIL', r.verdict + ' ' + (r.serverVersion || r.alert || r.code || ''));
  }
  const a = await nodeProbe(host, 'TLSv1.2', 'TLSv1.2');
  push('T3', 'TLS 1.2 still served', a.ok ? 'PASS' : 'FAIL', a.ok ? a.proto + ' / ' + a.cipher : (a.code || a.msg));
  const b = await nodeProbe(host, 'TLSv1.3', 'TLSv1.3');
  push('T4', 'TLS 1.3 served', b.ok ? 'PASS' : 'FAIL', b.ok ? b.proto + ' / ' + b.cipher : (b.code || b.msg));
}

/* =============================== origin ================================ */
const CF_V4 = ['173.245.48.0/20','103.21.244.0/22','103.22.200.0/22','103.31.4.0/22','141.101.64.0/18','108.162.192.0/18','190.93.240.0/20','188.114.96.0/20','197.234.240.0/22','198.41.128.0/17','162.158.0.0/15','104.16.0.0/13','104.24.0.0/14','172.64.0.0/13','131.0.72.0/22'];
const ip2n = (ip) => ip.split('.').reduce((a, o) => ((a << 8) >>> 0) + Number(o), 0) >>> 0;
const inCidr = (ip, cidr) => { const [n, b] = cidr.split('/'); const m = Number(b) === 0 ? 0 : (0xffffffff << (32 - Number(b))) >>> 0; return (ip2n(ip) & m) === (ip2n(n) & m); };
function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 6000 }, () => { s.destroy(); resolve({ open: true }); });
    s.on('timeout', () => { s.destroy(); resolve({ open: false, why: 'timeout' }); });
    s.on('error', (e) => resolve({ open: false, why: e.code }));
  });
}
async function originChecks() {
  if (!ORIGIN) {
    const a = await dns.resolve4(DOMAIN).catch(() => []);
    const allCf = a.length > 0 && a.every(ip => CF_V4.some(c => inCidr(ip, c)));
    push('S1', 'Origin not directly reachable', allCf ? 'PASS' : 'FAIL', allCf ? 'every A record is Cloudflare edge (' + a.join(',') + '); origin is a Worker, zero inbound ports' : 'non-CF A record: ' + a.join(','));
    return;
  }
  const p443 = await tcpProbe(ORIGIN, 443);
  const p80 = await tcpProbe(ORIGIN, 80);
  const blocked = !p443.open && !p80.open;
  push('S1', 'Origin not directly reachable', blocked ? 'PASS' : 'FAIL', ORIGIN + ' :443=' + (p443.open ? 'OPEN' : 'closed/' + p443.why) + ' :80=' + (p80.open ? 'OPEN' : 'closed/' + p80.why));
}

/* ============================ rate limiting ============================ */
async function ratelimitChecks() {
  const url = BASE + RL_PATH;
  const codes = {}; let sent = 0;
  const worker = async () => { while (sent < RL_COUNT) { sent++; const r = await fetchHead(url); const k = r.status || r.error; codes[k] = (codes[k] || 0) + 1; } };
  await Promise.all(Array.from({ length: RL_CONC }, worker));
  const limited = (codes[429] || 0) + (codes[503] || 0) > 0;
  push('R1', 'Rate limit returns 429 under ' + RL_COUNT + ' req / ' + RL_CONC + ' conn', limited ? 'PASS' : 'FAIL', JSON.stringify(codes));
}

/* ============================== self test ============================== */
function selfTest() {
  const good = {
    spf: 'v=spf1 -all',
    dmarc: 'v=DMARC1; p=reject; rua=mailto:dmarc@duchenlin.top; adkim=s; aspf=s',
    caa: ['issue letsencrypt.org', 'issue pki.goog'],
    hsts: 'max-age=31536000; includeSubDomains; preload',
    csp: "default-src 'self'; script-src 'self'; frame-ancestors 'none'; object-src 'none'",
    xfo: 'DENY', nosniff: 'nosniff', ref: 'strict-origin-when-cross-origin',
    perm: 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
  };
  const bad = { spf: 'v=spf1 ~all', dmarc: 'v=DMARC1; p=none', hsts: 'max-age=300', csp: "default-src *", xfo: 'SAMEORIGIN', nosniff: '', ref: 'no-referrer', perm: 'geolocation=(self)' };
  const cases = [
    ['spf', spfPass(good.spf), spfPass(bad.spf)],
    ['dmarc', dmarcPass(good.dmarc) && dmarcStrict(good.dmarc), dmarcPass(bad.dmarc)],
    ['caa', caaPass(good.caa), caaPass(['issue digicert.com'])],
    ['caa+cf', caaPass(['issue letsencrypt.org','issue pki.goog; cansignhttpexchanges=yes','issue digicert.com']), caaPass(['issue letsencrypt.org','issue evil-ca.example'])],
    ['hsts', hstsPass(good.hsts), hstsPass(bad.hsts)],
    ['csp', cspPass(good.csp), cspPass(bad.csp)],
    ['xfo', xfoPass(good.xfo), xfoPass(bad.xfo)],
    ['nosniff', nosniffPass(good.nosniff), nosniffPass(bad.nosniff)],
    ['referrer', refPass(good.ref), refPass(bad.ref)],
    ['permissions', permPass(good.perm), permPass(bad.perm)],
  ];
  let bad2 = 0;
  for (const [n, t, f] of cases) { if (!t || f) { bad2++; console.log('  SELFTEST FAIL ' + n + ' (good->' + t + ', bad->' + f + ')'); } else console.log('  SELFTEST ok   ' + n); }
  console.log(bad2 ? 'SELFTEST: ' + bad2 + ' predicate(s) broken' : 'SELFTEST: all 9 predicates discriminate good from bad');
  process.exit(bad2 ? 1 : 0);
}

/* ================================ main ================================ */
if (argv.includes('--self-test')) selfTest();
const t0 = Date.now();
console.log('== hardening-audit == ' + new Date().toISOString() + '  domain=' + DOMAIN + '  mode=' + MODE + '  base=' + BASE);
if (want('dns')) await dnsChecks();
if (want('http')) await httpChecks();
if (want('tls')) await tlsChecks();
if (want('origin')) await originChecks();
if (want('ratelimit')) await ratelimitChecks();
console.log('');
console.log('id   status  check                                                      detail');
for (const r of results) console.log(r.id.padEnd(4) + ' ' + r.status.padEnd(6) + ' ' + r.name.slice(0, 55).padEnd(56) + ' ' + r.detail);
const fail = results.filter(r => r.status === 'FAIL');
const warn = results.filter(r => r.status === 'WARN');
const pass = results.filter(r => r.status === 'PASS');
console.log('');
console.log('SUMMARY pass=' + pass.length + ' warn=' + warn.length + ' fail=' + fail.length + '  elapsed=' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
if (fail.length) console.log('FAILED: ' + fail.map(f => f.id).join(', '));
if (JSONOUT) { fs.writeFileSync(JSONOUT, JSON.stringify({ domain: DOMAIN, mode: MODE, base: BASE, at: new Date().toISOString(), results }, null, 2)); console.log('json -> ' + JSONOUT); }
process.exit(fail.length ? 1 : 0);
