# 部署契约（给执行部署的 Agent / harness）

> 最后核实：2026-10-23。本文写的是**代码里已经存在的事实**，不是计划。
> 凡本文未写、或与你看到的环境不一致的，以实际环境为准并回报差异，不要猜。

---

## 0. 一句话现状

单进程 Node 服务，**零构建**，HTTP 静态页与 API 由**同一个进程**提供。
数据库是**单文件 SQLite**。发布 = 让这个进程在公网跑起来 + 把域名喂给它。

---

## 1. 线上跑在哪

| 项 | 值 | 代码出处 |
|---|---|---|
| 入口 | `node server/src/index.js` | `server/src/index.js` |
| 启动命令 | `npm start`（= `node --env-file-if-exists .env server/src/index.js`） | `package.json` |
| 监听地址 | `0.0.0.0`（默认，已为反向代理适配；可用 `HOST` 覆盖） | `config.js` `host` |
| 端口 | `PORT` 环境变量，缺省 **4310** | `config.js` `port` |
| Node 版本 | **≥ 24**（必须） | `package.json` `engines` |
| 构建步骤 | **无**。前端是 Vanilla SPA，直接读 `web/` 目录 | `config.js` `webDir` |
| 依赖安装 | `npm install`（生产只需 3 个：imapflow、nodemailer、workbuddy-cloud-sdk） | `package.json` |
| 静态路由 | `/`、`/index.html`、`/r/*` → `web/index.html`（SPA fallback 已实现） | `http.js:113` |
| API 前缀 | `/api/v1/**`，共 41 个路由 | `routes/index.js` |
| 优雅退出 | 已处理 `SIGINT` / `SIGTERM` | `index.js:34-35` |

**关键约束：必须单实例。**

进程内跑着调度器（`ENABLE_SCHEDULER` 默认 `true`，`index.js:37`）。
起两个副本 = 提醒邮件**发两遍**、邮件同步**跑两遍**。
如果托管平台会自动扩副本，部署时必须显式把副本数锁成 **1**，或者设 `ENABLE_SCHEDULER=false` 改用第 6 节的外部触发。

---

## 1.5 ⚠️ 访问必须带 `sharecode`（2026-10-23 实测，重要）

发布后实测（同一域名、同一时刻）：

| 请求 | 结果 |
|---|---|
| `https://bangnili.app.workbuddy.host/api/v1/health` | **403** 「链接不完整」 |
| `https://bangnili.app.workbuddy.host/api/v1/health?sharecode=YOUR_SHARE_CODE_CONFIG_VALUE` | **200** `{"ok":true,...}` |
| 带 sharecode 访问过一次后，同 IP 再不带 sharecode | 200（网关已放行该来源） |

**结论：分享链接必须带 `?sharecode=<码>`，否则新访客（未激活的来源）一律 403。**
首次带码访问会放行当前来源，但**换网络/换人访问仍需带码**。

> **对 `APP_BASE_URL` 的影响（2026-10-24 已由代码方案解决）：**
> 不要把 sharecode 写进 `APP_BASE_URL` 本身。已合入 `SHARE_CODE` 环境变量支持
> （`config.js:54` + `util.js appendShareCode`）：设置后，邮件/深链生成的链接
> **自动追加** `?sharecode=…`；不设置则完全不影响本机与普通域名。
> 主工作区 `.env` 已配置 `SHARE_CODE`（gitignore 不入库）。
> ⚠️ 生效前提：`.env` 或环境变量必须**真的进入沙箱**——`.env` 在 .gitignore 中，
> 若上传遵循 gitignore，线上 `SHARE_CODE` 为空、邮件链接不带码，
> 4G 下打开会 403。harness 的「提醒链接带码能在 4G 打开」验收项即在验证此事。
> 裸域名新访客仍 403：这是**平台网关**行为，应用代码改不了，
> 带码链接才是唯一的访问入口。

---

## 2. 域名

