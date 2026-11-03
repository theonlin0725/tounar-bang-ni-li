# 插件 A 复验：574940b

验收日期：2026-10-27。验收基线：`main @ 574940b`，开始验收时工作区干净。

**结论：有实际修复，但不能按“六组问题全部修完 / A 完整通过”验收。** 原有 `test:toast` 确实 13/13 通过；独立补验 6 个浏览器场景，1 个通过、5 个失败。另有 3 个源码契约检查失败，单独记录，不冒充真实后端行为。

本轮只验收 A。没有修改产品代码、修复 B、运行真实招聘站点采集或操作用户业务数据库。新增内容仅为本报告和 `.tmp` 下的验收脚本、测试数据、截图及 trace。

## 一、执行与证据范围

| 检查 | 本次实际结果 | 证据性质 |
| --- | --- | --- |
| `npm run test:toast` | 13/13 通过 | 11 个浏览器检查 + 2 个源码契约检查 |
| 独立补验脚本 | 1/6 通过，5 个失败 | 真实扩展脚本、隔离真实后端、本地测试页面、代理控制断网和延迟 |
| 额外源码契约检查 | 0/3 通过 | 从当前产品源码提取原函数；合成回执，不代表真实后端已产生这种组合 |

浏览器：Chrome for Testing 156.0.8078.4。测试扩展预授权 localhost，删除测试构建中的静态 content_scripts，由产品实际动态注入链路加载。未测试原生权限弹窗。两个浏览器运行使用各自的隔离 profile 和数据库，测试结束后已关闭。

本轮没有重新运行 `npm test`、`test:e2e`、`test:web` 或 `test:plugin-acceptance`；对方报告中的这些数字不能当成本轮独立复验结果。

## 二、实际页面中仍存在的问题

### 1. P1：不同页面的排队任务仍被混成一个批次，既会丢提示，也会串页计数

复现一：在同一标签页断网采集岗位 5101，再进入岗位 5102 采集，停留在 5102 恢复同步。真实后端分别建好了两条记录，队列清空，但 **5102 没有成功提示**，session 中的反馈映射也已经清空。

复现二：断网先后采集岗位 5111、5112，返回 5111 后恢复同步。当前是只有岗位 5111 的详情页，却显示 **“本页 2 个岗位已保存”**；其中一条来自此前访问的 5112 页面。

代码原因：

- [service-worker.js:103](</Users/mingenlin/Desktop/opencode project/帮你理/extension/background/service-worker.js:103>) 只按 `tabId:frameId` 分组，bucket 的 URL 和上下文取第一条事件。
- [service-worker.js:108](</Users/mingenlin/Desktop/opencode project/帮你理/extension/background/service-worker.js:108>) 在确认能否正确投递前就删除最终结果映射。
- [service-worker.js:116](</Users/mingenlin/Desktop/opencode project/帮你理/extension/background/service-worker.js:116>) 用第一条 URL 判断整个 bucket：停在第二页会整组丢弃；返回第一页会整组合并显示。
- [tracker.js:976](</Users/mingenlin/Desktop/opencode project/帮你理/extension/content/tracker.js:976>) 只要 `status === 'batch'` 就绕过岗位身份检查，因此详情页也能收到跨页面的“本页”汇总。

应按有效来源页面/任务拆分后，再在正确的列表上下文中汇总；不能先混合不同页面，再以第一条 URL 决定整组去留。

### 2. P1：已经显示的成功 Toast 不随岗位切换撤下

在岗位 5010 成功采集，Toast 已显示；立即通过 SPA 切换到岗位 5002。切换后 400ms，页面标题、URL、岗位编号均为 5002，右下角仍显示 5010 的 **“当前岗位已计入「看过没投」”**。

这与已有的“延迟 A 回执到 B 后拒绝显示”是两个不同场景。新代码只检查消息到达时的身份，没有让已经显示的 Toast 随页面身份失效。

入口：[tracker.js:630](</Users/mingenlin/Desktop/opencode project/帮你理/extension/content/tracker.js:630>) 的 `resetJob()` 和后续路由检测没有撤下旧提示；[tracker.js:983](</Users/mingenlin/Desktop/opencode project/帮你理/extension/content/tracker.js:983>) 的身份检查只在显示时执行。

### 3. P2：A→B→A 仍会接受上一轮 A 的旧回执

暂扣岗位 5301 的真实成功回执；切换到 5002，再返回 5301；释放旧回执后仍显示成功 Toast。

这证明当前关联只能核对 URL/岗位，不能区分同一岗位的两轮页面任务。入队元数据没有 documentId 或页面任务版本，见 [service-worker.js:386](</Users/mingenlin/Desktop/opencode project/帮你理/extension/background/service-worker.js:386>)。

证据边界：本用例证明旧回执未失效，**没有制造新一轮失败被旧成功覆盖的完整竞争过程**。按原修复任务书要求，任务代次防护仍未完成。

### 4. P2：带分享码的“查看台账”链接仍拼错

通过 popup 将后台设置为 `http://127.0.0.1:<测试端口>/?sharecode=audit-token`。采集能成功，但点击 Toast 的“查看台账”，实际打开：

```text
http://127.0.0.1:<测试端口>/?sharecode=audit-token/?app=<实际记录ID>
```

