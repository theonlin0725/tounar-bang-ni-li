# P3/P4 · 站点抓取与可选项目状态（2026-10-23 本机实测）

## 1. 本轮真实浏览器实测结果

| 站点 | 本轮动作 | 结果 |
|---|---|---|
| 百度 | `talent.baidu.com/jobs/social` 用 Chrome for Testing 156 打开 | **跳 `about:blank`**（status 200，finalUrl=about:blank，无 DOM）→ 与云端结论一致，无法取证 |
| BOSS | `zhipin.com/web/geek/job?...` 打开 | 被重定向回首页，拿不到职位列表/详情 → 不绕过 |
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

结论：百度不是“页面拿不到”，而是**当前适配器比那版弱**。要补，得把 A 版百度选择器移植过来并配回归——本轮没做。

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

## 5. 建议的下一步（需要你拍板）

1. 是否把 A 版百度适配器移植进二期（工作量：选择器 + 2 份快照回归 + 站点表更新）。
2. 白名单外站点是继续逐家适配，还是先把“认不出就留空、不猜”作为可接受行为。
3. BOSS 需要你本机**已登录的正常 Chrome** 才能看真实详情；如果要，我可以走你浏览器的正常会话，但仍不绕过任何验证。
