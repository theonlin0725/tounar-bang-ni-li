# 邮件状态识别与自动入台账完善方案（基于 `bd57d3e` 审查）

**审查日期**：2026-11-21  
**代码基线**：`bd57d3e`（`feat: 统一招聘邮箱抓取、自动入账与实时进度`）  
**核心目标**：当用户收到真实招聘邮件（例如“投递了网易，收到网易测评通知，但台账里尚无该记录或仅在看过没投”）时，系统能够可靠识别**公司名、岗位名、当前投递状态**，并按“收到测评/面试/Offer/拒信 ⇒ 必然已投递”的业务规则，**自动新建或推进到「投递明细」台账**（如直接建账并置为 `assessment` / 笔试测评），大幅减少误落「待确认」。

---

## 1. 现状代码审查：为什么真实邮件仍难自动进台账？

经逐行审查 `bd57d3e` 中的 `parser.js`、`sync.js`、`mailMatching.js`、`applications.js`、`workflow.js`、`llm.js`，当前“抓得到邮件但自动判状态入台账不完整”由以下 **6 个具体代码缺陷** 导致：

| 编号 | 所在位置 | 具体缺陷 | 实际后果（以“网易测评”为例） |
|---|---|---|---|
| **D1** | `server/src/domain/mailMatching.js` (`resolveMailApplication` L96–102) | 当用户台账里已有“同公司其他岗位”（如“看过没投”里浏览过「网易 · 游戏策划」），而邮件是同公司新岗位「网易 · 产品经理」时，`sameJob` 为空后会 fallthrough 返回 `ambiguous: true, reason: 'company_only'`。 | 即使邮件写清了公司+岗位+测评，`recordConfirmedMail` 和 `workflow.js` 都会拦截建账，并错误提示“只识别到公司名”。 |
| **D2** | `server/src/modules/data-capture/mail/parser.js` (`confirmedMailProgress` L154–172) | ① 全文排除正则包含 `取消 / 尚未 / 招聘流程 / 如您 / 若您`，极易被真实 HR 邮件页脚免责声明误杀；② 仅认 `公司：` 或句首 `^【公司】`，未使用发件人显示名 `from.name` 与域名 `companyIdentity`；③ 岗位仅认 `岗位：` 或严格结尾 `测评邀请$`，无法识别中文自然语言（如 `您应聘的「游戏策划」岗位`、`在线测评通知`）；④ 仅覆盖 3 种状态，拦截 `offer / rejected / closed`。 | 绝大多数真实企业测评/面试邮件直接返回 `null`，无法命中自动入账快路径。 |
| **D3** | `server/src/domain/applications.js` (`processMailEvent` L885–908) | 未配置 AI 或快路径未命中时落入 `processMailEvent`，但该函数在 `candidates.length === 0` 时仍一律进待确认（有 `stage` 时甚至误报 `STAGE_SPLIT_REQUIRED`），**从未支持 0 候选自动建账**。 | 台账中没有的网易岗位收到测评邮件，直接被丢进待确认。 |
| **D4** | `server/src/domain/mailMatching.js` + `server/src/modules/recruitment-intake/workflow.js` (L400) | 校招常见“公司级统一测评邮件”（如 `【网易】2027届校招线上测评通知`，有明确公司和测评状态，但邮件里没写具体岗位名）：无论台账有 0 条还是恰好 1 条网易记录，一律被拒入台账（`AI_COMPANY_ONLY` / `AI_IDENTITY_INSUFFICIENT`）。 | 真实校招测评邮件大量落入待确认，用户被迫手工录入。 |
| **D5** | `server/src/modules/data-capture/mail/sync.js` + `server/src/modules/recruitment-intake/llm.js` + `workflow.js` (L379) | ① `sync.js` 解析出的发件人显示名 `from.name`（如 `网易校园招聘`）从未存入 `payload` 或传给模型；② `workflow.js` 当模型保守输出 `newness: 'uncertain'` 时，即便目标处于 `pending/applied` 且新邮件是更晚的 `assessment`，也仍拦截进 `AI_NEWNESS_UNCERTAIN`。 | AI 路径下缺少发件人公司线索，且对明确的向前阶段推进过于保守。 |
| **D6** | `server/src/domain/applications.js` (`applyStatusTransition` L369–376) | 已有记录从 `pending / applied` 自动更新到 `assessment / interview` 时，未同步写入 `stage_received_at` 和 `stage_anchor_at`。 | 自动升入测评/面试的记录缺少阶段收件时间，影响阶段回看提醒与排序。 |

