---
title: 阿里云 CDN + 腾讯云 CDN 双优化方案：从 0 到 1 的完整落地教程
categories:
  - 教程发布
tags:
  - CDN
  - 阿里云
  - 腾讯云
  - 性能优化
  - 运维
cover: '/tutorial/cdn/arch.png'
description: 单 CDN 的容灾与成本天花板太低？本站真实落地的阿里+腾讯双 CDN 方案：缓存规则对齐、DNSPod 分线路调度、刷新预热流程化，TTFB 下降 90%、源站带宽下降 91%，附完整配置截图与踩坑清单。
comments: true
date: 2026-10-30 07:01:14
updated: 2026-10-30 07:01:14
---

# 阿里云 CDN + 腾讯云 CDN 双优化方案：从 0 到 1 的完整落地教程

> 单 CDN 就够了吗？当你的源站被回源流量打满、某家 CDN 抽风导致全国访问超时、或者月底一看流量账单肉疼的时候，你就会明白为什么 serious 的站点都在跑**双 CDN 架构**。这篇教程基于本站（宝塔 + Nginx 源站）的真实落地过程，把阿里云 CDN 和腾讯云 CDN 的配置要点、调度方案和踩坑点一次讲透。

![双CDN架构图](/tutorial/cdn/arch.png)

## 一、为什么要「阿里 + 腾讯」双 CDN？

| 维度 | 单 CDN | 双 CDN 组合 |
|---|---|---|
| 容灾能力 | CDN 故障 = 全站故障 | 境内走阿里、境外走腾讯，单云故障一键切换 |
| 访问质量 | 厂商各有所长 | 阿里境内 2800+ 节点 + 腾讯境外 3200+ 节点，各打各的优势区 |
| 成本 | 只能用一家的价格体系 | 两家流量包混搭叠加，流量单价能压到 0.1 元/GB 以内 |
| 回源压力 | 全部回源压力打在源站 | 中间源 + 回源收敛，源站带宽直降 90% |

核心思路一句话：**源站只有一套，DNS 按线路把流量拆给两朵云，两朵云配置对齐，任何一家挂了都能 5 分钟内切流**。

## 二、前置准备：源站要做对的三件事

双 CDN 的效果上限取决于源站配置，动手前先确认：

1. **全站 HTTPS**：CDN 回源走 HTTPS，源站证书要有效（宝塔 Let's Encrypt 自动续期即可）；
2. **静态资源带版本号**：`app.js?v=20261030` 这种写法配合 CDN 缓存最干净，改版不用刷新；
3. **动态接口与静态资源分路径**：`/api/*` 是动态、其余是静态，后面缓存规则要按这个拆。

另外在两家 CDN 上传的加速域名建议分开：境内 `cdn-static.ldnet.tech`、境外 `cdn-oversea.ldnet.tech`，配置互不干扰，回滚也方便。

## 三、阿里云 CDN 配置（境内主节点）

![阿里云CDN控制台配置](/tutorial/cdn/ali-config.png)

### 3.1 添加加速域名

控制台 → CDN → 域名管理 → 添加域名，四个关键项：

- **加速域名**：`cdn-static.ldnet.tech`；
- **业务类型**：图片小文件（博客/资讯类站点选这个）；
- **源站信息**：填源站 IP `156.x.x.x`，端口 443，**回源协议选 HTTPS**——源站强制 HTTPS 的话，这里选 HTTP 会直接 502；
- **回源 Host**：填真实站点域名 `ldnet.tech`，不是加速域名！这是新手第一大坑。

添加完成后阿里云会分配一个 CNAME（形如 `xxx.w.kunlungr.com`），先记下来，第五节统一配解析。

### 3.2 缓存规则（自上而下匹配）

| 优先级 | 规则 | TTL |
|---|---|---|
| 1 | 后缀 `jpg;png;webp;gif;svg;ico;avif` | 180 天 |
| 2 | 后缀 `css;js;woff2;ttf` | 30 天 |
| 3 | 目录 `/api/` | **不缓存** |
| 4 | 其余全部 | 遵循源站 Cache-Control |

`/api/` 不缓存这条**必须配**，否则边缘节点把接口响应缓存住，用户看到的就是别人的数据。

### 3.3 性能优化开关

- **智能压缩**：Gzip + Brotli 全开（文本类资源体积再省 30%）；
- **HTTP/2 + QUIC**：HTTPS 域名默认支持 HTTP/2，QUIC 建议打开，弱网收益明显；
- **Range 回源**：大文件必开，防止回源超时；
- **过滤参数**：如果静态资源带 `?v=` 版本号，选「保留参数」，否则不同版本会互相覆盖。

## 四、腾讯云 CDN 配置（境外节点）

![腾讯云CDN控制台配置](/tutorial/cdn/tencent-config.png)

腾讯云这边的域名加速区域选**「全球（不含中国内地）」**——境外线路免备案，和境内域名互不冲突。

### 4.1 回源配置要点

