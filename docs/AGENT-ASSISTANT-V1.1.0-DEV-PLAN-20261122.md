# Tounar 帮你理 v1.1.0：AI 求职助手（Agent 对话工作台）开发方案

**日期**：2026-11-22
**基线版本**：`tounar-1.0.0`（`a77d740` / `v1.0.0`，严格封板，**不得修改或覆盖**）
**开发分支**：`tounar-1.1.0`（基于 `tounar-1.0.0` 新建，版本号升级为 `1.1.0`）
**核心目标**：在完全不影响 `v1.0.0` 既有功能的前提下，上线「AI 求职助手」对话工作台，打通 **7 项既有业务底座能力 + 1 项新建「AI 按 JD 定向改写简历」能力（共 8 大功能）**，实现前后端实时上下文联动、轻量状态反馈、受控写操作二次确认，并支持直连环境变量中的 OpenRouter API Key 完成真实模型联调。

---

## 1. 版本隔离与功能边界

### 1.1 分支与版本红线
- **严禁改动 `tounar-1.0.0` 分支与 `v1.0.0` 标签**。
- 基于 `tounar-1.0.0` 新建开发分支 **`tounar-1.1.0`**；`package.json`、`package-lock.json` 与 `server/src/config.js` 默认 `appVersion` 升级为 `1.1.0`。
- 数据库仅做向后兼容的**增量建表与增量加列**，不修改任何 `1.0.0` 已有表结构与 API 契约。

### 1.2 本期范围（严格锁定 8 大功能，其余 3 项挂起）

| 序号 | 功能模块 | 类型 | 核心能力说明 |
|---|---|---|---|
| **1** | **自然语言查台账与筛选** | 复用底座 | 按状态、来源、关键词、投递时间范围（补 `applied_from/applied_to`）、超期未反馈等条件检索台账 |
| **2** | **单岗位详情与 JD 问答** | 复用底座 | 读取岗位完整 JD、轮次、进展历史与来源，回答岗位要求与准备建议 |
| **3** | **多岗位横向对比与排序** | 复用底座 | 读取多个岗位详情与已有匹配报告，在对话层输出结构化对比与优先级排序 |
| **4** | **单岗位六维匹配分析** | 复用底座 | 触发或复用 `ai_reports` 缓存执行单岗位匹配，输出核心短板与报告直达链接 |
| **5** | **面试题与答题框架生成** | 复用底座 | 基于匹配报告缺口生成高频面试题与答题思路并持久化到 `ai_reports` |
| **6** | **单条/批量修改投递状态** | 复用底座 + 封装 | 先展示写操作确认卡，确认后逐条校验 `expected_version` 乐观锁并落库写审计日志 |
| **7** | **跨页实时上下文与分层记忆** | 新建编排与前端 | 左侧「AI 助手」主入口 + 详情/匹配页快捷唤起；实时同步当前简历/岗位、切岗隔离旧 JD、写后自动刷新业务页 |
| **8** | **AI 按 JD 定向改写简历** | **唯一新建业务板块** | 按目标岗位 JD + 匹配缺口生成逐段改写对比建议，确认后在 `resumes` **生成新简历版本**（严禁覆盖原简历） |

> **本期明确挂起（不做）**：① 独立求职画像（`user_profiles` / `get_profile` / `update_profile`）；② 投递策略转化漏斗（`analyze_strategy`）；③ 单岗位自定义提醒天数。因此前端欢迎卡与底部上下文条**不展示“画像已确认”胶囊**，仅展示真实存在的简历与岗位上下文。

---

## 2. 数据模型增量设计（`server/src/schema.sql` & `db.js`）

### 2.1 新增 4 张 Agent 表

1. **`agent_sessions`**（对话会话）
   - `id TEXT PRIMARY KEY`、`owner_id TEXT NOT NULL`、`title TEXT`
   - `context_resume_id TEXT`（当前绑定简历 ID）、`context_application_id TEXT`（当前聚焦岗位 ID，可空表示“全部”）
   - `summary_text TEXT`（长会话压缩摘要）
   - `created_at TEXT`、`updated_at TEXT`、`archived_at TEXT`
2. **`agent_messages`**（对话消息）
   - `id TEXT PRIMARY KEY`、`session_id TEXT NOT NULL`、`owner_id TEXT NOT NULL`
   - `role TEXT NOT NULL`（`user` / `assistant` / `context_boundary`）
   - `content TEXT NOT NULL`（自然语言正文，**不存工具原始 JSON**）
   - `meta_json TEXT`（轻量状态标签、引用实体链接 `[{type,id,label}]`、追问建议芯片 `suggestions`、权限标 `read_only` / `has_pending_write`）
   - `created_at TEXT`
