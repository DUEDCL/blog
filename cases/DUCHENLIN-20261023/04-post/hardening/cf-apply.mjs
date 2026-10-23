#!/usr/bin/env node
/* cf-apply.mjs - DUCHENLIN-20261023 Cloudflare hardening engine (stages 1 + 2).
 *
 * Design rules baked in:
 *  1. every item exports <item>-before-<UTC> before touching it, and <item>-after-<UTC> right after;
 *  2. WAF / rate-limit rules land in log mode by default (--mode enforce is a separate, later run);
 *  3. never deletes A/AAAA; only adds records, and only removes records it created itself (see rollback);
 *  4. idempotent: re-running converges, it does not duplicate;
 *  5. every mutation prints its own rollback line into ROLLBACK.md.
 *
 * Usage:
 *   CF_API_TOKEN=... CF_ZONE_ID=... node cf-apply.mjs snapshot
 *   CF_API_TOKEN=... CF_ZONE_ID=... node cf-apply.mjs apply --only dns
 *   CF_API_TOKEN=... CF_ZONE_ID=... node cf-apply.mjs apply --only edge
 *   CF_API_TOKEN=... CF_ZONE_ID=... node cf-apply.mjs apply --only waf        # log mode
 *   CF_API_TOKEN=... CF_ZONE_ID=... node cf-apply.mjs apply --only ratelimit  # log mode
 *   CF_API_TOKEN=... CF_ZONE_ID=... node cf-apply.mjs apply --only bots
 *   CF_API_TOKEN=... CF_ZONE_ID=... node cf-apply.mjs enforce --only waf      # day 2, after 24h clean logs
 *   CF_API_TOKEN=... CF_ZONE_ID=... node cf-apply.mjs rollback --stamp 20261023T122700Z
 * Flags: --dry-run  --rua <mailto>  --origin <ip>  --stamp <ts>
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKUPS = path.join(HERE, 'backups');
fs.mkdirSync(BACKUPS, { recursive: true });

const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CF_API_TOKEN || '';
const ZONE = process.env.CF_ZONE_ID || '';
const DOMAIN = process.env.CF_ZONE_NAME || 'duchenlin.top';
const argv = process.argv.slice(2);
const CMD = argv[0] || 'help';
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);
const DRY = has('dry-run');
const SIM = DRY && !process.env.CF_API_TOKEN;   // dry-run without credentials = print the exact API plan
const MODE = flag('mode', 'log');
const ONLY = flag('only', '');
const ORIGIN = flag('origin', '');
const RUA = flag('rua', 'mailto:dmarc@' + DOMAIN);
const STAMP = flag('stamp', new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'));

const C = { r: '\u001b[31m', g: '\u001b[32m', y: '\u001b[33m', d: '\u001b[90m', x: '\u001b[0m' };
const log = (...a) => console.log(...a);
const ok = (m) => log(C.g + '  OK   ' + C.x + m);
const skip = (m) => log(C.d + '  SKIP ' + C.x + m);
const warn = (m) => log(C.y + '  WARN ' + C.x + m);
const fail = (m) => log(C.r + '  FAIL ' + C.x + m);
const rollbackLines = [];
const rollback = (item, cmd) => { rollbackLines.push('- **' + item + '** -> ' + cmd); };

function needCreds() {
  if (SIM) { warn('no CF_API_TOKEN: simulation mode, printing the API plan only'); return; }
  const missing = [];
  if (!TOKEN) missing.push('CF_API_TOKEN');
  if (!ZONE) missing.push('CF_ZONE_ID');
  if (missing.length) {
    fail('missing credentials: ' + missing.join(', '));
    log('  export CF_API_TOKEN=<token with Zone:DNS:Edit + Zone:Zone Settings:Edit + Zone:Firewall Services:Edit + Zone:Zone WAF:Edit>');
    log('  export CF_ZONE_ID=<zone id of ' + DOMAIN + '>');
    process.exit(2);
  }
}

let simN = 0;
async function cf(method, url, body) {
  if (SIM) {
    log(C.d + '  [plan] ' + method.padEnd(5) + ' ' + url + (body === undefined ? '' : '  ' + JSON.stringify(body)) + C.x);
    if (method === 'GET') {
      if (url.includes('/dns_records')) return [];
      if (url.includes('/settings/')) return { value: null };
      const e = new Error('simulated 404 (no ruleset yet)'); e.status = 404; throw e;
    }
    return Object.assign({ id: 'sim-' + (++simN) }, body || {});
  }
  const res = await fetch(API + url, {
    method,
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { success: false, errors: [{ message: text.slice(0, 400) }] }; }
  if (!res.ok || json.success === false) {
    const e = new Error(method + ' ' + url + ' -> HTTP ' + res.status + ' ' + JSON.stringify(json.errors || json).slice(0, 600));
    e.status = res.status; e.payload = json; throw e;
  }
  return json.result;
}

function save(item, when, data) {
  const f = path.join(BACKUPS, (SIM ? 'sim-' : '') + item + '-' + when + '-' + STAMP + '.json');
  fs.writeFileSync(f, JSON.stringify({ item, when, stamp: STAMP, at: new Date().toISOString(), data }, null, 2));
  return f;
}
function load(item, when, stamp) {
  const f = path.join(BACKUPS, item + '-' + when + '-' + (stamp || STAMP) + '.json');
  if (!fs.existsSync(f)) throw new Error('backup not found: ' + f);
  return JSON.parse(fs.readFileSync(f, 'utf8')).data;
}

/* ---------------------------------------------------------------- stage 1: DNS */
const WANTED_RECORDS = [
  { type: 'TXT', name: DOMAIN, content: 'v=spf1 -all', comment: 'DUCH-1: domain sends no mail -> hard fail every sender' },
  { type: 'TXT', name: '_dmarc.' + DOMAIN, content: 'v=DMARC1; p=reject; rua=' + RUA + '; adkim=s; aspf=s', comment: 'DUCH-2: reject From forgery' },
  { type: 'CAA', name: DOMAIN, data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' }, comment: 'DUCH-3a: pin issuance to LE' },
  { type: 'CAA', name: DOMAIN, data: { flags: 0, tag: 'issue', value: 'pki.goog' }, comment: 'DUCH-3b: pin issuance to GTS (current WE1 wildcard)' },
];

async function snapshotDns() {
  const list = await cf('GET', '/zones/' + ZONE + '/dns_records?per_page=200');
  save('dns-records', 'before', list);
  log('  ' + list.length + ' records exported -> dns-records-before-' + STAMP + '.json');
  for (const r of list) log('    ' + r.type.padEnd(6) + ' ' + r.name + '  ' + (r.content || JSON.stringify(r.data)).slice(0, 90) + '  proxied=' + !!r.proxied);
  return list;
}

function sameRecord(existing, want) {
  if (existing.type !== want.type || existing.name !== want.name) return false;
  if (want.type === 'CAA') {
    const d = existing.data || {};
    return Number(d.flags) === Number(want.data.flags) && String(d.tag).toLowerCase() === want.data.tag && String(d.value).toLowerCase() === want.data.value;
  }
  return String(existing.content).trim() === String(want.content).trim();
}

async function applyDns() {
  log('== stage 1: DNS (' + DOMAIN + ')');
  const before = await snapshotDns();
  const created = [];
  for (const want of WANTED_RECORDS) {
    const hit = before.find(r => sameRecord(r, want));
    if (hit) { skip(want.type + ' ' + want.name + ' already present (id ' + hit.id + ')'); continue; }
    const body = { type: want.type, name: want.name, ttl: 1, comment: want.comment };
    if (want.type === 'CAA') body.data = want.data; else body.content = want.content;
    if (DRY && !SIM) { skip('[dry-run] would create ' + want.type + ' ' + want.name); continue; }
    const r = await cf('POST', '/zones/' + ZONE + '/dns_records', body);
    created.push(r);
    ok('created ' + want.type + ' ' + want.name + ' = ' + (r.content || JSON.stringify(r.data)) + ' (id ' + r.id + ')');
    rollback('DNS ' + want.type + ' ' + want.name, 'curl -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" ' + API + '/zones/' + ZONE + '/dns_records/' + r.id);
  }
  const after = await cf('GET', '/zones/' + ZONE + '/dns_records?per_page=200');
  save('dns-records', 'after', after);
  log('  post-change export -> dns-records-after-' + STAMP + '.json (' + after.length + ' records)');
  if (created.length === 0) skip('no DNS change needed');
}

/* ------------------------------------------------------- stage 2: zone settings */
const SETTINGS = [
  ['ssl', 'strict', 'Full (strict): origin cert must be valid; Workers origins always are'],
  ['min_tls_version', '1.2', 'kill TLS 1.0/1.1 (audit T1/T2 currently FAIL)'],
  ['tls_1_3', 'on', 'keep 1.3'],
  ['always_use_https', 'on', 'redirect http->https at edge'],
  ['automatic_https_rewrites', 'on', 'rewrite same-host http:// subresources'],
  ['opportunistic_encryption', 'on', 'advertise Alt-Svc http/3 + OE'],
];

async function probeOrigin() {
  if (!ORIGIN) return { checked: false };
  const p = (port) => new Promise(r => {
    const s = net.connect({ host: ORIGIN, port, timeout: 5000 }, () => { s.destroy(); r(true); });
    s.on('timeout', () => { s.destroy(); r(false); });
    s.on('error', () => r(false));
  });
  const open = await p(443);
  return { checked: true, open443: open };
}

async function applyEdge() {
  log('== stage 2a: zone settings');
  const before = {};
  for (const [k] of SETTINGS.concat([['security_header', '']])) before[k] = await cf('GET', '/zones/' + ZONE + '/settings/' + k).catch(e => ({ error: e.message }));
  save('zone-settings', 'before', before);
  log('  exported -> zone-settings-before-' + STAMP + '.json');

  const o = await probeOrigin();
  if (o.checked && !o.open443) {
    warn('origin ' + ORIGIN + ':443 is closed -> NOT switching ssl to strict (would 526). Fix origin TLS first.');
  } else if (o.checked) {
    ok('origin ' + ORIGIN + ':443 reachable, safe to switch ssl mode');
  } else {
    skip('no --origin given; origin is a Worker (no inbound port), strict mode is trivially satisfiable');
  }

  for (const [k, v, why] of SETTINGS) {
    if (k === 'ssl' && o.checked && !o.open443) { skip('ssl=strict held back (origin 443 closed)'); continue; }
    const cur = before[k] && before[k].value;
    if (String(cur) === String(v)) { skip(k + ' already ' + v); continue; }
    if (DRY && !SIM) { skip('[dry-run] would set ' + k + ' ' + cur + ' -> ' + v); continue; }
    await cf('PATCH', '/zones/' + ZONE + '/settings/' + k, { value: v });
    ok(k + ': ' + cur + ' -> ' + v + '  (' + why + ')');
    rollback('setting ' + k, 'PATCH /zones/' + ZONE + '/settings/' + k + ' {"value":"' + cur + '"}');
  }

  // HSTS lives in the security_header setting, not in a header transform rule.
  const hstsWant = { strict_transport_security: { enabled: true, max_age: 31536000, include_subdomains: true, preload: true, nosniff: true } };
  const hstsCur = (before.security_header && before.security_header.value) || {};
  if (JSON.stringify(hstsCur.strict_transport_security || {}) === JSON.stringify(hstsWant.strict_transport_security)) skip('HSTS already max-age=31536000; includeSubDomains; preload');
  else if (DRY) skip('[dry-run] would enable HSTS');
  else {
    await cf('PATCH', '/zones/' + ZONE + '/settings/security_header', { value: hstsWant });
    ok('HSTS enabled: max-age=31536000; includeSubDomains; preload');
    rollback('HSTS', 'PATCH /zones/' + ZONE + '/settings/security_header ' + JSON.stringify({ value: hstsCur }));
  }
  save('zone-settings', 'after', await cf('GET', '/zones/' + ZONE + '/settings/security_header'));
}

/* --------------------------------------------- stage 2b: response header rules */
const CSP_HASHES = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, 'csp-hashes.json'), 'utf8')); } catch { return []; } })();
const CSP = "default-src 'self'; script-src 'self'" + CSP_HASHES.map(h => " 'sha256-" + h + "'").join('') +
  "; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
