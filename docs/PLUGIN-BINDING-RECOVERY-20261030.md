# 插件绑定与 4311 自测库恢复记录（2026-10-30）

## 结论

采用**“以旧验收库为业务基线、复制到独立固定目录、原库和当前库都不覆盖”**的方式恢复。没有解除插件绑定、没有重新配对、没有清空本地队列、没有覆盖项目根库或旧验收库。

恢复后的固定自测库为：

```text
data/mail-selftest/            ← 4311 使用的新固定副本（已恢复）
data/mail-selftest-profile.json ← 固定指针，启动时校验数据库身份和预期设备
data/recovery-backups/2026-10-30T15-43-20-964Z/ ← 恢复前的一致性备份
data/recovery-backups/2026-10-30T15-53-20-162Z-post-recovery/ ← 插件补传后的一致性备份
```

4311 不再默认复制 `.tmp/mail-selftest` 或根 `data/tounar.sqlite`；profile、数据库身份或预期插件设备任一不匹配时，启动直接停止，不会静默换库。

## 为什么选择这个方案

对照四份库：

| 库 | 台账 | 设备 | 目标设备 `dev_NaDfl…` | 结论 |
|---|---:|---:|---|---|
| 旧验收库 `~/tounar-acceptance/20261025-060103` | 40 | 2 | 存在、未撤销、2027-04-24 到期 | **业务基线** |
| 恢复前 4311 库 `.tmp/mail-selftest` | 6 | 1 | 不存在 | 不能直接继续使用 |
| 项目根 `data/tounar.sqlite` | 6 | 1 | 不存在 | 不能覆盖旧库 |
| `.tmp/acceptance-smtp-20261030` | 6 | 1 | 不存在 | 另一份测试副本 |

旧验收库是 40 条台账的真子集来源；恢复前的 6 条台账全部包含在旧库中，没有“只在新库存在”的业务台账。邮件模板／投递／测试记录在恢复前库中也是 0 条，因此不需要把旧库覆盖到新库，也不需要做复杂双向合并。复制旧库可以同时保住：

- 目标插件设备的令牌哈希和绑定版本（不读取原始令牌）；
- 40 条台账、54 条复核项、112 条事件、105 封邮件记录；
- 原 `mail_connections` 和邮件游标；
- 同一把 `master.key`（旧库、根库、恢复副本三者哈希一致，加密凭据仍可解密）。

重新配对会改变设备身份，且客户端解除配对默认可能清空队列，因此没有采用。

## 实际执行

1. 用 SQLite backup API 对**旧验收库**和**恢复前 4311 库**做一致性备份（含 WAL），保存到 `data/recovery-backups/2026-10-30T15-43-20-964Z/`，权限 700；备份内保留 master key 和 env 副本，均为 600。
2. 以旧验收库的备份为基，创建新的 `data/mail-selftest/tounar.sqlite`；通过 `openDatabase` 执行当前代码的增量 schema 迁移。
3. 将恢复前 4311 库中“新库不存在”的邮件表行导入（本次为 0 行）；对已存在行只允许人工审阅过的字段冲突，不覆盖业务数据。
4. 复制同源 `master.key`、`internal-tick.token`；写入 `acceptance.env`（保留当前 SMTP/管理员/测试收件人配置）。
5. 写入固定 profile：`id`、`data_dir`、`recovered_from`、`backup_dir`、`expected_device_id=dev_NaDflQAaoK0H4d3b`。
6. 启动校验：数据库 `selftest_profile_id` 匹配；预期设备存在、未撤销、未过期、账号未删除；`PRAGMA integrity_check=ok`、`PRAGMA foreign_key_check=[]`。
7. 用 `npm run mail:selftest` 启动 4311，验证健康检查、管理员自测登录、设备列表和台账读取。
8. 插件自动补传 4 条事件后，再做恢复后一致性备份 `data/recovery-backups/2026-10-30T15-53-20-162Z-post-recovery/`：41 条台账、116 条事件、55 条复核项、2 台设备，`integrity_check=ok`、外键检查通过，master key 与运行库一致。

恢复没有修改：

- 项目根 `data/tounar.sqlite`；
- 旧验收库 `~/tounar-acceptance/20261025-060103`；
- 恢复前的 `.tmp/mail-selftest`；
- `.tmp/acceptance-smtp-20261030`；
- 插件本地存储或队列。

## 恢复后核对

固定副本：

- 台账 **40**（39 条属于 `1191240794@qq.com`，1 条属于 `demo@tounar.local`）；
- 设备 **2**：`dev_xy6rXP-f6deJuCjl`、`dev_NaDflQAaoK0H4d3b`，均未撤销、绑定版本 1；
- 目标设备到期时间 **2027-04-24**，所属账号未处于删除阻断；
- 邮件记录 105，QQ 连接 1（`1191240794@qq.com`，`headers_only`）；
- 台账状态（恢复完成时）：已投 1、面试 1、待定 38；复核项 open 42、resolved 12；
- `mail_template_versions`、`mail_deliveries`、`mail_test_runs` 为 0，管理员首次保存时按代码默认模板生成版本。

4311 服务：