3. **`agent_tool_runs`**（幕后工具审计日志，前端默认不展示）
   - `id TEXT PRIMARY KEY`、`session_id TEXT`、`message_id TEXT`、`owner_id TEXT NOT NULL`
   - `tool_name TEXT NOT NULL`、`input_json TEXT`、`output_summary_json TEXT`
   - `status TEXT`（`ok` / `error`）、`latency_ms INTEGER`、`prompt_tokens INTEGER`、`completion_tokens INTEGER`
   - `created_at TEXT`（大体积明细按 30 天定期清理，避免 SQLite 膨胀）
4. **`agent_pending_actions`**（受控写操作确认单）
   - `id TEXT PRIMARY KEY`、`session_id TEXT NOT NULL`、`message_id TEXT`、`owner_id TEXT NOT NULL`
   - `action_type TEXT NOT NULL`（`update_status` / `rewrite_resume`）
   - `payload_json TEXT NOT NULL`（含目标记录列表、每条 `expected_version`、改写后的完整文本与逐段 diff）
   - `summary_json TEXT NOT NULL`（供前端确认卡渲染的摘要信息）
   - `status TEXT NOT NULL DEFAULT 'pending'`（`pending` / `confirmed` / `cancelled` / `expired` / `failed`）
   - `result_json TEXT`、`expires_at TEXT NOT NULL`、`created_at TEXT`、`resolved_at TEXT`

### 2.2 `resumes` 表向后兼容增量加列（在 `db.js` `migrate()` 中执行）

- `parent_resume_id TEXT`：指向被改写的原始简历版本 ID；
- `target_application_id TEXT`：指向本次定向改写所针对的岗位 ID；
- `rewrite_summary_json TEXT`：记录本次改写的逐段对比摘要与对应 JD 依据，供简历库查看来源。

---

## 3. OpenRouter 模型接入与 Agent 编排架构

### 3.1 模型配置优先级（`server/src/config.js` & `server/src/modules/agent/llm.js`）

Agent 网关采用标准 OpenAI Chat Completions + Function Calling（`tools` / `tool_calls`）协议，配置按以下优先级读取（全部为服务端环境变量，严禁暴露给前端或写入仓库）：

1. 显式 Agent 配置：`AGENT_API_URL` / `AGENT_API_KEY` / `AGENT_MODEL`；
2. **OpenRouter 环境变量（本轮 API 测试默认通道）**：检测到 `OPENROUTER_API_KEY` 时，自动路由到 `OPENROUTER_API_URL`（默认 `https://openrouter.ai/api/v1/chat/completions`），模型取 `AGENT_MODEL || OPENROUTER_MODEL || AI_MODEL`（需支持 Function Calling，如 `google/gemini-2.5-flash` / `deepseek/deepseek-chat` / `openai/gpt-4o-mini` 等），并附带 `HTTP-Referer` 与 `X-Title: Tounar BangNiLi` 请求头；
3. 回退现有 `AI_API_URL` / `AI_API_KEY` / `AI_MODEL`。

同时在 `.env.example` 中补充 `OPENROUTER_API_KEY`、`OPENROUTER_API_URL`、`OPENROUTER_MODEL`、`AGENT_MODEL` 注释模板（不填任何真实 key）。

### 3.2 幕后工具编排与轻量状态流（`server/src/modules/agent/orchestrator.js`）

1. **多轮 Tool Use 循环**：
   - 系统 Prompt 注入当前会话的 `AgentContext`（当前简历概要、当前聚焦岗位概要、台账统计），**绝不把其他无关岗位的 JD 塞进上下文**；
   - 单次用户提问最多允许 `maxSteps = 6` 次工具调用，防止模型死循环；
   - 工具原始结果仅在当轮推理中喂给 LLM，写入 `agent_tool_runs`，**不写入 `agent_messages.content`**，避免后续轮次 Token 膨胀。
2. **SSE 实时轻量状态推送**：
   - `POST /api/v1/agent/sessions/:id/chat` 采用 SSE（`text/event-stream`）流式返回事件：
     - `event: status` → 推送单行轻量状态文案（如 `正在筛选投递台账…`、`正在读取字节跳动岗位详情…`、`正在生成简历改写方案…`）；
     - `event: delta` / `event: message` → 返回整合后的自然语言回答、实体链接、追问芯片与（若有写操作）待确认卡；
     - `event: done` → 返回 `mutated_entities`（如 `["applications"]` / `["resumes"]`）与最新 `data_revision`。
   - **严格遵守展示约定**：前端只在执行过程中展示单行轻量状态文案，**完成后收起，绝不展示工具结果卡片、调用参数或完整步骤列表**。