const HEADERS = [
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()'],
];

async function applyHeaders() {
  log('== stage 2b: response header transform (CSP first as Report-Only)');
  const phase = 'http_response_headers_transform';
  let before = null;
  try { before = await cf('GET', '/zones/' + ZONE + '/rulesets/phases/' + phase + '/entrypoint'); } catch (e) { if (e.status !== 404) throw e; }
  save('transform-headers', 'before', before);
  log('  exported -> transform-headers-before-' + STAMP + '.json' + (before ? '' : ' (no ruleset yet)'));

  const cspName = MODE === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';
  const rules = [];
  for (const [k, v] of HEADERS) rules.push({ action: 'set', action_parameters: { headers: { [k]: { operation: 'set', value: v } } }, expression: 'true', description: 'DUCH header ' + k });
  rules.push({ action: 'set', action_parameters: { headers: { [cspName]: { operation: 'set', value: CSP } } }, expression: 'true', description: 'DUCH CSP (' + (MODE === 'enforce' ? 'enforcing' : 'report-only, day 1') + ')' });

  if (DRY && !SIM) { skip('[dry-run] would PUT ' + rules.length + ' header rules'); return; }
  const after = await cf('PUT', '/zones/' + ZONE + '/rulesets/phases/' + phase + '/entrypoint', { rules });
  save('transform-headers', 'after', after);
  ok(rules.length + ' header rules live; CSP header name = ' + cspName);
  rollback('transform headers', before ? 'PUT /zones/' + ZONE + '/rulesets/' + before.id + ' ' + JSON.stringify(before.rules) : 'DELETE /zones/' + ZONE + '/rulesets/phases/' + phase + '/entrypoint');
}

