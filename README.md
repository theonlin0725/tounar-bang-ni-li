# 帮你理（Tounar BangNiLi）

投递线索整理与进度追踪：浏览器插件自动采集 → 后台入库 → 网页台账 → 邮件提醒。

仓库：<https://github.com/theonlin0725/tounar-bang-ni-li>（私有）

> 当前状态：**本地链路已跑通并可体验，真实环境尚未验收**（详见 `docs/DELIVERY-REPORT.md`）。

二期 Mac 本地接手请先读 [完整交接说明](docs/LOCAL-AGENT-HANDOFF.md)：包含最新 GitHub 状态、Mac 启动故障、数据保护要求、测试证据与未完成事项。

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

## 一·五、用真实数据验收：一条命令

不想记一堆环境变量，就用这个（会把真实库**副本**放到 `~/tounar-acceptance/<时间戳>/`，原库只读）：

```bash
npm run local:acceptance            # 默认 127.0.0.1:4311，MAIL_MODE=outbox，不发真信
npm run local:acceptance -- --mail-mode=smtp   # 需要真发信时（只发 ALLOWED_EMAILS 白名单）
npm run local:stop                  # 停止（服务是后台常驻的，关终端不会停）
```

它会自己完成：Node ≥24 检查 → SQLite backup 复制（含 WAL）→ 复制同源 `master.key` →
端口占用检查（不杀进程）→ 以显式 `DATA_DIR/DB_PATH/HOST/PORT/APP_BASE_URL` 启动 →
轮询 `/api/v1/health` 与首页，两个都 200 才打印“✅ 已就绪”。

插件那边：popup 里点「检测本机服务」，会依次探测 `127.0.0.1:4311` 和 `4310`，
找到就自动填入并保存；连不上时会直接显示原因（连接被拒绝 / 超时 / HTTP 状态码 / 地址格式），
不再只有一句“不可达”。

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
| `npm test` | 后端及工具测试（81 项） |
| `npm run test:e2e` | 插件端到端（63 项，使用官方 Playwright Chromium） |
| `npm run test:web` | 网页端到端（51 项） |

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

通用采集按多个字段来源评分，优先结构化数据、已验证选择器和岗位语义；低把握字段留空，不用站点名或整页最长正文填值。新站点需要有效岗位标题和申请信号，不能保证任意已授权页面都可采集。专属适配的日期、路径和字段结果以真实证据为准。

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

当前进度：优先八家 **7/8**；连同牛客、实习僧及白名单外米哈游、Airbnb，共 **11 站 22/26 页**。剩余百度、BOSS 未完成真实详情验收；小米仅验证旧版招聘库。牛客修复公司/城市字段，阿里新入口已校准；Airbnb 使用通用规则，公司/城市留空。

## 八、外部依赖历史记录与当前边界

QQ 邮箱与云环境条目记录前一轮 2026-10-22 的结果，不能证明本轮真实账号会话或 SMTP/IMAP 验收已通过。本轮仍缺真实用户数据验收，详见二期交付报告。

| 依赖 | 状态 | 说明 |
|---|---|---|
| QQ 邮箱 IMAP 收信 | ✅ | 2026-10-22 真实授权码首扫 71 封成功 |
| SMTP 真实发信 | ✅ | `smtp.qq.com:465`，需显式 TLS（已在 `mailer.js` 修好） |
| 二期真实站点 | 🟡 22/26 页，优先官网 7/8 | 见第七节及逐站证据，未达到整体目标 |
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

用户已确认真实数据库只在其 Mac，云工作区没有该副本。本轮验收禁止真发邮件，强制 `MAIL_MODE=outbox`。可用独立工具导出去凭据副本，保留台账/邮件/待确认业务数据且不复制原密钥；详见 [真实数据隔离验收](docs/REAL-DATA-ACCEPTANCE.md)。

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

`probe:site` / `plugin:tryrun` 现在使用共享浏览器解析，可用 `--snapshot tests/fixtures/sites/<站点>/<岗位>.html` 保存去表单、去可执行脚本和页面状态、去联系方式的公开岗位快照。证书失败页不保存为岗位快照；禁止关闭 TLS 校验来通过验收。可用 `--report .tmp/tryrun.json` 保存结果；字段有值只是烟测，仍需人工核对。真实 DOM 可用 `node tools/replay-sites.mjs --report .tmp/replay.json` 完全离线回放。
