// @ts-check
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

// https://astro.build/config
export default defineConfig({
  site: 'https://duchenlin.eu.cc',

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
      // 双主题：随深色模式切换，无需运行时 JS 重新高亮
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      wrap: true,
    },
  },
});
