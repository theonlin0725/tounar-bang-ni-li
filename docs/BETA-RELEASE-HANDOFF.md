# “帮你理”内测发布交接

状态：**`20261102-beta4` 发布候选已完成本地与真实云隔离验收，尚未部署。** 当前线上仍是 `20261102-beta3`，尚未启用云持久化。

## 1. 应用与数据影响

| 项 | 当前结论 |
|---|---|
| 应用 | 复用 `wbapp_Yw3dKlnEp4jVVAuyNDilAW`，不新建应用 |
| 域名 | `https://bangnili.app.workbuddy.host` |
| 候选版本 | `20261102-beta4` |
| 插件 | `0.2.3`，本轮无插件代码变更 |
| 本机项目与真实数据 | 未清空、未迁移、未覆盖 |
| beta3 线上数据 | 重新发布后曾回到上传时的空库；旧会话、邮箱连接、插件绑定和隔离测试台账未能恢复，不能伪造已恢复 |
| beta4 目标 | 保留 SQLite 业务逻辑，用云数据库保存加密一致性快照，避免重发布丢失运行期写入 |

beta4 首次部署后，需要重新完成管理员登录、指定 QQ 邮箱授权和插件配对。beta3 已丢失的数据不能凭快照方案找回。

## 2. 持久化实现

- SQLite 仍是唯一业务事务库，既有 34 张业务表和邮件、AI、Jev、Dify、台账规则未改写。
- 每次成功提交由统一数据库写入钩子标记快照待保存；事务回滚不会触发快照。
- 使用 SQLite `backup()` 生成包含已提交 WAL 的一致性副本，再 gzip 压缩并以 AES-256-GCM 加密。
- 云端只保存密文、明文数据库 SHA-256 和单调递增 revision；邮件正文、授权码和台账不以明文写入云表。
- 启动时验证 AEAD、SHA-256 和 `PRAGMA integrity_check`；所有候选均无效则拒绝启动，不回退为空库。
- 受保护 RPC 校验 writer token 哈希和 `expected_revision`；不同实例的新 revision 进入 `conflict`，不能覆盖云端。
- 路由成功响应前等待快照队列；保存失败返回 `503 PERSISTENCE_UNAVAILABLE`，不返回虚假成功 ACK。
- 启动迁移和 SIGTERM/SIGINT 关闭流程均刷盘。健康接口只暴露持久化状态、revision 和错误码，不暴露密钥。

云资源（复用同一应用）：

- `app_sqlite_snapshot_vault`：启用 RLS；公共客户端只能 SELECT 密文，无公开 INSERT/UPDATE/DELETE。
- `app_snapshot_writer_guard`：启用 RLS；不公开读取，只保存 writer token 的 SHA-256。
- `append_app_sqlite_snapshot(...)`：受保护写入入口，校验凭证与 revision。

早期用于合成烟测的 `app_sqlite_snapshots` 不再被当前代码使用。

## 3. 已完成验收

### 本地与隔离回归

- 后端：**154/154**（分批执行，未关闭安全删除保护）。
- 网页真实浏览器：**57/57**。
- 插件真实 Chromium：**67/67**。
- 插件提示与正式深链：**13/13**。
- 自身页面排除：**6/6**。
- 正式后台访问：**4/4**。
- 双后台隔离：非空队列阻止切换和解绑；切换清除旧设备令牌；新事件只进入新后台。
- 简历 PDF 测试使用隔离安装的既有 `pypdf` 依赖后通过，未修改简历/AI 业务代码。

### 云持久化专项

- 单元与 HTTP 测试覆盖 WAL 快照、密文无明文、删除本地副本后恢复、失败重试、损坏快照拒绝、错误密钥拒绝、revision 冲突、失败不 ACK、后台写入刷盘及明文临时文件清理。
- 同步后的发布源、最小发布目录和原项目分别复验，云持久化专项均为 **2/2 通过**。
- 真实云跨进程验收：写入管理员会话、插件设备、台账和事件后，删除本地 SQLite/WAL/SHM 并重启；原会话、原设备、原台账和事件幂等全部继续有效。
- 真实 SIGTERM 验收：不经过 HTTP 的后台写入在关闭时成功刷入云端；删除本地副本后恢复。
- 真实云验收均使用独立 validation stream 和合成数据；全部合成验收快照已清理，最终核对快照表为空。正式 `bangnili-beta-v1` 流尚未创建，待 beta4 首次部署启动。

## 4. 发布配置

候选发布源：`/Users/mingenlin/Desktop/opencode project/帮你理-beta-release/`
最小发布目录：`/Users/mingenlin/Desktop/opencode project/帮你理-beta-deploy/`

生产 `.env` 保持既有私密配置不变，仅更新/新增：

```bash
APP_VERSION=20261102-beta4
CLOUD_PERSISTENCE_ENABLED=true
CLOUD_SNAPSHOT_STREAM=bangnili-beta-v1
```

必须继续保持：

- `MASTER_KEY` 和 `INTERNAL_TICK_TOKEN` 不变；更换后旧快照无法解密或无法追加。
- 单写入实例。多实例不会被静默合并，revision 冲突会使写入失败。
- Node ≥24、前端/API 同端口、现有 WorkBuddy `publicConfig`。
- `.env` 不进入 Git、插件 ZIP 或公开下载目录。

## 5. 插件产物

- 页面下载：`web/downloads/bangnili-extension-0.2.3.zip`
- ZIP 顶层：`bangnili-extension/`，其中直接包含 `manifest.json`
- 默认后台：`https://bangnili.app.workbuddy.host/?sharecode=…`
- SHA-256：`c0b5bf09398523bf1f0f2bf07894094e1ea92fd4627972186df087eb78bea8d4`
- 本机探测只填候选地址，不自动保存，不自动解绑；非空队列不能跨后台搬移。

## 6. 部署后必须完成

1. 带平台分享码检查 `/api/v1/health`：版本为 beta4，`cloud_persistence.enabled=true`、状态 `ready`、无待保存错误。
2. 仅使用 `1191240794@qq.com` 接收真实 OTP 并登录管理员；不输出验证码或会话令牌。
3. 重新授权该 QQ 邮箱，验证同步成功、首扫唯一计数不超基线、空批次和游标稳定、无重复台账/待确认。
4. 重新配对插件 0.2.3，上传隔离测试事件并验证正式入账、重复上传判重、自身页面排除。
5. 记录新产生的会话、邮箱连接、设备和台账后，执行同版本重新部署。
6. 重部署后再次使用原会话、原邮箱连接、原设备令牌和原事件验证：数据仍在，重复事件仍判重。
7. 只有以上全部通过，才可宣称重发布持久化验收完成。

## 7. 剩余边界

- 云端持久化对象是 SQLite 快照，不包含 `data/outbox` 等独立文件；生产 SMTP 不依赖 outbox 持久化。
- 云服务不可用时会明确降级为失败状态并拒绝成功 ACK，不会假装已保存。
- 该方案防止旧实例覆盖云端，但不提供多实例同时写入。
- 平台分享码、应用邀请码和插件配对码仍是三套不同凭据。
- 本轮发布前仍需取得本轮部署授权；本地验收不等同于线上验收。
