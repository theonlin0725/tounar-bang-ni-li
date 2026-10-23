# 部署到 WorkBuddy：可行性结论与执行手册（2026-10-23）

依据：`DEPLOY-上线契约-给DeepSeek.md` / `帮你理/docs/DEPLOY.md`（两份内容完全一致）。
本文只写**本机核实过的事实**，以及**我做不到、需要你决定的部分**。

## 1. 结论

**代码形态可以直接跑在 WorkBuddy 上**：单进程 Node ≥24、无构建、静态页与 API 同进程、监听 `0.0.0.0:$PORT`、
`SIGTERM` 优雅退出、SQLite 单文件——这些都和契约一致。

**但「发布」这个动作我做不了**：

- WorkBuddy 是桌面应用（`/Applications/WorkBuddy.app`）。我在它的安装包里只找到 `codebuddy`（AI 编程 CLI）和
  `cbc-prewarm`，**没有找到任何「发布应用 / 部署」的命令行入口**。
- 平台侧没有可用的发布凭据。`.workbuddy/applications.yaml` 里只有 `locator: wbapp_Yw3dKlnEp4jVVAuyNDilAW`，
  没有 token。
- 旧地址 `https://bangnili.app.workbuddy.host` 实测 **403（页面标题「链接不完整」）**，按契约必须重新发布，
  不能沿用旧链接。

所以：**部署的准备工作我全做完了并本机验证过；最后一步「点发布/分配域名」需要你在 WorkBuddy 客户端里操作，
或者给我一个可用的发布入口。**

## 2. 与契约不一致的一处（以代码为准）

契约第 5 节说「后端 41 个路由里没有 `/api/v1/health`，插件会 404」。

**这个缺口在当前 `phase3-local-fix-20261023` 分支上不存在**：健康检查在 `server/src/http.js:168` 单独处理，
不经过路由表。本机实测：

```
GET /api/v1/health → 200 {"ok":true,"service":"tounar-bang-ni-li",...}
```

所以契约里「补 health 路由」这一条**已经不需要做**（那条结论来自更早的代码快照）。

## 3. 部署哪一份代码 + 哪一份数据（必须按这个组合）

| 项 | 选择 | 原因 |
|---|---|---|
| 代码 | `tounar-bang-ni-li-phase2` 的 `phase3-local-fix-20261023` | 本轮所有修复与验收都在这个分支 |
| 数据库 | 真实库（`Desktop/…/帮你理/data/tounar.sqlite`） | 你的真实数据；phase3 副本里的是自建空库 |
| 密钥 | **Desktop 副本的 `data/master.key` / `internal-tick.token`** | 库是用这把密钥加密的；phase3 副本自建的 key 是另一把，混用 = 已加密的邮箱凭据永久解不开 |

这条组合已经落成一个目录：

```
~/tounar-deploy/20261023-154635/
├── tounar.sqlite          ← 真实库的一致快照（backup API，含已提交 WAL）
├── master.key             ← Desktop 副本同源密钥
├── internal-tick.token
└── manifest.json          ← 数量 / 完整性 / sha256
```

数量核对：用户 2 / 台账 6 / 邮件 84 / 待确认 20，`integrity_check = ok`。

生成命令（可重复）：

```bash
node server/scripts/prepare-deploy-bundle.js \
  --source-db "/Users/mingenlin/Desktop/opencode project/帮你理/data/tounar.sqlite"
```

## 4. 本机模拟部署（已做，4 项全过）

用这份 bundle 直接按线上参数起了一个实例（端口 4314，`MASTER_KEY`/`INTERNAL_TICK_TOKEN` 走环境变量，
`DATA_DIR` 指向 bundle，`ENABLE_SCHEDULER=false`）：

| 检查 | 期望 | 实测 |
|---|---|---|
| `GET /api/v1/health` | 200 + ok | **200** |
| `GET /api/v1/me`（未登录） | 401 | **401** |
| `GET /api/v1/internal/status`（错 token） | 401 | **401** |
| 同上（正确 token） | 200 | **200** |

