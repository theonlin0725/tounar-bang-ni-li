# 招聘邮件大模型泛化识别、状态自动更新与待确认去重开发方案

**日期**：2026-11-21  
**适用仓库**：`tounar-bang-ni-li`  
**核心目标**：提升招聘邮件识别的**泛化性**、**实体准确度**与**状态自动更新能力**，确保大模型已自动确认入账的岗位不再重复出现在「待确认」中，并在不破坏任何既有功能的前提下通过全量回归测试。

## 1. 现状问题与代码根因

结合真实 QQ 邮箱同步结果与当前代码实现，定位到 5 类核心问题：

| 现象 | 代码根因 | 涉及文件 |
|---|---|---|
| 出现 `帮你理`、`Tounar` 两条错误记录 | 自身产品发送的提醒/验证码/测试邮件包含“面试/申请/进展”等词，缺少自发邮件黑名单，被自己抓回台账 | `server/src/modules/data-capture/mail/parser.js`、`sync.js` |
| 出现 `95555`、`recruitment` 等错误公司名 | `extractMailFields` / `cleanMailEntity` 未拦截纯数字发件人和通用招聘角色词，且未优先结合正文抬头/落款识别真实雇主（如 `95555` 实际为招商银行） | `server/src/modules/data-capture/mail/parser.js`、`server/src/domain/mailMatching.js`、`server/src/modules/recruitment-intake/llm.js` |
| 出现 `2027欧莱雅中国管理培训生` + `岗位名称待核对` | 主题方括号内容被整段写入 `company_name`，未拆出「批次 + 公司 + 岗位」，导致 `job_title` 为空 | `server/src/modules/data-capture/mail/parser.js`、`server/src/modules/recruitment-intake/llm.js` |
| 识别出的邮件类型太少、大量招聘邮件漏掉 | 入口 `isRecruitmentHeader` 的关键词和 ATS 域名覆盖过窄（许多银行/国企/外企/ATS 邮件连正文都不会下载）；同时本地常以离线窄规则模式运行，未充分发挥大模型语义泛化能力 | `server/src/modules/data-capture/mail/sync.js`、`parser.js`、`server/src/config.js` |
| 大模型已自动确认进「投递明细」，但仍出现在「待确认」 | `workflow.js` 与 `recordConfirmedMail` 自动新建/更新台账后，没有关闭同一事件或同岗位同阶段（及更早阶段）的 `open` 状态 `review_items` | `server/src/modules/recruitment-intake/workflow.js`、`server/src/domain/applications.js` |

## 2. 核心设计方案

### 2.1 模块 A：高召回抓取与噪声硬过滤（`parser.js`、`sync.js`）

1. **自身产品与非招聘噪声硬拦截（入口最先执行）**
   - 新增 `isSelfOrNoiseMail({ subject, fromAddress, fromName, bodyText })`：
     - 拦截发件人或主题命中自身产品特征的邮件：`tounar.local`、`MAIL_FROM`、发件人/主题含 `帮你理` 或 `Tounar` 且属于登录验证码、提醒汇总、本地测试信。
     - 拦截明确非招聘邮件：账单、发票、快递物流、银行消费/还款通知、验证码、纯营销退订（除非同时包含强招聘短语，如面试邀请、笔试通知、录用通知、网申进度）。
2. **扩大招聘邮件召回范围**
   - 扩充 `RECRUITMENT_DOMAIN_HINTS` 与常见 ATS / 测评平台域名：`mokahr.com`、`beisen.com`、`italent.cn`、`hotjob.cn`、`workday.com`、`myworkdayjobs.com`、`greenhouse.io`、`lever.co`、`ashbyhq.com`、`smartrecruiters.com`、`shl.com`、`acmcoder.com`、`hackerrank.com`、`codility.com`、`hirevue.com`、`nowcoder.com`、`cmbchina.com` 等。
   - 扩充中英文标题/发件人线索词：`网申`、`校招`、`秋招`、`春招`、`实习`、`管培`、`笔试`、`测评`、`行测`、`机试`、`AI面`、`一面`、`二面`、`终面`、`群面`、`复试`、`面试`、`资格审查`、`谈薪`、`意向`、`录用`、`背调`、`体检`、`感谢信`、`人才库`、`Next steps`、`Coding Challenge`、`Superday`、`Assessment`、`Interview`、`Offer`。
