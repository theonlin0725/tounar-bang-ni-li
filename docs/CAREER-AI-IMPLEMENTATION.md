# 简历与 AI 岗位分析实现说明（2026-10-31）

## 1. 范围与入口

在现有 SPA 增加 `/?panel=career` 页面，并在台账「投递明细 / 看过没投」行增加勾选。用户可在两个板块跨选 2–6 个岗位，点击勾选栏「对比选中」进入 AI 页面；AI 页面同时提供简历上传/修正、画像、对比和未投递推荐。

没有另建前端应用、数据库或账号体系；简历和报告写入现有 SQLite，所有请求走现有同源 Cookie 会话。

## 2. 实现方式（Dify 评估）

选择**服务端直接调用 OpenAI 兼容模型网关**，没有接 Dify：

- 现有项目已有服务端配置、SQLite、路由和 SPA；增加一个 `AI_API_URL/AI_API_KEY/AI_MODEL` 网关即可复用全部身份/数据隔离和页面能力。
- Dify 会额外引入工作流、应用 API、变量/会话管理和一套后台配置；对本需求的简历画像、对比、排序三个结构化 JSON 调用没有明显收益，反而增加部署和联调成本。
- 现有 WorkBuddy 云端 SDK 是浏览器 localStorage/平台登录态模型；本机服务端探针返回 403，不能作为可靠服务端入口。AI 功能要求显式 `AI_API_URL`，不把“配置了 CLOUD_*”误报为可用。
- 如果以后需要 Dify，可在 `career-ai/llm.js` 增加一个 Dify 适配器，保持 `askJson(system,user)` 和现有 API/前端不变。

## 3. 数据链路

1. 前端读取文件或粘贴文本，base64/JSON 上传；服务端限制 5 MB。
2. `resume-parser.js` 提取文本：
   - 文本：UTF-8/UTF-16；
   - DOCX：Python 标准库读取 `word/document.xml`；
   - PDF：Python `pypdf` 提取（本机已安装；缺失时返回 `RESUME_PDF_UNSUPPORTED`，提示粘贴文本）。
   - 原始文件不落盘，只保存提取文本（最多 60,000 字）和画像。
3. `resumes` 每次上传创建新版本，旧版本保留并标记非当前；`is_current` 唯一索引保证每个账号只有一份当前简历。
4. `POST /resumes/:id/analyze` 调用模型生成画像；服务端用简历原文逐条核验 `evidence`，不通过的技能/经历/优势/限制被丢弃；失败写 `failed`，可重试或修正文本。
5. 对比：校验 2–6 个 application_id 都属于当前用户，读取真实 JD；JD < 80 字标记资料不足。
6. 推荐：服务端查询当前用户全部 `has_applied=0 AND archived_at IS NULL` 岗位；JD 充分者按简历关键词做本地预筛（最多 12 个）再交模型排序；无 JD/过短岗位单独列出，不冒充确定推荐。
7. 报告写入 `ai_reports`（kind/status/result/error），前端展示；AI 不写 applications/status/history。

## 4. 数据隔离与删除

- 查询/写入都带 `owner_id`；对比会逐个 `getApplication(ownerId, id)`，他人记录返回 404。
- 前端只拿当前账号的 `/resumes/current`；页面切换账号会重新加载（现有会话代际守卫）。
- 数据删除任务会删除 `ai_reports` 和 `resumes`；不保留原始上传文件。

## 5. 前端交互

- `career.js`：上传/粘贴、分析中、失败重试、文本修正、画像证据、对比报告、推荐报告、空状态。
- `ledger.js`：跨板块勾选、勾选栏名称/移除/清空、2–6 个岗位进入对比；选择在 SPA tab 切换间保留。
- 所有长正文/报告用 `textContent` 渲染，不把模型输出当 HTML；外链使用 `noopener noreferrer`。

## 6. 验证结果

| 检查 | 结果 |
|---|---|
| `server/test/career-ai.test.js` | 6/6：上传/画像、对比、推荐、PDF/DOCX、隔离、失败重试/空状态 |
| `npm run test:career-ai` | **11/11**：真实浏览器+真实后端+本地假模型；上传失败重试、画像、跨板块选择、对比、推荐、不改状态 |
| 后端全量 | 150/150 |
| 网页 E2E | 57/57 |
| 自身页面排除 | 6/6 |
| 插件 E2E | 67/67 |
| 插件稳定场景 | 18/18 |

**真实模型联调边界**：本机 `npm run probe:llm` 对 WorkBuddy 线上 endpoint 返回 403/无服务端登录态；没有配置可用的 `AI_API_URL`。因此：

- AI 的存储、接口、前端状态、隔离和失败重试已用本地假模型验证；
- 真实模型输出质量、时延、PDF/DOCX 真实用户文件、正式模型费用/限流**尚未联调**；
- 未配置时页面明确显示 `AI_NOT_CONFIGURED`，不会生成模拟报告；
- 不把这次假模型测试当作“真实 AI 已交付”。

## 7. 需要用户/管理员提供

要完成真实联调，需要以下之一：

1. OpenAI 兼容模型网关：`AI_API_URL`、`AI_API_KEY`、`AI_MODEL`（推荐；Dify 可用其 OpenAI 兼容端点或另外适配）；
2. 若坚持 WorkBuddy 云端：提供服务端可用的鉴权方式/服务端 token，而不是浏览器 localStorage 登录态；
3. Dify：服务地址、应用 API key、应用类型与输入/输出约定；当前未接。

## 8. 已知限制

- 推荐只使用已经采集的未投递岗位，不访问外部招聘网站；列表采集但完全没有 JD 的岗位只能列为信息不足。
- 最多分析 12 个 JD 充分候选（`AI_MAX_JOBS` 可调）；超出部分明确列为“未纳入本次排序”，不是隐藏。
- 简历证据核验是逐字匹配，模型改写证据会被丢弃；可能偏保守。
- PDF 解析依赖本机 `python3` + `pypdf`；DOCX 依赖 `python3` 标准库；缺失时只能粘贴文本。
- 未做真实模型质量基准、长简历 token 成本、并发限流和移动端全面验收。
