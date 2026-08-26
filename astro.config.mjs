// @ts-check
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

// https://astro.build/config
export default defineConfig({
  // 主域。canonical、sitemap、RSS 里的绝对地址全由这里推导 ——
  // duchenlin.eu.cc 也绑在同一个 Worker 上，但它在国内被 RST，不能当主域。
  site: 'https://duchenlin.top',

  // /start 是起始页的旧地址。R14 阶段⑥ 把它搬到了根路径（需求逐字是「解决输入域名
  // 跳转的不是启动页问题」），旧链接不能断 —— 页脚指过它、外部也可能已经收录。
  // 静态输出下 Astro 为它生成一张 meta-refresh 跳转页并带上指向目标的 canonical，
  // 不依赖任何平台能力，所以选它而不是 Cloudflare 的 _redirects 文件。
  redirects: {
    '/start': '/',
  },

  integrations: [
    mdx(),
    // 不再排除 /start：那一页现在就是站点门面（根路径），本该进 sitemap。
    // 排除它的旧理由（「一张全英文的入口幕，标题与本站无关」）在 R17 之后也不成立了 ——
    // 页面上现在只有中文：站名、题词。
    //
    // /admin 排除：那是后台（R35）。「藏起来」的一半是不进 sitemap、不进 llms.txt、
    // `_headers` 里给它配 noindex；另一半是登录。地址难猜不算保护，所以地址就用 /admin。
    sitemap({ filter: (page) => !page.includes('/admin') }),
  ],

  image: {
    // 全局响应式：自动生成 srcset / sizes，摄影栏目依赖此项
    layout: 'constrained',
    responsiveStyles: true,
  },

  markdown: {
    // Astro 7 起插件通过 processor 传入，旧的 markdown.remarkPlugins 已弃用
    processor: unified({
      remarkPlugins: [remarkMath],
      rehypePlugins: [rehypeKatex],
    }),
    shikiConfig: {
      /* 双主题（R44 恢复）。R31 砍掉浅色时这里改成了单主题 `github-dark`，
         理由是「浅色档没了，双主题只会让每个 code 块多带一份用不上的
         --shiki-light-*」。现在四套版次里「晨版」是浅底纸，深底代码块压在米白纸上
         是整页唯一一块深色 —— 不是不能读，是与那一版的其余部分不是一份印刷品。

         `defaultColor: 'dark'` 让行内色直接是深色档（夜刊/胶片/霓虹三档零开销），
         浅色档以 `--shiki-light-*` 变量输出，由 global.css 里那两条按
         `html[data-theme='paper']` 切过去。 */
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      defaultColor: 'dark',
      wrap: true,
    },
  },
});
