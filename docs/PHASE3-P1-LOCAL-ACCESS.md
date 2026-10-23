# P1 · 本地阻塞解除记录（2026-10-23 本机实测）

本轮代码目录：`/Users/mingenlin/Documents/deepseek-harness/default-workspace/tounar-bang-ni-li-phase2`
分支：`phase3-local-fix-20261023`（基线 `phase2-acceptance-20261023` @ `1ca627a`）
Node：v26.8.1 / npm 11.19.0（用 `/opt/homebrew/bin/node`）

## 1. 用户看到的两个现象，真实原因是什么

### 1.1 `npm error Missing script: "start"`

在本机复现了两种输出，两者的报错**完全不同**：

| 当前目录状态 | 实际报错 |
|---|---|
| 有 `package.json`，但里面没有 `start` | `npm error Missing script: "start"` |
| 没有 `package.json` | `npm error ENOENT ... Could not read package.json` |

用户看到的是前者，所以当时终端所在目录**有一个 package.json 但没有 start 脚本**。
本机检查结果：

- `帮你理/package.json` 有 `start`（`node --env-file-if-exists .env server/src/index.js`）；
- 验收分支 worktree 的 `package.json` 也有 `start`；
- 该项目下其它子目录（`web/`、`extension/`、`server/`、`data/`）都**没有** package.json。

结论：当时的 cwd 不在项目根。具体是哪一个目录，现场已经不可考（没有终端历史），
但**不是 Node 版本问题，也不是代码缺脚本**。这也解释了为什么 `/api/v1/health` 一直没人应答。

现在不需要再猜目录：`npm run local:acceptance` 用绝对路径启动 `server/src/index.js`，
从哪个目录执行都行。

### 1.2 插件“后台未接通”

- 原默认地址 `http://127.0.0.1:4310`（`extension/lib/common.js`）。实测 4310/4311 上当时都没有监听进程。
- 服务端 CORS 正常：带 `Origin: chrome-extension://…` 的请求能拿到 `Access-Control-Allow-Origin`，
  所以不是跨域问题。
- 本机 shell 有 `HTTP(S)_PROXY=http://127.0.0.1:57109`，curl 不带 `--noproxy '*'` 会拿到代理的 502，
  容易误判成服务坏了。本轮的脚本与验证全部用 Node `http`/`fetch`（不走代理）或 `curl --noproxy '*'`。

## 2. 本轮新增

| 文件 | 作用 |
|---|---|
| `server/scripts/local-acceptance.js` | 一条命令：Node 版本检查 → backup API 复制真实库（含 WAL）→ 复制同源 `master.key`/`internal-tick.token` → `lsof` 端口检查（不杀进程）→ 显式 `DATA_DIR/DB_PATH/HOST=127.0.0.1/PORT=4311/APP_BASE_URL` 启动 → 轮询 health 与首页 → 打印 ✅ 与停止方式 |
| `server/scripts/local-stop.js` | 只停“由本验收目录启动、命令行含 `server/src/index.js`”的进程；SIGTERM → 等待退出 |
| `extension/lib/api.js` | fetch 失败分类：地址格式错 / 超时（8s AbortController）/ 连接被拒绝；HTTP 404 给出“这个地址不是帮你理”的提示 |
| `extension/background/service-worker.js` | health 失败时把 `message` 一起返回给 popup |
| `extension/popup/popup.js` + `popup.html` | 「检测本机服务」按钮：探测 4311 → 4310，找到即自动填入并保存；失败显示每个地址的具体原因 |
| `tests/e2e/local-acceptance-verify.mjs` | 真实 Chromium + 未打包扩展，对已运行的验收实例做 11 项端到端验证 |
| `docs/acceptance/phase3/*.png` + `verify-report.json` | 截图与报告（popup 里邮箱与设备 ID 已脱敏） |

## 3. 实测结果（2026-10-23 21:20–21:24）

```bash
npm run local:acceptance
# ✅ 已就绪：http://127.0.0.1:4311
# 数据副本：/Users/mingenlin/tounar-acceptance/20261023-132023
# 业务数量：用户 2 / 台账 6 / 邮件 84 / 待确认 20
```

- 进程 detached（pid 64250），关掉终端后 `ps` 仍在；`npm run local:stop` 可正常停止。
- `/api/v1/health` 200，`/` 200（1030 字节）。
- `node tests/e2e/local-acceptance-verify.mjs` → **11/11 通过**：
  health / 首页 / outbox 验证码登录 / 扩展加载 / 检测本机服务 / popup 显示后台可达 /
  配对码 / 网页会话批准 / 插件已绑定 / 绑定文案 / 服务端设备列表。
- 截图见 `docs/acceptance/phase3/01..04`。

注意：验收副本启动时 phase2 的迁移会把 `review_items.source_mail_id` 回填——
原库是 0/20，副本变成 16/20（4 条本来就没有对应邮件）。这是预期迁移行为，原库未被写入。

## 4. 插件默认地址：建议

- **不改生产默认值**（`common.js` 仍是 4310）。理由：4310 是一期以来的默认端口，改默认值会影响
  已发布版本的说明与线上文档，收益不抵风险。
- 本机验收用「检测本机服务」按钮自动切到 4311，一次性解决“地址对不上”。
- 如果用户希望默认就指向 4311，需要明确拍板，再单独改。

## 5. 扩展加载来源（必须确认）

Chrome 里可能还装的是 `Desktop/opencode project/帮你理/extension`（一期那版）。
请到 `chrome://extensions` 确认来源路径是：

```
.../default-workspace/tounar-bang-ni-li-phase2/extension
```

如果还是旧路径：移除旧扩展 → 「加载已解压的扩展程序」→ 选上面这个目录 → 重新配对。
