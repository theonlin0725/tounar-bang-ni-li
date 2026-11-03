# 招聘进展自动入账工作流（2026-11-01）

## 1. 本轮问题

核查 4311 固定自测库时，open 待确认 50 条，主要来自：

- 邮件进展匹配不到唯一岗位：17 条；
- 同一岗位链接出现不同内容，身份不确定：13 条；
- 浏览字段不完整：8 条；
- 笔试/面试拆分：2 条；
- 表单填写无法归属：2 条。

旧逻辑的主要限制不是“阈值太高”，而是：

- 规则分类结果直接驱动建账/待确认，缺少独立的内容真伪与岗位归属判断；
- 邮件候选主要依赖公司/岗位文本，未把“是否本人实际进展”“新旧”“流程说明”分开问；
- 旧证据可能按处理顺序覆盖新状态；
- 终态一律要求人工确认，清晰录用/拒绝也无法自动更新；
- 摘要字段缺失会把浏览记录推进待确认。

## 2. 新链路

```text
插件 / 邮件
  → 清洗、去重、来源校验
  → LLM 提取结构化字段 + 逐字证据
  → 查询候选台账
  → Jev System One 判断（实际进展 / 阶段 / 证据 / 新旧 / 岗位归属）
  → 服务端执行人工保护、时间、终态、冲突、幂等校验
  → 自动创建 / 自动更新 / 无需变更 / 待确认
  → 前端轮询 data_revision 同步
```

### 2.1 LLM：只提取，不决定入账

`server/src/modules/recruitment-intake/llm.js` 调用 `.env` 的 OpenAI 兼容网关（当前 `AI_API_URL=https://api.deepseek.com`、`AI_MODEL=deepseek-flash`）。输出严格 JSON：

- 公司、岗位、批次、申请编号、岗位链接；
- 事件时间（只在原文明确时）；
- 状态候选；
- 内容角色：实际进展 / 流程说明 / 广告 / 转发或历史引用 / 其他；
- 证据 quotes（必须逐字出现在原文；服务端会过滤不匹配项）；
- 不确定项。

缺失字段保持 `null`，不根据常识补造。公司/岗位为空不会自动创建占位值。

### 2.2 Jev：独立、类型化判断

