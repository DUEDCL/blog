---
# Claude 起草，事实核对过，口吻待沉麟重写。改完把 draft 去掉。
question: 为什么有两个域名？duchenlin.eu.cc 我打不开是怎么回事？
aliases:
  - 你的网站地址是哪个
  - eu.cc 那个域名打不开
  - 为什么访问不了你的网站
topic: 这个站
draft: true
---

主域是 `duchenlin.top`，`duchenlin.eu.cc` 是备用入口，两个都绑在同一个 Worker 上，
内容完全一样。

`duchenlin.eu.cc` **在国内访问不了**，原因是有中间设备按主机名做字符串匹配、注入 TCP RST。
判据是主机名本身，所以换 IP、换端口、换子域名都绕不过去 —— 这不是配置问题，也没法从
我这一侧修。境外访问是正常的。

所以要访问请用 `duchenlin.top`。