---

## 2. 端到端业务规则：从邮件到台账的完整判断逻辑

以用户的核心场景为例：**“投递了网易，收到网易发来的测评邮件，但台账里没有（或仅在看过没投）”**。系统统一按以下 4 条核心业务公理自动运转：

1. **进展蕴含投递公理**：收到某公司发出的明确 `assessment`（测评/笔试）、`interview`（面试）、`offer`（录用）或 `rejected`（拒信）通知，即确证用户**已投递该岗位**（`has_applied = 1`，`applied_at = 邮件收件时间`，`applied_at_precision = 'inferred_before'`），记录直接进入**「投递明细」**而非停留在「看过没投」。
2. **状态单调推进公理**：同一岗位按阶段顺序 `pending(0) < applied(1) < assessment(2) < interview(3) < offer/rejected(4) < closed(5)` 自动向前推进；若原记录在「看过没投（`pending`）」，收到测评邮件后自动升级为 `has_applied = 1, status = 'assessment'` 并移入「投递明细」。
3. **三档归属决策公理（先匹配、再新建、真歧义才待确认）**：
   - **唯一命中已有记录** → 原地推进状态、补全缺失字段、写 `mail` 变更历史；
   - **台账无对应岗位记录** → 自动新建一条投递明细记录（写入公司名、岗位名、收件日期、当前状态、`channel = '邮件'`）；
   - **真正歧义/冲突**（同公司存在 ≥2 条未终态岗位且邮件未写明岗位名、字段与原文冲突、终态冲突）→ 进入「待确认」。
4. **安全保护红线不变**：人工修改时间晚于邮件时间不覆盖；旧邮件/迟到投递回执不回退更高阶段；终态（`offer / rejected / closed`）不被不同阶段静默覆盖；重复同步或催促提醒幂等不重复建账。

---

## 3. 具体代码修改方案（按文件落点）

### 3.1 修复同公司新岗位被误拦 + 支持单活跃公司匹配（`server/src/domain/mailMatching.js`）
改动 `resolveMailApplication(ownerId, fields)`：

1. **有明确 `job_title` 但 `sameJob.length === 0` 时，不再误报 `company_only`**：
   - 当前 L96–102 把 `sameJob.length === 0`（台账有同公司其他岗位，但没有当前岗位）直接返回 `ambiguous: true, reason: 'company_only'`。
   - **修改为**：
     - 如果 `fields.job_title` 非空且 `sameJob.length === 0`，说明这是**同公司的一个新岗位**（例如台账只有「网易 · 游戏策划」，邮件是「网易 · 产品经理」），返回：
       ```js
       return { target: null, candidates: [], ambiguous: false, reason: 'new_job_same_company' };
       ```
       让上游自动为其新建投递明细！
     - 只有当 `!fields.job_title`（邮件确实没写岗位名）时，才按以下规则处理 `sameCompany`：
       - `sameCompany` 中未终态记录（`!TERMINAL.has(a.status)`）**恰好 1 条** → 返回 `{ target: active[0], candidates: [asCandidate(active[0], 'single_active_company', 0.85)], ambiguous: false, reason: 'single_active_company' }`，允许自动推进这条唯一活跃记录（如把「看过没投」里的网易岗位自动推进为「笔试/测评」）。
       - `sameCompany` 中未终态记录 **≥ 2 条** → 返回 `{ target: null, candidates: active.map(...), ambiguous: true, reason: 'company_only' }`，进入「待确认」让用户选择归属哪一条。
       - `sameCompany` 中 **0 条** → 返回 `{ target: null, candidates: [], ambiguous: false, reason: 'none' }`。
2. **扩充 `COMPANIES` 常用招聘域与别名**：保留公共邮箱域名（`qq.com / 163.com / 126.com / yeah.net` 等）绝不作为公司证据的保护，同时确保 `service.netease.com`、`corp.netease.com`、`netease.com`、`campus.163.com`、`mokahr.com`（不作公司名，仅作招聘域）等正确区分。

### 3.2 透传发件人显示名 `from_name`（`server/src/modules/data-capture/mail/sync.js`）
1. 在 `sync.js` 构造 `fields`、`payload`、`parsed` 和调用 `processIntakeEvent` 时，将 `addressFromEnvelope(message.envelope)` 提取出的 `from.name`（如 `网易校园招聘`、`字节跳动招聘`）完整透传为 `from_name`。
2. 在 `ingestMessage` 中把 `from_name` 写入 `event.payload`（脱敏、限长 80 字，不存邮箱全文）。

