# 邮件推送模块

核对日期：2026-10-28。负责登录验证码邮件、进展/回看/待确认摘要的内容生成、发信和发送批次状态。QQ 收信与招聘邮件解析属于[数据抓取插件层](../data-capture/README.md)。

## 目录与主要文件

```text
server/src/modules/mail-push/
├── mailer.js       nodemailer SMTP、开发 outbox、验证码文本/HTML 模板
└── reminders.js    候选筛选、提醒文本/HTML、批次频控、提醒链接及两步确认凭据
```

相关文件保留原位：`server/scripts/run-reminders.js`（命令入口）、`server/scripts/latest-otp.js`（读取本地验证码）、`server/src/jobs/scheduler.js`（跨模块调度）、`server/src/config.js`（统一环境配置）、`server/src/routes/index.js`（设置和链接 API）。`tools/prod-reminder-verify.mjs` 是含生产/真实邮件操作的验收工具，不属于本地回归命令。

## 开发进度

| 状态 | 功能与代码依据 |
| --- | --- |
| **已实现** | `mailer.js` 的 `sendOtpMail` 生成验证码主题、纯文本、HTML；验证码有效期来自调用方配置 |
| **已实现** | `sendMail` 支持 outbox JSON 和 nodemailer SMTP；465 显式 TLS，其余端口要求 STARTTLS |
| **已实现** | `reminders.js` 的 `buildReminderCandidates` / `reviewDigestState` 分别选取新进展、该回看和待确认摘要 |
| **已实现** | HTML/纯文本摘要、原信/进展日期、岗位或状态页链接、台账深链、回看确认链接；外部岗位链接经过安全 URL 检查 |
| **已实现** | 每用户/北京时间日期/email 渠道批次；已发送/取消批次复用，空批次可再计算；回看记录 7 天频控、阶段锚点控制，待确认默认 15 天摘要 |
| **已实现** | 设置保存和只读预览；回看链接要求登录，GET 不改状态，明确点击后签发一次性确认凭据，最终写入由公共 `domain/reviews.js` 处理 |
| **部分实现** | SMTP 协议与错误记录已有代码，但本轮只测试 outbox，不证明真实收件箱送达 |
| **部分实现** | 进程内定时器及内部 tick API 已有实现；持续在线、失败恢复和生产外部调度仍依赖部署环境 |
| **尚未实现** | 收件箱投递状态/退信回调、SMTP 精确一次投递保证、独立消息队列工作进程；仓库未提供对应完整实现 |

outbox 模式也会将批次记为 `sent`，含义是本地 JSON 已写出。SMTP 模式 `sendMail` 返回不等于收件箱实际收到；2026-10-30 起会核对 `accepted` 是否包含目标收件人，拒收时记为失败。

## 配置

通过根目录 `.env` 和 `server/src/config.js` 配置；统一启动仍用根 `package.json`。没有独立的模块 `.env`、package.json 或构建步骤。

| 变量 | 实际默认值 / 作用 |
| --- | --- |
| `MAIL_MODE` | 有 `SMTP_URL` 时默认 `smtp`，否则 `outbox`；本地验证应显式指定 `outbox` |
| `SMTP_URL` | 空；SMTP 模式下必需，例如 `smtps://用户:授权码@smtp.qq.com:465`；凭据中的特殊字符需 URL 编码 |
| `MAIL_FROM` | `Tounar 帮你理 <no-reply@tounar.local>`；真实发信使用供应商允许的地址 |
| `DATA_DIR` | 根目录 `data/`；outbox 固定写到其 `outbox/` 子目录，无单独的 `OUTBOX_DIR` 配置 |
| `APP_BASE_URL` | `http://127.0.0.1:<PORT>`，决定邮件内链接，真实部署需填写用户可访问的地址 |
| `SHARE_CODE` | 空；可附加到邮件中的应用链接 |
| `REMINDER_HOUR` / `REMINDER_MINUTE` | `8` / `0`，Asia/Shanghai |
| `REMINDER_TICK_SECONDS` | `30`；定时器最小实际间隔为 15 秒 |
| `ENABLE_SCHEDULER` | `true`，同一个调度器还运行收信、浏览归档、删除恢复 |
| `REVIEW_DIGEST_DAYS` | `15`，待确认摘要间隔 |
| `REMINDER_LINK_DAYS` / `CONFIRMATION_TTL_MINUTES` | `14` 天 / `10` 分钟 |
| `OTP_TTL_MINUTES` | `10`；OTP 生成、校验和限流由公共 `auth.js` 负责 |

用户级提醒设置存入 `notification_preferences`，由网页保存，不是环境变量：

- `mode`：`all` / `changes_only` / `review_only` / `off`，新用户默认 `all`。
- `review_frequency`：`daily` / `weekly_monday`，默认 `daily`；`review_threshold_days`：7–30，默认 14。
- `stage_followup_days`：7 / 14 / 0（关闭），默认 7。

## 运行和验证

服务随 `npm start` / `npm run dev` 启动。纯本地体验可使用以下独立数据目录（首次为空），不读取根 `.env`：

```bash
DATA_DIR="$PWD/.tmp/mail-module-demo" DB_PATH="$PWD/.tmp/mail-module-demo/tounar.sqlite" \
HOST=127.0.0.1 PORT=4312 APP_BASE_URL=http://127.0.0.1:4312 \
ALLOWED_EMAILS=demo@tounar.local MAIL_MODE=outbox ENABLE_SCHEDULER=false \
CLOUD_LLM_ENABLED=false node server/src/index.js
```

