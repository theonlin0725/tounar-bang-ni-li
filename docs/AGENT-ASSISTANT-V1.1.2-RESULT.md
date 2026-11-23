# v1.1.2 AI 助手稳定性与回答质量实现结果

**日期**：2026-11-23
**分支**：`tounar-1.1.2`
**基线**：`tounar-1.1.1`（`96184a2`；未改动 `tounar-1.0.0` / `v1.0.0`）

## 1. 已实现

### 模型网关可靠性

- 兼容 OpenRouter 数组分片 `content: [{type:'text', text}]`。
- 处理 HTTP 200 内嵌 `{error}`，按鉴权/可重试分类。
- 识别 `finish_reason=length` + reasoning 吃光正文的 `AGENT_REASONING_TRUNCATED`，自动提高 token 预算并重试。
- 普通对话默认 `max_tokens=2800`（`AGENT_MAX_TOKENS` 可配）；改写显式 6000。
- 支持 `response_format: {type:'json_object'}`；上游 400 不支持时自动去掉并重试。
- 可重试错误最多重试 2 次，退避 600ms / 1800ms；支持 `AGENT_FALLBACK_MODEL`。
- 结构化脱敏诊断日志：只记录 provider/model/HTTP/finish_reason/content_len/reasoning_len/tool_calls_len/attempt/latency/error_code，不打印 key 或用户正文。

### 编排器

- 达到工具步数上限时不再输出“请缩小范围”；以 `tools: []`、`tool_choice: 'none'` 再调用一次模型，强制基于已读取工具数据总结。
- 空内容兜底重试/总结，最终失败才返回明确错误提示。
- 新增 `get_resume_detail` 只读工具，可按当前上下文或指定 `resume_id` 读取完整简历。
- 新增 `update_job_fields` 受控写入工具：修改公司/岗位/城市/批次/链接/JD，先生成确认单，确认时复用 `correctApplication()` + `expected_version` 乐观锁。
- system prompt 明确鼓励并行发起多个只读工具，减少重复轮次。

### 简历改写工作台

- `sourceBlocks()` 从逐行碎片改为自然段/条目聚类，典型简历明显减少块数。
- Delta 输出：模型只返回改动或需标注的 block，未提及 block 自动保留原文并标记 `unchanged`。
- 四级护栏继续生效：`needs_user_fact` 不自动编造，`unsupported_blocked` 不写入生成内容。
- JSON 解析失败自动修复提取，再失败追加纠错提示重试一次。
- 真实模型实测连续 3 次改写 + Word 导出全部成功。

### 前端

- 首轮对话后顶部欢迎、画像条和 4 张快捷任务卡保持常驻。
- 画像未建立显示暖琥珀提示和“现在开始”；已建立显示青绿画像条和“修改画像”。
- 画像确认后胶囊实时切换为 `画像：已建立`。

## 2. 验证

- `npm run test:agent`：32 项服务端 + 26 项 Playwright 通过。
- 真实模型稳定性实测：10/10 通过，0 次 `AGENT_INVALID_RESPONSE`。
  - 5 类对话：查本周投递、读取简历并选岗、读取完整简历、修改岗位字段确认、建立画像确认。
  - 3 次真实简历改写 + Word 导出。
  - 使用本机 `.env` 的 OpenRouter 兼容网关；未打印或提交 Key。
  - 报告：`.tmp/agent-v112-smoke.md`
- `npm run test:web`：74/74。
- `npm run test:e2e`：67/67。
- `npm run test:career-ai`：51/51。
- 其他面板/网易/自身页面/入账/邮件套件通过。
- `npm test`：除既有云快照环境波动外全部通过。

## 3. 边界

- OpenRouter 真实模型可能受账号限流影响；自动重试与诊断日志已覆盖，仍需看实际额度。
- Word 为 ATS 友好标准 `.docx`，不承诺任意 PDF 多栏/绝对定位像素级还原。
- 改写新版本初始为 `parsed`，设为当前后需重新分析才能用于匹配。