### 3.3 重构邮件解析与强规则提取（`server/src/modules/data-capture/mail/parser.js`）
目标：让不依赖 AI 的规则层也能准确识别真实中文/英文企业招聘邮件。

1. **正文预处理：剥离页脚免责区，避免误杀**
   - 新增 `stripMailBoilerplate(bodyText)`：剥离常见页脚提示行（如“此邮件由系统自动发送，请勿直接回复”、“如您已取消/放弃应聘请忽略”、“如需取消或改期请联系…”、“如您尚未…”、“招聘流程：网申→测评→面试”等静态流程图说明），**仅在正文核心内容中做否定/条件句过滤**，彻底解决真实 HR 邮件因页脚含 `取消 / 尚未 / 如您 / 招聘流程` 被全盘误杀的问题。
2. **增强公司名提取优先级（`extractMailFields` & `confirmedMailProgress`）**
   1. 正文显式键值对（`公司/公司名称/企业名称/招聘单位：`）
   2. 主题方括号/中括号前缀（`【网易】`、`【网易雷火】`、`[网易]`）或分隔符前缀（`网易 · 游戏策划`、`网易2027届校招-产品经理`）
   3. 发件人显示名 `fromName` 清洗（如 `网易校园招聘` → `网易`，`腾讯校招团队` → `腾讯`）
   4. 正文自然语言句式（`感谢您应聘/投递【?([^】「」《》\s]{2,16})】?`、`欢迎加入([^，,。！!]{2,16})`）
   5. 发件人企业域名映射 `companyIdentity('', fromDomain)`（如 `campus@service.netease.com` → `网易`，自动排除公共邮箱域与第三方 ATS 域如 `beisen.com / mokahr.com / nowcoder.com`）
3. **增强岗位名提取（支持中文自然语言句式）**
   - 在现有 `应聘岗位：xxx` 基础上，新增匹配：
     - `您(?:应聘|投递|申请)(?:的)?(?:[^「《【“\n]{0,12})?[「《【“]([^」》】”\n]{2,40})[」》】”](?:岗位|职位)?`
     - `您(?:应聘|投递|申请)(?:的)?([^\n，,。；;]{2,30}?)(?:岗位|职位)`
     - 主题模式：`^【[^】]+】(?:20\d{2}届?(?:校园招聘|校招|春招|秋招|社招)?[-—·\s]*)?(.{2,36}?)[-—·｜|\s]*(?:在线)?(?:测评|笔试|面试|录用|投递)(?:邀请|通知|安排|结果|成功)`
   - 清洗掉岗位名中的批次词（`2027届校招`）和阶段词（`在线测评通知`），并过 `cleanMailEntity(..., { title: true })`。
4. **扩充状态识别规则（覆盖真实 HR 措辞）**
   - `assessment`（笔试/测评）：`测评邀请 / 笔试邀请 / 在线测评通知 / 测评通知 / 笔试通知 / 测评安排 / 笔试安排 / 测评已开启 / 进入测评环节 / 请于.{0,20}完成.{0,10}(?:测评|笔试|在线考试) / online assessment / written test`
   - `interview`（面试）：`面试邀请 / 面试通知 / 面试安排 / 面试时间确认 / 邀请.{0,12}(?:一面|二面|三面|初试|复试|终面|HR面|面试) / invitation to interview`
   - `applied`（已投递）：`投递成功 / 申请成功 / 已收到您的简历 / 简历已收到 / 申请已提交 / application submitted`
   - `offer`（录用，仅在明确无否定词时命中）：`正式录用 / 录用通知 / 录用意向书 / offer letter`
   - `rejected`（拒绝，需显式否定词，不含仅“感谢应聘”）：`很遗憾.{0,20}(?:未通过|不合适|未能|遗憾) / 未通过(?:本次)?(?:筛选|简历|测评|笔试|面试) / 进入人才库 / unfortunately.{0,30}not selected`
