# 插件：轻量反馈 + 识别准确度（2026-10-26）

对应 [PLUGIN-FEEDBACK-ACCURACY-PROMPT-20261026](PLUGIN-FEEDBACK-ACCURACY-PROMPT-20261026.md)。
**功能 A 完成并有自动化验证；功能 B 只做了一处有证据的修复，样本量远未达到任务书要求，如实写在下面。**

---

## A. 页面轻量反馈（已实现 + 自动化验证）

### A.1 实现

| 层 | 改动 |
|---|---|
| 服务端 | 事件回执新增 `outcome`（created/updated/unchanged/review/applied）、`application_status`、`has_applied`、`missing_fields`；`accepted`/HTTP 200 不再被当作入账 |
| service worker | 记录「事件 → 来源标签页/URL」，上传后校验标签页仍是同一页面（origin+pathname），再把回执发给该页；多事件合并成一条汇总；`pageFeedback` 关闭时不发 |
| 内容脚本 | Shadow DOM 隔离的右下角 Toast：`帮你理` 品牌、关闭按钮、`aria-live=polite`、不抢焦点、4 秒（需操作 8 秒）自动消失、同内容 5 秒去重、`prefers-reduced-motion` 生效 |
| popup | 新增「在招聘网页上显示采集提示」开关（默认开），关闭后 popup 状态仍在 |

状态文案（全部由服务端回执决定，不由页面猜）：

| 回执 | 文案 |
|---|---|
| created | 当前岗位已计入「看过没投」；缺字段追加「，部分信息待补充」 |
| updated | 当前岗位信息已更新 |
| unchanged | 自动浏览静默；主动采集显示「该岗位已在台账中」 |
| review | 当前岗位信息需要确认（带「查看台账」→ `?panel=reviews`） |
| queued | 当前岗位待同步，连接恢复后自动重试 |
| failed | 尚未保存，请打开插件查看原因 |
| batch | 「本页 N 个岗位已保存，M 个待确认/待同步」 |
| 无 outcome | 中性文案「当前岗位已保存到台账」 |

「查看台账」用当前后台地址拼 `/?app=<id>` 或 `/?panel=reviews`，不写死端口，只在用户点击时打开。

### A.2 验证（`npm run test:plugin-acceptance`，真实扩展 + 真实后端）

新增断言：

1. 采集成功后页面出现 Toast，文本含「看过没投」（截图 `docs/acceptance/toast-viewed.png`）；
2. 关闭 popup 开关后再采集，**不再出现 Toast**，但 popup 状态仍更新；
3. 断网采集时 Toast 显示「待同步」；
4. 原有用例继续验证：只有服务端给出 `application_id` 才算入账、重复采集不重复、A→B 切换不串提示。

### A.3 已知限制

- 「事件 → 标签页」映射存在 service worker 内存里：SW 休眠会丢，Toast 退化为不显示（popup 状态不受影响）。这是有意的轻量降级，未做持久化。
- 列表页多岗位汇总已实现（同一批 flush 按标签页聚合），但自动化里只验证了单个岗位的文案，没有对「本页 N 个」做截图断言。

---

## B. 识别准确度（只完成一处有证据的修复）

### B.1 发现的问题与修复：腾讯 JD 丢章节标题

实测 `careers.tencent.com/jobdesc.html?postId=…`：

- 修复前：`jd_text` 有职责/要求正文，但**没有「岗位职责 / 任职要求」分界**（父容器里有 introduction/duty/requirement 三个模块，正文节点本身不带标题）；
- 修复后：verified 适配器按父容器语义补回 `岗位职责` / `任职要求` / `项目介绍` 标签，正文仍保留原始换行。

证据（同一页面、同一提取器）：

```
修复前 len=437 hasDuty=false hasReq=false
修复后 len=447 hasDuty=true  hasReq=true
```

第二页（《三角洲行动》-系统策划）同样从「只有要求正文」变成带「岗位职责/任职要求」分段。
摘要字段（`jd_summary`）仍取第一段，旧回归不受影响。

### B.2 样本与能力边界（如实）

| 项 | 本轮情况 |
|---|---|
| 真实详情样本 | 腾讯 2 个详情（`postId=2099730961662128128`、`1942052496046424064`） |
| 其他站点 | 未在本轮重新采样 |
| 列表页 | 未验证。`careers.tencent.com/search.html` 在 headless 下没有 `<a href=jobdesc>`，适配器走页面自身的 Query 接口 replay；本次探测拿到 0 条链接，不能宣称列表采集可用 |
| 字段准确率 | **没有做**逐字段人工对照，不能给精确率/召回率数字 |
| BOSS / 登录态 / 首次授权 | 仍未验证 |

分类结论：

- **已实现且本轮样本验证通过**：腾讯详情页的公司、标题、城市、岗位 ID、链接、JD 全文（含职责/要求分段）。
- **支持但不稳定**：其他白名单站点（旧样本通过，本轮未复测）。
- **当前不支持/未验证**：腾讯搜索页列表发现、BOSS 登录态、10 站各 1 列表 + 3 详情的验收矩阵。

---

## C. 测试

| 命令 | 结果 |
|---|---|
| `npm test` | **101/101** |
| `npm run test:e2e` | **67/67** |
| `npm run test:web` | **52/52** |
| `npm run test:plugin-acceptance` | **失败 0**（含新增 Toast 断言） |

## D. 文件

- `server/src/plugin.js`：回执补 `outcome / application_status / has_applied / missing_fields`
- `server/src/domain/applications.js`：`missingCoreFields()`；`processView` 返回 created/updated/unchanged
- `extension/background/service-worker.js`：来源标签页映射、`deliverFeedback`、`set_page_feedback`、回执字段
- `extension/content/tracker.js`：Shadow DOM Toast、反馈文案、章节标签补全、pending/queued 提示
- `extension/lib/common.js`、`extension/popup/popup.{html,js}`：`pageFeedback` 开关
- `tests/e2e/plugin-acceptance.mjs`：Toast 断言与截图

## E. 未完成

1. 10 站 ×（1 列表 + 3 详情）的字段/JD 矩阵与准确率数字；
2. 腾讯搜索页列表发现（headless 下拿不到卡片链接）；
3. BOSS 登录态、首次授权权限全流程；
4. 列表多岗位汇总文案的自动化断言；
5. 可选模型辅助提取（未接入）。
