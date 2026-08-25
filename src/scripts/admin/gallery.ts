/**
 * 「图库管理」面板（R41②）。
 *
 * ## 它管什么
 *
 * 相册的**元信息与体检**：一个相册有没有封面、封面的 alt 写了没有、组图里哪几张缺 alt、
 * 是不是还挂着 `draft: true`、alt 里是不是还留着「占位图，请替换」。
 * 这几项全在 frontmatter 里，也全是会忘的东西 —— 站上现在两组相册就都还是占位内容。
 *
 * ## 它不管什么：上传图片
 *
 * 照片的真身是 `src/content/photos/` 下的 jpg，构建期由 Astro 的图片管线处理
 * （生成 srcset、转 webp、算尺寸）。后台把图片存到别处（比如 R2）就绕开了那条管线 ——
 * 响应式图片、`layout: 'constrained'`、封面比例全部失效，而那是摄影页的全部立身之本。
 * 所以图片仍然是「放进仓库 → 部署」，后台只负责把元信息写对。这一条在页面上明写着。
 *
 * 「编辑元信息」直接跳到「文章编辑」那一页并载入同一个文件 —— 不为相册再造一个编辑器。
 */
import { api, el, every, q, beat } from './core';
import { openRepo } from './write';

interface Full {
  coll: string;
  slug: string;
  path: string;
  title: string;
  draft: boolean;
  pubDate: string;
  front: string;
  body: string;
}

/** 从 frontmatter 原文里抓一个顶层标量。解析不了就空串 —— 不猜 */
const field = (front: string, key: string) =>
  (front.match(new RegExp('^' + key + ':[ \\t]*(.*)$', 'm'))?.[1] ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '');

/** 组图里的 alt 行。`images:` 下每一项一个 `alt:`，缩进过的那些才算 */
const altLines = (front: string) =>
  (front.match(/^\s+alt:[ \t]*(.*)$/gm) ?? []).map((s) => s.replace(/^\s+alt:[ \t]*/, '').trim());

const PLACEHOLDER = /占位|请替换|placeholder/i;

function card(a: Full): HTMLElement {
  const box = el('div', 'album');

  const head = el('div', 'album__head');
  head.appendChild(el('span', 'album__title', a.title || a.slug));
  if (a.draft) head.appendChild(el('span', 'tag tag--wait', 'draft · 站上看不到'));
  box.appendChild(head);

  const cover = field(a.front, 'cover');
  const coverAlt = field(a.front, 'coverAlt');
  const alts = altLines(a.front);
  const imgs = (a.front.match(/^\s+src:/gm) ?? []).length;

  box.appendChild(
    el(
      'p',
      'dim',
      [
        a.pubDate || '没写日期',
        '封面 ' + (cover || '缺'),
        '组图 ' + imgs + ' 张',
        a.path,
      ].join(' · ')
    )
  );

  /* 体检。每一条都是**会真的出现在站上**的问题，不是风格建议：
     alt 缺失伤可读性与可访问性，占位文案会被访客读到（R32 记过这件事） */
  const bad: string[] = [];
  if (!cover) bad.push('没有封面 —— schema 里它是必填，构建会直接报错');
  if (!coverAlt) bad.push('封面缺 coverAlt');
  else if (PLACEHOLDER.test(coverAlt)) bad.push('封面 alt 还是占位文案：' + coverAlt);
  if (alts.length < imgs) bad.push(imgs - alts.length + ' 张组图缺 alt');
  for (const t of alts) if (PLACEHOLDER.test(t)) bad.push('组图 alt 还是占位文案：' + t);
  if (PLACEHOLDER.test(a.body)) bad.push('正文里还留着占位说明');

  const res = el('div', 'res ' + (bad.length ? 'res--warn' : 'res--ok'));
  res.appendChild(el('p', 'res__head', bad.length ? bad.length + ' 处要改' : '元信息齐了'));
  if (bad.length) res.appendChild(el('p', 'res__body', bad.join('\n')));
  box.appendChild(res);

  const acts = el('div', 'row');
  const edit = el('button', 'key', '编辑元信息');
  edit.type = 'button';
  edit.addEventListener('click', () => {
    // 跳到写作台并载入这一份。tab 切换靠派事件，不去 import index（会绕成循环依赖）
    document.dispatchEvent(new CustomEvent('adm:tab', { detail: 'write' }));
    void openRepo(a.path);
  });
  acts.appendChild(edit);

  const look = el('a', 'key key--quiet2', a.draft ? '（draft，站上没有这一页）' : '看这一页');
  if (!a.draft) {
    (look as HTMLAnchorElement).href = '/photos/' + a.slug;
    (look as HTMLAnchorElement).target = '_blank';
  }
  acts.appendChild(look);
  box.appendChild(acts);
  return box;
}

async function refresh() {
  const { ok, data } = await api('content?coll=photos');
  const host = q('[data-gallery]');
  if (!ok) {
    host.textContent = '';
    host.appendChild(el('p', 'dim', '读不出来：' + String(data.error ?? '')));
    return;
  }
  const items = (data.items ?? []) as Full[];
  host.textContent = '';
  q('[data-gallery-sum]').textContent =
    items.length + ' 组相册，其中 ' + items.filter((a) => a.draft).length + ' 组还是 draft';
  if (!items.length) {
    host.appendChild(el('p', 'dim', '还没有相册。新建走「文章编辑」那一页，栏目选「相册」。'));
    return;
  }
  for (const a of items) host.appendChild(card(a));
  beat();
}

export function wireGallery() {
  q('[data-gallery-refresh]').addEventListener('click', () => void refresh());
  // 图库来自构建产物，只有部署过才会变 —— 一分钟一次够了，不必跟着对话那套节奏
  every('gallery', 60000, refresh);
}
