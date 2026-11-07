---
title: V免签 Cloudflare Workers 版安装教程：零服务器实现个人免签收款
categories:
  - 教程发布
tags:
  - V免签
  - Cloudflare
  - Workers
  - D1
  - 免签支付
cover: /tutorial/vmq/vmq-arch.svg
description: >-
  想在自己的站点收几块钱，又不想接支付宝/微信商户资质？V免签 Cloudflare Workers 版用「监听手机收款通知」代替支付回调，全部跑在
  Cloudflare 免费额度内：Workers 10 万请求/天 + D1
  5GB，零服务器零成本。本篇从克隆代码到收到第一笔测试款，每一步都带验证命令与踩坑提示。
comments: true
abbrlink: 29b62231
date: 2026-11-06 10:00:00
updated: 2026-11-06 10:00:00
---

# V免签 Cloudflare Workers 版安装教程：零服务器实现个人免签收款

> 很多个人站长的痛点很一致：想在自己的站点上收几块钱，但不想（也办不下来）支付宝/微信的商户资质。V免签的思路是「监听手机收款通知」来代替支付回调，把钱到账这件事自动化。而这个 Cloudflare Workers 版更进一步——连服务器都不用买，全部跑在 CF 免费额度内。本篇把从零安装到收到第一笔测试款的完整流程整理成可复制的操作手册。

![V免签 Cloudflare Workers 收款架构](/tutorial/vmq/vmq-arch.svg)

## 一、它解决什么问题？

整条链路的工作原理一句话讲清：

```
用户扫码付款 → 手机收到收款通知 → 监控端 App 监听到 → POST /appPush
                                                          ↓
                    按金额匹配订单 → 标记已支付 → 回调你的商户系统 → 发货
```

没有支付回调，靠监控端 App 监听收款通知确认到账——这就是「免签」二字的含义。

## 二、和 V免签、易支付是什么关系？

这个项目**不是「V免签 + 易支付」两套东西拼在一起**，而是 **V免签的一个 TypeScript / Workers 重写**，天生同时具备两个身份：

| 身份 | 说明 |
|---|---|
| 对外 | 易支付协议的兼容网关：商户用标准参数下单、MD5 验签、统一格式回调，接过易支付的商城改个地址就能用 |
| 对内 | 个人收款码 + 手机监听的免签收单机：没有支付回调，靠监控端 App 确认到账 |

{% note info %}
**关键澄清**：本项目没有对接任何第三方易支付网关，全仓唯一的出站请求是回调你自己的 `notify_url`。
{% endnote %}

## 三、前置准备

动手前确认以下环境，任一项不满足先补齐：