- 平台托管域名格式：**`<名字>.app.workbuddy.host`**（腾讯 EdgeOne CDN 承载）。
- 本项目已注册的发布身份：`appId = wbapp_Yw3dKlnEp4jVVAuyNDilAW`，名称「帮你理」，类型 `web`
  （本地记录：`.wbapp_Yw3dKlnEp4jVVAuyNDilAW.genie`、`.workbuddy/applications.yaml`）。
- **2026-10-23 已重新发布成功**，域名沿用不变：`https://bangnili.app.workbuddy.host`
  （发布返回的分享链接：`https://bangnili.app.workbuddy.host/?sharecode=YOUR_SHARE_CODE_CONFIG_VALUE`）。
  实测 `health` 200、`/api/v1/me` 401（鉴权生效）。
  ⚠️ 但**访问必须带 sharecode**，详见第 1.5 节。
- 补充说明：重新发布前该地址曾返回 403「链接不完整」——
  当时是应用实例已下线，**不是域名失效**。重新发布后域名保持不变。
- 自定义域名（如 `bangnili.com`）：托管域名是平台自动分配的；绑自有域名需要把 DNS
  `CNAME` 指到平台给出的目标地址。**目标地址以重新发布后平台返回的值为准**，不要沿用旧的
  （本次 dig 到的旧 CNAME 目标是 `3wjcyjr594ya.app.workbuddy.host.eo.dnse5.com`，仅作参考）。

> ⚠️ **重新发布后必须做的一件事**：把最终域名写进环境变量 `APP_BASE_URL`。
> 否则邮件里的提醒链接、落地页链接仍然指向 `http://127.0.0.1:4310`，用户点了打不开。
> 出处：`config.js:46`。

---

## 3. 线上库在哪 · 怎么持久化（**本节是部署成败的关键**）

### 3.1 库的位置

| 项 | 值 | 出处 |
|---|---|---|
| 引擎 | `node:sqlite`（Node 内置，**不需要装任何数据库**） | `db.js:3` |
| 文件 | `data/tounar.sqlite`（WAL 模式） | `config.js` `dbPath` |
| 覆盖方式 | `DB_PATH`（单文件）或 `DATA_DIR`（整个目录） | `config.js:6,41` |
| 建表 | 进程启动时自动执行 `server/src/schema.sql` + 轻量迁移，**无需手工建表** | `db.js:19-21` |
| 会话模式 | `PRAGMA journal_mode=WAL; foreign_keys=ON; busy_timeout=5000` | `db.js:18` |

### 3.2 真正会炸的地方：两个密钥文件

`config.js` 的 `loadOrCreateSecret()`（`config.js:20-26`）逻辑是：
**文件存在就读，不存在就随机生成一个再写文件。**

于是：

- `data/master.key` —— 主密钥，用来加密邮箱授权凭据等敏感字段，同时派生 OTP pepper。
- `data/internal-tick.token` —— 内部调度令牌。

**如果容器文件系统不持久，重建后这两个文件会被重新生成 → 密钥变了。**
后果不是"数据丢了"，而是**旧数据变成解不开的乱码**——已存的 IMAP 凭据全部作废、
已登录用户全部掉线、历史加密字段无法还原，且**不可逆**。

### 3.3 因此，持久化必须做两件事

**① 把两个密钥从「文件」提升为「环境变量」。**
`config.js` 已经支持 env 优先（`process.env.MASTER_KEY` / `process.env.INTERNAL_TICK_TOKEN`），
不需要改代码。在本机读取现有值（**不要把明文写进任何文档或 Git**）：

```bash
# 在本机项目根目录执行，把值交给部署侧注入为环境变量
cat data/master.key            # → MASTER_KEY（须为 64 位十六进制，否则启动直接抛错）
cat data/internal-tick.token   # → INTERNAL_TICK_TOKEN
```

注入后，即使容器重建、文件系统清零，密钥也保持不变，已加密数据始终能解开。

