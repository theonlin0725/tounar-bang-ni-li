# v1.1.3 简历改写质量、进度与助手滚动优化结果

**日期**：2026-11-23
**分支**：`tounar-1.1.3`
**基线**：`tounar-1.1.2`（`af61ae6`；未改动 `tounar-1.0.0` / `v1.0.0`）

## 1. 已实现

### 简历反断行与改写质量

- 新增 `normalizeResumeBlocks()`：识别模块标题、经历抬头、项目符号和“小标题：”边界；续行按中英文规则无缝拼接，清理 PDF 提取孤立空格。
- 真实 2049 字 PDF 简历实测归并为 28 个完整块，无“承接上一条”、无中文残句换行。
- 两阶段 9 步流水线：
  - 阶段一读取 JD/简历并提取四类要求：`hard_requirements`、`core_competencies`、`plus_items`、`other_requirements`。
  - 阶段二按 Delta 模式逐批对齐改写；超过 18 块自动分批，未提及块保留原文。
- `supported_optimize` 要求实质表达升级；`needs_user_fact` 保持原文并提示；`unsupported_blocked` 严格不写入生成内容。

### 进度与稳定性

- `resume_rewrite_drafts` 增量增加 `progress_percent`、`progress_label`；POST 立即返回草稿，后台异步推进 15% → 40% → 75%/批次 → 95% → 100%。
- 前端 800ms 轮询进度，显示青绿进度条、百分比和阶段文案；成功后自动切换左右对照，失败显示错误与“重新生成”按钮。
- 复用 v1.1.2 模型网关重试、JSON 修复、数组分片与 reasoning 截断适配。

### 左右对照与助手滚动

- 改为成对行 Grid（`minmax(0,1fr)` × 2），移动端切为上下排列；补齐 `min-width:0 / overflow-wrap:anywhere`，修复右栏裁切。
- 右栏使用轻量前缀/后缀 diff `<mark>` 高亮改动，聚焦时转为纯文本编辑；提供“还原原句”。
- 顶部新增 JD 四类要求概览条；报告继续展示缺口和四级计数。
- `.tn-assistant-welcome` 移入 `.tn-assistant-thread` 滚动容器顶部，不再固定占据上半屏；对话消息滚动时欢迎区自然滚出，回顶部仍可点击快捷卡。

## 2. 验证

- `npm run test:agent`：33 项服务端 + 29 项 Playwright 通过。
- 真实 OpenRouter 兼容模型隔离调用：10/10 通过，0 次 `AGENT_INVALID_RESPONSE`；3 次改写 + Word 成功。
- 4326 真实长 PDF 简历 + 真实 JD 连续 2 次：
  - 均生成 28 个完整块；
  - 无“承接上一条”、无中文残句换行；
  - JD 四类要求均返回；
  - 进度到达 100%，Word 为合法 ZIP/OOXML；
  - 两次均确认保存成功。
- `npm run test:web` 74/74、`test:e2e` 67/67、`test:career-ai` 51/51。
- `npm test`：除既有云快照环境波动外全部通过。

## 3. 边界

- Word 为标准 ATS 友好 `.docx`，不承诺复杂 PDF 多栏/绝对定位的像素级还原。
- 长简历分批仍依赖模型可用性和账号额度；失败时保留明确错误和重新生成入口。
- 改写新版本初始为 `parsed`，设为当前后需重新分析才能用于匹配。
