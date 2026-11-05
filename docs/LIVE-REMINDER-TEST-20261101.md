# 真实提醒邮件测试（2026-11-01）

## 结论

- 真实台账当前**没有**满足 A（未消费进展）/ B（回看到期）/ digest（待确认汇总到期）的候选：A=0、B=0；待确认 28 条，但上次 digest 是 2026-10-22，未到 15 天。
- 为验证发送链路，使用真实库的**隔离副本**补出 A/B/digest 条件；只修改副本中的提醒控制字段和一条 outbox，不改真实台账。
- 通过实际 `runReminderForOwner` 业务逻辑发送 **1 封**到 `1191240794@qq.com`，并在该 QQ 收件箱按主题核验到收件。
- 同一批次再次触发返回 `reused: true`，未发送第二封，delivery 数量保持 1。
- 另用 outbox 模式验证“新进展在下一业务日形成新批次”，未再发真实邮件。

## 当前真实候选（只读）

| 类型 | 结果 |
|---|---:|
| A 未消费进展 | 0 |
| B 回看到期 | 0 |
| 待确认总数 | 28（发送时） |
| digest 是否到期 | 否（上次 2026-10-22） |
| 当前偏好 | mode=all，daily，阈值 14 天，阶段回看 7 天 |

因此不能把这次真实发送宣称为“当前真实台账已有候选”；候选是隔离副本的边界样本。

清理后复查（只读）：A=0、B=0、digest due=false、待确认总数=6；仍无真实候选。

## 真实发送

| 项目 | 值 |
|---|---|
| 收件人 | `1191240794@qq.com` |
| 主题 | `【帮你理】拼多多·产品管培生（广东省） 有进展 · 1 条该回看了 · 28 条待确认（2026-10-31收到）` |
| 批次 | `batch_OePiK7gUoDI2F-7m` |
| 业务日期 | 2026-11-01 |
| 发送时间（UTC） | 2026-11-01T05:36:57Z |
| SMTP 受理时间（UTC） | 2026-11-01T05:36:59Z |
| SMTP 结果 | accepted；transport=smtp |
| SMTP message id | `<2218529f-62ec-fc6f-b7a7-846cf8b92605@qq.com>` |
| delivery | `delivery_h77Jp9zsBfJVu42I`，status=accepted |
| 收件箱核验 | IMAP INBOX UID 2871，主题一致，日期 2026-11-01T05:36:57Z，From 1191240794@qq.com |
| 模板版本 | reminder v1 / progress_item v1 / review_item v1 / digest_item v1 |
| 批次内容 | A=1，B=1，待确认 digest=28 |

### 内容检查

用同一套 `buildReminderCandidates` + `renderReminderMessage` 预渲染并核对：

- 主题、公司、岗位、状态、日期、摘要均来自副本记录；
- 没有 `{{变量}}`、`undefined`、`null` 占位；
- A 卡包含真实拼多多岗位详情链接、台账详情链接；
- B 卡包含真实小红书岗位详情链接、确认链接和台账详情链接；
- digest 含 28 条当时的待确认摘要及处理入口；
- 实际收件箱主题与批次主题完全一致。

实际收件 MIME 为 `multipart/alternative`，text/html 两个 part；抽取到 8 个 URL（拼多多/小红书真实岗位详情、台账详情、待确认入口、设置入口、真实 review token）。未出现 `undefined`、`null`、`{{`、`}}`、`preview-token`。

发送时 digest 中仍有历史无效待确认（本次清理前），因此这封测试邮件的 28 条是**发送当时**的真实状态；清理后待确认已降到 6 条，下一次提醒不会包含已清理项。

## 去重

在同一副本、同一天的同一 `channel=email` 再次调用：

```json
{
  "status": "sent",
  "reused": true,
  "batch_id": "batch_OePiK7gUoDI2F-7m"
}
```

发送前 delivery=1、batch=5；发送后仍为 1、5。没有生成第二封邮件。

## 新进展区分

在副本中新增 2026-11-02 的新 outbox（A 类），使用 `MAIL_MODE=outbox`（不真实外发）：

- A 候选=1，B=0；
- 创建新批次 `batch_L4sRoSxXNzPZb_R4`；
- 新主题 `【帮你理】拼多多·产品管培生（广东省） 有进展（2026-11-02收到）`；
- delivery transport=outbox，status=outbox_written。

这说明“新进展形成新批次”与“同批次重复触发复用旧批次”是两条不同路径；没有拿重复旧进展冒充新提醒。

## 收件箱外的边界

- 已确认 SMTP accepted，并在 QQ INBOX 找到同主题邮件；没有只凭 SMTP 返回值宣称送达。
- 无法读取用户邮件正文/打开行为；只验证了主题、From、日期和消息 UID。
- 只向 `1191240794@qq.com` 发送了一封真实测试邮件；没有向其他用户发送。
- 测试副本路径：`.tmp/reminder-real`；真实库未因这次提醒测试改变。

## 配置与证据

- 发信配置来自 `.env` 的 SMTP_URL/MAIL_FROM；服务端密钥未写入文档。
- 发送记录：`.tmp/reminder-real/report.log`、`.tmp/reminder-real/dedupe.json`、`.tmp/reminder-real/new-progress.json`。
