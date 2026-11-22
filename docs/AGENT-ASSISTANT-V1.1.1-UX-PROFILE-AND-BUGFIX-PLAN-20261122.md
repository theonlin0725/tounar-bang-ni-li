# AI 求职助手升级方案：排版体验、首次引导求职画像、Bug 修复与二级岗位选择器

**日期**：2026-11-22
**基线分支**：`tounar-1.1.0`（严格基于 `1.1.0` 迭代，**绝不改动已封板的 `tounar-1.0.0` / `v1.0.0`**）
**核心目标**：解决当前 AI 助手在真实自测中暴露的 4 类核心体验与稳定性问题——① Markdown 渲染、字体排版与精致确认卡；② 插件安装后引导建立 6 维求职画像并打通「匹配分析」；③ 修复长任务静默无响应与点击快捷词跳回顶部两个 Bug；④ 上下文岗位升级为「投递明细 / 看过没投」二级联动选择器。全过程不影响任何已有功能，并通过全量回归测试。

> **参考图说明**：下文引用的 `assets/v1.1.0-ref/*.png` 为本次需求对应的 4 张参考截图，请将聊天中上传的图 1–图 4 按对应文件名放入 `docs/assets/v1.1.0-ref/` 目录即可在 Markdown 预览中直接渲染（每张图下方亦附有完整视觉规范，不阻塞开发）。

---

## 1. 需求一：Markdown 实时渲染、排版升级与精致操作确认卡

![图1：当前 AI 助手 Markdown 未渲染与排版密集问题](assets/v1.1.0-ref/fig1-assistant-markdown-issue.png)

### 1.1 安全 Markdown 实时渲染（`web/assets/js/views/assistant.js`）
- **现状问题**：当前消息正文仅按 `\n` 拆成纯文本 `<p>`，导致模型输出的 `**加粗**`、`1. 列表`、`- 要点`、`` `代码` `` 全部以原始符号裸露展示（见图 1）。
- **改造方案**：
  - 新增轻量、零 XSS 风险的纯 DOM Markdown 渲染器 `renderMarkdownNodes(text)`（**严禁直接拼 `innerHTML`**，全部经 `document.createElement` / `textContent` 构建节点）：
    - 支持标题（`###` / `##`）、加粗（`**text**`）、斜体、行内代码（`` `code` ``）、有序列表（`1. `）、无序列表（`- ` / `* `）、引用块（`> `）与安全 `http(s)` / 站内链接；
    - 流式/最终回复均走同一渲染器，保证重点词加粗、条目清晰分层。

### 1.2 字体与阅读排版优化（`web/assets/app.css`）
- **字体栈统一**：在助手区（及正文可读区域）采用易读中文无衬线字体栈：
  ```css
  font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  ```
- **字号与行距放宽**：
  - 对话正文从当前偏小密集样式调整为 `font-size: 15px; line-height: 1.75; letter-spacing: 0.01em;`；
  - 段落间距 `margin: 0 0 10px`，列表项间距 `6px`，气泡内边距 `16px 20px`，气泡最大宽度控制在可读区间（`max-width: 780px`），整体呼吸感显著提升。

### 1.3 精致操作确认卡片（1:1 对齐图 4）

![图4：精致操作确认卡片参考设计](assets/v1.1.0-ref/fig4-action-confirm-card.png)

- 改造 `renderActionCard()`（`assistant.js` + `app.css`）：
  - 顶部大标题 `请确认操作`（18px 加粗）+ 状态角标；
  - 中部采用**双列键值表格布局**（左列浅灰标签 `操作类型 / 命中记录 / 当前状态 / 修改后状态 / 影响记录数量`，右列清晰正文与柔和圆角状态色块胶囊，如暖琥珀 `已投递`、浅灰 `已结束`）；
  - 下方配置**浅红底色风险提示横条**（带三角形警示图标，明确提示“执行前系统将重新校验岗位记录与当前状态是否仍符合条件”）；
  - 底部右对齐操作按钮：`[取消]`（浅灰描边）与 `[确认执行]`（品牌青绿实心按钮）。

---

## 2. 需求二：首次引导建立「用户求职画像」并打通「匹配分析」

![图3：目标岗位、简历版本与已确认求职画像卡片联动参考](assets/v1.1.0-ref/fig3-profile-and-rewrite-context.png)

