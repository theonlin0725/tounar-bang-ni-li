# 邮件状态识别与自动入台账完善交付记录

基线：`bd57d3e`。本单候选提交见当前 `HEAD`。

## 1. 同公司归属修复（D1）

`server/src/domain/mailMatching.js`：

- 有明确岗位名但同公司没有相似岗位时，返回 `new_job_same_company`（target null、非歧义），由上游自动新建。
- 无岗位名时：
  - 同公司未终态记录恰好 1 条 → `single_active_company`，允许原地推进；
  - ≥2 条 → 才进入待确认，并返回候选；
  - 0 条 → target null、非歧义。
- `findProgressCandidates` 对 mail 的“已知新岗位”不再误匹配同公司其他岗位。
- 网易招聘域补充 `campus.163.com`、`hr.163.com`，公共邮箱域仍不会被当公司。

## 2. 邮件解析与强规则（D2）

`server/src/modules/data-capture/mail/parser.js`：

- 新增 `stripMailBoilerplate`，剥离自动发送/请勿回复/如您取消/招聘流程等页脚，避免免责声明误杀正文。
- 公司提取优先级：正文键值对 → 自然语言感谢应聘 → 主题【公司】/分隔符 → 发件人显示名 → 企业域名映射；排除公共邮箱和占位词。
- 岗位提取补充：
  - `您应聘的「游戏策划」岗位`
  - 自然语言“应聘/申请……岗位/职位”
  - 主题“岗位 + 在线测评/笔试/面试通知”
  - 清理批次词和阶段词。
- 状态覆盖：
  - assessment：测评邀请、在线测评通知、笔试安排、请于…完成测评等；
  - interview：面试邀请/安排/时间确认/轮次；
  - applied：投递成功/简历已收到/申请已提交；
  - offer/rejected/closed 的明确措辞。
- 公司级无岗位名测评/面试邮件返回：
  `company_only_progress: true, title_inferred: true`。
- 发件人 `from.name` 与域名已透传给 `from_name`/`from_domain`。

## 3. 自动新建/推进（D3、D4）

`server/src/domain/applications.js`：

- 新增 `single_active_company` 冲突豁免，直接推进唯一活跃记录。
- 0 候选且明确公司 + 岗位 + 状态时自动创建投递明细。
- 无岗位但公司级统一测评/面试可创建“`2027届校招（待补充岗位）`”或“`待补充岗位`”，岗位字段来源标为：
  `mail / low / mail_company_only`。
- `processMailEvent` 离线兜底也支持 0 候选自动建账，不再一律 `STAGE_SPLIT_REQUIRED`。
- 同状态、旧邮件、人工修改、终态冲突保护保留。

`server/src/modules/recruitment-intake/workflow.js`：

- 公司级无岗位邮件在 AI 路径下也允许建账（仅 applied/assessment/interview，且达到进度阈值）。
- 确定向前推进状态即使模型返回 `newness: uncertain`，在证据时间不早于当前记录时放行。
- 发件人显示名 `from_name` 透传给抽取器。
- 建账后写入低置信度岗位来源，后续插件或含岗位名的邮件可用更高置信度覆盖。

## 4. 阶段时间（D6）

`applyStatusTransition` 在推进到 assessment/interview 时写入：

- `stage_received_at`：邮件证据时间/收信时间；
- `stage_anchor_at`：面试时取收信时间与实际预约时间的较晚值。

## 5. 场景测试

`mail.test.js`、`flash-intake.test.js` 新增：

- S1 网易测评无台账：正文含“如您已取消应聘请忽略”页脚，仍识别公司/岗位/测评，自动新建；
- S2 公司级无岗位：自动创建“2027届校招（待补充岗位）”，岗位来源 low；
- S3 台账唯一 pending 同公司记录：原地升级为 assessment，写 has_applied 和阶段时间；
- S4 同公司已有其他岗位、新岗位来测评：返回 `new_job_same_company`，不误判歧义；
- S5 同公司两个未终态岗位、无岗位名：仍进待确认；
- S6 阶段推进、旧回执、人工终态保护由现有 phase/reviews 测试继续覆盖；
- 相似岗位名不再因严格标题不等误报冲突；
- 历史待确认回填强规则入账并关闭 review。

## 6. 回归结果

| 套件 | 结果 |
|---|---:|
| 邮件重点套件（mail / flash / intake / phase2 / review / reviews / config） | **78/78** |
| `npm test` | **212/213**；仅既有云快照 `加密云快照…损坏与冲突拒绝` 失败 |
| `npm run test:web` | **70/70** |
| `npm run test:career-ai` | **51/51** |
| `npm run test:panel` | **8/8** |
| `npm run test:e2e` | **67/67** |
| `npm run test:netease-game` | **60/60** |
| `npm run test:intake` | **10/10** |
| `npm run test:mail-admin` | 通过 |
| `npm run test:mail-progress` | **6/6** |

## 7. 未完成 / 外部条件

- 没有真实 QQ/163 客户端授权码；T5 真实 IMAP/SMTP 联调未完成。当前验证的是解析、路由、强规则、隔离落库和固定进度 UI，不能宣称真实邮箱链路通过。
- 网易真实 `ID` 握手仍需真实 163/126/yeah.net 账号复核；代码已发送 `clientInfo`。
- `plugin-access`、`plugin-web-first`、`plugin-manual-pairing` 在当前 Playwright Chromium 中仍因扩展 service worker 无法启动而超时。
- 未把真实邮件正文、授权码或账号凭据写入仓库。
