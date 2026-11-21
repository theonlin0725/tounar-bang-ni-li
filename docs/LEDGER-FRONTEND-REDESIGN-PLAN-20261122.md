# 投递台账前端排版与交互改造开发方案

**日期**：2026-11-22  
**适用仓库**：`tounar-bang-ni-li`  
**核心目标**：精简投递台账主表信息密度、对齐极简现代的列表排版与色块状态呈现、统一「已投天数」与「更新时间」展示口径；所有改造仅作用于主表呈现与日期计算，**不破坏左侧导航、详情抽屉、筛选分页、待确认、简历匹配、插件采集与邮箱同步等任何既有功能**，并通过全量回归测试。

## 1. 改造前后对比总览

| 区域 / 列 | 改造前 | 改造后 | 说明 |
|---|---|---|---|
| 顶部四标签栏（`#tn-tabs`） | 展示 `投递明细 \| 看过没投 \| 待确认 \| 已归档` | **移除**，页面直接呈现台账明细表 | 左侧导航栏（`nav-ledger` / `nav-viewed` / `nav-reviews` / `nav-archived`）与 URL 路由已完整覆盖四视图，去重降噪 |
| `公司` 列 | 展示公司名 + 按需「补充信息」按钮 | **保留**，优化字重与行距 | 点击整行仍打开详情抽屉；「补充信息」点击仍阻止冒泡进入编辑 |
| `岗位` 列 | 岗位名 + `批次 · 城市` 副行 | **保留**，排版更克制 | 正常展示岗位名与批次/城市副信息 |
| `JD 摘要` 列 | 主表展示摘要文本 | **从主表移除** | 数据与 API 字段保留，点击行进入详情抽屉仍可完整查看与编辑 JD |
| `投递渠道` 列 | 主表展示 `邮件` / `插件` 等 | **从主表移除** | 顶部工具条的「全部来源」筛选与详情抽屉中的渠道字段保持不变 |
| `状态` 列 | 灰白原生下拉框 | **柔和圆角颜色块下拉选择器** | 兼具图 1 的色块视觉辨识度与直接下拉切换状态能力，选中新状态后色块即时切换 |
| `已投天数` 列 | 邮件推断记录显示 `≤ 2026-11-19（据邮件推断）`，无 `applied_at` 显示 `投递时间待补` | **统一直接显示天数**（如 `3 天` / `今天`） | 当前日期（上海时区）减去「邮件收件日期 / 投递日期 / 加入明细日期」 |
| `查看岗位` 列 | 主表单独占一列（大多为 `—`） | **从主表移除** | 岗位链接仍保留在详情抽屉内，随时可点开 |
| `更新时间` 列 | `2026-11-21 23:54` + 副文案 `台账更新时间` | **仅显示日期 `YYYY-MM-DD`**（如 `2026-11-21`） | 去掉时分与冗余副文案，鼠标悬停可通过 `title` 查看精确时间 |

最终主表固定为 **5 列**：`公司` ｜ `岗位` ｜ `状态` ｜ `已投天数` ｜ `更新时间`。

## 2. 详细设计与实现规范

### 2.1 移除顶部冗余标签栏，保持多视图路由完整（`web/assets/js/views/ledger.js`）

1. **DOM 精简**：
   - 从 `renderLedger` 主容器移除 `#tn-tabs`（不再渲染 `buildTabs()`），顶部工具条下方直接紧接明细表格卡片。
   - 保留 `state.view`（`applied` / `viewed` / `archived` / `reviews`）、`switchView(id)`、`notifyView(id)` 与 `tounar:counts` / `tounar:view` 事件派发，确保左侧侧边栏的高亮态、计数角标和 URL 参数（`/`、`/?panel=ledger&view=viewed`、`/?panel=ledger&view=archived`、`/?panel=reviews`）与此前完全一致。
2. **联动兼容**：
   - 保留 `openManual` 回调里的 `onOpenReviews: () => switchView('reviews')` 以及「看过没投」行内改状态自动切回 `applied` 视图的逻辑，去掉其中对 `buildTabs()` 的调用即可。
   - 骨架屏 `skeletonTable()` 列数同步调整为 **5 列**，与主表对齐。

### 2.2 主表列重构与极简排版（`web/assets/js/views/ledger.js`、`web/assets/app.css`）

