# 插件自测与本机更新（2026-10-26）

扩展版本：0.2.1。本教程操作的是 Chrome 中的“帮你理”扩展。当前实现包括列表发现、详情自动补全、JD 全文、真实入账回执和前端自动更新。实际覆盖及未完成项以 `PLUGIN-ACCEPTANCE-20261026.md` 和生成的 JSON 为准。

## 本机先使用修复版

当前服务为 <http://127.0.0.1:4311>，使用原验收副本 `/Users/mingenlin/tounar-acceptance/20261025-060103`。2026-10-26 已先备份数据库，再原地重启加载新后端，保留原台账、账号和插件配对。原业务库未替换。

1. 在 Chrome 的 `chrome://extensions` 找到“帮你理”，点击**重新加载**，确认版本 **0.2.1**。打开插件点“检测本机服务”，如 Chrome 询问访问本机地址权限，请允许。开发目录为 `/Users/mingenlin/Desktop/opencode project/帮你理/extension`。保持原扩展 ID；不要移除再安装，以免丢失配对和权限。
2. 打开 4311 台账，刷新一次加载本轮网页代码，进入“看过没投”。之后正常采集不需要刷新台账。
3. 在新标签打开用户提供的[腾讯列表](https://careers.tencent.com/search.html?pcid=40003)。首次授权站点后采集当前已加载岗位；列表记录显示“列表发现 / JD 待补充”。
4. 打开其中详情，正常可见停留至少 3 秒：完整职责及要求补到原记录，仍为未投递；重复浏览不重复新建。扩展重新加载前已打开的招聘标签可能需要重新打开一次，后续授权与浏览无需反复刷新。

如果这台 Chrome 尚未配对，在插件填写 `http://127.0.0.1:4311`，点击“保存并授权连接”并允许 Chrome 权限，开始配对，再到台账“设置 → 数据与授权 → 插件绑定”批准配对码。本机 outbox 模式不会发真邮件，登录验证码可读：

```bash
node --env-file=/Users/mingenlin/tounar-acceptance/20261025-060103/acceptance.env server/scripts/latest-otp.js
```

`npm run local:acceptance` 会创建**新的**数据库副本；不应把它当成保留现有数据的升级命令。

## 统一自动验收

在项目目录运行：

```bash
npm run test:plugin-acceptance                  # 稳定 fixture；真实扩展、隔离用户/数据库/前端
npm run test:plugin-acceptance -- --real-sites  # 腾讯：用户链接，1 列表 + 3 详情
npm run test:plugin-acceptance -- --site=oppo   # 单站当前真实页面
npm run test:plugin-acceptance -- --all-sites   # 9 个可访问必选站 + 2 通用布局，生成汇总
npm run test:plugin-acceptance -- --summary-only # 只汇总已有报告；不重新测试
npm run test:plugin-acceptance -- --production # 原版 manifest，有界面；需真实 Chrome 权限确认
```

`--site` 当前支持 `tencent`（推荐用 `--real-sites`）、`netease`、`xiaomi`、`oppo`、`pinduoduo`、`mihoyo`、`meituan`、`kuaishou`、`shixiseng`、`greenhouse`、`smartrecruiters`。

默认及联网模式只在测试构建中预授予 manifest 主机权限，**没有预注入静态内容脚本**。仍经过真实扩展 UI、动态脚本注册、真实队列/接口、业务记录和前端；不使用伪造事件、mock runtime/storage 或直接调用提取器代替主流程。但它们**不验证 Chrome 原生可选权限弹窗**。原版权限模式单独记录，未成功就失败退出。

单站任一检查失败，退出码非零。完整联网汇总目前因 BOSS 登录态、原生权限和性能项未完成，退出码保持非零，即使可访问站点都通过也不宣称完整验收成功。汇总会列出站点失败与阻塞。

生成文件：

- 稳定：`.tmp/plugin-acceptance/report.json`、`report.md`、截图、`trace.zip`；重启前另有 `trace-before-restart.zip`。
- 腾讯：`.tmp/plugin-acceptance-live/`；其他站：`.tmp/plugin-acceptance-<site>/`。
- 汇总：`.tmp/plugin-acceptance-suite/report.json`、`report.md`。
- 独立真值：`tests/fixtures/live/`，包括采样时间、原文证据和字段。网易、美团保留旧版并增加 20261026 采样；测试不会自动修改 expected。

每条明细串联 `client_event_id → processing_state → application_id → frontend_visible`，保留字段来源、模板版本、重复数和诊断耗时。空白批次按“原页未提供”分类，不计为成功提取。逐条截图会拖长后续行的计时，因此这些耗时不是 P50/P95 证据。

## 稳定回归范围

18 项包括：UI 配对、显式采集、关闭 popup 后继续浏览、同名不同 ID、多个 JD 区块、超过 20000 字正文、SPA 延迟替换、同 URL 侧栏切换、列表不覆盖完整 JD、待确认不误报、首页/登录/过期页、重复访问、旧模板跨岗位核对、浏览器重启、模板失效重学、后端断连后自动补传、暂停恢复、删除模板与清队列分别生效。

后端回归另验证人工字段保护、列表与详情合并、ID 隔离、长 JD 和状态语义。

```bash
npm test
npm run test:e2e
npm run test:web
```

旧快照和 mock 提取器回归仅用于防退化，不替代真实网站、真实扩展验收。

## 状态与限制

- “待上传”表示仅入本地队列；“待确认”表示关键字段不可靠；只有返回业务记录并完成处理才显示“已入账”。
- 列表无完整 JD 是正常的“待补充”，不伪造浏览时长；打开详情后补全。
- 超过 100000 字的正文显式标为超长，不静默截断后声称完整。
- 快手当前 PC 社招页面真实点击进入 `#/official/social/job-info/<id>`，本轮按当前路由验收；侧栏切换由独立稳定场景覆盖，不能把快手说成已验抽屉。
- 快手列表只读取可见卡片绑定的 `id/name` 并与卡片标题核对，不复制完整组件状态，不重放带签名接口。
- BOSS 必须使用用户正常登录且可见的页面。本轮指定 BrowserSkill 实例的新标签返回空白，借用现有标签确认超时，已停止并结束会话；未以公开未登录页或历史快照替代验收。
- Chrome 原生首次允许/拒绝/撤销、尚缺的异常矩阵、完整分阶段 P50/P95 仍未完成。

## 最短自测记录

测试时可按下表逐项核对，不需要反复点“采集当前页”：

| 操作 | 通过表现 |
|---|---|
| 新标签打开腾讯列表，授权本站 | 当前列表岗位进入“看过没投”，来源为列表发现，JD 待补充 |
| 从列表点开一个岗位并可见停留至少 3 秒 | 原记录出现完整职责和要求，不增加第二条 |
| 关掉插件弹窗，打开另一个岗位 | 自动出现或补全，无需重新授权 |
| 回到第一个岗位、刷新一次 | 原岗位仍只有一条，保持未投递 |
| 到台账查看统计 | 浏览岗位没有被误计为已投递 |

若没有通过，请保留岗位 URL 和插件弹窗的具体状态文字（例如等待上传、待确认、服务端拒绝），并指出卡在表中哪一步。这比只看到队列数量归零更容易定位。

## 0.2.1：后台正在运行却报“连不上”的修复

2026-10-26 用户实测发现：健康检查正常，但上传显示无法连接。已用原版 manifest、没有任何预授予主机权限的真实 Chrome 复现。原因是后台 CORS 预检未包含插件携带的 X-Device-Token，请求在浏览器中被拦截；原先测试构建的主机预授权掩盖了该问题。

已补齐该请求头，保存后台地址、检测本机服务和开始配对会申请目标后台访问权限；网络错误不再臆断“没有服务监听”。已绑定设备的成功状态检查会清除旧连接错误。当前 4311 服务已原地更新，保留数据。

若仍看到旧报错：Chrome 扩展管理页重新加载帮你理到 0.2.1 → 检测本机服务并允许权限 → 检查状态 / 立即同步。无需重新配对，也不要清空待上传队列。

新增真实浏览器针对性回归：

```bash
npm run test:plugin-backend
```

它使用生产 manifest、无主机预授权，验证健康检查、有效设备请求、无效设备真实 401，以及未授权时的可操作提示。此测试不冒充原生授权弹窗允许/拒绝测试。报告在 `.tmp/backend-access/report.json`。
