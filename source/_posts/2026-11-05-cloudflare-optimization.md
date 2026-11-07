---
title: Cloudflare 免费套餐优化实战：零成本让网站快到飞起
categories:
  - 教程发布
tags:
  - Cloudflare
  - CDN
  - SSL
  - 性能优化
  - 网络安全
cover: /tutorial/cf/cf-arch.svg
description: >-
  不花一分钱，用 Cloudflare 免费套餐给网站套上全球 CDN、全链路 HTTPS、WAF 防火墙和 DDoS 防护。本篇基于本站真实配置，从 DNS
  接入、SSL/TLS 加密模式、缓存规则到 WAF 自定义规则逐项实操，TTFB 从 420ms 降到 85ms，附完整配置截图与规则表达式。
comments: true
abbrlink: ac336d88
date: 2026-11-05 18:30:00
updated: 2026-11-05 18:30:00
---

# Cloudflare 免费套餐优化实战：零成本让网站快到飞起

> 很多个人站长的第一反应是：CDN 和 WAF 都是按流量收费的奢侈品。其实 Cloudflare 的免费套餐已经覆盖了全球 CDN、无限 DDoS 防护、免费 SSL 证书和基础 WAF——只要配置得当，零成本也能把 TTFB 从 420ms 压到 85ms。这篇教程把本站接入 Cloudflare 的全过程整理成可复制的操作手册，照着做就行。

![Cloudflare 全球加速架构](/tutorial/cf/cf-arch.svg)

## 一、为什么选 Cloudflare？

在双 CDN 方案里，阿里云和腾讯云负责境内流量，而 Cloudflare 负责境外加速和安全兜底。对纯个人站点来说，Cloudflare 免费套餐甚至可以独立撑起整个站点的加速与防护：

| 维度 | 传统自建 | Cloudflare 免费套餐 |
|---|---|---|
| CDN 节点 | 单机房或单region | 全球 330+ 城市边缘节点，Anycast 就近接入 |
| HTTPS 证书 | 手动申请+续期 | 自动签发，一键开启全链路加密 |
| DDoS 防护 | 无，或按防护峰值收费 | 不限流量、不限次数的 L3/L4/L7 防护 |
| WAF 规则 | 需额外购买安全产品 | 5 条自定义规则 + 托管规则集 |
| 价格 | 每月几十到几千 | 0 元 |

一句话总结：**免费套餐给的不是一个"试用版 CDN"，而是一套完整的边缘安全加速体系。**

## 二、接入 Cloudflare：5 分钟接管 DNS

1. 注册 Cloudflare 账号，点击 **Add a site**，输入你的主域名（如 `ldwl.tech`）。
2. 选择 **Free 计划**，Cloudflare 会自动扫描现有 DNS 记录并导入。
3. 确认记录无误后，Cloudflare 会给你两个 Nameserver，形如 `xxx.ns.cloudflare.com`。
4. 到域名注册商处把 Nameserver 改成这两个地址。
5. 等待 NS 生效（通常几分钟到几小时），状态变为 **Active** 即接入完成。

{% note warning %}
**踩坑提示**：如果域名同时用了 DNSPod 等国内 DNS 做分线路解析，接入 Cloudflare 后所有解析都会收归 CF 管理。本站的做法是：主域名走 Cloudflare，子域名按需用 CNAME 接入国内 CDN，两边互不冲突。
{% endnote %}

接入后，DNS 记录列表里的橙色云朵代表该记录已启用代理（流量经 CF 边缘），灰色云朵代表仅 DNS 解析。**加速和安全功能只在橙色云朵下生效**，源站真实 IP 也会被隐藏。

## 三、SSL/TLS：一步到位选「完全（严格）」

这是接入后**最优先、也最容易翻车**的一步。进入 SSL/TLS → 概述，可以看到四种加密模式：

![SSL/TLS 加密模式设置](/tutorial/cf/cf-ssl.svg)

