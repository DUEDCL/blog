/**
 * 「文章编辑」面板 —— 也就是他要的「写作工具」（R41②）。
 *
 * ## 这一页能做什么，不能做什么
 *
 * 能：列出仓库里现有的全部内容（文章／随笔／作品／相册／知识库）、打开原文改、
 * 新写一篇、frontmatter 与正文分开编辑、实时预览结构、字数与预计阅读、
 * 自动存草稿（多设备看到同一份）、导出 .md。
 *
 * **不能：把文章直接发上线。** 这个站是静态构建的，文章的真身是
 * `src/content/**\/*.md`，而线上 Worker 没有仓库的写权限 —— 也不该有，
 * 那意味着把一把能改代码的 token 放进线上环境。
 * 所以定稿之后要走：导出 .md → 放进仓库 → 跑一次部署。
 * 这条边界在页面上是明写着的，不能让他以为点了保存就上线了。
 *
 * ## 草稿存在哪
 *
 * Durable Object（配置实例的 `draft` 表）。选它而不是 localStorage 的理由：
 * 他在手机上想到一段，回电脑上要能接着写。
 */
import { api, el, every, q, words, beat } from './core';

export interface Item {
  coll: string;
  slug: string;
  path: string;
  title: string;
  draft: boolean;
  pubDate: string;
  chars: number;
}

interface DraftItem {
  id: string;
  coll: string;
  slug: string;
  title: string;
  updated: number;
  chars: number;
}

export const COLLS = ['posts', 'notes', 'projects', 'photos', 'kb'] as const;
export const COLL_LABEL: Record<string, string> = {
  posts: '文章',
  notes: '随笔',
  projects: '作品',
  photos: '相册',
  kb: '知识库',
};

/** frontmatter 模板。新建时按栏目填一份骨架 —— 字段名与 `content.config.ts` 的 schema 对齐 */
export const TEMPLATE: Record<string, string> = {
  posts: "title: \ndescription: \npubDate: {today}\ntags: []\ndraft: true",
  notes: "title: \ndescription: \npubDate: {today}\ntags: []\ndraft: true",
  projects:
    "title: \ndescription: \npubDate: {today}\ntags: []\nstatus: wip\nfeatured: false\ndraft: true",
  photos:
    "title: \ndescription: \npubDate: {today}\ncover: './xxx.jpg'\ncoverAlt: \nimages: []\ndraft: true",
  kb: 'question: \naliases: []\ntopic: \ndraft: true',
};

export let repo: Item[] = [];
let drafts: DraftItem[] = [];
let cur = { coll: 'posts', slug: '', from: 'new' as 'new' | 'repo' | 'draft' };
let saveTimer = 0;

const list = () => q('[data-write-list]');
const front = () => q<HTMLTextAreaElement>('[data-w-front]');
const body = () => q<HTMLTextAreaElement>('[data-w-body]');
const slugIn = () => q<HTMLInputElement>('[data-w-slug]');
const collIn = () => q<HTMLSelectElement>('[data-w-coll]');
const say = (t: string) => {
  const n = q('[data-w-msg]');
  n.textContent = t;
  n.hidden = !t;
};

export const today = () => new Date().toISOString().slice(0, 10);

/** 目标文件路径。它同时是「导出去放哪儿」的答案，所以一直显示在编辑器上方 */
export const targetPath = () => 'src/content/' + collIn().value + '/' + (slugIn().value || '未命名') + '.md';

export function drawList() {
  const kw = q<HTMLInputElement>('[data-write-q]').value.trim().toLowerCase();
  const only = q<HTMLSelectElement>('[data-write-coll]').value;
  const h = list();
  h.textContent = '';

  const hit = (coll: string, title: string, slug: string) =>
    (!only || coll === only) &&
    (!kw || (title + ' ' + slug).toLowerCase().includes(kw));

  if (drafts.some((d) => hit(d.coll, d.title, d.slug))) {
    h.appendChild(el('p', 'lab', '后台草稿（还没进仓库）'));
    for (const d of drafts) {
      if (!hit(d.coll, d.title, d.slug)) continue;
      const b = el('button', 'ses', '');
      b.type = 'button';
      b.appendChild(el('span', 'ses__line', (d.title || d.slug) + ' · ' + d.chars + ' 字符'));
      b.appendChild(el('span', 'tag tag--on', COLL_LABEL[d.coll] ?? d.coll));
      b.addEventListener('click', () => void openDraft(d.id));
      h.appendChild(b);
    }
  }

  const mine = repo.filter((r) => hit(r.coll, r.title, r.slug));
  h.appendChild(el('p', 'lab', '仓库里的（' + mine.length + '）'));
  for (const r of mine) {
    const b = el('button', 'ses', '');
    b.type = 'button';
    b.appendChild(el('span', 'ses__line', r.title + ' · ' + r.chars + ' 字'));
    b.appendChild(el('span', 'tag', COLL_LABEL[r.coll] ?? r.coll));
    if (r.draft) b.appendChild(el('span', 'tag tag--wait', 'draft'));
    b.addEventListener('click', () => void openRepo(r.path));
    h.appendChild(b);
  }
}

