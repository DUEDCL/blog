---
title: SQLite FTS5 搜不到中文，我是先测出来才动手写的
description: unicode61 把整段汉字当成一个 token。绕开它的办法不是换分词器，是索引派生 token —— 顺带说清为什么查询侧必须把单字丢掉。
pubDate: 2026-08-06
tags: ['SQLite', '全文检索', 'Python']
# 元数据的译文（R46）。正文仍是中文原文，详情页会在标题下挂一条说明 ——
# 正文也译好之后放到 src/content/i18n/<语言>/<栏目>/ 下，那时这一段可以留着，
# 两处都有时以译文文件里的为准（见 content.config.ts 的注释）。
i18n:
  en:
    title: "SQLite FTS5 cannot find Chinese — I measured that before writing a line"
    description: "unicode61 treats a whole run of Han characters as one token. The way around it is not a different tokeniser but indexing derived tokens — and here is why the query side has to drop single characters."
  ja:
    title: "SQLite FTS5 で中国語が引けない。書く前に測って分かった"
    description: "unicode61 は漢字のひと続きを一つのトークンとして扱う。回避策は分詞器の差し替えではなく、派生トークンを索引に入れることだ —— ついでに、検索側で一文字を捨てなければならない理由も書いた。"
---

给语音平台做记忆层，选的是 SQLite 加 FTS5：单文件、无服务、进程内，跟「本地优先」那条红线正好合。

动手之前先跑了一遍。还好跑了。

## 五行代码就能看到的坑

```python
import sqlite3
c = sqlite3.connect(':memory:')
c.execute("CREATE VIRTUAL TABLE t USING fts5(body)")
c.execute("INSERT INTO t(body) VALUES ('用户喜欢用中文交流 and english too')")
# 然后拿不同的词去 MATCH 这一行
```

同一行记录，四次查询：

| 查询 | 命中 |
| --- | :---: |
| `MATCH 'english'` | 1 |
| `MATCH '中文'` | 0 |
| `MATCH '用中文'` | 0 |
| `MATCH '喜欢'` | 0 |

英文命中，中文一个都不中。原因是 FTS5 默认的 `unicode61` 按空白和标点切词，而「用户喜欢用中文交流」中间没有空白 —— **整段汉字被当成了一个 token**。只有把这九个字连着一起查才可能命中，而没人会那样查。

本机 SQLite 3.49.1、Python 3.12.10。

## 两条现成的路，我都试过

**ICU 分词器。** FTS5 官方的答案，但 ICU 要在编译期进去，Python 自带的 `sqlite3` 没编。装扩展等于给一个「单文件、无服务」的方案加一个原生依赖 —— 红线是我自己定的，为了检索方便就破一次，后面每一条都可以照着破。

**trigram 分词器。** SQLite 3.34 起自带，不用 ICU，它确实索引中文。测出来是这样：

| 查询 | 长度 | 命中 |
| --- | :---: | :---: |
| `中文` | 2 | 0 |
| `喜欢` | 2 | 0 |
| `用中文` | 3 | 1 |
| `喜欢用` | 3 | 1 |

trigram 要求查询串至少 3 个字符，**短于 3 个字符它静默返回空** —— 不报错，就是没结果。中文里两字词密度极高：中文、偏好、喜欢、记忆、路由。查询侧全军覆没，还查不出原因。

## 解法：索引派生 token，不索引原文

分词器不肯切，那就自己切完再喂给它。索引侧存的不是原句，是派生出来的 token 串：**单字 + 相邻双字**。

「用户喜欢用中文交流」变成：

```text
用 户 喜 欢 用 中 文 交 流 用户 户喜 喜欢 欢用 用中 中文 文交 交流
```

token 之间有空白，`unicode61` 就能切了。查询侧同样展开成双字，用 AND 连起来。

## 查询侧为什么要把单字丢掉

这是整个方案里唯一需要停下来想一下的地方。

索引侧留了单字，查询侧只用双字。因为查「偏好」如果展开成 `偏 OR 好 OR 偏好`，那么任何含「好」的记录都会中 —— 「今天天气很好」跟「偏好」没有半点关系，但它会挤在召回结果的前面。

实测：

| 查询 | 展开成 | 命中 |
| --- | --- | :---: |
| 中文 | `"中文"` | 1 |
| 喜欢 | `"喜欢"` | 1 |
| 偏好 | `"偏好"` | 0 |

第三条命中 0 才是对的。丢掉单字换来精度，代价是纯单字查询没法命中。这笔账我认。

## 两段式召回

严格一遍：全部 token 用 AND，缺一个就整条不中。不中再退一步，换 OR，按 bm25 排序。

```python
def recall_records(store, query, *, limit=8):
    """严格一遍，不中再宽松一遍。两遍都空就返回空。"""
    strict = store.search(match_expression(query, require_all=True), limit=limit)
    if strict:
        return strict
    return store.search(match_expression(query, require_all=False), limit=limit)
```

两段的顺序就是这个折中的全部内容：**召回一堆垃圾比召回空更糟，但明明有相关的却召回空也好不了多少**。所以先要精度，拿不到再要覆盖。

还有一处不显眼但省不掉的 —— 每个 token 都要加双引号：

```python
return joiner.join(f'"{token}"' for token in dict.fromkeys(tokens))
```

查询词是麦克风里来的一句人话，`NOT`、`*`、`(` 都可能原样出现在里面。不包住，用户说一句带这些字符的话就直接撞进 FTS5 的查询语法里去了。

## 顺便说一句向量检索

按理说中文语义检索该上向量，我算了一下就放下了：单人语料这个规模，换不来额外 200 MB 本地嵌入模型的代价 —— 体积、加载时间，还多一个依赖边界。

而且真相源根本不在库里。事实层是 `memory/facts/*.md`，可以手改；SQLite 只是它上面的一个索引，删了能重建。**能被人打开看、能被人改对的记忆，比检索得更准的记忆重要。**

## 收成一句

分词器的行为要自己测一遍，别信「支持 Unicode」这四个字 —— `unicode61` 确实支持 Unicode，它只是不切中文。
