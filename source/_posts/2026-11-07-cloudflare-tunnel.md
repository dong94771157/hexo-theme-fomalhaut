---
title: Cloudflare Tunnel 内网穿透实战：无需公网 IP 把家里服务暴露到互联网
categories:
  - 教程发布
tags:
  - Cloudflare
  - Tunnel
  - 内网穿透
  - cloudflared
  - 自建服务
cover: /tutorial/cftunnel/cftunnel-arch.svg
description: >-
  家里跑了 NAS、发卡站、开发环境，出门在外想访问却没公网 IP？Cloudflare Tunnel 让内网机器主动外连 CF 边缘节点，零端口映射、零公网
  IP、自带 HTTPS 和 DDoS 防护，免费额度个人完全够用。本篇从 30 秒极速试用到生产级常驻部署，附 Docker、SSH/RDP
  远程、控制台演示图与踩坑清单。
comments: true
abbrlink: af73f4b8
date: 2026-11-07 14:00:00
updated: 2026-11-07 14:00:00
---

# Cloudflare Tunnel 内网穿透实战：无需公网 IP 把家里服务暴露到互联网

> 很多人家里都跑着几样东西：一台 NAS 存照片、一个发卡站赚零花钱、一套开发环境随手用。但只要出了门，这些服务就「失联」了——运营商早就不给公网 IP，路由器端口映射无从谈起，frp 又得额外买台云服务器当中转。Cloudflare Tunnel 的思路完全反过来：**不是让外网找进来，而是让内网主动连出去**。一条加密隧道把 CF 全球边缘节点和你的内网打通，外面的人访问你的域名，流量经 CF 转发进隧道，直达内网服务。本篇把从 30 秒试用到生产级部署的完整流程整理成可复制的操作手册。

![Cloudflare Tunnel 内网穿透架构](/tutorial/cftunnel/cftunnel-arch.svg)

## 一、它解决什么问题？

先看传统方案为什么越来越难走：

- **路由器端口映射**：前提是有公网 IP。现在大部分家宽都是大内网 NAT，打 10086 要公网 IP 也未必给；就算有，开端口等于把内网服务裸奔到互联网，扫描器分分钟光顾。
- **frp / nps 自建**：不需要公网 IP，但需要**一台有公网 IP 的云服务器**当中转，双端配置、保活、证书续期全得自己来，服务器一年也要几百块。
- **ngrok 免费版**：域名随机变、有连接数限制、国内访问不稳定。

Cloudflare Tunnel（前身 Argo Tunnel）把这三座大山一次搬掉：

| 痛点 | Cloudflare Tunnel 的解法 |
| --- | --- |
| 没有公网 IP | 内网主动外连，不需要任何入站端口 |
| 不想开端口 | 全部出站流量，路由器零配置 |
| HTTPS 证书麻烦 | CF 自动签发 + 自动续期 |
| 怕被 DDoS / 扫描 | 真实 IP 永不暴露，CF WAF 和 DDoS 防护前置 |
| 不想买服务器 | 跑在 CF 免费额度内，个人零成本 |

{% note info %}
**免费额度够用吗？** Cloudflare Tunnel 本身完全免费，不限制流量。唯一需要注意的是 Zero Trust（Access 策略）免费版上限 50 个用户——对个人和小组来说绰绰有余。
{% endnote %}

## 五、生产级部署：Named Tunnel 五步走

Quick Tunnel 图个新鲜，真正长期用必须上 **Named Tunnel**：域名固定、可挂多条路由、可配 Access 策略。以下以 Linux（Debian/Ubuntu）为例，完整命令流如下：

![cloudflared 命令行安装与配置流程](/tutorial/cftunnel/cftunnel-cli.svg)

### 第 1 步：安装 cloudflared

```bash
# Debian / Ubuntu
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared-linux-amd64.deb

# CentOS / RHEL
rpm -i https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm

# macOS
brew install cloudflared

# Windows（管理员 PowerShell）
winget install --id Cloudflare.cloudflared
```

装完验证一下：

```bash
cloudflared --version
```

### 第 2 步：登录授权

```bash
cloudflared tunnel login
```

