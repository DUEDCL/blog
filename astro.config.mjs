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

  integrations: [mdx(), sitemap()],

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
      // 双主题：随深浅色切换，无需运行时 JS 重新高亮
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      // 关键：false 时两套颜色都以 CSS 变量输出（--shiki-light / --shiki-dark），
      // 不写死行内色。默认值 'light' 会把浅色写进 style，深色优先的站点会错。
      defaultColor: false,
      wrap: true,
    },
  },
});
