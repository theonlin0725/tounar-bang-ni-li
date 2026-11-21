# 招聘邮件「发信 → 读取 → 识别 → 入账」全链路泛化验收方案

**日期**：2026-11-22  
**适用仓库**：`tounar-bang-ni-li`  
**核心目的**：构建一套可由 Agent 自主执行的端到端模拟验证链路——**自己构造并发送多形态招聘与噪声邮件 → 真实协议读取 → 大模型与规则识别整理 → 自动写入投递台账与待确认 → 校验前端接口与页面呈现**，通过「已知回归集 + 全新未见泛化集」量化评估系统真实的泛化能力、准确率与薄弱环节，且不污染真实用户数据、不影响既有功能。

## 1. 总体架构：双模式全链路闭环

为保证测试走完 **100% 生产代码路径**（`nodemailer` 发信 → MIME/HTML 编码 → `ImapFlow` 拉取 → `syncConnection` → `parser.js` → `llm.js` + `judge.js` → `workflow.js` / `applications.js` → SQLite → `/api/v1/ledger` & `/api/v1/reviews` → 前端台账渲染），设计双模式运行架构：

1. **默认模式：本地 SMTP + 本地 IMAP 全链路隔离沙箱（100% 自主可重复）**
   - 在测试脚本内启动一个轻量**本地 SMTP 收信服务 + 本地 IMAP 邮箱服务**（共用同一内存/临时目录邮箱存储，支持真实 MIME `text/plain` / `text/html` / `multipart/alternative`、RFC 2047 中文主题与发件人显示名、Quoted-Printable / Base64 编码、UID / UIDVALIDITY、`SEARCH SINCE`、`FETCH BODYSTRUCTURE` 与正文下载）。
   - 启动隔离的 `server/src/index.js` 实例（临时 `DATA_DIR` / SQLite，开启 `AUTO_INTAKE_ENABLED=true`，真实调用 `.env` 中配置的模型网关，不读取/修改真实用户库）。
   - 脚本按「多轮时间线」用 `nodemailer` 通过本地 SMTP 真正发出模拟邮件，然后调用 `/api/v1/mail-connections/:id/sync` 触发生产级同步，逐轮核验 SQLite、API 与前端页面结果。
2. **可选模式：`--live-smtp` 真实测试邮箱联调**
   - 复用现有 `mail-selftest` 机制，将同一批脱敏合成模板邮件经真实 SMTP 发往白名单测试邮箱（主题带隔离批次标签，避免与真实个人求职信混淆），等待收信后触发真实 IMAP 同步验收。
   - **安全红线**：绝不将真实个人邮件正文、邮箱密码或授权码写入仓库与报告。

## 2. 模拟邮件语料库设计（36–40 封，量化真实泛化性）

为避免“只测自己写过的正则模板”，语料库必须严格拆分为：
- **已知回归子集（约 30%）**：覆盖历史上出现过的典型坑点（如 `95555`、欧莱雅复合标题、网易测评免责声明页脚、面试改期“时间不合适”、自发 `Tounar`/`帮你理` 邮件）。
- **全新未见泛化子集（约 70%）**：使用代码中**从未硬编码过的公司、域名、句式、HTML 表格与英文模板**，专门检验大模型的真实泛化能力。

### 2.1 五大测试分组

