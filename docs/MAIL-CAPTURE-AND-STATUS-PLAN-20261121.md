# 邮箱抓取与投递状态自动整理｜规划与开发修改方案（整合完善版）

**编写日期**：2026-11-21  
**审查代码基线**：`dab10ad`（分支 `codex/model-gated-local-review`）  
**交付对象**：下游开发 Agent  

---

## 0. 开发前必做：工作区现状审计与半成品清理

当前工作区存在上一轮开发（中途终止）留下的未提交改动（6 个修改文件 + 1 个新增文件 `providers.js`）。经逐行审查，其中包含**可复用的好设计**，也包含**严重缺陷**，下游开发 Agent 动工前必须按以下清单处理：

1. **必须先从 `HEAD` 还原 `web/assets/js/views/settings.js`**：上一轮的 Python 字符串切片脚本误删了 439 行（`renderReminderPanel` 主逻辑、`renderDataPanel`、`renderPairingSection`、`renderDevicesSection`、`renderMailSection` 均丢失，且残留 `QQ_MAIL_READ_CONSENT_V1` 与 `QQ 邮箱` 副标题），会导致设置页直接崩溃。**务必先 `git checkout -- web/assets/js/views/settings.js` 再按本方案第 5 节重新增量修改。**
2. **保留并修正后端半成品中的 5 个隐患**（详见第 2–4 节）：
   - `recordConfirmedMail` 中使用 `normalizedJobTitle(a) !== normalizedJobTitle(b)` 判冲突，比 `resolveMailApplication` 使用的 `similarJob(a, b)` 更严格，会导致相似岗位命中后反而误报冲突进待确认 → **改为 `!similarJob(...)`**。
   - `sync.js` 中历史待确认邮件正文回填（`backfill`）分支目前只跑离线正则 `parsed.confirmed`，跳过 AI/Flash 判断 → **补齐回填分支对 `processIntakeEvent` 的支持**。
   - `sync.js` 的 `clientInfo` 缺少 `support-email`，且 `classifyError` 尚未识别网易 163/126/yeah.net 的 `Unsafe Login` 错误 → **补全网易 IMAP `ID` 握手与错误分类**。
   - `sync.js` 进度上报缺少 `phase` / `phase_label` / `percent` 显式字段，且每封写库未做节流 → **统一结构化进度字段并适度节流**。
   - 前端 `refresh` 轮询在扫描完成后仍每 5 秒无限轮询且未通知台账刷新 → **扫描完成后停止轮询，并在有新入账/待确认时触发 `onChanged()`**。

---

## 1. 现状根因分析（结合真实自测库数据）

沿「邮箱授权 → IMAP 扫描 → 邮件判断 → 投递明细」全链路核查，**“抓取下来全部进待确认”**由以下 4 个叠加原因导致：

1. **真实自测库实测分布**：在验收库中查到 **33 条待确认原因为 `STAGE_SPLIT_REQUIRED`（阶段需拆分），7 条为 `MAIL_MATCH_UNCONFIRMED`（岗位归属未确认）**。
2. **离线/无模型路径无法自动新建投递明细**：`server/src/domain/applications.js` 中的 `processMailEvent` 仅在 `candidates.length === 1` 时更新已有记录；只要用户台账中尚无对应记录（`candidates.length === 0`），即使邮件明确给出了公司、岗位和测评/面试邀请，也会直接落入 `STAGE_SPLIT_REQUIRED` 或 `MAIL_MATCH_UNCONFIRMED` 进待确认。
3. **默认/存量连接停在 `headers_only`**：`HEAD` 版本默认绑定 `headers_only`（不下载正文），标题往往缺少公司名或岗位名，导致字段不全、置信度不足；同时 `stripHtml` 原实现把 `<br>`、`</p>`、`</div>` 全部压成空格，破坏了正文里的“公司：xxx / 岗位：yyy”换行结构。
4. **AI 链路默认配置与单轮 50 封截断**：`config.js` 中 `mailIntakeJudge` 默认仍为 `jev`（未配 `JEV_API_KEY` 时不会自动启用 Flash 直判）；`sync.js` 原实现单次同步最多处理 `uids.slice(0, 50)`，且前端仅静态展示 `首扫进度 176/176`（无实时百分比进度条）。

---

## 2. 目标一：多邮箱 IMAP/SMTP 授权码连接与防崩溃改造

