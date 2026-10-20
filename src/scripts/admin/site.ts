/**
 * 后台 · 「站点账号」分区（邀请码 + 用户）。
 *
 * 独立成一个模块，不并进 `scripts/admin/index.ts`：那一份是点歌台/对话那套东西的编排，
 * 加进去要动它的分区切换逻辑。这里只做副作用绑定 —— 分区显示时才加载数据。
 *
 * 接口在 `src/lib/site-admin.ts`（走 `/api/admin/site-*`，鉴权由后台口令 cookie 负责）。
 *
 * **编辑入口用 `prompt()` 而不是行内表单**：这一版的目标是「站长能自己手动改有效期与次数」，
 * 一个 prompt 换一行代码。后面真要频繁改，再换成行内输入框。
 */

const API = '/api/admin/';

function $(s: string): HTMLElement | null {
  return document.querySelector(s);
}
function $all(s: string): HTMLElement[] {
  return Array.from(document.querySelectorAll(s));
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'HTTP ' + res.status };
  }
}

function fmtTime(v: unknown): string {
  const n = Number(v);
  if (!n) return '—';
  const d = new Date(n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ─────────────────────── 邀请码 ─────────────────────── */

function renderInvites(rows: Record<string, unknown>[]): void {
  const box = $('[data-inv-list]');
  if (!box) return;
  box.innerHTML = '';

  const sum = $('[data-site-sum]');
  if (sum) {
    const live = rows.filter((r) => Number(r.status) === 1).length;
    sum.textContent = `${rows.length} 个码 · ${live} 个启用`;
  }

  if (!rows.length) {
    box.appendChild(el('p', 'dim', '还没有邀请码，上面生成一个。'));
    return;
  }

  for (const r of rows) {
    const code = String(r.code ?? '');
    const maxUses = Number(r.max_uses ?? 0);
    const used = Number(r.used_count ?? 0);
    const expires = Number(r.expires_at ?? 0);
    const status = Number(r.status ?? 1);
    const expired = expires > 0 && expires < Date.now();
    const exhausted = maxUses > 0 && used >= maxUses;

    const row = el('div', 'row');
    row.style.alignItems = 'center';
    row.style.borderTop = '1px solid var(--rule, rgba(128,128,128,.25))';
    row.style.paddingTop = '.45rem';

    const codeEl = el('code', undefined, code);
    codeEl.style.minWidth = '9rem';
    codeEl.style.fontFamily = 'var(--font-mono, monospace)';
    row.appendChild(codeEl);

    row.appendChild(
      el(
        'span',
        'dim',
        `${used}/${maxUses === 0 ? '∞' : maxUses} 次 · ${
          expires === 0 ? '永不过期' : '至 ' + fmtTime(expires)
        }${expired ? '（已过期）' : ''}${exhausted ? '（已用尽）' : ''}${
          status === 1 ? '' : '（已作废）'
        }${r.note ? ' · ' + String(r.note) : ''}`
      )
    );

    const mk = (label: string, fn: () => void, quiet = false) => {
      const b = el('button', 'key' + (quiet ? ' key--quiet' : ''), label) as HTMLButtonElement;
      b.type = 'button';
      b.addEventListener('click', fn);
      row.appendChild(b);
    };

    mk('改次数', () => {
      const raw = prompt('可用次数（0 = 不限次数）', String(maxUses));
      if (raw == null) return;
      void api('site-invite-update', { code, maxUses: Number(raw) }).then(loadInvites);
    });

    mk('改有效期', () => {
      const days = prompt('从今天起多少天有效（0 = 永不过期）', '7');
      if (days == null) return;
      const d = Number(days);
      const expiresAt = Number.isFinite(d) && d > 0 ? Date.now() + d * 86400000 : 0;
      void api('site-invite-update', { code, expiresAt }).then(loadInvites);
    });

    mk('改备注', () => {
      const note = prompt('备注', String(r.note ?? ''));
      if (note == null) return;
      void api('site-invite-update', { code, note }).then(loadInvites);
    });

    mk('已用清零', () => {
      if (!confirm(`把 ${code} 的已用次数清零？（用于让同一个码再注册一次）`)) return;
      void api('site-invite-update', { code, usedCount: 0 }).then(loadInvites);
    }, true);

    mk(status === 1 ? '作废' : '启用', () => {
      void api('site-invite-update', { code, status: status === 1 ? 0 : 1 }).then(loadInvites);
    }, true);

    mk('删除', () => {
      if (!confirm(`删除 ${code}？（记录会一起消失，作废更安全）`)) return;
      void api('site-invite-delete', { code }).then(loadInvites);
    }, true);

    box.appendChild(row);
  }
}

async function loadInvites(): Promise<void> {
  const r = await api('site-invites');
  if (!r.ok) {
    const box = $('[data-inv-list]');
    if (box) box.innerHTML = '';
    const msg = $('[data-inv-msg]');
    if (msg) msg.textContent = String(r.error ?? '读取失败');
    return;
  }
  renderInvites((r.rows ?? []) as Record<string, unknown>[]);
}

/* ─────────────────────── 用户 ─────────────────────── */

function renderUsers(rows: Record<string, unknown>[]): void {
  const box = $('[data-site-users-list]');
  if (!box) return;
  box.innerHTML = '';
  if (!rows.length) {
    box.appendChild(el('p', 'dim', '还没有站点用户。'));
    return;
  }

  for (const r of rows) {
    const id = String(r.id ?? '');
    const active = Number(r.status ?? 1) === 1;

    const row = el('div', 'row');
    row.style.alignItems = 'center';
    row.style.borderTop = '1px solid var(--rule, rgba(128,128,128,.25))';
    row.style.paddingTop = '.45rem';

    const name = el('span', undefined, String(r.nick || r.account || ''));
    name.style.minWidth = '8rem';
    row.appendChild(name);

    row.appendChild(el('span', 'dim', String(r.account ?? '')));
    row.appendChild(
      el(
        'span',
        'dim',
        `注册 ${fmtTime(r.created_at)} · 上次登录 ${fmtTime(r.last_login_at)} · 记录 ${Number(
          r.prog_count ?? 0
        )} 条${active ? '' : ' · 已停用'}${r.invite ? ' · 码 ' + String(r.invite) : ''}`
      )
    );

    const b = el('button', 'key' + (active ? ' key--quiet' : ''), active ? '停用' : '启用') as HTMLButtonElement;
    b.type = 'button';
    b.addEventListener('click', () => {
      if (active && !confirm(`停用「${String(r.account ?? '')}」？会同时清掉它的登录会话。`)) return;
      void api('site-user-status', { id, status: active ? 0 : 1 }).then(loadUsers);
    });
    row.appendChild(b);

    box.appendChild(row);
  }
}

async function loadUsers(): Promise<void> {
  const r = await api('site-users');
  renderUsers((r.rows ?? []) as Record<string, unknown>[]);
}

/* ─────────────────────── 绑定 ─────────────────────── */

export function initSiteAdmin(): void {
  if (document.querySelector('[data-panel="site"]')?.dataset.bound === '1') return;
  const panel = document.querySelector('[data-panel="site"]') as HTMLElement | null;
  if (!panel) return;
  panel.dataset.bound = '1';

  const gen = $('[data-inv-gen]');
  if (gen) {
    gen.addEventListener('click', async () => {
      const msg = $('[data-inv-msg]');
      const count = Number(($('[data-inv-count]') as HTMLInputElement)?.value ?? 1);
      const maxUses = Number(($('[data-inv-uses]') as HTMLInputElement)?.value ?? 1);
      const days = Number(($('[data-inv-days]') as HTMLInputElement)?.value ?? 7);
      const note = ($('[data-inv-note]') as HTMLInputElement)?.value ?? '';

      if (msg) msg.textContent = '生成中…';
      const r = await api('site-invite-create', {
        count,
        maxUses,
        expiresAt: days > 0 ? Date.now() + days * 86400000 : 0,
        note,
      });
      if (msg) {
        msg.textContent = r.ok
          ? '已生成：' + ((r.codes as string[]) ?? []).join(' / ')
          : String(r.error ?? '生成失败');
      }
      await loadInvites();
    });
  }

  const reload = $('[data-site-users-reload]');
  if (reload) reload.addEventListener('click', () => void loadUsers());

  // 分区第一次显示时再加载，避免后台一打开就打两个接口
  for (const tab of $all('[data-tab]')) {
    if (tab.getAttribute('data-tab') !== 'site') continue;
    tab.addEventListener('click', () => {
      void loadInvites();
      void loadUsers();
    });
  }

  // 直接带 #site 打开时也加载一次
  if (location.hash === '#site') {
    void loadInvites();
    void loadUsers();
  }
}

if (document.readyState !== 'loading') initSiteAdmin();
else document.addEventListener('DOMContentLoaded', initSiteAdmin);
