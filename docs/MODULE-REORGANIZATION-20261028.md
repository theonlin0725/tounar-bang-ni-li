# 模块化整理记录（2026-10-28）

> 2026-10-30 后续：邮件管理改动新增 11 项后端测试和 `npm run test:mail-admin`；当前后端回归为 **150/150**（15 suites），网页 E2E 仍为 57/57。本文第 8 节的 101/101 是 10-28 当时的结果；恢复与最新验证见[插件绑定恢复](PLUGIN-BINDING-RECOVERY-20261030.md)。

## 0. 结论

在不拆分进程、不新增数据库/构建、不改变现有启动方式和 URL 的前提下，把服务端中职责明确的采集与推送实现移入 `server/src/modules/`，并保留 `web/`、`extension/` 原位：

- **数据抓取插件层**：`server/src/modules/data-capture/` + 根目录 `extension/`
- **邮件推送模块**：`server/src/modules/mail-push/`
- **前端展示模块**：`web/`

公共基础设施、共享业务规则、路由装配、调度和测试夹具没有强行塞进任一模块，保留原因见第 5 节。旧导入路径保留为两行转导出入口，现有命令、路由、数据库 schema、Chrome 已加载扩展路径均不变。

本轮没有创建 Git 提交；改动留在工作区，便于审阅后再决定是否提交。

## 1. 整理前

服务端业务文件平铺在 `server/src/`：

```text
server/src/
├── plugin.js                插件配对/设备/事件接收（约 363 行）
├── mailer.js                OTP/提醒邮件发送
├── domain/
│   ├── mail.js              QQ 连接生命周期
│   ├── mailSync.js          IMAP 收信与事件转换
│   ├── mailParser.js        招聘邮件解析纯函数
│   ├── reminders.js         提醒候选、批次、链接与两步确认
│   ├── applications.js      共享建档/状态/字段规则
│   ├── mailMatching.js      共享匹配规则
│   ├── ledger.js            台账读取模型
│   ├── reviews.js           复核/纠错/归档
│   └── deletion.js          删除状态机
├── cloud/llm.js             云端邮件兜底 + 预留页面提取
├── routes/index.js          API 装配
├── jobs/scheduler.js        收信/提醒/归档/删除调度
└── config.js / db.js / http.js / auth.js / util.js / idempotency.js
```

主要问题不是功能缺失，而是采集、推送和共享业务混在同一层：只看目录无法判断 `mail.js` 是收信还是发信，`mailer.js` 与 `reminders.js` 的关系也不直观。直接整体搬动共享文件又会造成前端/插件反向依赖错误职责。

## 2. 整理后

```text
server/src/modules/
├── data-capture/
│   ├── README.md
│   ├── plugin.js                    插件配对、设备鉴权、心跳、撤销、C1 事件批次
│   ├── mail/
│   │   ├── connections.js           QQ 连接创建/重授权/断开/同步触发
│   │   ├── sync.js                  IMAP 收信、游标、去重、正文读取、事件转换
│   │   └── parser.js                招聘邮件过滤、分类、字段与证据摘要
│   └── cloud/llm.js                 云端邮件兜底与页面提取函数
└── mail-push/
    ├── README.md
    ├── mailer.js                    SMTP/outbox、验证码与提醒邮件发送
    └── reminders.js                 候选、摘要、批次、频控、链接、两步确认

extension/                            数据抓取插件层的 Chrome MV3 客户端（原位）
web/                                  前端展示模块（原位）
```

三个模块的职责、进度、配置、运行、验证和依赖分别见：

- [数据抓取插件层](../server/src/modules/data-capture/README.md)
- [邮件推送模块](../server/src/modules/mail-push/README.md)
- [前端展示模块](../web/README.md)

## 3. 文件移动表

| 原路径 | 新路径 | 处理 |
|---|---|---|
| `server/src/plugin.js` | `server/src/modules/data-capture/plugin.js` | 移动实现；原文件改为 `export *` 兼容入口 |
| `server/src/domain/mail.js` | `server/src/modules/data-capture/mail/connections.js` | 移动实现并改名为 connections，避免与发信混淆；原文件转导出 |
| `server/src/domain/mailSync.js` | `server/src/modules/data-capture/mail/sync.js` | 移动实现；原文件转导出 |
| `server/src/domain/mailParser.js` | `server/src/modules/data-capture/mail/parser.js` | 移动实现；原文件转导出 |
| `server/src/cloud/llm.js` | `server/src/modules/data-capture/cloud/llm.js` | 移动实现；原文件转导出 |
| `server/src/mailer.js` | `server/src/modules/mail-push/mailer.js` | 移动实现；原文件转导出 |
| `server/src/domain/reminders.js` | `server/src/modules/mail-push/reminders.js` | 移动实现；原文件转导出 |