> `MASTER_KEY` 有格式校验：必须是 **64 个十六进制字符**（32 字节），
> 否则 `config.js:29-31` 直接 `throw`，服务起不来。复制时不要带上换行以外的字符。

**② 把 `data/` 目录挂到持久卷**（或整体设 `DATA_DIR` 指向持久卷路径）。
这样 `tounar.sqlite` 本身不随容器销毁。

### 3.4 ⚠️ 先想清楚「部署哪一份」：三份代码、两把密钥

本机存在**三份代码副本**，且**密钥互不相同**（2026-10-23 实测 hash 比对确认）：

| 副本路径 | 分支 | 有无 `data/` | 状态 |
|---|---|---|---|
| `/Users/mingenlin/Desktop/opencode project/帮你理` | `main` | ✅ 有（含真实库，569KB） | 主工作区 |
| `.../deepseek-harness/default-workspace/tounar-bang-ni-li` | `main` | ❌ **无** | 旧副本（20:15），无库无依赖 |
| `.../deepseek-harness/default-workspace/tounar-bang-ni-li-phase2` | `phase3-local-fix-20261023` | ✅ 有（自建库） | **harness 当前活跃副本** |

（`...` = `/Users/mingenlin/Documents`）

**规则：部署哪份代码，就用那份代码目录下的 `data/master.key`。**

两把密钥已经实测为**不同的两把**（主工作区 `6fba13f4…` / phase2 `57916a94…`）。
它们的库是用各自密钥加密的，**跨副本混用 = 已加密字段全部解不开**，
表现为"邮箱连接突然失效、凭据报废"，且不可逆。

> 如果 harness 在 phase2 副本上开发，就部署 phase2，并用 phase2 的 key；
> 若要部署主工作区版本，就用主工作区的 key。**不要混。**
> 上线**之前**先把这件事定下来，不要上线后再发现连错库。

**附带一个必做的坑：WAL 未 checkpoint。**

phase2 副本当前 `tounar.sqlite` 只有 **4KB**，而 `tounar.sqlite-wal` 有 **791KB** ——
绝大部分已提交数据还躺在 WAL 里。
**只复制 `.sqlite` 文件 = 丢掉 99% 的数据。**

迁移/备份前必须先 checkpoint（二选一）：

```bash
# 方式 A：原地截断（原地生效）
sqlite3 data/tounar.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"

# 方式 B：导成单文件快照（更安全，推荐）
sqlite3 data/tounar.sqlite "VACUUM INTO '/绝对路径/snapshot.sqlite';"
```

> 服务**必须先停**再 checkpoint；运行中复制会得到不一致的快照。

### 3.5 持久卷：平台侧已明确「没有」

> **2026-10-23 已核实**（来自发布能力的官方说明）：
> 托管沙箱以单公网端口提供 Node/Python/Go/静态站点，
> **不提供数据库、缓存、消息队列**。也就是说**没有持久卷**。

推论（请按最坏情况设计）：

- SQLite 文件随沙箱存在，**沙箱重建/冷启动后数据大概率丢失**，回到初始状态。
- 因此第 ① 步（把密钥提升为环境变量）**比以往更重要**：
  它保证"每次重建后已加密数据仍可解"，而不是变成乱码。
- 但**它不能阻止"新增的数据丢失"**。
- 定时任务更不可靠：进程会睡，第 6 节的外部 cron 触发是**必须项**，不是可选项。

**另一个连带问题**：`.gitignore` 排除了 `data/*.sqlite`、`data/*.key`、`.env`。
若上传遵循 .gitignore，线上将**既没有库也没有密钥**，
服务启动时会**随机生成一把新 master.key 并建空库** ——
每次重建密钥都不同，历史加密数据永远解不开。

**因此上线后必须立刻实测确认**（harness 的"重启存活测试"就是为此）：
若发现线上是空库 / 密钥每次都变，说明需要改用平台云数据库（Postgres），
那就属于代码改造，需单独评估，不在本轮"直接部署"范围内。

---

## 4. 环境变量全清单