1. **表头与行结构**：
   - `<thead>` 仅保留 5 列：`公司`、`岗位`、`状态`、`已投天数`、`更新时间`。
   - 表格视觉对齐图 1 风格：
     - 表头使用极浅灰底（如 `#f7f8fa`）、中等字重（`500`–`600`）、柔和深灰字色（`#5c6573`），去掉厚重边框；
     - 数据行纯白底、统一宽松行高（单元格上下 padding `14px–16px`）、细浅分割线（`#eef0f3`），hover 态轻浅高亮；
     - 合理分配 5 列宽度比例（例如：`公司 20%`、`岗位 30%`、`状态 20%`、`已投天数 15%`、`更新时间 15%`），在 1280px–1440px 桌面端无需横向滚动。
2. **不破坏详情与既有字段**：
   - 后端 `/api/v1/ledger` 与 `/api/v1/applications/:id` **不删除** `jd_summary`、`channel`、`job_url` 等字段；详情抽屉（`detail.js`）、筛选器（`toolbar-source`）、简历匹配（`career.js`）继续正常读取。

### 2.3 状态颜色块下拉选择器（`web/assets/js/views/ledger.js`、`web/assets/app.css`）

1. **交互与 DOM 保持兼容**：
   - 继续在 `statusEditor(item)` 中使用 `<select data-test="ledger-status-edit" data-status-app-id="${item.id}">`，保留 `expected_version` 并发校验、缺失 `applied_at` 时展开日期输入框（`ledger-status-date` + `ledger-status-save`）以及失败回滚逻辑。
   - 给 `<select>`（或其外层胶囊容器）绑定状态类名 `tn-status-pill status-${item.status}`，在 `change` 与加载时动态同步类名，使色块颜色随当前状态实时变化。
2. **颜色块视觉规范（对齐图 1 柔和配色）**：
   - 圆角 `8px`（或 `999px` 胶囊）、紧凑内边距、居中/左对齐文字 + 轻量自定义下拉箭头（隐藏厚重原生边框，hover/focus 时显示轻描边）：

| 状态值 | 文案 | 建议背景色 | 建议文字色 | 建议轻边框/聚焦色 |
|---|---|---|---|---|
| `applied` | 已投递 | `#fff4df`（柔暖琥珀） | `#b86b00` | `#f5d89e` |
| `assessment` | 笔试/测评 | `#e6f5f0`（柔浅青绿） | `#1f7a63` | `#b8e3d5` |
| `interview` | 面试中 | `#e8f1ff`（柔浅天蓝） | `#1d5bbf` | `#bdd5ff` |
| `offer` | 录用 | `#e7f7ec`（柔浅翠绿） | `#1b7a3d` | `#b7e4c7` |
| `rejected` | 拒绝 | `#fdeceb`（柔浅珊瑚红） | `#c93b3b` | `#f8c6c3` |
| `closed` | 已结束 | `#f1f3f5`（柔浅中性灰） | `#5c6573` | `#d8dde4` |
| `pending` | 待投递 | `#f4f2ff`（柔浅淡紫） | `#5b46b8` | `#d9d2fc` |

   - 若记录存在 `roundText`（如 `一面`、`二面`）或 `due_for_review`（「待回看」），以轻量小徽标紧跟在状态色块后，不破坏色块本体对齐。

### 2.4 「已投天数」统一计算规则（`server/src/domain/applications.js`、`web/assets/js/views/ledger.js`、`web/assets/js/util.js`）

1. **统一基准日期优先级（Asia/Shanghai 自然日口径）**：
   - 在后端 `applicationProjection(app, preferences, asOf)` 中计算 `days_since_applied`（保持上海时区自然日差 `daysBetweenShanghai(anchorAt, asOf)`，与提醒、统计口径一致）：
     1. 优先取 `app.applied_at`（插件/手动投递为实际投递日期；邮件自动入账为该邮件的收件日期）；
     2. 若 `app.applied_at` 为空，其次取 `app.stage_received_at`（邮件进展收件日期）；
     3. 若仍为空（且记录已进入投递明细，或属于历史记录），回退取 `app.created_at`（用户/系统将该记录加入投递明细的日期）。
   - 同时在响应中保留 `applied_at`、`applied_at_precision`，不破坏既有 API 契约；前端也可在极端缺字段时做同口径兜底计算。
