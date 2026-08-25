/**
 * 「模型」面板（R41②③）—— 线路配置、可达性探测、连通性测试、一键拉模型、停服开关。
 *
 * 与 R39 那一版最大的不同是**线路成了一串**（最多三条，按顺序试）。他那句
 * 「我必须能使用国内的服务商，无论你使用什么办法」落在这里就是两件具体的东西：
 * ① 预设一键填 —— 十家国内服务商的兼容端点是实测过的（见 `data/providers.ts`）；
 * ② 「探一下能不能连」—— 从 Cloudflare 边缘打一次，顺带打一个对照端点，
 *    当场分清「这家不通」与「出网整体有问题」。R37 那一整轮就卡在没有这颗按钮上。
 *
 * **输入框只在明确的时机回填**（首次进入、保存之后、点「重新读取」）。
 * 每 6 秒那一次轮询只更新「上一次为什么没走通」与每条线路的生效摘要 ——
 * 否则他正在输入框里改端点，一次后台刷新就把手上的字冲掉了。
 */
import { PROVIDERS } from '../../data/providers';
import { PROTO_LABEL } from '../../data/proto';
import { api, q, el, every, beat } from './core';

interface RouteView {
  base: string;
  model: string;
  hasKey: boolean;
  proto: string;
  domestic: boolean;
}

const host = () => q('[data-routes]');
const say = (text: string) => {
  const n = q('[data-model-msg]');
  n.textContent = text;
  n.hidden = !text;
};

let routes: RouteView[] = [];
let routeMax = 3;

/** 一条线路的 DOM。每条都是同一套结构，靠 `data-at` 记住自己是第几条 */
function block(r: RouteView, at: number): HTMLElement {
  const box = el('div', 'route');
  box.dataset.at = String(at);

  const head = el('div', 'route__head');
  head.appendChild(el('span', 'route__name', at === 0 ? '主线' : '备线 ' + at));
  head.appendChild(el('span', 'route__live dim'));
  const drop = el('button', 'key key--quiet2', '删掉这条');
  drop.type = 'button';
  drop.dataset.drop = '1';
  if (at > 0) head.appendChild(drop);
  box.appendChild(head);

  /* 预设：点一下把端点、协议、示例模型、国内标记四样一起填上。
     这四样必须一起填 —— 只填端点的话协议或模型对不上，失败长得跟「连不上」一样 */
  const picks = el('div', 'picks');
  for (const p of PROVIDERS) {
    const b = el('button', 'pick', p.name + (p.domestic ? '' : ' ·境外'));
    b.type = 'button';
    b.title = p.note + (p.intl ? '｜境外镜像：' + p.intl : '');
    b.addEventListener('click', () => {
      q<HTMLInputElement>('[data-base]', box).value = p.base;
      q<HTMLInputElement>('[data-model]', box).value = p.models;
      q<HTMLSelectElement>('[data-proto]', box).value = 'openai';
      q<HTMLInputElement>('[data-domestic]', box).checked = p.domestic;
      q('[data-hint]', box).textContent =
        p.note + (p.intl ? '　境外镜像（账号与密钥另算）：' + p.intl : '');
    });
    picks.appendChild(b);
  }
  box.appendChild(picks);
  box.appendChild(el('p', 'dim hint', '')).setAttribute('data-hint', '');

  box.appendChild(field('端点', `<input class="in" data-base value="${attr(r.base)}" placeholder="https://…/v1" aria-label="端点" />`));
  box.appendChild(
    field(
      '请求格式',
      '<select class="in" data-proto aria-label="请求格式">' +
        Object.entries(PROTO_LABEL)
          .map(
            ([v, label]) =>
              `<option value="${v}"${v === 'bedrock' ? ' disabled' : ''}${v === r.proto ? ' selected' : ''}>${label}</option>`
          )
          .join('') +
        '</select>'
    )
  );
  box.appendChild(
    field(
      '模型（逗号分隔多个，按顺序试）',
      `<input class="in" data-model value="${attr(r.model)}" placeholder="model-a, model-b" aria-label="模型" />`
    )
  );
  box.appendChild(
    field(
      `密钥 <em class="dim">${r.hasKey ? '（已设置，留空＝不改）' : '（还没设）'}</em>`,
      '<input class="in" type="password" data-key autocomplete="off" placeholder="留空＝不改" aria-label="密钥" />'
    )
  );

  const chk = el('label', 'check');
  chk.innerHTML =
    `<input type="checkbox" data-domestic${r.domestic ? ' checked' : ''} />` +
    '<span>这家服务商在国内 <em class="dim">—— 只是个记号，不改变请求怎么发。' +
    '2026-08-25 线上逐家实测过：预设里那十家**边缘全部打得通**（401/403，0.3–2.5 秒），' +
    '所以「国内的用不了」这条不成立。换服务商时还是先点一下右边那颗「探一下」。</em></span>';
  box.appendChild(chk);

  const acts = el('div', 'row');
  for (const [label, act] of [
    ['探一下能不能连', 'reach'],
    ['测一下', 'test'],
    ['看原始流', 'raw'],
    ['拉取可用模型', 'pull'],
  ] as const) {
    const b = el('button', 'key' + (act === 'pull' || act === 'raw' ? ' key--quiet2' : ''), label);
    b.type = 'button';
    b.dataset.act = act;
    acts.appendChild(b);
  }
  box.appendChild(acts);
  box.appendChild(el('div', 'res-box')).setAttribute('data-out', '');
  box.appendChild(el('div', 'picks picks--models')).setAttribute('data-list', '');
  return box;
}

/** `<label>` + 控件。控件是字符串拼的 —— 这一片全是自己造的静态结构，没有外部输入 */
function field(label: string, control: string): HTMLElement {
  const f = el('label', 'field');
  f.innerHTML = `<span class="lab">${label}</span>${control}`;
  return f;
}

/** 往 HTML 属性里塞值。端点与模型名来自后台自己存的配置，但仍然转义 —— 不留这种口子 */
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function renderRoutes() {
  const h = host();
  h.textContent = '';
  routes.forEach((r, i) => h.appendChild(block(r, i)));
  q('[data-add-route]').hidden = routes.length >= routeMax;
}

/** 从表单读回一条线路。密钥留空表示不改，所以空串照原样传上去（Worker 那边认这个约定） */
function read(box: HTMLElement) {
  return {
    base: q<HTMLInputElement>('[data-base]', box).value.trim(),
    model: q<HTMLInputElement>('[data-model]', box).value.trim(),
    key: q<HTMLInputElement>('[data-key]', box).value,
    proto: q<HTMLSelectElement>('[data-proto]', box).value,
    domestic: q<HTMLInputElement>('[data-domestic]', box).checked,
  };
}

export const readAll = () =>
  Array.from(host().querySelectorAll<HTMLElement>('.route')).map(read);

export { routes, routeMax, say };
export const setRoutes = (list: RouteView[], max: number) => {
  routes = list.length ? list : [{ base: '', model: '', hasKey: false, proto: 'openai', domestic: false }];
  routeMax = max || 3;
};

/** 顶上那两行状态：停服开关的真实值 + 上一次为什么没走通。轮询只动这两处 */
export function applyLive(data: Record<string, unknown>) {
  q<HTMLInputElement>('[data-off]').checked = !!data.off;
  const why = q('[data-why]');
  why.textContent = String(data.lastWhy ?? '') || '（还没有失败记录）';
  q('[data-fallback]').textContent = String(data.fallback ?? '');
  beat();
}

every('models', 6000, async () => {
  const { data } = await api('state');
  if (data.logged) applyLive(data);
});
