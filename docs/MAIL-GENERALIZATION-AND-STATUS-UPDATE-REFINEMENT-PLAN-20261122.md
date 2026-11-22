# 招聘邮件多模式泛化识别与状态自动更新优化方案

**日期**：2026-11-22  
**基线提交**：`bb369b9`（`test: 增加招聘邮件全链路泛化基准`）  
**核心目的**：在**不影响任何已有功能**的前提下，从模型源头、状态机流转、基准真实性校验与前端状态呈现四个层面收口 `bb369b9` 验收中暴露的缺陷，进一步提高系统对**不同模式招聘邮件的泛化识别能力**与**投递状态自动更新准确度**。

## 1. 基线验收发现的问题汇总

结合 `bb369b9` 代码变更与 4324 / 泛化基准实拍截图核验，定位到以下 5 项需要收口的问题：

| 级别 | 涉及文件 | 问题描述 | 影响 |
|---|---|---|---|
| **P1** | `server/src/domain/applications.js` | **跨阶段推进残留上一阶段的 `round_label`**：记录从 `assessment` 推进到 `interview`、或从 `interview` 推进到 `offer/rejected/closed` 时，若新邮件未带新轮次，旧 `round_label` 原样保留 | 基准截图出现 `云图科技：面试中 · 在线测评`、`云杉互娱：录用 · 一面`，状态语义错乱 |
| **P1** | `server/src/modules/recruitment-intake/flash.js`<br>`server/src/modules/recruitment-intake/workflow.js` | **证据门禁放宽过头，未从源头修判断器口径**：`workflow.js` 中 `clearProgressAuto` 将 `evidence_support` 降到 `>= 0.2`，且 `job_title` 为空时直接跳过校验，存在放过低证据幻觉邮件的风险 | 牺牲精准率换召回率，泛化到复杂真实收件箱时易引入误判 |
| **P1** | `tools/run-mail-e2e-benchmark.mjs` | **基准打分存在空断言与幸存者偏差**：① `findApp()` 对 `ignored` / `pending` 样本直接 `return null`，使 `sampleSuccess()` 中 `!app` 恒为 `true`，负样本即使误建台账也算通过；② 公司/岗位准确率分母只算已匹配行，未计入漏召回样本 | 100% 基准分数存在失真风险，无法真实暴露泛化短板 |
| **P2** | `server/src/modules/recruitment-intake/llm.js` | **`location` 偶尔抽取为详细面试街道地址**（如 `广州市天河区华穗路5号招商银行大厦4楼`） | 台账副行冗长，影响城市筛查与可读性 |
| **P2** | `web/assets/js/views/ledger.js`<br>`web/assets/app.css` | **状态列长轮次与「待回看」徽标折行**（如 `HackerRank Coding Challenge`、`线上AI视频面试` 被折成两行） | 桌面端表格行高不齐，影响状态一眼扫描 |

## 2. 详细修改方案

### 2.1 完善跨阶段状态自动更新与轮次清理（`server/src/domain/applications.js`）

保证不同阶段的邮件到来时，状态与附属阶段信息同步演进、不串台：

1. **跨阶段推进自动清理旧轮次**：
   - 在 `applyStatusTransition()` 中，当 `targetStatus !== app.status` 时：
     - 若新状态进入终态（`offer` / `rejected` / `closed`），在 `updates` 中清空 `round_label: null`、`interview_scheduled_at: null`（原有轮次与时间完整保留在 `application_history` 中，不影响历史追溯）；
     - 若新状态为 `assessment` 或 `interview` 且本次事件未提供新的 `round_label`，主动清空 `round_label: null`，避免把「在线测评」带进「面试中」。
2. **同阶段更新保持不变**：
   - 同阶段内轮次升级（如 `一面 → 二面`、`初面 → 终面`）或面试改期，继续由 `maybeSetRound()` 更新 `round_label`、`interview_scheduled_at` 与 `stage_anchor_at`。
   - 保持既有护栏不动：用户手动修改保护（`manual_status_at`）、迟到旧回执不回退、终态冲突和平转待确认、自动入账后 `resolveSupersededReviews()` 消解旧待确认。

### 2.2 校准模型抽取与判断口径，提升多模式泛化与抗幻觉能力（`llm.js`、`flash.js`、`workflow.js`）

1. **从源头修判断器提示词（`server/src/modules/recruitment-intake/flash.js`）**：
   - 明确说明 `evidence_support` **仅衡量原文是否直接支持「真实雇主 + 当前已发生的招聘进展阶段」这一核心事实**；
   - 明确指示模型：**正文中缺少截止时间、申请编号、工作地点、面试官姓名等可选字段时，不得压低 `evidence_support`**。
2. **收紧 `workflow.js` 自动放行门禁（`server/src/modules/recruitment-intake/workflow.js`）**：
   - 将 `clearProgressAuto` 的证据门禁恢复为严格且合理的下限：
     - 统一要求 `judged.evidence_support >= Math.max(0.45, config.autoIntakeMinEvidence - 0.15)`（不再在 `!extracted.job_title` 时跳过校验，不再使用 `0.2` 的过低阈值）；
     - 同时要求 `Array.isArray(extracted.evidence) && extracted.evidence.length > 0`（必须存在逐字原文证据）。
   - 对非终态三阶段（`applied` / `assessment` / `interview`）保持高召回，同时守住不放行无证据幻觉的底线。
