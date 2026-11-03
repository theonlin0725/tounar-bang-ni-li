# 数据抓取插件层

核对日期：2026-10-28。职责是接入数据来源、采集和解析线索，并交给公共业务层处理。浏览器招聘页面和 QQ 收件箱是目前的两种来源；SMTP 发信属于[邮件推送模块](../mail-push/README.md)。

本模块由服务端实现和根目录的 `extension/` 共同组成。保留扩展目录是为了兼容 Chrome 已加载的扩展路径、manifest 相对资源和现有测试工具；它不是另一个独立业务模块。

## 目录与主要文件

以下路径相对项目根目录：

```text
server/src/modules/data-capture/
├── plugin.js                 配对、设备鉴权、心跳、撤销、C1 事件批量接收与回执
├── mail/
│   ├── connections.js        QQ 连接创建、重新授权、断开与同步触发
│   ├── sync.js               IMAP 收信、游标、去重、正文读取、事件转换
│   └── parser.js             招聘邮件过滤、分类、字段和证据摘要提取
└── cloud/llm.js              可选云端邮件兜底；预留页面提取函数
extension/
├── manifest.json             Chrome MV3，当前源码版本 0.2.1
├── content/adapters.js       专属站点规则、通用规则和部分公开岗位接口适配
├── content/tracker.js        页面识别、字段评分、可见停留计时、SPA 跟踪和页面反馈
├── background/service-worker.js  权限注入、上传、重试、设备清理和回执反馈
├── lib/{common,api,queue,learned}.js  设置、API、IndexedDB 队列、选择器模板
├── popup/                   配对、授权、主动采集、暂停、队列和模板管理 UI
├── icons/                   扩展图标
└── scripts/make-test-build.mjs  本地测试扩展构建
tools/
├── probe-site.mjs / tryrun-plugin.mjs  页面探测、生产采集脚本试跑
├── replay-sites.mjs / live-site-capture.mjs  快照回放、实时站点识别体检（非完整验收）
├── site-{session,snapshot,page-state}.mjs  浏览器会话、快照脱敏、错误页识别
└── probe-llm.mjs             云端能力探针
```

`server/scripts/run-mail-sync.js` 是既有命令入口；`tests/fixtures/{sites,live,synthetic-capture}/` 是不同来源的验收样本。工具和样本继续原位保存，便于现有命令及证据路径复用。

## 已实现

| 功能 | 代码依据与边界 |
| --- | --- |
| 插件配对和设备管理 | `plugin.js`：8 位配对码、网页批准、设备令牌、心跳、撤销和清理回执；撤销不等于离线设备已清理 |
| 页面采集 | `tracker.js`：可见页面累计 3 秒浏览、主动采集、列表线索、填写/提交/状态证据；不把填写或普通点击直接当作成功投递 |
| 字段与正文 | 多来源字段评分、低把握留空、完整 JD 与摘要；JD 正文上限 100000 字符，超限不静默截断保存 |
| 队列与上传 | IndexedDB 持久队列、批量上传和重试；服务端逐条校验、幂等、返回 `outcome`、记录/待确认 ID 等结果 |
| 选择器模板 | `learned.js`：按 origin/路由形状存储、回放核验、失败降级、列表及删除；属于本地规则学习 |
| QQ 连接生命周期 | 仅接受 qq.com、foxmail.com、vip.qq.com；授权码加密保存、显式同意、异步同步、错误状态、断开和重新授权 |
| IMAP 读取与解析 | 只读 INBOX；首次按日期扫描，后续按 UID/UIDVALIDITY 增量；单次最多处理 50 封，批量同步最多选 20 个连接；邮件去重、摘要留存和事件转换 |
| 两种读取模式 | `headers_only` 不读取正文；`recruitment_body` 对先通过邮件头筛选的邮件读取文本/HTML 正文，下载上限 192 KiB，不读取附件 |

解析后的状态归属和自动更新由公共 `domain/applications.js`、`domain/mailMatching.js` 决定；自动入账开启时，疑似招聘邮件还会进入 `modules/recruitment-intake/` 的 LLM+Jev 工作流，由服务端最终校验后写入。匹配代码同时服务插件，因此没有移入邮件专属目录。

## 自动入账接入（2026-11-01）

- 邮件：`mail/sync.js` 对疑似招聘邮件调用 `processIntakeEvent`；LLM 提取、Jev 判断、服务端校验后才创建/更新/待确认。技术失败进入 `ai_ingest_runs` retry，不制造用户待确认。
- 插件：`site_status_observed` 先 accepted，随后异步走同一工作流；普通浏览和强提交仍走原有证据规则。
- 自动开启时不再调用旧的 WorkBuddy 邮件分类兜底，避免两套判断竞争。
- 详细配置、阈值、真实样本评估见[自动入账工作流](../../../../docs/AUTO-INTAKE-WORKFLOW.md)。

