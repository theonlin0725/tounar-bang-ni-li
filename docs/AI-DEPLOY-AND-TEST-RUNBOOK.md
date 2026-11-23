# 帮你理 Tounar v1.1.2：AI 部署与内测 Runbook

**适用对象**：Codex / Claude Code / Gemini / Cursor 等编程助手  
**当前版本**：v1.1.2（AI 助手稳定性 + 简历改写工作台）
**目标**：在不修改业务代码、不接触真实生产库的前提下，完成环境预检、隔离启动和 (a)–(f) 模块验活（e 为 AI 助手/画像，f 为简历改写）。

---

## 0. 硬性安全规则

1. 不读取、上传或提交 `.env`、`data/*.sqlite*`、`data/*.key`、`data/*.token`、`.tmp/`、真实邮箱正文或授权码。
2. 不用真实库直接启动测试；需要真实数据时只用 `npm run local:acceptance` 的隔离副本。
3. 不把模型 Key、邮箱授权码写进 README、测试、截图或提交历史。
4. 不修改 `server/`、`web/`、`extension/` 业务代码来“让测试变绿”；先定位环境问题还是产品问题。
5. 真实站点验收必须人工确认；离线 fixture 通过不等于线上站点全部可用。

---

## 1. 环境预检

在仓库根目录执行：

```bash
node -v
npm -v
git status --short
git log --oneline -1
```

要求：

- Node **≥ 24**（需要内置 `node:sqlite`）；
- 依赖已安装：`npm ci`（或 `npm install`）；
- `git status` 只应出现预期的文档/本地未跟踪文件；不提交 `.env`/数据库/截图；
- 如没有 `.env`：`cp .env.example .env`，只在本地填写。

### 1.1 `.env` 必填/可选

| 变量 | 用途 | 本地最小自测 |
|---|---|---|
| `ALLOWED_EMAILS` | OTP 登录白名单 | 必填，填测试邮箱 |
| `PORT` | 主应用端口，默认 4310 | 可选 |
| `AI_API_URL` / `AI_API_KEY` / `AI_MODEL` | 兼容 OpenAI 的模型网关 | 邮件/简历 AI 需要 |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | OpenRouter Agent 网关 | AI 助手真实联调需要 |
| `AGENT_API_URL` / `AGENT_API_KEY` / `AGENT_MODEL` | 显式 Agent 配置，优先级最高 | 可选 |
| `MAIL_INTAKE_JUDGE` | `jev` 或 `flash` | 可先 `flash` |
| `JEV_API_URL` / `JEV_API_KEY` | 招聘进展判断 | 使用 `jev` 时需要 |
| `MAIL_MODE` | `outbox` 不真发信，`smtp` 才真发 | 自测建议 `outbox` |
| `SMTP_URL` / `MAIL_FROM` | 真实发信 | 仅显式需要时 |
| `AUTO_INTAKE_ENABLED` | 自动入账总开关 | 邮件验收时 `true` |
| `ENABLE_SELFTEST_LOGIN` | OTP 回显（仅本机管理员自测） | 默认 `false`，不要在生产开 |

模型配置必须是**服务端**环境变量，不能写入前端 JS 或扩展包。真实邮箱授权码通过网页绑定流程加密存储，不要写进 `.env`。

---

## 2. 选择启动方式

### A. 全新空库自测

```bash
npm start
```

- 默认：`http://127.0.0.1:4310`
- 空库不会有演示数据。
- 登录验证码从本地 outbox 读取：

```bash
npm run otp:latest
```

### B. 真实数据隔离副本（推荐给产品验收）

```bash
npm run local:acceptance
# 默认 http://127.0.0.1:4311
npm run local:acceptance -- --mail-mode=smtp  # 仅在明确要测真实发信时
```

该命令：

- 以 SQLite backup 复制真实库到 `~/tounar-acceptance/<timestamp>/`；
- 复制同源 `master.key`，但不以读写方式打开原库；
- 检查端口与健康接口；
- 生成隔离的 `state.json`；
- 进程后台常驻，停止：

```bash
npm run local:stop
```

> 本地验收默认使用 A；只有用户明确提供真实库/授权码时才使用 B，并禁止把副本内容复制到仓库。

### C. 健康检查

```bash
curl -fsS http://127.0.0.1:4310/api/v1/health
# 期望：ok: true, version: "1.1.2"
```

---

## 3. 六模块自动验活

### (a) 插件采集

```bash
npm run test:netease-game
npm run test:self-page
npm run test:panel
npm run build:plugin
```

验收：

- `test:netease-game`：60/60；
- `test:self-page`：6/6；
- `test:panel`：8/8；
- `build:plugin` 输出 `bangnili-extension-0.2.11.zip`，版本 0.2.11，无违禁文件。

手工补充：加载 `extension/` 或解压 ZIP，访问至少 3 家招聘站详情页，确认「看过没投」和详情抽屉字段正常。

### (b) 前端

```bash
npm run test:web
```

验收：

- 74/74；
- 截图：`.tmp/web-e2e/`；
- 检查台账 5 列、无 `#tn-tabs`、状态色块、天数、日期、390px 卡片布局。