`server/src/modules/recruitment-intake/jev.js` 直接调用 TypeSafe Jev：

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $JEV_API_KEY
{
  "model": "jev-latest",
  "state": { "subject": "...", "body_text": "...", "extracted": {...}, "candidates": [...] },
  "questions": { ... }
}
```

问题不是一段普通“Judge prompt”，而是：

- `actual_progress`（Noul）：是否本人已发生的招聘进展；收到笔试/测评/面试邀请也算进展，流程说明/广告/转发不算；
- `status`（Choice）：已投递/笔试测评/面试/录用/拒绝/关闭/无法判断；
- `evidence_support`（Noul）：原文是否直接支持该判断；
- `newness`（Choice）：新进展/重复或旧信息/无法判断；
- `candidate`（Choice）：`c0…cN` 之一，或 `no_match` / `uncertain`，不强迫选岗位。

实际接口返回 `noul`、`choice`、`confidence`、`probabilities`；本项目使用 `jev-1.14.0`（`jev-latest` 当前解析版本），保留 request/usage/model 到审计表。官方文档：<https://docs.typesafe.ai/introduction>。

### 2.3 服务端最终决策

`server/src/modules/recruitment-intake/workflow.js` 只在以下条件同时满足时自动写入：

- Jev `actual_progress` 和 `evidence_support` 达到阈值；
- 阶段明确且 `status.confidence` 达到阈值；录用/拒绝/关闭另有更高阈值；
- 内容角色不是广告/转发；流程说明只有 Jev 高度确认为实际进展时才进入复核，不自动写入；
- 候选岗位选择明确且 `candidate.confidence` 达到阈值；`uncertain` 或同公司多候选进入待确认；
- 当前记录是终态时，不同阶段进入终态冲突待确认；
- 用户手动修改时间晚于证据时间时，直接 no-op，不覆盖、不制造待确认；
- 事件时间早于当前状态时间时 no-op；
- 候选/旧状态明确不重复创建；重复事件由 UID/hash 和状态 no-op 双重保护。

新建只在“有可追溯身份”时发生：稳定申请/岗位 ID、岗位 URL，或公司+岗位 / 公司+批次 / 岗位+批次。自 2026-11-01 起，人工确认入账也必须有有效公司、岗位；空白记录只能保留/补录，不能新建空白台账。

Jev/LLM 技术失败（超时、鉴权失败、5xx、非法 JSON）不会创建待确认，而是：

1. `ai_ingest_runs.status='retry'`；
2. 事件保持 `pending`，`review_reason='AI_PIPELINE_RETRY'`；
3. 调度器每轮尝试 `retryPendingIntakes`，默认 5 分钟后重试；
4. 超过可配置阈值仍失败时保留 pending，原状态不变。

### 2.4 接入原流程

- 邮件同步：`modules/data-capture/mail/sync.js` 对疑似招聘邮件调用 `processIntakeEvent`；自动启用时不再走旧的 WorkBuddy 分类兜底。
- 插件官网状态：`site_status_observed` 在服务端先返回 accepted，随后异步走同一工作流；`job_viewed` / `application_submitted` 继续使用强证据规则。
- 前端：台账继续用 data_revision 轮询；自动更新后统计、状态、提醒候选随之刷新；无需用户先打开待确认。

## 3. 人工状态修改与保护

- 表格状态列直接下拉编辑，调用 `POST /api/v1/applications/:id/status`；
- 支持现有状态：已投递、笔试/测评、面试、录用、拒绝、结束；不新增前后端不一致的状态字符串；
- 写入 `application_history`（from/to、修改时间、`source_method='manual'`、原因）和 `manual_status_at`；
- 旧证据时间 ≤ `manual_status_at`：直接 no-op；
- 新证据时间 > `manual_status_at`：允许自动更新，并清除 `manual_status_at`，不会永久锁死；
- 终态冲突仍进待确认；用户可以在表格/详情继续人工纠正。

## 4. 前端精简

- 待确认卡片只剩「确认入账 / 忽略」；确认先走 LLM+Jev 识别，缺失/歧义才弹补录，取消保持待确认；
- 默认看过没投；公司/岗位可以不填；
- 标题有安全原网页链接时标题本身是链接；没有链接保持普通文本；
- 无独立“打开原网页”按钮；
- 忽略立即生效，无二次确认；
- 投递明细/看过没投删除重复“投递链接”列，只保留“查看岗位”，始终链接 `job_url`，不再显示申请状态页/回退文案；
- 状态编辑保存失败保留原状态并提示。

## 5. 审计与数据表

`ai_ingest_runs` 记录：

- `event_id/source_method/status/attempts`；
- `llm_model/jev_model/rule_version='auto-intake-v1'`；
- `extraction_json/jev_json`（含证据、概率、候选）；
- `decision/reason_code/application_id/before_status/after_status`；
- `error_code/error_message/next_retry_at`。

原始事件仍在 `events`；邮件正文只保留 AI 所需的有界片段，不复制原始文件。删除用户数据时一并删除 `ai_ingest_runs`、`ai_reports`、`resumes`。

## 6. 配置

```bash
AI_API_URL=https://api.deepseek.com
AI_API_KEY=...
AI_MODEL=deepseek-flash
JEV_API_URL=https://api.typesafe.ai/v1/systemone
JEV_API_KEY=...
JEV_MODEL=jev-latest
AUTO_INTAKE_ENABLED=true
AUTO_INTAKE_MIN_PROGRESS=0.72
AUTO_INTAKE_MIN_EVIDENCE=0.65
AUTO_INTAKE_MIN_STATUS=0.60
AUTO_INTAKE_MIN_CANDIDATE=0.60
AUTO_INTAKE_MIN_TERMINAL=0.85
AUTO_INTAKE_RETRY_MINUTES=5
JEV_TIMEOUT_MS=30000
```

没有 AI/Jev 凭据时默认关闭，回到既有规则路径；显式开启但没有凭据会进入重试/失败审计，不会伪造结果。

## 7. 真实模型样本评估

样本：8 条**合成中文招聘邮件**，覆盖面试更新、测评新建、录用、拒绝、流程说明、同公司多候选、广告、旧事件。每条有一个人工标签；使用真实 DeepSeek + Jev，运行在 `.tmp/intake-eval` 隔离库，不读取用户数据。

最近一次结果：

| 指标 | 数值 |
|---|---:|
| 样本数 | 8 |
| 自动更新/创建 | 4 |
| 自动结果正确 | 4/4（100%，仅本次小样本） |
| 自动覆盖全部样本 | 4/8（50%） |
| 可自动样本覆盖 | 4/4（100%） |
| 待确认 | 1（12.5%） |
| 非招聘/流程/旧信息过滤 | 3 |
| 技术失败 | 0 |
| 错误状态更新 | 0 |
| 错误岗位匹配 | 0 |

明细：面试更新、测评新建、录用、拒绝 4 条自动；流程说明、广告、旧事件 3 条忽略；同公司两候选 1 条待确认。原始结果：[AUTO-INTAKE-EVAL-20261101.json](AUTO-INTAKE-EVAL-20261101.json)。旧事件在“把握度低”之前先做时间/重复 no-op，避免旧邮件重新变成用户任务。

限制：样本均为合成邮件、样本量很小、只跑一次；未覆盖真实 QQ 正文截断、附件、多语言、真实 IMAP 延迟、长线程和模型重复稳定性。真实邮件头-only 的明确面试/笔试邀请会保留为待确认（不计作非进展）。因此上述 100% 不是生产精准率承诺。

复现：

```bash
node --env-file-if-exists .env tools/eval-intake.mjs
```

## 8. 未完成/边界

- 2026-11-01 已对当时 28 条 open 待确认做一次定向补救：19 条自身页面/无信息忽略、1 条新建、2 条邮件非进展忽略、2 条只有邮件头的有效进展恢复保留、6 条真实歧义保留；0 失败。详见[清理对账](PENDING-REMEDIATION-20261101.md)。
- 没有真实 IMAP/QQ 邮箱的端到端联调；当前用隔离样本验证模型链路。
- 没有 Dify；直接用后端编排，减少一层工作流运行时。若需要 Dify，可替换 `llm.js`/`jev.js` 的调用层，服务端校验/审计/前端不变。
- 没有对真实用户邮件做准确率承诺；上线后应持续保存人工纠正样本，按周重算自动准确率、覆盖率、待确认比例和错误更新数。
