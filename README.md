# 帮你理（Tounar BangNiLi）

> **beta4 / 本地 4312 评审快照：从 [三个板块 Review 导航](docs/review/README.md) 开始。当前验证结果与待查问题见 [本次验证](docs/review/VALIDATION.md)，下方历史记录不替代本轮核验。**

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
| `npm start` / `npm run dev` | 启动服务（默认监听 `0.0.0.0:4310`，本机访问 `127.0.0.1:4310`） |
| `npm run otp:latest` | 打印 outbox 里最新验证码 |
| `npm run remind` | 手动触发一次提醒批次（不等 08:00） |
| `npm run mail:sync` | 手动触发一次邮箱同步 |
| `npm test` | 后端及工具测试（**150 项**） |
| `npm run test:e2e` | 插件端到端（67 项；共享解析器优先 Chrome for Testing，回退 Playwright Chromium） |
| `npm run test:web` | 网页端到端（55 项） |
| `npm run test:self-page` | 插件排除本项目自身页面（6 项） |
| `npm run test:career-ai` | 简历/对比/推荐浏览器流程（本地假模型，11 项） |
| `npm run test:intake` | 自动入账工作流 + 插件异步状态（隔离假模型，10 项） |
| `npm run eval:intake` | 真实 LLM/Jev 的中文样本评估（隔离临时库，绝不读用户库） |
| `npm run test:mail-admin` | 管理员邮件页面/模板/业务通路（隔离 outbox，不发真实邮件） |
| `npm run audit:self-captures -- --db ... --origin ...` | 只读识别历史自身页面误采集；`--apply --confirm` 才处理 |

> 本机若装了 WorkBuddy 的安全删除守卫，测试可能因为清理临时目录被拦截，加前缀即可：
> `env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR -u CODEBUDDY_SAFE_DELETE_BULK_GUARD npm test`

## 四、目录结构

| 目录 | 内容 |
|---|---|
| `server/` | Node 后端：`src/schema.sql`（表）、`src/domain/*`（共享业务）、`src/modules/{data-capture,mail-push,career-ai,recruitment-intake}/`、`src/routes/index.js`（58 条公共路由）、`src/modules/mail-push/admin.js`（8 条管理路由）、`src/jobs/`（调度） |
| `extension/` | 数据抓取插件层的 Chrome MV3 客户端：content 采集、service worker、本地离线队列、popup |
| `web/` | 前端展示模块：无构建 Vanilla SPA（`index.html` + `assets/js/views/*`） |
| `tests/e2e/` | 插件与网页端到端脚本 |
| `docs/` | 契约、交付报告、需求矩阵、决策清单 |

职责模块的详细说明：

| 模块 | 服务端实现 | 客户端 / 页面 | README |
|---|---|---|---|
| 数据抓取插件层 | `server/src/modules/data-capture/` | `extension/` | [模块说明](server/src/modules/data-capture/README.md) |
| 邮件推送模块 | `server/src/modules/mail-push/` | 无独立客户端 | [模块说明](server/src/modules/mail-push/README.md) |
| 前端展示模块 | 公共 API 与静态托管 | `web/` | [模块说明](web/README.md) |
| 招聘进展自动入账 | `server/src/modules/recruitment-intake/` | 服务端工作流 / 台账轮询 | [实现说明](docs/AUTO-INTAKE-WORKFLOW.md) |
| 简历与 AI 分析 | `server/src/modules/career-ai/` | `web/assets/js/views/career.js` | [模块说明](server/src/modules/career-ai/README.md) |

文件移动、无法归类文件的保留理由和本轮验证结果见[模块化整理记录](docs/MODULE-REORGANIZATION-20261028.md)。

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
| QQ 邮箱 IMAP 收信 | ✅ 历史 | 2026-10-22 真实授权码首扫 71 封成功；本轮未复验 |
| SMTP 真实发信 | ✅ 历史 | `smtp.qq.com:465`，需显式 TLS（实现在 `server/src/modules/mail-push/mailer.js`）；本轮未复验 |
| 二期真实站点 | 🟡 22/26 页，优先官网 7/8 | 见第七节及逐站证据，未达到整体目标；本轮未重新验收实时站点 |
| WorkBuddy 云环境 | ✅ 历史 | 2026-10-22 已开通并发布上线，云端免密钥大模型接入邮件解析兜底（D09 第一阶段）；本轮未实测 |

