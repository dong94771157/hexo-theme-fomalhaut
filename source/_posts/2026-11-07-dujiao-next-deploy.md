---
title: 独角数卡 Next（Dujiao-Next）最新版部署教程：Docker Compose 十分钟搭建自动发卡站
categories:
  - 教程发布
tags:
  - 独角数卡
  - Dujiao-Next
  - Docker
  - 自动发卡
  - 开源项目
cover: /tutorial/dujiao/dujiao-arch.svg
description: >-
  老牌自动发卡系统独角数卡已于 2026 年 10 月归档停更，官方社区转向全新重写的 Dujiao-Next：Go + Gin 后端、Vue 3
  前端、单二进制交付，一个端口同时跑前台与后台。本篇基于最新 v1.5.2，用 Docker Compose（SQLite + Redis）从零部署到
  Nginx 上线，附配置详解、安全加固清单与升级姿势。
comments: true
abbrlink: 9ed1d17c
date: 2026-11-07 10:00:00
updated: 2026-11-07 10:00:00
---

# 独角数卡 Next（Dujiao-Next）最新版部署教程：Docker Compose 十分钟搭建自动发卡站

> 卖卡密、卖会员、卖激活码，最怕的就是「人在睡觉钱来了货没发」。自动发卡系统就是解决这件事的——买家付款后系统秒发卡密，7×24 无人值守。老牌开源项目「独角数卡」陪伴了无数站长，但原版已于 2026 年 2 月停止更新、10 月正式归档；官方社区如今指向全新重写的 **Dujiao-Next**。本篇基于最新版 v1.5.2，用 Docker Compose 从零搭一套生产可用的发卡站。

![独角数卡 Next Docker Compose 部署架构](/tutorial/dujiao/dujiao-arch.svg)

## 一、从独角数卡到 Dujiao-Next：发生了什么

先交代背景，免得新朋友踩坑：

