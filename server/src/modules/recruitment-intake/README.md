# 招聘进展自动入账模块

把插件/邮件原始线索变成受控的台账写入，核心顺序是：

```text
LLM 提取（llm.js）
  → 候选台账查询（workflow.js）
  → Jev 类型化判断（jev.js）
  → 服务端时间/冲突/重复/人工保护校验
  → 自动创建 / 自动更新 / no-op / 待确认 / retry
```

- `llm.js`：OpenAI 兼容服务端调用，只提取字段和逐字证据；缺失保持 null，不补造。提示词明确区分实际进展、流程说明、广告、转发/历史。
- `jev.js`：直接调用 TypeSafe Jev `/v1/systemone`，用 Noul/Choice 问题判断实际进展、阶段、证据支持、新旧和岗位候选；候选必须允许 `no_match` / `uncertain`。不是普通 Judge 提示词。
- `workflow.js`：服务端最终决策；Jev 不直接写库。技术失败写 `ai_ingest_runs` 并进入 retry，不创建用户待确认。用户手动状态之后、事件时间更早的旧证据直接 no-op；更新时才清除人工保护，允许后续新证据自动更新。
- 接回：`modules/data-capture/mail/sync.js` 的邮件同步；`modules/data-capture/plugin.js` 的 `site_status_observed` 异步处理；调度器 `retryPendingIntakes`。
- 审计：`ai_ingest_runs` 记录模型、规则版本、提取/Jev 原始 JSON、决策、原因、前后状态、重试时间。
- 配置：`AI_API_URL/AI_API_KEY/AI_MODEL`、`JEV_API_URL/JEV_API_KEY/JEV_MODEL`、`AUTO_INTAKE_*`。无凭据默认关闭；显式开启但失败不会伪造成待确认。

完整规则、真实样本评估和限制见[自动入账工作流](../../../../docs/AUTO-INTAKE-WORKFLOW.md)。

测试：

```bash
npm run test:intake
npm run eval:intake   # 真实模型，隔离临时库
```
