/**
 * 「聊天记录」与「聊天实时接管」两个面板共用的零件（R41②）。
 *
 * 两个面板看的是同一份数据，用途不同：记录是回头看（全量、可翻），
 * 接管是当下（增量、要能回话）。共用的部分就是「一条会话长什么样」
 * 与「一条消息长什么样」—— 这两样在两个面板里必须**看起来一样**，
 * 否则同一段对话在两页上对不上号。
 */
import { ago, el, when } from './core';

export interface Ses {
  id: string;
  first: number;
  last: number;
  n: number;
  ip: string;
  model: string;
  takeover: boolean;
  wait: boolean;
}

export interface Msg {
  id: number;
  role: string;
  text: string;
  ip: string;
  model: string;
  who: string;
  /** 哪个浏览器窗口（R42）。会话按 IP 合并了，同一条会话里可能有好几个窗口 */
  tab: string;
  ts: number;
}

/** 会话按钮上那一行字。时间用相对的（好扫），IP 与条数跟在后面 */
export function sesLabel(s: Ses): string {
  return (
    ago(s.last) +
    ' · ' +
    (s.ip || '无 IP') +
    ' · ' +
    s.n +
    ' 条' +
    (s.model ? ' · ' + s.model : '')
  );
}

/**
 * 一颗会话按钮。两个标记都画在上面：
 * - **接管中** —— 这个会话的下一句由沉麟自己回；
 * - **有人在等** —— 此刻真有一条访客请求挂着（最多 25 秒），这是唯一有时效的一个标记。
 */
export function sesButton(s: Ses, onPick: (s: Ses) => void): HTMLElement {
  const b = el('button', 'ses');
  b.type = 'button';
  b.dataset.id = s.id;
  b.appendChild(el('span', 'ses__line', sesLabel(s)));
  if (s.takeover) b.appendChild(el('span', 'tag tag--on', '接管中'));
  if (s.wait) b.appendChild(el('span', 'tag tag--wait', '有人在等'));
  b.addEventListener('click', () => onPick(s));
  return b;
}

/** 一条消息。三种身份：访客 / 分身（模型） / 沉麟本人（接管时打的字） */
export function msgNode(m: Msg): HTMLElement {
  const me = m.role === 'user';
  const human = !me && m.who === 'human';
  const p = el('p', 'msg msg--' + (me ? 'me' : human ? 'human' : 'ai'));
  /* 窗口号取前 6 位（R42）。会话按 IP 合并之后，同一条会话里可能有两个人在聊 ——
     不标出来的话那两段对话在这一页上看着就是一个人在自言自语。
     6 位十六进制够分辨，也短得不占地方 */
  const win = m.tab ? '窗口 ' + m.tab.slice(0, 6) : '';
  const meta = [when(m.ts), me ? '访客' : human ? '沉麟本人' : '分身', win, m.ip, m.model]
    .filter(Boolean)
    .join(' · ');
  p.appendChild(el('span', 'msg__meta', meta));
  p.appendChild(el('span', 'msg__text', m.text));
  return p;
}

/** 列表重画时保住选中项：DOM 整片换掉之后按 id 把高亮加回去 */
export function markPicked(host: HTMLElement, id: string) {
  for (const b of host.querySelectorAll<HTMLElement>('.ses')) {
    b.classList.toggle('is-on', b.dataset.id === id);
  }
}