来源：`.env.example`、`config.js`。标 🔴 的是**上线必填**，标 ⚠️ 的是**不填就会静默降级**。

| 变量 | 默认 | 说明 |
|---|---|---|
| 🔴 `APP_BASE_URL` | `http://127.0.0.1:4310` | **线上域名**，不填则邮件链接全部指向本地 |
| 🔴 `MASTER_KEY` | 自动生成到文件 | 64 位 hex，**上线必须显式注入**（见 3.3） |
| 🔴 `INTERNAL_TICK_TOKEN` | 自动生成到文件 | 内部调度令牌，**上线必须显式注入** |
| 🔴 `ALLOWED_EMAILS` | `demo@tounar.local,peer@tounar.local` | 内测白名单，逗号分隔；**默认两个是假域名，收不到邮件** |
| `PORT` | `4310` | 平台若注入 `PORT` 会自动跟随 |
| `HOST` | `0.0.0.0` | 一般不用改 |
| `APP_ENV` | `development` | 线上建议设 `production` |
| `DATA_DIR` | `<项目根>/data` | 挂持久卷时指向卷路径 |
| `DB_PATH` | `<DATA_DIR>/tounar.sqlite` | 一般不用改 |
| ⚠️ `SMTP_URL` | 空 | 空 = 开发模式，邮件只落 `data/outbox/` **不会真发出去** |
| ⚠️ `MAIL_FROM` | `Tounar 帮你理 <no-reply@tounar.local>` | 配 SMTP 时须与授权账号一致，否则 QQ 拒发 |
| `IMAP_HOST` / `IMAP_PORT` | 空 / `993` | 收信侧 |
| ⚠️ `CLOUD_ENDPOINT` / `CLOUD_PUBLISHABLE_KEY` / `CLOUD_LLM_ENABLED` | 空 / 空 / `true` | 云端大模型兜底；**置空会自动回退纯规则解析，不影响主流程** |
| `REMINDER_HOUR` / `REMINDER_MINUTE` | `8` / `0` | 北京时间 |
| `ENABLE_SCHEDULER` | `true` | 多副本时必须关掉 |
| `SESSION_DAYS` | `30` | 会话有效期 |

其余 `BROWSE_ARCHIVE_DAYS`、`AUTO_TERMINAL_CONFIDENCE` 等是已冻结决策 D01–D12 的开关，
默认值即冻结结果，**一般不要覆盖**（详见 `docs/DECISIONS-D01-D13.md`）。

---

## 5. ✅ `/api/v1/health` 已存在，不需要补

> **2026-10-23 更正**：本节初版写「后端没有 health 路由」是**错的**，
> 当时只搜了 `routes/index.js`（路由表），没搜 `http.js`。
> harness 实测并指出后已核实：health 在 **请求分发之前被短路处理**，不在路由表里。

- 实现位置：`server/src/http.js:168-171`（主工作区与 phase2 副本**两处都有**）

```js
if (pathname === '/api/v1/health') {
  sendJson(res, 200, { ok: true, service: 'tounar-bang-ni-li', time: new Date().toISOString() });
  return;
}
```

- 调用方：`extension/lib/api.js:35-36` → `request('/api/v1/health', { serverUrl })`
- 它是**public 且无 CSRF 校验**（在 `serveStatic` 与路由分发之前直接返回），插件未配对时也能调通。
- 实测：本地按线上参数起服务，`GET /api/v1/health` 返回 **200**。

**结论：不需要为此改任何代码。**

---

## 6. 定时任务：沙箱会睡，08:00 提醒不可靠

调度器在进程内（`jobs/scheduler.js`），进程睡了就不触发。
托管沙箱通常按需冷启动 —— **每天 08:00 的提醒批次很可能根本不执行**。

### 6.1 ⚠️ 网关行为（2026-10-24 探针实测，重要）

腾讯 EdgeOne 网关对到达应用的请求做了两件事：

