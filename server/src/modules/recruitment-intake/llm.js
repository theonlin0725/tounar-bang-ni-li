import { config } from '../../config.js';
import { AppError } from '../../util.js';

const SYSTEM = `你是招聘进展信息提取器，不是聊天助手。只输出一个 JSON 对象，不要 Markdown。
任务：从用户提供的邮件/网页原文中提取“当前用户本人已经发生的招聘进展”，并保留逐字证据。
严格要求：
1. 只提取原文明确写出的信息；不要按常识补造公司、岗位、批次、申请编号、日期或状态。缺失写 null。
2. 区分：实际进展(actual_progress)、招聘流程说明(process_description)、广告/推广(advertisement)、转发/历史引用(forwarded_or_historical)、其他(other)。
   “招聘流程包括笔试、面试”“如果你通过会通知”等是流程说明，不是用户已发生的进展；
   但“邀请你参加笔试/测评/面试”“请于某日前完成测评”是已发生的邀请/进展，即使考试尚未进行，也属于 actual_progress。
3. status 只能是 applied/assessment/interview/offer/rejected/closed/unknown。
   applied 仅用于明确的投递成功/申请已收到；offer 仅用于明确录用；rejected 仅用于明确未通过/拒绝。
   assessment 指笔试或测评；interview 指面试邀请或已面试。旧邮件、一般招聘宣传、求职建议不算。
4. event_time 只在原文明确给出日期/时间时填写 ISO 8601；不要用收信时间代替。
5. evidence 中每条 quote 必须逐字出现在原文中；没有证据就不要写该字段。
6. 对不确定的地方写入 uncertainties，不要猜。
JSON 结构：
{
 "is_recruitment": true/false,
 "content_role": "actual_progress|process_description|advertisement|forwarded_or_historical|other",
 "company_name": string|null,
 "job_title": string|null,
 "recruitment_batch": string|null,
 "site_application_id": string|null,
 "job_url": string|null,
 "event_time": string|null,
 "status": "applied|assessment|interview|offer|rejected|closed|unknown",
 "progress_description": string|null,
 "evidence": [{"field":"status|company_name|job_title|event_time","quote":"原文逐字片段"}],
 "uncertainties": [string]
}`;

function parseJsonLoose(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('not json');
}
function text(value, max = 200) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}
function safeHttp(value) {
  if (!value) return null;
  try { const u = new URL(String(value)); return /^https?:$/.test(u.protocol) ? u.toString() : null; } catch { return null; }
}
function evidenceFor(raw, sourceText) {
  const hay = String(sourceText || '').replace(/\s+/g, ' ');
  return (Array.isArray(raw) ? raw : []).map((e) => ({
    field: ['status', 'company_name', 'job_title', 'event_time'].includes(e?.field) ? e.field : 'status',
    quote: text(e?.quote, 500)
  })).filter((e) => e.quote && hay.includes(e.quote.replace(/\s+/g, ' '))).slice(0, 8);
}
function normalize(raw, sourceText) {
  const statuses = new Set(['applied', 'assessment', 'interview', 'offer', 'rejected', 'closed']);
  const roles = new Set(['actual_progress', 'process_description', 'advertisement', 'forwarded_or_historical', 'other']);
  return {
    is_recruitment: raw?.is_recruitment === true,
    content_role: roles.has(raw?.content_role) ? raw.content_role : 'other',
    company_name: text(raw?.company_name, 200),
    job_title: text(raw?.job_title, 200),
    recruitment_batch: text(raw?.recruitment_batch, 100),
    site_application_id: text(raw?.site_application_id, 80),
    job_url: safeHttp(raw?.job_url),
    event_time: text(raw?.event_time, 64),
    status: statuses.has(raw?.status) ? raw.status : 'unknown',
    progress_description: text(raw?.progress_description, 600),
    evidence: evidenceFor(raw?.evidence, sourceText),
    uncertainties: Array.isArray(raw?.uncertainties) ? raw.uncertainties.map((x) => text(x, 200)).filter(Boolean).slice(0, 8) : []
  };
}

export async function extractRecruitmentSignal({ source, subject = '', bodyText = '', statusText = '', fromDomain = '', receivedAt = '', ruleFields = {} }) {
  if (!config.aiApiUrl) throw new AppError(503, 'AUTO_AI_NOT_CONFIGURED', '自动入账需要服务端 AI_API_URL/AI_MODEL', { retryable: false });
  const url = /\/chat\/completions$/i.test(config.aiApiUrl.replace(/\/$/, ''))
    ? config.aiApiUrl.replace(/\/$/, '')
    : `${config.aiApiUrl.replace(/\/$/, '')}/chat/completions`;
  const sourceText = [subject, statusText, bodyText].filter(Boolean).join('\n');
  const payload = {
    model: config.aiModel || 'default',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({
        source, subject, from_domain: fromDomain, received_at: receivedAt,
        status_text: statusText, body_text: String(bodyText || '').slice(0, 8000),
        rule_extracted: ruleFields
      }) }
    ]
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.aiLlmTimeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.aiApiKey ? { Authorization: `Bearer ${config.aiApiKey}` } : {}) },
      body: JSON.stringify(payload), signal: controller.signal
    });
  } catch {
    throw new AppError(503, 'AUTO_AI_UNAVAILABLE', 'AI 提取服务连接失败', { retryable: true });
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    if ([401, 403].includes(res.status)) throw new AppError(503, 'AUTO_AI_UNAUTHORIZED', 'AI 提取服务鉴权失败', { retryable: false });
    throw new AppError(503, 'AUTO_AI_UNAVAILABLE', 'AI 提取服务暂时不可用', { retryable: res.status >= 500 || res.status === 429 });
  }
  let data;
  try { data = await res.json(); } catch { throw new AppError(502, 'AUTO_AI_INVALID_RESPONSE', 'AI 提取结果无法解析', { retryable: true }); }
  const content = data?.choices?.[0]?.message?.content ?? data?.output?.text ?? null;
  if (!content) throw new AppError(502, 'AUTO_AI_INVALID_RESPONSE', 'AI 提取结果为空', { retryable: true });
  try { return { extraction: normalize(parseJsonLoose(content), sourceText), model: data.model || config.aiModel || null }; }
  catch { throw new AppError(502, 'AUTO_AI_INVALID_RESPONSE', 'AI 提取结果不是有效 JSON', { retryable: true }); }
}