### 2.1 多邮箱服务商路由表（`server/src/modules/data-capture/mail/providers.js`）
统一收信协议为 **IMAP + 邮箱客户端授权码**（向用户说明“IMAP/SMTP 授权码，非登录密码”，与系统发提醒用的 `SMTP_URL` 相互独立）。

| 邮箱域名 | 服务商标识 | IMAP Host | 端口 / TLS | 特殊协议要求 |
|---|---|---|---|---|
| `qq.com`, `vip.qq.com`, `foxmail.com` | `qq` | `imap.qq.com` | `993` (`secure: true`) | QQ 邮箱客户端授权码 |
| `163.com` | `netease_163` | `imap.163.com` | `993` (`secure: true`) | **必须发送 RFC 2971 IMAP `ID` 命令**，否则 `SELECT INBOX` 报 `Unsafe Login` |
| `126.com` | `netease_126` | `imap.126.com` | `993` (`secure: true`) | 同上 |
| `yeah.net` | `netease_yeah` | `imap.yeah.net` | `993` (`secure: true`) | 同上 |

**实现要点：**
- 提供 `imapHostFor(email)` / `resolveMailProvider(email)`；不支持的域名返回 400：`支持 QQ、Foxmail、163、126 和 yeah.net 邮箱`。
- 环境变量 `IMAP_HOST` 仅在本地 mock / QQ 默认覆盖场景生效，**不得把 163/126/yeah.net 路由到 `imap.qq.com`**。
- `ImapFlow` 显式传入完整 `clientInfo`（触发 RFC 2971 `ID` 命令，兼容网易邮箱）：
  ```js
  clientInfo: {
    name: 'Tounar',
    version: '0.1.0',
    vendor: 'Tounar',
    'support-email': 'support@tounar.local'
  }
  ```
- 授权码去除空白后校验长度 `8..64`。
- `reauthorizeMailConnection` 增加同账号其他活跃连接冲突检查（`id <> ? AND status <> 'disconnected'`），避免违反 `idx_mail_owner_active` 唯一索引。

### 2.2 全链路防崩溃（No-Crash）加固
改动文件：`server/src/modules/data-capture/mail/connections.js`、`server/src/modules/data-capture/mail/sync.js`

1. **Socket 未捕获错误监听**：创建 `ImapFlow` 实例后**立即**绑定 `client.on('error', (err) => logSyncError(fresh.id, 'imap_socket', err))`，防止网络抖动或服务端断连引发 Node.js `Unhandled 'error' event` 导致进程崩溃；`finally` 中 `lock?.release()` 和 `client?.logout()` 各自 `try/catch`。
2. **异步启动隔离**：`kickSync` 始终捕获异常并记录脱敏日志（严禁打印授权码、邮件正文或完整服务端响应）。
3. **中文 MIME 与 HTML 容错**：
   - `decodeMimeWords` 遇到 `TextDecoder` 不支持的 charset 时安全降级，不抛 `RangeError`。
   - `stripHtml(value, keepLines = false)` 支持保留换行（将 `<br>`、`</p>`、`</div>`、`</li>`、`</tr>` 转为 `\n`），避免正文键值对黏连；正文下载遇到单段邮件无 part 编号时继续兜底 `part = '1'`。
4. **单封失败与连接失败分离**：
   - `SEARCH` 与 `FETCH` 之间可能发生邮件被删除（expunge），将 `batch.length - messages.length` 计入已扫描数，避免进度条永远停在 99%。
   - 单封正文下载失败时记入 `stats.errors`，保留上一成功 UID 游标以便下轮重试；若是畸形内容导致解析异常则安全降级为仅邮件头处理，不拖垮整个同步任务。
5. **精确错误分类（`classifyError`）**：
   - `AuthenticationFailure` / `AUTHENTICATIONFAILED` / `LOGIN failed` / `Invalid credentials` → `reauth_required` / `IMAP_AUTH_FAILED`：“邮箱授权失效，请检查是否已开启 IMAP/SMTP 服务并填写正确的客户端授权码”。
   - `Unsafe Login` / `kefu@188.com` → `reauth_required` / `IMAP_UNSAFE_LOGIN`：“网易邮箱安全拦截，请确认已开启 IMAP 服务并使用客户端授权码”。
   - `CERT` / `TLS` / `ENOTFOUND` / `ECONNREFUSED` / `ECONNRESET` / `ETIMEDOUT` / `socket` → `degraded` / `IMAP_NETWORK_ERROR`：“暂时无法连接邮箱服务器，已保留上次同步结果”。

