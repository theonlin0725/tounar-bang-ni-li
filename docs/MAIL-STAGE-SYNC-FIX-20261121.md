# 邮件同步中断修复与 4324 真实 77 封验收记录

日期：2026-11-21  
代码基线：`bff3326`  
验收实例：`http://127.0.0.1:4324`  
数据副本：`/Users/mingenlin/tounar-acceptance/20261120-real-resume-selftest`

## 1. 工作区复核修复

保留并复核了工作区原有 7 个文件改动，未回退：

- `server/src/domain/applications.js`
  - `recordConfirmedMail` 传入 `reviewTerminal: !config.autoTerminalFromMail`；
  - `applyStatusTransition` 返回失败时创建 review，不再抛 `MAIL_STAGE_CONFLICT` 中断整轮同步。
- `server/src/modules/data-capture/mail/parser.js`
  - 收紧 rejected 正则，排除“如时间不合适请联系改期”等面试改期文案。
- `server/src/modules/data-capture/mail/sync.js`
  - 单封 `ingestMessage` 异常隔离为 `ingestMessageIsolated`，计入 `stats.errors` 并继续扫描；
  - AI 开启时优先 `processIntakeEvent`，AI 技术失败时回退强规则；
  - `IMAP_SYNC_FAILED` 日志透出 `err.code`。
- `server/src/util.js`
  - `AppError` 补 `this.name = 'AppError'`。
- `server/src/modules/recruitment-intake/workflow.js`
  - 同公司新岗位（`new_job_same_company`）不再混入同公司旧候选，避免 `AI_NO_MATCH_WITH_CANDIDATES`。
- `web/assets/js/views/settings.js`
  - `pollMail` 进入终态时先清空 `msgBox`，不再残留“当前状态：正在扫描 0 / 77 封”。

## 2. 新增边界测试

- 单封 ingest 抛错被隔离、`stats.errors=1`、后续消息仍可完成；
- AI 开启时同公司新岗位、模型返回 `no_match`，直接新建独立记录，不进入待确认；
- 另继续覆盖终态转待确认、面试改期不误判、公司级无岗位名、历史回填等。

## 3. 真实 4324 同步结果

使用副本库中已绑定连接 `mailconn_64jN1pTAQr2lWrVz`（邮箱已脱敏）通过浏览器「设置 → 数据与授权 → 立即同步」触发：

| 指标 | 结果 |
|---|---:|
| 总扫描 | 77 |
| 进度 | 0% → 100% |
| 自动入账事件（`applied`） | 13 |
| 新建独立台账 | 7 |
| 转待确认（`pending`） | 2 |
| ignored | 5 |
| duplicate | 35 |
| errors | 0 |
| 剩余积压 | 0 |

- 页面最终显示：`已扫描 77 / 77 封（完成） 100%`、`自动入账 13 条 · 待确认 2 条 · 错误 0`。
- 底部不再残留扫描中状态。
- `.tmp/real-resume-server.log` 本轮未再出现 `MAIL_STAGE_CONFLICT` 或 `mail_sync_failed`。
- 同步前后的数据在同一副本库，未触碰真实源库。

截图保存在 `.tmp/`，不提交仓库：

- `.tmp/4324-mail-sync-complete.png`
- `.tmp/4324-ledger-sync-complete.png`

## 4. 4324 启停元数据

副本目录已补齐：

- `acceptance.env`
- `state.json`

`npm run local:stop -- --port 4324` 已实际验证能识别并停止原实例；随后用最新代码重新启动：

- PID：`6913`
- `GET /api/v1/health`：`200`，`ok:true`
- `GET /`：`200`

启动参数保留副本 `DATA_DIR`、`DB_PATH`、`MAIL_MODE=outbox`、调度关闭和模型/简历配置。

## 5. 全量回归

| 套件 | 结果 |
|---|---:|
| 邮件重点套件（mail / flash / intake / phase2 / review / reviews / config） | **81/81** |
| `npm test` | **215/216**；仅既有云快照 `加密云快照…损坏与冲突拒绝` 失败 |
| `npm run test:web` | **70/70** |
| `npm run test:career-ai` | **51/51** |
| `npm run test:panel` | **8/8** |
| `npm run test:e2e` | **67/67** |
| `npm run test:netease-game` | **60/60** |
| `npm run test:intake` | **10/10** |
| `npm run test:mail-admin` | 通过 |
| `npm run test:mail-progress` | **6/6** |

## 6. 未提交内容与边界

- `.tmp/` 日志、截图、真实邮箱账号、授权码和邮件正文未提交。
- 真实邮箱统计仅来自本机隔离副本；真实 QQ IMAP 连接、真实进度和自动入账均为本次实测结果。
- 扩展 service worker 相关浏览器测试仍受当前 Chromium 环境限制，不属于本轮邮箱修复门禁。
- 既有云快照测试历史不稳定，本轮剩余唯一失败为 `加密云快照：WAL 写入、故障重试、删除本地后恢复、损坏与冲突拒绝`。
