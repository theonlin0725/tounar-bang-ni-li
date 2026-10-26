# P0 修复：浏览入账 + 证据可见（2026-10-26）

对应任务书：[NEXT-ITERATION-PROMPT-20261026](NEXT-ITERATION-PROMPT-20261026.md) 的 §四/§六/§九。
本轮只做两件 P0，不做阶段完成度、模型接入和站点扩展。

## 1. 两个用户问题的根因

### 1.1 浏览记录堆在「待确认」

`processView()` 一开头就要求 `company_name && job_title && (job_url || site_job_id)`，缺任何一项就
`reviewForEvent(VIEW_FIELDS_INCOMPLETE)` 并 return——**不建业务记录**。
而「看过没投」读的是 `applications`（`has_applied=0`），所以这些浏览在台账里根本不存在，只能卡在复核队列。

另外，命中候选时又走 `COMPANY_TITLE_ONLY` 复核，同样不建记录。

### 1.2 证据面板空白

- `reviewForEvent()` 只把 evidence_level/code/site/occurred_at/status_text/url_origin 存进 `evidence_json`，
  **没有岗位标题、公司、链接、JD 片段、缺失字段**；
- `reviewList()` / `reviewDetail()` 不返回来源事件的 payload；
- 前端 `reviews.js` 只渲染 `subject_excerpt / from_domain / body_excerpt / status_text`（邮件字段），
  页面来源自然全空。

## 2. 改了什么

### 2.1 浏览入账规则（server/src/domain/applications.js）

- 只要事件有**可追溯的岗位身份**（`site_application_id` / `site_job_id` / `job_url`），就建立
  `status=pending, has_applied=0` 的记录；公司/岗位/城市/批次/JD 缺了就留空并在前端显示「待补充」，
  **不再因为字段不全进待确认**。
- 只有连身份都没有（没有链接也没有站点岗位 ID）才进复核，reasonCode 改为 `VIEW_IDENTITY_MISSING`，
  摘要写明「没有可追溯的岗位身份」。
- 「有候选但无法确定是同一申请」不再阻塞入账：浏览记录照常建立，同名不同 ID 不合并。

### 2.2 证据链路（applications.js / ledger.js / reviews.js）

- `reviewForEvent()` 新增 `evidence.page`：站点、原岗位标题、公司、岗位链接、城市、批次、渠道、
  JD 片段（≤400 字）、JD 字数、JD 状态、页面状态原文、字段把握度/来源、缺失字段、采集时间。
- `reviewList()` / `reviewDetail()` 关联 `events`，返回 `source`：
  - 页面来源：直接把 `evidence.page` 给前端；老数据没有 `page` 时用 `events.payload_json` 现场还原；
  - 邮件来源：主题、发件域名、收信时间、正文片段（没有正文时明确说明“仅邮件头授权”）。
- 前端 `reviews.js`：
  - 页面来源展示「原岗位标题 / 公司 / 城市 / 批次 / 站点 / 采集时间 / 页面状态原文」+「打开原网页」+ JD 片段 + 缺失字段；
  - 邮件来源展示主题/域名/收信时间/正文片段；没有正文时给出具体原因，不留空白面板；
  - 来源不可恢复时显示「原始事件或邮件可能已被删除」；
  - 页面来源的按钮文案改为「按页面信息新建一条」，新建表单用页面证据预填。

### 2.3 历史误分类修复（server/scripts/repair-browse-reviews.js）

只处理 `job_viewed` / `job_captured` 且 reason 为 `VIEW_FIELDS_INCOMPLETE` / `COMPANY_TITLE_ONLY` 的 open 复核项：

- 有稳定身份、且不是本机/测试地址（`127.0.0.1` 等）才迁移；
- 已有同 URL / 同站点岗位 ID 的记录 → **并入**，不新建；
- 没有则建 `pending/has_applied=0` 记录；
- 关闭复核项、把事件标为 applied，写迁移理由；
- 默认 dry-run，`--apply` 前自动 `backup()`。

**在验收副本上的实跑结果**（`/Users/mingenlin/tounar-acceptance/20261025-060103`）：

```
open 复核项 19（这两类）
可迁回 11，跳过 8（全部是 127.0.0.1:4311 的测试噪声）
created 5，merged 6，resolved 11
备份：tounar.sqlite.pre-browse-repair-1792992559493.sqlite
```

迁移后台账：`pending/has_applied=0` 由 6 条变为 **11 条**；这两类 open 复核项从 19 降到 **8 条**（都是测试噪声，保留）。

## 3. 回归与验证

| 测试 | 结果 |
|---|---|
| `npm test` | **98/98** |
| `npm run test:e2e` | **67/67** |
| `npm run test:web` | **52/52** |
| `npm run test:plugin-acceptance` | **0 failed**（含新用例：缺公司但身份可追溯 → 直接进看过没投） |

新增/更新的用例：

- `server/test/plugin-capture.test.js`
  - 「缺字段但岗位身份可追溯：进看过没投，不进待确认」；
  - 「没有岗位身份才进待确认，且证据里能读到页面信息」；
  - 原「缺公司进待确认」用例按新规则改为「直接入账 + 幂等」。
- `tests/e2e/plugin-acceptance.mjs`：缺公司岗位 → popup 显示「已自动入账」、台账可见、`has_applied=0`、无复核项。

前端截图（本机真实浏览器、验收副本数据）：`docs/acceptance/review-evidence-20261026.png`
——能看到「来源：网页采集 / 原岗位标题 / 站点 / 采集时间 / 打开原网页 / 缺失字段」。

## 4. 还没做（如实）

1. **阶段完成度**（邀请 vs 已完成/结果）没有新增字段和展示，仍是原有 `assessment/interview`；
2. **大模型**页面抽取仍未接入（`llmExtractPageLead` 无调用方）；
3. **真实站点**只回归了既有样本，没有按新要求重跑 10 站列表+3 详情；BOSS 仍阻塞；
4. 迁移只处理了这两类复核项，**邮件类 16 条**（MAIL_MATCH_UNCONFIRMED）没动；
5. 证据面板没有做异步“加载更多正文/重试”，因为当前数据已在列表接口里返回；真正的按需加载留待邮件正文补链。
6. 8 条 `127.0.0.1` 测试噪声仍是 open —— 它们来自本地 fixture 采集，不是真实岗位；是否删除需要你确认（我没自动删）。

## 5. 手动复验

```bash
# 服务（已按迁移后的副本重启在 4311）
cd "/Users/mingenlin/Desktop/opencode project/帮你理"
node --env-file="/Users/mingenlin/tounar-acceptance/20261025-060103/acceptance.env" server/src/index.js
```

- 打开 `http://127.0.0.1:4311/?panel=reviews` → 任选一条页面来源，展开应看到原始标题/站点/时间/链接/JD 片段/缺失字段；
- 打开「看过没投」→ 应能看到腾讯的岗位（标题或公司显示“待补充”）；
- 迁移命令（换副本时）：
  ```bash
  node server/scripts/repair-browse-reviews.js --db <副本>/tounar.sqlite            # dry-run
  node server/scripts/repair-browse-reviews.js --db <副本>/tounar.sqlite --apply    # 写库（自动备份）
  ```
