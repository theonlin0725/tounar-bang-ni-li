# 插件修复与验收记录（2026-10-26）

> 后续修正：0.2.0 的预授权测试未覆盖用户报告的后台 CORS 失败。0.2.1 已通过“原版 manifest、无任何主机预授权”的针对性真实浏览器回归并更新本机服务。旧版的 9 站结果仍只代表当时声明的预授权条件，不能用来证明原版连接流程。详情见自测教程的 0.2.1 章节。

生成时间：2026-10-26T01:28:47.088Z

必选站 9/10 通过。真实浏览器扩展采用 manifest 预授权；不代表原生首次授权已通过。

| 站点 | 状态 | 准确列表记录 | 准确详情 | 有值字段正确/检查数 |
|---|---|---:|---:|---:|
| 腾讯 | passed | 10/10 | 3/3 | 55 / 55 |
| 网易 | passed | 10/10 | 3/3 | 55 / 55 |
| 小米 | passed | 10/10 | 3/3 | 55 / 55 |
| OPPO | passed | 10/10 | 3/3 | 55 / 55 |
| 拼多多 | passed | 10/10 | 3/3 | 68 / 68 |
| 米哈游 | passed | 10/10 | 3/3 | 55 / 55 |
| 美团 | passed | 10/10 | 3/3 | 58 / 58 |
| 快手 | passed | 10/10 | 3/3 | 55 / 55 |
| 实习僧 | passed | 15/15 | 3/3 | 75 / 75 |
| BOSS | blocked | —/— | 0/3 | — |
| Yext / Greenhouse（通用） | passed | 0/0 | 1/1 | 5 / 5 |
| Talan / SmartRecruiters（通用） | passed | 0/0 | 1/1 | 5 / 5 |

原页未提供的空字段 108 个，不计入有值字段准确率。详情需字段正确、生成正确 application_id、前端自动可见且不重复才计成功。JD 按独立真值逐字比对，区块间统一一个空行。

未完成：

- BOSS 正常登录列表及 3 个详情
- Chrome 原生首次权限允许/拒绝/撤销
- 全链路 P50/P95 与分阶段性能采样
- 后端 4xx/5xx、验证码/聊天/空列表等尚未单独覆盖的异常矩阵

每条 expected/actual、字段来源、模板版本、事件 ID、回执、前端截图和 trace 位于对应站点 report.json 及其目录。采样名单在 tests/fixtures/live 固定；测试不会自动改 expected。网页内容变化必须重新独立采样并保留旧版本。

## 本轮修复

- 首次站点授权的后续注入和采集由后台接续；popup 关闭不应中断后续正常浏览采集。原生权限弹窗仍单独待验。
- 上传状态区分识别、本地入队、待上传、待确认、服务端拒绝和已入账。队列恢复自动补传，处理事务回滚可重试。
- 新增列表发现事件，记录列表来源和 JD 待补充；详情补全原记录，不伪造列表浏览时长，不覆盖完整 JD 或人工修正。
- 同站岗位 ID 与域名共同参与身份判断，同名不同 ID 不误合并；记录保持 pending / has_applied=0。
- JD 覆盖职责和要求，保留段落；允许 100000 字，超限显式标记，不再静默裁成 20000 字。
- 旧模板必须在不同岗位核对成功才升级，结构变化降级并产生新版本；单字段命中不冒充整模板成功。
- 台账检查更新间隔改为 2 秒，详情显示全文和来源。
- 补齐当前腾讯、小米、OPPO、网易、美团、拼多多、米哈游、快手、实习僧列表及详情；通用识别补充 schema.org microdata 和明确的雇主声明。

## 数据与证据口径

这次测试的是本地未提交工作区，扩展 0.2.0；11 个联网测试报告的产品源码指纹相同：`879507d59ad75cf4841158448af296ad5b288d2429e8a636ba645e76258ac649`。浏览器版本、代码 HEAD、dirty 标记、隔离目录和采样时间在各 JSON 中。

必选站：9 个列表 / 95 张已加载卡片 / 27 个不同详情；准确入账分别为 95/95、27/27。BOSS 的 1 列表和 3 详情不计入“已测试”，固定要求仍为 10 站、30 个详情，不能把 27/27 写成全部需求达标。