- **原版独角数卡**（`assimon/dujiaoka`）：基于 PHP + Laravel 的经典自动发卡系统，2026-02-12 停止维护，2026-10-22 仓库归档，不再接受 Issue 和 PR。
- **Dujiao-Next**（`dujiao-next/dujiao-next`）：由原社区维护者发起的全新重写版本，**不是**在老代码上修修补补，而是换了一套现代化技术栈从零做起，官方站点 [dujiao-next.com](https://dujiao-next.com/)。

{% note info %}
**为什么值得换？** 原版是 PHP + Laravel，部署要装 Nginx + PHP-FPM + Composer 一整套；Dujiao-Next 用 Go 重写后端，从 v1.4.0 起**前端界面通过 go:embed 直接内嵌进后端二进制**——一个进程、一个端口（8080）、一个域名，前台在 `/`，后台在可配置路径，部署复杂度断崖式下降。
{% endnote %}

### 技术栈速览

| 层 | 技术 |
| --- | --- |
| 后端 | Go 1.26 + Gin + GORM |
| 前端 | Vue 3 + Vite + TypeScript + Tailwind CSS v4 |
| 鉴权 | JWT 双域（管理端/用户端分离）+ Casbin RBAC |
| 异步任务 | asynq（基于 Redis） |
| 数据库 | SQLite（默认，开箱即用）/ PostgreSQL（生产推荐） |
| 交付形式 | 单二进制（内嵌前端）/ Docker 镜像 `dujiaonext/dujiao-next` |

截止本文发布，最新稳定版为 **v1.5.2**（2026-11-02 发布）。想先体验再决定，可以逛官方 Demo：前台 [demo.dujiao-next.com](https://demo.dujiao-next.com/)，后台 [demo.dujiao-next.com/admin/](https://demo.dujiao-next.com/admin/)（账号 `test` / `Test123456`）。

## 二、部署架构：为什么只需要一个端口

理解这张架构图，后面的配置就不会迷路：

- **买家**通过域名访问 → **Nginx**（80/443，负责 TLS 证书）→ 反代到 `127.0.0.1:8080`
- **Dujiao-Next** 单容器监听 8080，同时托管前台 SPA（`/`）和后台 SPA（`web.admin_path` 配置的路径）
- 后端通过 GORM 读写 **SQLite/PostgreSQL**，通过 asynq 把发卡、邮件等任务丢进 **Redis** 异步处理
- 支付渠道（支付宝/微信/易支付/USDT 等）由后端统一对接，异步回调验签发货

关键设计：**Redis 和数据库容器一律不对外导出端口**，应用端口也只绑定在 `127.0.0.1`，所有外部流量必须经过 Nginx 统一入口。这是官方推荐的安全基线。

## 三、环境准备

### 3.1 服务器要求

| 项目 | 最低 | 推荐 |
| --- | --- | --- |
| 系统 | Linux x86_64（Ubuntu 22.04+ / Debian 12+ / CentOS Stream 9+） | Ubuntu 24.04 LTS |
| CPU / 内存 | 1 核 / 1GB | 2 核 / 2GB |
| 磁盘 | 10GB | 20GB+ SSD |
| 软件 | Docker 24+（含 compose 插件） | 同左 |
| 域名 | 可选 | 建议（用于 HTTPS） |

SQLite 方案 1 核 1G 的小鸡完全跑得动；日订单过千再考虑换 PostgreSQL。

### 3.2 安装 Docker

以官方一键脚本为例（Ubuntu/Debian 通用）：

```bash
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker

# 验证
docker --version
docker compose version
```

输出 `Docker version 24.x+` 和 `Docker Compose version v2.x+` 即可继续。

## 四、Docker Compose 部署（SQLite + Redis）

这是官方推荐的入门方案：两个容器搞定，适合中小站点。整体流程六步走：

![Dujiao-Next Docker Compose 部署六步走](/tutorial/dujiao/dujiao-flow.svg)

### 4.1 下载部署文件

```bash
git clone https://github.com/dujiao-next/dujiao-next.git
cd dujiao-next/docker
```

`docker/` 目录下有三个关键文件：

| 文件 | 作用 |
| --- | --- |
| `docker-compose.yml` | 容器编排（应用 + Redis） |
| `.env` | 环境变量，主要管镜像版本 `TAG` |
| `config/config.yml` | 应用配置（密钥、数据库、后台路径等） |

### 4.2 生成密钥并修改配置

这是**整个部署中最重要的一步**，直接决定你的站会不会被人一秒接管。

**① 生成三个互不相同的密钥：**

```bash
openssl rand -hex 32   # 复制输出，作为 app.secret_key
openssl rand -hex 32   # 复制输出，作为 jwt.secret
openssl rand -hex 32   # 复制输出，作为 user_jwt.secret
```

**② 编辑 `config/config.yml`，至少改这几处：**

```yaml
app:
  secret_key: "刚才生成的第 1 个值"      # 必改

jwt:
  secret: "刚才生成的第 2 个值"          # 必改

user_jwt:
  secret: "刚才生成的第 3 个值"          # 必改

web:
  admin_path: "/manager"                # 必改！别用默认 /admin

bootstrap:
  default_admin_password: ""            # 留空 = 启动时随机生成并打印一次

server:
  trusted_proxies: ["127.0.0.1"]        # Docker 部署填 Nginx 所在网段
```

{% note danger %}
**三件事别偷懒：**
1. 三个 secret **必须各不相同**——它们分别保护会话、管理端 JWT、用户端 JWT，复用等于一把钥匙开三把锁；
2. `web.admin_path` **务必改掉默认的 `/admin`**——全网的扫描器都在扫这个路径；
3. `default_admin_password` 留空即可，v1.5.1 起首次启动会**随机生成管理员密码并在日志里打印一次**，比硬编码弱密码安全得多。记住：密码只在日志出现一次，抄下来存好。
{% endnote %}

**③ 确认 `.env` 中的版本号：**

```bash
TAG=v1.5.2
```

### 4.3 启动容器

```bash
docker compose up -d
```

首次启动会拉取镜像 `dujiaonext/dujiao-next:v1.5.2`，并自动建表、初始化数据。看日志：

```bash
docker compose logs -f dujiao-next
```

{% note info %}
**启动成功的标志**：日志中出现类似 `Embedded SPAs: admin (/manager), user (/)` 的字样，说明内嵌的前后台 SPA 已挂载成功。同时留意日志开头打印的随机管理员密码，格式类似 `bootstrap admin password: xxxxxxxx`。
{% endnote %}

### 4.4 验证服务

```bash
# 健康检查接口
curl http://127.0.0.1:8080/health

# 浏览器访问
# 前台：http://127.0.0.1:8080/
# 后台：http://127.0.0.1:8080/manager（你改的 admin_path）
```

健康检查返回正常状态、前台能打开商品页、后台能用随机密码登录——本地部署就完成了。

## 五、界面预览

部署完成后，你会得到一个这样的前台商店（示意）：

![Dujiao-Next 前台商店界面示意](/tutorial/dujiao/dujiao-store.svg)

前台是标准的现代电商布局：顶部导航 + Hero 横幅 + 分类筛选 + 商品卡片网格。买家选商品 → 填邮箱 → 扫码付款 → 订单页直接显示卡密，同时发一份到邮箱。支持优惠券、订单自助查询，无需注册也能购买。

后台长这样（示意）：

![Dujiao-Next 管理后台界面示意](/tutorial/dujiao/dujiao-admin.svg)

左侧是功能菜单：仪表盘、商品管理、订单管理、卡密仓库、支付配置、优惠券、用户与权限（Casbin RBAC，可给客服开只看订单的权限）、系统设置。仪表盘首屏就是今日营收、订单量、待处理数，最近订单表一目了然。

{% note info %}
**配图说明**：本文界面图为基于官方 Demo 布局重绘的示意图，用于展示功能区域划分；实际样式以你部署的版本为准，建议部署后自行截图替换。
{% endnote %}

## 六、Nginx 反向代理与 HTTPS

本地跑通后，用 Nginx 把它挂到域名上。得益于单端口设计，反代配置极简——**一条 `location` 就够**：

```nginx
server {
    listen 443 ssl http2;
    server_name shop.example.com;

    ssl_certificate     /etc/letsencrypt/live/shop.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/shop.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name shop.example.com;
    return 301 https://$host$request_uri;
}
```

用 certbot 签发证书：

```bash
sudo certbot --nginx -d shop.example.com
```

{% note warning %}
**别忘了 `trusted_proxies`**：走 Nginx 反代后，应用看到的来源 IP 全是 127.0.0.1。把 `config.yml` 里的 `server.trusted_proxies` 设为 Nginx 所在地址（本机部署填 `["127.0.0.1"]`，Docker 网桥部署则填容器网段如 `["172.16.0.0/12"]`），否则订单里的买家 IP、风控统计全是错的。改完 `docker compose restart` 生效。
{% endnote %}

## 七、生产进阶：换 PostgreSQL

SQLite 单文件、零运维，日订单几百完全够用。但如果你预期并发较高、或者需要多实例水平扩展，建议上 PostgreSQL。官方 compose 提供了三容器方案（应用 + PostgreSQL + Redis）：

```bash
# 仓库 docker/ 目录下通常提供 docker-compose.postgres.yml
docker compose -f docker-compose.postgres.yml up -d
```

切换时在 `config/config.yml` 里把数据库段从 sqlite 改为 postgres，填上容器内的连接信息：

```yaml
database:
  driver: postgres
  host: postgres        # compose 服务名
  port: 5432
  username: dujiao
  password: "强密码"
  dbname: dujiao_next
```

{% note warning %}
**SQLite → PostgreSQL 不支持自动迁移数据**。新站直接选 PostgreSQL 最省事；老站已有 SQLite 数据要搬迁，请用官方文档提供的导出/导入工具，别手搓 SQL。
{% endnote %}

## 八、上线前安全清单

逐条对照打勾，再对外开站：

- [ ] 三个 secret（`app.secret_key` / `jwt.secret` / `user_jwt.secret`）已用 `openssl rand -hex 32` 生成，**互不相同**
- [ ] `web.admin_path` 已改为非 `/admin` 的隐蔽路径
- [ ] 管理员密码为首次启动随机生成，且已修改为自己保存的强密码
- [ ] `docker-compose.yml` 中应用端口绑定 `127.0.0.1:8080`，Redis / PostgreSQL **无端口导出**
- [ ] 已配置 Nginx + HTTPS，80 端口强制跳转 443
- [ ] `server.trusted_proxies` 已正确设置，订单能记录真实买家 IP
- [ ] 服务器防火墙仅放行 22 / 80 / 443
- [ ] 定期备份 `data/` 目录（SQLite 文件 + 上传附件）与 `config/config.yml`

{% note danger %}
**备份比你想的重要**：SQLite 方案下整个数据库就是一个文件，`data/` 目录打包带走就是完整快照。建议 crontab 每日打包一次到异地（对象存储/另一台机器），发卡站的订单和卡密就是你的资产本身。
{% endnote %}

## 九、版本升级

Dujiao-Next 迭代很快，升级姿势极其简单——数据在卷里，升级只换镜像：

```bash
cd dujiao-next/docker

# 1. 改 .env 里的版本号
sed -i 's/TAG=v1.5.2/TAG=v1.5.3/' .env   # 以新版本号为准

# 2. 拉新镜像并重启
docker compose pull
docker compose up -d

# 3. 看日志确认
docker compose logs -f dujiao-next
```

启动时会自动执行数据库迁移（如有），全程秒级完成。升级前**备份 `data/` 目录**是好习惯，方便随时回滚 `TAG`。

## 十、常见问题

**Q1：日志里没看到随机管理员密码，怎么办？**
密码只在**首次启动**（数据库为空时）打印一次。如果你不小心清了屏幕，最简单的办法是停掉容器、删掉 `data/` 下的数据库文件重新初始化（新站无数据时可行）；已有数据的老站请走后台的密码重置流程或官方文档的 CLI 重置命令。

**Q2：访问后台 404？**
检查你访问的路径是否与 `config/config.yml` 里 `web.admin_path` 完全一致（含前导斜杠）。改过配置后必须 `docker compose restart` 才生效。

**Q3：支付回调一直收不到？**
三步排查：① Nginx 的 `location /` 是否覆盖了支付渠道回调路径（单端口设计下无需额外配置）；② `trusted_proxies` 是否正确，导致验签时取到错误 IP 一般不影响回调，但签名校验失败要检查支付网关里填的密钥/商户号；③ 云服务商安全组是否放行了 443。

**Q4：SQLite 够用吗？什么时候必须换 PostgreSQL？**
日订单几百以内、单机部署，SQLite 毫无压力。出现以下信号再换：并发写入频繁报 `database is locked`、需要多实例负载均衡、需要更细粒度的备份恢复策略。

**Q5：能从老版独角数卡（dujiaoka）迁移过来吗？**
Dujiao-Next 提供了从 dujiaoka 的数据迁移工具，具体以官方文档 [dujiao-next.com](https://dujiao-next.com/) 的迁移章节为准。建议先在测试环境跑一遍迁移，核对订单与卡密数量无误后再切流量。

## 十一、写在最后

从 PHP + Laravel 的「全家桶」到 Go 单二进制的「一个文件」，Dujiao-Next 把自动发卡站的部署门槛拉到了历史最低：两三个容器、一条 Nginx 反代、十来分钟，一个能 7×24 自动卖货的站就跑起来了。原版独角数卡归档不是结束，而是把接力棒交给了更现代的下一代。

如果你正在用老版独角数卡，建议抽空迁过来——停更项目的安全风险只会随时间累积；如果你是第一次搭发卡站，那直接从 Dujiao-Next 开始就对了。

> 项目地址：[github.com/dujiao-next/dujiao-next](https://github.com/dujiao-next/dujiao-next) · 官网文档：[dujiao-next.com](https://dujiao-next.com/) · 官方 Demo：[demo.dujiao-next.com](https://demo.dujiao-next.com/)

部署遇到问题欢迎留言，看到都会回。