### 2.1 六维求职画像数据模型（`server/src/schema.sql` & `db.js`）
新增 `user_profiles` 表（按 `owner_id` 唯一，完全向后兼容旧库）：
- `owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE`
- `preferred_locations_json TEXT`（**地点**，如 `["上海", "深圳"]`）
- `salary_expectation TEXT`（**薪资**，如 `月薪 20k–25k / 年包 30w+`）
- `work_mode TEXT`（**工作方式**，如 `线下面对面 / 混合办公 / 远程`）
- `career_direction TEXT`（**职业发展方向**，如 `产品经理 / 数据分析 / AI 产品`）
- `industry_preferences_json TEXT`（**行业偏好**，如 `["互联网", "金融科技", "游戏"]`）
- `company_preferences_json TEXT`（**企业偏好**，如 `["大厂", "外企", "高成长独角兽"]`）
- `summary_text TEXT`（面向页面展示的一句话画像摘要，如 `产品 / 数据分析方向 · 上海/深圳`）
- `status TEXT NOT NULL DEFAULT 'draft'`（`draft` / `confirmed`）
- `onboarding_completed_at TEXT`、`version INTEGER NOT NULL DEFAULT 1`、`updated_at TEXT NOT NULL`

### 2.2 完整引导与 3–5 轮对话建画像流程
1. **首次进入流程**：
   - 用户登录后按现有流程先执行**插件连接检测**（`promptPluginConnection`）；
   - 当用户完成插件安装/绑定后，若 `user_profiles.status !== 'confirmed'`（尚未建立画像），自动引导默认进入 **`/?panel=assistant&onboarding=profile`**（同时提供「稍后再说」跳过入口，不强行卡死用户）；
2. **3–5 轮结构化对话收集画像**：
   - AI 助手在 `onboarding=profile` 会话下启动专属引导 Prompt，用自然、克制的 **3–5 轮**对话分批询问 6 大维度（第 1 轮：职业发展方向 + 期望地点；第 2 轮：行业偏好 + 企业偏好；第 3 轮：薪资范围 + 工作方式；若用户一次答全则提前收敛，不机械凑轮次）；
   - 收集完成后，Agent 调用新增工具 `update_profile` 生成**「求职画像确认卡」**（采用图 4 同款键值表展示 6 个维度），用户点 `[确认保存画像]` 后落盘 `user_profiles (status='confirmed')`；
3. **打通「匹配分析」与「AI 助手」**：
   - **后端**：新增 `GET /api/v1/profile`、`PUT /api/v1/profile`；在 `matchApplication()`（`career-ai/service.js`）读取已确认的 `user_profiles` 注入匹配分析上下文，让六维匹配真实结合用户的地点、薪资、行业与方向偏好；
   - **前端「匹配分析」页**：按图 3 在顶部增加「求职画像」卡片（显示 `已确认画像 · <方向与要点>` + `[编辑画像]` 按钮，支持弹窗直接编辑或点击“用 AI 助手重新梳理”）；
   - **前端「AI 助手」页**：欢迎卡与底部上下文条同步展示真实 `画像：<已确认 / 未建立>` 胶囊（不再出现假状态）。

---

## 3. 需求三：修复 2 个高优前后端 Bug

![图2：按 JD 改写简历静默无响应与当前平铺岗位下拉框](assets/v1.1.0-ref/fig2-assistant-hang-and-context.png)

### 3.1 Bug 1：「按 JD 改写简历」等重任务静默消失、半天无答案（见图 2）
- **代码级根因定位**：
  1. `assistant.js` L337 在 SSE 请求超时、断开或服务端返回 `error` 事件时，仅弹出一条 3 秒消失的 `toast`，随即清空 `statusText` 并调用 `loadSession()`；而服务端在 `orchestrator.js` L103 早已写入了用户消息、异常时未写入任何助手回复，导致界面只剩孤立的用户气泡（用户连发两次「按 JD 改写简历」都直接消失）；
  2. 当底部上下文为 `全部岗位` 时，直接问「按 JD 改写简历」会触发模型反复试探工具或 `rewrite_resume` 因 `maxTokens: 6000` 生成耗时超过 HTTP/网关默认超时；
  3. Node HTTP Server 对 SSE 长连接未显式关闭单次 socket 超时（`req.setTimeout(0)` / `res.setTimeout(0)`）。
- **彻底修复方案**：
  1. **SSE 长连接防断开**：在 `streamAgentChat()` 中对 SSE 响应显式设置 `req?.setTimeout?.(0); res.setTimeout?.(0);`，心跳间隔缩短至 `8000ms`；
  2. **异常必有可见回复（绝不静默消失）**：
     - 服务端 `orchestrator.js` 捕获工具或模型超时/错误时，若本轮未产出 `assistant` 消息，**必须落盘一条带 `meta.is_error = true` 的助手提示消息**（明确告知失败原因，如“目标岗位缺少完整 JD”“模型响应超时”），并附带 `[重试本轮]` 按钮；
     - 前端 `assistant.js` 在 `catch` 中若未收到服务端消息，也在消息流中渲染可见错误气泡与重试按钮，不再只靠 3 秒 toast 闪过；
  3. **缺目标岗位快速澄清**：当 `rewrite_resume` 缺少 `application_id` 且会话上下文为「全部岗位」时，立即返回结构化提示让模型直接向用户澄清目标岗位（或引导点下方二级选择器选定岗位），不消耗多余步数；
  4. **单次工具调用超时与可读进度**：`generateResumeRewrite` 调用阶段通过 `onStatus` 持续推送轻量状态（如 `正在读取岗位 JD 与原简历…` → `正在生成逐段改写建议（预计 15–30 秒）…`），并在 `config.agentTimeoutMs` 上允许单次改写最高 120s。

