# 插件升级 · 本轮交付与实测（2026-10-24）

> 状态：**三个能力的代码主链路已落地；站点覆盖与学习复用只完成了一部分**。
> 下面每一条都标了「已实测 / 未实测」，没测到的不写成通过。

## 1. 三条根因（代码位置已复核）

| # | 现象 | 根因 |
|---|---|---|
| 1 | 授权后不采集 | `popup.js` 的 `grant-current` 只做 `permissions.request` + `registerContentScripts`，**没有对当前已打开标签页执行脚本**；页面不刷新就不会有 content script |
| 2 | JD 只有 80 字 | `tracker.js` `MAX_JD_CHARS = 80` + `plugin.js` 把 `jd_summary` 归一化到 80，且数据库没有完整 JD 字段 |
| 3 | 快速采集被 3 秒停留卡住 | `job_viewed` 的发送条件是 `visibleMs >= DWELL_MS(3000)`，没有独立的“显式采集”事件 |

## 2. 本轮改动

### 2.1 授权即采（功能二）

- `popup.js`：授权按钮文案改为「将本站设为招聘网站并授权」；授权成功后调用 service worker 的 `capture_current_tab`，并显示「已授权，正在识别当前页…」→ 结果状态。
- `service-worker.js`：新增 `capture_current_tab`：校验权限 → `chrome.scripting.executeScript` 注入 `lib/learned.js`、`content/adapters.js`、`content/tracker.js`（tracker 有 `__tounarTrackerLoaded` 守卫，重复注入无害）→ `tabs.sendMessage(tounar_capture_now)` → 把结果写进 `lastCapture`（耗时、状态、岗位名）。
- `tracker.js`：新增 `captureNow()`，发 **`job_captured`** 事件（强证据 + `explicit_capture`），**不伪造 visible_dwell_ms**；新增 `tounar_ping`。
- `plugin.js` / `applications.js`：允许 `job_captured`；处理时复用浏览逻辑但跳过停留门禁，仍要求强证据，落库为 `pending`（不计已投递）。

**已实测**：本机真实页面调用 `__tounarCapture()`，9 个站点都拿到岗位并生成 `job_captured` 事件（见第 3 节）。
**未实测**：popup 按钮 → SW → 页面这条完整链路还没有在真实 Chrome 里跑（需要你本机加载扩展点一次，或我下一轮用 e2e 补）。

### 2.2 完整 JD（功能一）

- 插件：`jd_summary` 仍 80 字；新增 `jd_text`（最多 20000 字，保留换行）；二者同源同分。
- 服务端：新增 `applications.jd_text` 列与增量迁移；`plugin.js` 校验（>20000 字**显式拒绝** `JD_TEXT_TOO_LONG`，不静默截断）；`applications.js` 落库/补全；详情接口返回 `jd_text`（列表不带，避免每行 20K）。
- 前端：详情抽屉新增「JD 全文」区块（`white-space: pre-wrap`，限高滚动）。
- 测试：新增两条服务端用例（`job_captured` 落库完整 JD；超长 JD 被拒绝）。

**已实测**：腾讯 201 字、小米 85、美团 311、网易 159、京东 232、字节 507、米哈游 153、实习僧 285、小红书 326 —— 都**不是** 80 字截断。
**未实测**：前端详情页在真实浏览器里展示 JD 全文（web e2e 还没覆盖这一条）。

### 2.3 模板学习 v1（功能三）

- 新增 `extension/lib/learned.js`：按 `origin + 路由形态` 存模板（title/company/jd 的 CSS 选择器），状态 `trial → stable → suspect`，存 `chrome.storage.local`，跨重启可用。
- `tracker.js`：启动时异步载入模板，命中则作为快速路径（分数 90）；选择器失效时标记 `suspect` 并降级到通用识别。
- `popup.html/js`：新增「已学习的页面模板」区块，列出站点/路径/状态/成功失败次数，支持删除单条与清空。

**已实测**：学习动作本身会写入（`captureNow()` 返回 `learned: 'trial'`）。
**未实测（重要）**：**“第二次访问优先用学习模板”还没有在真实浏览器里得到证据**。我用本地 mock 存储跑了两次，第二次仍走站点适配器（`site_selector`），原因是我在页面里伪造的 `chrome.storage` 没能在刷新后保留。这条必须在真扩展环境里验，不能算完成。

## 3. 真实站点实测矩阵（2026-10-24，headless Chrome for Testing 156，本机）

测法：打开真实详情页 → 注入 adapters/tracker → 5 秒后调用 `__tounarCapture('verify')` → 记录本地识别耗时与字段。
**这不是插件全链路验收**（没有 popup、没有后端、没有前端可见性），只证明「页面识别 + 完整 JD 抽取」这一段。

