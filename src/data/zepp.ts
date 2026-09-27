/**
 * Zepp Life（小米运动）刷步协议层。
 *
 * 端口自 mimotion / zepp_helper.py + aes_help.py，三件事：
 * ① 登录拿 access_token（表单要 AES-128-CBC，密钥与 IV 是华米固定的）；
 * ② 换 login_token / app_token / user_id；
 * ③ 提交一份伪造的 band_data（把模板里的日期与步数换掉）。
 *
 * 只在 Worker 侧调用 —— 密码与 token 不进浏览器。
 * AES 用 Web Crypto（AES-CBC 自带 PKCS7），不引第三方库。
 *
 * 上游端点都是华米 / Zepp 的公开接口，与 mimotion 同一套。
 * 跨境到这些域名不保证通（与点歌台那条链路同一类问题），所以每一步
 * 都要能单独失败并给出中文原因。
 */
import { BAND_TEMPLATE } from './zepp-band';
import { beijingDate, clampSteps } from './steps';

/** 华米传输加密：固定密钥与 IV（来自 Zepp_API，mimotion 同源） */
const HM_KEY = 'xeNtBVqzDc6tuNTh';
const HM_IV = 'MAAAYAAAAAAAAABg';

const enc = new TextEncoder();

function bytesOf(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(enc.encode(s).buffer as ArrayBuffer);
}

async function aesCbcEncrypt(plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', bytesOf(HM_KEY), 'AES-CBC', false, [
    'encrypt',
  ]);
  const out = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: bytesOf(HM_IV) },
    key,
    plain
  );
  return new Uint8Array(out);
}

