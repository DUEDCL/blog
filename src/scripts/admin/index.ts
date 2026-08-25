/**
 * 后台的外壳（R41②）：登录、顶部状态栏与五个面板的切换、顶栏那几个实时数字。
 *
 * 五个面板的名字与他给的一字不差：模型 / 聊天记录 / 聊天实时接管 / 文章编辑 / 图库管理。
 *
 * **面板的 markup 一直在页面里，只是 hidden。** 不做按需渲染的理由：这一页是登录后才有内容的
 * 空壳（`admin.astro` 顶部那条约束），五个面板加起来也就几十个节点，
 * 换 tab 要的是立刻切过去，不是再等一次渲染。
 *
 * 各面板的接线只在**登录成功之后跑一次**：`wireWrite` 之类会立刻去拉数据，
 * 未登录时跑等于白挨一串 401。
 */
import { activate, api, every, q } from './core';
import { applyLive, renderRoutes, setRoutes } from './models';
import { wireModels } from './models-acts';
import { wireLogs } from './logs';
import { wireLive } from './live';
import { wireWrite } from './write-tools';
import { wireGallery } from './gallery';

const TABS = ['models', 'logs', 'live', 'write', 'gallery'] as const;
type Tab = (typeof TABS)[number];

const views = {
  load: q('[data-view="load"]'),
  login: q<HTMLFormElement>('[data-view="login"]'),
  panel: q('[data-view="panel"]'),
};

const show = (which: 'load' | 'login' | 'panel') => {
  views.load.hidden = which !== 'load';
  views.login.hidden = which !== 'login';
  views.panel.hidden = which !== 'panel';
};

/** 记住上次待在哪个 tab。他多半是为了同一件事反复回来 */
const KEY = 'adm:tab';

function setTab(name: string) {
  const tab = (TABS as readonly string[]).includes(name) ? (name as Tab) : 'models';
  for (const t of TABS) {
    q('[data-panel="' + t + '"]').hidden = t !== tab;
    q('[data-tab="' + t + '"]').classList.toggle('is-on', t === tab);
  }
  activate(tab);
  try {
    localStorage.setItem(KEY, tab);
  } catch {
    /* 隐私模式下会抛 —— 记不住就每次从「模型」开始，不影响用 */
  }
}

let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;
  wireModels();
  wireLogs();
  wireLive();
  wireWrite();
  wireGallery();
  for (const t of TABS) {
    q('[data-tab="' + t + '"]').addEventListener('click', () => setTab(t));
  }
  // 图库那边「编辑元信息」要把人送到写作台，靠这个事件而不是相互 import（会成环）
  document.addEventListener('adm:tab', (e) => setTab(String((e as CustomEvent).detail)));

  let saved = 'models';
  try {
    saved = localStorage.getItem(KEY) ?? 'models';
  } catch {
    /* 读不到就默认第一个 */
  }
  setTab(saved);
}

/** 拉一次状态，决定显示登录框还是控制台 */
async function refresh() {
  const { data } = await api('state');

  if (!data.logged) {
    show('login');
    // 「口令还没设」不是登录失败，要明确告诉他该跑哪几条命令
    q('[data-noset]').hidden = data.ready !== false;
    q<HTMLInputElement>('[data-pass]').focus();
    return;
  }

  setRoutes((data.routes ?? []) as never[], Number(data.routeMax) || 3);
  renderRoutes();
  applyLive(data);
  show('panel');
  wireOnce();
}

views.login.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = q('[data-err]');
  const pass = q<HTMLInputElement>('[data-pass]');
  err.hidden = true;
  const { ok } = await api('login', { pass: pass.value });
  pass.value = '';
  if (!ok) {
    err.textContent = '进不去';
    err.hidden = false;
    return;
  }
  show('load');
  await refresh();
});

q('[data-logout]').addEventListener('click', async () => {
  await api('logout', {});
  location.reload();
});

/* ---- 顶栏那几个实时数字 --------------------------------------------------
   常驻任务（tab 传 `'*'`）：不管在哪个面板都跑。它是「后台一眼能看出现在有事没事」
   的唯一来源 —— 尤其「有人在等」那个数字，看着「文章编辑」也该看得见。

   `wired` 当门闸：没登录的时候一次都不打。不加这道闸的话，停在登录框上的这一页
   会每 4 秒挨一个 401，控制台里刷一屏红字 —— 本地验收时就是这么发现的。 */
every('*', 4000, async () => {
  if (!wired) return;
  const { ok, data } = await api('stat');
  if (!ok) return;
  const num = (sel: string, v: unknown, hot = false) => {
    const n = document.querySelector<HTMLElement>(sel);
    if (!n) return;
    const val = Number(v) || 0;
    n.textContent = val ? String(val) : '';
    n.hidden = !val;
    n.classList.toggle('is-hot', hot && val > 0);
  };
  num('[data-badge="logs"]', data.sessions);
  num('[data-badge="live"]', data.waiting, true);
  num('[data-badge="write"]', data.drafts);
  q('[data-sum]').textContent =
    [
      Number(data.sessions) || 0 ? (data.sessions as number) + ' 个会话' : '还没人聊过',
      (Number(data.msgs) || 0) + ' 条消息',
      (Number(data.takeover) || 0) + ' 个接管中',
      (Number(data.drafts) || 0) + ' 份草稿',
      (Number(data.content) || 0) + ' 个内容文件',
    ].join(' · ');
});

void refresh();
