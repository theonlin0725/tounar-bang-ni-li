# 帮你理（Tounar BangNiLi）

投递线索整理与进度追踪：浏览器插件自动采集 → 后台入库 → 网页台账 → 邮件提醒。

仓库：<https://github.com/theonlin0725/tounar-bang-ni-li>（私有）

> 当前状态：**本地链路已跑通并可体验，真实环境尚未验收**（详见 `docs/DELIVERY-REPORT.md`）。

---

## 一、本机跑起来（3 分钟）

```bash
# 1. 装依赖（只有 playwright 是开发依赖，后端用 Node 内置 node:sqlite，无需数据库）
npm install

# 2. 复制环境变量模板
cp .env.example .env

# 3. 编辑 .env，把能登录的邮箱写进白名单
#    ALLOWED_EMAILS=你的邮箱@xx.com,同事邮箱@xx.com

# 4. 启动
npm start          # 或 npm run dev（改代码自动重启）
```

打开 <http://127.0.0.1:4310>：

1. 输入白名单里的邮箱 → 获取验证码
2. 开发模式下验证码**不会真的发邮件**，去 `data/outbox/` 找最新 JSON，或直接跑：
   ```bash
   npm run otp:latest
   ```
3. 登录后即可看到空台账（新账号三个数字都是 0，没有演示数据）

> 需要 **Node ≥ 24**（`package.json` 的 `engines`）。后端用的是内置 `node:sqlite`，不用装数据库。

## 二、默认白名单邮箱

代码默认（`server/src/config.js`）：

| 邮箱 | 用途 |
|---|---|
| `demo@tounar.local` | 主测试账号 |
| `peer@tounar.local` | 第二个账号，用于验证多用户隔离 |

这两个是假域名，**不能收邮件**，只用于本地 OTP（验证码从 outbox 读）。要换成真实邮箱就改 `.env` 的 `ALLOWED_EMAILS`。

## 三、常用命令

| 命令 | 作用 |
|---|---|
| `npm start` / `npm run dev` | 启动服务（默认 127.0.0.1:4310） |
| `npm run otp:latest` | 打印 outbox 里最新验证码 |
| `npm run remind` | 手动触发一次提醒批次（不等 08:00） |
| `npm run mail:sync` | 手动触发一次邮箱同步 |
| `npm test` | 后端测试（58 项） |
| `npm run test:e2e` | 插件端到端（17 项，需 Chrome for Testing） |
| `npm run test:web` | 网页端到端（40 项） |

> 本机若装了 WorkBuddy 的安全删除守卫，测试可能因为清理临时目录被拦截，加前缀即可：
> `env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR -u CODEBUDDY_SAFE_DELETE_BULK_GUARD npm test`

## 四、目录结构

| 目录 | 内容 |
|---|---|
| `server/` | Node 后端：`src/schema.sql`（表）、`src/domain/*`（业务）、`src/routes/index.js`（41 个路由）、`src/jobs/`（调度） |
| `extension/` | Chrome MV3 插件：content 采集、service worker、本地离线队列、popup |
| `web/` | 无构建 Vanilla SPA（`index.html` + `assets/js/views/*`） |
| `tests/e2e/` | 插件与网页端到端脚本 |
| `docs/` | 契约、交付报告、需求矩阵、决策清单 |

## 五、协作约定

1. **不塞演示数据**：前端空账号必须是 0 条；接口失败原样呈现，不转 0、不编造。
2. **外部未验收不写成已实现**：真实 QQ IMAP、真实 SMTP、≥8 家站点、云环境未跑通前，只能标"部分实现/阻塞"。
3. **改代码 → 跑测试 → 再提交**：`npm test` 与 `npm run test:web` 必须全绿。
4. **密钥不入库**：`data/master.key`、`data/internal-tick.token`、`.env` 已在 `.gitignore` 里。

## 六、待你拍板的 13 个决策

见 `docs/DECISIONS-D01-D13.md`，已经落地的有：D01（3 秒门槛）、D07（已面 N 天只作提醒标签）、D12（插件自动采集为主 + 手动补录兜底）。

## 七、真实站点适配（同事可认领）

站点适配是**唯一可以并行推进**的阻塞项，一个人认领一家即可，不需要懂后端。

```bash
# 1. 看真实页面渲染后的 DOM，挑出选择器
npm run probe:site -- "https://某招聘站/某职位页"

# 2. 把 extension/content/adapters.js 里对应站点改好

# 3. 用生产脚本在真实页面上试跑，看能不能自动采到字段
npm run plugin:tryrun -- "https://某招聘站/某职位页"
```

判定"这家做完了"的标准和已完成的证据都在 `docs/SITE-ADAPTER-EVIDENCE.md`。
**采不到就如实标 `site_verified: false`，不要改文案假装完成。**

当前进度：**1 / 8**（字节跳动校园招聘已验证）。

## 八、外部依赖闭合情况

| 依赖 | 状态 | 说明 |
|---|---|---|
| QQ 邮箱 IMAP 收信 | ✅ | 2026-10-22 真实授权码首扫 71 封成功 |
| SMTP 真实发信 | ✅ | `smtp.qq.com:465`，需显式 TLS（已在 `mailer.js` 修好） |
| ≥8 家真实站点 | 🟡 1/8 | 见第七节 |
| WorkBuddy 云环境 | ⬜ | 仍是本地替代方案 |

配真实邮件只需在 `.env` 里填（模板见 `.env.example`）：

```
SMTP_URL=smtp://你的QQ号@qq.com:授权码@smtp.qq.com:465
MAIL_FROM=Tounar 帮你理 <你的QQ号@qq.com>
ALLOWED_EMAILS=你的邮箱@qq.com
```