移动文件除相对导入路径外，函数、导出名和业务逻辑未改。`server/src/domain/mail.js` 的模块名改为 `connections.js`，是为了在采集模块内明确它只负责 QQ 连接生命周期；对应旧路径仍可导入。

### 3.1 导入更新

生产代码：

- `server/src/routes/index.js`：插件、QQ 连接、提醒改为新模块路径。
- `server/src/auth.js`：OTP 发信改为 `modules/mail-push/mailer.js`。
- `server/src/jobs/scheduler.js`：收信与提醒改为新模块路径。
- `server/scripts/run-mail-sync.js`、`run-reminders.js`：命令入口改为新路径，命令名不变。
- `tools/probe-llm.mjs`：云端探针改为新路径。
- `tests/e2e/plugin-acceptance.mjs`：源码指纹读取改为 `modules/data-capture/plugin.js`。

兼容验证：

- `server/test/mail.test.js` 继续从 `server/src/domain/mailParser.js` 导入。
- `server/test/phase2.test.js` 继续从 `server/src/domain/reminders.js` 动态导入。

这两处故意保留旧路径，用来覆盖转导出兼容入口；不是遗漏迁移。

### 3.2 没有改动的契约

- 数据库 schema、迁移、表名、字段：未改。
- HTTP 路由、请求/响应结构、状态码：未改。
- `.env` 变量名、默认值、端口：未改；`.env.example` 只补了已有变量的注释。
- Chrome 扩展目录、manifest、content script 路径、storage key：未改。
- `npm start` / `npm run dev` / 测试命令：未改。

## 4. 代码依据的职责边界

| 能力 | 归属 | 依据 |
|---|---|---|
| 浏览器页面识别、停留计时、表单/提交/状态证据、离线队列 | 数据抓取插件层 | `extension/content/tracker.js`、`service-worker.js`、`lib/queue.js` |
| 插件配对、设备令牌、事件批次校验与入库 | 数据抓取插件层 | `server/src/modules/data-capture/plugin.js` |
| QQ IMAP 连接、收信、招聘邮件解析 | 数据抓取插件层 | `mail/connections.js`、`mail/sync.js`、`mail/parser.js` |
| 云端 LLM 邮件兜底 | 数据抓取插件层（可选能力） | `cloud/llm.js` |
| 验证码/提醒邮件内容与发送 | 邮件推送模块 | `mail-push/mailer.js`、`mail-push/reminders.js` |
| 提醒候选、批次、频控、链接、两步确认 | 邮件推送模块 | `mail-push/reminders.js` |
| 页面、交互、错误呈现、台账/证据展示 | 前端展示模块 | `web/assets/js/**`、`web/assets/app.css` |
| 建档/字段保护/状态机、匹配、台账读取、复核、删除 | 公共业务层（不归单模块） | `server/src/domain/{applications,mailMatching,ledger,reviews,deletion}.js` |

解析后的状态归属和自动更新由公共 `domain/applications.js`、`domain/mailMatching.js` 决定：分类置信度乘以匹配把握度，并检查唯一候选、状态回退、终态保护等条件。匹配代码同时服务插件和邮件，因此没有移入邮件专属目录。

## 5. 未移动文件及原因

这些文件不是“尚未检查”，而是按现有依赖判断不适合强行归类：

