# 招聘邮件泛化识别与投递台账改版结果

**日期**：2026-11-22  
**代码基线**：`b17d3d3` 之后  
**范围**：邮件召回/实体清洗/状态入账/待确认互斥，以及投递台账主表 5 列改版。

## 1. 已落地

### 1.1 邮件入口与噪声过滤

- 新增 `isSelfOrNoiseMail()`：拦截 `tounar.local`、`Tounar`、`帮你理`、配置的 `MAIL_FROM` 自身地址，以及验证码、账单、发票、物流、消费/还款、营销退订等非招聘邮件。
- 强招聘短语（面试邀请、笔试/测评通知、录用通知、网申进度等）优先，避免真招聘邮件被泛化噪声词误杀。
- `isRecruitmentHeader()` 扩展中英文招聘关键词、常见 ATS/测评平台域名和发件人显示名线索，并在下载正文前执行自身邮件过滤。

### 1.2 正文与实体清洗

- 大模型输入改为正文首部 4500 字 + 尾部 1500 字，避免落款/表格里的真实雇主被截断；HTML 转文本保留 `<tr>/<td>/<th>` 结构。
- 新增 `splitCompositeEntity()`：将 `2027欧莱雅中国管理培训生` 拆为 `欧莱雅中国 / 管理培训生 / 2027`。
- `cleanMailEntity()` 统一拒绝纯数字、年份/批次、通用招聘角色词、ATS/测评平台名、URL/官网路径、自身产品名和明显占位岗位名。
- `mailMatching.js` 增加 `招商银行` / `cmbchina.com` / `95555.com` 映射，以及 `companyMatchIdentity()` 进行同公司历史脏名归一。
- 模型输出在 `workflow.js` 中统一过实体校验；模型脏值不能直接创建台账。

### 1.3 状态与台账

- 保留六态 `applied / assessment / interview / offer / rejected / closed` 及向前推进、同阶段轮次更新、旧邮件不回退、终态冲突转待确认。
- 新增 `location / round_label / interview_scheduled_at / deadline_at` 的抽取、校验和入账透传。
- 低置信度占位岗位（如同公司唯一活跃记录、`待补充岗位`）可由后续明确岗位名自动补全；人工字段与人工状态继续保护。
- 公司级清晰测评/面试进展在无候选时可自动建账占位岗位；仅“内推成功确认”这类没有个人阶段邀请的邮件直接忽略。
- 对 `applied / assessment / interview` 三态，公司/岗位/阶段都明确且模型主进展把握达标时，不再因为缺少截止时间、申请号等可选字段而进待确认。
- 规则分类器将“面试时间调整/时间不合适/改期”与拒信区分，避免面试改期误判 `rejected`。

### 1.4 自动入账与待确认互斥

- 新增 `resolveSupersededReviews(ownerId, app, event)`：
  - 同事件 open review 直接 resolved；
  - 同公司 + 相似岗位（或同公司唯一活跃且审批项无岗位名）且建议阶段不高于当前状态时自动 resolved；
  - 同步把对应 `mail_messages.processing_state` 置为 `applied`。
- 在 AI 自动新建/更新/无变化确认，以及规则自动入账路径统一调用。
- 新增 `server/scripts/cleanup-mail-auto-ledger.js`：默认 dry-run，`--apply` 才归档历史脏邮件台账并关闭已被覆盖的 open review；严格跳过 `manual` / `plugin` 来源。

### 1.5 台账前端

- 移除顶部 `#tn-tabs`，四视图继续由左侧导航和 URL 路由承担。
- 主表固定 5 列：公司 / 岗位 / 状态 / 已投天数 / 更新时间。
- 状态改为带状态色的圆角下拉；切换后即时变色，失败回滚。
- 已投天数统一为上海时区自然日：`applied_at → stage_received_at → created_at` 三级回退；不再显示长串“≤ 日期（据邮件推断）”。
- 更新时间仅显示 `YYYY-MM-DD`，精确时间留在 `title`。
- `≤760px` 下表格重排为卡片，无横向溢出；岗位链接和 JD 仍保留在详情抽屉。
- 邮箱同步完成后派发计数刷新事件，设置页立即更新侧栏待确认/观看角标。

