# 帮你理二期：移交 Mac 本地 agent

交接日期：2026-10-23。本文记录已经完成的工作、仍然存在的问题、证据边界与接手顺序。请先完成本机验收，不要把 GitHub 分支存在或云端测试通过当作生产验收完成。

## 1. 当前结论

- P0–P3 和 P4 通用采集的代码已实现，云端隔离测试通过；真实个人数据尚未验收。
- 已推送独立 GitHub 分支 `phase2-acceptance-20261023`；`main` 未合并、未改写，未执行生产部署。
- 真实招聘页完成 **11 站 × 2＝22/26 页**，优先八家完成 **7/8**；百度和 BOSS 四页仍未完成。
- 用户 Mac 上网页和插件当前不可用。用户提供的启动错误是 **`npm error Missing script: "start"`**；本地故障尚未修复或验证。
- 云端 agent 无法读取用户 Mac：没有挂载 `/Users/...`，没有 Mac 远程工具，用户确认 **未配置 SSH**。没有实际远程连接 Mac。
- 验收禁止真实邮件发送，必须 `MAIL_MODE=outbox`。唯一真实数据库、邮箱密钥和原服务均未被本云端 agent 操作。

## 2. 任务依据与必须保留的约束

用户要求按上传的第二轮任务书审查、补齐其他 agent 未完成的项目，并把完成项、未完成项和风险如实写入二期交付。原始任务书已原样归档为 [PHASE2-ORIGINAL-PROMPT.md](PHASE2-ORIGINAL-PROMPT.md)。原文件 SHA-256：`70b3c5c3c6b109ccd06f1c17f22f56dafe5e27d666dc998aa0a40f134b66070e`。任务书是用户指定的需求依据；后续用户明确提出的数据与发信限制优先于任务书早期假设。

必须遵守：

1. 不塞演示数据，不把请求失败显示为 0 或编造结果；不要把空开发库冒充用户真实库。
2. 原数据库修改或迁移前先备份，使用 SQLite 一致备份包含已提交 WAL；迁移只允许增量加列和 meta 标记，不删表重建。
3. 插件不读取表单内容、Cookie 或上传整页正文；快照用于本地字段回归并去掉个人信息。邮件正文不整封落库，只保留摘要。
4. 用户硬要求：验收一律 `MAIL_MODE=outbox`，禁止真实 SMTP 发信。不要直接继承 `.env` 的真发信配置。
5. 建议同时强制 `SMTP_URL=`、`ENABLE_SCHEDULER=false`、`CLOUD_LLM_ENABLED=false`；只在需要验证某个批次时，对测试副本手动触发 outbox。
6. 不输出、提交或要求用户粘贴 `.env`、邮箱授权码、密钥、会话 Cookie。不要使用历史聊天中出现的凭据；本交接不保存它们。
7. 每个新增功能阶段须配回归，并在 `npm test`、`npm run test:e2e`、`npm run test:web` 全绿后单独提交。
8. 未实测站点不能标为已验证；当前 `site_verified` 只代表记录的公开详情路径，不代表登录、投递成功或全部域名。
9. 用户已经授权验收分支 push；**合并 main、生产部署与真实旧字段修复 apply 尚未授权**。不要强推或改写既有历史。

## 3. 仓库和提交位置

仓库：<https://github.com/theonlin0725/tounar-bang-ni-li>。