| 头部 | 网关行为 | 后果 |
|---|---|---|
| `Authorization` | **无条件注入/覆盖**为自己的 JWT（约 380 字符） | 应用的 Bearer 鉴权全部失效 |
| `X-Internal-Token` | **剥离** | 内部端点头通道失效 |
| 其他自定义头（如 `X-Device-Token`、`X-Session-Token`） | **正常透传** | 可用 |
| 查询参数 / 请求体 | 正常透传 | 可用 |

**因此代码已做如下适配（`fa993b8` 起，已上线）：**

- **内部调度令牌**：`requireInternalToken` 接受 `?tick_token=`（GET）与
  `body.tick_token`（POST），优先级高于头通道。
- **插件设备凭证**：`authenticateDevice` 优先读 `X-Device-Token` 头；
  插件 `api.js` 同时发送 `X-Device-Token` 与 `Authorization`（本地无网关仍兼容）。
- **CSRF 豁免收紧**：只有 `dev_` 设备凭证跳过 CSRF；网关注入的任意 Bearer 不再豁免。

### 6.2 触发方式（线上可用）

```bash
# 查询参数和 sharecode 一起带（sharecode 是网关门禁，tick_token 是应用鉴权）
curl "$APP_BASE_URL/api/v1/internal/status?sharecode=<码>&tick_token=<令牌>"

curl -X POST "$APP_BASE_URL/api/v1/internal/tick?sharecode=<码>" \
  -H "Content-Type: application/json" \
  -d '{"tick_token": "<令牌>", "mail": true, "reminders": true}'
```

令牌值与 `data/internal-tick.token` 一致（已通过 `.env` 的 `INTERNAL_TICK_TOKEN` 注入线上，
health 探针 `tick_sha8` 可比对：当前线上 = 本地 = `4692f6b0`）。
注意：query 里的令牌会进 CDN 日志，优先用 POST body 通道。

一次性手动触发也可用本机脚本 `npm run remind` / `npm run mail:sync`。

### 6.3 health 探针字段（部署诊断用）

`GET /api/v1/health` 回显（只含布尔/来源/哈希前8，不含任何秘密值）：
`version`（部署批次标记）、`share_code`（SHARE_CODE 是否生效）、
`tick_token_source`（env/file）、`tick_sha8`、`internal_header_seen`、`auth_header_len` 等。
**以后排查线上环境变量问题，先看这个探针。**

---

## 7. 插件侧（Chrome 扩展）

- 插件**不在部署范围内**（是用户浏览器里手动加载的），但服务端地址要改。
- 默认地址写死为 `http://127.0.0.1:4310`：`extension/lib/common.js:5` 的 `DEFAULTS.serverUrl`。
- **好消息**：popup 里有地址输入框（`extension/popup/popup.js:22`，消息 `set_server_url`），
  用户可以直接填线上域名，代码不必改。
- 建议：把 `DEFAULTS.serverUrl` 的默认值改为线上域名，省掉手工填写。
- 注意：线上是 HTTPS，默认值必须是 `https://` 开头的完整地址，不能带尾斜杠
  （`api.js:4` 会去掉尾部斜杠，但协议别写错）。

---

## 8. 上线验收清单（逐条打勾，不要跳）

```bash
# 1) 静态页可达（证明进程活着）
curl -sS -o /dev/null -w "%{http_code}\n" "$APP_BASE_URL/"          # 期望 200

# 2) 健康检查（第 5 节补完后）
curl -sS "$APP_BASE_URL/api/v1/health"                              # 期望 200 + ok:true

# 3) 未登录访问受保护接口应被拒（证明鉴权生效，不是裸奔）
curl -sS -o /dev/null -w "%{http_code}\n" "$APP_BASE_URL/api/v1/me" # 期望 401

# 4) OTP 能发出（白名单邮箱；若未配 SMTP，去 data/outbox/ 取码或 npm run otp:latest）
curl -sS -X POST "$APP_BASE_URL/api/v1/auth/request-otp" \
  -H "Content-Type: application/json" -d '{"email":"<白名单邮箱>"}'

# 5) 内部端点带错 token 应 401（证明密钥注入正确）
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "X-Internal-Token: wrong" "$APP_BASE_URL/api/v1/internal/status"  # 期望 401
```

