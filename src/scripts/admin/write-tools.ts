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

/** 从 frontmatter 里取一个字段（不做完整解析，只认 `key: value` 一行） */
function fm(key: string): string {
  const re = new RegExp('^' + key + ':\\s*(.*)$', 'm');
  const m = re.exec(front().value);
  return (m && m[1] ? m[1] : '').trim().replace(/^['\"]|['\"]$/g, '');
}

/**
 * 发布到线上（R52）。**这是真的实时**：写进 DO 的 content_live，
 * Worker 的 /live/<coll>/<slug> 立刻渲染出来，不用构建、不用部署。
 *
 * 知识库（coll === 'kb'）走另一条：写进 kb_live，loadKb() 一分钟内并进分身的底座。
 */
async function publishLive() {
  const coll = q<HTMLSelectElement>('[data-w-coll]').value;
  const slug = (q<HTMLInputElement>('[data-w-slug]').value || '').trim();
  if (!slug) return say('先起一个 slug（它也是线上地址的一段）');

  if (coll === 'kb') {
    const question = fm('question') || slug;
    const { ok, data } = await api('kb-live-put', {
      question,
      answer: body().value,
      topic: fm('topic'),
      aliases: fm('aliases').replace(/[\[\]']/g, ''),
      status: 1,
    });
    return say(ok ? '已写进分身知识库：' + question + '（一分钟内生效）' : '没发上去：' + String(data.error ?? ''));
  }

  const title = fm('title') || slug;
  const { ok, data } = await api('content-live-put', {
    coll,
    slug,
    title,
    front: front().value,
    body: body().value,
    status: 1,
  });
  if (!ok) return say('没发上去：' + String(data.error ?? ''));
  say('已发布：' + String(data.url ?? '') + '（这一页立刻能看，不用部署）');
}

/** 把一段文字插到正文光标处 */
function insertBody(text: string) {
  const t = body();
  const s = t.selectionStart;
  t.focus();
  t.setRangeText(text, s, t.selectionEnd, 'end');
  refreshStat();
  autoSave();
  paint();
}

/**
 * 图片上传。**先在浏览器里压**：长边 1600px、WebP、质量 0.86。
 * 两层理由：DO 的单行 BLOB 有上限（这里卡 3MB），而相机原图动辄 5–8MB；
 * 另外文章正文根本用不到 4000px 宽的图。
 */
async function uploadImage(file: File) {
  say('正在处理图片…');
  let blob: Blob = file;
  try {
    const bmp = await createImageBitmap(file);
    const max = 1600;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    if (ctx) {
      ctx.drawImage(bmp, 0, 0, w, h);
      const out = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/webp', 0.86));
      if (out) blob = out;
    }
  } catch {
    /* 老浏览器不支持 createImageBitmap：原图直传，体积由服务端兜 */
  }

  if (blob.size > 3 * 1024 * 1024) return say('压完还是超过 3MB，换一张小点的');

  const b64 = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] ?? '');
    fr.onerror = () => rej(new Error('读不出来'));
    fr.readAsDataURL(blob);
  });

  const key = 'img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7) + '.webp';
  const { ok, data } = await api('media-put', { key, mime: 'image/webp', data: b64 });
  if (!ok) return say('没传上去：' + String(data.error ?? ''));
  const url = String(data.url ?? '/api/media/' + key);
  insertBody('\n![' + file.name.replace(/\.[^.]+$/, '') + '](' + url + ')\n');
  say('图已上传：' + url + '（已插到正文光标处）');
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
  q('[data-w-publish]').addEventListener('click', () => void publishLive());
  q('[data-w-img]').addEventListener('click', () => q<HTMLInputElement>('[data-w-file]').click());
  q<HTMLInputElement>('[data-w-file]').addEventListener('change', (e) => {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    if (f) void uploadImage(f);
    (e.currentTarget as HTMLInputElement).value = '';
  });
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