## 2. 验证结果

### 2.1 自动化

| 套件 | 结果 |
|---|---|
| `npm test` | 224 / 226；两个既有云快照用例不稳定失败（`cloud-persistence` / `cloud-persistence-http`，ENOENT/TEMPORARY_FAILURE），与本次改动无关 |
| `npm run test:web` | 74 / 74 |
| `npm run test:e2e` | 67 / 67（Plugin-E2E） |
| `npm run test:career-ai` | 51 / 51 |
| `npm run test:panel` | 8 / 8 |
| `npm run test:intake` | 10 / 10 |
| `npm run test:mail-admin` | 通过 |
| `npm run test:mail-progress` | 6 / 6 |

新增专项覆盖：

- 自身邮件/噪声过滤与 `MAIL_FROM`；
- 正文头尾截断；
- 纯数字 `95555` + 企业域名/正文 → 招商银行；
- 复合标题拆分；
- 模型返回 URL/年份脏岗位名清洗；
- 公司级低证据但清晰进展自动建账；
- 仅内推确认忽略；
- 自动入账关闭同岗位旧 open review；
- 台账 5 列、状态色、纯天数、日期更新时间、390px 卡片布局。

### 2.2 全链路泛化基准

新增 `tools/run-mail-e2e-benchmark.mjs`、本地 SMTP/IMAP 沙箱和 `tests/fixtures/mail-generalization-corpus.json`：

- 40 封合成邮件（已知 10 / 未见 30，unseen 占 75%）；
- 本地 SMTP → IMAP → production sync/parser/LLM/DB/API/前端闭环；
- 首轮基线召回 74.2%，暴露“缺少截止时间导致清晰测评进待确认”和“改期误判拒信”两个共性问题；修正后本轮 100% 通过全部门槛，详见 `docs/MAIL-E2E-GENERALIZATION-BENCHMARK-RESULT-20261122.md`。

### 2.3 4324 真实邮箱验收

隔离副本：`/Users/mingenlin/tounar-acceptance/20261120-real-resume-selftest`  
服务：`http://127.0.0.1:4324`

本轮执行全量窗口同步（10/22–11/22）：

- 已扫描 129 / 129，进度 100%；
- 自动入账 15 条，待确认 2 条，错误 0；
- 形成 9 条邮件来源台账（另有 4 条既有插件浏览记录保留）；
- 最终 open review 1 条，为“发件人名称/PM 岗位无法确认真实公司”的字段冲突，属于应人工确认的歧义；
- 未再生成 `Tounar`、`帮你理`、`95555`、`recruitment` 等脏公司；
- 早前 177 封基线已验证 `2027欧莱雅中国管理培训生 → 欧莱雅中国 / 管理培训生`；
- 自动入账的岗位未再重复出现在待确认中；
- 页面无顶部标签栏，5 列、状态色、天数、日期更新时间与移动端卡片均正常。

真实邮箱地址、授权码、验证码、邮件正文和截图均保留在 `.tmp/` 或隔离副本中，未写入仓库。

## 3. 使用说明

```bash
# 清理脚本先预览
DATA_DIR=/Users/mingenlin/tounar-acceptance/20261120-real-resume-selftest \
  node server/scripts/cleanup-mail-auto-ledger.js

# 确认后执行
DATA_DIR=/Users/mingenlin/tounar-acceptance/20261120-real-resume-selftest \
  node server/scripts/cleanup-mail-auto-ledger.js --apply

# 4324 登录验证码
DATA_DIR=/Users/mingenlin/tounar-acceptance/20261120-real-resume-selftest \
  npm run otp:latest

# 停止 4324
npm run local:stop -- --port 4324
```

## 4. 诚实边界

- 真实 163 / 126 / yeah.net IMAP 联调仍未完成：当前没有这些邮箱的客户端授权码。
- 既有云快照用例仍有不稳定失败（`cloud-persistence` / `cloud-persistence-http`），未在本次范围内修复。
- 浏览器扩展 GUI 相关套件（如 `toast-feedback`）依赖扩展 service worker 环境；本次未将其结果当作产品回归通过证据。