**重启存活测试（必做，否则等于没验证持久化）：**
发布 → 登录 → 造一条记录 → 触发一次重启/重新部署 → 再登录，确认：
记录还在 ✅｜已绑邮箱仍能同步（没变成乱码）✅｜没被强制下线 ✅
任一不通过，说明持久卷或密钥注入没生效，**不要对外发布链接**。

---

## 9. 给 harness 的执行指令（可直接复制）

```
目标：把「帮你理」部署为公网可访问的应用。

前置：Node >= 24；npm install；不要改动业务代码，除非本指令明确要求。

0. 【先定这件事，不要跳过】确认要部署哪一份代码副本（见第 3.4 节）：
   - 候选：主工作区 /Desktop/opencode project/帮你理（main）
     或 harness 活跃副本 /Users/mingenlin/Documents/deepseek-harness/default-workspace/tounar-bang-ni-li-phase2
   - 选定后，密钥必须取自「同一份副本」的 data/master.key 与 data/internal-tick.token
   - 若该副本的 .sqlite-wal 明显大于 .sqlite（如 4KB vs 791KB），
     必须先停服务并执行 VACUUM INTO 或 wal_checkpoint(TRUNCATE) 再迁移，否则丢数据
   - 在这一步回报你选了哪一份、为什么

1. 按第 4 节准备环境变量，其中：
   - APP_BASE_URL = 最终公网域名
   - MASTER_KEY / INTERNAL_TICK_TOKEN 取自第 0 步选定副本的 data/ 目录
     （明文只允许进环境变量，禁止写入任何文件、日志或 Git）
   - MASTER_KEY 必须是 64 位十六进制，否则服务起不来
2. 【不需要补 health】第 5 节已更正：`/api/v1/health` 在 http.js:168 已存在且实测 200，不要重复添加。
3. 启动服务，监听 0.0.0.0 与平台注入的 PORT，副本数锁 1。
4. 发布并取回公网域名，回填 APP_BASE_URL 后重启一次。
   （注：主工作区 .env 里 APP_BASE_URL 已预置为 https://bangnili.app.workbuddy.host，
    若重新发布沿用同一域名则无需修改；域名变了必须改。）
5. 按第 8 节逐条验收，含"重启存活测试"。
6. 回报：公网域名、验收逐条结果、第 3.5 节"是否有持久卷"的核实结论。
   任何一条没过，如实说明卡在哪，不要标注为已完成。
```

---

## 10. 决策状态（2026-10-23 拍板）

| # | 事项 | 状态 |
|---|---|---|
| 1 | **持久化路线** | ✅ 已定：**先上线验证，再加固**。即按第 3.3 节（SQLite + 注入密钥 + 挂持久卷）直接部署；由 harness 核实平台是否提供持久卷，拿到结论后再决定要不要升级到云数据库。**本轮不做 Postgres 迁移。** |
| 2 | **`GET /api/v1/health`** | ✅ 已澄清：**本来就有**，在 `http.js:168`（主工作区与 phase2 副本两处都在），实测 200。初版契约称其缺失是误判，本节已更正。**无需改代码。** |
| 3 | **真实 SMTP / IMAP 凭据** | ⏳ 待人决定。不注入则线上走 outbox 模式，**不发真邮件**。 |
| 4 | **自定义域名** | ⏳ 待人决定，见第 2 节。 |
| 5 | **D13 备注字段** | ⏳ 产品决策未冻结（与部署无关）。 |
| 6 | **sharecode 处理** | ✅ 已定（2026-10-24）：不写进 APP_BASE_URL，改用 `SHARE_CODE` 环境变量，应用生成链接时自动附加。见第 1.5 节。 |

> harness 只执行第 1、2 条已定项；第 3–5 条**不要自行决定**，遇到就回报。