2. **前端统一展示文案**：
   - 不再对 `applied_at_precision === 'inferred_before'` 展示长串 `≤ 2026-11-19（据邮件推断）`，统一直接展示天数：
     - `days === 0` → `今天`（或 `0 天`）
     - `days > 0` → `${days} 天`
     - `days < 0`（异常未来时间）→ `0 天`（并在 `title` 中注明基准日期）
   - 将基准日期与来源放入单元格 `title` 提示（例如：`基准日期：2026-11-18（据邮件收件日期）` 或 `基准日期：2026-11-18（加入投递明细日期）`），兼顾界面简洁与信息可追溯。
   - 待回看超期高亮类名 `.tn-days-late` 保留。

### 2.5 「更新时间」精确到日期（`web/assets/js/views/ledger.js`）

- 将更新时间单元格从 `fmtDateTime(item.updated_at)` + `台账更新时间` 副行，改为单行 `fmtDate(item.updated_at)`（输出 `YYYY-MM-DD`，上海时区）。
- 在该单元格 `title` 属性保留 `fmtDateTime(item.updated_at)`，悬停时仍可看到精确到分钟的时间。

## 3. 兼容性影响与 E2E 用例适配说明

经检索仓库，移除 `#tn-tabs` 后，以下既有 E2E 脚本中存在对 `[data-test=tab-viewed]` 的点击断言，需同步改为通过左侧栏 `[data-test=nav-viewed]`（或 URL）切换视图，**不要删除或跳过任何断言**：

- `tests/e2e/run-web-e2e.mjs`（约 L325）
- `tests/e2e/plugin-acceptance.mjs`（约 L87、L94、L156）
- `tests/e2e/toast-feedback.mjs`（约 L68）

同时核查 `tests/` 下是否有针对台账列数、表头文案（`JD 摘要` / `投递渠道` / `查看岗位`）或 `≤ YYYY-MM-DD（据邮件推断）` 的旧断言，一并按新规范更新，其余业务逻辑断言保持不变。

## 4. 实施步骤与回归验收清单

### 4.1 实施顺序

1. **后端天数口径升级**：更新 `server/src/domain/applications.js` 中 `days_since_applied` 的基准日期回退规则，并补充单测。
2. **前端台账与样式改造**：更新 `web/assets/js/views/ledger.js`、`web/assets/js/util.js`、`web/assets/app.css`，完成去顶部标签栏、5 列重构、颜色块状态选择器、纯天数展示和 `YYYY-MM-DD` 更新时间。
3. **测试适配与新增用例**：适配上述 E2E 导航选择器，并补充台账新 UI 专项测试（5 列表头、无 `#tn-tabs`、颜色块状态切换与持久化、邮件收件日/加入日天数计算、更新时间仅显示日期）。
4. **全量回归与真机截图验收**：跑通全部测试套件，并在本地 `http://127.0.0.1:4324` 截图核验桌面端与窄屏效果（截图放 `.tmp/`，不提交进 git）。

### 4.2 必跑回归套件（不得引入任何新失败）

- `npm test`
- `npm run test:web`
- `npm run test:e2e`
- `npm run test:panel`
- `npm run test:career-ai`
- `npm run test:netease-game`
- `npm run test:intake`
- `npm run test:mail-admin`
- `npm run test:mail-progress`

### 4.3 验收标准

1. 打开 `http://127.0.0.1:4324`，页面无顶部 `投递明细 / 看过没投 / 待确认 / 已归档` 标签栏，直接展示 5 列明细表（`公司`、`岗位`、`状态`、`已投天数`、`更新时间`），不再出现 `JD 摘要`、`投递渠道`、`查看岗位` 列。
2. 通过左侧导航切换「看过没投」「待确认」「已归档」以及点击任意行打开详情抽屉（查看 JD、渠道、岗位链接、编辑纠错）全部正常。
3. 「状态」列呈现柔和圆角颜色块，点击可直接下拉切换状态，保存后颜色块即时更新且刷新不丢失。
4. 「已投天数」直接展示天数（如 `3 天` / `今天`），邮件来源与手动/插件来源均按基准日期正确计算。
5. 「更新时间」仅展示 `YYYY-MM-DD`，无时分与「台账更新时间」副文案。
