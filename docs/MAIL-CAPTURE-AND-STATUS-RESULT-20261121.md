# 招聘邮箱抓取与投递状态自动整理｜交付记录（2026-11-21）

基线：`dab10ad`。本单候选提交见当前 `HEAD`。

## 1. 多邮箱连接与防崩溃

- 新增 `server/src/modules/data-capture/mail/providers.js`：
  - QQ / VIP QQ / Foxmail → `imap.qq.com`
  - 163 → `imap.163.com`
  - 126 → `imap.126.com`
  - yeah.net → `imap.yeah.net`
  - 其他域名返回 400；不再仅支持 QQ。
- `ImapFlow` 显式发送 `clientInfo`，包含 RFC 2971 `ID` 所需客户端标识和 `support-email`。
- `IMAP_HOST` 只作为 QQ 默认主机覆盖；不会把 163/126/yeah.net 路由到 QQ。
- 授权码去空白后校验 8–64 位；重新授权会检查同账号其他活跃连接，避免唯一索引冲突。
- 同步实例创建后立即监听 `error`；连接、锁、logout 全部 try/catch，单封失败与连接失败分离。
- `decodeMimeWords` 对未知 charset 安全降级。
- `stripHtml(value, keepLines)` 可将 `<br>/<p>/<div>/<li>/<tr>` 转为换行；正文模式使用保留换行版本。
- 错误分类新增网易 `Unsafe Login` → `IMAP_UNSAFE_LOGIN`；认证失败、网络错误、未知同步错误分别给出状态和中文提示。

## 2. 单一招聘扫描模式

- 新建连接/重新授权前端统一提交 `consent_version: MAIL_RECRUITMENT_READ_V2`，后端强制 `recruitment_body`。
- 兼容旧单测的 `QQ_MAIL_READ_CONSENT_V1` 和旧 `mode` 接口仍保留。
- 设置页面移除「读取模式」下拉框、双向切换按钮、`读取范围：仅邮件头`。
- 旧 `headers_only` 连接只显示一次性「启用招聘邮件整理」；升级后按钮消失，不再提供切回仅邮件头。
- 断开连接后在原卡片下方直接显示换绑/重新连接表单，可连接 QQ、Foxmail、163、126、yeah.net。
- 邮件只读取命中招聘候选的正文，不读附件；证据最多保留 300 字摘录。

## 3. 自动整理与强规则

- `confirmedMailProgress(subject, bodyText)` 作为离线/无模型强规则：
  - 识别明确的测评/笔试、面试、投递成功；
  - 拒绝转发、流程介绍、条件句、广告、岗位推荐；
  - 公司/岗位可从正文键值对、主题【公司】/分隔符提取；
  - 排除公共邮箱域名、URL、邮箱地址和「通知 / 招聘 / 测评 / 未知 / 待补充」等占位词。
- 无台账命中、但公司 + 岗位 + 明确状态齐全时，直接新建投递明细：
  - `has_applied=1`；
  - `channel=邮件`；
  - `applied_at=收信时间`，精度 `inferred_before`；
  - 来源历史记为 `mail`。
- 已有唯一匹配时原地推进状态；相似岗位名使用 `similarJob`，不再因严格标题不等误进冲突。
- 人工修改保护、旧邮件不回退、同状态幂等、终态冲突保留。
- 只有身份不足、多岗歧义、字段/终态冲突/低置信度、AI 重试耗尽等真不确定场景进入待确认。

## 4. 历史待确认回填

- 事件 payload 记录 `body_review_version`。
- 同步时把 `review_items.status='open'` 且 `body_review_version < 1` 的历史 UID 并入本轮工作集。
- 回填正文后：
  1. 更新 `body_excerpt`/`ai_body_excerpt`/`body_review_version=1`；
  2. 优先走 `recordConfirmedMail` 强规则；
  3. AI 可用时也支持 `processIntakeEvent`；
  4. 自动入账后关闭原 review，并把 mail message 置为 `applied`。

## 5. 进度条与轮询

- 后端 `last_sync_stats_json` 增加并持续写入：

