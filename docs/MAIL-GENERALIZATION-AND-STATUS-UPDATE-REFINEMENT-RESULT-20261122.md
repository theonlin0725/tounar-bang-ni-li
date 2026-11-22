# 招聘邮件泛化与状态更新收口结果

**日期**：2026-11-22  
**基线**：`bb369b9` 后本轮改动

## 1. 本次修复

### 跨阶段轮次清理

`applyStatusTransition()` 和 `createApplication()`：

- 从 `assessment` → `interview` 且新邮件没有明确轮次时，清空旧 `round_label`（不再出现“面试中 · 在线测评”）；
- 进入 `offer` / `rejected` / `closed` 时清空 `round_label` 与 `interview_scheduled_at`；
- 同阶段一面 → 二面、改期仍由 `maybeSetRound()` 更新；
- 旧轮次仍完整保留在 `application_history`。

### 判断器口径与安全门禁

- `flash.js` 明确 `evidence_support` 只衡量“真实雇主 + 当前已发生进展阶段”的核心事实；缺少截止时间、申请编号、地点、面试官等可选字段不得压低。
- `workflow.js` 的 `clearProgressAuto` 恢复严格下限：
  - `evidence_support >= max(0.45, autoIntakeMinEvidence - 0.15)`；
  - 必须存在逐字 `evidence`；
  - 公司/岗位/阶段置信度仍需通过原有阈值。
- `llm.js` 要求 `location` 只输出城市级名称，详细街道地址只提取城市。

### 基准真实性

- 负样本不再依赖 `findApp()` 的空返回：直接核查 DB 中是否有同公司台账、event 是否为 `ignored`、是否存在 open review；误建即失败。
- pending 样本要求 event 为 pending 且存在对应 `source_event_id` 的 open review，并且该事件没有错误关联/改写台账。
- 公司/岗位/状态准确率改为**全量应入账样本分母**，漏召回会计入失败。
- 新增断言：终态无 `round_label`、面试状态无测评轮次、`location` 无街道门牌。
- 语料扩展到 44 封（34 封 unseen），新增英文泛化主题、详细街道地址、测评直达 Offer 等样本。
- 新增自检：负样本构造错误台账时评分必须失败。
- 基准 app 启用受限调度重试，避免上游 Jev 偶发失败污染结果；默认使用真实模型网关的 Flash 判断器。

### 状态列排版

- 状态单元格改为上下两层：上层状态色块，下层轮次/待回看徽标；
- 长轮次单行省略并保留 `title`，不再把表格行撑成两行；
- 5 列主表和移动端卡片布局不变。

## 2. 验证

- 全链路基准：44 封、11 轮，最终 **100%** 召回 / 拦截 / 公司 / 岗位 / 状态，全部高危项 0。
- `npm test`：227 / 228，仅既有云快照用例环境性失败。
- `npm run test:web`：74 / 74。
- `npm run test:e2e`：67 / 67。
- `npm run test:career-ai`：51 / 51。
- `npm run test:panel`：8 / 8。
- `npm run test:intake`：通过。
- `npm run test:mail-progress`：6 / 6。
- `npm run test:mail-admin`：通过。

基准截图已在 `.tmp/mail-e2e-benchmark/<timestamp>/ledger.png` 核验：无“面试中 · 在线测评”、无“录用 · 一面”、无街道门牌城市、长轮次为单行省略。

## 3. 边界

- 本地 SMTP/IMAP 沙箱不等同于真实公网 QQ/163/126/yeah.net 服务；
- 语料为合成脱敏数据；
- 真实 163/126/yeah.net 授权链路仍缺测试凭据；
- Jev 服务器偶发连接失败时，基准可通过 `MAIL_BENCH_JUDGE=jev` 复现；默认 Flash 保证可重复性。
