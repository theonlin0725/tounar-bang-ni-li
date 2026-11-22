import { config } from '../../config.js';
import { AppError } from '../../util.js';
import { chatJsonCompletion } from './llm.js';

/* Flash 直判：复用 AI_API_* 的 OpenAI 兼容模型，对“抽取结果 + 候选台账”做一次结构化判断。
 * 输出形状与 Jev 保持一致，工作流/人工确认不需要分叉写账逻辑。
 * 模型只给判断与置信度；归属、时间、终态和人工保护仍由服务端校验。 */

const SYSTEM = `你是招聘进展判断器，不是聊天助手。只输出一个 JSON 对象，不要 Markdown。
输入会给出邮件原文、已抽取字段和候选台账。你要判断：
1. 这是否是当前用户本人已经发生的招聘进展（收到笔试/测评/面试邀请、录用、拒绝都算；招聘流程说明、广告、转发、历史引用、未来条件句不算）。
2. 阶段：applied/assessment/interview/offer/rejected/closed/no_status。只有原文明确支持才选择。正文可能是“首部 + 尾部”拼接，仍以正文抬头/表格/落款和主题为主，from_name/from_domain 仅作辅助。
3. 抽取出的公司、岗位是否被原文直接支持，字段是否错位；纯数字发件人、recruitment/careers/hr、ATS/测评平台名、自身产品 Tounar/帮你理 都不能视为有效公司。
   evidence_support 只衡量原文是否直接支持“真实雇主 + 当前已发生的招聘进展阶段”这一核心事实。正文缺少截止时间、申请编号、工作地点、面试官姓名等可选字段时，不得因此压低 evidence_support；可选字段缺失只写入 uncertainties，不否定主进展。
4. 相对候选记录的当前状态，这条信息是 new / duplicate_or_old / uncertain。
5. 这条进展属于哪个候选（c0、c1…）；不能确定选 uncertain，没有候选匹配选 no_match。不要为了凑匹配选同公司的其他岗位。

只输出 JSON：
{
  "actual_progress": 0到1,
  "evidence_support": 0到1,
  "company_valid": 0到1,
  "job_title_valid": 0到1,
  "fields_consistent": 0到1,
  "status": { "value": "applied|assessment|interview|offer|rejected|closed|no_status", "confidence": 0到1 },
  "newness": { "value": "new|duplicate_or_old|uncertain", "confidence": 0到1 },
  "candidate": { "value": "c0|c1|...|no_match|uncertain", "confidence": 0到1 }
}`;

function score(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}
function choice(raw, allowed, fallback) {
  const value = String(raw?.value || raw || '');
  return {
    value: allowed.has(value) ? value : fallback,
    confidence: score(raw?.confidence, 0),
    probabilities: raw?.probabilities || null
  };
}

export function normalizeFlashJudgement(raw, candidates = []) {
  const statuses = new Set(['applied', 'assessment', 'interview', 'offer', 'rejected', 'closed', 'no_status']);
  const newnessValues = new Set(['new', 'duplicate_or_old', 'uncertain']);
  const candidateValues = new Set(['no_match', 'uncertain', ...candidates.map((_, i) => `c${i}`)]);
  return {
    actual_progress: score(raw?.actual_progress, 0),
    evidence_support: score(raw?.evidence_support, 0),
    company_valid: raw?.company_valid == null ? null : score(raw.company_valid),
    job_title_valid: raw?.job_title_valid == null ? null : score(raw.job_title_valid),
    fields_consistent: raw?.fields_consistent == null ? null : score(raw.fields_consistent),
    status: choice(raw?.status, statuses, 'no_status'),
    newness: choice(raw?.newness, newnessValues, 'uncertain'),
    candidate: choice(raw?.candidate, candidateValues, candidates.length ? 'uncertain' : 'no_match'),
    model: raw?.model || config.aiModel || null,
    request_id: null,
    usage: null
  };
}

export async function judgeRecruitmentFlash({ state, candidates = [] }) {
  const candidateState = candidates.map((c, i) => ({
    key: `c${i}`,
    application_id: c.id || c.application_id || null,
    company_name: c.company_name || null,
    job_title: c.job_title || null,
    recruitment_batch: c.recruitment_batch || null,
    status: c.status || null,
    has_applied: !!c.has_applied,
    match_reason: c.reason || c.match_reason || null,
    updated_at: c.updated_at || null,
    last_status_changed_at: c.last_status_changed_at || null,
    manual_status_at: c.manual_status_at || null,
    stage_received_at: c.stage_received_at || null
  }));
  const { data, content } = await chatJsonCompletion({
    system: SYSTEM,
    user: JSON.stringify({ ...state, candidates: candidateState })
  });
  let raw;
  try {
    const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    raw = JSON.parse(text);
  } catch {
    throw new AppError(502, 'AUTO_AI_INVALID_RESPONSE', 'Flash 判断结果不是有效 JSON', { retryable: true });
  }
  if (!raw || typeof raw !== 'object' || raw.actual_progress == null || raw.status == null || raw.candidate == null) {
    throw new AppError(502, 'AUTO_AI_INVALID_RESPONSE', 'Flash 判断缺少必要字段', { retryable: true });
  }
  return { ...normalizeFlashJudgement(raw, candidates), model: data.model || config.aiModel || null };
}
