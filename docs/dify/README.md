# Dify 演示工作流：帮你理-确认入账-LLM+Jev

## 地址与状态

- 工作流地址：https://cloud.dify.ai/app/7703d511-a684-4ea4-a3e1-7ac2cbf4216f/workflow
- 已发布 Web App：https://udify.app/workflow/jbmNAiAMrvsWA3Pk
- 名称：`帮你理-确认入账-LLM+Jev`
- 状态：已发布（Published）
- 平台：Dify Cloud，账号为当前浏览器已登录的 `226020283@link.cuhk.edu.cn`
- 模型：LLM 节点使用 `z-ai/glm-5.3-flash`；Jev 节点是真实 HTTP 调用 `https://api.typesafe.ai/v1/systemone`，不是改名 LLM。

## 节点结构

`输入原始信息`（主题、正文/JD、公司/岗位线索、候选台账 JSON）
→ `LLM 提取字段`（只提取公司、岗位、状态、批次、证据）
→ `整理 JEV 判断输入`（把提取结果、候选、原文组织成 Jev state/questions）
→ `调用真实 JEV`（TypeSafe Jev，Bearer 鉴权，POST systemone）
→ `校验并汇总判断`（字段有效性、缺字段、候选归属；输出可入账/需要补录/归属待确认/调用失败）
→ `输出确认入账结果`（公司、岗位、状态、missing、matched_candidate、置信度、decision、error）

## 两次真实运行

### 1）可入账

输入：

- 主题：`面试通知｜星河科技｜数据产品实习生`
- 正文：`星河科技邀请您参加数据产品实习生岗位的面试。面试时间：2026年11月5日 14:00。请确认是否参加。`
- 候选台账：`[]`

关键输出：

```json
{
  "company_name": "星河科技",
  "job_title": "数据产品实习生",
  "status": "interview",
  "missing": "",
  "matched_candidate": "no_match",
  "candidate_confidence": 0.68,
  "actual_progress": 0.95,
  "evidence_support": 0.88,
  "fields_consistent": 0.97,
  "decision": "可入账"
}
```

对应产品规则：LLM 只给文本候选，Jev 判断字段/进展；Dify 只演示判断，不直接写帮你理数据库。

### 2）需要补录

输入：

- 主题：`招商银行2027校园招聘统一笔试通知`
- 正文：空
- 候选台账：`[]`

关键输出：

```json
{
  "company_name": "招商银行",
  "job_title": "",
  "status": "assessment",
  "missing": "job_title",
  "matched_candidate": "no_match",
  "candidate_confidence": 0.12,
  "actual_progress": 0.41,
  "evidence_support": 0.23,
  "fields_consistent": 0.77,
  "decision": "需要补录"
}
```

这对应产品中的“只能识别公司 → 补岗位”，不会创建空白台账。

## 两条“直连”不要混淆

2026-11-01 18:49 实测：

- **本机服务 → TypeSafe Jev 直连**：HTTP 451（地区限制），所以产品里的 `direct_jev_error` 是 `JEV_UNAVAILABLE`。
- **本机服务 → Dify API**：HTTP 200，工作流状态 `succeeded`。
- **Dify 工作流 → TypeSafe Jev HTTP 节点**：成功，输出公司/岗位/状态。

因此“直连失败”指本机到 TypeSafe 的直连；“Dify：成功”和“Jev 判断：成功 · 经 Dify”才是实际成功路径。产品前端已改成这种中文展示，不再暴露 `dify_fallback` 这种容易误解的内部字段。

## 与产品实际流程的连接

- **正式流程仍由帮你理服务端编排**：待确认确认按钮 → 服务端读取原文 → LLM → Jev → 字段/归属/状态校验 → 直接入账或补录弹窗。Dify 演示流与产品使用相同的 Jev 语义、字段必填规则和候选归属要求。
- Dify 演示不写正式库；如要让正式流程交给 Dify 编排，可让 Dify 调用帮你理的受限内部接口（或由服务端调用 Dify），由服务端做最终查询、版本校验、人工保护、幂等和写入。当前未把正式写入交给 Dify，避免两个写入源。
- Dify 的 `candidates_json` 需要由调用方从当前用户台账查出后传入；Dify 不直接访问帮你理数据库。

## DSL

- 脱敏 DSL：[recruitment-confirm-workflow.sanitized.yml](recruitment-confirm-workflow.sanitized.yml)
- 其中 Jev Bearer key 已替换为 `__JEV_API_KEY__`；导入后需在 Dify 的 HTTP 节点授权里填自己的 key。
- 未包含任何真实密钥、Cookie、邮箱正文或用户台账。

## 截图

- [工作流全景](workflow-overview.png)
- [第二次运行：需要补录](run-needs-input.png)

## 如何再次运行

1. 打开工作流地址。
2. 点击右上角 `Test Run`。
3. 填 `原始主题`，可填正文、公司/岗位线索；`候选台账 JSON` 传 `[]` 或候选数组。
4. 点击 `Start Run`，在右侧 `RESULT` 查看公司/岗位/状态/missing/decision。
5. 若要验证自动/补录两条分支，使用上面两组输入重跑。

## 边界

- Dify 节点的 HTTP key 存在 Dify 工作流凭据中，不写入脱敏 DSL。
- 这次是 Dify Cloud 的真实运行（模型 + Jev HTTP 调用），不是本地模拟；产物是判断结果，不入帮你理台账。
- 产品前端的真实确认流程另见[确认入账实现](../CONFIRM-INTAKE-WORKFLOW-20261101.md) 和实际联调记录。