function fill(coll: string, slug: string, f: string, b: string, from: typeof cur.from, note: string) {
  cur = { coll, slug, from };
  collIn().value = coll;
  slugIn().value = slug;
  front().value = f;
  body().value = b;
  q('[data-w-editor]').hidden = false;
  say(note);
  refreshStat();
  /* 让预览跟着重画。派事件而不是 import `paint` —— 那个函数在 `write-tools.ts` 里，
     而它已经 import 了这个文件，直接反向 import 就成环了。 */
  document.dispatchEvent(new CustomEvent('adm:paint'));
}

/** 打开仓库里的一份。改动**不会**写回仓库 —— 存的是一份同名草稿 */
export async function openRepo(path: string) {
  const { ok, data } = await api('content?path=' + encodeURIComponent(path));
  if (!ok) return say('读不出来：' + String(data.error ?? ''));
  const it = data.item as { coll: string; slug: string; front: string; body: string };
  fill(it.coll, it.slug, it.front, it.body, 'repo', '打开的是仓库里的原文。改完存的是草稿，仓库文件不会被动。');
}

export async function openDraft(id: string) {
  const { ok, data } = await api('draft?id=' + encodeURIComponent(id));
  if (!ok) return say('读不出来：' + String(data.error ?? ''));
  const it = data.item as { coll: string; slug: string; front: string; body: string };
  fill(it.coll, it.slug, it.front, it.body, 'draft', '后台草稿。');
}

export function fresh() {
  const coll = collIn().value || 'posts';
  fill(coll, '', (TEMPLATE[coll] ?? '').replace('{today}', today()), '', 'new', '新的一篇。slug 就是文件名，只能用小写字母、数字与连字符。');
  slugIn().focus();
}

/** 字数、预计阅读、目标路径。每次敲键都会走一遍，所以只做纯计算 */
export function refreshStat() {
  const n = words(body().value);
  q('[data-w-stat]').textContent =
    n + ' 字 · 约 ' + Math.max(1, Math.round(n / 350)) + ' 分钟 · ' + [...body().value].length + ' 字符';
  q('[data-w-path]').textContent = targetPath();
}

/** 存草稿。自动存也走这一条 —— 手动与自动不该有两套逻辑 */
export async function saveDraft(quiet = false): Promise<boolean> {
  const slug = slugIn().value.trim();
  if (!slug) {
    if (!quiet) say('先起一个 slug（文件名）');
    return false;
  }
  const title = (front().value.match(/^(?:title|question):[ \t]*(.*)$/m)?.[1] ?? '').trim() || slug;
  const { ok, data } = await api('draft-save', {
    coll: collIn().value,
    slug,
    title: title.replace(/^['"]|['"]$/g, ''),
    front: front().value,
    body: body().value,
  });
  if (!ok) {
    say('没存上：' + String(data.error ?? ''));
    return false;
  }
  cur = { coll: collIn().value, slug, from: 'draft' };
  if (!quiet) say('存好了 —— 这是后台草稿，还没进仓库');
  await loadDrafts();
  return true;
}

/** 敲完两秒自动存一次。写东西的时候没人愿意记得按保存 */
export function autoSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveDraft(true), 2000);
}

export async function loadDrafts() {
  const { ok, data } = await api('drafts');
  if (ok) drafts = (data.items ?? []) as DraftItem[];
  drawList();
}

export async function loadRepo() {
  const { ok, data } = await api('content');
  if (ok) repo = (data.items ?? []) as Item[];
  drawList();
  beat();
}

export const curDraftId = () => cur.coll + '/' + cur.slug;

every('write', 20000, loadDrafts);
