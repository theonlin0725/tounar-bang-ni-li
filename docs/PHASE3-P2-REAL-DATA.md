# P2 · 真实数据验收记录（2026-10-23 本机）

验收副本：`~/tounar-acceptance/20261023-133740`（outbox）与 `~/tounar-acceptance/20261023-133758`（smtp）
真实原库：`~/Desktop/opencode project/帮你理/data/tounar.sqlite` —— **全程只读，一次都没写入**。
备份：`~/tounar-backups/20261023-211901/`（SQLite backup API，integrity ok，含 `master.key`/`internal-tick.token`/`.env`，权限 700）

## 1. 数据量与迁移

| 项 | 原库（直读） | 验收副本启动后 |
|---|---|---|
| 用户 | 2 | 2 |
| 台账 | 6 | 6 |
| 邮件 | 84 | 84 |
| 待确认 | 20 | 20 |
| `review_items.source_mail_id` | 0/20 | 16/20 |

- 原库的 `source_mail_id` 列存在但**全空**（另一版迁移只加了列没回填）；二期启动时的增量迁移把 16 条能对上的回填了，4 条本来就没有对应邮件。这是预期行为，不是数据丢失。
- 迁移幂等：同一副本连续重启两次，`applications/mail_messages/review_items/events` = `8/84/20/31`，两次完全一致。

## 2. 20 条待确认

逐条明细见 [review-decisions.md](acceptance/phase3/review-decisions.md)，原始 JSON 在 [review-acceptance.json](acceptance/phase3/review-acceptance.json)。

本轮在副本上实际执行了 4 条（验证链路，都带 `【验收】` 标记或明确记录）：

| 动作 | 结果 |
|---|---|
| 按邮件新建 ×2 | 200；投递时间按原信日期推断为 `inferred_before`；台账 6→8 |
| 关联已有台账 ×1 | 200；写入了历史（但见下方“发现 3”） |
| 忽略 + 10 秒内撤销 + 再次忽略 | 全部 200，记录最终 dismissed |
| 过期版本提交 | **409 VERSION_CONFLICT**（符合预期） |
| 计数变化 | 待确认 20→16，台账 6→8 |

**没有替你判断归属**：剩余 16 条都没有候选台账，需要你确认公司/岗位后再建；4 条腾讯浏览记录的唯一候选是台账里的「腾讯 / 岗位详情」「腾讯 / 首页」，而这两条本身就是脏数据。

## 3. 真实 IMAP 同步（真连 QQ 邮箱）

命令：`node --env-file=<副本>/acceptance.env server/scripts/run-mail-sync.js`
结果：`status=connected`，本次增量拉取 **4 封**，`remaining=0`，`last_uid=2835`。

| 时间 | 分类 | 处理 | 发件域名 | 主题 |
|---|---|---|---|---|
| 10-23 09:27 | assessment | 进待确认 | mail.hrtools.cn | 数字广东公司2027届校招笔试预通知 |
| 10-23 09:32 | assessment | 进待确认 | batchmail.nowcoder.net | 数字广东邀请你参加在线笔试 |
| 10-23 12:00 | **other** | **ignored** | shmail.ibeisen.com | 合合信息感谢您的应聘 |
| 10-23 12:24 | other | ignored | qq.com | 【Tounar 帮你理】登录验证码（本系统自己发的，忽略正确） |

全库分类分布：`other 69 / assessment 13 / interview 5 / application_update 1`。

**发现的误判（1 条）**：「合合信息感谢您的应聘」是典型的拒信，被分到 `other` 后直接 ignored，**不会进入待确认**。规则看起来要求“遗憾/未通过”这类词才判拒信，只有“感谢您的应聘”就漏了。这是真实的假阴性，需要你决定是补关键词还是保持保守。

## 4. 真实提醒邮件（真发到你邮箱）

副本 B 以 `MAIL_MODE=smtp` 启动，用真实 SMTP 发出，`provider_message_id=<7cd77eea-ee17-7897-bd6d-a2816792d8a5@qq.com>`，`transport=smtp`。