3. **正文保留首尾结构，避免截断落款公司名**
   - `stripHtml` 保留表格与换行结构，确保银行/国企 HTML 表格里的“应聘岗位/批次/志愿”不被粘连破坏。
   - 传给大模型的 `body_text` 改为 **首部 4500 字 + 尾部落款 1500 字** 拼接（总长 ≤ 6000 字），防止长邮件把底部署名/落款中的真实雇主名截掉。
   - `stripMailBoilerplate` 只剥离免责声明与退订行，不删除底部企业署名与落款。

### 2.2 模块 B：大模型标题+正文联合识别与实体清洗规则（`llm.js`、`flash.js`、`parser.js`、`mailMatching.js`）

1. **升级大模型抽取 Prompt 与字段契约（`llm.js`）**
   - **主次依据**：要求模型以「完整正文（抬头、表格、主体、落款）+ 邮件标题」为第一依据，`from_name` 和 `from_domain` 仅作辅助佐证，**不得盲从 `rule_extracted` 中的脏值**。
   - **公司名提取规范**：
     - 输出真实雇主品牌/公司名，剥离年份批次（如 `2027`、`2027届`）、招聘后缀（`校园招聘`、`校招组`、`HR团队`）和岗位词；
     - 严禁输出纯数字（如 `95555`）、通用邮箱/角色词（`recruitment`、`careers`、`campus`、`hr`、`noreply`）、自身产品名（`帮你理`、`Tounar`）、以及代发 ATS/测评平台名（北森、Moka、牛客、赛码、SHL、HireVue）；
     - 遇到纯数字发件人或代发平台时，必须结合正文抬头与落款识别真实雇主（例如发件人 `95555` + 正文“招商银行” → `company_name: "招商银行"`）。
   - **岗位/批次/城市/时间拆分规范**：
     - 标题或正文将批次、公司、岗位连写时必须拆解（例如 `2027欧莱雅中国管理培训生` → `company_name: "欧莱雅中国"`、`job_title: "管理培训生"`、`recruitment_batch: "2027"`）；
     - 优先从正文表格、第一志愿/投递岗位、书名号/引号/括号、管培生/实习生项目名中提取纯岗位名，剥离阶段词（如“在线测评通知”“一面邀请”）；
     - 同步抽取 `location`（工作城市）、`round_label`（如 `一面`、`二面`、`终面`、`HR面`、`行测`、`专业笔试`）、`interview_scheduled_at`（明确预约时间 ISO 8601）、`deadline_at`（测评/笔试截止时间 ISO 8601）。
   - **非进展判别规范**：广告推广、宣讲会、开放日、流程科普、系统自身通知、历史转发线程一律判 `is_recruitment: false` 或 `content_role != "actual_progress"`。
2. **服务端确定性实体校验与兜底护栏（`parser.js`、`mailMatching.js`、`workflow.js`）**
   - 强化 `cleanMailEntity` 校验，大模型输出与规则输出统一过同一套护栏：
     - 拒绝纯数字或纯符号（`/^\d+$/`）、通用角色词（`recruitment`、`careers`、`campus`、`talent`、`zhaopin`、`hr`、`noreply`、`admin`、`service`、`通知`、`招聘`）、自身产品名（`帮你理`、`tounar`）、纯 ATS/测评平台名；
     - 新增 `splitCompositeEntity`：当公司名仍粘连年份批次（如 `^20\d{2}届?`）或岗位后缀（如 `管理培训生`、`管培生`、`实习生`、`工程师`、`产品经理`）且 `job_title` 为空时，自动拆分并补填 `recruitment_batch` 与 `job_title`；
     - 扩展 `mailMatching.js` 高频企业域名/别名映射（例如 `95555.com` / `cmbchina.com` → `招商银行`），并保持“正文明确雇主优先于域名推断”。
   - 校验不通过的脏公司名禁止自动写入「投递明细」。

