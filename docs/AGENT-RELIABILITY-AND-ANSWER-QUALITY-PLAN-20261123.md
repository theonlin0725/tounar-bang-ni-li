# AI 助手与简历改写回答稳定性提升方案（v1.1.2）

**日期**：2026-11-23
**基线分支**：`tounar-1.1.1`（提交 `96184a2`，**严禁改动已封板的 `tounar-1.0.0` / `v1.0.0`**）
**核心目标**：根治实测中出现的「AI 有时候回答不出来」「改写失败：`AI 助手没有返回有效内容 (AGENT_INVALID_RESPONSE)`」「步骤多时只回一句让用户缩小范围」等问题，全面提升 OpenRouter / OpenAI 兼容模型在多轮对话、工具调度与长文本简历改写场景下的**回答成功率、完整度与自愈能力**，且不破坏任何已有功能。

---

## 1. `v1.1.1` 验收总结与问题实锤根因

### 1.1 `v1.1.1` 已通过部分
- 分支隔离规范：`tounar-1.1.1` 独立推送，`tounar-1.0.0` 与 `v1.0.0` 零改动；
- 两大需求主功能均已落地：安全 Markdown 渲染、精致确认卡、独立滚动与防跳顶、二级岗位选择器、`user_profiles` 六维画像与引导、「简历改写」工作台与 `.docx` 导出，离线回归全绿（`test:agent` 49 项、`test:web` 74/74、`test:career-ai` 51/51）。

### 1.2 导致「AI 回答不出来 / `AGENT_INVALID_RESPONSE`」的 4 个代码根因

| 级别 | 文件位置 | 实锤根因 | 用户看到的现象 |
|---|---|---|---|
| **P0** | `server/src/modules/agent/llm.js`（L27, L55–61） | ① 只读 `String(message.content)`，未兼容 OpenRouter 常见的数组分片 `[{type:'text',text}]`、HTTP 200 内嵌 `{error}` 及推理模型把 `max_tokens` 吃光后返回 `content: ""` + `reasoning` + `finish_reason: "length"`；② 普通对话默认 `maxTokens = 1200` 偏小；③ 标了 `retryable: true` 但**零自动重试** | 频繁报 `AI 助手没有返回有效内容（AGENT_INVALID_RESPONSE）`，稍有上游抖动就直接失败 |
| **P0** | `server/src/modules/career-ai/rewrite-workbench.js`（L18–28, L103–115） | `sourceBlocks()` 按单行拆分，一份完整简历会产生 45–80 个 block；单次请求同时要求完成 9 步并输出全部 block 的 JSON，且未传 `response_format: { type: 'json_object' }`，极易触发推理超长/输出截断/空内容 | 点「开始定向改写」直接弹出红色报错 `改写失败：AI 助手没有返回有效内容` |
| **P1** | `server/src/modules/agent/orchestrator.js`（L110–150） | 达到 `MAX_STEPS` / `MAX_TOOL_CALLS` 上限时直接退出循环，**没有在最后一步关闭工具（`tool_choice: 'none'`）强制模型总结已拿到的工具数据**，而是硬编码回复“步骤较多，请缩小范围” | 复杂问题（如“结合简历挑合适岗位”）跑完工具却不给结论，只让用户缩小范围 |
| **P1** | `server/src/modules/agent/llm.js` & `tools.js` | ① 缺少结构化脱敏诊断日志（`finish_reason`、`has_reasoning`、`provider_error`、`usage`），出问题只能靠猜；② 缺少「读取完整简历」与「受控修改岗位字段」等高频能力，模型缺信息时易反复空转 | 排查困难；用户问简历细节或想改岗位信息时助手答不上来 |

---

## 2. 核心修复与能力增强方案

### 2.1 升级统一模型网关层：强兼容 + 自动重试 + 推理模型适配（`server/src/modules/agent/llm.js`）

1. **健壮解析多形态响应体**：
   - 先检查 `payload?.error`（即使 HTTP 200，若 OpenRouter 返回 `{ error: { code, message } }`，按可重试/鉴权错误分类处理，不再误报空内容）；
   - 新增 `extractMessageText(message)`：
     - 若 `message.content` 为字符串，正常读取；
     - 若 `message.content` 为数组（如 `[{ type: 'text', text: '...' }]`），拼接全部 `text` 块；
     - 若 `content` 为空但存在 `finish_reason === 'length'` 且存在 `message.reasoning` / `message.reasoning_content`，识别为**思考预算耗尽导致正文截断**（错误码区分标记 `AGENT_REASONING_TRUNCATED`），自动触发**带更大 `max_tokens` 或关闭/降低 reasoning 预算的重试**。