---

## 4. 八大工具契约与写操作安全规范

### 4.1 工具清单与存储去向

| 工具名 | 权限 | 底层服务复用 / 新建 | 数据去向 |
|---|---|---|---|
| `search_jobs` | 只读 | 复用 `/api/v1/application-search` | 仅入本轮上下文 + `agent_tool_runs` |
| `filter_applications` | 只读 | 复用 `ledgerResponse()`（在 `server/src/domain/ledger.js` 增量支持 `applied_from`、`applied_to`、`inactive_days`） | 仅入本轮上下文 + `agent_tool_runs` |
| `get_job_detail` | 只读 | 复用 `applicationDetail()` | 仅入本轮上下文 + `agent_tool_runs` |
| `compare_jobs` | 只读 | 读取 2–5 个岗位详情与已有 `ai_reports(kind='match')` 在编排层结构化对比 | 仅入本轮上下文 + `agent_tool_runs` |
| `analyze_match` | 只读分析 | 复用 `matchApplication()`（同简历同岗位已有 `ready` 报告时优先复用，支持 `force: true` 重算） | 落盘 `ai_reports (kind='match')` |
| `generate_interview_questions` | 只读生成 | 复用 `interviewQuestionsForReport()`（若该岗尚无匹配报告，先自动触发 `analyze_match` 再出题） | 落盘 `ai_reports` 关联面试题 |
| `update_status` | **确认后写入** | 复用 `setApplicationStatusManually()`，外包 `agent_pending_actions` 批量动作单 | `agent_pending_actions` → `applications` + `application_history` + `audit_log(actor='agent_confirmed')` |
| `rewrite_resume` | **确认后写入（新建）** | 新建 `server/src/modules/career-ai/rewrite.js` + `agent_pending_actions` 确认单 | `agent_pending_actions` → `resumes` **新建版本行**（保留原简历）+ `audit_log` |

### 4.2 新建模块详设：`rewrite_resume`（AI 按 JD 定向改写简历）

1. **生成阶段（不写库）**：
   - 输入：`application_id`（必填，未指定时 Agent 先反问澄清或使用当前上下文岗位）、`resume_id`（默认取当前上下文/当前激活简历）、可选用户侧重要求（如“突出数据分析与项目量化结果”）。
   - 读取原始简历全文 + 目标岗位完整 JD + 若存在匹配报告则附带匹配缺口。
   - 调用模型生成结构化改写方案：
     - `version_label`（如 `原简历名 · 字节跳动-产品经理定向版`）；
     - `sections`：逐段对比列表（`section_name`、`original_excerpt`、`rewritten_excerpt`、`reason`、`jd_evidence`）；
     - `full_rewritten_text`：可直接落库的完整新版简历文本；
     - **严禁编造虚假学历、公司或项目经历**（Prompt 硬约束：仅基于原简历事实做表述优化、结构重排与关键词对齐）。
   - 写入 `agent_pending_actions (action_type='rewrite_resume')`，返回确认卡（展示目标岗位、原简历版本、改写段落数、关键改动预览、是否同时设为当前简历勾选框、`[取消]` `[保存为新版本]`）。
2. **确认落库阶段**：
   - 用户点击 `[保存为新版本]` 后，调用 `POST /api/v1/agent/actions/:id/confirm`；
   - 经 `createResumeFromText()` 统一服务在 `resumes` 新增一条记录，写入 `parent_resume_id`、`target_application_id`、`rewrite_summary_json`，**原始简历保持只读不被覆盖**；
   - 若用户勾选“设为当前简历”，调用 `setCurrentResume()` 切换并同步刷新前端上下文条与「简历库」。

### 4.3 批量/单条改状态二次确认规范（`update_status`）

- 确认卡展示：操作类型（单条/批量修改状态）、命中岗位列表（公司 + 岗位 + 当前状态 → 目标状态）、影响数量、风险提示（如终态变更提示）、`[取消]` `[确认执行]`。
- 用户确认后后端执行：
  1. 校验动作单 `status === 'pending'`、未过期（默认 15 分钟）且走幂等键保护；
  2. **逐条重新查库比对 `expected_version`**：若记录已被用户手动或邮件同步修改，跳过该条并记录 `VERSION_CONFLICT` 原因，绝不拿过期快照覆盖；
  3. 逐条调用 `setApplicationStatusManually()`，写入 `application_history` 与 `audit_log`（`actor = 'agent_confirmed'`）；
  4. 返回成功条数、跳过条数及逐条原因，调用 `bumpRevision()` 并通知前端刷新。