5. **公司级无岗位名测评邮件支持（返回结构化标记 `title_inferred: true`）**：
   - 当识别到**明确公司名** + **明确 `assessment / interview / applied` 状态**，但邮件正文和标题确实未写具体岗位名时（如“【网易】2027届校招线上测评通知”），`confirmedMailProgress` 不再直接返回 `null` 丢弃，而是返回 `{ company_name, job_title: null, recruitment_batch, status, company_only_progress: true }`，交由下游 `recordConfirmedMail` 按“单活跃匹配 / 无记录自动建账（岗位记为 `待补充岗位` 或 `2027届校招（待补充）`）/ 多岗歧义进待确认”统一决策。

### 3.4 完善自动入账与阶段时间更新（`server/src/domain/applications.js`）
1. **完善 `recordConfirmedMail(event, facts)`**：
   - 当 `target` 为空（0 候选）且 `!match.ambiguous` 时：
     - 若 `facts.company_name && facts.job_title && facts.status` → 直接 `createApplication`（`has_applied = 1`，`status = facts.status`，`applied_at = event.occurred_at`，`applied_at_precision = 'inferred_before'`，`channel = '邮件'`）。
     - 若 `facts.company_name && !facts.job_title && facts.company_only_progress`（公司级统一测评/面试邮件，且台账中该公司尚无任何记录）→ 直接 `createApplication`，`job_title` 填 `facts.recruitment_batch ? `${facts.recruitment_batch}（待补充岗位）` : '待补充岗位'`，并在 `application_field_sources` 将 `job_title` 标为 `confidence = 'low'`（这样后续插件采集或收到含岗位名的邮件时，`fillMissingFields` 会自动用高置信度真实岗位名覆盖，无需人工修改！）。
   - 当 `target` 存在且来自 `single_active_company`（无岗位名邮件命中该公司唯一活跃记录）时：不触发 `!similarJob` 冲突，直接推进 `target` 的状态（例如把「看过没投」里的网易岗位自动升为「笔试/测评」）。
2. **修复 `processMailEvent(event)`（离线兜底路径）**：
   - 当 `source === 'mail'`、`candidates.length === 0`、且 `fields.company_name` 有效、状态明确且置信度达标（非终态 `>= config.autoProgressConfidence`，终态 `>= config.autoTerminalConfidence`）时：
     - 先确认台账中不存在“同公司同岗位处于另一阶段”的记录（真跨阶段才报 `STAGE_SPLIT_REQUIRED`）；
     - 若确实是台账中不存在的新申请，直接自动创建投递明细（复用 `createApplication`），**彻底消除“0 候选却误报 `STAGE_SPLIT_REQUIRED` 进待确认”的问题**。
3. **修复 `applyStatusTransition` 漏写阶段时间（L369–376）**：
   - 当 `['assessment', 'interview'].includes(targetStatus)` 时，在 `updates` 中补写：
     ```js
     const stageReceived = eventEvidenceAt(event) || changedAt;
     updates.stage_received_at = stageReceived;
     updates.stage_anchor_at = maxIso(stageReceived, targetStatus === 'interview' ? parseIso(event.payload?.interview_scheduled_at) : null);
     ```

### 3.5 优化 AI 抽取与判断链路（`server/src/modules/recruitment-intake/llm.js` & `workflow.js`）
1. **`llm.js`**：
   - `extractRecruitmentSignal` 接收并传入 `from_name`（发件人显示名）。
   - 在 `SYSTEM` 提示词中明确补充两条规则：
     - 公司名可结合主题、正文落款、发件人显示名（`from_name`）及企业发件域名综合识别（公共邮箱域名除外）；
     - 收到笔试/测评/面试/录用/拒绝通知即表明用户已投递该岗位，应直接输出对应状态（`assessment / interview / offer / rejected`）。
2. **`workflow.js`**：
   - **放行确定性向前推进（修复 L379）**：当 `target` 存在、`status` 有效、且 `STATUS_RANK[status] > STATUS_RANK[target.status]` 且 `incomingAt >= targetAt` 时，不再因为 `newness === 'uncertain'` 拦截进 `AI_NEWNESS_UNCERTAIN`，直接向前推进状态。
   - **支持公司级统一测评邮件自动入账（修复 L400）**：当 `!target`、`!mailMatch?.ambiguous`、`extracted.company_name` 有效、`status` 为 `applied / assessment / interview` 且 `judged.actual_progress >= config.autoIntakeMinProgress` 时，即使 `extracted.job_title` 为空，也允许以 `待补充岗位`（低置信度可覆盖）自动建账进投递明细。
   - **执行顺序优化（`sync.js`）**：当 `config.autoIntakeEnabled` 为 `true` 时，先跑 `processIntakeEvent`（AI 抽取更全，能识别自然语言、批次、面试时间、Offer/拒信）；仅在 `processIntakeEvent` 技术失败/未启用时降级走 `confirmedMailProgress` → `recordConfirmedMail`，避免强规则跳过 AI 导致漏提批次、轮次或面试预约时间。