### (c) 邮件与状态

```bash
npm run test:mail-progress
npm run test:intake
npm run test:mail-admin
```

全链路基准（需要外部模型凭据）：

```bash
MAIL_BENCH_ENV_FILE="/path/to/.env" MAIL_BENCH_JUDGE=flash npm run bench:mail-e2e
```

验收：

- 44 封 / 11 轮；
- 报告 `.tmp/mail-e2e-benchmark-report.md`；
- 召回/拦截/公司/岗位/状态 100%，高危项 0（以实际运行结果为准，不能改断言凑通过）。

真实邮箱只在用户明确授权后测试；没有授权码就如实记录“阻塞”，不要伪造 163/126/yeah.net 通过。

### (d) 简历与单岗匹配

```bash
npm run test:career-ai
```

验收：

- 51/51；
- 简历库多版本、手动编辑、六维卡片、纠偏、面试题持久化；
- AI 按 JD 定向改写与保存新版本在下面的 Agent 模块验收，原有简历不得被覆盖。

---

## 4. Agent 助手验活（v1.1.1）

```bash
npm run test:agent
```

- 服务端：会话、8 类工具、待确认/取消、版本冲突、简历新版本、上下文边界；
- Playwright：欢迎卡、只读状态、确认卡、写后刷新、390px；
- 真实 OpenRouter 四场景（需要 `OPENROUTER_API_KEY`）：

```bash
OPENROUTER_API_KEY=... OPENROUTER_MODEL=google/gemini-2.5-flash \
  node tools/smoke-agent-openrouter.mjs
```

无 key 时脚本输出 `.tmp/agent-openrouter-smoke.md` 的 BLOCKED，不伪造通过。

## 5. 全量回归

按顺序执行并记录：

```bash
npm run test:agent
npm test
npm run test:web
npm run test:e2e
npm run test:career-ai
npm run test:panel
npm run test:netease-game
npm run test:self-page
npm run test:intake
npm run test:mail-progress
npm run test:mail-admin
```

预期基线：

- `npm test` 约 226/228；仅 `cloud-persistence` / `cloud-persistence-http` 两条云快照用例可能因环境波动失败；
- 其余套件全绿；
- 任何**新增失败**都必须先修复，不能通过删除/跳过测试处理。

---

## 6. 排障

| 现象 | 处理 |
|---|---|
| 端口占用 | `lsof -nP -iTCP:4310 -sTCP:LISTEN`；换 `PORT` 或 `npm run local:stop -- --port 4311` |
| OTP 收不到 | 本地 outbox 模式执行 `npm run otp:latest`；确认邮箱在 `ALLOWED_EMAILS` |
| Playwright Chromium 缺失 | `npx playwright install chromium`，或设置 `PLAYWRIGHT_BROWSERS_PATH` |
| 插件加载失败 | 确认选择的是直接包含 `manifest.json` 的目录，不是 ZIP 或上一级目录 |
| Chrome 扩展测试超时 | 无头 Playwright 对 service worker 有环境限制；改为本机 Chrome 手工加载验收，不要据此判定业务失败 |
| `cloud-persistence` 失败 | 已知环境性云快照波动，保留日志并确认不是新增业务失败 |
| 模型接口 401/429 | 检查 `.env` 的 `AGENT_API_KEY` / `OPENROUTER_API_KEY` / `AI_API_KEY`；不要把 Key 打印到日志 |
| AI 助手无动作卡 | 检查 Agent 工具确认单是否 pending；确认前不会写库 |
| 邮件同箱重复 | 确认使用了隔离库；`npm run bench:mail-e2e` 使用临时 DATA_DIR |
| 真实授权失败 | 邮箱后台开启 IMAP 并使用客户端授权码；网易提示 Unsafe Login 时按服务商要求开启客户端授权 |

---

## 7. 交付给 AI 的固定提示词

```text
你在 /path/to/tounar-bang-ni-li 仓库工作。
先读 docs/AI-DEPLOY-AND-TEST-RUNBOOK.md 和 docs/SELF-TEST-GUIDE-V1.0.0.md，
再按环境预检 → 隔离启动 → (a)(b)(c)(d) 验活 → 全量回归的顺序执行。
不得修改业务代码、不得提交 .env/数据库/真实邮箱/授权码/.tmp 证据。
已知 cloud-persistence 两条环境性失败、无头扩展限制和 163/126/yeah.net 未真机联调，
如实记录，不要伪造通过。
```

---

## 8. 完成条件

- [ ] Node ≥ 24，依赖安装完成。
- [ ] 健康接口 200 且 version=1.1.1。
- [ ] (a)(b)(c)(d) 模块验活完成，失败项有日志与归因。
- [ ] `npm run test:web`、`test:career-ai`、`test:mail-progress` 至少抽跑通过。
- [ ] 工作区没有 `.env`、SQLite、授权码、真实邮件正文或 `.tmp/` 证据入库。
- [ ] 不把未开发的 AI 简历改写当作已实现功能。