---

## 3. 目标三（扫描策略）：统一为单一模式，取消用户二选一

### 3.1 技术决策：邮件头初筛 + 招聘候选正文自动拉取
- **结论**：统一采用 **`recruitment_body`（邮件头初筛 + 命中招聘候选自动拉取正文）** 单一扫描模式，**不再让用户在“仅抓标题”与“抓正文”之间二选一**。
- **原因**：大量真实招聘邮件在标题里仅写“测评邀请”“面试通知”，公司名、岗位名和具体状态在正文里；先用 `isRecruitmentHeader` 过滤广告/账单/验证码，再仅对招聘候选拉取正文（上限 `192KB`，不读附件，仅保留 `<=300` 字摘录），既能实现自动直录投递明细，又兼顾性能与隐私。

### 3.2 新旧连接兼容与历史待确认自动回填
1. **新建连接 / 重新授权**：前端统一提交 `consent_version: 'MAIL_RECRUITMENT_READ_V2'`，后端强制写入 `mode = 'recruitment_body'`（后端仍兼容旧单测传入的 `QQ_MAIL_READ_CONSENT_V1` 与 `POST /api/v1/mail-connections/:id/mode` 接口）。
2. **存量 `headers_only` 连接单向升级（无双向切换）**：
   - 对于数据库中已存在的旧 `headers_only` 连接，前端仅展示一次性的单向按钮 **「启用招聘邮件整理」**（确认后升级为 `recruitment_body` + `MAIL_RECRUITMENT_READ_V2` 并立刻重扫）；升级完成后该按钮永久消失，**不再提供“切回仅邮件头”**。
3. **历史待确认邮件正文回填重判（`body_review_version`）**：
   - 在 `events.payload_json` 记录 `body_review_version: connection.mode === 'recruitment_body' ? 1 : 0`。
   - 同步时查询 `events JOIN review_items` 中 `status = 'open'` 且 `COALESCE(json_extract(payload_json, '$.body_review_version'), 0) < 1` 的历史 UID，并入本轮 `work` 列表重新下载正文。
   - **关键完善**：回填拿到正文后，先更新 `payload_json`（写入 `body_excerpt`、`ai_body_excerpt`、`body_review_version: 1`），再**同时支持强规则快路径（`confirmedMailProgress`）与 AI 自动入账路径（`processIntakeEvent`）**进行重判；若成功自动入账（`state === 'applied'`），在同一事务内自动将对应 `review_items` 标记为 `resolved` 并更新 `mail_messages.processing_state = 'applied'`。

---

## 4. 目标二 & 三（核心优先级）：明确自动判别规则与直录投递明细

### 4.1 整体判定流水线

```text
邮件 (Subject + From + ReceivedAt + Body[保留换行])
  │
  ▼ [规则 1] 初筛与噪音过滤（非招聘 / 广告 / 转发 / 流程介绍 / 条件句 → 直接 ignored）
  │
  ▼ [规则 2] 双引擎字段提取与状态判定
  │   ├─ 引擎 A（确定性强规则快路径）：confirmedMailProgress + recordConfirmedMail
  │   └─ 引擎 B（AI 抽取 + Flash 直判，未配 Jev 时默认 flash）：extractRecruitmentSignal + judgeIntake
  │
  ▼ [规则 3] 服务端台账归属匹配（resolveMailApplication）
  │   ├─ 命中唯一已有申请 → 原地推进状态 & 补全缺失字段
  │   └─ 无已有申请且「公司 + 岗位 + 明确状态」齐全 → 直接自动新建投递明细（has_applied=1）
  │
  ▼ [规则 4] 写账安全保护（人工修改保护 / 时间倒流与阶段回退保护 / 同状态幂等 / 终态保护）
  │
  ▼ [规则 5] 仅 4 类真不确定场景落入「待确认」（review_items）
```

### 4.2 五步判别规则明细

