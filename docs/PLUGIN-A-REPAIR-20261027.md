# 插件 A：页面 Toast 修复记录（2026-10-27）

对应 [PLUGIN-A-REPAIR-PROMPT-20261027](PLUGIN-A-REPAIR-PROMPT-20261027.md) 与
[PLUGIN-A-ACCEPTANCE-20261027](PLUGIN-A-ACCEPTANCE-20261027.md) 的 6 组问题。
本轮只修 A（页面轻量反馈），未改 B 的识别逻辑。

新增可重复测试：**`npm run test:toast`**（`tests/e2e/toast-feedback.mjs`，13 项，真实扩展 + 隔离后端 + 本地 fixture + 测试代理）。
本次实跑：**13/13 通过**。

## 1. [P1] A 岗回执在 B 岗页面报成功 —— 已修

- 采集事件入队时记录：`tabId / frameId / 完整 URL（含 query、hash）/ 岗位身份 / 事件类型 / 时间`；
- 岗位身份 = `站点:ID:<site_job_id>`，没有 ID 时用完整规范化 URL；
- SW 投递前用**完整 href** 比较（`?postId=5001 → 5002`、`#/job/1 → #/job/2` 都算离开）；
- 内容脚本显示前再用 `detectJob()` 算一次当前岗位身份，与回执绑定的身份不一致就不显示；
- 列表汇总只认列表页上下文，要求完整 URL 一致；
- 已离开/关闭/无法证明属于当前任务时，页面不显示，结果仍留在 popup 的 `lastEventResults`。

验证（真实扩展，测试代理暂扣回执后切到 5002 再释放）：

- `A 岗回执延迟到 query 切换后，不得在 B 岗报当前岗位成功` —— PASS；
- `页面身份比较必须区分 hash 岗位（契约检查）` —— PASS；
- 截图：`docs/acceptance/toast-stale-query.png`。

未单独实测：同 URL 抽屉 A→B（身份比较已覆盖该条件，但没有真实抽屉样本）、A→B→A、多标签并行。

## 2. [P2] 开关不完整 —— 已修

- `get_status` 返回 `pageFeedback`（之前漏返回，popup 把 undefined 当开启）；
- 内容脚本启动即读 storage，监听 `storage.onChanged` 与 `tounar_feedback_settings` 广播；
- **所有**页面提示统一走 `feedbackEnabled` 检查：处理中、成功、待确认、待同步、失败、列表汇总、主动采集直接提示；
- 关闭时立即移除当前 Toast 并清掉计时器；重新打开 popup 显示真实状态；
- 关闭提示不影响采集、上传、队列与 popup 状态。

验证：

- `关闭开关在重新打开 popup 后应保持关闭` —— PASS；
- `关闭提示时，主动离线采集也不得显示 Toast` —— PASS；
- 截图：`docs/acceptance/toast-disabled-offline.png`（无 Toast，popup 状态仍为等待上传）。

## 3. [P2] 自然浏览断网无反馈 —— 已修

- `runFlush()` 上传异常分支现在把失败/待同步结果交给同一个 `deliverFeedback()`；
- 可重试（断网、超时、5xx）→ `queued`：「当前岗位待同步，连接恢复后自动重试」；
- 认证失败/撤销/不可重试 → `failed`：「尚未保存，请打开插件查看原因」；
- 同一页面同一岗位的 queued/failed 60 秒内只提示一次，连续重试不刷屏；
- 恢复后以真实回执替换（成功/复核/不变）。

验证：

- `自然浏览断网应给出待同步提示` —— PASS；
- 截图：`docs/acceptance/toast-automatic-offline.png`。

## 4. [P2] 批量按事件计数 —— 已修

- 汇总前按 `application_id` 去重；没有 ID 时按站点作用域的岗位身份去重；再退化为复核 ID；
- 分类统计：`saved`（created/updated/saved）、`review`、`queued`、`failed`，不再把失败都算作待同步；
- `unchanged`（仅浏览时间变化）不计入“已保存”；
- 自动浏览无变化静默；主动采集无变化显示「该岗位已在台账中」；
- 同一岗位的重复事件、列表与详情事件都只算一个岗位。

验证：

- `同一岗位两次待同步，恢复后汇总不能算作两个岗位` —— PASS；
- 截图：`docs/acceptance/toast-batch-same-job.png`。

未实测：多岗位混合成功/复核/待同步/失败的真实汇总数字（分类逻辑已实现，测试只覆盖同岗位与列表）。

## 5. [P1] “已保存”兜底未核对入账 —— 已修

`feedbackStatus()` 现在必须同时满足：

```
accepted === true
processing_state === 'applied'
application_id 存在
```

才归为成功；`ignored / cancelled / accepted 但无 ID / 未知回执 / error` 都不会走成功兜底，分别落到 `review / queued / failed / unknown`。
`unknown` 文案是「尚未确认保存，请打开插件查看状态」。
popup 的 `event_result` 也改用同一个 `feedbackStatus()` 解释，两处不再给出不同结论。

验证：

- `回执无 application_id 且 ignored 时不能判保存成功（契约检查）` —— PASS；
- 真实后端链路没有制造该组合，仅证明函数契约（与验收报告口径一致）。

## 6. [P1] SW 休眠恢复后反馈关联丢失 —— 已修并实测

- 映射从内存 `Map` 改为 **`chrome.storage.session` 持久化**（防抖写入，30 分钟 TTL，>200 条淘汰）；
- SW 启动/首次使用时从 session storage 恢复；
- **待同步/重试中的事件保留映射**，最终结果才删除（上一版失败路径会提前删掉，已修）；
- 解绑、清空队列时清除映射；
- 恢复后仍校验页面身份，不会把回执发给复用 tab ID 的其他页面。

验证（真实停止/重启，不是“只重开 popup”）：

1. 断网采集一个未访问过的岗位（1004）→ 映射写入 session storage；
2. 通过 CDP `Target.closeTarget` 真实关闭扩展 service worker；
3. 唤醒后确认 1004 的映射已恢复；
4. 恢复网络、flush → 页面出现「当前岗位已计入『看过没投』」。

测试项 `SW 重启后排队事件的反馈仍能回到原页面` —— PASS；截图 `docs/acceptance/toast-sw-restart.png`。

## 7. 顺带修复的回归

新增 Toast 宿主（`[data-tounar-toast]`）会触发页面 MutationObserver，导致 `detectAndTrackRoute()` 在 800ms 内返回 null，
使 **form_started 检测失效**（`npm run test:e2e` 曾从 67/67 掉到 9/10）。已把 Toast 宿主排除在 DOM 变更判定之外，
`test:e2e` 恢复 67/67。

## 8. 测试结果

| 命令 | 结果 |
|---|---|
| `npm run test:toast`（新增） | **13/13** |
| `npm test` | **101/101** |
| `npm run test:e2e` | **67/67** |
| `npm run test:web` | **52/52** |
| `npm run test:plugin-acceptance` | **失败 0** |

## 9. 仍未验证（不当作通过）

- 原生首次权限允许/拒绝/撤销；
- 真实招聘站点上的 Toast 遮挡、分享码后台地址深链；
- 同 URL 抽屉真实 A→B（只有身份判定逻辑与契约检查）；
- 多标签并行、A→B→A、页面刷新/关闭与旧任务竞争；
- 多岗位混合状态汇总的真实数字；
- 真实后端产生「accepted 但无 ID」的链路（只有契约检查）；
- B 部分识别准确度不在本轮范围。