```json
{
  "phase": "connecting|searching|scanning|finalizing|done|error",
  "phase_label": "正在扫描 62 / 176 封",
  "total": 176,
  "scanned": 62,
  "percent": 35,
  "fetched": 100,
  "new": 62,
  "processed": 62,
  "applied": 14,
  "pending": 2,
  "ignored": 46,
  "errors": 0,
  "remaining": 114
}
```

- 单次同步按 50 封分批循环扫完，每 10 封续租并校验 binding；每批提交游标。
- 每 3 封/每批节流写入；expunge 缺失 UID 计入已扫描，避免卡在 99%。
- 前端设置页使用语义化 `<progress max="100">`：
  - 连接/搜索阶段为 indeterminate；
  - 扫描阶段显示进度、百分比、自动入账/待确认/错误摘要；
  - 完成显示 100%，没有新邮件时显示「没有新邮件」；
  - 仅 `connecting/syncing` 每 1200ms 查询一次；
  - 进入 connected/degraded/reauth_required/disconnected 立即停止；
  - 新入账或待确认时触发 `onChanged()`；
  - 使用本地 `paint` 更新状态卡，不整页重绘，避免表单失焦。

## 6. 配置

- 有 `AI_API_URL + AI_API_KEY` 且没有 `JEV_API_KEY` 时，`MAIL_INTAKE_JUDGE` 默认自动为 `flash`；显式 `MAIL_INTAKE_JUDGE=jev` 仍可覆盖。
- `AUTO_INTAKE_ENABLED` 的默认值同步与 Flash 可用性对齐。
- 没有 AI key 时不误启用自动入账。

## 7. 回归结果

| 套件 | 结果 |
|---|---:|
| 邮件重点套件（mail / flash / intake / phase2 / review / config） | **72/72** |
| `npm test` | **206/207**；仅既有云快照 `加密云快照…损坏与冲突拒绝` 失败 |
| `npm run test:web` | **70/70** |
| `npm run test:career-ai` | **51/51** |
| `npm run test:panel` | **8/8** |
| `npm run test:e2e` | **67/67** |
| `npm run test:netease-game` | **60/60** |
| `npm run test:intake` | **10/10** |
| `npm run test:mail-admin` | 通过（outbox，未发真实邮件） |
| `npm run test:mail-progress` | **6/6** |

新增覆盖：

- 多服务商路由、网易 Unsafe Login、公共邮箱域名/占位词过滤；
- HTML 换行正文、无台账测评邀请直接创建投递明细、重复邮件幂等；
- 历史待确认正文回填强规则入账并关闭 review；
- 相似岗位名推进不误报冲突；
- 邮件自动判断 Flash 默认与显式覆盖；
- 设置页进度条 35% → 100%、轮询停止、旧 headers_only 一次性升级、断开换绑、无旧模式/划线文案。

## 8. 证据

- 截图：`docs/evidence/mail-capture-20261121/`
  - `mail-progress-35.jpg`
  - `mail-progress-100.jpg`
  - `mail-upgrade.jpg`
  - `mail-form.jpg`
- 测试报告日志：`.tmp/mail-final-*`、`.tmp/mail-focused-final.log`、`.tmp/mail-progress-3.log`

## 9. 未完成 / 外部条件

- **T5 真实邮箱联调未完成**：没有真实 QQ / 163 客户端授权码；当前验证的是服务商路由、错误分类、离线强规则、固定 UI 进度和隔离 outbox，不把真实 IMAP/SMTP 连接标记为通过。
- `plugin-access.mjs`、`plugin-web-first.mjs`、`plugin-manual-pairing.mjs` 在当前 Playwright Chromium 上无法启动扩展 service worker，30 秒超时；与本轮邮箱功能独立，但未作为通过项。
- 没有把真实邮箱授权码、真实邮件正文或账号凭据写入仓库。
- 真实网易 IMAP 的 RFC 2971 `ID` 兼容性仍需真实 163/126/yeah.net 账号复核；当前只验证了 `clientInfo` 已发送、错误分类和请求路由。
