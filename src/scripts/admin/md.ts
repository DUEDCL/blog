/**
 * 写作工具里那个实时预览用的极简 Markdown 渲染器（R41②）。
 *
 * **为什么不引 marked／markdown-it**：站上正文的渲染是 Astro 构建期做的
 * （remark + rehype + KaTeX + Shiki），那一套的产物才是文章的最终样子。
 * 后台这个预览的用途只有一个 —— **写的时候看结构**（这一段是不是标题、列表有没有断、
 * 引用有没有闭合）。为这个目的往前端塞 50 KB 的解析器不值，也做不到与构建期一致
 * （数学公式与代码高亮这儿本来就不做）。所以它是**排版草图**，不是所见即所得，
 * 后台上那句提示就是这么写的。
 *
 * **安全**：先把整段 HTML 转义，再按行套模板。所以正文里写一段 script 标签只会显示成字、
 * 不会执行 —— 这一条不能省：草稿的内容来自输入框，而预览是 `innerHTML` 插进去的。
 */

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * 行内标记。**一趟扫完，不用占位符**：所有形式写在一个正则的 alternation 里，
 * 谁先匹配到谁生效，代码段排在最前，所以反引号里的星号不会被当成强调。
 *
 * 这正是「先把代码段抽出来存进数组、回填时再换回去」那套常见写法要解决的问题 ——
 * 而那套写法需要一个「正文里绝不会出现」的占位符，本身就是个坑
 * （用「空格+数字+空格」当占位符时，正文里本来就有的「 3 」会被还原成别的代码片段）。
 */
function inline(s: string): string {
  return s.replace(
    /`([^`]+)`|!\[([^\]]*)\]\(([^)\s]+)[^)]*\)|\[([^\]]+)\]\(([^)\s]+)[^)]*\)|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~/g,
    (m, code, alt, isrc, txt, href, bold, em, del) => {
      if (code !== undefined) return '<code>' + code + '</code>';
      if (isrc !== undefined) return '<span class="mdimg">图：' + alt + '（' + isrc + '）</span>';
      if (href !== undefined) return '<a href="' + href + '" rel="noopener">' + txt + '</a>';
      if (bold !== undefined) return '<strong>' + bold + '</strong>';
      if (em !== undefined) return '<em>' + em + '</em>';
      if (del !== undefined) return '<del>' + del + '</del>';
      return m;
    }
  );
}

/**
 * 整段渲染。支持的东西刻意只有这些：标题、围栏代码、引用、有序/无序列表、分隔线、段落。
 * 表格没做 —— 本站文章里表格不少，但预览的用途是看结构，一张没对齐的表格
 * 比一段原文更难看出问题，所以表格原样当段落显示。
 */
export function md(src: string): string {
  const lines = esc(src.replace(/\r\n/g, '\n')).split('\n');
  const out: string[] = [];
  let inCode = false;
  let list: '' | 'ul' | 'ol' = '';
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + inline(para.join(' ')) + '</p>');
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push('</' + list + '>');
      list = '';
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^```/.test(line)) {
      flushPara();
      flushList();
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const n = h[1].length;
      out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>');
      continue;
    }

    // 分隔线：三个以上同种符号独占一行。`esc` 不动这几个字符，照原样匹配
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push('<hr />');
      continue;
    }

    // 引用。`>` 经过 `esc` 已经变成 `&gt;`，所以这里匹配的是转义后的形态
    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) {
      flushPara();
      flushList();
      out.push('<blockquote>' + inline(quote[1]) + '</blockquote>');
      continue;
    }

    const li = line.match(/^\s*(?:([-*+])|(\d+)\.)\s+(.*)$/);
    if (li) {
      flushPara();
      const want: 'ul' | 'ol' = li[1] ? 'ul' : 'ol';
      if (list !== want) {
        flushList();
        out.push('<' + want + '>');
        list = want;
      }
      out.push('<li>' + inline(li[3]) + '</li>');
      continue;
    }

    flushList();
    para.push(line.trim());
  }

  flushPara();
  flushList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}
