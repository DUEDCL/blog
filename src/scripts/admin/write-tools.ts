/**
 * 写作工具的手活（R41②）：插入工具条、实时预览、导出 .md、事件接线。
 *
 * 从 `write.ts` 拆出来的分工与 models 那两个文件一样 ——
 * 那边管「有哪些内容、当前在编哪一份」，这边管「点了会发生什么」。
 */
import { api, q } from './core';
import { md } from './md';
import {
  COLL_LABEL,
  COLLS,
  TEMPLATE,
  autoSave,
  curDraftId,
  drawList,
  fresh,
  loadDrafts,
  loadRepo,
  refreshStat,
  saveDraft,
  targetPath,
  today,
} from './write';

const body = () => q<HTMLTextAreaElement>('[data-w-body]');
const front = () => q<HTMLTextAreaElement>('[data-w-front]');
const say = (t: string) => {
  const n = q('[data-w-msg]');
  n.textContent = t;
  n.hidden = !t;
};

/**
 * 在光标处套一层标记。`before`/`after` 包住选中的字；没选中就插入 `sample` 当占位。
 * 用 `setRangeText` 而不是拼字符串重设 value —— 后者会把撤销栈整段清掉。
 */
function wrap(before: string, after = '', sample = '') {
  const t = body();
  const [s, e] = [t.selectionStart, t.selectionEnd];
  const picked = t.value.slice(s, e) || sample;
  t.focus();
  t.setRangeText(before + picked + after, s, e, 'end');
  // 没选中时把光标放到占位文字上，直接打字就替换掉
  if (s === e && sample) t.setSelectionRange(s + before.length, s + before.length + sample.length);
  refreshStat();
  autoSave();
  paint();
}

/** 工具条。每一项就是「插什么」，顺序按用得多不多排 */
const TOOLS: [string, () => void][] = [
  ['H2', () => wrap('\n## ', '', '小标题')],
  ['H3', () => wrap('\n### ', '', '小小标题')],
  ['粗', () => wrap('**', '**', '重点')],
  ['斜', () => wrap('*', '*', '强调')],
  ['码', () => wrap('`', '`', 'code')],
  ['代码块', () => wrap('\n```ts\n', '\n```\n', '// 代码')],
  ['引用', () => wrap('\n> ', '', '引一句')],
  ['列表', () => wrap('\n- ', '', '一条')],
  ['链接', () => wrap('[', '](https://)', '文字')],
  ['图', () => wrap('![', '](./图片.jpg)', '说明')],
  ['分隔线', () => wrap('\n\n---\n\n')],
  ['表格', () => wrap('\n| 项 | 说明 |\n| :-- | :-- |\n| ', ' |  |\n', 'a')],
];

/** 实时预览。默认开着 —— 它的用途是「写的时候看结构」，藏起来就没用了 */
let preview = true;
function paint() {
  const box = q('[data-w-preview]');
  box.hidden = !preview;
  if (preview) box.innerHTML = md(body().value);
}

/** 拼回一份完整的 .md。frontmatter 原样进原样出，所以导出的文件与仓库里的写法一致 */
const compose = () => '---\n' + front().value.trim() + '\n---\n\n' + body().value.trim() + '\n';

function download() {
  const name = (q<HTMLInputElement>('[data-w-slug]').value.trim() || '未命名') + '.md';
  const url = URL.createObjectURL(new Blob([compose()], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // 立刻回收：Blob URL 不撤掉会一直占着内存，直到这一页被关掉
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  say('下好了。放到 ' + targetPath() + ' 再跑一次部署就上线。');
}

async function copyAll() {
  try {
    await navigator.clipboard.writeText(compose());
    say('整份 .md 已复制（含 frontmatter）');
  } catch {
    say('复制不了 —— 用「下载 .md」那颗');
  }
}

export function wireWrite() {
  // 栏目下拉与筛选下拉的选项都从同一份表来，不手写两遍
  for (const sel of ['[data-w-coll]', '[data-write-coll]']) {
    const s = q<HTMLSelectElement>(sel);
    if (sel === '[data-write-coll]') s.appendChild(new Option('全部栏目', ''));
    for (const c of COLLS) s.appendChild(new Option(COLL_LABEL[c], c));
  }

  const tools = q('[data-w-tools]');
  for (const [label, run] of TOOLS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick';
    b.textContent = label;
    b.addEventListener('click', run);
    tools.appendChild(b);
  }

  for (const t of [body(), front()]) {
    t.addEventListener('input', () => {
      refreshStat();
      autoSave();
      if (t === body()) paint();
    });
  }

  q('[data-write-q]').addEventListener('input', drawList);
  q('[data-write-coll]').addEventListener('change', drawList);
  q('[data-w-new]').addEventListener('click', fresh);
  q('[data-w-save]').addEventListener('click', () => void saveDraft());
  q('[data-w-down]').addEventListener('click', download);
  q('[data-w-copy]').addEventListener('click', () => void copyAll());

  q('[data-w-coll]').addEventListener('change', () => {
    refreshStat();
    // 换栏目时如果 frontmatter 还是空的（刚点了新建），换成新栏目的模板
    if (!front().value.trim()) {
      front().value = (TEMPLATE[q<HTMLSelectElement>('[data-w-coll]').value] ?? '').replace('{today}', today());
    }
  });

  q('[data-w-eye]').addEventListener('click', () => {
    preview = !preview;
    q('[data-w-eye]').textContent = preview ? '收起预览' : '看预览';
    paint();
  });

  q('[data-w-del]').addEventListener('click', async () => {
    const id = curDraftId();
    if (!confirm('删掉草稿「' + id + '」？仓库里的文件不受影响。')) return;
    const { ok, data } = await api('draft-del', { id });
    say(ok ? '删了' : '删不掉：' + String(data.error ?? ''));
    await loadDrafts();
  });

  q('[data-w-slug]').addEventListener('input', refreshStat);

  // 载入一份内容之后 `write.ts` 会派这个事件，预览跟着重画（见那边 `fill` 里的注释）
  document.addEventListener('adm:paint', paint);

  void loadRepo();
  void loadDrafts();
  paint();
}