- main：`88b733410658947417b79b28f2d45f008ca110e9`。
- 验收分支：[phase2-acceptance-20261023](https://github.com/theonlin0725/tounar-bang-ni-li/tree/phase2-acceptance-20261023)。
- 最新功能代码：`7e00f827b621e3c62785002a5340a6135ac4f885`。
- 交接整理前的分支顶端：`187e90ff879692f44729f623f8a9e943c7ee66fa`，只更新推送状态文档。
- 本次交接补充也是文档/证据提交，具体顶端以 `git log -1` 和远端核对为准，不代表新增功能或重新执行所有测试。

| 提交 | 已完成内容 |
|---|---|
| `03b1824` | P0：原信 ID/日期链路、增量回填、待确认/详情深链、OTP 后恢复原链接 |
| `6d1164f` | P1：待确认提交、搜索/新建、批量、409、10 秒撤销、版本保护 |
| `92f90c2` | P2：邮件匹配/阈值、自动更新与撤回、推断投递时间、修订刷新 |
| `f3ec66d` | P3：原信收信日期通知、7/14/关闭阶段回看、预约锚点与频控 |
| `6f1fc56` | P4：候选评分、字段来源、SPA 身份保护、人工字段保护、旧错值修复清单 |
| `5b3dab5` | 首轮 16 页真实快照、官网选择器校准、URL 脱敏、离线回放工具 |
| `7e00f82` | 牛客/阿里校准、Airbnb 通用识别、错误页检测、popup 地址编辑竞态、去凭据导出 |
| `187e90f` | 记录独立验收分支已推送；无业务代码变化 |

原 main 已由 Git 历史完整保留，目前无需回退 main。后续若合并后需要回退，优先通过 revert 提交留痕；Git 不备份运行时数据库或密钥。

## 4. 用户 Mac 的真实数据和会话

用户提供的位置：

```text
项目/数据所在位置：/Users/mingenlin/Desktop/opencode project/帮你理
唯一真实库：     /Users/mingenlin/Desktop/opencode project/帮你理/data/tounar.sqlite
原访问地址：     http://127.0.0.1:4310
```

项目代码的实际 Git 根目录和 npm 当前目录尚未在 Mac 核实；不要只因上述数据路径存在就假定自己站在正确代码根目录。

用户报告的数量是 **台账 6 / 邮件 84 / 待确认 20 / 用户 2**，云端从未读取核实；本地接手后以实际数据为准。仓库不含原数据库、`.env`、密钥或可复用会话，无法从 GitHub 拉取它们。

- 邮箱凭据保存在 `mail_connections.credential_ciphertext/credential_iv/credential_tag`，需要同源 `data/master.key` 解密。直接复制 SQLite 而换密钥不能正常同步邮件。
- `sessions` 只保存 token hash，不能反向恢复登录会话。验收应重新 OTP 登录。
- 原 `.env` 中的 `SMTP_URL` 是真发信配置；不要 source、粘贴、打印或在验收中启用它。
- 若备份原运行环境，数据库、`master.key`、`internal-tick.token` 只在 Mac 私有位置配套保存。去凭据导出不等于完整生产备份。
- 云端导出工具会清除副本中的邮箱密文、会话、插件设备/配对和提醒确认令牌，所以新副本需要重新登录和配对；这属于预期行为。
- **不需要把真实库上传到云端才能继续。** 本地 agent 可以在 Mac 上创建并验收去凭据副本。该副本仍包含真实业务个人信息，不是匿名数据。

## 5. 当前 Mac 启动问题：已知证据与待确认项

用户执行 `npm start` 后提供的实际错误：

```text
npm error Missing script: "start"
npm error To see a list of scripts, run:
npm error   npm run
```

已知：GitHub 验收分支根目录 `package.json` 明确包含：

```json
"start": "node --env-file-if-exists .env server/src/index.js"
```

这意味着用户执行时 npm 没有读取到包含该脚本的正确配置；可能是终端目录、代码副本或 npm 工作区选择问题。**不能仅凭这段输出确定是哪一个目录，也不能确认 Mac 已切换到验收分支。** 此前对话直接说“目录不对”过于确定，本地 agent 需要实际核实。

尚未取得：Mac 的 `pwd`、实际 package.json、当前 Git 分支/提交、Node/npm 版本、监听进程及具体启动环境。项目要求 **Node ≥24**，但本次错误本身并不能证明是 Node 版本导致。

先在 Mac 执行只读诊断：

```bash
pwd
git rev-parse --show-toplevel
git status --short
git branch --show-current
git log -1 --oneline
node -v
npm -v
npm run
node -p 'JSON.stringify(require("./package.json").scripts)'
lsof -nP -iTCP:4310 -sTCP:LISTEN
lsof -nP -iTCP:4311 -sTCP:LISTEN
```

若当前目录不是正确根目录，先定位含上述 `package.json` 的项目，不要给错误目录临时添加一个 start 来掩盖原因。`npm --prefix "/已核实的代码根目录" start` 可以消除终端当前目录的歧义，但仍必须设置测试数据目录及禁止发信的环境变量，不能直接指向原库。

另一个必须处理的地址差异：原默认端口是 **4310**，隔离验收文档使用 **4311**。如果测试服务实际监听 4311，网页和插件后台都应设为 `http://127.0.0.1:4311`。浏览器 `127.0.0.1` 指向浏览器所在机器，GitHub push 不会启动 Mac 上的服务。

本次没有对用户 Mac Chrome 重新加载扩展、修改后台地址、重新配对或恢复服务；这些工作仍由接手的本地 agent 执行。

## 6. 代码具体实现与阅读入口

| 范围 | 最值得先读的文件 | 当前行为 |
|---|---|---|
| 原信关联与迁移 | `server/src/db.js`、`domain/mailSync.js`、`domain/ledger.js` | 回填原信 ID/收信日期，增量迁移及幂等 |
| 待确认 | `server/src/domain/reviews.js`、`web/assets/js/views/reviews.js` | 无候选可搜索/新建，中文提示，逐条批量、409 刷新、撤销和版本保护 |
| 邮件联动 | `server/src/domain/mailMatching.js`、`mailParser.js`、`applications.js` | 公司/岗位/域名线索匹配，分类分×匹配分，非终态 0.8、终态 0.9，保留回退/终态保护 |
| 台账与详情 | `web/assets/js/views/ledger.js`、`detail.js`、`web/assets/js/app.js` | 60 秒/获焦检查修订，自动更新提示和撤回，低把握待补充，深链恢复 |
| 提醒 | `server/src/domain/reminders.js`、`web/assets/js/views/settings.js` | 原信日期、日期范围、三类链接、7/14/关闭阶段回看、预约锚点/推进/确认/频控 |
| 插件 | `extension/content/{tracker,adapters}.js` | 逐字段评分/来源、低把握留空、SPA 安静后识别、人工字段保护 |
| 插件弹窗 | `extension/popup/popup.js` | 编辑中的后台地址不会被刷新覆盖，忽略过期刷新，保存失败如实显示 |
| 安全验收副本 | `server/scripts/export-acceptance-copy.js` | 只读源库、SQLite backup、清凭据/令牌、清空闲页、私有权限、完整性检查 |
| 旧字段修复 | `server/scripts/repair-captured-fields.js` | 默认只读 dry-run，apply 需要已审阅计划/confirm，自动备份并锁内复查版本 |
| 站点工具 | `tools/{probe-site,tryrun-plugin,replay-sites,site-page-state,site-snapshot}.mjs` | 真实页取证、脱敏、错误页拒绝、同 DOM 前后回放 |

域名或公司别名匹配只是线索，未新增 SPF/DKIM 身份核验。规则分不是经过个人真实邮箱效果统计的概率；终态普通公司+岗位拒信可能仍因乘积不足 0.9 进入人工确认，这是当前阈值设计的结果。

## 7. 已执行的测试和证据边界

执行环境：Linux 云工作区，Node 24.19.0 / npm 11.9.0 / 官方 Playwright Chromium 156。没有把这些结果写成 Mac 实机结果。

| 检查 | 最后实际结果 | 证据 |
|---|---|---|
| 后端/工具 `npm test` | **81/81**，0 失败/跳过 | 云端 `/tmp/phase2-final-unit.log`；用例在 `server/test/` |
| 插件 `npm run test:e2e` | **63/63** | 云端 `/tmp/phase2-final-extension.log`，含 22 个真实快照 |
| 网页 `npm run test:web` | **51/51** | 云端 `/tmp/phase2-final-web.log` |
| 当前真实 DOM 回放 | **22/22** 预期一致 | `tests/fixtures/sites/replay-results.json` |
| 原 main 同 DOM 基线 | 22 页，保留旧错误与空值 | `tests/fixtures/sites/baseline-88b7334.json` |
| 最新启动/插件连通烟测 | **7/7** | [已归档 JSON](evidence/LOCAL-START-VERIFICATION-20261023.json) |

7 项烟测于 2026-10-23 12:34 UTC 完成，代码 `187e90f`（与 `7e00f82` 的业务代码相同）：

1. 从 `/tmp` 用 `npm --prefix <正确代码目录> start` 成功启动；监听 4311，独立空测试库，outbox，调度关闭。
2. `/api/v1/health` 返回 200（**不是 `/health`，后者是 404**）。
3. 首页返回 200。
4. 浏览器使用测试 outbox OTP 登录成功，测试账号台账为空。
5. Chromium 中实际加载扩展，弹窗可达该 4311 后台。
6. 插件配对通过已登录网页会话批准并完成绑定。
7. 登录后待确认深链正常打开。

烟测测试服务已停止；它不是可供用户 Mac 浏览器访问的云预览。测试扩展构建只在临时副本声明 localhost 权限，未给生产 manifest 加测试权限，也没有修改用户本机扩展。烟测初版静态 HTML 断言误用了运行时 DOM 节点，修正测试断言后完成 7/7；这次未修改业务代码。

较早一次插件全量测试确实出现配对批准 404：后台刷新覆盖尚未保存的地址，配对去了错误服务。该业务问题已在 `7e00f82` 修复并加回归，之后 63/63。不要把这次已修复竞态与 Mac 当前的 Missing script 混为同一个错误。

日志路径 `/tmp/...`、`.tmp/...` 和浏览器缓存属于云环境，不在 GitHub，也不会自动出现在 Mac；已归档的 JSON、测试源码、真实快照和交付报告可以从验收分支取得。不要要求用户上传整个 outbox 或含会话/令牌的原始日志。

## 8. 真实站点完成度与未完成项

| 站点 | 有效详情 | 范围/限制 |
|---|---:|---|
| 腾讯 | 2/2 | careers.tencent.com jobdesc 公开浏览态 |
| 字节 | 2/2 | 校园详情，既有历史岗位重验通过 |
| 阿里 | 2/2 | talent-holding.alibaba.com 社招，CSS 模块选择器可能随部署变化 |
| 美团 | 2/2 | 官网 web/position/detail |
| 京东 | 2/2 | 新社会招聘 job-info-detail；旧列表需登录，校园入口未验 |
| 小米 | 2/2 | 旧版招聘库，列表年份 2017，不证明岗位仍开放 |
| 百度 | **0/2** | headless 与有界面 Chromium 均跳 about:blank，仍为草案 |
| 网易 | 2/2 | 中文详情 lang=zh |
| BOSS | **0/2** | 安全验证或账号入口，无可验收详情，仍为草案 |
| 牛客 | 2/2 | 当前公开详情；公司名称与岗位城市已修正 |
| 实习僧 | 2/2 | 公开实习详情，字体乱码字段保守留空 |
| 米哈游 | 2/2 | 白名单外，generic；公司/城市留空 |
| Airbnb | 2/2 | 第二家白名单外，generic；公司/城市留空 |

拼多多官方入口失败，按任务书“白名单外任选”改用 Airbnb，因此拼多多不再作为 26 页中的必选站。Airbnb 另一个 61 字符标题因任务书 2–60 字上限被排除，失败样本另列，未算入 22 页成功样本。

22 页共 154 字段：原 main **正确 68 / 错误 36 / 空 50**；当前 **正确 128 / 错误 0 / 空 26**。26 空项是 18 个无明确批次和白名单外公司/城市八项，不算正确。已完成七家优先官网 14 页，公司+岗位 28/28 正确，城市/JD 各 14/14 正确；不能外推百度或所有页面。

**程序顺序偏差**：真实取证在改造后才恢复，所谓“改造前”是用 `88b7334` 原脚本回放同一真实 DOM 的离线重建，不是动手前先完成的线上摸底。此偏差已披露，不能改写成原任务顺序完全满足。

证据见 [SITE-ADAPTER-EVIDENCE.md](SITE-ADAPTER-EVIDENCE.md) 和 `tests/fixtures/sites/{cases,live-results,baseline-88b7334,replay-results,blocked-results}.json`。所有官网真实登录、投递成功和账号投递记录页均未验收；没有替用户提交过职位申请。

## 9. 本地 agent 接手执行顺序

### A. 先定位目录，隔离代码

1. 读取本文、原始任务书、README 决策表及二期交付报告，实际执行第 5 节只读诊断。
2. 保留本机未提交改动；不 `reset --hard`、不 `git clean`、不覆盖 `.env`、不复制模板替换用户配置。
3. 从正确仓库 fetch 验收分支，创建独立 worktree 或全新 clone；不改变原 main 的代码与运行数据。若用 worktree，可在已核实 Git 根目录执行：

```bash
git fetch origin phase2-acceptance-20261023
LOCAL_ACCEPTANCE_ROOT=$(mktemp -d /tmp/tounar-local-acceptance.XXXXXX)
git worktree add --detach "$LOCAL_ACCEPTANCE_ROOT/repo" origin/phase2-acceptance-20261023
```

变量值应保留在本机并记下，后续不要混用不同目录。确认 Node ≥24，再在新 worktree 内 `npm ci`。如果需要修复代码，从该 worktree 新建自己的修复分支留痕。

### B. 先备份，再在副本启动

1. 先识别原服务和写入者，按用户要求停原服务后对真实库做一致备份，并在 Mac 私有位置保留同源密钥；不要杀不明进程或删除唯一原库。
2. 使用新 worktree 中的 `server/scripts/export-acceptance-copy.js`，以已核实原数据库路径为 `--db`，在新的私有目录生成去凭据导出。该工具独立运行，不会导入 `.env` 或迁移原库。
3. 再用导出工具把第一份导出复制到另一新的运行目录，保留第一份不变，作为迁移前基线。两个 `--out` 目录都必须不存在；工具拒绝覆盖是有意保护，不要为通过命令而删掉已有备份。
4. 核对实际业务计数。不要把生成空库后的 0 条当作用户数据“已恢复”。
5. 运行副本启动命令见 [REAL-DATA-ACCEPTANCE.md](REAL-DATA-ACCEPTANCE.md)。必须显式指定副本 `DATA_DIR`、`DB_PATH`、4311 与 outbox；不要在原目录裸跑 `npm start` 触发原库迁移。

启动命令形式如下，路径由本地 agent 替换为本次实际创建的目录；原库不得填在 `DB_PATH`：

```bash
DATA_DIR="/本次运行副本目录" \
DB_PATH="/本次运行副本目录/tounar.sqlite" \
HOST=127.0.0.1 PORT=4311 APP_BASE_URL=http://127.0.0.1:4311 \
MAIL_MODE=outbox SMTP_URL= ENABLE_SCHEDULER=false CLOUD_LLM_ENABLED=false \
ALLOWED_EMAILS=1191240794@qq.com \
npm --prefix "/本次验收代码根目录" start
```

不要直接复制占位路径执行。保持启动终端运行；读取启动输出中的实际监听端口，不把 npm 进程存在当作健康检查通过。

### C. 恢复网页与插件的验收入口

1. 本机访问 `http://127.0.0.1:4311/` 和 `/api/v1/health`；应分别正常显示页面和返回 200。
2. 用副本中的本人账号申请 OTP，在相同 `DATA_DIR` 的 outbox 中读取；不要真的发验证码邮件。可以使用 `DATA_DIR=... npm --prefix <代码目录> run otp:latest`。
3. Chrome 扩展确认加载自本次验收 worktree 的 `extension/`；需要时在 `chrome://extensions` 重新加载，避免仍运行旧路径的扩展。
4. 插件后台设为 `http://127.0.0.1:4311` 并保存，检查“后台可达”。不要仍指向默认 4310 或 GitHub 网页地址。
5. 副本中原设备记录已清除，需要使用测试账号重新配对；如旧令牌仍存在，在 UI 中解除旧绑定后重新绑定，保留本地队列，不直接删扩展数据掩盖问题。
6. 如健康接口可访问而插件不可达，再收集扩展权限、service worker 错误和实际后台地址定位；不要先归因于服务端回归。

### D. 完成真实业务验收

- 在运行副本核实用户报告的四项业务数量、迁移前后数据保留与重复启动幂等。
- 对现有待确认逐项测试：点击路径、接口状态、关联/新建、台账变化、计数、历史、撤销和版本冲突。真实归属不确定时列出需用户判断的项，不能替用户编造归属正确。
- 验证原信日期、推断投递时间显示、登录后深链、阶段回看及本地 outbox 内容；不能据此声称真实 SMTP 送达通过。
- 在本地正常公开页面尝试百度/BOSS 各两页，保留真实 DOM、七字段表和失败证据，不修改站点验证机制来凑数量。
- 只在已迁移的运行副本上运行 `repair-captured-fields.js` 的 dry-run，保存私有计划；真实原库 apply 仍需具体审阅与备份后另行授权。
- 代码有新改动时补必要测试并执行三套门禁；不要把历史云端全绿替代本地受影响回归。浏览器路径应使用 Mac 实际安装路径，不照抄 Linux 缓存路径。
- 更新 [PHASE2-DELIVERY.md](PHASE2-DELIVERY.md)，明确哪些是本地实测、哪些仍受限。完成后再申请合并 main / 生产部署。

## 10. 尚未完成或已知风险清单

- Mac 启动故障未修复，未验证 Mac 当前仓库副本、Node、监听与扩展。
- 真实库未读取，20 条待确认未逐条走通，真实旧数据迁移/回填/回看尚未验收。
- 去凭据副本不支持真实 IMAP；本轮真实 SMTP 按用户要求禁止，不能标为通过。
- 百度/BOSS 四页和全部官网登录/投递态未验收；小米样本是旧库；阿里 CSS 模块类名可能变化。
- 通用规则在米哈游/Airbnb 公司、城市留空；61 字标题被上限排除，属于已知漏采。
- SPA 同 URL、同标题且缺乏独立岗位 ID 时仍可能需人工归属；不能承诺所有异步切换无歧义。
- 邮件分类与匹配分是规则分，未做真实个人邮箱准确率统计；发件域名不是身份认证。
- 旧错值修复规则可能误报，只交付了 dry-run/人工审阅机制，真实数据没有 apply。
- `bangnili.app.workbuddy.host` 是 README 记录的历史线上地址，不能假设其持有用户 Mac 的真实库；部署目标和持久化方式仍需确认。
- 原任务要求“先摸底再动手”的顺序没有完全满足；当前比较是离线重建，不应隐去。

## 11. 云环境信息及不可依赖的临时产物

用户后来授权补齐开发网络，取代此前“暂不应用”。原 41 域名加 `fc.alibaba.com`、`wappass.baidu.com`、`talent-holding.alibaba.com`、`careers.airbnb.com` 共 45 项草稿已保存；所需四个域名已实际访问。但工具只保存草稿并返回 `requires_publish`，不能因此宣称开发环境快照已发布，更不代表生产部署。

云端使用用户授权的系统公开代理 CA 与正常 Chromium NSS 信任；没有禁用 TLS 校验或修改 HOME。普通沙盒 NSS 只读曾导致 HTTPS 问题，有界面诊断使用用户目录 Xvfb。**这些是云端限制，本地 agent 不应直接给 Mac 导入云端代理 CA 或复刻云端网络规则。**

云端 `/workspace/phase2-delivery.bundle` 是代码历史备份，`git bundle verify` 已验证过，不含 data/.env/密钥；本次交接完成后会更新一次。此前 `.tmp/backups/pre-phase2-1792719162067.sqlite` 是开发空库备份，绝不是 Mac 真实库备份。两者都不能替代本机原库备份。

临时烟测脚本与日志不作为产品交付的一部分；已归档的报告、测试源码、真实快照和原始任务书在 GitHub 验收分支。云端曾保留旧开发服务 4310，这不说明 Mac 4310 正在运行，也不能用于验收本机业务数据。

## 12. 接手后向用户汇报的最小内容

实际操作了哪个代码目录/提交、是否找到原库、原库备份位置（不含秘密）、隔离库位置/实际数量、服务监听地址、网页和插件是否恢复、20 条待确认逐项结果、站点剩余项、测试结果、是否有真实库写入，以及仍需用户判断或授权的事项。

在没有新证据前，准确表述是：**代码已在验收分支并通过云端隔离测试；Mac 服务、真实数据和剩余站点验收仍待本地完成。**
