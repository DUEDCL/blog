/**
 * 「模型」面板的动作（R41②③）：探可达性、测模型、看原始流、拉模型列表、加线路、保存。
 *
 * 拆成第二个文件是因为 `models.ts` 那边全是「怎么把线路画出来」，这边全是
 * 「点了会发生什么」—— 两件事各自都不短，混在一个文件里找不到东西。
 *
 * 事件用**委托**：线路块是脚本造出来又随时会被重画的，逐个绑事件的话每次重画都要重绑，
 * 忘一次就是一颗按不动的按钮。委托到 `[data-routes]` 上，重画多少次都不用管。
 */
import { api, q, el } from './core';
import { readAll, renderRoutes, routes, routeMax, say, setRoutes } from './models';

/** 一条结果。三档配色与 R37 定的那三档一致：可用 / 不认角色 / 连不上 */
function line(out: HTMLElement, cls: string, head: string, body: string) {
  const box = el('div', 'res ' + cls);
  box.appendChild(el('p', 'res__head', head));
  if (body) box.appendChild(el('p', 'res__body', body));
  out.appendChild(box);
}

const at = (box: HTMLElement) => Number(box.dataset.at) || 0;

/** 探可达性。三种结论各有一句人话 —— 这颗按钮的价值就在于把结论说清，不是报个状态码 */
async function reach(box: HTMLElement) {
  const out = q('[data-out]', box);
  out.textContent = '';
  const f = readAll()[at(box)];
  if (!f.base) return line(out, 'res--bad', '先填端点', '');

  line(out, '', '探…（最多 10 秒）', '打这家的模型列表端点，同时打一个对照端点');
  const qs = new URLSearchParams({ base: f.base, proto: f.proto, ...(f.key ? { key: f.key } : {}) });
  const { data } = await api('reach?' + qs.toString());
  out.textContent = '';

  if (!data.ok) return line(out, 'res--bad', '探不了', String(data.error ?? ''));

  const t = (data.target ?? {}) as { ms?: number; status?: number; error?: string };
  const cs = (data.controls ?? []) as { label: string; ms?: number; status?: number; error?: string }[];
  const shot = (x: { ms?: number; status?: number; error?: string }) =>
    (x.status ? 'HTTP ' + x.status : x.error || '无响应') + ' · ' + ((x.ms ?? 0) / 1000).toFixed(1) + 's';

  const verdict = String(data.verdict ?? '');
  const say3 =
    verdict === 'reachable'
      ? ['res--ok', '通了', '出网能打到这家。接下来看密钥与模型 —— 401 只说明密钥不对，不是不通。']
      : verdict === 'blocked'
        ? [
            'res--bad',
            '这一家不通',
            '对照端点有响应、这家没有：要么跨境被掐，要么它在拦云厂商出网（R37 那次就是）。' +
              '换境外镜像域名，或者把它放到备线、主线用别家。',
          ]
        : [
            'res--warn',
            '出网整体有问题',
            '两个对照端点也都超时了 —— 这一次与这家服务商无关。' +
              '本机 wrangler dev 下这一档也可能是代理没开，线上才是真的出网异常。',
          ];

  line(out, say3[0], say3[1], say3[2]);
  line(
    out,
    '',
    '这家：' + shot(t),
    cs.map((c) => '对照 ' + c.label + '：' + shot(c)).join('\n')
  );
}

/** 测模型。判据与显示口径沿用 R37 定的三档，`promptTokens` 是「知识库到没到」的证据 */
async function test(box: HTMLElement) {
  const out = q('[data-out]', box);
  out.textContent = '';
  line(out, '', '挨个打一次…（每个最多等 30 秒）', '');

  const f = readAll()[at(box)];
  const { ok, data } = await api('test', { ...f, at: at(box) });
  out.textContent = '';
  if (!ok) return line(out, 'res--bad', '测不了', String(data.error ?? ''));

  if (data.kbCount) line(out, '', '知识库 ' + data.kbCount + ' 条已送进提示词', '');

  for (const r of (data.results ?? []) as Record<string, unknown>[]) {
    const okr = !!r.ok;
    const obedient = !!r.obedient;
    const pt = r.promptTokens == null ? '' : ' · 提示词 ' + r.promptTokens + ' token' + (Number(r.promptTokens) < 2000 ? ' ⚠ 太少，system 被丢了' : '');
    line(
      out,
      okr ? (obedient ? 'res--ok' : 'res--warn') : 'res--bad',
      (okr ? (obedient ? '可用' : '不认角色') : '连不上') +
        ' · ' + String(r.model) +
        ' · ' + (Number(r.ms) / 1000).toFixed(1) + 's' +
        (r.status ? ' · HTTP ' + r.status : '') +
        (r.think ? ' · 思考 ' + r.think + ' 字' : '') +
        pt,
      okr
        ? String(r.text || '（正文是空的）')
        : String(r.error ||
            (r.think
              ? '思考占满了测试预算（300 token），正文没出来 —— 真实对话给 700，不一定不行'
              : '（没有错误信息）'))
    );
  }
}

