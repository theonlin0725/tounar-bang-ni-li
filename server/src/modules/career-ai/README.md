# 简历与 AI 岗位分析

本模块负责把用户简历转为可核验的结构化画像，并在现有台账数据上生成岗位对比与未投递岗位推荐。它不是独立服务：路由、鉴权、SQLite、前端 SPA 都复用主项目。

## 主要文件

- `resume-parser.js`：PDF / DOCX / 文本提取。PDF 通过本机 `python3 + pypdf`，DOCX 用 Python 标准库读取 `word/document.xml`；不保存原始文件二进制，只保存文本与画像。
- `llm.js`：服务端模型网关客户端、简历/对比/推荐提示词、JSON 校验与证据核验。
- `service.js`：简历版本、当前简历、分析、对比、推荐、报告存储和账号隔离。
- `server/test/career-ai.test.js`：使用本地假模型服务验证完整 API 链路；不访问真实外部模型。
- `tests/e2e/career-ai.mjs`：浏览器上传、失败重试、画像、对比、推荐、跨板块勾选。

## 配置

服务端必须显式配置以下变量；密钥不得进入前端、插件或版本库：

```bash
AI_API_URL=https://你的模型网关/v1
AI_API_KEY=服务端密钥
AI_MODEL=模型名
# 可选
AI_PROVIDER=openai_compatible
AI_LLM_TIMEOUT_MS=60000
AI_MAX_JOBS=12
```

- 走 OpenAI 兼容的 `POST {AI_API_URL}/chat/completions`，要求返回 JSON object。
- `CLOUD_ENDPOINT/CLOUD_PUBLISHABLE_KEY` 是既有 WorkBuddy 云端邮件兜底，不是本功能的默认服务端模型；当前本机探针返回 403/无服务端登录态，因此 AI 功能要求上面的显式网关。
- 没有配置时接口返回 `AI_NOT_CONFIGURED`，前端明确提示，不生成假报告。

## 数据与接口

新增表：`resumes`（文本、画像、当前版本）、`ai_reports`（对比/推荐报告）。删除用户数据时会清理这两张表。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/ai/status` | 模型可用性、当前简历状态 |
| GET/POST | `/api/v1/resumes`、`/api/v1/resumes/text` | 列表 / 上传文件或粘贴文本 |
| GET | `/api/v1/resumes/current`、`/api/v1/resumes/:id` | 当前/指定简历 |
| POST | `/api/v1/resumes/:id/analyze` | 生成结构化画像；失败保留 failed 可重试 |
| PUT | `/api/v1/resumes/:id/text` | 修正文本并重新分析 |
| POST | `/api/v1/ai/compare` | 2–6 个本人岗位对比 |
| POST | `/api/v1/ai/recommend` | 当前账号全部未投递岗位推荐 |
| GET | `/api/v1/ai/reports/:id` | 读取本人报告 |

所有查询按 `owner_id` 隔离；对比只接受本人的 application_id。推荐服务端过滤 `has_applied=1` 或已归档的岗位，AI 不修改岗位状态。

## 画像与报告约束

- 简历画像的每项技能/经历/优势/限制必须带简历原文引用；服务端会检查引用是否逐字出现在简历文本中，不通过则丢弃该项。`grounded=false` 时前端提示修正文本。
- 对比/推荐提示词要求相对匹配，不输出录用概率。JD 少于 80 字的岗位标记 `information_sufficient=false`，不能作为确定推荐。
- 推荐只分析 JD 充分的候选（默认最多 12 个），其余岗位进入“信息不足/未纳入排序”，并说明原因；不做外部招聘网站搜索。
- 前端状态：上传/解析 → 分析中 → 完成/失败 → 重试；失败不会影响台账。

## 验证

```bash
node --test --test-concurrency=1 server/test/career-ai.test.js
npm run test:career-ai
```

测试使用本地假模型（明确非真实模型联调）和隔离数据库；真实外部模型、真实用户 PDF/DOCX、模型质量/时延仍需配置后联调。
