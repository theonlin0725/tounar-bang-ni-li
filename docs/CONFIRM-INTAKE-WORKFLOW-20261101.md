# 确认入账：LLM + Jev 工作流实现与联调（2026-11-01）

## 根因

旧版确认按钮直接调用 `POST /api/v1/review-items/:id/assign`，前端只传状态/日期，服务端 `assignReview` 没有公司/岗位必填校验，也不调用 LLM/Jev；因此：

- 公司/岗位为空也能创建台账；
- 邮件抽取出的 `company_name="面试通知"`、`job_title="您已成功预约招商银行面试"` 被原样写入；
- 表格显示“面试 | 招商银行”不是列映射交换，而是上游邮件字段提取错误后被旧接口直接接受；
- 对已有台账的确认路径还会忽略用户在补录表单里修改的公司/岗位。

## 卡死根因（2026-11-01 15:40 实际核对）

截图中的旧卡片有“状态下拉 + 实际投递时间”且没有公司/岗位输入框，而当前磁盘上的新版 `reviews.js` 已移除这些控件，改为“确认入账 → 识别中 → 补录弹窗”。实际阻塞不是服务端“先校验空字段”，而是浏览器仍运行旧前端模块：

1. 静态 JS 曾返回 `Cache-Control: public, max-age=300`；用户标签页在修改前加载了旧 `reviews.js`，30 分钟缓存有效期内不会取新文件。
2. 旧模块仍调用旧 `/assign`，只传状态/日期；服务端新校验返回 `REVIEW_FIELDS_REQUIRED`，旧页面没有补录表单，于是只剩一条错误和日期框。
3. 版本化入口还暴露了重复模块问题：页面同时加载 `app.js?v=...` 与 `app.js`（视图里的 `../app.js` 未带版本），导致两个 `boot()`、两个 `tn-main`、同一待确认渲染两份。实测 5 条待确认出现 10 张卡。
4. 修复：JS/CSS 改为 `no-store`；入口、`ledger.js`、`reviews.js` 等使用同一版本号；`renderReviews` 先清空容器；`app.js` 的引用全部统一到同一 URL。修复后实测 1 个 `tn-main`、1 个 reviews-view、5 张卡。

因此新代码本身已有补录弹窗；用户截图是旧模块缓存造成的旧界面。现在需要刷新一次，之后不会再出现 5 分钟旧 JS。

## 新流程

`POST /api/v1/review-items/:id/intake`

1. 服务端读取 review 关联的原始 event/mail，取主题、正文/摘要、JD、链接、状态文本和现有字段线索。
2. 真实 DeepSeek `deepseek-flash` 提取公司、岗位、状态、证据；不把旧前端/旧模型结论当事实。
3. 查询当前用户候选台账。
4. 真实 Jev 判断：实际进展、字段有效性、字段一致性、状态、候选归属、新旧。
5. 服务端校验：
   - 公司/岗位必须非空且不是“待补充/未知/面试/通知/提醒/系统判断”等占位/阶段词；
   - 状态必须有可靠结果；
   - 归属不唯一时返回补录，不盲目合并；
   - 已投递无实际投递时间时使用邮件收信上界/提交事件时间，不用确认时间冒充。
6. `ready` 时服务端在同一个业务写入中更新/创建台账并关闭待确认；`needs_input` 只返回预填字段和候选，不写任何表；技术失败返回可重试错误，不静默创建空白。

`POST /api/v1/review-items/:id/assign` 仍是最终写入接口，但已加严：

- 公司/岗位必填、占位词拒绝；
- 用户修改的公司/岗位会应用到原记录（旧实现会忽略）；
- 版本冲突/幂等仍由服务端处理，重复点击只产生一次业务结果。

前端 `web/assets/js/views/reviews.js`：

- 卡片只有“确认入账/忽略”，不再有默认状态下拉框直接写库。
- 点击后按钮显示“识别中…”，重复点击被禁用。
- 可靠 → 直接保存、刷新统计；
- 缺字段/歧义 → 弹窗预填可靠字段，只要求补缺失/纠正；状态空时用户必须选择，不能默认“已投递”；
- 取消 → 不发 assign，待确认保持 open；后台后续回调也不会替用户入账；
- 模型失败 → 显示“识别/核验失败，未创建台账”，提供“重试识别”和“手动填写”；
- 保存失败保留输入；成功后只关闭待确认。

## “直连失败”到底指什么（2026-11-01 18:49 实测）