#### 规则 1：噪音与非进展过滤（直接 `ignored`，不进台账也不进待确认）
- **非招聘邮件**：不命中招聘关键词且发件域名非招聘相关；或主题命中 `验证码 / 发票 / 订单 / 发货 / 促销 / 优惠券 / newsletter / unsubscribe` 且不含 `面试 / 笔试 / 测评 / offer / 录用 / 申请 / 岗位`。
- **非本人实际进展**：
  - 主题以 `Re:` / `Fwd:` / `FW:` / `回复:` / `转发:` 开头；
  - 正文属于 `流程介绍 / 招聘流程 / 模拟测评 / 模拟面试 / 宣讲会 / 开放日 / 广告 / 岗位推荐`，或属于条件假设句（`如果通过 / 若通过 / 若您通过 / 不代表`）。

#### 规则 2：字段提取与投递状态映射
| 目标状态枚举 | 投递明细展示 | 判定依据（邮件头 + 保留换行的正文） | 自动入账门槛 |
|---|---|---|---|
| `applied` | 已投递 | 明确“投递成功 / 申请已提交 / 已收到您的简历 / application submitted” | 强规则单一命中，或 AI（progress≥0.72, evidence≥0.65, status≥0.60） |
| `assessment` | 笔试/测评 | 明确“邀请您参加/完成测评或笔试 / 请于 X 前完成测评 / 测评邀请 / 笔试邀请 / 在线考试” | 同上 |
| `interview` | 面试 | 明确“邀请您参加面试 / 面试邀请 / 一面/二面/HR面 / 面试时间确认” | 同上 |
| `offer` | 录用 | 明确“正式录用 / Offer / 录用意向书 / 录取通知” | 仅 AI 高置信度（`status.confidence >= 0.85`） |
| `rejected` | 拒绝 | 明确“很遗憾 / 未通过 / 不合适 / 进入人才库 / unfortunately / not selected” | 仅 AI 高置信度（`>= 0.85`）；仅“感谢您的应聘/投递”且无明确拒绝词时**不得**自动判拒信，进待确认 |
| `closed` | 已结束 | 明确“岗位关闭 / 流程结束 / 申请已撤回 / position closed” | 仅 AI 高置信度（`>= 0.85`） |

**字段提取与清洗约束：**
- **收件日期**：取邮件 `internalDate`（ISO 8601）；自动新建投递明细时写入 `applied_at = received_at`（`applied_at_precision = 'inferred_before'`），同时写入 `stage_received_at = received_at`。
- **公司名**：支持从正文键值对（`公司/公司名称/企业名称/招聘单位：`）或主题前缀（`【公司】` / `公司 · 岗位`）提取，自动去除尾部 `校园招聘 / 社会招聘 / 招聘 / 有限公司`；排除占位词（`通知 / 招聘 / 测评 / 系统 / 校招 / 未知 / 待补充`）与 URL/邮箱；**严禁将 `qq.com / 163.com / 126.com / yeah.net / foxmail.com` 等公共邮箱域名当作公司名**。
- **岗位名**：支持从正文键值对（`应聘岗位/应聘职位/岗位名称/职位：`）或主题（`【公司】岗位名 - 测评邀请/面试邀请/投递成功`）提取，排除占位词、状态词和 `有限公司`。
- **双引擎路由与默认配置（`server/src/config.js`）**：
  - 当配置了 `AI_API_URL` + `AI_API_KEY` 且未配置 `JEV_API_KEY` 时，`mailIntakeJudge` 默认自动切为 **`flash`**（不再默认 `jev` 导致自动入账失效）；仍允许环境变量 `MAIL_INTAKE_JUDGE` 显式覆盖。
  - **执行顺序建议**：
    - 当 `config.autoIntakeEnabled` 为 `true`（已配 AI/Flash）时：优先走 `processIntakeEvent`（可覆盖更多非模板真实邮件及 `offer / rejected / closed`），仅在 AI 不可用/未启用时或作为确定性加速层走 `confirmedMailProgress` + `recordConfirmedMail`；
    - 当 `config.autoIntakeEnabled` 为 `false`（离线/无模型）时：优先走 `confirmedMailProgress` + `recordConfirmedMail`（解决无模型时明确测评/面试/投递邮件全进待确认的问题），未命中强规则时再回退 `processMailEvent`。