| 文件/目录 | 保留位置 | 原因 |
|---|---|---|
| `server/src/config.js` | 公共 | 被采集、推送、鉴权、调度、HTTP 共同读取；根目录路径和密钥派生影响全进程 |
| `server/src/db.js`、`schema.sql` | 公共 | 单库连接、迁移、事务、修订号；表被多个流程共同使用 |
| `server/src/util.js`、`idempotency.js` | 公共 | 状态/时间/URL/加密/幂等工具，跨模块复用 |
| `server/src/http.js` | 公共 | 同时提供 API、安全头、静态资源和 `/r/` SPA 回退，不能只归前端或后端 |
| `server/src/index.js` | 装配根 | 初始化数据库/路由、监听、启停调度和退出清理 |
| `server/src/routes/index.js` | 装配根 | 一个文件聚合插件、收信、台账、提醒、删除、设置等 API；拆开需要改路由装配，不属于本次目录整理 |
| `server/src/auth.js` | 公共 | OTP 登录/会话/限流供所有 API 使用；发验证码时调用推送模块，但鉴权本身不能归推送 |
| `server/src/domain/applications.js` | 公共 | 插件、邮件、人工补录共同建档和改状态 |
| `server/src/domain/mailMatching.js` | 公共 | 名称含 mail，但同时支持插件稳定身份与邮件匹配 |
| `server/src/domain/ledger.js` | 公共 | 服务端台账查询/统计/证据投影，不是浏览器展示代码 |
| `server/src/domain/reviews.js` | 公共 | 确认、纠错、归档、撤销跨插件/邮件/人工来源 |
| `server/src/domain/deletion.js` | 公共 | 跨来源删除、设备回执、匿名化 |
| `server/src/jobs/scheduler.js` | 公共 | 同一个调度器运行收信、提醒、浏览归档、删除恢复；只搬提醒会留下跨模块反向依赖 |
| `server/scripts/*` | 运维/验收 | `local-acceptance`、部署/数据副本、历史修复等跨模块或含用户数据，保持命令入口稳定 |
| `server/test/`、`tests/e2e/` | 测试基础设施 | 共享隔离库、fixture 服务、浏览器解析和报告路径；拆分会让现有命令和证据路径失效 |
| `extension/` | 数据抓取插件层客户端 | Chrome 已加载扩展路径、manifest 相对资源和测试工具依赖此位置；内部 README 指向模块说明 |
| `tools/` | 验收工具 | 页面探测、实时采集、快照回放、云端探针继续按现有路径运行，避免破坏证据命令 |
| `demo/`、`demo.zip` | 历史原型 | 使用内存示例数据、不调用网络、不由服务端托管；保留原位以免混入真实 SPA |
| `data/`、`.env` | 本地运行数据/配置 | 含密钥、数据库、授权码或本地路径；不进 Git，不属于模块代码 |

## 6. 模块依赖方向

```text
Chrome extension (content / service worker / popup)
        │  HTTP + C1 事件 / 配对 / 心跳 / 回执
        ▼
routes/index.js ──► data-capture/plugin.js ──► domain/applications.js
        │                                      domain/deletion.js
        │
QQ IMAP ──► data-capture/mail/connections.js
              └─► mail/sync.js ──► mail/parser.js
                        └────────► domain/applications.js + mailMatching.js
        │
        ▼
SQLite (共享) ──► notification_outbox / notification_preferences
        │
        ▼
mail-push/reminders.js ──► mail-push/mailer.js ──► outbox / SMTP
        ▲
        ├── auth.js（OTP 验证码）
        └── routes/index.js（设置、预览、落地页、确认）

web/ SPA ──HTTP──► routes/index.js ──► domain/{ledger,applications,reviews,deletion}.js
                                      └─► data-capture / mail-push 的公开能力
```

依赖原则：

1. 采集和推送不直接导入前端；前端只通过 HTTP API 调用服务端。
2. 推送不导入收信实现，只消费公共业务层写入的 `notification_outbox`。
3. 公共业务层不反向依赖 `extension/` 或 `web/`。
4. 旧转导出文件只用于兼容，不承载新逻辑。

## 7. 三模块进度摘要

详细证据以各模块 README 为准。

| 模块 | 已实现 | 部分实现 | 尚未实现 |
|---|---|---|---|
| 数据抓取插件层 | 插件配对/设备、页面识别与 3 秒停留、列表/详情/表单/提交/状态事件、本地持久队列、模板学习、QQ 连接生命周期、IMAP 增量收信、规则解析、云端邮件兜底函数 | 真实站点覆盖；页面反馈若干已知缺口；真实 QQ IMAP 未用真实授权码复验；云端兜底调用条件与待确认保证不完全一致 | 页面 LLM 接入正式采集链路；QQ 以外邮箱供应商完整接入；插件市场发布；各模块独立服务部署 |
| 邮件推送模块 | OTP 邮件；outbox/SMTP 发送；进展/回看/待确认摘要；批次与频控；提醒链接；两步确认；设置预览 | 真实 SMTP 送达未验证；进程内调度/外部 cron 的持续在线与失败恢复依赖部署环境 | 退信/投递状态回调；SMTP 精确一次保证；独立消息队列工作进程 |
| 前端展示模块 | OTP 登录/重验证、统计/台账/筛选/分页、详情与 JD、手动补录、纠错/归档、待确认证据与批量操作、提醒设置/预览、插件/QQ 授权、删除进度、`/r/` 落地页、2 秒修订检查 | 真实外部服务（QQ/SMTP/招聘站/云）依赖条件；移动端/无障碍未做全量验收 | 独立前端 API 地址/跨域部署；离线业务写入/网页 Service Worker |

## 8. 本轮验证结果