## 自身页面排除（2026-10-31）

“帮你理”自己的 SPA、登录页、`/mail-selftest.html`、`/api/` 和 `/assets/` 不是招聘岗位。排除分四层，任何一层命中都不会创建岗位/浏览线索/待确认：

1. **内容脚本**：按后台 origin（从 popup 保存的 `serverUrl` 读取）+ 项目 DOM（`#tn-root`）+ 标题（Tounar/帮你理）+ 项目路径识别；`detectJob`、`blockedPage`、列表识别、停留计时、`sendEvent`、主动采集、页面输入、提交/状态扫描、SPA 路由、`pagehide`、消息反馈都提前返回。
   所有事件现在额外携带 `payload.page_url`；服务端据此识别 loopback 根路径、`?panel=`、自测页、`/api/`、`/assets/`，即使插件指向 4310/4312 等未登记端口也拒绝。没有有效岗位内容（系统摘要、空状态、导航、占位标题）的浏览/表单事件自动 ignored，不进入待确认。
2. **service worker**：入队前检查发送页 origin 和事件 `job_url/status_url` 是否属于后台；旧队列在 flush 时逐条移除自身页面事件，不清空其他事件；上传结果不生成虚假岗位。
3. **服务端兜底**：按 `APP_BASE_URL`、实际 Host、本机端口构造自身 origin；`/events/batch` 的 `SELF_APP_EVENT` 直接拒绝，不入库、不建待确认。这样旧版插件/旧队列也无法穿透。
4. **历史数据**：`npm run audit:self-captures -- --db <库> --origin http://127.0.0.1:4311` 只读识别历史事件/待确认/关联台账；`--apply --confirm` 只忽略事件、关闭历史待确认，不删除台账，不整队清空。当前 4311 历史识别结果见[审计报告](../../../../docs/SELF-CAPTURE-AUDIT-20261101.md)。

验收：`npm run test:self-page` **6/6**（打开、停留、刷新、路由切换、主动采集均不新增）；`server/test/plugin-capture.test.js` 覆盖服务端拒绝且正常招聘事件仍入账。

## 部分实现与尚未实现

- **部分实现：真实站点覆盖。** 有专属规则、通用识别、公开页面快照和历史验收，但不能据此承诺任意招聘站、登录页或投递成功态都可用。本轮仅验证本地夹具和已有快照，未重新验收实时招聘站。
- **部分实现：页面反馈。** 提示、队列恢复等已有代码和测试，但尚有跨页面批次混合、SPA 切换后旧提示、A→B→A 旧回执、分享码深链等缺口。见现有[插件复验报告](../../../../docs/PLUGIN-A-REACCEPTANCE-20261027.md)；该文件在本次工作开始前已存在且未提交，本次原样保留。源码位置为 `service-worker.js` 的 `deliverFeedback`、`tracker.js` 的 `resetJob`/反馈处理和 `popup.js` 的 `refresh`。现有测试通过不表示这些问题已修复。
- **部分实现：真实 QQ IMAP。** 协议代码存在，自动测试覆盖连接生命周期和失败可见性；本轮未使用真实授权码验证收信。
- **部分实现：云端兜底。** 配置完整才调用 `llmClassifyMail`，失败返回 `null`；返回的 LLM 置信度封顶 0.88。当前 `sync.js` 也会用 LLM 补公司/岗位、保留原规则分类分数，且调用条件与类别替换条件并不完全一致；不能把注释中的“永远只进待确认”当作已验证的端到端保证。
- **尚未实现：页面 LLM 接入正式采集链路。** `llmExtractPageLead` 仅由 `tools/probe-llm.mjs` 调用，插件没有对应调用链。
- **尚未实现：QQ 以外邮箱供应商的完整接入、插件市场发布流程、各模块独立服务部署。** 当前仓库中无相应完整实现。

## 配置与运行

所有命令在项目根目录执行，Node ≥24，依赖使用根 `package.json`。通过 `npm start` / `npm run dev` 与公共后端一起启动，不另启采集服务。

1. 按[根 README](../../../../README.md) 启动网页并使用白名单邮箱登录。
2. Chrome 打开 `chrome://extensions`，开启开发者模式，加载根目录 `extension/`。
3. popup 保存后台地址并授予连接权限；默认 `http://127.0.0.1:4310`，本机检测会优先选择 4311、其次 4310。
4. popup 发起配对，在网页「数据与授权」输入配对码批准；对招聘站点显式授权后浏览或主动采集。
5. 需要 QQ 收信时，在网页「数据与授权」填入邮箱和授权码、读取模式及首扫日期，并确认同意条款。该授权存入数据库，不是 `.env` 中的 SMTP 密码。

实际环境变量集中在 `server/src/config.js` 和本模块 `mail/sync.js`：

