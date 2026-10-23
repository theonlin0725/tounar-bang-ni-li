# 本地验收清单（你自己点一遍就能确认）

本机实测环境：macOS / Node v26.8.1 / Chrome for Testing 156 / 分支 `phase3-local-fix-20261023`
真实库只读，验收用副本：`~/tounar-acceptance/<时间戳>/`。

## 0. 一条命令启动

```bash
cd /Users/mingenlin/Documents/deepseek-harness/default-workspace/tounar-bang-ni-li-phase2
npm run local:acceptance
```

看到 `✅ 已就绪：http://127.0.0.1:4311` 即可。它会自己：检查 Node ≥24 → SQLite backup 复制真实库（含 WAL）
→ 复制同源 `master.key`（否则邮箱凭据解不开）→ 检查端口没被占 → 用显式地址启动 → 自己验 health 和首页。
进程是后台的，**关掉终端也不会停**。停：

```bash
npm run local:stop
```

## 1. 网页

- [ ] 打开 <http://127.0.0.1:4311/>，用 `1191240794@qq.com` 获取验证码
- [ ] 验证码从副本 outbox 读（不会真发信）：`node --env-file=<副本>/acceptance.env server/scripts/latest-otp.js`
- [ ] 登录后台账显示 6 条（不是 0，说明用的是真实库副本而不是空库）
- [ ] 打开 `http://127.0.0.1:4311/?panel=reviews`，应直接进待确认，共 20 条（或 16，如果你已处理过副本）

## 2. 插件

- [ ] `chrome://extensions` 确认加载的是 **这个 worktree** 的 `extension/`，不是 `Desktop/opencode project/帮你理/extension`
- [ ] 点插件图标 →「检测本机服务」→ 应显示 `✅ http://127.0.0.1:4311；❌ …:4310（连接被拒绝）` 并自动填入保存
- [ ] 「后台可达」出现
- [ ] 「开始配对」→ 网页登录后到「设置 → 浏览器插件」输入配对码 → 插件显示「已绑定」

## 3. 待确认

- [ ] 每条卡片能看到：一句话结论、把握度、原信收到日期
- [ ] 展开证据能看到主题、域名、正文片段
- [ ] 任选一条：搜索本人台账关联 / 按邮件新建 / 忽略，三个按钮都能点
- [ ] 忽略后 10 秒内点撤销，记录回到待确认
- [ ] 两个标签页同时改同一条，后提交的提示“这条刚被更新过”

## 4. 邮件（真实发信）

副本用 outbox 时**不会真发**。要真发：

```bash
npm run local:acceptance -- --mail-mode smtp --port 4312
node --env-file=~/tounar-acceptance/<时间戳>/acceptance.env server/scripts/run-reminders.js
```

- [ ] 邮箱收到主题形如 `【帮你理】N 条该回看了（X月X日收到）`
- [ ] 顶部有「收信 / 进展日期」，每段末尾有「—— X月X日 收到」
- [ ] 页脚有推送时间
- [ ] 三个链接（直接打开状态页 / 我看过了没变化 / 结果出来了去更新）点开都对，域名是 `127.0.0.1:4312`
- [ ] 点「我看过了，没变化」后，同一条 7 天内不再提醒

> 注意：CLI 一定要带 `--env-file=<副本>/acceptance.env`，否则链接会指回默认 4310（本轮已踩过）。

## 5. 抓取

- [ ] 在插件里授权一个招聘站点，打开真实岗位详情，停留 3 秒
- [ ] 台账出现该岗位，字段把握度低的显示“待补充”而不是乱填
- [ ] 已测试通过的：腾讯/字节/阿里/美团/京东/网易/小米/牛客/实习僧 + 米哈游/Airbnb（22 页）
- [ ] **未通过**：百度（实时跳 about:blank）、BOSS（安全验证）、小红书（认不出）

## 6. 收尾

- [ ] `npm test` 81/81、`npm run test:e2e` 63/63、`npm run test:web` 51/51
- [ ] 确认原库没有被写过：`ls -l "/Users/mingenlin/Desktop/opencode project/帮你理/data/tounar.sqlite"` 的时间应停在 2026-10-22 17:00
