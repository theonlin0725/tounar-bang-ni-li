# 帮你理 C1 / A1 冻结契约（v1）

> 状态：**研发冻结稿（2026-10-22）**。来源为四份 PRD；凡 D 项未获用户拍板者，只做参数化实现并标注，不视为最终产品承诺。
> 唯一总需求来源：`PRD-帮你理-v2.0.md`。字段与事件语义遵循数据稿 C1，业务 API 与任务遵循后台稿 A1。

## 1. 冻结边界

- 存储：单实例 SQLite（持久化文件，WAL、外键、事务），每张用户表含 `owner_id TEXT NOT NULL`；服务端从会话/设备身份注入，拒绝客户端提交 `owner_id`。
- 时间：UTC ISO 8601 落库；展示、日历差、提醒分组按 `Asia/Shanghai`。`occurred_at`、`observed_at`、`received_at` 分开。
- ID：服务端生成不透明字符串。前端只当字符串。
- 七状态：`pending / applied / assessment / interview / offer / rejected / closed`。
- 不变量：`has_applied=false` 仅允许 `pending` 或按 D03 归档的 `closed`；`applied/assessment/interview/offer/rejected` 必须有正式申请确证。`closed` 不反推已投。
- 事件处理状态：`pending / applied / ignored / failed`，与申请状态分开。
- 所有写接口幂等；状态、历史、事件处理与通知候选同一 SQLite 事务内提交。

## 2. 数据表（逻辑 DDL）

### 2.1 身份与安全

| 表 | 关键列 |
|---|---|
| `users` | `id(owner_id)`, `email_normalized`, `email_display`, `allowlisted`, `created_at`, `last_login_at`, `deletion_blocked`, `deletion_generation`, `auth_at` |
| `otp_challenges` | `id`, `email_normalized`, `code_hash`, `expires_at`, `attempts`, `max_attempts`, `consumed_at`, `created_at`, `request_ip_hash` |
| `sessions` | `id`, `token_hash`, `owner_id`, `created_at`, `auth_at`, `expires_at`, `revoked_at`, `user_agent_hash` |
| `rate_limits` | `key`, `window_start`, `count`（仅短期限流；不存隐私正文） |
| `idempotency_keys` | `owner_id`, `scope`, `key`, `request_hash`, `status_code`, `response_json`, `created_at`, `expires_at` |
| `audit_log` | `id`, `owner_id`, `actor`, `action`, `target_type`, `target_id`, `meta_json`（不含正文/凭证） |

### 2.2 台账

`applications` 字段与 C1 3.2 一致，另加服务内部列：

`id, owner_id, company_name, company_key, job_title, site_key, site_job_id, site_application_id, recruitment_batch, location, jd_summary, channel, job_url, canonical_job_url, status_url, status_url_scope, status, has_applied, applied_at, applied_at_precision, first_viewed_at, last_viewed_at, form_started_at, last_status_changed_at, last_progress_at, last_site_observed_at, last_reviewed_at, deadline_at, deadline_precision, interview_round, round_label, interview_scheduled_at, last_interview_completed_at, source_methods_json, latest_event_id, version, created_at, updated_at, archived_at, archive_reason, last_b_notified_at, last_a_notified_at, deletion_generation`

`application_history`：`id, owner_id, application_id, event_id, from_status, to_status, changed_fields_json, changed_at, source_method, reason`。

`application_field_sources`：`application_id, owner_id, field, source_method, event_id, updated_at`。

### 2.3 事件与复核

`events`：C1 3.4 必含字段 + `payload_json, payload_hash, clock_skew_flag, review_reason, processed_at, processing_error`。
唯一约束：`(owner_id, source_method, client_event_id)`；邮件另有 `(connection_id, mailbox, uidvalidity, uid)`。

`review_items`：`id, owner_id, kind, reason_code, summary, evidence_json, suggested_changes_json, candidates_json, source_event_id, source_mail_id, status(open/resolved/dismissed), resolution_json, version, created_at, resolved_at`。
`review_resolutions`：`review_id, owner_id, idempotency_key, request_hash, result_json, created_at`。

### 2.4 插件

`plugin_pairings`：`id, request_id, request_secret_hash, code_hash, device_name, status(pending/approved/exchanged/expired), owner_id, expires_at, approved_at, exchanged_at, created_at`。
`plugin_devices`：`id, owner_id, device_name, token_hash, binding_version, pairing_id, created_at, last_heartbeat_at, last_event_at, server_revoked_at, device_cleanup_state(unknown/acknowledged), device_cleanup_ack_at`。
设备令牌只存 SHA-256 摘要；扩展只在 `chrome.storage.local` 存原始令牌。撤销保留最小记录供清理回执。

### 2.5 邮箱