/** 登录请求体：华米要的是 application/x-www-form-urlencoded 再整体加密 */
function loginQuery(user: string, password: string): string {
  const data = {
    emailOrPhone: user,
    password,
    state: 'REDIRECTION',
    client_id: 'HuaMi',
    country_code: 'CN',
    token: 'access',
    redirect_uri: 'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html',
  };
  // 与 Python 的 urlencode 一致：空格变 '+'
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%20/g, '+')}`)
    .join('&');
}

const UA = 'MiFit6.14.0 (M2007J1SC; Android 12; Density/2.75)';
const APP = 'com.xiaomi.hm.health';

export interface ZeppTokens {
  access_token: string;
  login_token: string;
  app_token: string;
  user_id: string;
  device_id: string;
  /** 各 token 的获取时刻（毫秒） */
  access_token_time: number;
  login_token_time: number;
  app_token_time: number;
}

export type ZeppResult<T> = { ok: true; data: T } | { ok: false; error: string };

function fail<T>(error: string): ZeppResult<T> {
  return { ok: false, error };
}

function uuid(): string {
  return crypto.randomUUID();
}

/** 从 302 Location 里抠出 access=… / error=… */
function pickQuery(location: string, key: string): string | null {
  const m = new RegExp(`(?:^|[?&])${key}=([^&]+)`).exec(location);
  return m ? decodeURIComponent(m[1]) : null;
}

/** ① 账号密码 → access_token */
export async function loginAccessToken(
  user: string,
  password: string
): Promise<ZeppResult<string>> {
  // 手机号补 +86，与 mimotion 一致；邮箱原样
  const account = user.startsWith('+86') || user.includes('@') ? user : '+86' + user;

  let cipher: Uint8Array<ArrayBuffer>;
  try {
    cipher = await aesCbcEncrypt(bytesOf(loginQuery(account, password)));
  } catch (e) {
    return fail('登录加密失败：' + (e instanceof Error ? e.message : String(e)));
  }

  let res: Response;
  try {
    res = await fetch('https://api-user.zepp.com/v2/registrations/tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'user-agent': UA,
        app_name: APP,
        appname: APP,
        appplatform: 'android_phone',
        'x-hm-ekv': '1',
        'hm-privacy-ceip': 'false',
      },
      body: cipher as unknown as BodyInit,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return fail('连不上 Zepp 登录接口：' + (e instanceof Error ? e.message : String(e)));
  }

  if (res.status !== 303) return fail(`登录异常，status: ${res.status}`);
  const location = res.headers.get('location') ?? '';
  const code = pickQuery(location, 'access');
  if (!code) {
    return fail('拿不到 accessToken：' + (pickQuery(location, 'error') ?? '未知错误'));
  }
  return { ok: true, data: code };
}

/** ② access_token → login_token / app_token / user_id */
export async function grantLoginTokens(
  accessToken: string,
  deviceId: string,
  isPhone: boolean
): Promise<ZeppResult<{ login_token: string; app_token: string; user_id: string }>> {
  const data: Record<string, string> = isPhone
    ? {
        app_name: APP,
        app_version: '6.14.0',
        code: accessToken,
        country_code: 'CN',
        device_id: deviceId,
        device_model: 'phone',
        grant_type: 'access_token',
        third_name: 'huami_phone',
      }
    : {
        'allow_registration=': 'false',
        app_name: APP,
        app_version: '6.14.0',
        code: accessToken,
        country_code: 'CN',
        device_id: deviceId,
        device_model: 'android_phone',
        dn: 'account.zepp.com,api-user.zepp.com,api-mifit.zepp.com,api-watch.zepp.com,app-analytics.zepp.com,api-analytics.huami.com,auth.zepp.com',
        grant_type: 'access_token',
        lang: 'zh_CN',
        os_version: '1.5.0',
        source: `${APP}:6.14.0:50818`,
        third_name: 'email',
      };

  let res: Response;
  try {
    res = await fetch('https://account.huami.com/v2/client/login', {
      method: 'POST',
      headers: {
        app_name: APP,
        'x-request-id': uuid(),
        'accept-language': 'zh-CN',
        appname: APP,
        cv: '50818_6.14.0',
        v: '2.0',
        appplatform: 'android_phone',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: new URLSearchParams(data).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return fail('连不上华米登录接口：' + (e instanceof Error ? e.message : String(e)));
  }

  let j: Record<string, unknown>;
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    return fail(`华米登录返回的不是 JSON（status ${res.status}）`);
  }
  if (j.result !== 'ok') return fail('客户端登录失败：' + String(j.result ?? j.message ?? ''));
  const tok = j.token_info as
    | { login_token?: string; app_token?: string; user_id?: string }
    | undefined;
  if (!tok?.login_token || !tok.app_token || !tok.user_id)
    return fail('登录返回里缺 token');
  return {
    ok: true,
    data: {
      login_token: tok.login_token,
      app_token: tok.app_token,
      user_id: tok.user_id,
    },
  };
}

/** 用 login_token 换一颗新的 app_token（旧的过期时） */
export async function grantAppToken(loginToken: string): Promise<ZeppResult<string>> {
  const url =
    'https://account-cn.huami.com/v1/client/app_tokens' +
    `?app_name=${APP}&dn=api-user.huami.com%2Capi-mifit.huami.com%2Capp-analytics.huami.com` +
    `&login_token=${encodeURIComponent(loginToken)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'MiFit/5.3.0 (iPhone; iOS 14.7.1; Scale/3.00)' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return fail('换 app_token 失败：' + (e instanceof Error ? e.message : String(e)));
  }
  if (res.status !== 200) return fail(`换 app_token 异常：${res.status}`);
  let j: Record<string, unknown>;
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    return fail('换 app_token 返回的不是 JSON');
  }
  if (j.result !== 'ok') return fail('换 app_token 失败：' + String(j.error_code ?? j.result ?? ''));
  const tok = j.token_info as { app_token?: string } | undefined;
  if (!tok?.app_token) return fail('换 app_token 返回里缺 token');
  return { ok: true, data: tok.app_token };
}