#### 规则 3：台账归属匹配与原地推进（`domain/mailMatching.js` + `applications.js`）
按优先级在当前用户未归档台账中匹配（`resolveMailApplication`）：
1. **`site_application_id` 精确唯一命中** → 原地更新该申请。
2. **`canonical_job_url` 精确唯一命中** → 原地更新该申请。
3. **`公司 + 相似岗位 + 批次`**（未写批次时为 **`公司 + 相似岗位`**）唯一命中 → 原地更新该申请（允许 `pending / applied → assessment → interview → offer / rejected` 原地推进，`application_history` 记录每次阶段变迁，来源记为 `mail`）。
   - **修正上一轮半成品 Bug**：`recordConfirmedMail` 校验目标冲突时，岗位名比对必须使用 **`!similarJob(target.job_title, facts.job_title)`**，不得使用严格 `normalizedJobTitle(...) !== normalizedJobTitle(...)`。
4. **0 候选（台账尚无记录）**：当同时具备有效 `company_name` + 有效 `job_title` + 明确 `status` 时，**直接自动新建投递明细**（`has_applied = 1`，`channel = '邮件'`，`source_methods = ['mail']`），立刻出现在「投递明细」中。

#### 规则 4：写账安全保护（全部保留）
1. **人工修改保护**：`target.manual_status_at >= 邮件收件时间` → `no_change`（忽略），不覆盖人工结果、不生成待确认。
2. **时间倒流 / 阶段回退保护**：较早邮件不得覆盖较新状态（例如迟到的“投递成功”回执不能把 `assessment / interview` 拉回 `applied`；较早测评邮件不能把 `interview` 拉回 `assessment`）。
3. **同状态幂等与面试轮次推进**：重复同步或二次催促提醒命中同状态时，保持申请 ID 唯一、不重复建账；更晚的面试邮件按显式轮次或自动 `interview_round + 1` 更新。
4. **终态锁定保护**：目标记录已为 `offer / rejected / closed` 且新邮件给出不同状态 → 进待确认（`TERMINAL_CONFLICT`），不静默覆盖。

#### 规则 5：仅以下 4 类真不确定场景进入「待确认」
1. **身份缺失**：只识别到公司名无岗位名，或公司/岗位缺失（`AI_COMPANY_ONLY` / `AI_IDENTITY_INSUFFICIENT`）。
2. **多岗歧义**：同公司存在多个岗位且邮件未写明岗位名或申请编号，或批次不匹配（`AI_MATCH_UNCERTAIN` / `batch_mismatch`）。
3. **字段/终态冲突或低置信度**：公司/岗位与原文不符（`AI_FIELD_CONFLICT`）、终态冲突（`TERMINAL_CONFLICT`）、仅“感谢投递”等模糊状态。
4. **模型重试耗尽**：AI 连续失败达 `AUTO_INTAKE_MAX_ATTEMPTS`（默认 5 次）且未命中强规则快路径（`AI_RETRY_EXHAUSTED`）。

---

## 5. 目标二（前端体验）：动态实时百分比进度条与界面净化

### 5.1 后端实时进度数据契约
改动文件：`server/src/modules/data-capture/mail/sync.js`、`connections.js`、`routes/index.js`

在 `mail_connections.last_sync_stats_json` 中实时写入并在 `GET /api/v1/mail-connections/:id` 与 `GET /api/v1/me` 返回：

```json
{
  "phase": "connecting | searching | scanning | finalizing | done | error",
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
  "remaining": 114,
  "started_at": "2026-11-21T02:40:00.000Z",
  "finished_at": null
}
```

**后端刷新要求：**
- 单次 `syncConnection` 内按每批 50 封循环扫完所有 `work` UID（`for (let offset = 0; offset < work.length; offset += 50)`），每 10 封续租 `renewLease` 并校验 `binding_version`，每批提交游标 `commitCursor` 与 `first_scan_total`。
- `percent` 计算单调递增不回跳：
  - `connecting`：`null`（前端显示 indeterminate 过渡态，“正在连接邮箱…”）
  - `searching`：`null`（“正在获取邮件数量…”）
  - `scanning`：`total > 0 ? Math.min(99, Math.floor((scanned / total) * 100)) : 99`
  - `done`（`status === 'connected'`）：`100`（若 `total === 0` 文案为“没有新邮件”，否则“已扫描 X / X 封（100%）”）
- 写库节流：`total <= 30` 时每封调用 `publish()`；`total > 30` 时每 3 封及每批结束调用 `publish()`，避免高频 SQLite 写锁竞争。

