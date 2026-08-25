/**
 * 「聊天实时接管」面板（R41②）—— 他要的那句「聊天实时接管」。
 *
 * ## 一句话说清它做什么
 *
 * 打开某个会话的接管开关之后，**那个会话的下一句不再由模型回答**：访客一发问，
 * 他的请求会挂在服务端等最多 25 秒；沉麟在这一页打字按发送，访客看到的就是他打的字，
 * 逐段出现、与模型回答长得一样。25 秒内没人回，就退回模型 —— 访客不会空手，
 * 也不知道刚才有人在旁边。
 *
 * ## 为什么是轮询而不是 WebSocket
 *
 * 访客那一侧**不是轮询**：它是一条真正挂着的请求，由 Durable Object 在内存里
 * 存着回调，沉麟一按发送就地放走（见 `chat-log.ts` 的 `/wait` 与 `/reply`）——
 * 那一头是零延迟的，没有轮询间隔。
 *
 * 只有**后台这一侧**在轮询（1.5 秒一次增量）。这里用 WebSocket 的收益很小：
 * 他自己盯着屏幕时 1.5 秒的滞后看不出来；代价却不小 —— DO 那边要接
 * WebSocket hibernation 那套 API，而本项目刻意不引 `@cloudflare/workers-types`
 * （它的全局 Request/Response 会和 Astro 的 lib.dom 打架，`worker.ts` 顶部记过）。
 * 哪天真觉得慢了，改这一处就够，访客那一侧一行都不用动。
 */
import { api, el, every, q, beat } from './core';
import { markPicked, msgNode, sesButton, type Msg, type Ses } from './chat';

let all: Ses[] = [];
let picked: Ses | null = null;
let cursor = 0;
/**
 * 这条会话里最近出现过的窗口号（R43）。发人工消息时要指定发给谁 ——
 * 会话是按 IP 合并的，一条会话下可能有好几个窗口，「发给谁」不该靠服务端猜。
 *
 * 取「最近一条**访客**消息的窗口」而不是「最近一条消息」：他自己刚发的那条也带窗口号，
 * 用它会在连发几句之后仍然指向对的人，但访客那一条才是「谁在跟我说话」的真凭据。
 */
let lastTab = '';

const list = () => q('[data-live-list]');
const flow = () => q('[data-live-flow]');
const head = () => q('[data-live-head]');
const input = () => q<HTMLTextAreaElement>('[data-live-in]');
const toggle = () => q<HTMLInputElement>('[data-live-on]');

const say = (t: string) => {
  const n = q('[data-live-msg]');
  n.textContent = t;
  n.hidden = !t;
};

function draw() {
  const h = list();
  h.textContent = '';
  if (!all.length) {
    h.appendChild(el('p', 'dim', '还没有人聊过。有人进来会自动出现在这儿。'));
    return;
  }
  // 有人在等的排最前 —— 这一页的用途就是「现在有人等着我」
  const order = [...all].sort((a, b) => Number(b.wait) - Number(a.wait) || b.last - a.last);
  for (const s of order) h.appendChild(sesButton(s, pick));
  markPicked(h, picked?.id ?? '');
}

async function pick(s: Ses) {
  picked = s;
  cursor = 0;
  lastTab = '';
  flow().textContent = '';
  markPicked(list(), s.id);
  toggle().checked = s.takeover;
  q('[data-live-panel]').hidden = false;
  await pump();
  input().focus();
}

async function pump(): Promise<void> {
  if (!picked) return;
  const { ok, data } = await api(
    'log?session=' + encodeURIComponent(picked.id) + '&after=' + cursor
  );
  if (!ok) return;
  const items = (data.items ?? []) as Msg[];
  const box = flow();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  for (const m of items) {
    box.appendChild(msgNode(m));
    // 记住「谁在跟我说话」—— 发人工消息时要指定发给哪个窗口
    if (m.role === 'user' && m.tab) lastTab = m.tab;
  }
  cursor = Number(data.last) || cursor;
  if (items.length && atBottom) box.scrollTop = box.scrollHeight;
  if (items.length) idle = 0;

  const now = all.find((s) => s.id === picked?.id);
  head().textContent =
    (picked.ip || '无 IP') +
    ' · ' +
    box.querySelectorAll('.msg').length +
    ' 条' +
    (lastTab ? ' · 发给窗口 ' + lastTab.slice(0, 6) : '') +
    (now?.wait ? ' · 有人正在等你回话' : '');
  head().classList.toggle('is-hot', !!now?.wait);
}

/**
 * 空转计数。**免费档的 Durable Object 是 10 万请求／天**，而这一页是全站最快的轮询
 * （1.5 秒一次）—— 一直开着看一小时就是两千多次。所以安静下来之后自动放慢：
 * 连续 20 拍（约 30 秒）没有新消息就改成每 3 拍打一次（4.5 秒），
 * 一有新消息或有人在等就立刻回到 1.5 秒。
 *
 * 这不是省钱，是**别让后台自己把配额吃光** —— 配额一满，访客那边的对话也跟着挂。
 */
let idle = 0;

async function send() {
  if (!picked) return;
  const text = input().value.trim();
  if (!text) return;
  if (!lastTab) {
    return say('这条会话还没有任何窗口在线 —— 等对方先说一句，我才知道该发给谁。');
  }

  /* 输入框与按钮**一起**灰掉。原来只灰了输入框，按钮还能按 ——
     他实测连点两次就发出了两条一模一样的话（22:09:17 那两条「有点意思」） */
  const btn = q<HTMLButtonElement>('[data-live-send]');
  input().disabled = true;
  btn.disabled = true;
  const { ok, data } = await api('reply', { session: picked.id, text, tab: lastTab });
  input().disabled = false;
  btn.disabled = false;
  if (!ok) return say('没发出去：' + String(data.error ?? ''));

  input().value = '';
  input().focus();
  say(
    Number(data.waiting) > 0
      ? '发出去了，窗口 ' + lastTab.slice(0, 6) + ' 正在收字'
      : '存下了 —— 窗口 ' + lastTab.slice(0, 6) + ' 此刻没连着（对话框关了，或者开着但很久没动）。' +
          '他一打开对话框或者发一句话就会看到这条。'
  );
  await pump();
}

async function refresh() {
  const { ok, data } = await api('sessions');
  if (!ok) return;
  all = (data.items ?? []) as Ses[];
  draw();
  beat();
}

export function wireLive() {
  toggle().addEventListener('change', async () => {
    if (!picked) return;
    const on = toggle().checked;
    const { ok, data } = await api('takeover', { session: picked.id, on });
    if (!ok) {
      toggle().checked = !on;
      return say('改不了：' + String(data.error ?? ''));
    }
    picked.takeover = on;
    say(
      on
        ? '接管开着：这个会话的下一句由你回。访客发问后会等你最多 25 秒，超时才交给模型。你离开这一页超过 90 秒之后，访客就不会再等了。'
        : '接管关了，回到模型回答。'
    );
    await refresh();
  });

  q('[data-live-send]').addEventListener('click', () => void send());

  /* 回车发送、Shift+回车换行 —— 与站上那个对话框一致。
     用 textarea 而不是 input 是因为他可能要回一段带换行的话 */
  input().addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });

  every('live', 3000, refresh);
  every('live', 1500, () => {
    const hot = !!picked && (all.find((s) => s.id === picked?.id)?.wait ?? false);
    if (hot) idle = 0;
    else idle++;
    // 安静下来之后每 3 拍才打一次（见 `idle` 那段注释）
    if (idle > 20 && idle % 3 !== 0) return;
    void pump();
  });
}
