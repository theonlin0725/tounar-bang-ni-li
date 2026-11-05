# 自身页面误采集复盘的根因与实际验证（2026-11-01）

## 实际浏览器插件

- Chrome 扩展 ID：`kljgjklbcecdagpifhhahdegngfndgln`
- 加载方式：unpacked，路径 `/Users/mingenlin/Desktop/opencode project/帮你理/extension`
- manifest 版本：`0.2.1`
- Chrome Secure Preferences 的 `last_update_time`：2026-10-26；扩展目录中的 `content/tracker.js`/`service-worker.js` 在 2026-10-31 15:55 更新。
- 这解释了一个关键事实：**扩展代码文件更新后，已经打开的 4311 标签页仍可能运行旧 content script**；旧页面中的采集逻辑不会因为服务端/磁盘文件变更自动替换。4311 页面当时一直开着，历史截图和旧待确认来自更新前/旧标签页，而不是当前代码持续新增。

## 实际验证（不是只看代码）

1. 新开真实 Chrome 标签 `http://127.0.0.1:4311/`，依次打开首页、`/?panel=reviews`、`/?panel=career`、`/?panel=settings`、返回首页；期间刷新/切换。数据库事件数保持 137，未新增事件、岗位或待确认。
2. 新开真实拼多多岗位页（`careers.pddglobalhr.com`），产生真实 `job_viewed`，其 `payload.page_url` 存在，说明当前 content script 已加载修复后的页面 URL 字段；事件正常入账，未被自身页面规则误伤。
3. 历史 18 条 open 自身页面复核已全部关闭；处理后 open 自身页面复核 = 0。
4. 服务端仍保留兜底：`page_url`/`job_url`/`status_url` 指向本项目、loopback 根路径/panel/自测页/API/静态资源时返回 `SELF_APP_EVENT`；没有有效岗位内容的浏览/表单事件直接 ignored。
5. 旧队列在隔离 e2e 中验证：1 条旧自身页面事件入队后被逐条清除，不上传；`SELF-PAGE-GUARD 6/6`。

## 错误链接

- 历史记录 `app_ac_3R0cQdSbhpk5o` 的 `job_url` 曾为 `http://127.0.0.1:4311/`。已归档并把 `job_url/canonical_job_url` 清空；原 URL 仍在事件证据/审计中，不删除历史。
- 报表页/表格“查看岗位”只读取真实 `job_url`；没有安全岗位链接时显示空状态，不把前端地址兜底成岗位链接。
- 清理后查询：台账中 `127.0.0.1/localhost` 的 job_url = 0，open 自身页面复核 = 0。

## 为什么之前“看起来没修好”

此前修复主要在代码/服务端，但用户实际打开的 4311 标签页在代码更新前已加载旧 content script；旧页面的 DOM/路由继续走旧采集路径。服务端旧兜底又只检查部分 URL 字段，导致旧标签页的“系统判断/批次待补充”事件仍可能进入待确认。现在同时做了：

- 新注入 content script 的页面 URL 兜底；
- 服务端 page_url + loopback app 路由兜底；
- 无有效岗位内容/表单无进展的自动 ignored；
- 历史自身页面复核/错误链接的定向清理；
- 浏览器实际验证“新开/刷新/切换不新增”。

## 边界

- 不删除 40 条历史自身事件；它们保留为审计记录，部分已 ignored。
- 旧标签页若仍保留更新前的 content script，最稳妥是刷新一次页面；当前服务端兜底不会让它污染台账。
- 未强制重启用户 Chrome 或扩展；浏览器实际验证使用新开标签/刷新，未改变用户其他标签页。
