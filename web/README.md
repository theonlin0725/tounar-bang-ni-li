# 前端展示模块

核对日期：2026-10-31。负责用户页面、交互、API 错误呈现和台账/证据展示。现有 `web/` 已具备清晰边界，本次保留原目录和 URL，继续由公共 Node 服务提供静态文件。

## 目录与主要文件

```text
web/
├── index.html                 SPA 入口
└── assets/
    ├── app.css                页面、表格、抽屉、弹窗及响应式样式
    └── js/
        ├── app.js             路由、会话代际守卫、顶栏和视图挂载
        ├── api.js             同源 Cookie 请求、统一错误、幂等头、401 处理
        ├── util.js            DOM、格式化、提示和确认弹窗工具
        └── views/
            ├── career.js      简历上传/画像、岗位对比、未投递推荐
            ├── mail-admin.js  管理员模板、约束、预览、试发和业务触发记录
            ├── login.js       邮箱 OTP 登录和重验证
            ├── ledger.js      统计、台账、筛选、分页和更新检查
            ├── detail.js      详情、JD、来源、状态历史、纠错及归档
            ├── manual.js      手动补录与线索填充
            ├── reviews.js     待确认信息流、按状态直入账、候选选择/忽略/撤销
            ├── settings.js    提醒偏好、插件设备、QQ 授权、数据删除
            └── landing.js     邮件 /r/<token> 落地页和明确确认
```

根目录 `demo/` 是使用内存示例数据的独立历史原型，不调用网络、不持久化数据，`demo.zip` 为原型存档。两者不由 `config.webDir` 提供，不是当前真实后端 SPA；保留原位，避免把模拟数据原型混进运行入口。

`extension/popup/` 和注入页面的 Toast 虽然也是 UI，但依赖扩展权限、service worker 和采集任务生命周期，归属[数据抓取插件层](../server/src/modules/data-capture/README.md)，不移入网页模块。

## 开发进度

| 状态 | 已有能力与边界 |
| --- | --- |
| **已实现** | 白名单邮箱验证码登录、退出、过期会话处理和敏感操作重验证；账号切换作废旧请求结果、清理抽屉和弹窗 |
| **已实现** | 累计投递/进行中/面试统计；已投、看过没投、归档、待确认；关键词、状态、来源、回看条件筛选及分页 |
| **已实现** | 详情展示 JD、字段来源/把握度、历史、投递时间精度；手动补录、纠错、归档/恢复、已查看动作 |
| **已实现** | 待确认信息流：只分插件/邮件来源；卡片只保留「确认入账/忽略」。确认先走服务端 LLM+Jev 识别；公司/岗位必填，缺失/歧义弹补录，取消保持 open，模型失败可重试/手动。标题有原网页链接时直接可点；忽略立即生效。候选冲突时选择目标，保留短时撤销和并发冲突反馈 |
| **已实现** | 台账删除重复“投递链接”，只保留“查看岗位”并指向岗位详情；状态列直接下拉编辑，保留人工历史；看过没投转已投后进入投递明细。跨板块勾选 2–6 个岗位进入 `/?panel=career` 对比 |
| **已实现** | 服务端自动入账（LLM 提取 + Jev 判断 + 服务端校验）通过 data_revision 轮询反映到统计/状态；技术失败进入重试，不显示为待确认 |
| **已实现** | 提醒偏好保存/预览、插件配对批准与撤销、QQ 连接/同步/重新授权/断开、数据删除进度和设备清理回执 |
| **已实现** | `/?app=<id>`、`/?panel=reviews`、`/?panel=settings` 和 `/r/<token>`；提醒落地页登录后恢复操作，打开链接不直接修改记录 |
| **已实现** | 页面可见时每 2 秒检查修订、重新获焦时检查，邮件更新提示和高亮；这是当前 `ledger.js` 的实现，旧文档的“60 秒”已过时 |
| **部分实现** | 本地 API 与浏览器链路已实现；真实 QQ/SMTP/招聘站点、网关分享码和生产部署效果依赖外部服务，不能从网页回归推出已验收 |
| **部分实现** | 有响应式 CSS 与窄屏测试；本轮未进行全浏览器、全部真实手机或全面无障碍验收 |
| **尚未实现** | 独立前端 API 地址配置/跨域部署流程、离线业务写入/网页 Service Worker；当前按同源在线 SPA 运行 |

## 配置与运行

不需要前端构建，也没有独立的前端 package.json、Vite 或 `VITE_API_URL`。`api.js` 使用 `/api/v1/...` 相对路径和 `credentials: 'same-origin'`。

在项目根目录：

```bash
npm install
# 首次配置：仅在没有 .env 时，从 .env.example 复制；已有 .env 不要覆盖
npm start
# 开发时也可 npm run dev；浏览器静态资源修改后刷新页面
```

