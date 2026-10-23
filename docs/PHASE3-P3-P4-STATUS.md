# P3/P4 · 站点抓取与可选项目状态（2026-10-23 本机实测）

## 1. 本轮真实浏览器实测结果

| 站点 | 本轮动作 | 结果 |
|---|---|---|
| 百度 | `talent.baidu.com/jobs/social` 用 Chrome for Testing 156 打开 | 仍然 **跳 `about:blank`**（status 200，无 DOM）→ 实时取证不可能；改用留档分支里的 2 份真实快照做离线回放，**已通过**（见下） |
| BOSS | `zhipin.com/web/geek/job?...`，headless 与 **headed** 都试过 | headless 掉回首页；headed 直接跳 `passport-zp` 登录页（URL 带 `_security_check=1`），拿不到职位列表/详情 → 不绕过。需要用户本机已登录的 Chrome |
| 小红书（白名单外） | 列表页可打开（200），取到 2 个真实详情 URL：`/campus/position/22013`、`/campus/position/22011` | **已修复并取证**：两页原本不产生 `job_viewed`（页面没有 h1/h2，岗位名在普通 `div.text-title` 里）。新增通用兜底「投递按钮附近重复出现的标题」后，两页均识别成功，快照入 `tests/fixtures/sites/xiaohongshu/` |

## 2. 百度：有两份真实快照，但当前适配器认不出

另一版适配器（`0.2.0-draft`，本地另一 agent 于 2026-10-23 01:12 在本机采集）确实抓到过 2 个百度详情页，快照 HTML 根节点还留着当时的检测标记：

```
data-tounar-adapter="baidu"  data-tounar-adapter-version="0.2.0-draft"
data-tounar-job-title="DuMate生态运营（J100426）"  data-tounar-detection-score="0.95"
data-tounar-job-title="北京-网络研发工程师(J100700)"  data-tounar-detection-score="…"
```

用**当前二期适配器**回放这两份 DOM：`job_viewed` 事件为 `null`，即**认不出**。
两份快照只存在于留档分支 `archive/local-phase2-alt-20261022`（`tests/fixtures/sites/baidu/`），没有并入二期。

结论：百度不是“页面拿不到”，而是**当前适配器比那版弱**。

本轮已修：两处根因都在通用规则里，不是百度专属选择器——

1. `visible()` 把类名包含 `recommend` 的元素整棵排除，而百度投递按钮的类名恰好是 `recommend-btn__*`，导致“页面没有投递按钮” → 直接判定不是岗位页。改为：表单/输入类排除包含节点自身，容器类排除只看祖先。
2. 详情页标题不是 `h1/h2`，是 `div[class*="title"]`。新增 `titleClassNearApply`：整页唯一投递按钮、文本在按钮 6 层祖先内、2–60 字、过 `validTitle`、位置上在按钮上方且距离 ≤900，按 DOM 顺序取第一个（面包屑/主标题先于副标题和“相关链接”），打分 74。

结果：两份百度快照回放**标题、公司（百度）、JD 全部正确**，快照入 `tests/fixtures/sites/baidu/`，`cases.json` 26 条。
**边界**：DOM 是 2026-10-23 01:12 由另一版适配器在本机采集的，本轮实时访问仍不可用，所以站点表标「2/2（离线回放）」，不算线上验收通过。

## 3. 本轮新增的通用兜底（已落地）

SPA 招聘站（小红书这类）不放 `h1/h2`，岗位名是普通 `div`，但会**重复出现两次**（面包屑 + 标题），
且整页只有一个投递按钮。据此加了一条**低权限兜底**（`extension/content/tracker.js`）：

- 只在「没有任何中高把握标题候选」时启用；
- 要求整页**恰好一个**投递按钮；
- 候选文本必须在按钮 5 层祖先容器内、是叶子节点、2–60 字、过 `validTitle`；
- 必须**在页面正文中出现 ≥2 次**（过滤弹窗/列表的单次标题）；
- 打分 74（medium），字段来源 `repeated_text_near_apply`。

效果：小红书两页 `job_title` medium 正确、JD 由既有「工作职责」段落规则带出；公司/城市仍按策略留空。
回归：`npm run test:e2e` 63/63 不变；`tools/replay-sites.mjs` 24/24 与预期一致（含新增两页）。

## 4. 白名单外通用性进展

| 站点 | 状态 |
|---|---|
| 米哈游 / Airbnb | 云端已证 2 页/家，公司+城市留空 |
| 小红书 | ✅ 本轮实时 2 页，识别成功并入库快照 |
| 其余（快手 / 哔哩哔哩 / 莉莉丝） | 本轮未测 |

目标“再测 3 家各 2 页”：白名单外现共 3 家（米哈游、Airbnb、小红书）各 2 页。

## 4. P4 可选：低把握时用大模型补字段

未做。`server/src/cloud/llm.js` 目前只服务邮件解析兜底；`CLOUD_LLM_FIELD_EXTRACT` 开关和“只传岗位名附近 ≤1500 字”的插件侧抽取都没有实现。

## 4.5 BOSS 的准确状态

- 本机 headless / headed 两种 Chromium 都在 `_security_check` 后跳登录页；未登录拿不到任何岗位详情。
- `bsk`（借用户浏览器）当前 **0 个浏览器连接**：daemon 在跑，但扩展没连上，所以也借不到会话。
- 只要用户在自己 Chrome 里打开 BOSS 并保证 bsk 扩展已连接，或直接给出两个岗位链接，这一步就能继续；不绕过验证。

## 5. 建议的下一步（需要你拍板）

1. 是否把 A 版百度适配器移植进二期（工作量：选择器 + 2 份快照回归 + 站点表更新）。
2. 白名单外站点是继续逐家适配，还是先把“认不出就留空、不猜”作为可接受行为。
3. BOSS 需要你本机**已登录的正常 Chrome** 才能看真实详情；如果要，我可以走你浏览器的正常会话，但仍不绕过任何验证。