解析结果：`app` 参数不存在，`sharecode` 被污染成 `audit-token/?app=...`。所以无法按 app 参数定位记录，依赖分享码的网关也会收到错误分享码。本次未接真实分享网关，不声称已实际测到网关拒绝。

入口：[tracker.js:992](</Users/mingenlin/Desktop/opencode project/帮你理/extension/content/tracker.js:992>) 仍用字符串追加 `/?app=` 或 `/?panel=`，没有用 URL 参数合并。

## 三、另外三项源码契约缺口

以下使用当前产品原函数和合成输入，只证明代码防线/规则存在缺口。未让真实后端产生这些特定回执组合。

1. **同一个岗位，一条成功、一条待同步，会再次算成两个岗位。** 两条来源 identity 相同；成功项按 `app:<id>` 分组，待同步项按 `job:<identity>` 分组，结果是“本页 1 个岗位已保存，1 个待同步”，`total=2`。见 [service-worker.js:121](</Users/mingenlin/Desktop/opencode project/帮你理/extension/background/service-worker.js:121>)。原有“两个成功回执对应同一 application_id”的测试没有覆盖此问题。
2. **自动列表全部 unchanged 仍弹提示。** 两个不同岗位的回执均 `unchanged`，产生 batch，文案为“本页 没有新的岗位”，未遵守自动浏览无变化静默。见 [service-worker.js:131](</Users/mingenlin/Desktop/opencode project/帮你理/extension/background/service-worker.js:131>)、[tracker.js:950](</Users/mingenlin/Desktop/opencode project/帮你理/extension/content/tracker.js:950>)。
3. **popup 没有完全共用成功判定。** 合成 `accepted=false, processing_state=applied, application_id=app1`：SW 的 `feedbackStatus()` 返回 `unknown`，但 popup 的 `refresh()` 显示“已自动入账”。[popup.js:76](</Users/mingenlin/Desktop/opencode project/帮你理/extension/popup/popup.js:76>) 仍自行判断，未检查 accepted。`event_result` 共用函数不等于整个 popup 都共用。

## 四、哪些修复可以确认有效

- 已有 query 换岗延迟回执检查通过；新增的**同 URL 抽屉单条延迟回执 A→B** 也通过，B 页面没有显示 A 的成功提示。抽屉是本地可控样本，不能替代真实站点结论。
- 关闭开关并重开 popup 状态保持关闭；关闭状态下主动断网采集不弹 Toast。
- popup 关闭后的自然浏览断网能显示待同步。
- 同岗位多个成功回执不再简单按事件数报告多个岗位。
- SW 在 CDP 实际停止并重启后，同页排队事件能恢复反馈，显示真实后端成功回执。这项已有实测支持，不是只核对 session storage 存在。
- 成功入账、普通后台深链、自然浏览成功提示、约 4 秒消失、窄屏及关闭按钮等既有断言通过。
- SW 的 ignored/无 ID 契约检查通过；该结论不覆盖 popup 自行解释状态的路径。

“开关所有路径、错误分类所有分支”等未逐一覆盖的范围，不能由上述通过项推导为全覆盖。

## 五、原有测试为什么 13/13 仍漏问题

- “列表汇总应按实际岗位数显示”的断言只检查包含“本页”，没有断言实际数字与岗位集合。
- 同岗位恢复同步检查只排除“本页 2 个以上岗位已保存”，空字符串也能通过；没有证明当前页一定收到准确反馈。
- 延迟回执用例只覆盖 A→B，未覆盖已经显示的 Toast、返回 A、跨页面队列一起 flush。
- 成功门槛契约只测 SW 分类函数，没有覆盖 popup 的 `refresh()`。
- 普通后台深链通过不能推出带 sharecode 的 URL 也正确。

因此原测试结果真实，但其覆盖范围不足以证明六组问题全部关闭。

## 六、可重复执行与原始证据

执行命令（工程根目录）：

```bash
npm run test:toast
node .tmp/toast-reacceptance-extra-20261027.mjs
node .tmp/toast-contract-reacceptance-20261027.mjs
```

额外浏览器脚本存在失败断言时返回非零；契约脚本将逐项结果写入 JSON，以 JSON 的 `passed/failed` 为准。

- [原测试本次结果](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/toast-feedback-lJIl6b/report.json>) / [原测试 trace](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/toast-feedback-lJIl6b/trace.zip>)。
- [独立浏览器补验脚本](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/toast-reacceptance-extra-20261027.mjs>) / [结果 JSON](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/toast-reacceptance-extra-2l3JCY/report.json>) / [trace](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/toast-reacceptance-extra-2l3JCY/trace.zip>)。
- [换岗后旧 Toast 截图](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/toast-reacceptance-extra-2l3JCY/already-visible-stale.png>)。
- [详情页误报本页两个岗位截图](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/toast-reacceptance-extra-2l3JCY/multi-page-flush-on-a.png>)。
- [契约补验脚本](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/toast-contract-reacceptance-20261027.mjs>) / [契约结果 JSON](</Users/mingenlin/Desktop/opencode project/帮你理/.tmp/toast-contract-reacceptance-20261027.json>)。

`.tmp` 是本地临时验收目录，清理后证据会消失；本报告保留了主要步骤、观察和源码入口。

仍未验：真实站点提示遮挡、原生权限允许/拒绝/撤销、多标签并发、刷新/关闭完整竞争过程、真实后端异常回执组合、完整混合结果矩阵。B 部分识别准确度不在本轮结论内。