终端会打印一个 `https://dash.cloudflare.com/argotunnel?callback=...` 链接并自动打开浏览器（无图形界面则手动复制到本机浏览器打开）。在浏览器里选择你要用的域名，点授权。成功后终端提示：

```
You have successfully logged in.
cert.pem saved to /root/.cloudflared/cert.pem
```

这个 `cert.pem` 是后续创建隧道的凭证，别删。

### 第 3 步：创建隧道

```bash
cloudflared tunnel create home-lab
```

输出示例：

```
Created tunnel home-lab with id a1b2c3d4-e5f6-7890-abcd-ef1234567890
Tunnel credentials written to /root/.cloudflared/a1b2c3d4-e5f6-7890-abcd-ef1234567890.json
```

记住这个 **Tunnel ID**，配置文件里要用。`<Tunnel ID>.json` 是隧道的身份凭证，和 `cert.pem` 一样重要。

### 第 4 步：写配置文件

在 `/root/.cloudflared/` 下创建 `config.yml`：

```yaml
tunnel: a1b2c3d4-e5f6-7890-abcd-ef1234567890
credentials-file: /root/.cloudflared/a1b2c3d4-e5f6-7890-abcd-ef1234567890.json

ingress:
  # NAS 管理面板
  - hostname: nas.ldwl.dpdns.org
    service: http://localhost:5000
  # 发卡站后台
  - hostname: shop.ldwl.dpdns.org
    service: http://localhost:8080
  # 兜底规则（必须放最后）
  - service: http_status:404
```

{% note info %}
**ingress 规则要点**：按从上到下顺序匹配 `hostname`，命中即转发到对应 `service`；最后一条必须是**没有 hostname 的兜底规则**（通常返回 404），否则启动报错。一条隧道可以挂任意多条路由，把内网所有服务一网打尽。
{% endnote %}

### 第 5 步：绑定 DNS 并启动

```bash
# 为每条路由创建 CNAME（只需执行一次）
cloudflared tunnel route dns home-lab nas.ldwl.dpdns.org
cloudflared tunnel route dns home-lab shop.ldwl.dpdns.org

# 启动隧道
cloudflared tunnel run home-lab
```

`route dns` 会在 CF DNS 里自动创建一条 CNAME 记录：`nas.ldwl.dpdns.org → a1b2c3d4-e5f6-7890-abcd-ef1234567890.cfargotunnel.com`，无需手动去 DNS 面板添加。

看到下面这行就说明通了：

```
INF Connection registered connIndex=0 location=hkg
```

现在用手机流量访问 `https://nas.ldwl.dpdns.org`，你家的 NAS 面板就出来了——全链路 HTTPS，证书 CF 自动搞定。

### 设为开机自启（systemd）

手动跑 `tunnel run` 终端关了就断，生产环境必须注册为系统服务：

```bash
cloudflared service install
systemctl enable cloudflared
systemctl start cloudflared
systemctl status cloudflared   # 确认 active (running)
```

{% note warning %}
**注意**：`service install` 会读取当前用户 `~/.cloudflared/config.yml` 并复制到 `/etc/cloudflared/config.yml` 作为服务配置。之后改配置要改 `/etc/cloudflared/config.yml`，改完 `systemctl restart cloudflared` 生效。
{% endnote %}

Windows 下对应的命令是（管理员 PowerShell）：

```powershell
cloudflared service install
```

会注册为 Windows 服务 `Cloudflared`，开机自启。

## 六、Zero Trust 控制台可视化管理

命令行创建的隧道，在 Cloudflare Zero Trust 控制台（`one.dash.cloudflare.com`）里全能看到和管理：隧道健康状态、连接数、所在节点，以及每条 Public Hostname 路由。

![Cloudflare Zero Trust 控制台 - Tunnels 管理界面](/tutorial/cftunnel/cftunnel-dash.svg)

控制台里能做的事：

- **看健康状态**：`HEALTHY` 表示 4 条连接全在；`DOWN` 说明 cloudflared 进程挂了或机器断电。
- **增删路由**：不用敲命令，在 Public Hostname 页面点 Add，填子域名 + 服务地址即可。
- **装新机器**：点进隧道 → Install connector，会给你一条带 token 的安装命令，新机器粘贴执行就加入这条隧道（多机负载均衡）。
- **配 Access 策略**：给敏感后台加一层邮箱 OTP 验证，只有你能登录（免费版 50 用户内免费）。