### 2.3 模块 C：泛化状态自动更新规则与前端同步输出（`workflow.js`、`applications.js`、`web/assets/js/`）

1. **全流程 6 态映射矩阵**

| 标准状态 | 覆盖的真实招聘邮件信号 | 附加结构化字段 |
|---|---|---|
| `applied` | 投递成功、网申提交、简历已收到、志愿确认、初审/资格审查通过 | `applied_at`、`applied_at_precision` |
| `assessment` | 行测、性格测试、认知测评、在线测评、笔试、机试、编程测试、AI 视频测评 | `round_label`、`deadline_at`、`stage_received_at`、`stage_anchor_at` |
| `interview` | AI面、初面、一面、二面、三面、群面、复试、终面、HR面、面试预约/改期/提醒；体检/背调通知（未明确录用时） | `round_label`、`interview_scheduled_at`、`stage_received_at`、`stage_anchor_at` |
| `offer` | 录用意向书、正式录用通知、Offer Letter、谈薪确认录用 | `last_status_changed_at`、`last_progress_at` |
| `rejected` | 明确未通过、暂不匹配、遗憾止步、感谢信、转入人才库（严格排除面试改期“时间不合适”等误判） | `last_status_changed_at`、`last_progress_at` |
| `closed` | 岗位关闭、申请撤回、流程取消 | `last_status_changed_at`、`last_progress_at` |

2. **状态自动推进与字段升级规则**
   - **向前推进自动更新**：按 `pending(0) < applied(1) < assessment(2) < interview(3) < offer/rejected/closed(4)` 自动推进；同阶段内轮次升级（如 `一面 → 二面`）或面试改期，自动更新 `round_label`、`interview_scheduled_at`、`stage_anchor_at`、`last_progress_at`。
   - **迟到/乱序邮件保护**：邮件证据时间早于当前进展时间且阶段更靠前（如先扫到面试、后扫到旧的“投递成功”）时，**不回退状态**，仅补齐缺失基础字段（`applied_at`、`job_title`、`location`、`recruitment_batch`）。
   - **低置信度占位字段自动升级**：已有记录的 `job_title` 置信度为 `low`（如 `待补充岗位`、`2027届校招（待补充岗位）`）或为空时，后续邮件/大模型识别出真实岗位名、城市、批次后自动覆盖升级；**用户 `manual` 手动编辑的字段和状态仍严格保护不被覆盖**。
   - **终态和平降级**：已有终态与新邮件同态则幂等忽略，异态或未开启自动终态时和平转入「待确认」，绝不抛错中断整轮同步。
3. **前端实时输出与刷新**
   - 核对 `/api/v1/applications` 投影字段，确保 `status`、`status_label`、`round_label`、`interview_scheduled_at`、`deadline_at`、`stage_received_at`、`last_progress_at`、`location`、`recruitment_batch` 完整返回。
   - 前端在邮箱同步完成后自动重新拉取「投递明细」列表和「待确认」角标计数，立即可见最新状态、轮次/时间锚点和更新来源；仅对真正无岗位名的公司级邮件显示待补充占位提示，后续邮件补全后自动刷新为真实岗位名。

### 2.4 模块 D：自动入账与「待确认」严格互斥机制（`applications.js`、`workflow.js`）

1. **新增统一收口函数 `resolveSupersededReviews(ownerId, app, event)`**
   - 在 `workflow.js`（AI 自动新建/更新/无变更确认）与 `applications.js`（`recordConfirmedMail`、`processMailEvent` 自动新建/更新）成功写入后统一调用：
     - **同事件必关**：将 `source_event_id = event.id` 且 `status = 'open'` 的所有 `review_items` 标记为 `resolved`（`resolution_json` 记录 `reason: 'auto_applied'` 与 `application_id`）。
     - **同岗位已覆盖必关**：查找同一 `owner_id` 下 `status = 'open'` 的邮件类 `review_items`，若其 `suggested_changes_json` 中的公司+岗位与当前 `app` 匹配（或同公司唯一活跃记录且待确认项无岗位名），且其建议阶段不高于当前 `app.status`，自动标记为 `resolved`（`reason: 'superseded_by_auto_ledger'`、`application_id: app.id`）。
   - 同步更新 `mail_messages.processing_state = 'applied'`，保证同一岗位不会同时出现在「投递明细」和「待确认」中。