### 5.2 前端 UI 改造清单（对照截图逐项落实）
改动文件：`web/assets/js/views/settings.js`（先从 `HEAD` 恢复！）、`web/assets/app.css`

1. **必须删除的内容（对照用户截图红线）**：
   - 删除：`定时收信已关闭 · 提醒发信已关闭 · 邮件判断：Jev 核验`（整行删除）。
   - 删除：`真实 QQ IMAP 与 SMTP 未在当前环境配置时，连接/同步会如实失败并显示错误，不会伪装成“已同步”。`（整行删除）。
   - 删除：`切换为招聘候选正文` / `切回仅邮件头` 切换按钮、连接表单中的「读取模式」下拉框，以及 `读取范围：仅邮件头（不下载正文）` 文案。
   - 删除旧的静态行：`首扫进度 176/176` 与 `本轮取到 X · 新增 Y · 处理 Z · 待确认 W · 错误 E · 剩余积压 R`。
2. **多邮箱标题与文案更新**：
   - 卡片标题：`QQ 邮箱（只读）` → `招聘邮箱（只读）`。
   - 设置弹窗副标题：`提醒设置 · 插件绑定 · QQ 邮箱 · 删除数据` → `提醒设置 · 插件绑定 · 招聘邮箱 · 删除数据`。
   - 邮箱输入框 placeholder：`支持 QQ、Foxmail、163、126、yeah.net 邮箱`；自动回填判断函数 `isQqEmail` 扩展为 `isSupportedEmail`。
   - 授权码输入框与重授权表单：统一提示“邮箱客户端授权码（IMAP/SMTP 授权码，非登录密码）”，勾选文案统一为 `同意只读扫描邮件头和招聘候选正文，用于自动整理投递记录，不读取附件`（**彻底清除残留的 `同意 QQ_MAIL_READ_CONSENT_V1` 字符串**）。
   - **断开后支持换绑其他邮箱**：当 `conn.status === 'disconnected'` 时，直接在其下方渲染 `renderMailConnectForm(null)`，允许用户断开 QQ 后直接连接 163 邮箱。
3. **动态百分比进度条与轻量局部轮询**：
   - 在 `renderMailSection` 中构造独立卡片容器 `card`，提供 `paint(connection)` 局部更新函数（避免整页重绘导致闪屏或弹窗内表单失焦）：
     - 第一行：邮箱地址 + 状态胶囊（连接中 / 同步中 / 已连接 / 同步受阻 / 需重新授权 / 已断开）。
     - 第二行（动态进度条组件 `.tn-mail-progress`）：
       - 顶部文案行：左显示 `正在获取邮件数量…` / `已扫描 62 / 176 封` / `已扫描 176 / 176 封（完成）` / `没有新邮件`，右显示加粗等宽百分比（如 `35%` / `100%`）。
       - 进度条本体：使用语义化 `<progress max="100" value={pct}>`（`pct == null` 时移除 `value` 属性呈现不确定加载动画），配合 CSS 平滑宽度过渡与状态色（同步中用品牌色、完成态用绿色、受阻/失败用警告或错误色）。
     - 第三行（精简结果摘要）：`自动入账 {applied} 条 · 待确认 {pending} 条 · 错误 {errors}` + `最近成功同步 {relativeTime}`。
     - 错误行：仅在存在 `last_error_message` 时以醒目错误样式如实展示。
   - **轮询生命周期**：
     - 仅当 `conn.status` 为 `connecting` 或 `syncing` 时启动 `1200ms` 轮询 `GET /api/v1/mail-connections/:id` 并调用 `paint(c)`。
     - 一旦状态变为终态（`connected` / `degraded` / `reauth_required` / `disconnected`），**立即停止轮询**，更新一次 `state.me.mail_connection`，若 `applied > 0 || pending > 0` 则调用 `onChanged?.()` 刷新台账数据。
     - 通过递增 `mailPollId`、检查 `stillCurrent() && card.isConnected` 及 `onClose` 清理 `timers`，彻底杜绝内存泄漏和旧响应覆盖。

---

## 6. 涉及文件与兼容测试清单