## 七、Docker 部署：容器党最爱

如果你的服务全跑在 Docker 里，cloudflared 也可以容器化，和业务编排在一起：

```yaml
version: "3.8"
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel run
    environment:
      - TUNNEL_TOKEN=eyJhIjo...   # 从控制台 Install connector 处复制
    networks:
      - internal

  dujiao:
    image: dujiao/dujiao-next:latest
    restart: unless-stopped
    networks:
      - internal

networks:
  internal:
```

{% note info %}
**Token 模式 vs 配置文件模式**：用 `TUNNEL_TOKEN` 环境变量时，路由规则在 Zero Trust 控制台的 Public Hostname 页面配置（`service` 填 `http://dujiao:8080`，用 Docker 服务名代替 localhost），本地不需要 config.yml。两种模式任选其一，Token 模式更适合纯 Docker 场景。
{% endnote %}

## 八、不止 HTTP：SSH / RDP 也能穿

Cloudflare Tunnel 不只能转发 Web，SSH 和远程桌面照样穿。

### 方式一：cloudflared access 命令（推荐）

服务端 config.yml 加一条：

```yaml
  - hostname: ssh.ldwl.dpdns.org
    service: ssh://localhost:22
```

客户端本机也装一个 cloudflared，然后在 `~/.ssh/config` 里加：

```
Host home-lab
    HostName ssh.ldwl.dpdns.org
    ProxyCommand cloudflared access ssh --hostname %h
    User root
```

之后直接 `ssh home-lab` 就连上了，流量全程加密走 CF 隧道，22 端口不用对公网开。

### 方式二：浏览器直接 SSH / RDP

Zero Trust 控制台里把 `ssh.ldwl.dpdns.org` 的类型选为 SSH，浏览器打开这个域名，CF 会给你一个网页终端直接连；RDP 同理，浏览器里直接出远程桌面窗口。出差没带电脑时特别有用。

## 九、和 frp、端口映射怎么选

![三种内网穿透方案对比](/tutorial/cftunnel/cftunnel-vs-frp.svg)

简单总结：

- **有公网 IP + 只想自己用**：端口映射最简单，但记得套一层 CF 代理隐藏 IP。
- **有云服务器 + 需要转 TCP/UDP 任意协议**：frp 更灵活，游戏服务器、数据库转发它更在行。
- **没公网 IP + 以 Web/SSH/RDP 为主 + 想零成本**：Cloudflare Tunnel 是目前最优解，没有之一。

## 十、踩坑清单

实际部署中容易碰到的几个问题：

1. **`cloudflared tunnel run` 报错 `config.yml` 找不到**
   默认读取 `~/.cloudflared/config.yml`。用 `--config /path/to/config.yml` 显式指定，或确认工作目录。

2. **ingress 最后一条没写兜底 404**
   报错 `Invalid ingress rules`。补上 `- service: http_status:404` 放最后。

3. **域名访问 1033 错误**
   DNS 的 CNAME 没生效或隧道没跑起来。检查 `cloudflared tunnel route dns` 是否执行过、`systemctl status cloudflared` 是否 running。

4. **国内连 CF 隧道慢/不稳**
   CF 免费版国内回源节点看运气。缓解办法：给域名开「小黄云」代理、服务端开启 `warp-routing`，或考虑用自己的域名解析到优选 IP。

5. **WebSocket 断连**
   config.yml 对应 service 加上 `originRequest: { disableChunkedEncoding: true, connectTimeout: 30s }` 试试。

6. **多台机器跑同一个隧道**
   没问题，这是官方支持的负载均衡姿势。每台机器用同一个 Token 启动，CF 自动在多机间分流。

## 十一、写在最后

内网穿透这个需求存在了很多年，方案也从花生壳、ngrok、frp 一路演进。Cloudflare Tunnel 的杀手锏不是某个单点功能，而是**把「没有公网 IP」这个前提直接干掉了**——出站连接天然过 NAT，加上 CF 免费送的 HTTPS、WAF 和全球 CDN，个人玩家几乎找不到拒绝的理由。