/* ------------------------------------------------- stage 2c: WAF managed rulesets */
const MANAGED = [
  ['efb7b8c949ac4650a09736fc376e9aee', 'Cloudflare Managed Ruleset'],
  ['4814384a9e5d4991b9815dcfc25d2f1f', 'Cloudflare OWASP Core Ruleset'],
];

async function applyWafManaged() {
  log('== stage 2c: managed WAF rulesets (' + (MODE === 'enforce' ? 'BLOCK' : 'LOG') + ')');
  const phase = 'http_request_firewall_managed';
  let before = null;
  try { before = await cf('GET', '/zones/' + ZONE + '/rulesets/phases/' + phase + '/entrypoint'); } catch (e) { if (e.status !== 404) throw e; }
  save('waf-managed', 'before', before);
  const rules = [];
  for (const [id, name] of MANAGED) {
    const overrides = MODE === 'enforce' ? {} : { action: 'log' };
    rules.push({ action: 'execute', action_parameters: { id, overrides }, expression: 'true', description: 'DUCH ' + name + ' (' + (MODE === 'enforce' ? 'enforce' : 'log mode, 24h observation') + ')' });
  }
  if (DRY && !SIM) { skip('[dry-run] would execute ' + MANAGED.length + ' managed rulesets'); return; }
  try {
    const after = await cf('PUT', '/zones/' + ZONE + '/rulesets/phases/' + phase + '/entrypoint', { rules });
    save('waf-managed', 'after', after);
    ok('managed rulesets deployed, action override = ' + (MODE === 'enforce' ? 'ruleset default (block)' : 'log'));
  } catch (e) {
    fail('managed ruleset deploy rejected: ' + e.message);
    warn('run: node cf-apply.mjs list-managed   to print the ruleset ids actually available to this zone');
    return;
  }
  rollback('WAF managed', before ? 'PUT /zones/' + ZONE + '/rulesets/' + before.id + ' (previous ruleset)' : 'DELETE /zones/' + ZONE + '/rulesets/phases/' + phase + '/entrypoint');
}