3. **规范城市字段抽取（`server/src/modules/recruitment-intake/llm.js`）**：
   - 在抽取提示词中明确约束：`location` 只输出**城市级名称**（如 `广州`、`上海`、`深圳`、`北京`、`远程`），若原文只给出详细面试街道地址（如“广州市天河区华穗路5号…”），只提取城市名 `广州`，不要把街道门牌写入 `location`。

### 2.3 补齐泛化基准的真实性校验与多模式覆盖（`tools/run-mail-e2e-benchmark.mjs`、`tests/fixtures/mail-generalization-corpus.json`）

让基准分数真正反映系统的泛化水平，不留统计盲区：

1. **修复 `ignored` 负样本真校验**：
   - 不再依赖 `findApp()` 返回的 `null`；改为直接检索 `dbApps` 与 `openReviews`，核查是否存在与该负样本公司/别名/发件人/主题相关的记录，并校验 `events` 中该邮件最终未被 `applied` 或生成 `open` review。一旦负样本误建台账，立即扣减 `specificity` 并输出到失败明细。
2. **修复 `pending` 样本真校验**：
   - 校验该样本确实没有错误新建或改写台账，且 `openReviews` 中存在与该邮件 `source_event_id` 对应的 `open` 待确认记录。
3. **消除准确率分母的幸存者偏差**：
   - 公司名、岗位名、状态准确率同时报告**全量应入账样本口径（end-to-end）**与**已入账样本口径**，并以全量口径作为主门槛，防止漏召回被隐藏。
4. **新增关键业务一致性断言**：
   - 断言所有终态记录（`offer` / `rejected` / `closed`）的 `round_label === null`；
   - 断言从 `assessment` 推进到 `interview` 的记录不会残留 `在线测评` 等上一阶段 `round_label`；
   - 断言提取出的 `location` 不包含详细街道门牌号（如 `路/号/大厦/楼`）。
5. **可按需补充 4–6 封高难度多模式未见样本**（保持纯合成脱敏）：
   - 例如：外企英文邮件中 `Subject` 仅写 `Update on your application`（靠正文判断）、HTML 嵌套表格多志愿邮件、仅正文底部版权行出现公司名、从测评直接跳终面/直接发 Offer、先收到一面邀请后收到二面改期等，持续检验泛化边界。

### 2.4 收口前端状态列长轮次排版（`web/assets/js/views/ledger.js`、`web/assets/app.css`）

- 将「状态」单元格规整为上下两层，不改变 5 列主表结构和移动端卡片重排：
  - 第一行：柔和圆角颜色块 `<select data-test="ledger-status-edit">`（保留全部既有交互、乐观锁与日期补填逻辑）；
  - 第二行（仅在有 `roundText` 或 `待回看` 时渲染）：单行轻量副信息区（`display: flex; align-items: center; gap: 6px; white-space: nowrap;`），长轮次文本设置 `max-width` + `overflow: hidden; text-overflow: ellipsis;` 并通过 `title` 保留完整轮次名称。

## 3. 兼容性红线（禁止破坏已有功能）

- 不修改插件采集、简历解析与管理、JD 匹配分析、提醒调度、手动补录、人工字段/状态保护及现有 API 路由契约；
- 不把真实个人邮件正文、邮箱账号、授权码或 `.env` 密钥写入仓库；
- 不删除或跳过任何既有单元测试与 E2E 断言。

## 4. 验证与回归验收清单

1. **新增专项单测**：
   - `server/test/mail.test.js` / `server/test/phase2.test.js`：验证 `assessment(在线测评) → interview(无新轮次)` 清空旧 `round_label`；`interview(一面) → offer / rejected` 清空 `round_label` 与 `interview_scheduled_at`，且 `application_history` 保留历史变更；
   - `server/test/flash-intake.test.js`：验证 `evidence_support < 0.45` 或无逐字 `evidence` 时不再被 `clearProgressAuto` 放行，同时验证缺少可选字段（截止时间/申请号）但核心证据充分的邮件仍正常自动入账；
   - 基准脚本自检：验证负样本若误入台账，必然触发 `specificity < 100%` 报错。
2. **重跑全链路泛化基准**：
   - 使用外部 `.env` 执行 `npm run bench:mail-e2e`：
     - 严格口径下全部指标与高危零容忍项通过；
     - 新生成的 `.tmp/mail-e2e-benchmark/<timestamp>/ledger.png` 中无 `面试中 · 在线测评`、`录用 · 一面`、无街道门牌充当城市、无状态列长轮次折行。
3. **全量回归（零新增失败）**：
   - `npm test`
   - `npm run test:web`
   - `npm run test:e2e`
   - `npm run test:career-ai`
   - `npm run test:panel`
   - `npm run test:intake`
   - `npm run test:mail-progress`
   - `npm run test:mail-admin`
