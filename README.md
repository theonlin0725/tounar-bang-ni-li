# 帮你理 Tounar

> **v1.1.5（yyr）· 简历改写审阅 / 岗位识别插件 0.2.14**
> 浏览器插件自动采集招聘岗位 → 多邮箱同步招聘进展 → 台账与待确认管理 → 单岗位简历六维匹配。

**Git 开发分支**：`tournr-1.1.5-yyr` · [组员本地部署与模型分工](docs/LOCAL-DEPLOY-V1.1.5-YYR.md)

[GitHub 仓库](https://github.com/theonlin0725/tounar-bang-ni-li) · [产品自测指引](docs/SELF-TEST-GUIDE-V1.0.0.md) · [AI 部署与内测手册](docs/AI-DEPLOY-AND-TEST-RUNBOOK.md) · [v1.0.0 验收记录](docs/RELEASE-V1.0.0-AUDIT-RESULT-20261122.md) · [v1.1.0 Agent 方案](docs/AGENT-ASSISTANT-V1.1.0-DEV-PLAN-20261122.md) · [v1.1.1 需求方案](docs/AGENT-ASSISTANT-V1.1.1-UX-PROFILE-AND-BUGFIX-PLAN-20261122.md) · [v1.1.1 实现结果](docs/AGENT-ASSISTANT-V1.1.1-RESULT.md) · [v1.1.2 稳定性方案](docs/AGENT-RELIABILITY-AND-ANSWER-QUALITY-PLAN-20261123.md) · [v1.1.2 实现结果](docs/AGENT-ASSISTANT-V1.1.2-RESULT.md) · [v1.1.3 方案](docs/RESUME-REWRITE-QUALITY-AND-PROGRESS-PLAN-20261123.md) · [v1.1.3 实现结果](docs/AGENT-ASSISTANT-V1.1.3-RESULT.md) · [v1.1.4 方案](docs/V1.1.4-COMPREHENSIVE-UPGRADE-PLAN-20261124.md) · [v1.1.4 实现结果](docs/AGENT-ASSISTANT-V1.1.4-RESULT.md) · [文档索引](docs/INDEX.md)

| 项目 | 当前状态 |
|---|---|
| 主应用 | **v1.1.5（简历改写审阅 / 岗位识别升级）** |
| 浏览器插件 | **0.2.14** |
| 运行环境 | **Node.js ≥ 24**（使用内置 `node:sqlite`，无需安装数据库） |
| 真实邮箱 | QQ / Foxmail 已完成真实端到端验证 |
| 泛化基准 | 44 封合成邮件 / 34 封未见样本 / 11 轮全链路通过 |

---

## 1. 能做什么

### 1.1 浏览器插件 0.2.14：跨站岗位采集

- 支持主流大厂校招站、ATS 站及列表页同页展开的单岗详情采集。
- 自动排除帮你理自身页面（`127.0.0.1` / `localhost`），避免误采。
- 大模型辅助整理公司名、岗位名、JD 摘要与完整 JD。
- 低置信度自动标题在重新打开原文时可安全纠正，不覆盖人工修改。
- 支持网页一键检测连接插件、8 位手动配对码兜底、设备撤销与招聘网站授权管理。
- 插件 ZIP 是构建产物，仓库默认不提交；本地安装、配对或打包见[组员部署指引](docs/LOCAL-DEPLOY-V1.1.5-YYR.md)。

### 1.2 前端工作台：台账、设置、简历与单岗匹配

- 顶部模块迁移至左侧侧边栏：工作台（投递台账 / 看过没投 / 已归档）、待确认、匹配分析、简历库、设置。
- 投递台账精简为 5 列：**公司 / 岗位 / 状态 / 已投天数 / 更新时间**。
  - 状态为柔和圆角色块下拉，支持直接切换；
  - 轮次/待回看信息置于状态下方第二层，长轮次单行省略，不撑高表格；
  - 已投天数显示 `今天 / N 天`，更新时间显示 `YYYY-MM-DD`。
- 设置页聚合「提醒设置 / 数据与授权 / 安装指引 / 邮件测试与模板」二级页签。
- 支持 390px 窄屏：侧边栏抽屉、键盘焦点、Esc 关闭；台账自动重排为卡片。
- 简历库支持 PDF/DOCX/粘贴文本上传、多版本切换、设为当前版本与手动文本编辑。
- 单岗位匹配分析提供六维卡片（缩略/展开）、人工纠偏、基于匹配缺口生成面试题。

### 1.3 多邮箱抓取与大模型状态更新

- 支持 QQ / Foxmail、网易 163 / 126 / yeah.net IMAP 客户端授权码连接；当前 **QQ 已通过真实公网邮箱全链路验收**。
- 邮箱同步实时展示百分比与扫描件数，结束自动清理临时进度并刷新侧栏角标/台账。
- 结合邮件标题、正文首尾、HTML 表格与落款识别：
  - 真实公司、岗位、城市（只保留城市级名称）；
  - 已投递 / 笔试测评 / 面试 / 录用 / 拒绝 / 已结束六态；
  - 跨阶段自动清理旧 `round_label`，终态不携带面试轮次；
  - 自动入账后自动消解同事件/同岗位重复「待确认」；
  - 自身产品邮件、账单、物流、营销等噪声拦截；
  - 单封异常隔离，不中断整箱同步。
- 提供全链路泛化基准 `npm run bench:mail-e2e` 和存量脏邮件清理脚本 `npm run mail:cleanup`。

### 1.4 AI 求职助手 v1.1.4

- 任意页面可通过左侧「AI 助手」或右下角悬浮按钮打开右侧 Drawer，也保留 `/?panel=assistant` 全屏路由；主页面筛选和滚动位置不丢。
- 支持安全 Markdown 渲染、自然语言查询、岗位详情/JD 问答、多岗位对比、单岗位六维匹配、面试题生成。
- 模型网关兼容 OpenRouter 数组分片/内嵌错误/推理截断；自动重试、备选模型与脱敏诊断日志提升回答成功率。
- 工具步数达到上限时强制无工具总结；支持读取完整简历和受控修改岗位字段。
- 写操作（批量改投递状态、按 JD 改写简历并新建版本）先在对话中展示确认卡，用户明确确认后才落库。
- 当前上下文条可切换简历、岗位和求职画像；岗位使用「投递明细 / 看过没投」二级选择器与分页搜索，切换写入上下文边界。
- 首次使用可建立六维求职画像（方向、地点、薪资、工作方式、行业、企业偏好）；确认画像后注入单岗位匹配上下文。
- 缺 JD 岗位在对话内直接弹出补录卡片，保存后自动续接原分析请求，无需跳走重问。
- 首轮对话后顶部欢迎与快捷任务卡保持常驻；画像卡片可实时切换「未建立 / 已建立 / 修改画像」。
- 工具原始 JSON 只进入服务端审计表，不塞进对话消息；前端只显示轻量执行状态和最终自然语言结论。
- 模型配置优先 `AGENT_API_*`，其次 `OPENROUTER_*`，最后复用 `AI_API_*`；服务端 key 不进入浏览器。
- AI 简历改写只生成新版本，不覆盖原简历；未勾选“设为当前”时保留原当前简历。

### 1.5 简历库「简历改写」工作台 v1.1.5

- 简历库新增「我的简历 / 简历改写」二级页签；可从投递明细或看过没投选择目标岗位、切换简历版本、查看画像与 JD。
- 9 步结构化改写与四级事实对齐：已优化 / 可优化 / 待补事实 / 已拦截；无证据内容不进入最终草稿。
- 仅改写实习和项目描述；实际改写的正文以绿色虚线标记。简历默认居中，点「查看原文」才展开对应条目的原文；窄屏在条目下方展开。
- 确认后按「原简历名_岗位名」保存新版本，可重命名、可设为当前，并生成可编辑 Word（`.docx`）下载。
- Word 使用统一单栏 A4 模板，不包含审阅标记。导出前在本机实排并校验页数，不还原上传者的原始版式。

### 1.6 v1.1.4 体验升级

- 首次登录按真实数据渐进引导：检测插件 → 安装/授权 → 浏览入库动画 → 邮箱同步动画；按用户 localStorage 持久化，可稍后跳过。
- 单岗位匹配改为两级岗位弹窗（投递明细 / 看过没投），展示城市、状态与有/缺 JD；缺 JD 时给出补录提示。
- 推荐卡片更名「看过没投」岗位推荐，支持选择简历版本并随请求传入 `resume_id`。
- 简历改写新增 `core_keywords` / `target_persona`、反微调重试、句尾行内状态标签和更严格的逐块同行对齐。
- 全局后台任务条、完成提醒和缺 JD 补录已纳入 v1.1.4 回归。

---

## 2. 快速开始

### 2.1 全新空库自测（推荐首次体验）

```bash
npm install
cp .env.example .env
# 编辑 .env，至少把可登录邮箱写入 ALLOWED_EMAILS
npm start
```

打开 <http://127.0.0.1:4310>，输入白名单邮箱获取验证码。开发/outbox 模式不会真实发信：

```bash
npm run otp:latest
```

### 2.2 使用真实数据隔离副本（安全验收）

```bash
npm run local:acceptance
# 默认 http://127.0.0.1:4311，会复制到 ~/tounar-acceptance/<时间戳>/
npm run local:acceptance -- --mail-mode=smtp   # 需要真实发信时，仅白名单邮箱
npm run local:stop                              # 停止验收实例
```

`local:acceptance` 会复制真实数据库/密钥到隔离目录，不直接修改原库，并检查健康接口与首页均为 200。

### 2.3 配置模型（可选，但邮件自动识别/简历匹配需要）

在 `.env` 中配置 OpenAI 兼容模型网关（不要把 key 写入前端或仓库）：

```dotenv
AI_API_URL=https://你的模型网关/v1
AI_API_KEY=服务端密钥
AI_MODEL=模型名
```

邮件判断可使用 `MAIL_INTAKE_JUDGE=jev` 或 `flash`。`flash` 复用 `AI_API_*`，本地基准推荐使用：

```bash
MAIL_BENCH_JUDGE=flash
```

完整变量说明见 [.env.example](.env.example) 和 [AI 部署与内测手册](docs/AI-DEPLOY-AND-TEST-RUNBOOK.md)。

---

## 3. 产品自测入口

按六个模块自测，详细步骤见 [SELF-TEST-GUIDE-V1.0.0.md](docs/SELF-TEST-GUIDE-V1.0.0.md)：

| 模块 | 自测入口 | 重点 |
|---|---|---|
| **(a) 岗位 JD 抓取** | 安装插件 0.2.14 → 网页绑定 → 打开至少 3 家招聘站详情页 | 公司/岗位/JD 摘要与全文、看过没投、自身页面不误采 |
| **(b) 前端页面改造** | 左侧导航 / 台账 / 设置 / 390px | 5 列台账、状态色块、天数、日期、设置页签、移动端抽屉 |
| **(c) 邮件抓取与状态更新** | 先跑 `npm run bench:mail-e2e`，再绑定 QQ 邮箱实测 | 进度条、自动入账、状态推进、待确认互斥、噪声过滤 |
| **(d) 简历库、六维匹配与面试题** | 简历库上传/编辑 → 匹配分析 → 纠偏/面试题 | 多版本、手动编辑、六维卡片、纠偏与面试题持久化 |

> 简历定向改写需要配置服务端 AI 网关。生成草稿不会覆盖原简历；确认后保存为新版本。

---

## 4. 让 AI 帮你部署和内测

把下面这段提示词复制给 Codex / Claude Code / Gemini / Cursor 等 AI 助手，并让它先阅读：

```text
你在 /path/to/tounar-bang-ni-li 仓库工作。请先阅读：
1. docs/AI-DEPLOY-AND-TEST-RUNBOOK.md
2. docs/SELF-TEST-GUIDE-V1.0.0.md

严格按照 runbook 完成环境预检、隔离启动和 (a)–(f) 六模块验活。
不要修改业务代码，不要读取/上传真实邮箱、授权码、.env、数据库或 .tmp 证据。
遇到 cloud-persistence 两条已知环境性失败和云快照/无头扩展限制，如实记录，不要伪造通过。
```

AI 手册包含：

- Node ≥ 24 检查、依赖安装、`.env` 必填/可选变量清单；
- `npm start` 空库自测与 `npm run local:acceptance` 真实数据隔离副本两种启动方式；
- (a)(b)(c)(d) 自动回归命令、健康接口、截图与报告路径；
- 端口占用、Playwright 浏览器路径、Chrome 加载未打包/ZIP 插件、已知误报的排障说明。

---

## 5. 常用命令

| 命令 | 作用 |
|---|---|
| `npm start` | 启动主应用（默认 `127.0.0.1:4310`） |
| `npm run dev` | 开发模式，改动自动重启 |
| `npm run local:acceptance` | 复制真实库到隔离目录并启动验收实例 |
| `npm run local:stop` | 停止 local:acceptance 实例 |
| `npm run otp:latest` | 读取 outbox 最新开发验证码 |
| `npm test` | 后端/领域/工具单测（已知 2 条云快照用例存在环境性波动） |
| `npm run test:web` | Web/Playwright E2E（74 项） |
| `npm run test:e2e` | 插件端到端（67 项） |
| `npm run test:career-ai` | 简历/单岗匹配浏览器流程（51 项） |
| `npm run test:intake` | 自动入账工作流（10 项） |
| `npm run test:mail-progress` | 邮箱实时进度（6 项） |
| `npm run test:mail-admin` | 管理员邮件页面/模板/业务通路 |
| `npm run test:panel` | 同页单岗面板稳定性（8 项） |
| `npm run test:netease-game` | 网易互娱等站点快照泛化（60 项） |
| `npm run test:self-page` | 插件排除自身页面（6 项） |
| `npm run bench:mail-e2e` | 44 封合成邮件全链路泛化基准 |
| `npm run mail:cleanup` | 只读预览历史脏邮件台账清理；`--apply` 才写库 |
| `npm run test:agent` | AI 助手服务端单测 + Playwright 验活 |
| `npm run build:plugin` | 重新打包 0.2.14 插件 ZIP |
| `node tools/smoke-agent-openrouter.mjs` | OpenRouter 四场景真实联调（需 `OPENROUTER_API_KEY`） |
| `npm run eval:intake` | 使用真实模型评估自动入账（隔离库） |

---

## 6. 目录结构

```text
server/        Node 后端、领域服务、SQLite schema、调度
extension/     Chrome MV3 采集插件
web/           无构建 Vanilla SPA
tests/e2e/     浏览器与插件端到端测试
tools/         基准/探针/打包工具
docs/          产品、架构、验收与历史文档（见 docs/INDEX.md）
```

---

## 7. 未开发功能与已知边界

### 未开发功能（规划中，不属于 v1.1.4）

1. **投递策略与转化漏斗分析（analyze_strategy）**：阶段转化率、时间趋势和自定义提醒分析。
2. **单岗位自定义提醒天数**：当前使用全局提醒设置。
3. **原 DOCX 像素级模板替换**：当前导出标准可编辑 Word，不做任意设计稿的像素级逆向还原。

### 已知外部与测试边界

- 网易 163 / 126 / yeah.net 代码已支持，但**尚未完成真实公网授权码联调**；当前真实邮箱证据仅来自 QQ。
- 招聘站点适配持续演进；未逐站验证的冷门站点依赖通用规则 + 模型兜底，不保证 100% 站点零遗漏。
- `npm test` 中既有 `cloud-persistence` / `cloud-persistence-http` 两条云快照用例存在环境性波动，与 v1.1.4 业务功能无关。
- 无头 Playwright 下扩展 service worker/权限诊断存在环境限制；`test:plugin-backend` 的随机不可达 origin 断言不作为 v1.1.4 发版门禁。
- 真实个人邮箱、授权码、邮件正文、`.env`、SQLite 与 `.tmp/` 证据均不提交进仓库。

---

## 8. 文档入口

- [产品自测指引 v1.0.0](docs/SELF-TEST-GUIDE-V1.0.0.md)
- [v1.1.0 Agent 开发方案](docs/AGENT-ASSISTANT-V1.1.0-DEV-PLAN-20261122.md)
- [v1.1.0 Agent 实现结果](docs/AGENT-ASSISTANT-V1.1.0-RESULT.md)
- [v1.1.1 UX/画像/Bugfix 方案](docs/AGENT-ASSISTANT-V1.1.1-UX-PROFILE-AND-BUGFIX-PLAN-20261122.md)
- [简历库简历改写模块方案](docs/RESUME-LIBRARY-REWRITE-MODULE-PLAN-20261122.md)
- [v1.1.1 实现结果](docs/AGENT-ASSISTANT-V1.1.1-RESULT.md)
- [v1.1.2 稳定性方案](docs/AGENT-RELIABILITY-AND-ANSWER-QUALITY-PLAN-20261123.md)
- [v1.1.2 实现结果](docs/AGENT-ASSISTANT-V1.1.2-RESULT.md)
- [v1.1.3 简历改写质量/进度方案](docs/RESUME-REWRITE-QUALITY-AND-PROGRESS-PLAN-20261123.md)
- [v1.1.3 实现结果](docs/AGENT-ASSISTANT-V1.1.3-RESULT.md)
- [v1.1.4 综合升级方案](docs/V1.1.4-COMPREHENSIVE-UPGRADE-PLAN-20261124.md)
- [v1.1.4 实现结果](docs/AGENT-ASSISTANT-V1.1.4-RESULT.md)
- [AI 部署与内测手册](docs/AI-DEPLOY-AND-TEST-RUNBOOK.md)
- [v1.0.0 封板验收记录](docs/RELEASE-V1.0.0-AUDIT-RESULT-20261122.md)
- [全链路邮件泛化基准结果](docs/MAIL-E2E-GENERALIZATION-BENCHMARK-RESULT-20261122.md)
- [文档总索引](docs/INDEX.md)
- [产品决策 D01–D13](docs/DECISIONS-D01-D13.md)
- [自动入账工作流](docs/AUTO-INTAKE-WORKFLOW.md)
- [采集与匹配模块说明](server/src/modules/data-capture/README.md)
- [简历与 AI 分析模块说明](server/src/modules/career-ai/README.md)
