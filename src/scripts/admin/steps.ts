/**
 * 后台「刷步」面板：账号增删改、条件句、手动跑、最近记录。
 *
 * 密码只进不回：列表接口不回密码，这里保存之后输入框就清空。
 * 条件句那两行数字是规格本身 —— 与 `data/steps.ts` 的 ruleSentence 同一套字段。
 */
import { api, every, q, el, when } from './core';

interface Acc {
  id: string;
  userMask: string;
  enabled: boolean;
  auto: boolean;
  beforeHour: number;
  beforeMinute: number;
  threshold: number;
  toMin: number;
  toMax: number;
  lastSteps: number;
  lastRunAt: number;
  lastRunOk: boolean;
  lastRunMsg: string;
  rule?: string;
}

interface LogRow {
  id: number;
  userMask: string;
  steps: number;
  ok: boolean;
  msg: string;
  ts: number;
  via: string;
}

let editing: string | null = null;

function formEls() {
  return {
    box1: q('[data-steps-form]'),
    box2: q('[data-steps-form2]'),
    box3: q('[data-steps-form3]'),
    user: q<HTMLInputElement>('[data-s-user]'),
    pwd: q<HTMLInputElement>('[data-s-pwd]'),
    enabled: q<HTMLInputElement>('[data-s-enabled]'),
    auto: q<HTMLInputElement>('[data-s-auto]'),
    hh: q<HTMLInputElement>('[data-s-hh]'),
    mm: q<HTMLInputElement>('[data-s-mm]'),
    th: q<HTMLInputElement>('[data-s-th]'),
    min: q<HTMLInputElement>('[data-s-min]'),
    max: q<HTMLInputElement>('[data-s-max]'),
    msg: q<HTMLElement>('[data-s-msg]'),
  };
}

function showForm(on: boolean) {
  const f = formEls();
  f.box1.hidden = !on;
  f.box2.hidden = !on;
  f.box3.hidden = !on;
}

function fillForm(a?: Acc) {
  const f = formEls();
  editing = a?.id ?? null;
  f.user.value = a?.userMask ?? '';
  f.user.readOnly = !!a; // 列表只回脱敏名；改账号名请删了重建
  f.pwd.value = '';
  f.pwd.placeholder = a ? '留空不改密码' : '密码（必填）';
  f.enabled.checked = a ? a.enabled : true;
  f.auto.checked = a ? a.auto : true;
  f.hh.value = String(a?.beforeHour ?? 10);
  f.mm.value = String(a?.beforeMinute ?? 0);
  f.th.value = String(a?.threshold ?? 8000);
  f.min.value = String(a?.toMin ?? 10000);
  f.max.value = String(a?.toMax ?? 12000);
  f.msg.hidden = true;
  showForm(true);
}

function paintList(items: Acc[]) {
  const root = q('[data-steps-list]');
  root.textContent = '';
  if (!items.length) {
    root.appendChild(el('p', 'dim', '还没有账号。点「加账号」。'));
    return;
  }
  for (const a of items) {
    const box = el('div', 'acc');
    const head = el('div', 'acc__head');
    head.appendChild(el('code', 'mono', a.userMask));
    for (const [txt, on] of [
      [a.enabled ? '启用' : '停用', a.enabled],
      [a.auto ? '自动' : '仅手动', a.auto],
    ] as const) {
      const b = el('span', 'chip' + (on ? ' is-on' : ''), txt);
      head.appendChild(b);
    }
    head.appendChild(
      el('span', 'dim', a.lastRunAt ? `上次 ${when(a.lastRunAt)} · ${a.lastRunMsg}` : '还没跑过')
    );
    const acts = el('div', 'row');
    const edit = el('button', 'key key--quiet2', '改');
    edit.type = 'button';
    edit.addEventListener('click', () => fillForm(a));
    const run = el('button', 'key', '立刻刷一次');
    run.type = 'button';
    run.addEventListener('click', async () => {
      run.textContent = '正在刷…';
      run.setAttribute('disabled', '');
      const r = await api('steps-run', { id: a.id });
      run.removeAttribute('disabled');
      run.textContent = r.ok && r.data.ok ? `已刷到 ${String(r.data.steps ?? '')} 步` : `没刷成：${String(r.data.error ?? '')}`;
      setTimeout(() => {
        run.textContent = '立刻刷一次';
        void load();
      }, 1800);
    });
    acts.append(edit, run);
    box.append(head, el('p', 'rule', a.rule ?? ''), acts);
    root.appendChild(box);
  }
}

function paintLog(rows: LogRow[]) {
  const root = q('[data-steps-log]');
  root.textContent = '';
  if (!rows.length) {
    root.appendChild(el('p', 'dim', '还没有记录。'));
    return;
  }
  for (const r of rows.slice(0, 30)) {
    const li = el('div', 'logrow');
    li.appendChild(el('span', r.ok ? 'ok' : 'bad', r.ok ? `✓ ${r.steps}` : '✗'));
    li.appendChild(el('span', '', r.userMask));
    li.appendChild(el('span', '', r.via === 'auto' ? '自动' : '手动'));
    li.appendChild(el('span', '', r.msg));
    li.appendChild(el('span', 'dim', when(r.ts)));
    root.appendChild(li);
  }
}

async function load() {
  const acc = await api('steps-list');
  if (acc.ok) paintList((acc.data.items as Acc[]) ?? []);
  const lg = await api('steps-log');
  if (lg.ok) paintLog((lg.data.items as LogRow[]) ?? []);
  const sum = q('[data-steps-sum]');
  const n = ((acc.data.items as Acc[]) ?? []).length;
  sum.textContent = n ? `${n} 个账号` : '';
}

async function save() {
  const f = formEls();
  const body: Record<string, unknown> = {
    id: editing ?? '',
    user: f.user.value.trim(),
    pwd: f.pwd.value,
    enabled: f.enabled.checked,
    auto: f.auto.checked,
    beforeHour: Number(f.hh.value) || 0,
    beforeMinute: Number(f.mm.value) || 0,
    threshold: Number(f.th.value) || 0,
    toMin: Number(f.min.value) || 0,
    toMax: Number(f.max.value) || 0,
  };
  const r = await api('steps-put', body);
  f.msg.hidden = false;
  if (r.ok) {
    f.msg.textContent = '已保存';
    f.pwd.value = '';
    showForm(false);
    void load();
  } else {
    f.msg.textContent = String(r.data.error ?? '存不进去');
  }
}

export function wireSteps() {
  q('[data-steps-new]').addEventListener('click', () => fillForm());
  q('[data-steps-refresh]').addEventListener('click', () => void load());
  q('[data-s-save]').addEventListener('click', () => void save());
  q('[data-s-cancel]').addEventListener('click', () => showForm(false));
  q('[data-s-del]').addEventListener('click', async () => {
    if (!editing) return;
    await api('steps-del', { id: editing });
    showForm(false);
    void load();
  });
  /* 刷步不急着轮询 —— 10 秒一次足够看见「刚才手动刷的结果」 */
  every('steps', 10000, () => load());
}