在网页申请验证码后，另一终端读取同一数据目录：

```bash
DATA_DIR="$PWD/.tmp/mail-module-demo" node server/scripts/latest-otp.js
```

手动触发当前配置数据库的提醒批次，沿用既有命令：

```bash
MAIL_MODE=outbox npm run remind
MAIL_MODE=outbox npm run remind -- --owner=<用户ID>
```

`remind` 使用 `force: true` 跳过时段限制，但仍复用当天已发送批次。此命令会更新批次与通知消费状态；验证时必须让 `DATA_DIR`、`DB_PATH` 与测试库对应。没有可发送内容时返回 `skipped_empty` 是正常行为。网页版预览只计算候选，不发信、不改变批次。

自动回归会自行创建隔离库，覆盖验证码、提醒批次、频控、链接权限、明确确认、日期和阶段规则：

```bash
CLOUD_LLM_ENABLED=false npm test
CLOUD_LLM_ENABLED=false npm run test:web
```

主要测试：`server/test/auth.test.js`、`reminders.test.js`、`phase2.test.js`、`mail-admin.test.js`、`mail-transport.test.js` 和 `tests/e2e/run-web-e2e.mjs`。2026-10-30 追加管理员邮件测试后：`npm test` **150/150**、`npm run test:web` **57/57**、`npm run test:mail-admin` 通过；全部使用隔离库和 `MAIL_MODE=outbox`，未连接真实 SMTP，不能证明收件箱送达。拆分时点记录见[本轮验证记录](../../../../docs/MODULE-REORGANIZATION-20261028.md#8-本轮验证结果)，本轮恢复记录见[插件绑定恢复](../../../../docs/PLUGIN-BINDING-RECOVERY-20261030.md)。

## 已知问题与依赖

1. 自动调度只在配置小时、配置分钟起的 30 分钟窗口检查提醒，默认 08:00–08:29。错过窗口不会自动全天补发；模板仍写着“每日 08:00 触发，当天补发”，与可配置时间及窗口逻辑不完全一致。本次整理保留行为，后续应统一。
2. 网络超时等错误标记为 `delivery_unknown`，其他错误标记 `failed`；再次触发可重试，但未知送达时重试可能重复。`sending` 状态被直接复用，未见进程崩溃后对滞留 `sending` 批次的租约回收。
3. 调度器顺序等待 IMAP 再发提醒，收信耗时可能延迟推送。它也管理归档、删除任务，因此保留为公共调度，不能整个搬进推送模块。
4. 推送依赖公共 SQLite 中的申请、进展通知、待确认项、用户偏好和邮件收到时间；公共业务层负责写进展通知，本模块负责消费。它不直接调用收信模块。
5. `auth.js` 调用 `mailer.js` 发验证码；前端设置、提醒落地页通过公共路由调用本模块；同一配置、数据库与加密工具供各模块共享。

旧 `server/src/mailer.js` 和 `server/src/domain/reminders.js` 保留为转导出入口，避免历史工具或导入失效；实际维护位置是本目录。


## 管理员模板与手动自测（2026-10-30）

- `template-defaults.js`：验证码、摘要外壳、进展／回看／待确认卡片的代码默认版本。
- `templates.js`：动态变量转义、核心字段保护、可配约束、不可变版本和恢复；覆盖版本保存在当前 SQLite 的 `mail_template_versions`。
- `admin.js`：管理员校验、有限收件人试发、真实台账候选预览、短时隔离 HTML 预览、幂等与限流、触发／投递记录。
- `mailer.js`：所有发送的安全审计；不存真实 OTP 正文或 SMTP 密码，验证目标收件人确实被 SMTP 接受；受理不代表最终收到。
- `reminders.js`：正式与业务测试共享候选、卡片、摘要外壳和发信；测试使用独立 channel，不消费正式通知／回看频控。

使用根 `npm run mail:selftest` 启动固定 SMTP 自测副本（`data/mail-selftest-profile.json` 指向 `data/mail-selftest/`，已从旧验收库恢复插件绑定和 40 条台账；启动校验数据库身份与预期设备，失败即停止，不会重新复制）。管理入口 `/?panel=mail-admin`，完整操作与字段映射见 [真实邮件自测指南](../../../../docs/MAIL-SELFTEST-GUIDE.md)。普通服务必须显式配置 `ADMIN_EMAILS` 和 `TEST_MAIL_RECIPIENTS`；业务测试还要求 `ENABLE_MAIL_BUSINESS_TEST=true`，网页不能扩大权限或收件范围。`mail:selftest` 额外启用仅本机管理员自测登录（`ENABLE_SELFTEST_LOGIN`，回环+开发模式+管理员邮箱才回显 OTP，不发邮件）；普通 `npm start`/生产默认关闭。

新检查：`npm run test:mail-admin` 使用隔离 outbox 验证新页面操作；`server/test/mail-admin.test.js` 验证权限、约束、版本、真实业务记录与投递隔离，`mail-transport.test.js` 用本地模拟验证 SMTP 受理／拒收／超时，不进行真实外发。正式收件箱验收由用户执行。