| 依赖 | 版本要求 | 安装/检查命令 |
|---|---|---|
| Node.js | 22.15+ | `node -v` |
| pnpm | 9+ | `corepack enable`（仓库已锁定版本） |
| Wrangler CLI | 最新可用 | `npm i -g wrangler` |
| Cloudflare 账号 | 免费即可 | `wrangler login` 登录 |
| 监控端 App | Android 7.0+ | 推荐 [V免签配套监控安卓端](https://github.com/im-webb/vmq-monitor-android) |

登录 Wrangler 后先用 `wrangler whoami` 确认当前账号，多账号环境最容易在这里翻车。

## 四、安装部署：8 步上线

### 1. 拉代码 + 装依赖

```bash
git clone https://github.com/im-webb/vmq-cf-worker.git
cd vmq-cf-worker
pnpm install
```

### 2. 创建 D1 数据库

```bash
wrangler d1 create vmq
```

输出里会有 `database_id = "xxxx-xxxx-..."`，**复制下来**，下一步要用。

### 3. 填配置

```bash
cp wrangler.example.jsonc wrangler.local.jsonc
```

把 `wrangler.local.jsonc` 里的 `<your-database-id>` 换成上一步的 id。

{% note warning %}
**踩坑提示**：`wrangler.local.jsonc` 已在 `.gitignore` 里，不会被提交——真实域名、D1 ID、密钥、收款码**只能**写进这类已忽略文件，绝不进入任何会被提交的内容。改完用 `git status` 确认看不到这个文件。
{% endnote %}

多个环境（本地开发一个库、测试环境又一个库）时，不用来回改文件，用环境变量指定即可：

```bash
WRANGLER_CONFIG=wrangler.local.test.jsonc pnpm run deploy
```

### 4. 建表

```bash
pnpm db:remote        # 建表（schema.sql）
```

{% note danger %}
**必须带 `--remote`**（脚本里已经带了）。不带的话只初始化本地模拟库，线上仍然是空的。此命令只跑 `CREATE ... IF NOT EXISTS`，不会删数据。
{% endnote %}

建完验证一下表是否建好：

```bash
pnpm exec wrangler d1 execute vmq --remote -c "$(node scripts/cfg.mjs)" \
  --command "SELECT name FROM sqlite_master WHERE type='table'"
```

结果里必须有 `passages`、`orders`、`admins` 三张表。

### 5. 部署

```bash
pnpm run deploy
```

{% note warning %}
**必须写 `pnpm run deploy`**：`pnpm deploy` 是 pnpm 自己的命令（用于 workspace 部署），会报 `ERR_PNPM_NOTHING_TO_DEPLOY`，不会执行本项目的脚本。
{% endnote %}

它会先构建后台 SPA（`apps/admin`）与前台站点（`apps/web`），产物落到 `public/`，再随 Worker 一起上传。完成后会给你一个 `https://vmq.<你的子域>.workers.dev` 地址。

部署完做一次健康检查：

```bash
curl -s -o /dev/null -w '%{http_code}' https://你的地址/api/health
# 期望输出 200
```

### 6. 初始化（关键一步）

打开 `https://你的地址/setup`，填写：

| 项 | 说明 |
|---|---|
| 管理员账号 / 密码 | 至少 8 位，**没有默认密码** |
| 后台入口别名 | 后台会挂在 `/<别名>`，建议别用 `admin` |
| 站点名称 | 显示在支付页上 |

提交后直接跳到登录页 `/<别名>/login`，用刚设置的账号登录即可。通讯密钥在安装时自动生成（32 位十六进制），之后可以在后台「系统配置 → 密钥管理」查看。初始化完成后 `/setup` 自动关闭（再次访问返回 404）。

{% note warning %}
**防抢注（可选但强烈建议）**：部署完到点开 `/setup` 之间，任何人先访问就能占走管理员。想堵住这个窗口，先设一个初始化令牌：

```bash
npx wrangler secret put SETUP_TOKEN        # 随便一串只有你知道的值
```

之后必须用 `/setup?token=<令牌>` 打开。初始化完成后可以删掉：`npx wrangler secret delete SETUP_TOKEN`。
{% endnote %}

### 7. 后台配置

登录 `/<别名>/login` 后依次完成：

1. **通道管理** → 新增通道（微信 / 支付宝 / QQ / 数字人民币），填收款码
2. **系统配置 → 站点信息** → 站点地址、站点名称等（站点地址在 `/setup` 时已自动写成当前域名，可改）
3. **系统配置 → 密钥管理** → 通讯密钥就在这里；商户下单签名和监控端签名共用同一把

### 8. 绑定监控端

用 [V免签配套监控安卓端](https://github.com/im-webb/vmq-monitor-android) 扫描后台「通道管理」列表里的「APP扫码配置」二维码，或在 App 里手动填写：

```
https://your-domain.com/通讯密钥/通道id,支付类型
例：https://pay.example.com/3f9a…/8,1
```

域名取「系统配置 → 站点信息」的站点地址，没配则用你访问后台时所用的域名。

## 五、界面预览

**前台 · 站点首页**：顶部导航 + 主标题 + 四步支付流程卡片，下方是三步接入指引。

![前台首页：顶部导航、主标题与四步支付流程卡片](/tutorial/vmq/site-home.jpg)

**后台 · 概览**：左侧功能导航（概览 / 订单管理 / 通道管理 / 操作日志 / 管理员 / 系统配置），顶部监控端心跳状态徽标（绿=在线、黄=心跳中断未超 10 分钟、红=离线），下方是收入与订单统计。

![后台概览：左侧功能导航、监控端状态徽标、收入与订单统计](/tutorial/vmq/admin-overview.jpg)

## 六、对接商户系统

### 创建订单（你的站点 → 本站）

```
POST /api/order/create
```

{% note info %}
旧版 PHP 站的 `/submit.php`（以及 `/submit`）仍然可用，已经写死旧地址的商户代码不用改。新接入请用 `/api/order/create`。
{% endnote %}

| 参数 | 必填 | 说明 |
|---|---|---|
| `pid` | ✅ | 商户 ID，见后台「系统配置 → 密钥管理」，安装时自动生成 |
| `type` | ✅ | `wxpay` / `alipay` / `qqpay` / `rmb`（也接受 1/2/3/4） |
| `out_trade_no` | ✅ | 你的订单号，必须唯一 |
| `name` | ✅ | 商品名 |
| `money` | ✅ | 金额，两位小数 |
| `notify_url` | ✅ | 异步回调地址，**必须是域名，不能用裸 IP** |
| `return_url` |  | 支付完成后浏览器跳转地址 |
| `sign` | ✅ | 见下方签名规则 |
| `sign_type` |  | 固定 `MD5` |

**签名规则**：把所有非空参数按**参数名 ASCII 升序**拼成 `k1=v1&k2=v2`，末尾直接接通讯密钥，取 MD5：

```
sign = md5("money=1.00&name=月卡&notify_url=...&out_trade_no=...&pid=1001&return_url=...&type=wxpay" + 通讯密钥)
```

`sign`、`sign_type` 不参与签名。响应默认 302 到支付页；带 `format=json` 时返回 JSON。

### 异步回调（本站 → 你的 notify_url）

GET 请求，参数：`pid, type, out_trade_no, trade_no, trade_status=TRADE_SUCCESS, money, really_money, name, sitename, sign, sign_type=MD5`。验签规则与下单一致。

**返回什么算成功**取决于后台「回调成功判定」：

| 取值 | 判定 |
|---|---|
| `success` | 响应体去空白后等于 success |
| `@any2xx` | 只看 HTTP 状态码 2xx |
| `@json:code=1`（默认） | 响应体是 JSON 且 `code` 字段为 1 |

失败会按 `30s → 2m → 10m → 1h → 6h` 退避重试，最多 8 次。

{% note danger %}
**幂等必修**：同一笔订单可能收到多次回调（服务端回调 + 浏览器回跳），你的接口必须幂等——先查 `out_trade_no` 是否已处理，已处理直接返回成功。
{% endnote %}

## 七、常见问题

**Q：回调一直失败，错误是 `403 error code: 1003`？**
`notify_url` 用了裸 IP。Cloudflare 只认 zone 自己的域名，请求 IP 会被拒。换成域名即可——**不要用 IP 做回调地址**。

**Q：后台显示「监控端离线」，下不了单？**
监控端 60 秒没心跳就会拒单。检查 App 是否被系统杀掉（需要保活 / 自启动权限），或在后台把 `require_online` 改成 `0` 临时放开。

**Q：忘记管理员密码？**
在 D1 里清空管理员表，重新访问 `/setup`：

```bash
npx wrangler d1 execute vmq --remote --command "DELETE FROM admins;"
```

再打开 `/setup` 重设账号。**通讯密钥不会被重新生成**，监控端不用重新绑定。

**Q：上传图片提示「编码后超出数据库单条上限」？**
图片以 base64 存 D1，D1 单个值上限 2MB，所以原始文件限制在 1.4MB。收款码通常只有几十 KB，够用。要传大图建议改用 R2。

**Q：换域名要改哪些地方？**
① `wrangler.local.jsonc` 的 `routes`；② 后台「系统配置 → 站点信息」的站点地址；③ 商户侧的 `notify_url`。监控端二维码里的域名也要重新扫。

## 八、日常维护清单

| 频率 | 检查项 | 怎么做 |
|---|---|---|
| 每天 | 服务可达 | `curl -s -o /dev/null -w '%{http_code}' <地址>/api/health` 应为 200 |
| 每天 | 监控端在线 | 概览页徽标：绿=在线、黄=中断 1~10 分钟、红=离线超 10 分钟 |
| 每周 | 回调失败单 | 订单管理筛「回调失败」，逐条确认钱是否真到账 |
| 每月 | 备份 D1 | `pnpm exec wrangler d1 export vmq --remote --output ./.data/backup.sql -c "$(node scripts/cfg.mjs)"` |

## 总结

V免签 Cloudflare Workers 版把「个人免签收款」这件事的门槛压到了最低：不用买服务器、不用装 PHP、不用配 MySQL，一个 Cloudflare 免费账号 + 一台 Android 手机就能跑起来。对外兼容易支付协议意味着已有商城零改造接入，对内金额池防串单和 8 次退避重试则把免签方案最容易翻车的两个点兜住了。

如果你也在找一个零成本的个人收款方案，照着这篇教程从第 1 步走到第 8 步，半小时内就能收到自己的第一笔测试款。

> 项目地址：[im-webb/vmq-cf-worker](https://github.com/im-webb/vmq-cf-worker) ｜ 监控端：[im-webb/vmq-monitor-android](https://github.com/im-webb/vmq-monitor-android) ｜ 许可：MIT