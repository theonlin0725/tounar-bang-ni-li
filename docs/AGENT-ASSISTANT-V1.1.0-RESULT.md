# v1.1.0 AI 求职助手实现结果

**日期**：2026-11-22
**分支**：`tounar-1.1.0`
**基线**：`tounar-1.0.0` / `v1.0.0`（未修改）

## 1. 已实现

### 数据与编排

- 新增 `agent_sessions`、`agent_messages`、`agent_tool_runs`、`agent_pending_actions` 四张表；仅增量建表。
- `resumes` 增量列：`parent_resume_id`、`target_application_id`、`rewrite_summary_json`；`ai_reports.interview_result_json` 持久化面试题缓存。
- Agent 模型配置优先级：`AGENT_*` → `OPENROUTER_*` → `AI_*`；OpenRouter 携带 `HTTP-Referer` / `X-Title`。
- 单轮最多 6 次工具调用；工具原始输出只写 `agent_tool_runs`，不写入 `agent_messages.content`。
- SSE 事件：`status` / `message` / `done` / `error`；前端只展示单行状态与自然语言结论。

### 8 项工具

1. `search_jobs`
2. `filter_applications`（新增 `applied_from` / `applied_to` / `inactive_days` 筛选）
3. `get_job_detail`
4. `compare_jobs`
5. `analyze_match`（复用/新建 `ai_reports(kind=match)`）
6. `generate_interview_questions`
7. `update_status`（只生成待确认单，确认时逐条校验 expected_version）
8. `rewrite_resume`（按目标 JD 生成逐段改写方案，确认后新建 `resumes` 版本）

### 前端

- 左侧「AI 助手」入口，支持欢迎卡、快捷任务、历史会话、上下文切换、SSE 状态、自然语言结论与引用链接。
- 状态修改/简历改写显示确认卡；确认后触发 `tounar:data-changed`/角标刷新。
- 岗位详情、匹配报告增加「问 AI 助手」快捷入口。
- 390px 移动端卡片与输入区适配。

## 2. 验证

- `npm run test:agent`：服务端 10 + 4 + 4 + 2 项（Agent 业务/真实函数调用循环/匹配与面试题/配置优先级）+ Playwright 12 项通过。
- `npm test`：248 条中 247 条通过；仅既有 `cloud-persistence` 云快照用例出现环境性失败（此前 `cloud-persistence-http` 也会间歇出现）；新增 Agent 测试全部通过。
- `agent-openai-loop.test.js` 使用真实 OpenAI 兼容 HTTP mock，验证 tool_calls 解析、最多 6 步、切岗后旧 JD 不进入模型上下文。
- `agent-tools-match.test.js` 使用模拟 career-ai 网关，验证六维匹配复用、面试题持久化与无报告时自动匹配。
- `agent-config.test.js` 验证 OpenRouter-only 配置同时供 Agent 与 career-ai 使用。
- `npm run test:web`：74/74。
- `npm run test:e2e`：67/67。
- `npm run test:career-ai`：51/51。
- `npm run test:panel`：8/8；`test:netease-game`：60/60；`test:self-page`：6/6；`test:intake`、`test:mail-progress`、`test:mail-admin` 通过。

Agent E2E 报告：`.tmp/agent-e2e/agent-e2e-report.json`
截图：`.tmp/agent-e2e/assistant-desktop.png`、`assistant-mobile.png`、`resume-rewrite-source.png`

## 3. OpenRouter 实测

脚本：`tools/smoke-agent-openrouter.mjs`

```bash
OPENROUTER_API_KEY=... OPENROUTER_MODEL=google/gemini-2.5-flash \
  node tools/smoke-agent-openrouter.mjs
```

本轮开发环境没有 `OPENROUTER_API_KEY`，因此真实 OpenRouter 四场景标记为 **BLOCKED**，报告写入 `.tmp/agent-openrouter-smoke.md`；没有打印或提交任何 key。

## 4. 边界

- `test:agent` 的浏览器 E2E 使用 `AGENT_FAKE_MODE=true` 的确定性模型；服务端另用真实 OpenAI 兼容 HTTP mock 覆盖 tool_calls/6 步上限/上下文隔离，API、工具、SQLite、SSE 和 Playwright 都走真实代码。
- 真实 OpenRouter 需要支持 Function Calling 的模型；需要用户提供 key 后执行 smoke 脚本。
- 简历改写仍依赖原简历事实；服务端强制创建新版本，不覆盖原简历。
- 未开发：求职画像、投递策略分析、自定义提醒天数、独立多轮记忆压缩（当前仅保留最近消息与会话级上下文摘要字段）。