说明：代码 + 真实库 + 同源密钥 + 环境变量注入，这个组合是能起来的。

## 5. 在 WorkBuddy 上发布时要做的事（按顺序）

1. **发布入口**：在 WorkBuddy 客户端里对 `wbapp_Yw3dKlnEp4jVVAuyNDilAW`（帮你理）执行「重新发布」。
   旧实例已经 403，不能沿用。
2. **环境变量**（明文只进平台变量，不要写进仓库或文档）：
   - `MASTER_KEY` ← `~/tounar-deploy/20261023-154635/master.key` 的内容（64 位 hex）
   - `INTERNAL_TICK_TOKEN` ← 同目录 `internal-tick.token`
   - `DATA_DIR` ← 持久卷挂载路径（把 bundle 内容放进去）
   - `APP_BASE_URL` ← **发布后拿到的域名**（不填则邮件里的链接仍指向 `127.0.0.1:4310`）
   - `ALLOWED_EMAILS=1191240794@qq.com`
   - `ENABLE_SCHEDULER=false`（平台会冷启动/可能多副本，进程内 08:00 不可靠）
   - `APP_ENV=production`；SMTP/IMAP 凭据是否注入见第 7 节
3. **单实例**：副本数锁 1（进程内有调度器；多副本会重复发提醒、重复同步邮件）。
4. **持久卷**：`data/`（或 `DATA_DIR`）必须挂持久卷。**这一条平台是否提供，我无法从本机确认**——见第 6 节。
5. **08:00 提醒**：改用外部 cron 打内部端点（平台支持定时任务的话）：
   ```bash
   curl -X POST "$APP_BASE_URL/api/v1/internal/tick" \
     -H "Content-Type: application/json" -H "X-Internal-Token: $INTERNAL_TICK_TOKEN" \
     -d '{"mail": true, "reminders": true}'
   ```
6. **验收**：按契约第 8 节逐条跑，外加**重启存活测试**（造一条记录 → 重启 → 记录还在、邮箱仍能解密、没被强制下线）。
7. **插件**：在 popup 里把后台地址改成线上域名（`https://...`，不要带尾斜杠），再重新配对。

## 6. 我无法确认、必须你或平台回答的一件事

**托管环境给不给持久存储？**

- 给：按第 5 节做即可，SQLite 单文件 + 持久卷就够。
- 不给：重启/冷启动会丢库。只注入密钥能保证「不乱码」，不能保证「不丢数据」。那时才需要换云数据库
  （要改 `db.js` 的同步 API，属于代码改造，不在本轮范围）。

## 7. 真实 SMTP / IMAP 凭据（契约标为「待人决定」）

- 当前 bundle 里**没有** `.env`，也没有 SMTP_URL。不注入 → 线上走 outbox 模式，**不会真发邮件**，登录验证码也进不了邮箱。
- 如果要线上真发信/收信：把 Desktop `.env` 里的 `SMTP_URL` / `MAIL_FROM` 注入平台环境变量即可
  （邮箱 IMAP 凭据已经在库里、用 master.key 加密，不需要额外注入）。
- 这一步我没替你做，因为契约第 10 节把「真实凭据」列为待你决定。

## 8. 还差什么

| 事项 | 状态 |
|---|---|
| 代码 + 数据 + 密钥组合 | ✅ 已准备并本机验证 |
| health 路由 | ✅ 本分支已有，非缺口 |
| 单实例 / 环境变量清单 | ✅ 已列 |
| 发布动作（WorkBuddy 客户端） | ❌ 没有 CLI / 凭据，需要你操作 |
| 公网域名 | ⏳ 发布后才有 |
| 平台是否给持久卷 | ❓ 需要平台侧确认 |
| SMTP 是否上线启用 | ⏳ 你决定 |