|站点|样本|识别|本地耗时|标题|公司|城市|批次|JD 字数|备注|
|---|---|---:|---:|---|---|---|---|---:|---|
|腾讯|jobdesc postId=2099…|✅|20–23ms|✅|腾讯|上海|—|201|基准|
|小米|/job/view/714|✅|26ms|天线工程师|小米|Peking|—|85|城市值是站点的 "Peking"|
|美团|jobUnionId=4697320043|✅|12ms|AI全栈工程师|美团|北京市、上海市、成都市、深圳市|应届-校园招聘|311|多城市保留|
|网易|id=78226|✅|16ms|海外产品运营实习生（网易画加）|网易|广州市|—|159||
|京东|requementId=226996|✅|19ms|产品运营|京东|北京市|—|232||
|字节|团校招 detail|✅|22ms|AI Agent产品经理 - 巨量AI工作台|字节跳动|上海、北京|2027 校园招聘|507||
|米哈游|/#/position/9707|✅|9ms|资深Unreal游戏客户端工具开发…|—|—|—|153|hash 路由；公司/城市留空|
|实习僧|/intern/inn_lri5…|✅|19ms|企业用户运营/项目运营|简单心理|北京|—|285|公司来自岗位卡片|
|小红书|/campus/position/22013|✅|5ms|【2027校招】媒体网络研发工程师-流媒体方向|—|—|—|326|公司/城市留空|
|拼多多|/jobs/detail?code=…|❌|—|—|—|—|—|—|**页面自身返回「职位已过期或不存在」**（试了 3 个 code），识别器正确拒绝，不算我们的失败|
|OPPO|careers.oppo.com|❌|—|—|—|—|—|—|入口是 JS 渲染，猜的职位列表路径 404，没找到可用详情|
|快手|campus.kuaishou.cn|❌|—|—|—|—|—|—|列表卡片是 div 无链接，需点开抽屉；本轮没做点击流程|
|BOSS|zhipin.com|❌|—|—|—|—|—|—|仍然需要登录态浏览器，未绕过|

**覆盖率结论（如实）**：10 个必选站里 **9 个至少采到 1 个真实详情**；但需求要求「每站 1 列表 + 3 详情」，**这条没达标**（每站基本只有 1 个详情，列表采集未验）。

## 4. 性能（只测了“本地识别”一段）

- 本地识别（已有页面内容 → 结构化结果）：**5–28ms**，9 个站点全部远低于 P95 ≤ 1s 的目标。
- **没有测**：交互反馈 300ms、上传同步 P95 ≤ 2s、首次学习 15s、每场景 30 次采样、与腾讯 P50/P95 的 1.2×+200ms 对比。这些需要真扩展 + 后端 + 定速网络，本轮没做，不能算通过。

## 5. 未完成清单（按需求章节）

1. **功能二全链路**：popup 按钮 → SW 注入 → 页面采集 → 上传 → 前端可见，未在真实 Chrome 里跑通一次。
2. **列表页采集**：未实现/未验证；当前只采详情。
3. **学习复用与失效重学**：代码在，但“第二次访问走模板”“改版降级重学”没有真扩展证据。
4. **站点**：OPPO / 快手 / 拼多多（站点侧过期）/ BOSS 未完成；其余 9 站缺“每站 3 个详情 + 1 个列表”。
5. **页面类型识别**（首页/列表/详情/申请表单/状态页/登录页）目前仍是启发式，未按需求逐类验证。
6. **大模型增强**：未接入（`llmExtractPageLead` 仍在，但没有开关、没有节点回传协议）。
7. **精确率/召回率报告**：只做了逐字段人工核对（上表），没有按“正确/错误/漏采/原页缺失”统计分母。
8. **回归**：`npm test` 88/88、`test:e2e` 67/67、`test:web` 52/52 全绿；但新增的 `job_captured`/`jd_text`/学习链路**只有服务端单测**，e2e 未覆盖。

## 6. 建议的下一轮顺序

1. 用 e2e 把「授权即采」跑通（fixture 页 + popup 点击），并补前端 JD 全文断言；
2. 在真扩展里验学习复用（A 岗学习 → B 岗复用 → 改结构后 suspect → 重学）；
3. 拿 OPPO/快手各 1 个真实详情（需要点击/滚动流程）补齐；
4. 再谈 30 次采样与 P50/P95 性能报告——那需要固定测试脚本和环境，当前样本量不足以出数。

## 7. 文件清单

- `extension/lib/learned.js`（新）
- `extension/content/tracker.js`（jd_text、captureNow、模板快速路径、payload）
- `extension/background/service-worker.js`（capture_current_tab）
- `extension/popup/popup.{html,js}`（授权即采、采集按钮、学习列表）
- `extension/scripts/make-test-build.mjs`（测试构建注入 learned.js）
- `server/src/schema.sql`、`db.js`、`plugin.js`、`domain/applications.js`、`domain/ledger.js`（jd_text、job_captured）
- `web/assets/js/views/detail.js`（JD 全文）
- `server/test/events.test.js`（两条新用例）