浏览器打开 `http://127.0.0.1:4310`。Node ≥24；端口、监听地址和服务配置由 `server/src/config.js` 读取。代码默认监听 `0.0.0.0`，需要仅本机访问时设置 `HOST=127.0.0.1`。`.env.example`、登录白名单、outbox 验证码操作见[根 README](../README.md)。

不能直接双击 `web/index.html` 或只起一个静态服务器替代后端：认证和业务操作需要同源 API。邮件链接由后端 `APP_BASE_URL` / `SHARE_CODE` 生成；插件后台 URL 则在 popup 中单独保存。

## 验证

```bash
CLOUD_LLM_ENABLED=false npm test
CLOUD_LLM_ENABLED=false npm run test:web
```

`tests/e2e/run-web-e2e.mjs` 启动真实本地后端、隔离 SQLite/outbox 和 Playwright 浏览器，覆盖登录、台账、待确认、提醒设置与链接、设备、收信失败可见、删除等流程；`phase2-web.mjs` 补充邮件进展/阶段回看/移动视口验证。报告写入 `.tmp/web-e2e-report.json`，截图位于 `.tmp/web-e2e/`。

2026-11-01 自动入账/状态直改/精简待确认后：`npm test` **150/150**、`npm run test:web` **57/57**（Chrome for Testing 156.0.8078.4）、`npm run test:self-page` **6/6**、`npm run test:career-ai` **11/11**（本地假模型）、`npm run test:intake` **10/10**（隔离假模型）。真实 LLM/Jev 另见 `npm run eval:intake`；未验证真实 QQ/SMTP/招聘站点和线上部署。拆分时点记录见[拆分验证记录](../docs/MODULE-REORGANIZATION-20261028.md#8-本轮验证结果)，自动工作流见[实现说明](../docs/AUTO-INTAKE-WORKFLOW.md)。

浏览器准备与下载行为由 `tests/e2e/browser.mjs` 决定，见[采集模块说明](../server/src/modules/data-capture/README.md#验证与依赖)。

手动验证可按以下顺序：空账号登录 → 手动补录一条 → 打开详情 → 修改提醒偏好并预览 → 处理一条待确认（直接选状态）→ 打开测试 outbox 中的提醒链接，登录并明确确认。简历 AI 需先配置 `AI_API_URL/AI_API_KEY/AI_MODEL`，再从台账勾选岗位进入 `/?panel=career`；自动入账另需 `JEV_API_KEY`；创建测试记录应使用隔离库，参见[邮件模块的本地示例](../server/src/modules/mail-push/README.md#运行和验证)。

## 已知问题、未完成事项与依赖

- `manual.js`、`detail.js` 等仍有“D12 未冻结”文案，公共配置中的冻结决策与当前严格校验已更新；属于历史文案不一致，本次未改用户流程。
- 设置页展示的 `/api/v1/meta/decisions` 含静态历史门禁说明，不能用它判断当前真实凭据/站点验收情况；需结合连接状态和实际验收。
- 2 秒轮询已实现，但没有 WebSocket/SSE 推送；列表和明细由后端计算，接口错误显式呈现，不生成替代业务数据。
- `app.js` 与各视图存在相互引用，继续沿用现有 SPA 结构；本次没有借目录整理重写会话和视图逻辑。
- 简历 AI 页面依赖服务端显式配置的 OpenAI 兼容网关；未配置时上传/画像可解析但分析、对比、推荐会明确失败。真实模型输出质量、时延、费用和真实简历 PDF/DOCX 尚未联调；自动测试使用本地假模型。
- 自动入账已用真实 DeepSeek/Jev 跑 8 条合成中文样本；样本小，不能当作生产精准率。真实 IMAP 正文、附件和重复稳定性未联调。
- 依赖公共后端 `http.js` 提供页面和 `/r/` 回退、`auth.js` 提供会话、`routes/index.js` 提供 API；数据来自公共 `domain/ledger.js` / `applications.js` / `reviews.js`。这些文件包含多用户隔离、业务状态和写入规则，保留在服务端，不能当作展示代码搬进 `web/`。
- 与采集层通过设备/邮箱/台账/待确认 API 协作；与[邮件推送模块](../server/src/modules/mail-push/README.md)通过提醒偏好、预览、提醒链接和 OTP 协作，没有直接导入服务端 JS。


管理员真实邮件自测入口为 `/?panel=mail-admin`，顶栏仅对配置的管理员显示「邮件测试与模板」，后端所有管理 API 独立校验权限。参见 [完整自测指南](../docs/MAIL-SELFTEST-GUIDE.md)，使用 `npm run mail:selftest` 的持久测试副本。HTML 预览由需鉴权的短时预览地址提供，在无脚本、无外部资源的 sandbox iframe 内呈现内联排版，不把模板 HTML 注入主页面。