如果你家里也有几样想在外面访问的服务，花十分钟按本篇走一遍 Named Tunnel 流程，体验一下「装好就再也没管过」的省心感。

> 相关阅读：[V免签 Cloudflare Workers 版安装教程](/posts/vmq-cf-worker/) —— 同样跑在 CF 免费额度里的免签收款方案，和本文的发卡站场景是绝配。}

## 二、工作原理：为什么不用开端口

一张图讲清整条链路：

```
外网用户 → CF 边缘节点(HTTPS/WAF) ←加密隧道→ cloudflared(内网) → localhost:端口
                ↑                                        ↑
          你的域名 CNAME 指过来            主动向外发起 4 条长连接
```

关键在于方向：**cloudflared 是从内网向 CF 发起出站连接**（通常 4 条到不同边缘节点的长连接），CF 把用户请求顺着这条已有连接送回内网。因为连接是内网主动建立的，路由器不需要任何端口映射，NAT 穿透天然成立——和你平时刷网页没有任何区别。

这也意味着：

1. **真实 IP 永不暴露**：外面只能看到 CF 的 IP，攻击者摸不到你家宽带地址。
2. **断线自动重连**：长连接断了 cloudflared 会自动重连，无需人工干预。
3. **TLS 全程加密**：用户到 CF 是 HTTPS，CF 到 cloudflared 也是加密隧道。

## 三、准备条件

开始前确认你有这三样：

1. **一个托管在 Cloudflare 的域名**（免费版即可）。没有的话，先在 CF 注册一个或把现有域名 NS 改到 CF——这一步是前提，因为隧道路由依赖 CF 的 DNS。
2. **一台内网机器**：Linux / Windows / macOS / Docker 均可，能跑常驻进程。树莓派、NAS、旧笔记本都行。
3. **这台机器上跑着至少一个服务**：比如 `http://localhost:8080`。

## 四、30 秒极速试用：Quick Tunnel

不想配域名，先看看效果？Cloudflare 提供了 **Quick Tunnel**，一条命令拿一个临时公网地址：

```bash
cloudflared tunnel --url http://localhost:8080
```

输出里会出现一行：

```
Your quick Tunnel has been created! Visit it at:
  https://random-words-xxxx.trycloudflare.com
```

浏览器打开这个 `trycloudflare.com` 地址，就能从外网访问你内网的 8080 端口了。不用注册、不用域名、不用配置。

{% note warning %}
**Quick Tunnel 的限制**：域名随机分配且每次重启都会变，不能自定义，也无法挂 Access 策略。适合调试和演示，**不要用于生产**——下一节才是正餐。
{% endnote %}

## 五、生产级部署：Named Tunnel 五步走

Quick Tunnel 图个新鲜，真正长期用必须上 **Named Tunnel**：域名固定、可挂多条路由、可配 Access 策略。以下以 Linux（Debian/Ubuntu）为例，完整命令流如下：

![cloudflared 命令行安装与配置流程](/tutorial/cftunnel/cftunnel-cli.svg)

### 第 1 步：安装 cloudflared

```bash
# Debian / Ubuntu
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared-linux-amd64.deb

# CentOS / RHEL
rpm -i https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm

# macOS
brew install cloudflared

# Windows（管理员 PowerShell）
winget install --id Cloudflare.cloudflared
```

装完验证一下：

```bash
cloudflared --version
```

### 第 2 步：登录授权

```bash
cloudflared tunnel login
```

终端会打印一个 `https://dash.cloudflare.com/argotunnel?callback=...` 链接并自动打开浏览器（无图形界面则手动复制到本机浏览器打开）。在浏览器里选择你要用的域名，点授权。成功后终端提示：

```
You have successfully logged in.
cert.pem saved to /root/.cloudflared/cert.pem
```

这个 `cert.pem` 是后续创建隧道的凭证，别删。

### 第 3 步：创建隧道

```bash
cloudflared tunnel create home-lab
```

输出示例：