| 层次 | 文件 | 改动摘要 |
|---|---|---|
| 服务商路由 | `server/src/modules/data-capture/mail/providers.js` | QQ/Foxmail/VIP QQ + 163/126/yeah.net 路由与 `requiresImapId` |
| 连接生命周期 | `server/src/modules/data-capture/mail/connections.js` | 多邮箱放开、强制 `recruitment_body`、`MAIL_RECRUITMENT_READ_V2`（向后兼容旧版）、重授权冲突检查 |
| 解析与强规则 | `server/src/modules/data-capture/mail/parser.js` | `stripHtml(..., keepLines)` 保留换行、`confirmedMailProgress` 离线强规则提取与噪声/占位词过滤 |
| 同步与进度 | `server/src/modules/data-capture/mail/sync.js` | 多邮箱 host + `clientInfo`、socket error 防崩溃、循环分批扫完、expunge 计数、历史待确认正文回填（支持强规则 + AI）、节流实时进度上报 |
| 入账与配置 | `server/src/config.js`、`server/src/domain/applications.js`、`server/src/modules/recruitment-intake/workflow.js` | 无 Jev key 时默认 `flash`、`recordConfirmedMail`（修正 `similarJob` 冲突检查）、完善 0 候选自动新建投递明细 |
| 前端与样式 | `web/assets/js/views/settings.js`、`web/assets/app.css` | 从 `HEAD` 还原后改造：多邮箱表单、断开换绑、一次性旧连接升级、移除无关两段文案与模式切换、动态百分比进度条与局部轮询 |
| 关联单测/E2E | `server/test/mail.test.js`、`server/test/flash-intake.test.js`、`server/test/phase2.test.js`、`tests/e2e/run-web-e2e.mjs` | 同步更新关于“仅支持 QQ 邮箱 / 默认 `headers_only` / 划线文案”的旧断言，并新增以下 T1–T5 覆盖用例 |

---

## 7. 下游必跑回归与验收标准

### 7.1 必跑命令
```bash
node --test --test-concurrency=1 server/test/mail.test.js server/test/flash-intake.test.js server/test/intake-workflow.test.js server/test/phase2.test.js server/test/review-intake.test.js server/test/reviews.test.js
npm test
npm run test:web
npm run test:panel
```

### 7.2 核心验收用例
| 编号 | 场景 | 通过条件 |
|---|---|---|
| **T1 多邮箱与防崩溃** | 分别用 QQ、Foxmail、163、126、yeah.net 绑定；模拟错授权码、`Unsafe Login`、网络断连、非法 MIME charset、单封空正文、expunge 缺失 UID。 | 正确路由到各自 IMAP host；网易邮箱携带 `clientInfo`；所有异常如实展示错误码与文案，**服务零崩溃**，进度条不卡死。 |
| **T2 自动直录投递明细** | ① 台账为空时收到明确测评邀请（HTML 换行格式）；② 已有“已投递”同岗收到测评/面试/Offer/拒信；③ 重复同步/二次测评提醒；④ 历史 `headers_only` 产生的 `open` 待确认邮件升级后重扫回填。 | ① 自动新建投递明细（含收件日期、公司、岗位、测评中），**不进待确认**；② 原地推进状态并写 `mail` 历史；③ 幂等无重复；④ 历史待确认正文回填后自动入账并关闭原复核项。 |
| **T3 精准待确认与保护** | ① 只有公司名无岗位名；② 同公司两岗且邮件未指明岗位；③ 宣讲会/流程说明/广告/转发邮件；④ 手动改状态后的旧邮件；⑤ 迟到的旧“投递成功”回执；⑥ 已有终态冲突。 | ①②⑥ 进待确认且不改台账；③④⑤ 忽略不回退、不覆盖人工结果。 |
| **T4 单一模式与动态进度条** | 检查设置 → 数据与授权的未连接、连接中、扫描中（多批 120 封 mock）、扫描完成、已断开 5 种状态。 | 无“切换为招聘候选正文”、无模式下拉框、无截图中红线划掉的两段文案；扫描中进度条与百分比（0%→100%）局部平滑更新无闪屏，完成后自动停止轮询并触发台账刷新；断开后可直接换绑 163 邮箱。 |
| **T5 真实邮箱联调** | 使用真实 QQ 邮箱与 163 邮箱客户端授权码各实测一次连接 → 首扫 → 增量同步。 | 正常连接不崩溃、进度条走到 100%、真实招聘进展直录投递明细；若环境缺少某一方真实测试账号，须明确区分“离线隔离验收通过”与“真实账号待验”。 |
