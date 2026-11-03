# beta4 / 4312 代码 Review 入口

本分支是 2026-11-03 从运行本地 4312 的项目目录冻结的源码快照，基于 main `574940b`。不是云端发布结果，也不改变正式部署。分支名：`codex/beta4-local-review-20261103`。

## 三个评审板块

| 板块 | 评审说明 | 主要目录 |
|---|---|---|
| 数据插件层 | [采集、队列、设备与后台隔离](01-data-plugin.md) | `extension/`、`server/src/modules/data-capture/` |
| 前端页面 | [台账、待确认、简历及设置交互](02-frontend.md) | `web/` |
| 后台接口（大模型服务） | [鉴权、AI/Jev/Dify、邮件与持久化](03-backend-ai.md) | `server/src/`，采集模块除外 |

这是同一产品的三个评审边界，不是三个可独立部署的服务。后端同一进程同时提供 API 和网页，插件通过 HTTP 访问它。各分组提交存在依赖，请在分支最终版本上运行测试。

## 同事从空数据启动

需要 Node ≥24、npm；PDF 解析另需 Python 3 + `pypdf`。没有 PDF 依赖时可用粘贴简历文本的方式。不要索取或复制原作者的数据库、邮箱授权码或 `.env`。

```bash
git clone --branch codex/beta4-local-review-20261103 https://github.com/theonlin0725/tounar-bang-ni-li.git
cd tounar-bang-ni-li
npm ci
APP_ENV=development HOST=127.0.0.1 PORT=4312 \
APP_BASE_URL=http://127.0.0.1:4312 DATA_DIR="$PWD/.tmp/review-data" \
CLOUD_PERSISTENCE_ENABLED=false CLOUD_LLM_ENABLED=false \
ENABLE_SCHEDULER=false MAIL_MODE=outbox SMTP_URL='' \
ALLOWED_EMAILS=demo@tounar.local ADMIN_EMAILS=demo@tounar.local \
ENABLE_SELFTEST_LOGIN=true \
node --env-file-if-exists=.env.review server/src/index.js
```

打开 http://127.0.0.1:4312 ，用 `demo@tounar.local` 获取验证码并登录；管理员本机验证码自动填入。首次是空台账，手动补录即可体验。用 Control+C 停止。若机器已有 4312 服务，应自行换一个空闲端口，同时修改 PORT、APP_BASE_URL 和插件后台地址。

插件：在 Chrome 的 `chrome://extensions` 开开发者模式，加载仓库的 `extension/`；手动填 `http://127.0.0.1:4312` 并保存授权，再在网页「数据与授权」批准配对码。现有本机检测仅探测 4311/4310，不能用检测按钮替代手动填 4312。建议使用独立 Chrome 个人资料，不迁移正式后台插件的未上传队列。

需要真实 AI 时，在被 Git 忽略的 `.env.review` 中配置自己的 AI_API_URL / AI_API_KEY / AI_MODEL；自动工作流另需 JEV_API_KEY，可选 DIFY_API_URL / DIFY_API_KEY。参阅 `.env.example`，不要把凭据发到 PR。联网能力及真实 SMTP/IMAP不属于离线演示保证。

原作者的 `tools/start-beta4-demo.command` 和 [个人本机教程](../BETA4-LOCAL-DEMO-GUIDE.md) 依赖原作者已有数据副本；同事应使用上面的空库步骤。

## 本分支与本机源码的差异

- 运行时代码 `extension/`、`web/assets/`、`server/src/` 保持冻结时内容；没有为 review 重构调用路径。
- 增加本评审导航、核验说明，补全忽略规则。
- 移除跟踪的本机云部署描述文件，去掉打包工具中硬编码的平台分享码，改为显式环境变量配置。
- 文档里的已识别凭据脱敏；不提交数据库、邮箱正文文件、密钥、运行日志、`.env`、发布包或新增个人截图。
- `web/downloads/` 的成品 ZIP 不提交。需要下载按钮的包时运行 `npm run build:plugin`，本地测试可设置 `BETA_SERVER_URL=http://127.0.0.1:4312 SHARE_CODE=''`。插件也可以直接加载源码。
- 部分历史文档引用的个人截图不在本快照中；历史验收描述不代表本轮结果。请以 [本次验证](VALIDATION.md) 为准。

草稿 PR 仅供评审，不启用自动合并，不修改 main；原运行目录、原数据库、4311/4312 服务和部署目录保持原状。