async function listManaged() {
  const rs = await cf('GET', '/zones/' + ZONE + '/rulesets?per_page=50');
  for (const r of rs) log('  ' + r.kind.padEnd(10) + ' ' + r.phase.padEnd(34) + ' ' + r.id + '  ' + r.name);
}

/* -------------------------------------------------- stage 2d: WAF custom rules */
async function applyWafCustom() {
  log('== stage 2d: custom WAF rules (' + (MODE === 'enforce' ? 'BLOCK' : 'LOG') + ')');
  const phase = 'http_request_firewall_custom';
  let before = null;
  try { before = await cf('GET', '/zones/' + ZONE + '/rulesets/phases/' + phase + '/entrypoint'); } catch (e) { if (e.status !== 404) throw e; }
  save('waf-custom', 'before', before);
  const A = MODE === 'enforce' ? 'block' : 'log';
  const rules = [
    { action: A, expression: 'not http.request.method in {"GET" "HEAD" "POST" "PUT" "DELETE" "PATCH" "OPTIONS"}', description: 'DUCH-01 method allowlist' },
    { action: A, expression: 'http.request.uri.path matches "/(\\.git|\\.env|\\.svn|wp-admin|actuator|server-status|\\.DS_Store)"', description: 'DUCH-02 sensitive path probe' },
    { action: 'managed_challenge', expression: 'http.user_agent eq "" or http.user_agent matches "(sqlmap|nikto|nmap|masscan|zgrab|nuclei)"', description: 'DUCH-03 empty/scanner UA' },
    { action: 'managed_challenge', expression: '(http.request.method eq "POST") and (http.request.uri.path eq "/api/admin/login" or http.request.uri.path eq "/api/site/login" or http.request.uri.path eq "/api/site/register")', description: 'DUCH-04 challenge credential endpoints before body is parsed' },
  ];
  if (DRY && !SIM) { skip('[dry-run] would PUT ' + rules.length + ' custom rules'); return; }
  const after = await cf('PUT', '/zones/' + ZONE + '/rulesets/phases/' + phase + '/entrypoint', { rules });
  save('waf-custom', 'after', after);
  ok(rules.length + ' custom rules live (method/path action = ' + A + ')');
  rollback('WAF custom', before ? 'PUT /zones/' + ZONE + '/rulesets/' + before.id + ' (previous ruleset)' : 'DELETE /zones/' + ZONE + '/rulesets/phases/' + phase + '/entrypoint');
}