---

## 5. 后端 API 路由清单（`server/src/routes/index.js` 增量注册）

| 方法与路径 | 说明 |
|---|---|
| `GET /api/v1/agent/context` | 返回当前激活简历、近期可选岗位列表、台账计数（供助手页与快捷入口初始化上下文） |
| `GET /api/v1/agent/sessions` | 获取当前用户的历史会话列表（按 `updated_at DESC`） |
| `POST /api/v1/agent/sessions` | 新建会话（可传初始 `context_resume_id`、`context_application_id`） |
| `PATCH /api/v1/agent/sessions/:id/context` | 切换当前会话绑定的简历或岗位；切换岗位时写入 `context_boundary` 隔离旧 JD |
| `DELETE /api/v1/agent/sessions/:id` | 清空/归档指定会话 |
| `GET /api/v1/agent/sessions/:id/messages` | 获取会话消息历史与仍处于 `pending` 状态的确认单 |
| `POST /api/v1/agent/sessions/:id/chat` | 发送用户消息并 SSE 流式推送轻量状态文案 + 最终自然语言回复 + 追问芯片 + 待确认卡 |
| `POST /api/v1/agent/actions/:id/confirm` | 用户显式确认执行写操作（带 `Idempotency-Key`），返回逐条执行结果与 `mutated_entities` |
| `POST /api/v1/agent/actions/:id/cancel` | 用户取消待确认写操作 |

---

## 6. 前端页面与实时交互设计（对齐参考图视觉语言）

### 6.1 入口与跨页上下文打通（`web/assets/js/app.js`、`detail.js`、`career.js`、`views/assistant.js`）

1. **左侧主导航新增入口**：在「分析」分组或独立工作区新增 **`AI 助手`**（`data-test="nav-assistant"`，路由 `/?panel=assistant`），与现有 `投递台账 / 看过没投 / 已归档 / 待确认 / 匹配分析 / 简历库 / 设置` 视觉统一。
2. **岗位详情抽屉 & 匹配分析页快捷入口**：新增「问 AI 助手」按钮，点击后携带 `application_id` 与当前 `resume_id` 跳转（或打开右侧抽屉）进入助手，并自动将当前上下文锁定为该岗位。
3. **跨页实时同步事件总线**：
   - 前端监听自定义事件 `tounar:data-changed`（载荷 `{ entities: ['applications' | 'resumes' | 'reports'], data_revision }`）；
   - 当 Agent 确认改状态或保存改写简历后，自动触发 `tounar:counts` 与对应视图静默重载，无需用户手动刷新。

### 6.2 主界面四层结构（参考设计图落地规范）

1. **顶栏区**：
   - 左侧标题 `AI 求职助手`，副标 `统一自然语言入口 · 可查询、可分析、可受控写入`；
   - 右侧操作按钮：`[历史会话]`（滑出历史会话抽屉）、`[清空对话]`。
2. **欢迎与快捷任务卡（新会话展开，发出首条消息后可自动折叠为紧凑模式）**：
   - 问候语 `你好，我可以帮助你管理和优化求职过程。` + 实时状态胶囊（如 `9 条投递 · 2 份简历`，**不显示未开发的“画像已确认”**）；
   - 4 张横排快捷任务卡片（移动端 390px 自动 2×2 或单列堆叠）：
     - **查看本周投递情况**（台账只读查询）
     - **找出长期没有反馈的岗位**（按最近反馈时间筛选）
     - **比较两个岗位的匹配度**（六维结果横向对比）
     - **优化某个岗位的简历**（AI 按 JD 定向改写）
3. **对话消息流卡片**：
   - 卡片头部：左显示 `对话 · 会话 #<短ID> · 时间`，右显示轻量权限胶囊（`本轮仅使用只读工具` / `含待确认写操作`）；
   - **用户消息**：右对齐青绿胶囊气泡（复用 Tounar 品牌绿）；
   - **AI 消息**：左对齐，按以下极简层次呈现：
     - *执行中*：仅展示**单行轻量状态文案**（带微弱脉冲点，如 `正在查询投递台账…`），**绝不展开工具参数、返回字段或三行明细框**；
     - *完成后*：轻量状态收起，直接展示自然语言结论，涉及具体岗位/报告/新简历版本时渲染为**行内可点击链接**（点击直接打开详情抽屉、匹配报告或简历库）；
     - *若触发写操作*：在回答下方渲染**写操作确认卡**（展示影响记录与前后对比、`[取消]` `[确认执行]`；简历改写卡支持折叠查看逐段对比与勾选“设为当前简历”）；
     - *消息底部*：渲染 2–3 个轻量「继续追问」芯片（点击直接填入发送）。