```
Created tunnel home-lab with id a1b2c3d4-e5f6-7890-abcd-ef1234567890
Tunnel credentials written to /root/.cloudflared/a1b2c3d4-e5f6-7890-abcd-ef1234567890.json
```

记住这个 **Tunnel ID**，配置文件里要用。`<Tunnel ID>.json` 是隧道的身份凭证，和 `cert.pem` 一样重要。

### 第 4 步：写配置文件

在 `/root/.cloudflared/` 下创建 `config.yml`：

```yaml
tunnel: a1b2c3d4-e5f6-7890-abcd-ef1234567890
credentials-file: /root/.cloudflared/a1b2c3d4-e5f6-7890-abcd-ef1234567890.json

ingress:
  # NAS 管理面板
  - hostname: nas.ldwl.dpdns.org
    service: http://localhost:5000
  # 发卡站后台
  - hostname: shop.ldwl.dpdns.org
    service: http://localhost:8080
  # 兜底规则（必须放最后）
  - service: http_status:404
```

{% note info %}
**ingress 规则要点**：按从上到下顺序匹配 `hostname`，命中即转发到对应 `service`；最后一条必须是**没有 hostname 的兜底规则**（通常返回 404），否则启动报错。一条隧道可以挂任意多条路由，把内网所有服务一网打尽。
{% endnote %}

### 第 5 步：绑定 DNS 并启动

```bash
# 为每条路由创建 CNAME（只需执行一次）
cloudflared tunnel route dns home-lab nas.ldwl.dpdns.org
cloudflared tunnel route dns home-lab shop.ldwl.dpdns.org

# 启动隧道
cloudflared tunnel run home-lab
```

`route dns` 会在 CF DNS 里自动创建一条 CNAME 记录：`nas.ldwl.dpdns.org → a1b2c3d4-e5f6-7890-abcd-ef1234567890.cfargotunnel.com`，无需手动去 DNS 面板添加。

看到下面这行就说明通了：

```
INF Connection registered connIndex=0 location=hkg
```

现在用手机流量访问 `https://nas.ldwl.dpdns.org`，你家的 NAS 面板就出来了——全链路 HTTPS，证书 CF 自动搞定。

### 设为开机自启（systemd）

手动跑 `tunnel run` 终端关了就断，生产环境必须注册为系统服务：

```bash
cloudflared service install
systemctl enable cloudflared
systemctl start cloudflared
systemctl status cloudflared   # 确认 active (running)
```

{% note warning %}
**注意**：`service install` 会读取当前用户 `~/.cloudflared/config.yml` 并复制到 `/etc/cloudflared/config.yml` 作为服务配置。之后改配置要改 `/etc/cloudflared/config.yml`，改完 `systemctl restart cloudflared` 生效。
{% endnote %}

Windows 下对应的命令是（管理员 PowerShell）：

```powershell
cloudflared service install
```

会注册为 Windows 服务 `Cloudflared`，开机自启。

## 六、Zero Trust 控制台可视化管理

命令行创建的隧道，在 Cloudflare Zero Trust 控制台（`one.dash.cloudflare.com`）里全能看到和管理：隧道健康状态、连接数、所在节点，以及每条 Public Hostname 路由。

![Cloudflare Zero Trust 控制台 - Tunnels 管理界面](/tutorial/cftunnel/cftunnel-dash.svg)

控制台里能做的事：

- **看健康状态**：`HEALTHY` 表示 4 条连接全在；`DOWN` 说明 cloudflared 进程挂了或机器断电。
- **增删路由**：不用敲命令，在 Public Hostname 页面点 Add，填子域名 + 服务地址即可。
- **装新机器**：点进隧道 → Install connector，会给你一条带 token 的安装命令，新机器粘贴执行就加入这条隧道（多机负载均衡）。
- **配 Access 策略**：给敏感后台加一层邮箱 OTP 验证，只有你能登录（免费版 50 用户内免费）。

## 七、Docker 部署：容器党最爱

如果你的服务全跑在 Docker 里，cloudflared 也可以容器化，和业务编排在一起：

