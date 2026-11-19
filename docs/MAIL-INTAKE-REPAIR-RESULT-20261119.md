# 招聘邮件收信与入账修复结果（2026-11-19）

基线：`23c8c8d`。对应规划：`docs/MAIL-INTAKE-REPAIR-PLAN-20261119.md`。

## 本轮完成

### 1. 收信可观察、可续扫

- `ENABLE_MAIL_SCHEDULER` / `ENABLE_REMINDER_SCHEDULER` 独立于旧的 `ENABLE_SCHEDULER`。
- `schedulerStatus()` 增加收信/提醒开关、上次收信、积压数、判断模式；设置页展示本轮取到/新增/处理/待确认/错误/剩余积压。
- 上一轮有剩余邮件时下一 tick 继续分批续扫，不必等完整 `MAIL_SYNC_MINUTES`。
- 同步使用租约 + `binding_version`：每 10 封续租；断开、重授权或切换读取模式后旧任务不能提交游标、覆盖状态或写邮件。
- 正文单段无 part 编号时按 `part=1` 读取；空正文/下载异常抛可重试错误并停在上一成功 UID，不再静默推进游标。
- 支持显式切换 `headers_only` ↔ `recruitment_body`；切换正文模式要求 `QQ_MAIL_READ_CONSENT_V1`，并递增绑定版本作废旧租约。

### 2. 邮件判断统一

- 新增 `MAIL_INTAKE_JUDGE=flash`（复用 `AI_API_URL/AI_MODEL`）与 `PLUGIN_INTAKE_JUDGE` 独立开关；默认仍是 `jev`。
- 新增 `judgeIntake()` 统一入口；邮件自动同步和人工确认共用 Flash/Jev。
- 自动同步与人工确认共用 `resolveMailApplication()`：
  - 可信申请号 → 岗位链接 → 公司+岗位+批次 → 公司+岗位；
  - 多候选、只有公司、批次不一致、字段冲突都交人工；
  - 模型不直接凭公司名覆盖其他岗位。
- 技术失败重试上限 `AUTO_INTAKE_MAX_ATTEMPTS`（默认 5）；耗尽后写 `failed` 并生成 `AI_RETRY_EXHAUSTED` 待确认，不再无限重跑。
- `ai_ingest_runs.judge_mode`、`mail_connections.last_sync_stats_json` 落库。

### 3. 写账保护

- 人工状态时间晚于邮件证据时，旧邮件不覆盖人工结果（已有）。
- 新增阶段回退保护：迟到的旧“投递成功”回执不能把 `assessment/interview` 拉回 `applied`，返回 `ignored: OLDER_MAIL_EVIDENCE`。
- 终态、同日/重复、旧信和人工保护继续走原有校验。
- 复核 `closed` 动作与状态枚举对齐：`resolve` 接受 `closed` 并按关闭处理；`assignReview` 允许已确认记录使用 `closed`。

## 测试结果

| 套件 | 结果 |
| --- | ---: |
| 邮件/判断/调度相关 | **51/51** |
| 全量后端单测 | **184/185**；唯一失败是既有加密云快照用例（本机环境，与本轮无关） |
| 网页 E2E | **57/57** |
| 插件 E2E | 本轮改动不涉及插件；沿用既有 **67/67** |

关键新增用例：

- 读取模式切换、绑定版本递增、旧租约作废；
- 断开后旧租约不能写邮件/游标；
- 单段 `text/plain` / `text/html` 正文读取，空正文可重试；
- Flash 唯一岗位原地更新、同公司多岗待确认、无候选自动新建、技术失败有上限、人工确认复用 Flash；
- 邮件/插件判断开关独立；
- 迟到的旧投递回执不覆盖测评状态。

## 本地配置

```bash
# 收信独立开关
ENABLE_MAIL_SCHEDULER=true
ENABLE_REMINDER_SCHEDULER=true

# 邮件 Flash 直判（不改插件判断）
MAIL_INTAKE_JUDGE=flash
PLUGIN_INTAKE_JUDGE=jev
# 可选：Flash 技术失败回退 Jev（默认 none，不静默回退）
MAIL_INTAKE_JUDGE_FALLBACK=none

# 重试上限
AUTO_INTAKE_MAX_ATTEMPTS=5
```

## 仍未完成 / 验收边界

1. 4310/4311 仍是 `headers_only`，本轮没有真实 IMAP 新邮件端到端跑通“收信 → Flash → 台账 → 历史”。
2. 生产外部 cron/任务身份未配置；本轮只验证本地 scheduler 配置与代码路径。
3. 现有 pending 邮件（4311 中 14 封已确认、4 封已忽略仍 pending）尚未做只读对账/修正清单，避免旧数据被重跑模型改写。
4. “已投递 → 测评”已有自动/人工测试；后续“测评 → 面试”跨阶段策略仍按规划单独验收。
5. 模型准确率只以虚构样本和测试替身验证，未对真实邮件做准确率承诺。
