/**
 * 后台「卡密」面板（R48 步数管家 · 多用户版）。
 *
 * 生成 → 发给付款用户 → 用户在 /bushu 兑换 VIP。
 * 卡密是明文的（就靠它当凭据），所以这一页只给已登录的后台看；
 * 生成后建议立刻复制发走，别长期囤在列表里。
 */
import { api, every, q, el, when } from './core';

interface CardRow {
  code: string;
  days: number;
  note: string;
  createdAt: number;
  usedAt: number;
  usedBy: string;
}

let loading = false;

function message(text: string) {
  const n = q<HTMLElement>('[data-cards-msg]');
  n.textContent = text;
  window.setTimeout(() => {
    if (n.textContent === text) n.textContent = '';
  }, 2800);
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 剪贴板被浏览器拦住时，退回到「选中提示」—— 总比静默失败好 */
    window.prompt('复制这些卡密：', text);
    return false;
  }
}

function renderCards(items: CardRow[], unused: number, used: number) {
  const box = q<HTMLElement>('[data-cards-list]');
  box.textContent = '';
  q<HTMLElement>('[data-cards-sum]').textContent = `未使用 ${unused} · 已用 ${used}`;

  if (!items.length) {
    box.appendChild(el('p', 'dim', '还没有卡密。上面填数量与天数，点「生成」。'));
    return;
  }

  for (const c of items) {
    const row = el('div', 'logrow');
    row.appendChild(el('code', 'mono', c.code));
    row.appendChild(el('span', '', `${c.days} 天`));
    row.appendChild(el('span', 'dim', c.note || '—'));
    row.appendChild(
      el('span', c.usedAt ? 'dim' : 'ok', c.usedAt ? `已用 ${when(c.usedAt)}` : '未使用')
    );

    if (!c.usedAt) {
      const cp = el('button', 'key key--quiet2', '复制');
      cp.type = 'button';
      cp.addEventListener('click', async () => {
        await copy(c.code);
        message('已复制');
      });
      const del = el('button', 'key key--quiet', '删除');
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!window.confirm(`删掉未使用的卡密 ${c.code}？`)) return;
        const r = await api('app-card-del', { code: c.code });
        if (r.ok) {
          message('已删除');
          void load();
        } else message(String(r.data.error ?? '没删成'));
      });
      row.append(cp, del);
    } else {
      row.appendChild(el('span', 'dim', `用户 ${c.usedBy.slice(0, 8)}`));
    }

    box.appendChild(row);
  }
}

async function load() {
  if (loading) return;
  loading = true;
  try {
    const r = await api('app-cards');
    if (r.ok) {
      renderCards(
        (r.data.items as CardRow[]) ?? [],
        Number(r.data.unused) || 0,
        Number(r.data.used) || 0
      );
    } else {
      message(String(r.data.error ?? '卡密列表读不出来'));
    }
  } finally {
    loading = false;
  }
}

export function wireCards() {
  q('[data-card-gen]').addEventListener('click', async () => {
    const count = Math.max(1, Math.min(100, Number(q<HTMLInputElement>('[data-card-count]').value) || 10));
    const days = Math.max(1, Math.min(3650, Number(q<HTMLInputElement>('[data-card-days]').value) || 30));
    const note = q<HTMLInputElement>('[data-card-note]').value.trim();
    message('生成中…');
    const r = await api('app-card-gen', { count, days, note });
    if (!r.ok) {
      message(String(r.data.error ?? '生成失败'));
      return;
    }
    const codes = (r.data.codes as string[]) ?? [];
    if (codes.length && (await copy(codes.join('\n')))) {
      message(`已生成 ${codes.length} 张，并复制到剪贴板`);
    } else {
      message(`已生成 ${codes.length} 张`);
    }
    void load();
  });

  q('[data-card-copy]').addEventListener('click', async () => {
    const r = await api('app-cards');
    if (!r.ok) {
      message('列表读不出来');
      return;
    }
    const unused = ((r.data.items as CardRow[]) ?? []).filter((c) => !c.usedAt).map((c) => c.code);
    if (!unused.length) {
      message('没有未使用的卡密');
      return;
    }
    if (await copy(unused.join('\n'))) message(`已复制 ${unused.length} 张未使用卡密`);
  });

  /* 卡密变化不频繁，20 秒刷一次足够 */
  every('cards', 20000, () => load());
}
