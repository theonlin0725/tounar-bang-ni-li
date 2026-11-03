# 本轮验证记录（2026-11-03）

验证对象：独立 review 副本，Node 26.8.1，Chrome for Testing 156.0.8078.4。运行时代码与冻结的本机 4312 源码逐文件 SHA-256 相同，见 source-manifest.json。测试使用隔离数据库、outbox 和独立浏览器，不启动正式部署，不调用真实模型或发送真实邮件。

| 检查 | 本轮结果 |
|---|---|
| 网页 `npm run test:web` | 57/57 通过 |
| 插件 `npm run test:e2e` | 67/67 通过 |
| 后端 `npm test`（指定含 pypdf 的 Python） | 154/155 通过，1 项失败 |
| 云快照单元测试单独复测 | 1/2 通过，相同 pending 状态断言失败 |
| `git diff --check` | 通过 |
| 待提交文本凭据检查 | 与本地已知敏感配置对照及常见密钥格式扫描，未发现匹配；不代表形式化安全审计 |
| 排除运行文件 | 没有 data/、dist/、node_modules、真实 .env、数据库或密钥文件 |

## 尚未通过的检查

`server/test/cloud-persistence.test.js:101`：上传失败之后 `cloudPersistenceStatus().pending` 预期 true、实际 false；完整回归和单独运行均复现。应检查后台自动上传、串行队列和 dirty 状态的时序。尚未确定根因，未修改本次快照的业务代码，PR 保持草稿。

首轮为 152/155：默认 Python 缺少 pypdf 导致 PDF 解析失败，另外云快照单元和 HTTP 测试的 pending 断言失败。使用已安装 pypdf 的 Python、恢复常规测试环境后为 154/155，HTTP 测试通过，但单元 pending 失败仍存在。因此不宣称所有检查通过，也不把 HTTP 首轮失败隐藏为从未发生。

## 复现

```bash
# 如 python3 已包含 pypdf，可不传 PYTHON_BIN
PYTHON_BIN=/path/to/python-with-pypdf CLOUD_LLM_ENABLED=false npm test
CLOUD_LLM_ENABLED=false npm run test:web
CLOUD_LLM_ENABLED=false npm run test:e2e
CLOUD_LLM_ENABLED=false node --test server/test/cloud-persistence.test.js
```

浏览器测试复用机器上已有的 Chrome for Testing，其他机器按 tests/e2e/browser.mjs 的解析逻辑准备浏览器。首次需要下载浏览器时需要网络。

## 未在本轮重新验证

真实 LLM/Jev/Dify、真实 SMTP/QQ IMAP、实时招聘站点适配、生产部署和重部署恢复。test:self-page、backend-switch、test:career-ai、test:mail-admin 的独立专项命令未单独重跑；相应代码/测试保留给评审者，不把历史文档的通过数当成本轮结果。

本地 4312 上一轮基础启动、OTP 登录和台账读取烟测通过；那是本机演示验证，与本轮隔离回归分别记录。