- `/api/v1/health` 200；
- 管理员自测登录成功，`/api/v1/me` 返回 `is_admin=true` 和两台设备；
- `/api/v1/admin/mail` 返回 SMTP 已配置、5 个模板、38 条未归档台账记录；
- 服务以 `HOST=127.0.0.1`、`ENABLE_SCHEDULER=false`、`MAIL_MODE=smtp` 启动，启动本身不发送邮件；
- `ENABLE_SELFTEST_LOGIN=true` 仅存在于固定自测副本的 `acceptance.env`，普通 `npm start`/生产不设置。
- 普通 `npm start` 的 4310/根 `data/tounar.sqlite` 仍是 6 条旧基线，未用于本次恢复；插件指向 4311，不要用 4310 判断恢复结果。

插件真实链路已恢复并实际补传：服务启动后目标设备在 **2026-10-30T15:50:10Z** 更新 `last_event_at`，事件从 112 增至 116，新增 4 条事件；应用从 40 增至 41，新增的是“小红书 · 【2027校招】体验运营”（事件实际发生于 12:10，队列延迟上传）。4 条事件按同一 owner 入库，`client_event_id` 无重复。服务重启后目标设备又在 **15:55:52Z、16:00:52Z** 连续成功心跳，说明插件绑定在重启后仍有效。另有 1 条把 `127.0.0.1:4311` 台账页面自身当作岗位的空证据进入待确认（open 复核 43），这是采集误判，不是绑定失败；本轮没有擅自删除用户数据。

回归结果（2026-10-30 本次代码）：

| 检查 | 结果 |
|---|---:|
| `npm test` | **150/150**，15 suites，0 fail |
| `npm run test:web` | **57/57** |
| `npm run test:mail-admin` | 通过（模板试发、修改、恢复、约束、业务通路、权限、窄屏；全部 outbox） |
| 管理员自测登录浏览器验证 | 验证码 6 位、页面显示“未发送邮件”、登录后管理面板可进入 |
| 插件真实事件补传 | 4 条，目标设备认证通过，无重复 `client_event_id` |
| `npm run test:e2e` | **67/67** |
| `npm run test:plugin-backend` | **4/4** |
| `npm run test:plugin-acceptance` | **18/18** |

## 管理员本机自测登录（受控后备通道）

为避免 SMTP 故障时无法进入管理面板，新增一个**默认关闭、仅本机开发**的 OTP 回显：

- 仅在 `ENABLE_SELFTEST_LOGIN=true`、`APP_ENV=development`、`APP_BASE_URL` 为 `http://127.0.0.1`/`http://localhost`、请求来自回环地址、邮箱同时在 `ADMIN_EMAILS` 和 `ALLOWED_EMAILS` 时生效；
- 管理员在登录页输入邮箱并点“获取验证码”，验证码直接显示并填入，**不发送 SMTP 邮件**；
- 仍是正常 6 位 OTP、仍写 `otp_challenges`、仍受发送频率和尝试次数限制；审计表记录 `auth.selftest_otp_issued`，不记录验证码；
- 普通用户、非回环请求、生产域名或开关关闭时完全走原发信流程；
- `npm run mail:selftest` 自动设置该开关；普通 `npm start`/生产默认关闭。需要彻底关闭时停止服务，移除或设为 `false` 后重启。

这不是通用隐藏密码，也不提供跨网络/非管理员权限提升；本机文件和终端访问本身就是信任边界。不要把 4311 暴露到局域网或公网。

## 自测步骤

```bash
cd "/Users/mingenlin/Desktop/opencode project/帮你理"
npm run mail:selftest
```

1. 打开 <http://127.0.0.1:4311/>。
2. 测业务通路请用 `1191240794@qq.com`（恢复台账属于它）；`theonlin7@gmail.com` 也可登录，但没有这批台账，只适合测模板/发信。点“获取验证码”。
3. 页面会显示并自动填入本机自测验证码；点“验证登录”。
4. 顶栏进入“邮件测试与模板”；先用“A · 模板试发”验证页面/模板，再用“B · 业务通路”选择本人台账并发送到测试邮箱。
5. 真实收件箱仍需你手工核对；`accepted` 只代表 SMTP 受理。

停止服务但保留数据：

```bash
npm run mail:selftest:stop
```

## 回滚

1. `npm run mail:selftest:stop`。
2. 如需回到恢复前状态，保留当前 `data/mail-selftest` 作为证据，把 `data/recovery-backups/2026-10-30T15-43-20-964Z/` 中的 `prepared-profile.json` 和源库副本恢复到新的目录；不要覆盖旧验收库和项目根库。
3. 若只是停止使用自测服务，直接停止即可；根库和旧验收库从未被改动。

## 边界

- 本次没有发送真实 SMTP 邮件，也没有点击插件“解除绑定”/“清空队列”。
- 本次没有读取或输出插件原始设备令牌；只核对数据库中的设备 ID、令牌哈希、绑定版本、到期和撤销状态。
- 本次没有重新访问真实招聘站、真实 QQ IMAP 或云端模型；插件协议回归见 `docs/MAIL-CHANGE-PLUGIN-AUDIT-20261030.md` 与 `.tmp/plugin-mail-audit/`。
- 固定副本包含真实业务数据和邮件内容，已加入 `.gitignore`（`data/mail-selftest/`、profile、recovery-backups）；不得提交或上传。
