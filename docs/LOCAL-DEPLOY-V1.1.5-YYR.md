# v1.1.5（yyr）组员本地部署

这版包含简历改写审阅更新和浏览器插件 0.2.14。下文的「本地部署」指网页、后端和 SQLite 在组员自己的电脑上运行；启用 AI 后，相关内容仍会发到所配置的模型服务，不是离线推理。

## 1. 启动网页

使用 Node.js 24 或更新版本，并确认 GitHub 账号有仓库读取权限。已有仓库但工作区有未提交改动时，建议另克隆一份。

```bash
git clone --branch tournr-1.1.5-yyr --single-branch https://github.com/theonlin0725/tounar-bang-ni-li.git
cd tounar-bang-ni-li
npm ci
cp .env.example .env
```

在自己的 `.env` 中设置以下值，邮箱换成自己的，首次先不填模型密钥：

```dotenv
HOST=127.0.0.1
PORT=4310
APP_BASE_URL=http://127.0.0.1:4310
APP_ENV=development
ALLOWED_EMAILS=your-email@example.com
MAIL_MODE=outbox
ENABLE_SCHEDULER=false
```

运行 `npm start`，打开 [本地首页](http://127.0.0.1:4310)。输入白名单邮箱获取验证码后，在同一目录的另一个终端运行 `npm run otp:latest` 查看本机验证码。无须配置 SMTP。可在 [健康检查](http://127.0.0.1:4310/api/health) 核对版本。

## 2. 加载 Chrome / Edge 插件

打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式，点「加载已解压的扩展程序」，选择仓库的 `extension/` 目录。打开本地网页的插件安装指引，连接插件并授权所需招聘站点。若不能自动连接，在插件里把服务地址设为上一步的本地地址，再用网页生成的配对码绑定。已有旧版时，确认实际加载的是 0.2.14，避免两个副本同时运行。

如需通过网页下载安装包，macOS/Linux 可在仓库目录执行 `BETA_SERVER_URL=http://127.0.0.1:4310 npm run build:plugin`（系统需有 `zip`、`unzip`、`shasum`）。ZIP 生成在 `web/downloads/`，不会提交。端口有变化时，网页、插件地址和打包地址保持一致。

## 3. 哪个功能调用哪个模型

模型密钥只在本机后端的 `.env` 中由组员自行填写。不要放入插件、前端代码、GitHub、Dify DSL 或共享环境；修改后重启服务。岗位文字和通用 AI 是两组配置，即使使用同一个供应商也要分别配置。

| 功能 | 实际调用与配置 |
| --- | --- |
| 插件：招聘页文字 → 岗位标题、公司名、职责、要求 | 后端直连 DeepSeek，代码默认模型 `deepseek-flash`。设置 `JD_AI_ENABLED=true`，填写 `JD_AI_API_KEY`，可用 `JD_AI_API_URL` 与 `JD_AI_MODEL` 指定端点和模型。不依赖 Dify。 |
| 插件：文字未找到公司名 → 看图兜底 | 默认关闭。设置 `JD_VISION_ENABLED=true`、`JD_VISION_API_URL`、`JD_VISION_API_KEY` 后，后端把采集的授权岗位页全页截图交给千问 `qwen3.6-flash`。只补公司名候选，需人工核对；已有公司名时不走看图。 |
| 简历结构化、岗位匹配、面试题、定向改写 | 都走通用 AI 网关 `AI_API_URL` / `AI_API_KEY` / `AI_MODEL`。这版开发环境用的是 DeepSeek `deepseek-flash`，仓库不强制选它。没有专用 AI 配置时，也可复用配置好的 OpenRouter 网关。 |
| AI 求职助手聊天 | 优先配置独立的 `AGENT_API_URL` / `AGENT_API_KEY` / `AGENT_MODEL`，其次 OpenRouter，再复用通用 AI。若使用独立网关，三项一起填写；若复用通用 AI，可不填 `AGENT_*`。助手调用匹配或改写功能时，这些功能仍走通用 AI。 |
| 邮件／插件招聘进展自动入账 | 先用通用 AI 抽取结构化信息，再由 `MAIL_INTAKE_JUDGE` / `PLUGIN_INTAKE_JUDGE` 分别选择判断器。`jev` 用 TypeSafe（`JEV_API_KEY`，默认模型 `jev-latest`），`flash` 复用当前通用 AI，不代表固定使用 Gemini。插件判断默认 `jev`；仅配置直连通用 AI 且无 Jev key 时，邮件默认 `flash`。这条流程与插件的 JD 文字识别独立。 |
| 简历审阅、逐条查看原文、Word 排版导出 | 不调用模型。Word 导出使用统一单栏 A4 模板，需要本机 LibreOffice、Poppler 的 `pdfinfo` 和中文字体。若命令不在 PATH，可用 `RESUME_SOFFICE_BIN`、`RESUME_PDFINFO_BIN` 指定程序；`RESUME_CJK_FONT` 可指定字体。未通过单页 A4 校验时草稿仍可保存。 |

没有模型凭据也可以先验证登录、基本台账和插件配对；模型相关功能需要对应凭据。联调请用有权提交的测试资料，尤其注意简历、招聘邮件和全页截图可能包含个人信息。
