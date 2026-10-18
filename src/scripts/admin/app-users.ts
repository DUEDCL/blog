/**
 * 后台「用户」面板（R48 步数管家 · 多用户版）。
 *
 * 只做四件事：看注册用户、加/改 VIP、封禁/解封、删除。
 * 绑定的 Zepp 账号、自动任务与日志属于用户隐私，这里只看状态摘要；
 * 需要排查时靠用户自己的 /bushu 页与「最近记录」。
 */
import { api, every, q, el, when } from './core';

interface UserRow {
  id: string;
  account: string;
  nick: string;
  createdAt: number;
  vipUntil: number;
  isVip: boolean;
  status: number;
  bound: boolean;
  zeppUser: string;
  lastSteps: number;
  lastRunAt: number;
  lastRunOk: boolean;
  nextRunAt: number;
}

let loading = false;

function message(text: string) {
  const n = q<HTMLElement>('[data-users-msg]');
  n.textContent = text;
  window.setTimeout(() => {
    if (n.textContent === text) n.textContent = '';
  }, 2400);
}

function day(ms: number): string {
  return ms ? new Date(ms).toLocaleDateString('zh-CN').replace(/\//g, '-') : '';
}

function renderUsers(items: UserRow[], total: number, vip: number, bound: number) {
  const box = q<HTMLElement>('[data-users-list]');
  box.textContent = '';
  q<HTMLElement>('[data-users-sum]').textContent =
    total > 0 ? `${total} 人 · VIP ${vip} · 已绑定 ${bound}` : '';

  if (!items.length) {
    box.appendChild(el('p', 'dim', '还没有用户。'));
    return;
  }

  for (const u of items) {
    const wrap = el('div', 'acc');
    const head = el('div', 'acc__head');
    head.appendChild(el('code', 'mono', u.account));
    if (u.nick) head.appendChild(el('span', 'dim', u.nick));
    if (u.isVip) head.appendChild(el('span', 'chip is-on', `VIP 至 ${day(u.vipUntil)}`));
    else head.appendChild(el('span', 'chip', '非 VIP'));
    head.appendChild(el('span', 'chip' + (u.bound ? ' is-on' : ''), u.bound ? '已绑定' : '未绑定'));
    if (!u.status) head.appendChild(el('span', 'chip', '已封禁'));

    const meta = el(
      'p',
      'dim',
      [
        `注册 ${when(u.createdAt)}`,
        u.bound ? `Zepp ${u.zeppUser}` : '还没绑定 Zepp',
        u.lastSteps ? `上次 ${u.lastSteps} 步` : '',
        u.nextRunAt ? `下次自动 ${when(u.nextRunAt)}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    );

    const acts = el('div', 'row');
    const vipBtn = (days: number, label: string) => {
      const b = el('button', 'key key--quiet2', label);
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.setAttribute('disabled', '');
        const r = await api('app-user-vip', { id: u.id, days });
        b.removeAttribute('disabled');
        if (r.ok) {
          message(`已加 ${days} 天`);
          void load();
        } else message(String(r.data.error ?? '没改成'));
      });
      return b;
    };
    acts.append(vipBtn(30, '+30 天'), vipBtn(90, '+90 天'), vipBtn(365, '+365 天'));

    const ban = el('button', 'key key--quiet', u.status ? '封禁' : '解封');
    ban.type = 'button';
    ban.addEventListener('click', async () => {
      const r = await api('app-user-set', { id: u.id, status: u.status ? 0 : 1 });
      if (r.ok) {
        message(u.status ? '已封禁' : '已解封');
        void load();
      } else message(String(r.data.error ?? '没改成'));
    });
    acts.appendChild(ban);

    const del = el('button', 'key key--quiet', '删除');
    del.type = 'button';
    del.addEventListener('click', async () => {
      if (!window.confirm(`删除用户 ${u.account}？绑定、日志、会话都会一起删，不可恢复。`)) return;
      const r = await api('app-user-del', { id: u.id });
      if (r.ok) {
        message('已删除');
        void load();
      } else message(String(r.data.error ?? '没删成'));
    });
    acts.appendChild(del);

    wrap.append(head, meta, acts);
    box.appendChild(wrap);
  }
}

async function load() {
  if (loading) return;
  loading = true;
  try {
    const kw = q<HTMLInputElement>('[data-users-q]').value.trim();
    const r = await api('app-users' + (kw ? '?q=' + encodeURIComponent(kw) : ''));
    if (r.ok) {
      renderUsers(
        (r.data.items as UserRow[]) ?? [],
        Number(r.data.total) || 0,
        Number(r.data.vip) || 0,
        Number(r.data.bound) || 0
      );
    } else {
      message(String(r.data.error ?? '用户列表读不出来'));
    }
  } finally {
    loading = false;
  }
}

async function loadConfig() {
  const r = await api('app-config');
  if (!r.ok) return;
  const c = (r.data.config ?? {}) as Record<string, unknown>;
  const set = (sel: string, v: string) => {
    const n = q<HTMLInputElement>(sel);
    if (n) n.value = v;
  };
  set('[data-cfg-max]', String(Number(c.maxUsers) || 500));
  set('[data-cfg-int]', String(Number(c.freeInterval) || 60));
  set('[data-cfg-daily]', String(Number(c.freeDaily) || 50));
  set('[data-cfg-buy]', String(c.buyNote ?? ''));
  const open = q<HTMLInputElement>('[data-cfg-open]');
  if (open) open.checked = c.open !== false;
}

async function saveConfig() {
  const body = {
    maxUsers: Number(q<HTMLInputElement>('[data-cfg-max]').value) || 500,
    freeInterval: Number(q<HTMLInputElement>('[data-cfg-int]').value) || 60,
    freeDaily: Number(q<HTMLInputElement>('[data-cfg-daily]').value) || 50,
    buyNote: q<HTMLInputElement>('[data-cfg-buy]').value.trim(),
    open: q<HTMLInputElement>('[data-cfg-open]').checked,
  };
  const msg = q<HTMLElement>('[data-cfg-msg]');
  const r = await api('app-config-save', body);
  msg.hidden = false;
  msg.textContent = r.ok ? '已保存（用户页刷新后生效）' : String(r.data.error ?? '没存进去');
  if (r.ok) {
    message('设置已保存');
    void loadConfig();
  }
}

export function wireAppUsers() {
  q('[data-users-search]').addEventListener('click', () => void load());
  q('[data-users-refresh]').addEventListener('click', () => {
    void load();
    void loadConfig();
  });
  q<HTMLInputElement>('[data-users-q]').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void load();
  });
  q('[data-cfg-save]').addEventListener('click', () => void saveConfig());
  q('[data-app-auto]').addEventListener('click', async () => {
    message('正在跑到期自动任务…');
    const r = await api('app-auto-run', {});
    if (r.ok) message(`已执行 ${Number(r.data.ran) || 0} 个（跳过 ${Number(r.data.skipped) || 0} 个）`);
    else message(String(r.data.error ?? '执行失败'));
  });

  void loadConfig();
  /* 用户数变化不快，15 秒一次足够；面板切走时节拍器会自己停 */
  every('users', 15000, () => load());
}