## 九、云服务与线上版（2026-10-22 接入）

- 线上地址：`https://bangnili.app.workbuddy.host`（托管在 WorkBuddy 应用沙箱，SQLite 随应用运行）
- 云端大模型：规则解析拿不准的招聘邮件，会调用 WorkBuddy 云（免密钥）做兜底识别；
  LLM 自身置信度封顶 0.88，低于 0.9 的自动终态阈值，不能单独触发终态自动更新；
  云端失败静默回退纯规则解析，不影响主流程。实际分类/字段兜底是否进入待确认还受匹配把握度和
  调用条件影响，不能把它理解为“所有兜底结果都强制待确认”；详见[数据抓取模块说明](server/src/modules/data-capture/README.md)。
- 开关与配置（`.env`）：`CLOUD_ENDPOINT` / `CLOUD_PUBLISHABLE_KEY` / `CLOUD_LLM_ENABLED`
- 验证云端链路：`npm run probe:llm`
- 代码位置：`server/src/modules/data-capture/cloud/llm.js`（客户端封装）、`server/src/modules/data-capture/mail/sync.js`（调用点）；旧 `server/src/cloud/llm.js`、`server/src/domain/mailSync.js` 仅保留为兼容转导出。

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
| 台账刷新 | 2 秒 / 重新获焦 | 页面可见时按修订检查，显示本次邮件变更数量并高亮 |
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


## 自身页面排除、自动入账与精简待确认（2026-11-01）