`mail_connections`：`id, owner_id, email, mode(headers_only/recruitment_body), scan_since, status(connecting/connected/syncing/degraded/reauth_required/disconnected), consent_version, credential_ciphertext, credential_iv, credential_tag, last_sync_attempt_at, last_sync_success_at, last_error_code, last_error_message, binding_version, created_at, updated_at`。
`mail_cursors`：`connection_id, owner_id, mailbox, uidvalidity, last_uid, updated_at`。
`mail_messages`：`id, owner_id, connection_id, mailbox, uidvalidity, uid, message_id, subject_excerpt, from_domain, received_at, category, processing_state, review_item_id, created_at`，唯一来源键；默认不存正文。

### 2.6 提醒

`notification_preferences`：`owner_id, mode(all/changes_only/review_only/off), review_frequency(weekly_monday/daily), review_threshold_days, version, updated_at`。
`notification_outbox`：`id, owner_id, application_id, event_id, kind(status_change/deadline/new_lead), summary, occurred_at, consumed_batch_id, created_at`。
`notification_batches`：`id, owner_id, business_date, channel, status(pending/sending/sent/failed/delivery_unknown/skipped_empty/cancelled), subject, item_count_a, item_count_b, provider_message_id, error_code, created_at, updated_at`，唯一 `(owner_id, business_date, channel)`。
`notification_batch_items`：`batch_id, owner_id, application_id, kind, snapshot_json`。
`reminder_links`：`id, token_hash, owner_id, application_id, action(reviewed_no_change), expires_at, created_at, completed_at, confirmation_result_json`。
`reminder_confirmations`：`id, link_id, owner_id, application_id, application_version, idempotency_key, token_hash, token_ciphertext/iv/tag, state(ready/consumed/expired), expires_at, created_at, consumed_at`。

### 2.7 删除

`deletion_jobs`：`id, owner_id, status(requested/blocking_writes/deleting/awaiting_device_ack/completed/failed), scope_json, progress_json, requested_at, completed_at, error_code`。
`deletion_guards`：`owner_id, generation, blocked_at`（删除后最小防写回标记；不用于展示业务数据）。

## 3. 事件 Schema（插件 → 后端）

```json
{
  "schema_version": "C1",
  "events": [{
    "client_event_id": "opaque-stable-id",
    "event_type": "job_viewed|form_started|application_submitted|site_status_observed",
    "source_method": "plugin",
    "site_key": "adapter-key",
    "adapter_version": "1.0.0",
    "occurred_at": "2026-10-22T10:00:00.000Z",
    "observed_at": "2026-10-22T10:00:01.000Z",
    "evidence_level": "strong|weak|unknown",
    "evidence_code": "adapter-confirmed-submit",
    "payload": {
      "company_name": "示例公司",
      "job_title": "产品运营",
      "site_job_id": "job-123",
      "site_application_id": "app-456",
      "job_url": "https://example.com/jobs/123",
      "jd_summary": "不超过 80 个中文字符的纯文本摘要",
      "location": "上海",
      "recruitment_batch": "2027 秋招",
      "status_text": "面试中",
      "mapped_status": "interview",
      "round_label": "一面",
      "interview_scheduled_at": null
    }
  }]
}
```

- 每批最多 50 条。`owner_id`、`received_at` 由服务端补；提交即拒绝后台/用户专属事件。
- `application_submitted` 只有 `evidence_level=strong` 且适配器确认岗位绑定时才可自动入账；弱证据入复核。
- `job_viewed` 要求岗位详情识别 + 客户端可见累计 ≥3 秒；服务端无法重新验证停留，只能校验事件字段并记录 `adapter_version`。
- URL 只允许 `http/https`；按站点白名单剔除 `utm_* / from / spm / source` 等追踪参数，保留岗位/申请标识。
- 同幂等键同内容返回 duplicate；同键不同 `payload_hash` 返回逐条 `409`。
- 响应逐条：`{client_event_id, accepted, duplicate, event_id, processing_state, application_id, error?}`。

## 4. A1 响应与错误

统一错误：

```json
{"error":{"code":"VERSION_CONFLICT","message":"记录已更新，请刷新后重试","retryable":false},"request_id":"req_opaque"}
```

稳定错误码：`VALIDATION_ERROR`、`UNAUTHENTICATED`、`NOT_ALLOWLISTED`、`FORBIDDEN`、`NOT_FOUND`、`VERSION_CONFLICT`、`IDEMPOTENCY_CONFLICT`、`DEVICE_REVOKED`、`D05_NOT_FROZEN`、`D12_NOT_FROZEN`、`REAUTH_REQUIRED`、`RATE_LIMITED`、`UNAVAILABLE`。

## 5. 状态与投影规则

