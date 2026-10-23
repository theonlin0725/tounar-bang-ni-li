# 二期交付报告（持续更新）

基线：main `88b7334`。任务依据：用户上传的《帮你理·第二轮优化任务书》。不发布线上，不使用聊天中的授权码，不操作真实账号数据。数据库迁移前已用 SQLite backup API 备份本地数据库到 `.tmp/backups/pre-phase2-1792719162067.sqlite`（未提交）。线上备份仍须上线前由用户完成。

## P0：原信关联与深链

- 审查确认：`createReviewForEvent` 漏写原信 ID；此前 UI JOIN 收信日期实际拿不到。已修复 ingest → event → review 链路，并增量回填既有 open 项；列表和详情统一返回收信日期。
- 修复 `/?panel=reviews`，新增 `/?app=<id>`，OTP 登录后继续原深链。
- 变更：`server/src/db.js`、`domain/{applications,mailSync,ledger}.js`、`web/assets/js/{app,views/ledger}.js`。
- 新增：后端原信链路回归、网页待确认深链测试。
- 验证：后端 59/59；插件 17/17；网页 41/41。使用官方 Playwright Chromium 156，下载限制已解除，上一轮 system Chromium 的插件阻塞已解决。
- 限制：缺少真实用户数据库/会话，未对线上那十几条记录做写操作；隔离测试不等于真实账号验收。