---

## 4. 端到端场景走查（验收基准）

| 场景 | 输入邮件示例 | 改造前结果 | 改造后预期结果 |
|---|---|---|---|
| **S1：网易测评，台账无记录（含岗位名）** | From: `网易校园招聘 <campus@service.netease.com>`；Subject: `【网易】2027届校招在线测评通知`；Body: `您好，感谢您应聘网易「游戏策划」岗位，请于11月25日前完成测评。如您已取消应聘请忽略。` | 进待确认（页脚“取消”击穿正则 + `processMailEvent` 0 候选拒建账） | **自动新建投递明细**：公司=`网易`，岗位=`游戏策划`，`has_applied=1`，状态=`assessment`（笔试/测评），投递/阶段时间=收件日期，不进待确认。 |
| **S2：网易测评，台账无记录（无岗位名）** | Subject: `【网易】2027届校招线上测评通知`；Body: `请于11月25日前完成综合素质测评`（未写具体岗位） | 进待确认（`AI_IDENTITY_INSUFFICIENT`） | **自动新建投递明细**：公司=`网易`，岗位=`2027届校招（待补充岗位）`（低置信度，后续自动可覆盖），`has_applied=1`，状态=`assessment`。 |
| **S3：网易测评，台账已有“看过没投”同公司单岗** | 台账有 `网易 · 游戏策划`（`status=pending, has_applied=0`）；收到 S2 无岗位名测评邮件 | 进待确认（`AI_COMPANY_ONLY`） | **原地升级入投递明细**：该记录自动变为 `has_applied=1, status=assessment`，写入 `stage_received_at` 与 `mail` 历史。 |
| **S4：同公司已有其他岗位，新岗位来测评** | 台账有 `网易 · 游戏策划`（看过没投）；收到 `【网易】产品经理在线测评通知` | 进待确认（`resolveMailApplication` 误判 `company_only`） | **自动新建独立记录**：新建 `网易 · 产品经理`（`status=assessment`），不改动 `网易 · 游戏策划`。 |
| **S5：同公司已有 2 条未终态记录，来无岗位名测评** | 台账有 `网易 · 游戏策划` 与 `网易 · 产品经理`（均未终态）；收到 S2 无岗位名测评邮件 | 进待确认 | **保持进待确认**（`AI_COMPANY_ONLY`），列出两条候选供用户点选，不乱改台账。 |
| **S6：状态继续演进与保护** | S1 建账后收到 `网易 · 游戏策划 面试邀请` → 再收到迟到的 `投递成功` 回执 → 再手动改为 `offer` 后重放旧面试邮件 | 面试更新漏写 `stage_received_at` | `assessment → interview`（写入 `stage_received_at`），迟到回执被忽略，人工 `offer` 不被旧信覆盖。 |

---

## 5. 下游开发与回归验证清单

1. **核心修改文件**：
   - `server/src/domain/mailMatching.js`
   - `server/src/modules/data-capture/mail/parser.js`
   - `server/src/modules/data-capture/mail/sync.js`
   - `server/src/domain/applications.js`
   - `server/src/modules/recruitment-intake/llm.js`
   - `server/src/modules/recruitment-intake/workflow.js`
2. **新增单元测试（`server/test/mail.test.js`、`server/test/flash-intake.test.js`、`server/test/phase2.test.js`）**：
   - 完整覆盖上表 **S1–S6** 六个场景（同时测 **无 AI 离线路径** 与 **AI/Flash 路径**）。
   - 验证真实 HR 页脚免责词（`取消 / 尚未 / 如您 / 招聘流程`）不再误杀正文测评/面试邀请。
   - 验证 `applyStatusTransition` 自动推进到 `assessment / interview` 后 `stage_received_at` 与 `stage_anchor_at` 非空。
3. **必跑回归命令**：
   ```bash
   node --test --test-concurrency=1 server/test/mail.test.js server/test/flash-intake.test.js server/test/intake-workflow.test.js server/test/phase2.test.js server/test/review-intake.test.js server/test/reviews.test.js
   npm test
   npm run test:web
   ```