| 模式 | 浏览器→CF | CF→源站 | 安全性 | 建议 |
|---|---|---|---|---|
| 关闭 | HTTP | HTTP | 无 | 仅测试用 |
| 灵活 | HTTPS | HTTP | 伪加密，回源裸奔 | 坚决不用 |
| 完全 | HTTPS | HTTPS | 加密但不验证证书 | 过渡可用 |
| 完全（严格） | HTTPS | HTTPS + 证书校验 | 端到端可信 | **最终目标** |

**操作步骤**：

1. 先在源站装好证书。宝塔面板用户直接申请 Let's Encrypt，3 分钟搞定；没有面板的用 `acme.sh` 一行命令签发。
2. SSL/TLS 模式直接选 **完全（严格）**。
3. 打开 **SSL/TLS → 边缘证书** 里的「始终使用 HTTPS」和「最低 TLS 版本 1.2」。
4. 开启 **HSTS**（max-age 至少 6 个月），强制浏览器后续只走 HTTPS。

{% note danger %}
**大坑预警**：很多教程让你先选「灵活」跑通再改，结果源站没装证书、回源走 HTTP，等于前面挂了把锁、后门敞着。一旦源站证书就绪，立刻切到「完全（严格）」，别在「灵活」上停留。
{% endnote %}

## 四、缓存策略：让 96% 的请求不出边缘

Cloudflare 默认只缓存静态资源且 TTL 较短。想压榨性能，得用**缓存规则（Cache Rules）**精确控制。本站目前跑了三条核心规则：

![缓存规则配置](/tutorial/cf/cf-cache.svg)

**规则 1：静态资源长缓存**

- 匹配：`URI Path ends with .css .js .png .jpg .webp .woff2 .svg`
- 操作：边缘缓存 TTL = **1 年**，浏览器缓存 TTL = **1 年**
- 效果：命中后 0 回源，边缘直接返回，TTFB 降到 20ms 级别

**规则 2：HTML 短缓存**

- 匹配：`URI Path ends with .html` 或 `Content-Type equals text/html`
- 操作：边缘缓存 TTL = **5 分钟**
- 理由：博客文章更新后最多 5 分钟生效，兼顾时效与性能

**规则 3：后台与接口绕过缓存**

- 匹配：`URI Path starts with /admin` 或 `/api`
- 操作：**绕过缓存（Bypass cache）**
- 理由：登录态、动态接口一旦被缓存，会出现串号和脏数据

{% note info %}
**TTL 怎么选？** 静态资源带 hash/版本号的直接给 1 年；不带版本号的给 7 天 + 发布时用「清除缓存」刷新；HTML 类看更新频率，5 分钟～1 小时之间取值。本站这套规则上线后缓存命中率稳定在 96%，近 30 天节省回源请求 128 万次。
{% endnote %}

## 五、安全防护：WAF 自定义规则实战

免费套餐给 5 条自定义 WAF 规则，对个人站点足够。本站目前在跑的四条：

![WAF 自定义规则](/tutorial/cf/cf-waf.svg)

**规则 1：屏蔽敏感路径扫描**

```
(http.request.uri.path contains "/.env") or (http.request.uri.path contains "/wp-admin") or (http.request.uri.path contains "/.git")
→ 操作：Block
```

上线一周就拦截了 12000+ 次扫描，源站日志干净了一大截。

**规则 2：后台仅限国内访问**

```
(http.request.uri.path contains "/admin") and (ip.geoip.country ne "CN")
→ 操作：Block
```

海外 IP 根本看不到后台页面，暴力破解的攻击面直接砍掉九成。

**规则 3：登录接口速率限制**

```
(http.request.uri.path eq "/api/login") and (cf.threat_score gt 10)
→ 操作：Managed Challenge
```

对可疑来源弹出 Cloudflare Turnstile 人机验证，正常用户无感，脚本直接卡死。

