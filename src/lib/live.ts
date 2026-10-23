/**
 * 实时内容层（R52）—— 让后台改的东西**不用部署**就能被看到。
 *
 * 三样东西，都放在 `SITE` 这个 Durable Object 里（与站点账号同一个库，
 * 但表是分开的；这个库本来就只有几十到几百个用户，再加几 KB 正文不算负担）：
 *
 *   content_live  文章/随笔/作品的「线上稿」。后台点「发布」写这里，
 *                 Worker 用 /live/<coll>/<slug> 直接渲染出来 —— 这是**真·实时**。
 *   kb_live       分身知识库的线上稿。loadKb() 把它并进 /kb.json 的那一份，
 *                 所以「问沉麟的分身」一分钟内就能用上新写的那条。
 *   media         图片。上传即得 URL（/api/media/<key>），可直接写进文章。
 *
 * 边界（写清楚，免得以后误以为这是完整的 CMS）：
 *   · 站上的**列表页/归档页是构建期产物**。线上稿有自己的地址、能被搜到、能分享，
 *     但不会自动出现在 /posts 的列表里 —— 那需要一次部署。
 *   · 图片走的是 DO 存储，不是 Astro 的图片管线（srcset / webp / 尺寸计算）。
 *     所以摄影页那套「构建期图片管线」不适用；这里的图只服务文章正文。
 *
 * Markdown 渲染器是**自写的子集**，不引第三方库：Worker 运行期不装依赖，
 * 而引一个 remark 进来会把冷启动和包体积都拉高。支持到「够写一篇文章」为止：
 * 标题、段落、粗斜体、行内代码、围栏代码、列表、引用、链接、图片、分隔线、表格不做。
 */

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** 行内：先转义，再按「代码 → 粗体 → 斜体 → 链接 → 图片」的顺序替换 */
function inline(src: string): string {
  let s = esc(src);
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push('<code>' + c + '</code>');
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '');
  return s;
}

export function mdToHtml(md: string): string {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // 围栏代码
    if (/^\s*```/.test(line)) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        buf.push(lines[i] ?? '');
        i++;
      }
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const n = h[1]!.length;
      out.push('<h' + n + '>' + inline(h[2] ?? '') + '</h' + n + '>');
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      closeList();
      out.push('<hr>');
      i++;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        buf.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + inline(buf.join(' ')) + '</blockquote>');
      continue;
    }

    // 列表（- / * / 数字.）
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push('<li>' + inline(line.replace(/^\s*([-*]|\d+\.)\s+/, '')) + '</li>');
      i++;
      continue;
    }

    // 空行
    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }

    // 段落：吃到下一个空行/结构行为止
    closeList();
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() &&
      !/^\s*(#{1,4}\s|>|[-*]\s|\d+\.\s|```|---)/.test(lines[i] ?? '')
    ) {
      buf.push(lines[i] ?? '');
      i++;
    }
    out.push('<p>' + inline(buf.join('\n').replace(/\n/g, '<br>')) + '</p>');
  }
  closeList();
  return out.join('\n');
}

/** 线上稿的完整页面。样式内联 —— 这一页不进构建产物，拿不到 /_astro/*.css 的哈希名 */
export function renderLivePage(o: {
  title: string;
  coll: string;
  body: string;
  front: string;
  updatedAt: number;
}): string {
  const date = new Date(o.updatedAt).toISOString().slice(0, 10);
  const collName: Record<string, string> = {
    posts: '文章',
    notes: '随笔',
    projects: '作品',
    photos: '图库',
    kb: '知识库',
  };
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} · 沉麟</title>
<meta name="robots" content="noindex, follow">
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; background: #0b0b0d; color: #e8e3d9;
    font-family: ui-serif, Georgia, "Songti SC", "Noto Serif CJK SC", serif;
    line-height: 1.85; font-size: 17px;
  }
  .wrap { max-width: 44rem; margin: 0 auto; padding: 4rem 1.25rem 6rem; }
  .top { display: flex; gap: 1rem; align-items: baseline; font-size: .8rem;
         font-family: ui-monospace, Menlo, monospace; letter-spacing: .1em; color: #8a857c; }
  .top a { color: #c9a227; text-decoration: none; }
  h1 { font-size: clamp(1.9rem, 5vw, 2.9rem); line-height: 1.15; margin: 1.2rem 0 .6rem; }
  h2, h3, h4 { margin: 2rem 0 .6rem; line-height: 1.3; }
  hr { border: 0; border-top: 1px solid #2a2a2e; margin: 2rem 0; }
  blockquote { margin: 1.4rem 0; padding: .2rem 0 .2rem 1rem; border-left: 2px solid #c9a227; color: #b9b3a8; }
  pre { background: #141417; border: 1px solid #242428; padding: .9rem 1rem; overflow-x: auto; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: .9em; }
  img { max-width: 100%; height: auto; display: block; margin: 1.4rem 0; }
  a { color: #c9a227; }
  .meta { margin-top: 3rem; font-family: ui-monospace, Menlo, monospace;
          font-size: .72rem; letter-spacing: .08em; color: #6f6a63; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <a href="/home">沉麟</a><span>/</span><span>${collName[o.coll] ?? o.coll}</span><span>/</span><span>线上稿</span>
    </div>
    <h1>${esc(o.title)}</h1>
    <div class="meta">更新于 ${date} · 这一页由后台直接发布，未经过构建</div>
    <hr>
    ${mdToHtml(o.body)}
    <div class="meta">— 完 —</div>
  </div>
</body>
</html>`;
}