2. **显式控制推理预算与合理 Token 上限**：
   - 普通 Agent 对话默认 `maxTokens` 从 `1200` 提升至 **`2800`**（或通过 `AGENT_MAX_TOKENS` 可配）；
   - 当 `config.agentProvider === 'openrouter'` 时，支持按需透传 `reasoning: { effort: 'low' }`（对纯 JSON 结构化抽取/改写场景）或通过环境变量 `OPENROUTER_REASONING_EFFORT` 控制，避免思考链吃光输出额度；
   - 支持调用方传入 `responseFormat`（如 JSON 任务传 `{ type: 'json_object' }`，若上游模型返回 400 不支持该参数，自动去掉 `response_format` 重试一次）。
3. **内置有上限的指数退避重试 + 备选模型降级**：
   - 对 `retryable: true` 场景（空内容、429 限流、5xx 抖动、超时、JSON 截断）自动重试 **最多 2 次**（退避 `600ms → 1800ms`）；
   - 支持可选环境变量 `AGENT_FALLBACK_MODEL`（例如主模型偶发限流或空包时，第 2 次重试自动切到备选模型），显著拉高回答成功率。
4. **脱敏诊断日志（严禁打印密钥和用户隐私正文）**：
   - 每次失败或重试记录一条结构化 JSON 日志：`event: 'agent_llm_retry' | 'agent_llm_failed'`，仅含 `request_id`、`provider`、`model`、`http_status`、`finish_reason`、`content_len`、`reasoning_len`、`tool_calls_len`、`attempt`、`latency_ms`、`error_code`。

### 2.2 提升 Agent 编排器「必有有效回答」能力（`server/src/modules/agent/orchestrator.js`、`tools.js`）

1. **末步强制总结机制（彻底消灭“请缩小范围”空回复）**：
   - 当 `steps >= MAX_STEPS` 或 `toolCallsUsed >= MAX_TOOL_CALLS` 且 `finalContent` 仍为空时，**不再直接输出硬编码拒答文案**；
   - 改为追加一条系统提示“已达到本轮工具调用上限，请立刻仅基于以上已读取到的工具数据，直接向用户输出清晰、结构化的中文结论与下一步建议”，并以 **`tools: []`（不传工具 / `tool_choice: 'none'`）** 额外调用 1 次 `chatAgent()` 生成真正有用的最终回答！
2. **空内容兜底重试与自我纠偏**：
   - 若某轮工具调用后模型返回空内容且无 `tool_calls`，自动重试一次并明确指示“请根据刚拿到的工具结果直接用中文总结回复用户”。
3. **补齐关键工具缺口与清晰引导**：
   - 新增只读工具 **`get_resume_detail`**：允许助手按 `resume_id`（默认当前上下文简历）按需读取完整简历内容，解决“结合简历帮我分析/反推方向”时上下文信息不足的问题；
   - 顺手补齐之前验收提到的写入工具 **`update_job_fields`**（复用 `correctApplication()` + 图 4 同款确认卡 + `expected_version` 乐观锁），让用户可以直接让 AI 改岗位名、城市、批次、链接或补 JD；
   - 优化 `systemPrompt`：明确告诉模型“单次可并行发起多个只读工具调用（如同时查台账 + 读简历），优先用最少轮次拿到信息后直接作答，不要把步数浪费在重复查询上”。

### 2.3 重构「简历改写工作台」防截断与高成功率策略（`server/src/modules/career-ai/rewrite-workbench.js` & `rewrite.js`）

1. **合并过碎行块（Block 粒度优化）**：
   - 现状 `sourceBlocks()` 按每一个换行拆 block，造成 50–80 个碎片行，极大浪费输出 Token 且割裂语义；
   - 改为**按自然段 / 经历条目聚类**（保留模块标题 `heading`，将同一条经历的连续描述合并为合理段落块，典型简历控制在 **12–28 个块**），输出体积减少 50%+，改写质量反而更连贯。
2. **只要求模型输出「有改动或需标注的块」（Delta Output 模式）**：
   - 模型无需把未改动的姓名、电话、学校名等原封不动抄回 JSON；只需在 `alignments` 里返回需要 `supported_optimize` / `improvable` / `needs_user_fact` / `unsupported_blocked` 处理的 `block_id`，其余未提及的块由服务端自动保留原文！
   - 这样单次 JSON 输出量大幅缩减（通常 < 2500 tokens），彻底消除 6500 token 截断和 `AGENT_INVALID_RESPONSE`。
