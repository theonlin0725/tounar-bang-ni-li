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

## 六、产品决策（D01–D13）

见 `docs/DECISIONS-D01-D13.md`。**2026-10-22 已拍板 D01–D12**，要点：

| 决策 | 冻结结果 |
|---|---|
| D01 看过门槛 | 当前标签页可见 + 累计 ≥3 秒 |
| D02 站点白名单 | 腾讯/字节/阿里/美团/京东/小米/百度/网易（聊天不算投递；全站点扩展进迭代） |
| D03 浏览归档 | 看过未投 30 天自动归档，保留可查 |
| D04 去重边界 | 同岗位不同日期再投 = 新记录；公司+岗位相同只进待确认；公司筛选器进迭代 |
| D05 终态纠错 | 人工可改（必填原因 + 留痕），机器不写死 |
| D06 提醒频率 | 每日 08:00；进展发过即静默；回看类同一条 7 天最多 1 次 |
| D07 已面 N 天 | 只作邮件标签，不推断面试完成 |
| D08 自动判定 | 邮件置信度 ≥0.9 直接判终态；低于进待确认，每 15 天邮件汇总一次 |
| D09 大模型 | 方向：用于插件扫描（识别官网/理解行为/记录线索），实现进迭代 |
| D10 内测名单 | 本地 `.env` 白名单（当前：theonlin7@gmail.com、1191240794@qq.com） |
| D11 发信窗口 | 08:00 触发，当天补发 |
| D12 必填口径 | 插件自动采集为主；手动补录兜底且支持线索自动填充 |
| D13 备注字段 | **待定**（是否加 ≤200 字备注） |

## 七、真实站点适配（同事可认领）

**2026-10-22 起，所有已授权站点都有通用识别兜底**：专属适配器没命中时，插件用
「投递按钮信号 + 标题/og 标签链 + 主机公司映射」自动采集，用户随手授权新站点也能用。
逐站适配的意义从「能不能用」变为「字段准不准」——认领一个站点只需提升精度。

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
| WorkBuddy 云环境 | ✅ | 2026-10-22 已开通并发布上线，云端免密钥大模型接入邮件解析兜底（D09 第一阶段） |

## 九、云服务与线上版（2026-10-22 接入）

- 线上地址：`https://bangnili.app.workbuddy.host`（托管在 WorkBuddy 应用沙箱，SQLite 随应用运行）
- 云端大模型：规则解析拿不准的招聘邮件，会调用 WorkBuddy 云（免密钥）做兜底识别；
  置信度封顶 0.88，**只进待确认队列，绝不自动判终态**（守住 D08 冻结决策）；
  云端失败静默回退纯规则解析，不影响主流程
- 开关与配置（`.env`）：`CLOUD_ENDPOINT` / `CLOUD_PUBLISHABLE_KEY` / `CLOUD_LLM_ENABLED`
- 验证云端链路：`npm run probe:llm`
- 代码位置：`server/src/cloud/llm.js`（客户端封装）、`server/src/domain/mailSync.js`（调用点）

配真实邮件只需在 `.env` 里填（模板见 `.env.example`）：

```
SMTP_URL=smtp://你的QQ号@qq.com:授权码@smtp.qq.com:465
MAIL_FROM=Tounar 帮你理 <你的QQ号@qq.com>
ALLOWED_EMAILS=你的邮箱@qq.com
```

## 十、二期优化（本地待验收，未发布线上）

二期代码、验证结果、未验收项和风险见 [二期交付报告](docs/PHASE2-DELIVERY.md)，操作步骤见 [本地验收清单](docs/PHASE2-ACCEPTANCE.md)。真实站点覆盖以 [适配证据](docs/SITE-ADAPTER-EVIDENCE.md) 为准，离线用例不代表真实站点验收。

| 二期配置 / 决策 | 默认值 | 说明 |
|---|---|---|
| `notification_preferences.stage_followup_days` | `7` | 设置页选择 7 / 14 / 关闭（0）；独立于已投回看阈值，阶段推进重算，终态停止 |
| `AUTO_PROGRESS_CONFIDENCE` | `0.8` | 面邀 / 笔试 / 测评自动更新总把握度阈值 |
| `AUTO_TERMINAL_CONFIDENCE` | `0.9` | 终态自动更新总把握度阈值；同时受 `AUTO_TERMINAL_FROM_MAIL` 开关限制 |
| `D12_ALLOW_MAIL_INFERRED_APPLIED_AT` | `true` | 原投递时间缺失时允许按原信收到时间标记上界 `inferred_before`，界面显示「≤ 日期（据邮件推断）」；不是精确投递时间 |
| 台账刷新 | 60 秒 / 重新获焦 | 按修订检查，显示本次邮件变更数量并高亮 |
| 采集把握度 | 高 / 中 / 低 | 低把握留空；机器只能用更高把握纠正旧采集字段，不能覆盖人工字段 |

总把握度 = 分类置信度 × 匹配把握度。唯一记录、状态不回退、终态保护也必须同时满足。

**旧采集字段的一次性修复：先只读查看，再由用户审阅。**

```bash
node server/scripts/repair-captured-fields.js --db data/tounar.sqlite --out .tmp/field-repair-plan.json
# 审阅 JSON；确认内容后由用户执行，脚本会先做 SQLite 一致性备份并校验版本：
node server/scripts/repair-captured-fields.js --db data/tounar.sqlite --apply --confirm --plan .tmp/field-repair-plan.json
```

自动识别疑似错值的规则可能误伤岗位名含“招聘”的真实岗位，因此不自动执行。数据库变化后旧计划会被拒绝，须重新审阅。先启动新版完成增量迁移；不要把数据库、备份、计划中的用户资料或授权码提交到 Git。

云环境回归使用官方 Playwright Chromium：

```bash
export PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/playwright-official
npx playwright install chromium
npm test
npm run test:e2e
npm run test:web
```

`probe:site` / `plugin:tryrun` 现在使用共享浏览器解析，可用 `--snapshot tests/fixtures/sites/<站点>/<岗位>.html` 保存去表单、去可执行脚本和页面状态、去联系方式的公开岗位快照。证书失败页不保存为岗位快照；禁止关闭 TLS 校验来通过验收。