**规则 4：可疑 Bot 人机验证**

```
(cf.bot_management.score lt 30) and (not cf.client.bot)
→ 操作：JS Challenge
```

低信誉爬虫全部走 JS 挑战，搜索引擎验证爬虫（Verified Bot）放行，不影响收录。

{% note warning %}
**规则顺序很重要**：WAF 按优先级从上到下匹配，命中即停。把「Block」类规则放前面，「Challenge」类放后面，避免误伤。每次新加规则先观察 24 小时再定稿。
{% endnote %}

## 六、速度优化：别漏掉这些免费开关

除了缓存，Cloudflare 还有一堆"开就完事"的免费加速功能，集中在「速度 → 优化」页面：

**必开项**

| 开关 | 作用 | 建议 |
|---|---|---|
| Brotli 压缩 | 比 gzip 再省 15-20% 体积 | 开 |
| HTTP/2 | 多路复用，连接复用 | 默认开 |
| HTTP/3 (QUIC) | 基于 UDP，弱网提速明显 | 开 |
| 0-RTT 连接恢复 | TLS 握手 0 往返，回访秒开 | 开 |
| 早期提示 (Early Hints) | 预加载关键资源，首屏再快一档 | 开 |

**按需开**

- **Polish**：图片无损/有损压缩，免费套餐不提供，Pro 起步。预算有限可以在构建时用 `imagemin` / `squoosh` 自己压。
- **Rocket Loader**：异步加载 JS。对老站点有效，但容易打碎依赖 DOM 顺序的脚本，**博客主题插件多的话慎开**——本站实测开启后评论区直接挂掉，果断关了。
- **自动压缩 (Auto Minify)**：CF 已逐步下线该功能，建议在构建阶段用工具本地压缩，不依赖边缘。

{% note info %}
**国内访问提示**：Cloudflare 免费节点在国内的直连质量随地区波动。如果目标用户主要在国内，建议配合国内 CDN 做分线路调度（可参考本站《双 CDN 优化方案》一文），Cloudflare 负责境外加速和安全兜底，体验最稳。
{% endnote %}

## 七、实测效果

配置全部落地后，用 WebPageTest + Lighthouse 对同一页面做了前后对比：

![接入 Cloudflare 前后性能对比](/tutorial/cf/cf-speed.svg)

| 指标 | 优化前（直连源站） | 优化后（经 Cloudflare） | 变化 |
|---|---|---|---|
| TTFB | 420 ms | 85 ms | **-79.8%** |
| 首屏完全加载 | 2.8 s | 0.9 s | **-67.9%** |
| LCP | 3.1 s | 1.2 s | **-61.3%** |
| 缓存命中率 | — | 96% | 节省回源 128 万次/月 |
| 恶意请求拦截 | 0 | 58,633 次/周 | 源站零感知 |

最直观的感受：境外访客从"转圈 5 秒"变成"秒开"，源站日志里再也没见过扫描脚本刷屏。

## 八、写在最后

Cloudflare 免费套餐的完整优化路径，归纳起来就四步：

1. **接入 DNS**，橙色云朵开启代理，隐藏源站 IP
2. **SSL/TLS 切到「完全（严格）」**，源站装好 Let's Encrypt 证书
3. **缓存规则三分法**：静态长缓存、HTML 短缓存、动态绕过
4. **WAF 四条规则**：屏蔽扫描、后台地域锁、登录限速、Bot 挑战

做完这四步，你已经拿到了 90% 的收益。剩下的 10%（Polish、Argo 智能路由、Workers 定制逻辑）属于付费或进阶玩法，等站点流量起来再考虑也不迟。

如果你也在折腾网站加速，欢迎在评论区交流你的配置方案——尤其是国内分线路调度的最优解，本站也还在持续优化中。

> 相关阅读：《阿里云 CDN + 腾讯云 CDN 双优化方案：从 0 到 1 的完整落地教程》