/**
 * 「聊天记录」面板（R41②，R38 那一版的实时化改造）。
 *
 * 与 R38 的差别只有两处，但都是他这一轮要的「实时更新」：
 * ① 列表每 5 秒自动重拉，不用再点「刷新列表」（那颗按钮留着，急的时候手动催一下）；
 * ② 打开的那个会话每 3 秒**增量**追加新消息 —— 带 `after=<最后一条 id>`，
 *    一轮只搬新的几条，不是每次把四百条重新过一遍网络。
 *
 * 三个筛选（全部／接管中／有人在等）是纯前端过滤，不额外打接口。
 */
import { api, el, every, q, beat } from './core';
import { markPicked, msgNode, sesButton, type Msg, type Ses } from './chat';

let all: Ses[] = [];
let picked = '';
/** 打开的那个会话已经拿到的最后一条 id。增量轮询的游标 */
let cursor = 0;
let filter: 'all' | 'takeover' | 'wait' = 'all';

const list = () => q('[data-log-list]');
const detail = () => q('[data-log-detail]');
const head = () => q('[data-log-head]');

function draw() {
  const keep =
    filter === 'all' ? all : all.filter((s) => (filter === 'takeover' ? s.takeover : s.wait));
  const h = list();
  h.textContent = '';
  if (!keep.length) {
    h.appendChild(el('p', 'dim', all.length ? '这一档下没有会话' : '还没有人聊过'));
    return;
  }
  for (const s of keep) h.appendChild(sesButton(s, open));
  markPicked(h, picked);
}

/** 打开一个会话。换会话时游标归零，整段重拉 */
async function open(s: Ses) {
  picked = s.id;
  cursor = 0;
  detail().textContent = '';
  markPicked(list(), s.id);
  head().textContent = '读…';
  await pump();
}

/** 拉一次（首次是全量，之后是增量）。返回这一轮追加了几条 */
async function pump(): Promise<number> {
  if (!picked) return 0;
  const { ok, data } = await api(
    'log?session=' + encodeURIComponent(picked) + '&after=' + cursor
  );
  if (!ok) {
    head().textContent = '读不出来：' + String(data.error ?? '');
    return 0;
  }
  const items = (data.items ?? []) as Msg[];
  const box = detail();
  /* 贴底时才自动滚 —— 他往上翻着看旧消息时，新消息进来不该把视线拽回底部 */
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  for (const m of items) box.appendChild(msgNode(m));
  cursor = Number(data.last) || cursor;
  if (items.length && atBottom) box.scrollTop = box.scrollHeight;

  const me = all.find((s) => s.id === picked);
  head().textContent =
    (me ? (me.ip || '无 IP') + ' · ' : '') +
    box.querySelectorAll('.msg').length +
    ' 条' +
    (me?.takeover ? ' · 接管中' : '');
  return items.length;
}

async function refresh() {
  const { ok, data } = await api('sessions');
  if (!ok) return;
  all = (data.items ?? []) as Ses[];
  draw();
  beat();
}

export function wireLogs() {
  q('[data-log-refresh]').addEventListener('click', () => void refresh());

  for (const b of Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-log-filter]')
  )) {
    b.addEventListener('click', () => {
      filter = (b.dataset.logFilter ?? 'all') as typeof filter;
      for (const x of Array.from(document.querySelectorAll('[data-log-filter]')))
        x.classList.toggle('is-on', x === b);
      draw();
    });
  }

  every('logs', 5000, refresh);
  every('logs', 3000, () => void pump());
}