/** app_token 是否还能用 */
export async function checkAppToken(appToken: string): Promise<boolean> {
  const params = new URLSearchParams({
    r: uuid(),
    userid: '1188760659',
    appid: '428135909242707968',
    channel: 'Normal',
    country: 'CN',
    cv: '50818_6.14.0',
    device: 'android_31',
    device_type: 'android_phone',
    lang: 'zh_CN',
    timezone: 'Asia/Shanghai',
    v: '2.0',
  });
  try {
    const res = await fetch('https://api-mifit-cn3.zepp.com/huami.health.getUserInfo.json?' + params, {
      headers: {
        'User-Agent': UA,
        apptoken: appToken,
        appname: APP,
        clientid: '428135909242707968',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (res.status !== 200) return false;
    const j = (await res.json()) as { message?: string };
    return j.message === 'success';
  } catch {
    return false;
  }
}

/**
 * 尽力读今日步数。读不到就回 null —— 调用方用 lastSteps 兜底。
 * 用 summary 查询；上游形状偶尔会变，所以解析失败一律当读不到，不抛。
 */
export async function getTodaySteps(
  appToken: string,
  userId: string
): Promise<number | null> {
  const day = beijingDate();
  const params = new URLSearchParams({
    query_type: 'summary',
    start_date: day,
    end_date: day,
    r: uuid(),
    userid: userId,
    appid: '428135909242707968',
    channel: 'Normal',
    country: 'CN',
    cv: '50818_6.14.0',
    device: 'android_31',
    device_type: 'android_phone',
    lang: 'zh_CN',
    timezone: 'Asia/Shanghai',
    v: '2.0',
  });
  try {
    const res = await fetch(
      'https://api-mifit-cn.huami.com/v1/data/band_data.json?' + params,
      {
        headers: {
          'User-Agent': UA,
          apptoken: appToken,
          appname: APP,
          clientid: '428135909242707968',
        },
        signal: AbortSignal.timeout(12000),
      }
    );
    if (res.status !== 200) return null;
    const j = (await res.json()) as Record<string, unknown>;
    // 常见形状：{ data: [{ summary: "{\"ttl\":123,...}" }] } 或直接 summary
    const raw = j.summary ?? (j.data as { summary?: unknown }[] | undefined)?.[0]?.summary;
    if (raw == null) return null;
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const obj = (
      typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>)
    ) as { ttl?: unknown; steps?: unknown; step?: unknown };
    const n = Number(obj.ttl ?? obj.steps ?? obj.step);
    if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
    // 兜底：从串里抠 ttl
    const m = /"ttl"\s*:\s*(\d+)/.exec(text);
    if (m) return Number(m[1]);
    return null;
  } catch {
    return null;
  }
}

/**
 * ③ 提交伪造的 band_data。
 * 模板是 URL 编码串，里面 date 与 ttl 是占位，提交前替换成今日与目标步数。
 */
export async function postSteps(
  appToken: string,
  userId: string,
  steps: number
): Promise<ZeppResult<number>> {
  const step = clampSteps(steps);
  const day = beijingDate();
  // 模板里的占位与 mimotion 的正则同一组
  let dataJson = BAND_TEMPLATE.split('2021-08-07').join(day);
  dataJson = dataJson.split('18272').join(String(step));

  const t = String(Date.now());
  const url = `https://api-mifit-cn.huami.com/v1/data/band_data.json?&t=${t}&r=${uuid()}`;
  const body =
    `userid=${encodeURIComponent(userId)}` +
    `&last_sync_data_time=1597306380&device_type=0&last_deviceid=DA932FFFFE8816E7` +
    `&data_json=${dataJson}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        apptoken: appToken,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return fail('提交步数连不上：' + (e instanceof Error ? e.message : String(e)));
  }
  if (res.status !== 200) return fail(`提交步数异常：${res.status}`);
  let j: Record<string, unknown>;
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    return fail('提交步数返回的不是 JSON');
  }
  if (j.message !== 'success') return fail('提交失败：' + String(j.message ?? j.description ?? ''));
  return { ok: true, data: step };
}

/**
 * 保证有一颗可用的 app_token。
 * 顺序：缓存的 app_token → 用 login_token 换 → 用 access_token 重登。
 * 返回更新后的 token 包（调用方负责写回 DO）。
 */
export async function ensureAppToken(
  user: string,
  password: string,
  cached: ZeppTokens | null
): Promise<ZeppResult<ZeppTokens>> {
  const now = Date.now();
  const isPhone = !user.includes('@');
  const deviceId = cached?.device_id || uuid();

  if (cached?.app_token && (await checkAppToken(cached.app_token))) {
    return { ok: true, data: cached };
  }

  if (cached?.login_token) {
    const g = await grantAppToken(cached.login_token);
    if (g.ok) {
      return {
        ok: true,
        data: { ...cached, app_token: g.data, app_token_time: now },
      };
    }
  }

  // 重登
  const account = user.startsWith('+86') || user.includes('@') ? user : '+86' + user;
  const at = await loginAccessToken(account, password);
  if (!at.ok) return at;
  const gt = await grantLoginTokens(at.data, deviceId, isPhone);
  if (!gt.ok) return gt;
  return {
    ok: true,
    data: {
      access_token: at.data,
      login_token: gt.data.login_token,
      app_token: gt.data.app_token,
      user_id: gt.data.user_id,
      device_id: deviceId,
      access_token_time: now,
      login_token_time: now,
      app_token_time: now,
    },
  };
}

/** 跑一次完整刷步：拿 token → 查今日（可选）→ 提交 */
export async function runBrush(
  user: string,
  password: string,
  cached: ZeppTokens | null,
  targetSteps: number
): Promise<ZeppResult<{ steps: number; tokens: ZeppTokens; todayBefore: number | null }>> {
  const tok = await ensureAppToken(user, password, cached);
  if (!tok.ok) return tok;
  const todayBefore = await getTodaySteps(tok.data.app_token, tok.data.user_id);
  const post = await postSteps(tok.data.app_token, tok.data.user_id, targetSteps);
  if (!post.ok) return post;
  return {
    ok: true,
    data: { steps: post.data, tokens: tok.data, todayBefore },
  };
}
