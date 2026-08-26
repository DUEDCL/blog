---
title: 街角
description: 一些走路时拍的东西。没什么主题，就是光刚好落在那里。
pubDate: 2026-08-12
location: 待补充
# 占位内容，先不出现在站上。换成真照片后把这一行删掉（R32 决议）。
draft: true
cover: './street-01.jpg'
coverAlt: 占位图，请替换为你自己的照片
images:
  - src: './street-02.jpg'
    alt: 占位图，请替换
    caption: 图说可以写下当时的情境，也可以留空
  - src: './street-03.jpg'
    alt: 占位图，请替换
# 元数据的译文（R46）。正文仍是中文原文，详情页会在标题下挂一条说明 ——
# 正文也译好之后放到 src/content/i18n/<语言>/<栏目>/ 下，那时这一段可以留着，
# 两处都有时以译文文件里的为准（见 content.config.ts 的注释）。
i18n:
  en:
    title: "Street corners"
    description: "Things shot while walking. No theme — the light just happened to land there."
  ja:
    title: "街角"
    description: "歩きながら撮ったもの。主題はない、ただ光がちょうどそこに落ちていた。"
---

这组是占位内容。图片由脚本生成的抽象色块，用来让你看到相册的排版效果 —— 换成你自己的照片就行。

放图片的方法：把照片丢进 `src/content/photos/`，然后在上面的 frontmatter 里按相对路径引用。构建时会自动压缩、转 WebP、生成多个尺寸，你不需要手动处理。