### 3.2 Bug 2：点击回答下方快捷提示词后页面自动跳回最顶部
- **代码级根因定位**：
  1. `assistant.js` L221 `renderThread()` 每次收到 SSE `status` 或触发 `send()` 都调用 `clear(thread)` 清空整个消息容器，容器高度瞬间塌缩为 `0px`，导致浏览器将窗口 `scrollTop` 强行重置到顶部 `0`；
  2. `loadSession()` 结束时调用 `renderComposer()` 与 `inputEl.focus()`（未传 `{ preventScroll: true }`），进一步触发焦点跳动。
- **彻底修复方案**：
  1. **固定对话区独立滚动 + 增量更新**：将 `.tn-assistant` 设为固定视口高度的 Flex 布局（顶栏固定 + 中间 `.tn-assistant-thread` 独立 `overflow-y: auto` + 底部输入区吸底），**不再依赖整页 `window` 滚动**；
  2. **状态条原地更新不清空历史 DOM**：为轻量状态文案设置单独的常驻子节点 `.tn-agent-status-slot`，收到 `event: status` 时仅更新该节点文本，绝不 `clear(thread)` 重建历史消息；
  3. **平滑锚定到底部**：点击快捷提示词、发送消息或收到回复后，仅当用户原本处于底部附近（或主动发消息）时平滑滚动 `thread.scrollTop = thread.scrollHeight`；输入框聚焦一律使用 `inputEl.focus({ preventScroll: true })`。

---

## 4. 需求四：上下文岗位升级为「投递明细 / 看过没投」二级联动选择器

- **现状问题**：当前底部上下文条只有一个平铺的 `<select>`（见图 2），仅列出近期少量记录，且无法按「投递明细」与「看过没投」分类浏览和加载更多。
- **交互与接口设计**：
  1. **前端二级弹出面板（替换原平铺 `<select>`）**：
     - 触发按钮显示当前选中项（`岗位：全部岗位` 或 `岗位：字节跳动 · 产品经理`）；
     - **第一级菜单**：
       - `全部岗位`（清空聚焦）
       - `投递明细（N）` → 点击进入二级列表
       - `看过没投（M）` → 点击进入二级列表
     - **第二级列表**：
       - 顶部带返回上一级按钮 + 实时搜索框（按公司/岗位过滤）；
       - 列表项展示 `公司 · 岗位名` + 柔和状态胶囊 + 城市/批次；
       - **支持下滑触底分页加载**（对接 `/api/v1/ledger?view=applied|viewed&cursor=...`），自动与「投递明细」「看过没投」真实数据保持实时联动（收到 `tounar:data-changed` 时自动失效缓存并刷新计数）；
  2. **上下文同步与隔离**：
     - 选中具体岗位后调用 `PATCH /api/v1/agent/sessions/:id/context`，保持既有 `context_boundary` 机制，确保切换岗位后绝不混入上一岗位的 JD。

---

## 5. 测试与回归验收清单（确保不影响 1.0.0 与 1.1.0 既有功能）

1. **新增单测与 E2E（`server/test/agent.test.js`、`tests/e2e/agent-assistant.mjs`）**：
   - Markdown 渲染：验证 `**加粗**`、列表、标题正确转为 `<strong>` / `<ul>` / `<ol>`，且 `<script>` 等恶意输入被纯文本转义（防 XSS）；
   - 画像引导与落盘：验证 `GET/PUT /api/v1/profile`、`update_profile` 确认写入、`matchApplication()` 正确读取画像，且不影响无画像旧用户；
   - Bug 1 回归：模拟模型超时/报错时，消息流保留可见错误气泡与重试按钮，不静默消失；
   - Bug 2 回归：多条消息产生滚动条后点击快捷提示词，验证滚动位置停留在底部最新消息，不跳回顶部；
   - 二级岗位选择器：验证从「看过没投」与「投递明细」分别展开、分页加载并选中岗位，切换后 `context_boundary` 生效。
2. **全量防退化回归**：
   - `npm run test:agent`、`npm run test:web`、`npm run test:e2e`、`npm run test:career-ai`、`npm run test:panel`、`npm run test:netease-game`、`npm run test:self-page`、`npm run test:intake`、`npm run test:mail-progress`、`npm run test:mail-admin`、`npm test`（除既有 2 条云快照环境波动外全部通过）。