/* ---------------------------------------------------- stage 2e: rate limiting */
async function applyRateLimit() {
  log('== stage 2e: rate limiting (' + (MODE === 'enforce' ? 'BLOCK/CHALLENGE' : 'LOG') + ')');
  const phase = 'http_ratelimit';
  let before = null;
  try { before = await cf('GET', '/zones/' + ZONE + '/rulesets/phases/' + phase + '/entrypoint'); } catch (e) { if (e.status !== 404) throw e; }
  save('ratelimit', 'before', before);
  const rl = (path, per, period, timeout, action) => ({
    action: MODE === 'enforce' ? action : 'log',
    action_parameters: MODE === 'enforce' && action === 'block' ? { response: { status_code: 429, content_type: 'text/plain', content: 'rate limited' } } : {},
    ratelimit: { characteristics: ['ip.src', 'cf.colo.id'], period, requests_per_period: per, mitigation_timeout: timeout },
    expression: path,
    description: 'DUCH-RL ' + path + ' ' + per + '/' + period + 's -> ' + action + ' ' + timeout + 's',
  });
  const rules = [
    rl('http.request.uri.path eq "/api/site/login"', 10, 60, 300, 'block'),
    rl('http.request.uri.path eq "/api/admin/login"', 5, 60, 300, 'block'),
    rl('http.request.uri.path eq "/api/site/register"', 5, 60, 60, 'managed_challenge'),
    rl('starts_with(http.request.uri.path, "/api/")', 100, 60, 60, 'managed_challenge'),
    rl('true', 300, 60, 60, 'managed_challenge'),
  ];
  if (DRY && !SIM) { skip('[dry-run] would PUT ' + rules.length + ' rate limit rules'); return; }
  const after = await cf('PUT', '/zones/' + ZONE + '/rulesets/phases/' + phase + '/entrypoint', { rules });
  save('ratelimit', 'after', after);
  ok(rules.length + ' rate limit rules live');
  rollback('rate limiting', before ? 'PUT /zones/' + ZONE + '/rulesets/' + before.id + ' (previous ruleset)' : 'DELETE /zones/' + ZONE + '/rulesets/phases/' + phase + '/entrypoint');
}

