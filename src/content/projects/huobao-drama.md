---
title: 火宝短剧 · 二次开发
description: 不是我的项目。在一个一万四千星的开源 AI 短剧平台上补了一个视频生成 adapter，并把单镜头合成改成 TTS 可跳过。没做出成片。
pubDate: 2026-07-18
tags: ['TypeScript', 'FFmpeg', '二次开发']
status: 'archived'
# 元数据的译文（R46）。正文仍是中文原文，详情页会在标题下挂一条说明 ——
# 正文也译好之后放到 src/content/i18n/<语言>/<栏目>/ 下，那时这一段可以留着，
# 两处都有时以译文文件里的为准（见 content.config.ts 的注释）。
i18n:
  en:
    title: "Huobao Drama · extending someone else’s project"
    description: "Not my project. I added a video-generation adapter to a 14k-star open-source AI short-drama platform, and made single-shot compositing able to skip TTS. Never produced a finished film."
  ja:
    title: "火宝短劇 · 二次開発"
    description: "私のプロジェクトではない。1.4 万スターのオープンソース AI 短編ドラマ基盤に動画生成の adapter を足し、単カット合成で TTS を飛ばせるようにした。完成作は作っていない。"
---

先说清楚：**这不是我写的项目。** 它是 [chatfire-AI/huobao-drama](https://github.com/chatfire-AI/huobao-drama)，一个一万四千星的开源 AI 短剧生成平台。我在本地跑了一份，改了两处自己用得上的地方。

## 加的那一块

平台自带的视频生成 adapter 里没有我要用的服务商，于是补了一个：`adapters/toapis-video.ts`，走 `/v1/videos/generations`，对上 seedance-2 那几个模型。

麻烦的不是这 89 行，是把它接进去要动的另外六个文件 —— adapter 注册表、服务层、agent 入口、agent 路由、前端的 API 封装和设置页。少接一处不会报错，只会在某一条调用路径上说「该服务商没配置」，然后你去翻另外五个文件找哪儿漏了。

## 改的那一块

单镜头合成原来是固定的一条路：视频 + TTS 对白 + 烧录字幕，TTS 一定替换掉原音频。

问题是现在的视频生成模型自己就出声。于是给 `composeStoryboard()` 加了 `skipTTS`，三条分支分开写：有 TTS 就替换原音频；跳过 TTS 就 `-c:a copy` 保留模型自带的那条；既没对白又没跳过，才静音。

## 到哪儿为止

一部剧、一集，抽出 9 个角色和 17 个场景 —— 然后停了。分镜、图片、视频、拼接全是 0，`data/static` 是空的。**没做出成片。**

留这一条不是为了凑数。它值一句结论：一个看起来「填个 key 就能用」的服务商接入，实际要穿过多少层才算真的接进去。
