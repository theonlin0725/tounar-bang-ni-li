# 4c90875 核查问题的修复记录（2026-10-26）

对应 [P0-IMPLEMENTATION-REVIEW-20261026](P0-IMPLEMENTATION-REVIEW-20261026.md) 的 5 条问题。
本轮只修问题本身，不包含阶段完成度、大模型接入和真实站点重跑。

## 问题 1：邮件复核被当成网页来源 —— 已修

- 判据改为：`review.source_mail_id` → 事件 `source_method==='mail'` → 事件类型 `mail_*`，三者任一即邮件来源；
  **不再用“有没有 payload”判断**（邮件事件同样带 payload）。
- API `source` 对邮件返回：主题、发件域名、收信时间、分类、正文片段、`read_mode`、是否还关联原信。
- 前端邮件分支按 `read_mode` 给不同解释：
  - `headers_only` → 「仅读邮件头授权，只保存主题和发件信息」；
  - 正文模式但无片段 → 「已按正文模式同步，但没保存到可展示片段」；
  - 无 read_mode → 「无法确认是未授权正文还是解析失败」，不再一概说“仅邮件头”。
- 实测（验收副本、真实登录）：`rev_RwcHsX3IcZ19xWMx` 展开显示
  「来源：招聘邮件 / 邮件主题：中国电信天翼云邀请你参加在线笔试 / 发件域名：batchmail.nowcoder.net /
  收信日期 / 邮件分类：assessment / 仅读邮件头说明」。
  截图：`docs/acceptance/review-mail-evidence-20261026.png`。
- 新增回归：邮件事件生成的复核，列表和详情都返回 `source.type==='mail'` 且带主题与正文片段。

## 问题 2：迁移新建缺身份、事件没关联 —— 已修 + 已补数据

`repair-browse-reviews.js` 重写：

- 新建记录写入 `site_key / site_job_id / site_application_id / job_url / canonical_job_url /
  jd_summary / jd_text / jd_status / channel / recruitment_batch / location`，
  写 `application_history`（理由「历史浏览复核迁移」），并 `bump data_revision`；
- 新建与合并都会 `events.application_id = 记录ID`、`processing_state='applied'`；
- 新增 `--fix-migrated`：按 `latest_event` 的 payload 回填已迁移的 `app_mig_*` 记录，
  并把 `application_id` 写回 `review_items.resolution_json`；
- 新增 `--audit`：列出所有 migrated_browse 的来源事件与目标记录，标出站点/ID/host 不一致。

在验收副本上的结果：

```
--fix-migrated：fixed 5
审计：11 条迁移全部能关联到记录，suspicious = 0
5 条 app_mig_* 现在有 site_key=tencent、canonical_job_url、jd_summary（原 payload 里没有 site_job_id，保持为空，不猜）
```

## 问题 3：缺标题记录补全/重复浏览仍进待确认 —— 已修

- 身份冲突判断改为：**只有两个标题都非空且不同**才算“换了岗位”；
- 已有标题为空、新事件带来标题 → 走 `fillMissingFields` 补全；
- 已有标题、新事件标题为空 → 忽略，不冲突。
- 新增回归：URL-only → 补出标题 → 再上报空标题，三次都落在**同一条** `pending` 记录，且无复核项。

## 问题 4：迁移跨站合并同 ID —— 已修

- 身份匹配改为：`site_job_id` 必须同站点（两边都有 `site_key` 时必须一致）；
  URL 只认 `canonical_job_url`（去掉 session 类参数）；
- 命中多条 → `skip`，保留原复核让用户判断，不猜；
- 新增回归：甲站 `job-1` 与乙站同 ID 的浏览事件，迁移后生成两条记录，不互相合并；重复执行不新增。

## 问题 5：明确的投递成功邮件不能记为已投递 —— 分类已修

- `mailParser` 新增 `applied` 分类：命中「投递成功 / 申请已成功提交 / 已收到您的简历 / successfully submitted」等
  回执用语且无拒信信号 → `category=applied, status=applied, confidence=0.94`；
- 仍保持：只有「感谢您的应聘/投递」而无回执证据 → 拒信候选 0.88；明确「未通过/很遗憾」→ 0.95；
- 新增回归断言。

**没有做**：邮件无候选时的自动建档、跨阶段（笔试↔面试）的自动归类、邀请与完成的状态细分——
这些属于下一轮，未在本轮声明完成。

## 测试

| 命令 | 结果 |
|---|---|
| `npm test` | **101/101** |
| `npm run test:e2e` | **67/67** |
| `npm run test:web` | **52/52** |
| `npm run test:plugin-acceptance` | **失败 0** |

新增测试：

- `server/test/plugin-capture.test.js`：URL-only → 标题补全 → 空标题重报（同一条、无复核）；
- `server/test/phase2.test.js`：邮件复核 `source.type='mail'` 且带主题/正文；
- `server/test/mail.test.js`：投递成功回执 → applied；
- `server/test/repair-browse-reviews.test.js`（新文件）：迁移保留身份/JD/事件关联、跨站同 ID 不合并、重复执行幂等。

## 仍未完成（和审核意见一致的）

1. 阶段完成度（邀请 vs 已完成/结果）与阶段历史展示；
2. 邮件无候选时按可靠字段自动建档、跨阶段不阻塞；
3. 页面大模型抽取接入；
4. 真实站点/BOSS/首次授权权限全流程重跑；
5. 16 条邮件类复核未处理；8 条 `127.0.0.1` 测试噪声仍 open（等你决定是否删）。