| 分组 | 建议数量 | 覆盖的真实邮件形态 | 核心验证点 |
|---|---:|---|---|
| **A. 互联网与科技公司（中/英文）** | 7 封 | HTML 表格排版（岗位/城市在 `<table>` 内）、长邮件（真实公司名仅出现在 5000 字后的落款）、无冒号自然语言正文、中英混排岗位名（如 `Software Engineer Intern`） | 正文首尾拼接不丢落款；HTML 表格字段不粘连；准确提取公司、岗位、城市（仅城市名，不含详细街道） |
| **B. 银行 / 国企 / 央企 / 传统名企** | 7 封 | 未映射的纯数字发件人（如 `95588` 工商银行、`95533` 建设银行 + `95555` 招商银行）、复合粘连标题（如 `2027联合利华管理培训生测评通知`、`【2027届中兴通讯财经管培生】笔试安排`）、仅公司级统一测评/行测通知 | 不把纯数字或整串标题当公司名；未硬编码的新数字发件人能从正文识别真实雇主；复合标题正确拆出批次/公司/岗位 |
| **C. ATS 代发 / 测评平台 / 外企英文** | 7 封 | 发件人为 `noreply@mokahr.com`、`hr@beisen.com`、`assessments@shl.com`、`no-reply@hirevue.com`、`recruitment@myworkday.com` 等代发平台；外企全英文流程（`Application Received` / `HackerRank Coding Challenge` / `Superday Interview Invitation` / `Offer Letter` / `Unfortunately not moving forward`） | 绝不把 `Moka`、`北森`、`SHL`、`HireVue`、`recruitment` 当作公司名；外企英文全状态准确映射 |
| **D. 多轮状态演进与对抗边界（分轮发信）** | 9 封 | ① 同一岗位按 5 轮依次发送：`投递成功 → 在线测评 → 一面邀请（带时间） → 一面改期（含“如该时间不合适请联系改期”） → 终面/Offer`；② 乱序迟到旧回执（已有面试后补发更早时间的投递成功）；③ 同公司已有岗位 A，新发岗位 B 测评；④ 同公司多岗且无岗位名；⑤ 第 1 轮公司级无岗位测评建账/进待确认 → 第 2 轮带明确岗位名一面邮件到达 | 状态逐轮推进且台账仅保留 1 条记录；改期不误判拒信；旧回执不回退；同公司新岗位自动新建；多岗无岗位名进待确认；占位岗位自动升级且旧 `open` 待确认自动消解 |
| **E. 强负样本与噪声干扰** | 8 封 | 自身产品提醒信与登录验证码（`Tounar` / `帮你理`）、空中宣讲会邀请、校招流程科普文、单纯内推成功确认、岗位推荐周报、`Re:` / `Fwd:` 转发讨论线程、银行消费账单、快递/验证码/课程广告 | 100% 拦截，**零误入「投递明细」**、**零产生脏公司名** |

### 2.2 每封样本的标准标注 Schema

语料文件建议放在 `tests/fixtures/mail-generalization-corpus.json`（纯合成脱敏数据，无任何真实隐私），每条样本包含：

```json
{
  "id": "unseen_icbc_numeric_sender",
  "split": "unseen",
  "group": "B_bank_soe",
  "round": 1,
  "send_at": "2026-11-10T02:00:00.000Z",
  "from_name": "95588",
  "from_address": "95588@icbc.com.cn",
  "subject": "【2027校园招聘】在线笔试通知",
  "mime_type": "multipart/alternative",
  "text_body": "...",
  "html_body": "...",
  "expected": {
    "action": "created",
    "company_name": "中国工商银行",
    "company_aliases": ["工商银行", "中国工商银行"],
    "job_title": "金融科技岗",
    "status": "assessment",
    "recruitment_batch": "2027",
    "location": "上海",
    "should_leave_open_review": false
  }
}
```

## 3. 全链路执行流程设计（`tools/run-mail-e2e-benchmark.mjs`）

建议新增一条独立脚本与 npm 命令（例如 `"bench:mail-e2e": "node --env-file-if-exists .env tools/run-mail-e2e-benchmark.mjs"`），执行流程如下：

1. **环境初始化（全隔离）**
   - 在 `.tmp/mail-e2e-benchmark/<timestamp>/` 创建临时 `DATA_DIR` 和 SQLite，不碰真实库与 4324 副本。
   - 启动本地 SMTP + 本地 IMAP 测试服务，记录动态端口。
   - 启动被测应用 `server/src/index.js`（注入 `IMAP_HOST=127.0.0.1`、`IMAP_PORT=<动态端口>`、`AUTO_INTAKE_ENABLED=true` 及 `.env` 模型配置），校验 `/api/v1/health` 返回 `200`。
   - 创建测试账号并调用真实接口绑定邮箱连接（走完整加密存储与 `mail_connections` 流程）。
2. **分轮发信与真实同步（Round 1 → Round N）**
   - 按样本的 `round` 分组依次执行：
     - 用 `nodemailer` 通过本地 SMTP 发送本轮所有邮件（真实生成 MIME 头部、HTML/Text 多段正文与编码）。
     - 调用 `POST /api/v1/mail-connections/:id/sync` 触发生产同步，轮询 `GET /api/v1/mail-connections/:id` 直至状态回到 `connected`（或报错退出），记录本轮耗时、扫描数、进度是否达 100%、错误数。
   - 每轮同步后，拉取 `GET /api/v1/ledger?view=applied`、`GET /api/v1/reviews` 及 `ai_ingest_runs`，记录每封邮件的实际路由结果与最终台账快照。
