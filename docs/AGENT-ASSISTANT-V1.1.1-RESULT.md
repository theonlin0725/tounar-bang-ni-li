# v1.1.1 AI 助手体验升级与简历改写工作台实现结果

**日期**：2026-11-23
**分支**：`tounar-1.1.1`
**基线**：`tounar-1.1.0`（`1a5a10e`；未改动 `tounar-1.0.0` / `v1.0.0`）

## 1. 已实现

### AI 助手体验

- 新增安全纯 DOM Markdown 渲染器 `web/assets/js/markdown.js`：标题、加粗、斜体、行内代码、列表、引用、代码块、安全链接；不使用 `innerHTML`，`<script>` 等输入按文本处理。
- 助手正文改为 15px / 1.75 行高、780px 气泡宽度、中文无衬线字体栈；确认卡改为“请确认操作 + 双列键值表 + 风险条 + 右侧按钮”。
- SSE：单次 socket 超时关闭、8 秒心跳、请求校验提前到响应头之前；服务端异常会落盘 `meta.is_error` 助手消息并带 `retry_text`，前端显示错误气泡与“重试本轮”。
- 对话区改为固定视口 Flex 布局，消息区独立滚动；状态条原地更新，不再因 `status` 事件清空历史 DOM；输入框聚焦使用 `preventScroll`。

### 求职画像

- 新增 `user_profiles` 表与 `GET/PUT /api/v1/profile`。
- Agent 新增 `update_profile` 工具，只创建待确认卡；确认后写入 `status=confirmed`。
- 单岗位匹配注入已确认画像（地点、薪资、工作方式、方向、行业、企业偏好）到报告上下文和模型 payload。
- AI 助手欢迎卡、底部上下文条和匹配分析页显示真实画像状态；匹配页支持手动编辑与“用 AI 助手梳理”入口。
- 插件连接成功并关闭网站授权后，若画像未确认，自动跳转 `/?panel=assistant&onboarding=profile`（可跳过）。

### 二级岗位选择器

- 新增 `web/assets/js/views/job-picker.js`，AI 助手和简历改写共用。
- 第一级“全部岗位 / 投递明细（N）/ 看过没投（M）”；第二级搜索、状态/城市、滚动触底加载和分页。
- 选择后仍走既有 `PATCH /agent/sessions/:id/context` 与 `context_boundary`，切换岗位不混入旧 JD。

### 简历库「简历改写」工作台

- 简历库新增“我的简历 / 简历改写”二级页签；工作台支持选择投递明细/看过没投岗位、简历版本弹窗、画像/JD 信息卡与补充要求。
- 新增 `resume_rewrite_drafts` 表和 9 步结构化改写草稿；四级分类 `supported_optimize` / `improvable` / `needs_user_fact` / `unsupported_blocked`。
- 右侧高亮可编辑，待补事实只提示不编造，拦截内容不写入最终块；支持草稿 PATCH、确认保存、默认命名“原简历名_岗位名”。
- 新增无依赖 OOXML Word 导出；`GET /api/v1/resumes/:id/export.docx` 强校验 owner，标准可编辑 `.docx`，文件保存在 `DATA_DIR/resumes/...`。
- 简历库版本行提供 Word 下载入口。

### 数据兼容

- 仅增量建表/加列；新增 `resumes.export_docx_path`、`layout_meta_json`、`user_profiles`、`resume_rewrite_drafts`。
- older `agent_pending_actions` 通过重建表加入 `update_profile` 动作类型，历史 pending/confirmed 行保留。

## 2. 验证

- `npm run test:agent`：25 项服务端 + 24 项 Playwright 通过（含 Markdown XSS、画像确认、错误重试、二级岗位、简历改写与 Word）。
- `npm run test:web`：74/74。
- `npm run test:e2e`：67/67。
- `npm run test:career-ai`：51/51。
- `npm test`：除既有云快照环境波动外全部通过。

## 3. 边界

- Word 为 ATS 友好的标准可编辑 `.docx`；未承诺任意 PDF 多栏/绝对定位的像素级还原。
- 新简历版本初始为 `parsed`；勾选“设为当前”后需重新分析才能用于匹配。
- 真实 OpenRouter 联调仍需 `OPENROUTER_API_KEY`；本轮未打印或提交任何 key。