| 路径 | 实测结果 | 结论 |
|---|---|---|
| 本机服务 → TypeSafe Jev `api.typesafe.ai/v1/systemone` | HTTP 451，约 1026ms，`Typesafe is not available in your region` | 直连 Jev 被地区限制 |
| 本机服务 → Dify API `/v1/workflows/run` | HTTP 200，约 2736ms，状态 succeeded | Dify 调用正常 |
| Dify 工作流内部 → TypeSafe Jev | 成功，返回公司/岗位/状态判断 | Jev 真实调用成功 |

所以截图中的“直连失败：JEV_UNAVAILABLE”只表示**本地直连 TypeSafe Jev** 失败，不是 Dify 失败：
`Jev 判断：成功 · 经 Dify`、`Dify 调用：成功` 才是实际结果。前端已把这段改成：

```text
核验路径：经 Dify 调用真实 Jev
本地直连 Jev：失败（JEV_UNAVAILABLE 地区/网络限制），已自动转 Dify
```

不再把内部字段 `dify_fallback` 和“直连失败”混在一起展示。

## 真实 Jev 结论

本机直连 TypeSafe 实测：

```text
POST https://api.typesafe.ai/v1/systemone
HTTP 451
{"title":"Typesafe is not available in your region.","status":451}
```

因此：

- 配置已被服务读取（不是没配）；
- 旧直连调用会触发，但当前本机出口被地区限制；
- 服务端现在先尝试直连 Jev；遇到 `JEV_UNAVAILABLE` 时转 Dify Cloud 工作流，由 Dify 的 HTTP 节点真实调用同一 TypeSafe Jev，再用其输出参与字段/状态/归属分流；
- 返回体会显式标记 `analysis.verification="dify_fallback"` 和 `analysis.direct_jev_error`；
- 若 Dify 也不可用，返回 `INTAKE_RECOGNITION_FAILED`，不创建台账。

### 实际产品路径证据

- 真实 4311 待确认卡片：点击中国农业银行 → 识别 → 弹窗公司预填“中国农业银行”，岗位/状态为空（请求 `req_C4nkTrVTxoA6eArs`，Dify 运行 `c7f384f9-93d9-4a9f-8267-59c436eadec3`）（Jev 认为进展证据不足，不默认已投/笔试），日期预填邮件收信上界；取消后复核 DB 仍为 open，没有新台账。
- 隔离库真实 DeepSeek + Dify/Jev 联调：星河科技/数据产品实习生/面试，`analysis.verification=dify_fallback`，Dify 工作流运行 id `cd6c770c-4043-4fa6-a80e-8bf4f643ac38`，最终创建一条 `interview` 台账，未产生重复。
- 服务端 `INTAKE_RECOGNITION_FAILED` 路径：Jev/Dify 失败时返回可重试错误，review 保持 open；前端显示重试/手动。
- 单测（隔离假模型）覆盖：可靠直接入账、只识别公司需补岗位、字段错位不进库、模型失败不写、重复确认幂等。

## 截图

- [真实 4311 识别完成：公司预填、岗位/状态待补，展开识别详情](assets/confirm-intake-live.png)
- [隔离库真实 LLM/Jev：只有公司时打开补录表单](assets/confirm-missing-modal.png)
- [补齐岗位/状态后入账成功、待确认移除](assets/confirm-ui-applied.png)
- [真实成功请求的识别详情（LLM/Jev/Dify/request id）](assets/confirm-ui-trace.png)
- [模型失败后的重试/手动填写](assets/confirm-manual-error.png)
- [历史记录「补充信息」自动展开纠错表单](assets/supplement-form-live.png)

## 字段映射排查

- `createApplication`/`assignReview` 的 company/title 写入字段是明确的，不存在列交换。
- 旧错位来自 `processMailEvent` 对邮件主题的提取：`company_name="面试通知"`、`job_title="您已成功预约招商银行面试"`。
- 新链路用原文证据+Jev `company_valid/job_title_valid/fields_consistent` 复核；疑似错位返回补录，不自动交换两列。
- 台账/详情展示直接读取 `company_name`/`job_title`；截图中的“面试 | 招商银行”是历史数据错误，不是表格把列对调。

## 历史记录

见[历史字段修复对账](HISTORICAL-FIELD-REPAIR-20261101.md)：当前 17 条缺失/占位/疑似错位；没有足够证据自动修全，全部提供「补充信息」入口；0 自动修复、0 失败、0 新建/删除。人工修改的 11 条不被覆盖。

## 边界

- 本机无法直连 TypeSafe Jev（HTTP 451）；正式产品通过 Dify Cloud 兜底，仍可能受 Dify/Jev 可用性影响。
- 真实 4311 联调只做了不写库的补录/取消路径；自动入账使用隔离库，避免改用户正式台账。
- Dify 只做判断，不写帮你理数据库；最终保存仍由服务端完成。