/** 原始流。R39 加的那条不解析通道：流式一个字都不出时，只有它能说明上游到底吐了什么 */
async function raw(box: HTMLElement) {
  const out = q('[data-out]', box);
  out.textContent = '';
  line(out, '', '取上游流式响应的头几百字节…', '');
  const { ok, data } = await api('test', { ...readAll()[at(box)], at: at(box), raw: true });
  out.textContent = '';
  if (!ok) return line(out, 'res--bad', '取不到', String(data.error ?? ''));
  line(
    out,
    'res--warn',
    String(data.model) + ' · HTTP ' + String(data.status) + ' · ' + String(data.ct ?? ''),
    String(data.raw ?? '（空）')
  );
}

/** 拉模型列表。点一个加进候选、再点撤掉 —— 多候选是常态，上游会漂移 */
async function pull(box: HTMLElement) {
  const list = q('[data-list]', box);
  const out = q('[data-out]', box);
  list.textContent = '';
  out.textContent = '';
  const f = readAll()[at(box)];
  const qs = new URLSearchParams({ base: f.base, proto: f.proto, ...(f.key ? { key: f.key } : {}) });
  line(out, '', '拉…', '');
  const { ok, data } = await api('models?' + qs.toString());
  out.textContent = '';
  if (!ok) return line(out, 'res--bad', '拉不到', String(data.error ?? ''));

  const models = (data.models ?? []) as string[];
  line(out, '', models.length + ' 个（点一个加进候选，再点撤掉）', '');
  const input = q<HTMLInputElement>('[data-model]', box);
  const have = () => input.value.split(',').map((s) => s.trim()).filter(Boolean);

  for (const m of models) {
    const b = el('button', 'pick', m);
    b.type = 'button';
    if (have().includes(m)) b.classList.add('is-on');
    b.addEventListener('click', () => {
      const cur = have();
      const on = cur.includes(m);
      input.value = (on ? cur.filter((x) => x !== m) : [...cur, m]).join(', ');
      b.classList.toggle('is-on', !on);
    });
    list.appendChild(b);
  }
}

export function wireModels() {
  q('[data-routes]').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const box = t.closest<HTMLElement>('.route');
    if (!box) return;
    if (t.dataset.drop) {
      box.remove();
      // 删完要重编号，否则 `data-at` 与后端那个数组的下标对不上（密钥沿用是按位置的）
      Array.from(q('[data-routes]').querySelectorAll<HTMLElement>('.route')).forEach((b, i) => {
        b.dataset.at = String(i);
        q('.route__name', b).textContent = i === 0 ? '主线' : '备线 ' + i;
      });
      q('[data-add-route]').hidden = false;
      say('删掉了一条，记得点保存才生效');
      return;
    }
    const act = t.dataset.act;
    if (act === 'reach') void reach(box);
    else if (act === 'test') void test(box);
    else if (act === 'raw') void raw(box);
    else if (act === 'pull') void pull(box);
  });

  q('[data-add-route]').addEventListener('click', () => {
    const cur = readAll();
    setRoutes(
      [
        ...cur.map((r) => ({ base: r.base, model: r.model, hasKey: false, proto: r.proto, domestic: r.domestic })),
        { base: '', model: '', hasKey: false, proto: 'openai', domestic: false },
      ],
      routeMax
    );
    renderRoutes();
    say('加了一条备线。填好之后点保存');
  });

  q('[data-save]').addEventListener('click', async () => {
    say('存…');
    const { ok, data } = await api('save', {
      routes: readAll(),
      off: q<HTMLInputElement>('[data-off]').checked,
    });
    if (!ok) return say('没存上：' + String(data.error ?? ''));
    const st = await api('state');
    if (st.data.logged) {
      setRoutes((st.data.routes ?? []) as never[], Number(st.data.routeMax) || 3);
      renderRoutes();
    }
    say('存好了，下一次对话就用新的（' + routes.length + ' 条线路）');
  });
}