额外通用样本：Yext/Greenhouse、Talan/SmartRecruiters，各 1 个当前详情，2/2 通过。合计已测详情 29/29。有值字段正确 541/541，原页未提供 108 项，不纳入有值字段准确率；未观察到错误值或漏采。这里的字段包括公司、标题、城市、批次、URL 和 JD，ID 另由事件匹配与同记录补全断言核对。仅代表冻结样本，不外推所有岗位或网站。

快手实际使用的是当前详情路由，不把它计作真实抽屉；同 URL 抽屉 A→B 在稳定 fixture 覆盖。列表仅采当前已加载卡片，不宣称全站或所有筛选/分页覆盖。JD 对照独立原文保存，章节间统一一个空行，未以字数阈值代替完整性。

每站证据：

- 腾讯：[JSON 明细](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-live/report.json>)；[trace](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-live/trace.zip>)。截图路径见每条 evidence_path。
- 网易：[JSON 明细](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-netease/report.json>)；[trace](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-netease/trace.zip>)。截图路径见每条 evidence_path。
- 小米：[JSON 明细](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-xiaomi/report.json>)；[trace](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-xiaomi/trace.zip>)。截图路径见每条 evidence_path。
- OPPO：[JSON 明细](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-oppo/report.json>)；[trace](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-oppo/trace.zip>)。截图路径见每条 evidence_path。
- 拼多多：[JSON 明细](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-pinduoduo/report.json>)；[trace](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-pinduoduo/trace.zip>)。截图路径见每条 evidence_path。
- 米哈游：[JSON 明细](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-mihoyo/report.json>)；[trace](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-mihoyo/trace.zip>)。截图路径见每条 evidence_path。
- 美团：[JSON 明细](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-meituan/report.json>)；[trace](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-meituan/trace.zip>)。截图路径见每条 evidence_path。
- 快手：[JSON 明细](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-kuaishou/report.json>)；[trace](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-kuaishou/trace.zip>)。截图路径见每条 evidence_path。
- 实习僧：[JSON 明细](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-shixiseng/report.json>)；[trace](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-shixiseng/trace.zip>)。截图路径见每条 evidence_path。
- Yext / Greenhouse（通用）：[JSON 明细](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-greenhouse/report.json>)；[trace](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-greenhouse/trace.zip>)。截图路径见每条 evidence_path。
- Talan / SmartRecruiters（通用）：[JSON 明细](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-smartrecruiters/report.json>)；[trace](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/plugin-acceptance-smartrecruiters/trace.zip>)。截图路径见每条 evidence_path。

## 本机状态与未完成项

已把 4311 本机验收服务切换到修复后的后端代码，继续使用 `/Users/mingenlin/tounar-acceptance/20261025-060103`，升级前保存 SQLite 一致性备份。未替换原业务数据库，保留现有账号、配对和台账。Chrome 中已加载的旧扩展需要点击重新加载，确认 0.2.0；网页首次刷新后加载新前端。

BOSS 使用用户指定 BrowserSkill 实例 142b306a 尝试：新标签返回空白 DOM；现有登录标签借用确认超时。依照工具约束停止，没有绕过确认、换实例或将未登录公开页当作登录态成功。会话已结束。

完整验收未完成：原生首次权限允许/拒绝/撤销、BOSS 登录态、全链路性能 P50/P95、未单独覆盖的 4xx/5xx 与部分错误页面矩阵。默认联网测试的 manifest 预授权不能证明这些环节。

使用教程与所有命令见 [PLUGIN-SELF-TEST.md](./PLUGIN-SELF-TEST.md)。

## 最终回归结果

- `npm test`：95/95 通过。
- `npm run test:e2e`：67/67 通过（包含历史快照与业务回归，不等同于 67 个真实站点）。
- `npm run test:web`：52/52 通过。
- `npm run test:plugin-acceptance`：18/18 稳定场景通过。
- `npm run test:plugin-acceptance -- --all-sites`：9 个必选站、2 个额外通用站通过；完整验收因已列未完成项仍非零退出。
- `git diff --check` 和修改后扩展脚本语法检查通过。

旧米哈游快照原本把 location 空值写为期望，但同一条用例的独立 truth 已记录“上海”。修复城市漏采后只将期望对齐该既有真值；原 HTML 与原 truth 均未改写。

0.2.1 补充验证：`test:plugin-backend` 4/4、`npm test` 96/96、真实扩展稳定场景 18/18 通过；当前 4311 的 OPTIONS 响应已现场核验包含 X-Device-Token。旧站点提取规则本次未改动。