造数：两条 `【验收】` 面邀（面试时间 D-8 天，D+7 到期），`notification_preferences.stage_followup_days=7`。
清掉当天旧批次后强制发一次，得到 **items_b=2** 的汇总邮件。

邮件实际内容（从收件箱 IMAP 取回原始 MIME 解码，渲染图见 `acceptance/phase3/05-reminder-email.png`）：

- 主题：`【帮你理】2 条该回看了（2026-10-11收到）`
- 顶部：`收信 / 进展日期 2026-10-11`
- 一封原信一段，各自落款 `—— 2026-10-11 收到`
- 每段三个入口：直接打开申请状态页 / 我看过了，没变化（`/r/rl_…`）/ 结果出来了，去更新（`/?app=…`）
- 页脚：`推送时间：2026-10-23T13:40:23.502Z（北京时间每日 08:00 触发，当天补发）`
- 链接全部指向 `http://127.0.0.1:4312`（本轮副本端口）

### 这一轮抓到的两个真问题

1. **CLI 生成提醒链接会指错端口**：`npm run remind` 不传 `PORT/APP_BASE_URL` 时，config 默认 4310，第一封邮件的链接就写成了 `127.0.0.1:4310`。已修：`local-acceptance` 现在会在副本里写 `acceptance.env`（含 `PORT`/`APP_BASE_URL`/`DATA_DIR`/`DB_PATH`），CLI 用 `node --env-file=<副本>/acceptance.env` 跑就不会错。
2. **「面试中邀请 / 笔试中邀请」文案**：模板把状态标签直接拼上“邀请”。已修为「面试邀请 / 笔试邀请」，并加了断言 `!/面试中邀请|笔试中邀请/` 的回归测试。

## 5. 旧字段修复（只 dry-run，未 apply）

副本上执行 `repair-captured-fields.js --db <副本>/tounar.sqlite --out repair-plan.json`，命中 2 条：

| 台账 | 问题字段 | 原值 | 建议 |
|---|---|---|---|
| 腾讯 / 岗位详情 | jd_summary | “腾讯校园招聘 3 首页 青云计划 … 法律信息 服务协议” | 置空（导航/页脚文字） |
| 腾讯 / 首页 | job_title | “首页” | 置空 |
| 腾讯 / 首页 | jd_summary | “腾讯校园招聘 … 2027应届生招聘 …” | 置空 |

计划文件在副本目录里（私有）。**原库没有 apply**，等你确认。

## 6. 发现的问题清单（按严重度）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| 1 | “感谢您的应聘”类拒信漏判为 other，直接 ignored | 本次真实同步 | 补拒信关键词，或把“感谢应聘”也送待确认 |
| 2 | CLI 跑提醒时链接端口错误 | 第一封真实邮件 | 已修（acceptance.env） |
| 3 | 关联操作写了两条 `pending → pending` 历史 | `app_RJ0CfVWVNS1Y0Tvk` | 无变化的关联可以只留一条审计，不必写历史噪声 |
| 4 | 「面试中邀请」文案 | 真实邮件 | 已修 |
| 5 | 台账里「腾讯/岗位详情」「腾讯/首页」是脏数据 | 修复 dry-run | 待你确认后 apply |
| 6 | 84 封里 69 封是 other，分类覆盖率偏低 | 全库分布 | 属于二期已知边界，规则分不是概率 |

## 7. 未完成

- 20 条里 16 条仍 open：需要你决定公司/岗位（我不替你编）。
- 真实 SMTP 只验证了「发得出、内容对」；**QQ 网页版/手机端的排版**还需要你亲眼确认一次（我只能渲染本地 HTML）。
- 邮件自动判定（高把握自动改台账）在这批邮件里没有触发过：4 封里 2 封进待确认、2 封 ignored，没有一条达到 0.9 自动更新阈值。样本太小，不能下结论。
