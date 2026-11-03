# 本机怎么验证（2026-10-24 实测过的命令）

代码目录（部署用同一个）：`/Users/mingenlin/Desktop/opencode project/帮你理`，分支 `main`。
所有验证都在 `~/tounar-acceptance/<时间戳>/` 的**副本**上做，真实库只读。

---

## 0. 一条命令起环境

```bash
cd "/Users/mingenlin/Desktop/opencode project/帮你理"
npm install                      # 第一次或换机器才需要
npm run local:acceptance
```

看到这几行就算成功：

```
✅ 已就绪：http://127.0.0.1:4311
   数据副本：/Users/mingenlin/tounar-acceptance/<时间戳>
   业务数量：用户 2 / 台账 6 / 邮件 84 / 待确认 20
```

> 本次实测用的是 `20261024-125118` 这个副本。
> 停止：`npm run local:stop`。服务是后台常驻的，关终端不会停。

---

## 1. 网页 + 登录

打开 <http://127.0.0.1:4311>：

1. 输入 `1191240794@qq.com` → 获取验证码；
2. 终端读码（不会真发信）：

```bash
node --env-file=/Users/mingenlin/tounar-acceptance/<时间戳>/acceptance.env \
     server/scripts/latest-otp.js
```

3. 登录后应该看到 **6 条台账、待确认 20 条**（不是 0，说明用的是真实库副本）。

---

## 2. 待确认：人工修改（这次修的重点）

1. 打开 <http://127.0.0.1:4311/?panel=reviews>；
2. 任选一张卡片，点「不对，我来改」；
3. **公司 / 岗位两个输入框应该直接可见、可编辑**（以前只有“按邮件新建”才出现）；
4. 两种用法都试一下：
   - 选一条已有台账 + 改岗位名 → 点「提交更新」→ 台账里那条记录的岗位名被改掉；
   - 不选记录、只填公司 + 岗位 → 点「提交更新」→ 直接新建一条；
5. 点「忽略」→ 10 秒内出现「撤销」→ 撤销后卡片回到待确认。

---

## 3. 阶段 / 轮次规则

**最快的验证是跑单测：**

```bash
node --test --test-name-pattern="阶段规则|轮次|倒序" server/test/phase2.test.js
```

（`npm test -- --test-name-pattern=…` 不会真的过滤，npm 把参数追加在文件列表后面了；用上面这条直接调 node。）

会覆盖：

- 笔试邮件只匹配笔试记录、面试只匹配面试记录；
- 只有另一阶段记录时 → `STAGE_SPLIT_REQUIRED`（提示单独建一条）；
- 同名面试邮件按时间推进：第 1 面 → 第 2 面；
- 待确认按邮件收到时间倒序。

**手工看效果**：待确认列表现在就是按收信时间倒序（第一条最新），
把「数字广东」两条笔试按邮件新建，再用一条面试邮件操作，会看到系统提示“已有记录属于另一个阶段”。

---

## 4. 提醒邮件

### 4.1 先看内容（不发真信）

```bash
D=/Users/mingenlin/tounar-acceptance/<时间戳>

# 造一条「面试后第 8 天」的【验收】记录（脚本会拒绝在真实 data/ 上运行）
node --env-file="$D/acceptance.env" server/scripts/seed-acceptance-reminder.js

# 触发提醒批次（outbox 模式：只写文件，不发信）
node --env-file="$D/acceptance.env" server/scripts/run-reminders.js
```

结果里应有 `"status": "sent", "items_b": 1`。然后看最后一封：

```bash
ls -t "$D"/outbox/*.json | head -1 | xargs -I{} node -e \
  "const r=require('{}');console.log(r.subject);console.log(r.text)"
```

重点检查：

- 主题带收信日期，例如 `【帮你理】1 条该回看了（2026-10-12收到）`；
- 每段末尾有 `—— 2026-10-12 收到`（**是原信日期，不是今天**）；
- 一条里有三个入口：直接打开申请状态页 / 我看过了，没变化 / 结果出来了，去更新。

### 4.2 真发到自己邮箱

```bash
# 起一个 smtp 实例（会真的用你 .env 里的 SMTP_URL 发信）
npm run local:acceptance -- --mail-mode smtp --port 4312

D2=/Users/mingenlin/tounar-acceptance/<新时间戳>
node --env-file="$D2/acceptance.env" server/scripts/seed-acceptance-reminder.js
node --env-file="$D2/acceptance.env" server/scripts/run-reminders.js
```

去 QQ 邮箱看这封邮件：主题、顶部日期、每段落款、页脚推送时间、三个链接能不能点开。

### 4.3 验证 sharecode 会加到链接上（不依赖线上）

```bash
SHARE_CODE=TEST123 node --env-file="$D/acceptance.env" server/scripts/run-reminders.js
```

（环境变量优先于 `--env-file`，实测 `SHARE_CODE= TEST123` 生效。）
注意同一天已发过批次会复用，想再看一封就换一个新副本。
邮件里的链接应变成 `…/?app=xxx&sharecode=YOUR_SHARE_CODE`、`…/r/rl_xxx?sharecode=YOUR_SHARE_CODE`。

---

## 5. 插件

1. `chrome://extensions` → 确认加载的是
   `…/deepseek-harness/default-workspace/tounar-bang-ni-li-phase2/extension`（或部署目录的 `extension/`）；
2. 点插件图标 →「检测本机服务」→ 应显示 `✅ http://127.0.0.1:4311；❌ …:4310`；
3. 「开始配对」→ 网页「设置 → 浏览器插件」输入配对码 → 插件显示已绑定；
4. 随便开一个招聘岗位详情页，停留 3 秒 → 台账出现该岗位（低把握字段显示“待补充”）。

---

## 6. 三套测试

```bash
npm test            # 期望 86/86
npm run test:e2e    # 期望 67/67
npm run test:web    # 期望 52/52
```

> 注意：如果路径里有空格（比如本项目在 `Desktop/opencode project/`），
> 2026-10-24 之前的版本会挂一条 P4 测试，已在 `85d831a` 修掉。

---

## 7. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `npm error Missing script: "start"` | 当前目录不是项目根；用 `npm run local:acceptance`（脚本内部用绝对路径） |
| 端口被占 | 脚本会打印占用进程；先 `npm run local:stop`，或 `--port 4313` |
| 验证码收不到 | outbox 模式本来就不发信，去 `latest-otp.js` 读；smtp 模式才真发 |
| 验证码 429 | 默认 1 小时 5 次 / 60 秒间隔；验收副本可加 `--env OTP_RESEND_SECONDS=0 --env OTP_MAX_PER_HOUR=200` |
| 提醒说 `reused` | 当天批次已存在（含空批次）；`85d831a` 之后空批次可重试，已发过的批次仍按“一天一封”复用 |
| 插件连 4310 | 默认端口是 4310，验收用 4311；点「检测本机服务」自动切 |