3. **最终前端呈现抽检（Playwright 无头验收）**
   - 全部轮次结束后，用 Playwright 打开隔离实例前端首页，验证：
     - 主表固定 5 列（`公司 / 岗位 / 状态 / 已投天数 / 更新时间`），无顶部四标签栏；
     - 自动入账的记录状态色块、天数、`YYYY-MM-DD` 渲染正常；
     - 打开「待确认」视图，核对前端展示条数与接口一致，且无任何已入账岗位的重复残留。
   - 截图保存到 `.tmp/mail-e2e-benchmark/<timestamp>/`（不提交进 git）。
4. **清理退出**
   - 优雅停止本地 SMTP/IMAP 服务与被测应用进程，保留 JSON/Markdown 评测报告。

## 4. 泛化性量化指标与验收门槛

脚本执行完毕后自动输出 `.tmp/mail-e2e-benchmark-report.json` 与 `.tmp/mail-e2e-benchmark-report.md`，必须包含**整体指标**与**「未见泛化集（unseen）」单独指标**：

| 指标 | 定义 | 通过门槛 |
|---|---|---:|
| **有效进展召回率（Recall）** | 期望入账或转待确认的真实招聘邮件中，未被误忽略的比例 | **≥ 92%**（未见集 ≥ 90%） |
| **负样本拦截率（Specificity）** | E 组噪声/自身/非进展邮件未误进「投递明细」的比例 | **100%**（零误入账） |
| **公司名识别准确率** | 自动入账记录中，公司名命中期望名称或合法别名、且无脏词/数字/ATS 平台名的比例 | **≥ 92%**（未见集 ≥ 88%） |
| **岗位名识别准确率** | 邮件原文给出明确岗位名时，正确提取且未粘连批次/阶段词的比例 | **≥ 85%**（未见集 ≥ 80%） |
| **状态与多轮推进准确率** | 最终状态与期望完全一致的比例 | **≥ 92%** |
| **高危回归零容忍项** | ① 状态错误回退数；② 面试改期误判拒信数；③ 已自动入账但仍在 `open` 待确认中的重复数；④ `MAIL_STAGE_CONFLICT` 导致同步中断次数 | **全部必须为 0** |

### 失败归因明细表（报告必含）

报告需自动列出每条未达预期的样本，并标明卡在哪一环，方便定向优化：
- `stage_failed`：`imap_decode` / `header_filter（漏召回）` / `entity_extract（公司或岗位错）` / `status_judge（状态错）` / `matching（归属错）` / `review_dedup（待确认未消解）`
- 对比展示：`expected` vs `actual` + 模型返回的 `reason_code` / `uncertainties`。

## 5. 实施步骤与回归要求

1. **构建本地 SMTP + IMAP 闭环工具**：复用 `server/test/mail.test.js` 的测试 IMAP 能力并补齐标准 SMTP 投递 + 多段 MIME（HTML/Text/中文编码）支持，使发信和读信彻底走真实协议。
2. **编写 36–40 封脱敏语料库**：落盘至 `tests/fixtures/mail-generalization-corpus.json`，确保 `unseen` 未见泛化集占比 ≥ 70%。
3. **实现 `tools/run-mail-e2e-benchmark.mjs` 并注册 `npm run bench:mail-e2e`**：串联多轮发信 → 真实同步 → 指标打分 → Playwright 抽检 → 报告输出。
4. **实跑一轮并输出真实泛化基线报告**：
   - 使用当前 `300f396` 代码与真实大模型跑完完整一轮，**如实汇报每一项指标与失败样本归因**（不通过删样本或放宽断言粉饰分数）；
   - 如发现共性泛化短板（例如某类 HTML 表格、英文状态或城市字段抽取偏弱），在报告中给出明确的下一轮修复优先级建议。
5. **不破坏既有功能与回归检查**：
   - 本方案新增脚本、夹具与报告工具，不得修改影响现有功能的业务契约；
   - 完成后跑通 `npm run test:web`、`npm run test:e2e`、`npm run test:intake`、`npm run test:mail-progress` 及重点邮件单测，确认全绿且工作区无 `.tmp/` 临时文件入库。