3. **分段/重试容错 + 清晰进度**：
   - 改写调用显式传入 `responseFormat: { type: 'json_object' }`（不支持自动降级重试）、`maxTokens: 6000`、`timeoutMs: 120000`；
   - 若解析 JSON 失败（如尾部缺括号或包裹了说明文字），先尝试 JSON 修复提取，失败再自动重试 1 次（附带纠错提示“上次输出不是合法 JSON，请只返回紧凑 JSON”）。

### 2.4 前端顶部欢迎与快捷操作区常驻（含求职画像「已建立 / 修改」状态切换，`web/assets/js/views/assistant.js` & `app.css`）

1. **首轮对话后不再隐藏顶部区域**：
   - 移除 `renderWelcome()` 中 `if (messages.some((m) => m.role === 'user')) { welcome.hidden = true; return; }` 的强制隐藏逻辑；
   - 将顶部「问候 + 状态胶囊 + 求职画像条 + 4 张快捷任务卡」放入对话滚动容器的顶部（或常驻可滚回的头区），开始对话后仍保留在顶部，用户随时向上滚动即可再次点击快捷任务卡或画像按钮（可提供轻量「收起/展开」折叠按钮以兼顾长对话视野，默认保持可见，不自动消失）。
2. **求职画像状态实时切换**：
   - **未建立画像时**：胶囊显示 `画像：未建立`（暖琥珀色），下方横条显示 `先建立求职画像，再让匹配更懂你` + 主按钮 `[现在开始]`；
   - **画像确认建立后**：胶囊自动切换为 `画像：已建立`（柔和青绿色），下方横条切换为 **`求职画像已建立 · <画像摘要>`** + 次按钮 **`[修改画像]`**（点击可直接触发“帮我修改求职画像”对话或打开画像编辑弹窗），确认更新后实时刷新摘要。

---

## 3. 验证与回归验收清单（不得影响已有功能）

1. **新增专项单元测试与前端 E2E（`server/test/agent-resilience.test.js`、`tests/e2e/agent-assistant.mjs`）**：
   - 验证 OpenRouter 返回数组分片 `content: [{type:'text',text:'...'}]` 能正确解析；
   - 验证 HTTP 200 内嵌 `{error}`、首包空内容 + `finish_reason:'length'`（reasoning 耗尽）会自动重试并成功恢复；
   - 验证 `AGENT_FALLBACK_MODEL` 在主模型失败时自动切换成功；
   - 验证 `orchestrator` 达到 `MAX_STEPS` 时会执行末步无工具强制总结，输出真实数据结论而非“请缩小范围”；
   - 验证 `rewrite-workbench` Delta 输出模式（模型只返回改动块，未改动块自动保留原文、4 级护栏仍严格拦截 `unsupported_blocked`）；
   - 验证新增 `get_resume_detail` 与 `update_job_fields`（确认卡 + 乐观锁冲突跳过 + 不直接写库）；
   - 验证前端 E2E：发出首轮对话后顶部欢迎与 4 张快捷任务卡依然保留且可再次点击；建立并确认求职画像后，顶部胶囊自动变为 `画像：已建立`、横条按钮切换为 `[修改画像]`。
2. **OpenRouter 真实 API 稳定性实测（强制要求）**：
   - 使用用户本机 `.env` 中的真实 OpenRouter API Key（**绝不打印、绝不入库**）连续实测：
     - AI 助手 5 类典型问题（含复杂多步“结合简历挑台账里最合适岗位并排序”、修改岗位信息确认、建立画像）；
     - 简历改写工作台连续触发 3 次真实简历 + 真实 JD 改写并导出 `.docx`；
     - 目标：**0 次 `AGENT_INVALID_RESPONSE` 报错**，全部返回可读、完整、符合约束的结果。
3. **全量防退化回归（全部保持通过）**：
   - `npm run test:agent`、`npm run test:web`、`npm run test:e2e`、`npm run test:career-ai`、`npm run test:panel`、`npm run test:netease-game`、`npm run test:self-page`、`npm run test:intake`、`npm run test:mail-progress`、`npm run test:mail-admin`、`npm test`（除既有 2 条云快照环境波动外全部通过）。
4. **4326 实例更新**：
   - 修复合并到 `tounar-1.1.1`（或 `tounar-1.1.2`）并重启 `http://127.0.0.1:4326` 供产品直接复测。
