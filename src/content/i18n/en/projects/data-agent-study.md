---
# 一篇**正文译文**（R46 的机制样本）。
#
# 路径就是它的身份：`i18n/<语言>/<栏目>/<slug>` 与原文的 slug 逐字对应，
# 详情页照这个键去找（`utils/content.ts` 的 `translationOf()`）。
#
# 标题与摘要写在这儿而不是原文的 `i18n:` 段里 —— 那两处的分工是：
#   · 原文 `i18n:` 段 = 只译了元数据、正文还是中文时用（站上另外十四篇都是这样）；
#   · 这个文件 = 正文也译了，那就把标题摘要一起带上，一篇译文一个文件、自包含。
# 两处都写了的话**这边优先**（离正文最近的那份最可能是最新的）。
title: A study track toward a data-analysis agent
description: Two legs of a seven-week route are done — Python with LLM APIs, then Pandas for loading, cleaning and grouping. It stopped at SQL, and it says so.
---

This is not a project. It is a study track. It sits here because it produced something, and because it reached a conclusion.

The goal was never to write a few analysis scripts. It was to end up with a data-analysis agent I would actually use. The route: Python and LLM APIs → Pandas → SQL → analysis in practice → tool calling and agent architecture.

## What I finished

- **Python, and getting an LLM API to answer for the first time** — virtual environments, the terminal, reading the key out of an environment variable, and a first reply on the screen.
- **The core of Pandas** — loading, cleaning, grouping. The closing exercise was a set of coffee orders: sales and average price per product, with the cleaned data and the summary table each written to disk.

## Where it stopped

SQL got started and then stopped. **The drive is gone for now, and I am not going to pretend otherwise.**

## Why it is still here

Because none of it was wasted, and because the direction has not changed — in the voice platform I built afterwards, the questions of "which agent does this go to" and "how does a tool get called safely" are exactly what the fourth leg of this route runs into. I went around in a circle and came back to the same place.

I will pick this one back up.