- 主表：`has_applied=1 AND archived_at IS NULL`。看过没投：`has_applied=0 AND archived_at IS NULL`。归档：`archived_at IS NOT NULL`。
- 三统计全台账、未删除，不受筛选影响：累计=曾投总数（含归档/终态）；进行中=`applied/assessment/interview`；面试中=`interview`。
- 天数：`days_since_applied = ShanghaiDate(as_of) - ShanghaiDate(applied_at)`，当天 0，未来为 `null`；未知为 `null`。
- 回看锚点：`max(applied_at,last_progress_at,last_reviewed_at)` 非空项；`due_for_review` = 未归档 + 已投 + 非终态 + 已投天数 ≥ 阈值 + 距锚点 ≥ 阈值。
- D03 浏览归档：`BROWSE_ARCHIVE_DAYS=0` 默认关闭；启用只归档未投线索，`has_applied` 不变。
- 终态：`offer/rejected/closed` 自动流程锁定；D05 未冻结时终态纠错仅返回 `D05_NOT_FROZEN`，不静默放开。
- D12：默认正式入账要求公司、岗位、JD 摘要、安全链接、已投时间。缺失时插件事件/手动补录进入待确认或明确拒绝，不造值；环境开关只用于评审参数化，默认关闭。
- D06：默认 `weekly_monday`、阈值 14、同记录 B 类 7 天频控；A 类每日。参数可配，不代表 D06 已冻结。

## 6. 接口清单

| 方法/路径 | 契约要点 |
|---|---|
| `POST /api/v1/auth/request-otp` | 邮箱；通配中性响应；限流；真实 SMTP 或开发 outbox |
| `POST /api/v1/auth/verify-otp` | email + code；HttpOnly 会话；准入拒绝返回 403 前不建业务数据 |
| `POST /api/v1/auth/logout` | 撤销当前会话 |
| `POST /api/v1/auth/reauthenticate` | 删除等敏感操作的短期重鉴权 |
| `GET /api/v1/me` | 身份摘要、准入、连接/设备摘要、能力开关、data_revision；不含凭证 |
| `POST /api/v1/events/batch` | 设备 Bearer；≤50；逐条 ACK |
| `GET /api/v1/ledger` | view/q/status/source/due_for_review/sort/cursor/limit；同快照 stats/counts/as_of/data_revision/freshness |
| `GET /api/v1/applications/{id}` | 最新记录、投影、来源、history 分页、review 摘要、version、allowed_actions |
| `POST /api/v1/applications/manual` | Idempotency-Key；D12 门控；统一事件链 |
| `POST /api/v1/applications/{id}/corrections` | Idempotency-Key；expected_version；字段白名单；reason 必填 |
| `POST /api/v1/applications/{id}/reviewed` | Idempotency-Key；expected_version；context=ledger/reminder；reminder 必带 confirmation_token |
| `POST /api/v1/applications/{id}/archive` | Idempotency-Key；expected_version；archive 布尔；reason |
| `GET /api/v1/review-items`；`GET /api/v1/review-items/{id}` | 分页；双版本；证据最短化 |
| `POST /api/v1/review-items/{id}/resolve` | Idempotency-Key；review expected_version；action=confirm/dismiss/link/create；目标申请版本 |
| `POST /api/v1/plugin-pairings` | 扩展创建请求；返回配对码，仅存秘密摘要/验证摘要 |
| `POST /api/v1/plugin-pairings/{id}/approve` | 登录用户 + 配对码；绑定 owner |
| `POST /api/v1/plugin-pairings/{id}/exchange` | request secret；一次性兑换设备令牌 |
| `GET /api/v1/plugin-devices`；`POST .../{id}/revoke` | 安全摘要；撤销与清理回执分列 |
| `GET /api/v1/plugin-devices/self`；`POST /api/v1/plugin-devices/heartbeat`；`POST /api/v1/plugin-devices/cleanup-ack` | 扩展专用；撤销后仍仅允许最小清理回执 |
| `POST /api/v1/mail-connections` | QQ 地址/授权码/mode/scan_since/consent；202；不返授权码 |
| `GET /api/v1/mail-connections/{id}` | 状态、模式、最近尝试/成功、结构化错误、首扫进度 |
| `POST .../{id}/disconnect`；`POST .../{id}/reauthorize` | 幂等；版本失效、清授权、在途丢弃 |
| `GET/PUT /api/v1/notification-preferences` | 版本；D06 参数化 |
| `GET /api/v1/reminder-links/{token}` | 未登录仅登录引导；登录校验本人；GET/HEAD 只读 |
| `POST /api/v1/reminder-links/{token}/confirmations` | 明确点击后签发短期 confirmation_token；completed 只回既有结果 |
| `POST/GET /api/v1/data-deletions` | 202；重新鉴权；scope/阶段/失败/设备清理分列 |
| `POST /api/v1/internal/tick` | 内部调度令牌；邮件同步、提醒、浏览归档、删除任务 |
| `GET /api/v1/health` | 无敏感信息健康检查 |

## 7. 前端启动门禁

只有以下证据全部存在，前端生产代码才接入真实 API：

1. `PLUGIN-E2E`：真实 Chrome 扩展在 fixture 详情页停留 2s 不入库，≥3s 入库；提交成功形成正式申请；刷新/重复上传不重复。
2. `PERSIST`：重启后端后仍能通过 `GET /ledger` 读到同一记录、统计一致。
3. `API-E2E`：插件事件经 A1 持久化后，后端能返回字段正确、`owner_id` 隔离的台账；另用直接 API 验证 QQ 解析 fixtures、复核、提醒、删除等无插件路径。
4. `ISOLATION`：用户 A/B 反向读写全部拒绝。