4. **底部上下文条与输入区（吸底固定）**：
   - **当前上下文条**：左置 `当前上下文` 标签 + 可点击切换的 **`简历 <当前版本名>`** 胶囊 + **`岗位：<全部 / 公司·岗位>`** 胶囊；右置提示 `切换简历或岗位会同步更新本轮上下文`；
   - **输入栏**：多行自适应输入框（占位符：`输入你的问题，例如「找出超过 14 天没有反馈的岗位」或「帮我按字节这个岗改写简历」`）+ 青绿色 `[发送]` 按钮（生成中切换为 `[停止]`）。

---

## 7. 测试、OpenRouter 实测与防退化验收清单

### 7.1 单元测试与离线 E2E（默认假模型，CI 可稳定复现）
- **新增 `server/test/agent.test.js`**：
  - 覆盖 8 大工具的编排路由、只读权限隔离、最大步数保护；
  - 验证 `update_status` 未确认绝不写库、确认前记录版本变化触发 `VERSION_CONFLICT` 跳过并保留其余成功项、审计日志写入 `actor='agent_confirmed'`；
  - 验证 `rewrite_resume` 确认后在 `resumes` 生成带 `parent_resume_id` 和 `target_application_id` 的新版本，**原始简历文本与版本号零变更**；
  - 验证切岗位写入 `context_boundary` 后，新轮次不携带旧岗位 JD；
  - 验证工具原始 JSON 落盘 `agent_tool_runs` 且不写入 `agent_messages.content`。
- **新增 `tests/e2e/agent-assistant.mjs`**（注册 `npm run test:agent`）：
  - Playwright 验证桌面端 1440px 与移动端 390px 渲染、4 张快捷卡片、轻量状态文案（确认无冗余工具结果卡片）、上下文条切换简历/岗位、写操作确认卡执行后投递台账与简历库自动刷新。

### 7.2 OpenRouter 真实 API 联调验收
- 新增隔离联调脚本 `tools/smoke-agent-openrouter.mjs`（默认读取当前环境变量 `OPENROUTER_API_KEY`，使用 `.tmp/` 临时 SQLite，绝不触碰真实库、绝不打印或提交 API Key）：
  - 实测 4 条端到端真实对话：① 查超期未反馈岗位；② 单岗位六维匹配与面试题；③ 批量改状态确认流；④ 按目标 JD 定向改写简历并保存为新版本。
  - 输出脱敏验收报告至 `.tmp/agent-openrouter-smoke.md`（不入库）。

### 7.3 `v1.0.0` 防退化全量回归门禁（全部必须保持通过）
- `npm run test:agent`（新增）
- `npm run test:web`（74/74 + 新增导航断言）
- `npm run test:e2e`（67/67）
- `npm run test:career-ai`（51/51）
- `npm run test:panel`（8/8）
- `npm run test:netease-game`（60/60）
- `npm run test:self-page`（6/6）
- `npm run test:intake`（10/10）
- `npm run test:mail-progress`（6/6）
- `npm run test:mail-admin`（通过）
- `npm test`（除既有 2 条云快照环境波动外，其余全部通过且新增 `agent.test.js` 全绿）

---

## 8. 建议实施顺序（约 9–11 人天）

1. **阶段 1（基建与 OpenRouter 适配）**：切 `tounar-1.1.0` 分支 → 增量建 4 张 Agent 表与 `resumes` 改写列 → 实现 OpenRouter 兼容的 `agent/llm.js` 与 `orchestrator.js`。
2. **阶段 2（8 大工具与写确认闭环）**：接入 7 项既有底座工具 + 新建 `rewrite_resume` 服务 + 实现 `/api/v1/agent/*` 全套接口与 SSE 轻量状态流。
3. **阶段 3（前端工作台与实时联动）**：按参考图实现 `web/assets/js/views/assistant.js`、左侧导航入口、详情/匹配页快捷唤起、上下文条双向切换与跨页刷新事件总线。
4. **阶段 4（单测 + OpenRouter 实测 + 全量回归）**：跑通 `agent.test.js`、`test:agent`、OpenRouter 实测脚本与全部 1.0.0 回归套件，确认无回归后提交 `tounar-1.1.0` 分支。