- 源站同样填 IP:443，回源协议 HTTPS、**回源跟随 302 开启**；
- **中间源（回源收敛）务必开启**：多个边缘节点回源会先收敛到中间层，源站带宽压力直降 90%，这是腾讯云最容易忽略的高价值开关；
- **Range 回源**开启。

### 4.2 缓存键与状态码缓存

- Cache Key **保留全部参数**（与阿里侧对齐，版本号资源独立缓存）；
- 节点缓存过期规则和阿里侧一致：图片 180 天 / 文本 30 天 / `/api/` 不缓存；
- **状态码缓存单独配**：`404 → 缓存 10s`，防恶意扫描打爆回源；`5XX → 不缓存`，故障时千万别把错误页放大。

## 五、DNSPod 智能解析：把流量拆给两朵云

![DNSPod智能解析配置](/tutorial/cdn/dnspod.png)

这是整个方案的调度中枢。到 DNSPod 云解析（或其它支持分线路的解析商）添加记录：

| 主机记录 | 类型 | 线路 | 记录值 |
|---|---|---|---|
| www | CNAME | **境内** | `cdn-static.ldnet.tech.w.kunlungr.com`（阿里） |
| www | CNAME | **境外** | `cdn-oversea.ldnet.tech.cdn.dnsv1.com`（腾讯） |
| static | CNAME | 默认 | 阿里的 CNAME |

**容灾切换**：同一主机同一线路可以放两条 CNAME 做负载均衡；再配合 DNSPod「云拨测」监控两家 CDN 的可用性，一家故障时把它的权重降为 0，流量自动全量切到另一家，5 分钟内完成，无需改代码。

> 阿里云和腾讯云的 CNAME 值以各自控制台实际分配的为准，上表是格式示意。

## 六、缓存刷新与预热：发布新版不翻车

![刷新预热命令](/tutorial/cdn/refresh.png)

日常发布流程建议固化成脚本：

```bash
# 1. 阿里云：目录刷新（每天 100 条额度）
aliyun cdn RefreshObjectCaches \
  --ObjectPath "https://cdn-static.ldnet.tech/css/" \
  --ObjectType Directory

# 2. 腾讯云：URL 刷新
tccli cdn PurgeUrlsCache \
  --Urls "https://cdn-oversea.ldnet.tech/app.js"

# 3. 大促/首发场景：先预热再放量
aliyun cdn PushObjectCache --ObjectPath "https://cdn-static.ldnet.tech/logo.webp"
tccli cdn PushUrlsCache --Urls "https://cdn-oversea.ldnet.tech/logo.webp"
```

先「目录刷新」让旧资源失效，再「预热」把新资源推到边缘节点，命中率过渡最平滑，不会出现刷新后瞬间回源洪峰。

## 七、效果验证：用数据说话

切流后用 curl 直接量首字节：

```bash
# 看是否命中 CDN（命中时响应头有 X-Cache: HIT / eo-cache 等标记）
curl -sI https://www.ldnet.tech/ | grep -iE "x-cache|server|eo-|via"

# 量 TTFB
curl -o /dev/null -s -w "DNS:%{time_namelookup}  连接:%{time_connect}  首字节:%{starttransfer_s}  总耗时:%{time_total}s\n" https://www.ldnet.tech/
```

本站连续 3 日的实测数据：

![性能对比图](/tutorial/cdn/perf.png)

- **TTFB 从 420ms 降到 40ms 左右**（降幅 90%）；
- 首页完整加载从 3.8s 到 0.9s；
- 边缘缓存命中率稳定在 97%+，源站带宽下降 91%。

## 八、踩坑清单（每条都是真实付出过代价的）

| 坑 | 现象 | 解法 |
|---|---|---|
| 回源 Host 填成加速域名 | 回源 404 / 502 | 回源 Host 必须填真实站点域名 |
| 源站强制 HTTPS 但 CDN 用 HTTP 回源 | 502 | 回源协议选 HTTPS |
| `/api/` 没配不缓存 | 接口返回别人的数据 | 动态路径显式配不缓存 |
| 忽略了 URL 参数 | `?v=2` 和 `?v=3` 共用一份缓存 | 保留查询参数 |
| 5XX 配了状态码缓存 | 源站故障时全网看到错误页 | 5XX 永远不缓存，404 才配短 TTL |
| 双云缓存规则不一致 | 切流后新旧内容混杂 | 两家规则表逐条对齐，写进配置基线 |
| 跨云回源走了国际链路 | 境外 CDN 回源境内源站慢 | 源站开放全球访问 + 开中间源收敛 |

## 九、总结

双 CDN 不是简单买两份服务，核心是三件事：**缓存规则对齐、DNS 分线路调度、刷新预热流程化**。落地之后你得到的是：TTFB 下降 90%、源站带宽下降 91%、任何一家 CDN 故障都能分钟级切换。

如果你的站点也压着一台裸奔的源站，照着这篇一步步配，一个下午就能完成迁移。有问题欢迎在评论区留言讨论。

