# 公共后端与模块装配

后端仍是一个 Node ≥24 进程，使用内置 `node:sqlite`。在根目录运行 `npm start` / `npm run dev`，同时提供 API、网页静态资源和可关闭的进程内调度器。2026-10-31 的简历/AI 功能新增了 `resumes`、`ai_reports` 两张表，但仍共用同一个 SQLite 和进程，没有新增数据库或独立服务。

职责模块的文档入口：

- [数据抓取插件层](src/modules/data-capture/README.md)：服务端来源接入，加根 `extension/` 客户端。
- [邮件推送模块](src/modules/mail-push/README.md)：内容生成、发信、批次和提醒链接。
- [前端展示模块](../web/README.md)：根 `web/` 的同源 SPA。
- [简历与 AI 岗位分析](src/modules/career-ai/README.md)：简历解析/画像、岗位对比、未投递推荐；使用现有 HTTP/SQLite/SPA。
- [招聘进展自动入账](src/modules/recruitment-intake/)：LLM 提取 + Jev 判断 + 服务端校验；详见[工作流说明](../docs/AUTO-INTAKE-WORKFLOW.md)。

## 保留的公共文件

| 文件 | 职责、依赖与保留理由 |
| --- | --- |
| `src/index.js` | 初始化路由/数据库、监听、启停调度和退出清理；保持既有启动入口 |
| `src/http.js` | HTTP、请求解析、响应、安全头、CORS、同源写校验、健康检查及 `web/` 静态托管；服务所有模块 |
| `src/routes/index.js` | API 装配、鉴权、幂等和设置校验；同时聚合插件、收信、台账、提醒、删除，暂不按单个模块强行迁移 |
| `src/config.js` | 根路径、数据库、密钥及环境变量；保持根目录计算与已有 `.env` 兼容 |
| `src/db.js` / `schema.sql` | 单库连接、增量迁移、事务、查询、修订与通知写入；表被多个流程共同使用 |
| `src/util.js` / `idempotency.js` | 状态/时间/URL/加密工具和写操作幂等 |
| `src/auth.js` | 白名单、OTP、会话、限流、重鉴权；发验证码时调用推送模块，鉴权本身供所有 API 共用 |
| `src/domain/applications.js` | 插件、邮件、人工输入共同使用的建档、字段保护、候选复核、状态变更、历史与通知生成 |
| `src/domain/mailMatching.js` | 名称虽含 mail，但 `findProgressCandidates` 同时支持插件稳定身份与邮件匹配，属于共享业务规则 |
| `src/domain/ledger.js` | 多用户台账查询、统计、详情与证据投影；是服务端业务读取，不是浏览器展示代码 |
| `src/domain/reviews.js` | 确认、纠错、归档、已查看、撤销和版本冲突；跨插件、邮件和人工来源 |
| `src/domain/deletion.js` | 跨来源删除、撤销邮箱和设备、回执状态与匿名化 |
| `src/jobs/scheduler.js` | 收信、提醒、浏览归档、删除恢复的共同调度，保留装配位置 |

以上是明确的共享职责，不是尚未检查的文件。强制塞入采集/推送/展示中的一个，会让其他模块反向依赖错误的职责。

`src/plugin.js`、`src/mailer.js`、`src/domain/{mail,mailSync,mailParser,reminders}.js`、`src/cloud/llm.js` 是兼容转导出文件；真正实现已在 `src/modules/`。现有测试保留部分旧路径导入，以覆盖兼容入口；生产路由、鉴权、调度、命令和云端探针改用新路径。

## 脚本与测试

| 路径 | 归属和用途 |
| --- | --- |
| `scripts/run-mail-sync.js` | 采集模块 CLI，保留 `npm run mail:sync` |
| `scripts/run-reminders.js` / `latest-otp.js` | 推送模块 CLI，保留 `npm run remind` / `otp:latest` |
| `scripts/local-{acceptance,stop}.js` | 跨模块本地验收启动、复制数据库和进程管理 |
| `scripts/export-acceptance-copy.js` / `prepare-deploy-bundle.js` | 数据副本/部署准备，跨模块运维；涉及用户数据，不随模块搬动 |
| `scripts/repair-{captured-fields,browse-reviews}.js` | 历史业务记录修复工具；不是常规启动动作，本次不执行修复 |
| `scripts/audit-self-captures.js` | 只读识别历史自身页面误采集；`--apply --confirm` 才忽略事件/关闭待确认，不删除台账 |
| `../tools/eval-intake.mjs` | 真实 LLM/Jev 的隔离样本评估；不读取用户库 |
| `scripts/phase3-review-acceptance.mjs` / `seed-acceptance-reminder.js` | 跨采集、复核、台账和推送的验收/测试造数工具 |
| `test/` | 鉴权、隔离、持久化、事件、台账、邮件、提醒、复核、删除、修复工具等集成测试；使用隔离测试库 |
| 根 `tests/e2e/` | 共享浏览器、fixture 服务以及网页/插件端到端测试；不拆开公共测试基础设施 |

本轮职责移动清单、依赖图和验证结果见[拆分记录](../docs/MODULE-REORGANIZATION-20261028.md)。