| 变量 | 默认值 / 含义 |
| --- | --- |
| `IMAP_HOST` / `IMAP_PORT` | `imap.qq.com` / `993`；仅端口 993 使用 `secure: true` |
| `IMAP_CONNECT_TIMEOUT_MS` | `20000`，连接及问候超时 |
| `MAIL_SYNC_MINUTES` | `25`，公共调度器同步间隔 |
| `MAX_EVENT_BATCH` | `50`，服务端事件批次上限；插件自身也固定为 50 |
| `PAIRING_TTL_MINUTES` / `DEVICE_TOKEN_DAYS` | `10` / `180` |
| `CLOUD_ENDPOINT` / `CLOUD_PUBLISHABLE_KEY` | 默认空；两者完整才启用云端能力 |
| `CLOUD_LLM_ENABLED` / `CLOUD_LLM_TIMEOUT_MS` | `true` / `20000`；超时用于聊天请求，模型列表查询未使用同一超时控制 |
| `AUTO_PROGRESS_CONFIDENCE` / `AUTO_TERMINAL_CONFIDENCE` | `0.8` / `0.9`，公共业务层使用的总把握度阈值 |
| `AUTO_TERMINAL_FROM_MAIL` | `true`，允许高把握度终态自动更新 |
| `D12_ALLOW_MAIL_INFERRED_APPLIED_AT` | `true`，允许按收信时间推断最晚投递日期，不代表精确日期 |

`ENABLE_SCHEDULER=false` 关闭周期调度，但不阻止网页创建/同步连接时触发 IMAP。`MAIL_MODE=outbox` 只控制发信，不关闭收信。`IMAP_CLIENT_ID` 虽被配置对象读取，当前 ImapFlow 的 `clientInfo` 仍是硬编码，不能用它配置客户端身份。

```bash
npm run mail:sync                         # 同步当前数据库的连接
npm run mail:sync -- --connection=<连接ID> # 只同步指定连接
npm run probe:site -- 'https://招聘站/岗位页'
npm run plugin:tryrun -- 'https://招聘站/岗位页'
npm run probe:llm                         # 需要已配置的外部云端服务
```

## 验证与依赖

本地回归不需要真实 QQ、SMTP 或云服务：

```bash
CLOUD_LLM_ENABLED=false npm test
CLOUD_LLM_ENABLED=false npm run test:e2e
CLOUD_LLM_ENABLED=false npm run test:plugin-acceptance
CLOUD_LLM_ENABLED=false npm run test:toast
CLOUD_LLM_ENABLED=false npm run test:plugin-backend
node tools/replay-sites.mjs --report .tmp/module-replay.json
```

2026-10-28 拆分后、2026-11-01 追加自动入账后实际回归：`npm test` **150/150**；`npm run test:web` **57/57**；`npm run test:e2e` **67/67**（含 26 份真实站点快照离线回归，13 站点 × 2）；`npm run test:plugin-acceptance` **18/18**（稳定 fixture，manifest 预授权）；`npm run test:plugin-backend` **4/4**；`npm run test:toast` **13/13**（本轮重跑）；`npm run test:self-page` **6/6**；`npm run test:intake` **10/10**（隔离假模型）；`npm run eval:intake` 用真实模型跑合成样本但未接真实邮箱。全部使用隔离数据目录/outbox，未配置真实 QQ 授权码、SMTP 或云端凭据，也未重新访问实时招聘站；不能由此推出真实外部环境已验收。拆分时点结果见[拆分验证结果](../../../../docs/MODULE-REORGANIZATION-20261028.md#8-本轮验证结果)，本轮恢复记录见[插件绑定恢复](../../../../docs/PLUGIN-BINDING-RECOVERY-20261030.md)。

后端测试位于 `server/test/{plugin,plugin-capture,events,mail,phase2}.test.js`；端到端测试共享 `tests/e2e/browser.mjs`。测试自动使用 `.tmp` 隔离库和 outbox。浏览器解析器在 Mac 优先使用 `.tmp/cft` 的 Chrome for Testing，缺失时可能下载，再回退 Playwright Chromium。测试构建预授予本机主机权限，不证明原生 Chrome 权限弹窗已验收。

依赖方向：插件 → HTTP/C1 → `plugin.js` → 公共业务层；QQ → IMAP/解析 → 公共业务层 → SQLite。服务端依赖 `config.js`、`db.js`、`util.js`、`domain/applications.js`、`domain/deletion.js`，并由公共路由和调度器装配。前端通过 API 管理授权、设备、台账和待确认；采集模块不直接导入前端或发信模块。公共业务层写出的 `notification_outbox` 由推送模块消费。

旧 `server/src/plugin.js`、`domain/mail*.js` 中已迁移的三个文件和 `cloud/llm.js` 仅转导出，新开发请使用本模块路径。`domain/mailMatching.js` 仍是公共实现。完整移动表和本轮测试结果见[拆分记录](../../../../docs/MODULE-REORGANIZATION-20261028.md)。