- **自身页面排除**：插件按后台 origin、项目 DOM、标题和路径拦截本项目页面；自动/主动采集、列表、SPA 路由、离线上传和服务端事件入口均有兜底。旧队列逐条丢弃自身页面事件，不整队清空。专项验收 `npm run test:self-page` **6/6**。
- **待确认卡片**：只保留「确认入账 / 忽略」；点击确认先走服务端 LLM+Jev 识别，不再有默认状态直接写库。公司/岗位必填；可靠则直接入账，缺失/歧义弹补录，取消保持 open，模型失败可重试/手动。标题有安全原网页链接时直接可点；忽略立即生效。
- **台账**：删除重复“投递链接”列，只保留“查看岗位”且始终指向岗位详情；状态列可直接下拉修改，保留修改前后状态、时间和“用户手动修改”来源。旧证据不覆盖较新的手动修改，更晚的新证据仍可自动更新。
- **自动入账**：`插件/邮件 → LLM 提取 → Jev System One 判断 → 服务端时间/冲突/重复/人工保护校验 → 自动创建/更新/无需变更/待确认`。Jev 使用真实类型化问题（实际进展、阶段、证据、新旧、岗位归属），不是普通 Judge 提示词；录用/拒绝在归属可靠且无冲突时可自动更新。技术失败进入重试审计，不制造用户待确认。详见 [自动入账工作流](docs/AUTO-INTAKE-WORKFLOW.md)。
- **真实模型验证**：`.env` 已配置 DeepSeek 与 Jev。8 条人工标注中文样本最近一次结果：自动更新/创建 4 条且 4/4 正确，待确认 1 条（12.5%），非进展/旧信息过滤 3 条，错误状态更新 0、错误岗位匹配 0；可自动样本覆盖 4/4，总样本覆盖 50%。样本小且为合成邮件，不是生产精准率承诺。复现：`npm run eval:intake`。
- **简历 AI**：入口 `/?panel=career`，台账可跨板块勾选 2–6 个岗位对比；支持 PDF/DOCX/粘贴文本、简历版本、原文证据核验、岗位对比、未投递推荐。该页面测试使用本地假模型；真实简历模型质量仍需联调。详见 [实现说明](docs/CAREER-AI-IMPLEMENTATION.md) 和 [模块 README](server/src/modules/career-ai/README.md)。
- **实际环境核验**：Chrome 中加载的是项目 `extension/`（扩展 ID `kljgjklbcecdagpifhhahdegngfndgln`，manifest 0.2.1，Secure Preferences 记录 last update 2026-10-26）；更新后的 content script 已在新标签实际产生带 `page_url` 的真实岗位事件，而打开/刷新/切换 4311 首页、待确认、简历 AI、设置页均未新增事件。历史误采来自更新前已打开的旧标签页/旧事件；服务端新增页面 URL 兜底与无信息自动忽略。详见[自身页面根因报告](docs/SELF-CAPTURE-ROOT-CAUSE-20261101.md)。
- **真实提醒邮件**：已向唯一授权测试邮箱 `1191240794@qq.com` 实际发送一封，主题、SMTP 受理、QQ INBOX 收件均已核验；同批次重复触发复用旧批次、delivery 未增加。当前真实台账无 A/B/digest 候选，发送用隔离副本补边界条件，不能称为“真实候选发送”。详见[真实提醒测试](docs/LIVE-REMINDER-TEST-20261101.md)。
- **确认入账工作流**：旧「确认入账」直连 `/assign`、绕过 LLM/Jev 且允许空白；现改为 `/review-items/:id/intake` 识别预览 + 必填校验 + 补录。本机直连 TypeSafe 实测 HTTP 451（地区限制），已用 Dify Cloud 工作流真实调用 Jev 兜底，结果显式标记 `dify_fallback`。详见[确认入账实现与联调](docs/CONFIRM-INTAKE-WORKFLOW-20261101.md)。
- **确认卡死根因**：静态 JS 曾 `max-age=300`，旧标签页继续运行旧 `reviews.js`/直接 `/assign`；同时版本化入口与未版本化 `../app.js` 造成双模块、双壳、重复卡片。已改为 JS/CSS `no-store`、统一版本 `20261101-11`、全量统一 `app.js` 引用并清理重复容器。详见[确认入账根因与联调](docs/CONFIRM-INTAKE-WORKFLOW-20261101.md#卡死根因2026-11-01-1540-实际核对)。
- **历史空白/错位**：当前 17 条公司/岗位缺失、占位或疑似错位；自动修复 0（无完整可靠证据/人工保护），全部保留原记录并提供「补充信息」入口。详见[历史字段修复对账](docs/HISTORICAL-FIELD-REPAIR-20261101.md)。
- **Dify 演示**：已发布 `帮你理-确认入账-LLM+Jev` 工作流，真实 LLM + 真实 Jev HTTP 两次运行（可入账/需要补录），地址、脱敏 DSL 与截图见[Dify 工作流](docs/dify/README.md)。
- **现有待确认清理**：28 条 open 处理为 6 条真实歧义；19 条自身页面/无信息忽略，1 条自动新建，2 条自动忽略邮件非进展，2 条只有邮件头的有效进展恢复保留，0 失败，3 条历史无效台账归档。9 条 manual 空白记录保留。详见[清理对账](docs/PENDING-REMEDIATION-20261101.md)。
- **历史误采集**：`npm run audit:self-captures -- --db data/mail-selftest/tounar.sqlite --origin http://127.0.0.1:4311` 只读列出事件/待确认/关联台账；`--apply --confirm` 只忽略事件、关闭历史自身页面待确认，不删除台账。先审阅[历史识别报告](docs/SELF-CAPTURE-AUDIT-20261101.md)再决定。

## 管理员真实邮件自测（2026-10-30）

```bash
npm run mail:selftest
# 停止 / 查看状态
npm run mail:selftest:stop
npm run mail:selftest:status
```

入口：[邮件测试与模板](http://127.0.0.1:4311/?panel=mail-admin)，[逐步自测指南](docs/MAIL-SELFTEST-GUIDE.md)。当前固定使用 `data/mail-selftest/`（由 `data/mail-selftest-profile.json` 固定），已从旧验收库恢复 40 条历史台账（插件补传后当前 54 条）和原插件设备绑定；启动会校验数据库身份与预期设备，缺失/撤销/过期时直接停止，不会重新复制或回退旧基线。SMTP 使用本机 `.env`，启动不自动发信。管理员由 `ADMIN_EMAILS` 指定（当前 `theonlin7@gmail.com`、`1191240794@qq.com`；恢复台账属于后者）；测试收件人受 `TEST_MAIL_RECIPIENTS` 白名单限制。`mail:selftest` 还启用仅本机管理员自测登录：登录页会直接显示验证码而不发邮件（`ENABLE_SELFTEST_LOGIN`，普通 `npm start`/生产默认关闭）。

支持五种模板的主题／纯文本／HTML 编辑、示例变量、约束、版本恢复，以及分别标识的模板试发和业务通路测试。业务通路测试从本人台账读取真实候选，用独立测试批次手动触发；不消费正式通知，不代表定时调度验收。发信结果区分 SMTP 受理、本地文件、失败和未知；最终收件由用户核对收件箱。全部管理 API 校验管理员，试发收件人受白名单限制。
