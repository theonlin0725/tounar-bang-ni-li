# v1.0.0 封板验收记录

**日期**：2026-11-22  
**基线**：`235f43f`  
**目标版本**：`v1.0.0`  
**插件版本**：`0.2.11`

## 1. 版本与产物

- `package.json`：`1.0.0`
- `package-lock.json` 顶层版本：`1.0.0`
- `server/src/config.js` 默认 `appVersion`：`1.0.0`
- `GET /api/v1/health`：`ok: true`，`version: "1.0.0"`
- `extension/manifest.json`：`0.2.11`
- `web/assets/js/views/plugin-help.js`：`PLUGIN_VERSION = '0.2.11'`
- 重新构建 `web/downloads/bangnili-extension-0.2.11.zip`
  - 版本：`0.2.11`
  - 文件数：26
  - SHA256：`f40a264e0348ae62bd39cb48c1ee19b3a2edba0109e2c6a94bc4dbeb29328d08`
  - 压缩包顶层：`bangnili-extension/`
  - 构建脚本已检查违禁文件：无 `.env`、SQLite、密钥、token、日志、`node_modules`。

## 2. 三大需求模块核查

### P：插件 `0.2.6 → 0.2.11`

| 编号 | 结论 | 证据 |
|---|---|---|
| P-01 版本与下载包一致 | 通过 | manifest/PLUGIN_VERSION 均 `0.2.11`；重新构建 ZIP；SHA256 已记录 |
| P-02 多站点通用抓取 | 通过 | `test:netease-game` 60/60、`test:self-page` 6/6、`test:panel` 8/8 |
| P-03 大模型整理 JD | 通过 | `server/test/jd-extraction.test.js` 8/8；全量 `npm test` 仅余既有云快照环境失败；4324 台账/详情接口抽检正常 |
| P-04 网页连接与手动配对兜底 | 通过 | `server/test/plugin.test.js` 7/7；前端配对/设备面板由 web E2E 覆盖 |
| P-05 同页单岗详情与安全纠正 | 通过 | `test:netease-game` 60/60；`phase2` 安全纠正/人工保护单测通过 |

### F：前端大改造

| 编号 | 结论 | 证据 |
|---|---|---|
| F-01 左侧导航与角标 | 通过 | `test:web` 74/74；包含桌面/移动导航、角标同步断言 |
| F-02 简洁页面标题 | 通过 | `test:web` 页面标题断言；1440/390 抽检 |
| F-03 台账 5 列/状态色块/折叠轮次 | 通过 | `test:web` W-16a/W-16a1/W-16b/W-16b2；4324 与基准截图 |
| F-04 设置聚合与历史深链 | 通过 | `test:web` W-16c~W-16f、W-18b；`test:mail-admin` 通过 |
| F-05 简历分析/匹配六维/简历库 | 通过 | `test:career-ai` 51/51 |
| F-06 单岗匹配纠偏、面试题、旧对比下线 | 通过 | `test:career-ai` 51/51；旧对比深链零请求/无对比区断言通过 |
| F-07 390px 响应式 | 通过 | `test:web` 74/74；设置页与台账窄屏无横向溢出 |

### M：邮箱与状态自动更新

| 编号 | 结论 | 证据 |
|---|---|---|
| M-01 多邮箱供应商 | 通过 | `server/test/mail.test.js` 全通过；QQ/163/126/yeah.net 表单与路由检查 |
| M-02 实时进度与结束清理 | 通过 | `test:mail-progress` 6/6 |
| M-03 泛化识别与自动状态 | 通过 | `bench:mail-e2e` 44 封，全部指标 100%，7 项零容忍为 0 |
| M-04 4324 真实 QQ 状态 | 通过 | 129/129 邮件、9 条邮件台账、1 条真实待确认；无脏公司、无街道地址、无终态旧轮次 |
| M-05 待确认互斥/轮次清理/单封隔离 | 通过 | `mail.test.js`、`flash-intake.test.js`、`phase2.test.js` 全通过 |
| M-06 Flash 与清理脚本 | 通过 | `flash-intake` 全套通过；`mail:cleanup` dry-run 0 个脏候选 |
| M-07 全链路泛化基准 | 通过 | 44 封 / 11 轮；未使用真实个人数据；JSON/Markdown 报告已生成 |

## 3. 全量回归汇总

| 套件 | 结果 |
|---|---|
| `npm test` | **226 / 228**；仅既有 `cloud-persistence` / `cloud-persistence-http` 两个云快照用例环境性失败 |
| `npm run test:intake` | 10 / 10 |
| `npm run test:mail-progress` | 6 / 6 |
| `npm run test:mail-admin` | 通过 |
| `npm run test:web` | 74 / 74 |
| `npm run test:e2e` | 67 / 67 |
| `npm run test:career-ai` | 51 / 51 |
| `npm run test:panel` | 8 / 8 |
| `npm run test:netease-game` | 60 / 60 |
| `npm run test:self-page` | 6 / 6 |
| `npm run bench:mail-e2e` | 通过；44 封，召回/拦截/公司/岗位/状态均 100%，高危项全 0 |

额外专项：

- `server/test/jd-extraction.test.js`：8 / 8
- `server/test/plugin.test.js`：7 / 7
- `npm run build:plugin`：通过
- `npm run mail:cleanup`（dry-run）：0 个脏候选，open review 1 条（真实歧义）

## 4. 未修改能力防退化

账号认证、详情抽屉人工保护、手动补录/归档、待确认人工确认/忽略/撤销、每日提醒与深链两步确认、敏感操作二次鉴权与删除任务，均由全量 `npm test`、`test:web`、`test:e2e` 覆盖并通过。

## 5. 诚实已知边界

- 真实 **163 / 126 / yeah.net** 公网 IMAP 授权码联调仍未完成，当前只有 QQ 真实邮箱端到端证据；
- 无头 Playwright 下扩展 service worker/权限诊断存在环境限制；额外 `test:plugin-backend` 的随机不可达 origin 断言返回 `NETWORK_UNREACHABLE`，未作为本次发版门禁，P-04 的配对/设备生命周期由 `plugin.test.js` 与 web E2E 覆盖；
- 既有 `cloud-persistence` / `cloud-persistence-http` 云快照单测仍可能因环境文件/上游状态波动失败，与 v1.0.0 本次改动无关；
- 本仓库不提交真实邮箱、授权码、API Key、邮件正文或 `.tmp/` 证据。