/* ----------------------------------------------------------- stage 2f: bots */
async function applyBots() {
  log('== stage 2f: bot fight mode');
  const before = await cf('GET', '/zones/' + ZONE + '/settings/bot_fight_mode').catch(e => ({ error: e.message }));
  save('bot-fight-mode', 'before', before);
  if (before && before.value === true) { skip('Bot Fight Mode already on'); return; }
  if (DRY && !SIM) { skip('[dry-run] would enable Bot Fight Mode'); return; }
  try {
    await cf('PATCH', '/zones/' + ZONE + '/settings/bot_fight_mode', { value: true });
    ok('Bot Fight Mode on');
    rollback('Bot Fight Mode', 'PATCH /zones/' + ZONE + '/settings/bot_fight_mode {"value":false}');
  } catch (e) {
    warn('Bot Fight Mode not available on this plan/API: ' + e.message);
    warn('fallback: dashboard -> Security -> Bots -> Bot Fight Mode, and allow verified bots for API clients');
  }
  save('bot-fight-mode', 'after', await cf('GET', '/zones/' + ZONE + '/settings/bot_fight_mode').catch(e => ({ error: e.message })));
}

/* ------------------------------------------------------------- orchestrator */
const STAGES = { dns: applyDns, edge: applyEdge, headers: applyHeaders, waf: applyWafManaged, custom: applyWafCustom, ratelimit: applyRateLimit, bots: applyBots };

async function main() {
  log('== cf-apply ' + new Date().toISOString() + '  zone=' + DOMAIN + '  stamp=' + STAMP + '  mode=' + MODE + (DRY ? '  DRY-RUN' : ''));
  if (CMD === 'help') {
    log('commands: snapshot | apply | enforce | rollback | list-managed');
    return;
  }
  needCreds();
  if (CMD === 'list-managed') { await listManaged(); return; }
  if (CMD === 'snapshot') { await snapshotDns(); return; }
  if (CMD === 'apply' || CMD === 'enforce') {
    if (CMD === 'enforce') process.argv.push('--mode', 'enforce');
    const order = ONLY ? [ONLY] : ['dns', 'edge', 'headers', 'waf', 'custom', 'ratelimit', 'bots'];
    for (const s of order) {
      if (!STAGES[s]) { fail('unknown stage: ' + s); continue; }
      try { await STAGES[s](); } catch (e) { fail(s + ': ' + e.message); }
      log('');
    }
    if (rollbackLines.length) {
      const f = path.join(HERE, 'ROLLBACK-' + STAMP + '.md');
      fs.writeFileSync(f, '# rollback ' + STAMP + '\n\n' + rollbackLines.join('\n') + '\n');
      log('rollback sheet -> ' + f);
    }
    return;
  }
  fail('unknown command: ' + CMD);
}
main().catch(e => { fail(e.stack || e.message); process.exit(1); });