环境：macOS 26.6（arm64）、Node **v26.8.1**、npm **11.19.0**、Git HEAD `574940b`。测试统一使用隔离 SQLite 与 outbox，设置 `CLOUD_LLM_ENABLED=false`；浏览器使用共享解析器优先选择 `.tmp/cft` 的 Chrome for Testing **156.0.8078.4**。

| 命令 | 结果 | 说明 |
|---|---:|---|
| `npm test` | **101/101**（14 suites，0 fail） | 后端/工具集成测试；含插件事件、QQ 连接生命周期、邮件解析、提醒、复核、删除、持久化 |
| `npm run test:e2e` | **67/67** | 真实 MV3 扩展 + 本地 fixture + 真实后端；含 26 份真实站点快照离线回归（13 站点 × 2） |
| `npm run test:web` | **52/52** | 真实本地后端 + 无构建 SPA；登录、台账、复核、提醒链接、设备、删除 |
| `npm run test:plugin-acceptance` | **18/18** | 稳定 fixture；manifest 预授权，**未测试 Chrome 原生首次授权弹窗** |
| `npm run test:toast` | **13/13** | 页面反馈/队列恢复/断网与回执时序 |
| `npm run test:plugin-backend` | **4/4** | 原版 manifest 后台连接与错误提示 |
| 直接启动烟测 | health 200 / 首页 200 | `HOST=127.0.0.1 PORT=4399 MAIL_MODE=outbox ENABLE_SCHEDULER=false`，隔离 `DATA_DIR` |
| 旧路径兼容烟测 | **7/7 可加载** | 7 个转导出入口 import 成功（导出数 9/2/7/3/6/11/3） |
| 既有 CLI 烟测 | 均 exit 0 | `npm run mail:sync`、`npm run remind` 在隔离空库执行，输出 `[]` |

报告路径：`.tmp/e2e-report.json`、`.tmp/web-e2e-report.json`、`.tmp/plugin-acceptance/report.json`、`.tmp/toast-feedback-*/report.json`。

### 8.1 验证边界

- 没有配置真实 QQ 授权码，**IMAP 真实收信未复验**；测试只证明协议代码、失败可见和本地连接生命周期。
- 没有配置真实 SMTP，**真实收件箱送达未验证**；outbox 写入成功不等于收件人收到。
- 没有调用真实 WorkBuddy 云，**云端兜底未在本轮实测**；`probe:llm` 需要已配置凭据。
- 没有重新访问实时招聘站；插件测试使用 fixture、真实站点离线快照和稳定场景，**不能外推任意招聘站、登录页或投递成功态**。
- 插件稳定场景使用 manifest 预授权，**Chrome 原生首次授权/拒绝/撤销弹窗未验收**。
- 测试全绿不等于线上部署、网关分享码、外部 cron、真实用户数据验收完成。

## 9. 保持不变与兼容性

- `npm start` / `npm run dev` 启动同一 Node 进程，同时提供 API、`web/` 静态资源和可关闭的调度器。
- `npm run otp:latest`、`npm run remind`、`npm run mail:sync` 命令名和参数不变。
- 旧导入路径 `server/src/{plugin,mailer}.js`、`server/src/domain/{mail,mailSync,mailParser,reminders}.js`、`server/src/cloud/llm.js` 仍可导入。
- Chrome 继续加载根目录 `extension/`，无需重新打包路径；manifest 版本仍为 0.2.1。
- 数据库、`.env`、`data/` 未迁移；`local:acceptance` 等脚本读取的路径不变。

## 10. 已知问题与后续

1. **真实外部条件仍是主要缺口**：真实 QQ IMAP、真实 SMTP 收件、招聘站登录/投递态、云端 LLM、外部 cron 和线上部署未在本轮验收。
2. **页面反馈仍有已知缺口**：跨页面批次混合、SPA 切换旧提示、A→B→A 旧回执、分享码深链等，见 [插件复验报告](PLUGIN-A-REACCEPTANCE-20261027.md)；现有测试通过不表示这些已修复。
3. **提醒窗口与文案不完全一致**：调度器只在配置小时/分钟起的 30 分钟窗口检查，邮件模板仍写“每日 08:00 触发，当天补发”。本轮保留行为未改。
4. **发信状态语义有限**：outbox 的 `sent` 只表示本地 JSON 已写出；SMTP 返回不证明收件箱收到；`sending` 批次缺少崩溃后的租约回收。
5. **模块仍是单进程内的代码边界**，不是独立服务/独立数据库；没有新增构建步骤或模块级 `package.json`。
6. **历史文档的测试数字保留当时口径**：`docs/DELIVERY-REPORT.md`、`docs/PROJECT-PROGRESS-20261026.md` 等记录的是当时运行结果（58/81/51 等），不能当作本轮结果；本轮以第 8 节和模块 README 为准。