```yaml
version: "3.8"
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel run
    environment:
      - TUNNEL_TOKEN=eyJhIjo...   # 从控制台 Install connector 处复制
    networks:
      - internal

  dujiao:
    image: dujiao/dujiao-next:latest
    restart: unless-stopped
    networks:
      - internal

networks:
  internal:
```

{% note info %}
**Token 模式 vs 配置文件模式**：用 `TUNNEL_TOKEN` 环境变量时，路由规则在 Zero Trust 控制台的 Public Hostname 页面配置（`service` 填 `http://dujiao:8080`，用 Docker 服务名代替 localhost），本地不需要 config.yml。两种模式任选其一，Token 模式更适合纯 Docker 场景。
{% endnote %}

## 八、不止 HTTP：SSH / RDP 也能穿

Cloudflare Tunnel 不只能转发 Web，SSH 和远程桌面照样穿。

### 方式一：cloudflared access 命令（推荐）

服务端 config.yml 加一条：

```yaml
  - hostname: ssh.ldwl.dpdns.org
    service: ssh://localhost:22
```

客户端本机也装一个 cloudflared，然后在 `~/.ssh/config` 里加：

```
Host home-lab
    HostName ssh.ldwl.dpdns.org
    ProxyCommand cloudflared access ssh --hostname %h
    User root
```

之后直接 `ssh home-lab` 就连上了，流量全程加密走 CF 隧道，22 端口不用对公网开。

### 方式二：浏览器直接 SSH / RDP

Zero Trust 控制台里把 `ssh.ldwl.dpdns.org` 的类型选为 SSH，浏览器打开这个域名，CF 会给你一个网页终端直接连；RDP 同理，浏览器里直接出远程桌面窗口。出差没带电脑时特别有用。

## 九、和 frp、端口映射怎么选

![三种内网穿透方案对比](/tutorial/cftunnel/cftunnel-vs-frp.svg)

简单总结：

- **有公网 IP + 只想自己用**：端口映射最简单，但记得套一层 CF 代理隐藏 IP。
- **有云服务器 + 需要转 TCP/UDP 任意协议**：frp 更灵活，游戏服务器、数据库转发它更在行。
- **没公网 IP + 以 Web/SSH/RDP 为主 + 想零成本**：Cloudflare Tunnel 是目前最优解，没有之一。

## 十、踩坑清单

实际部署中容易碰到的几个问题：

1. **`cloudflared tunnel run` 报错 `config.yml` 找不到**
   默认读取 `~/.cloudflared/config.yml`。用 `--config /path/to/config.yml` 显式指定，或确认工作目录。

2. **ingress 最后一条没写兜底 404**
   报错 `Invalid ingress rules`。补上 `- service: http_status:404` 放最后。

3. **域名访问 1033 错误**
   DNS 的 CNAME 没生效或隧道没跑起来。检查 `cloudflared tunnel route dns` 是否执行过、`systemctl status cloudflared` 是否 running。

4. **国内连 CF 隧道慢/不稳**
   CF 免费版国内回源节点看运气。缓解办法：给域名开「小黄云」代理、服务端开启 `warp-routing`，或考虑用自己的域名解析到优选 IP。

5. **WebSocket 断连**
   config.yml 对应 service 加上 `originRequest: { disableChunkedEncoding: true, connectTimeout: 30s }` 试试。

6. **多台机器跑同一个隧道**
   没问题，这是官方支持的负载均衡姿势。每台机器用同一个 Token 启动，CF 自动在多机间分流。

## 十一、写在最后

内网穿透这个需求存在了很多年，方案也从花生壳、ngrok、frp 一路演进。Cloudflare Tunnel 的杀手锏不是某个单点功能，而是**把「没有公网 IP」这个前提直接干掉了**——出站连接天然过 NAT，加上 CF 免费送的 HTTPS、WAF 和全球 CDN，个人玩家几乎找不到拒绝的理由。

如果你家里也有几样想在外面访问的服务，花十分钟按本篇走一遍 Named Tunnel 流程，体验一下「装好就再也没管过」的省心感。

> 相关阅读：[V免签 Cloudflare Workers 版安装教程](/posts/vmq-cf-worker/) —— 同样跑在 CF 免费额度里的免签收款方案，和本文的发卡站场景是绝配。