2. **存量脏数据与重复待确认清理脚本（幂等、默认只预览）**
   - 新增一次性维护脚本（默认 `--dry-run` 预览，显式 `--apply` 执行）：
     - 自动关闭已被台账覆盖的冗余 `open` `review_items`；
     - 识别并支持归档历史脏规则误建的 `Tounar`、`帮你理`、`recruitment`、`95555` 等邮件来源记录（严格跳过所有 `manual` 和 `plugin` 来源记录）。

## 3. 实施顺序与兼容性约束

1. **阶段 1（前置过滤与实体清洗）**：落地 `parser.js`、`mailMatching.js` 的自发邮件拦截、脏公司名校验、`splitCompositeEntity` 拆分和扩召回规则。
2. **阶段 2（大模型抽取与判断升级）**：升级 `llm.js` 与 `flash.js` 的提示词、首尾正文拼接策略、以及 `location`/`round_label`/`deadline_at`/`interview_scheduled_at` 透传与校验；确保 AI 开启时优先走大模型路径，技术失败可安全回退。
3. **阶段 3（状态更新与待确认互斥）**：落地 `resolveSupersededReviews`、低置信度占位岗位自动升级，以及前端同步完成后的明细/待确认自动刷新。
4. **兼容性红线**：
   - 不破坏插件采集、JD 匹配、简历管理、提醒调度、手动补录及人工字段保护的既有行为；
   - 绝不将真实邮件正文、邮箱账号或授权码写入仓库与提交历史。

## 4. 测试与验收清单

### 4.1 必须补充的专项单测

- **自发邮件与噪声过滤**：`帮你理` / `Tounar` 系统提醒信、登录验证码邮件直接忽略，不进明细也不进待确认。
- **发件人纠偏与正文优先**：发件人 `95555` + 正文“招商银行2027校园招聘” → 识别为 `招商银行`；发件人 `recruitment@...` + ATS 代发邮件 → 从正文识别真实雇主（绝不输出 `95555` / `recruitment`）。
- **复合标题拆分**：`2027欧莱雅中国管理培训生` → 拆为 `company_name: "欧莱雅中国"`、`job_title: "管理培训生"`、`recruitment_batch: "2027"`。
- **全状态推进与字段升级**：覆盖 `applied → assessment → interview（一面→二面/改期）→ offer / rejected / closed`，验证旧回执不回退、低置信度占位岗位可被后续邮件自动升级、人工修改字段受保护。
- **待确认自动消解**：先存在 `open` 状态待确认，随后大模型自动入账或推进同岗位，验证对应 `review_items` 自动转为 `resolved`，待确认列表中不再重复出现。

### 4.2 全量回归套件（不得引入新失败）

- 邮件重点套件：`mail.test.js`、`flash-intake.test.js`、`intake-workflow.test.js`、`phase2.test.js`、`review-intake.test.js`、`reviews.test.js`、`mail-config-default.test.js`
- 全量套件：`npm test`、`npm run test:web`、`npm run test:career-ai`、`npm run test:panel`、`npm run test:e2e`、`npm run test:netease-game`、`npm run test:intake`、`npm run test:mail-admin`、`npm run test:mail-progress`

### 4.3 4324 本地真实邮箱端到端验收

- 开启模型配置并重启 `http://127.0.0.1:4324`，对 77 封真实 QQ 邮箱执行完整同步并核验：
  1. 进度条从 0% 完整推进至 100%，无中途报错与底部残留文案；
  2. 不再生成 `Tounar`、`帮你理`、`95555`、`recruitment` 等脏公司记录，复合标题能正确拆分出公司与岗位；
  3. 识别出的岗位与最新进展状态正确显示在「投递明细」，且已自动入账的岗位不再重复出现在「待确认」中。
