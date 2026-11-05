import { config } from '../../config.js';
import { AppError } from '../../util.js';

/* TypeSafe Jev System One：POST /v1/systemone，state + 类型化问题。
 * Jev 只返回判断，不直接写库；服务端仍做归属、时间、终态和人工保护校验。 */
export async function judgeRecruitment({ state, candidates = [] }) {
  if (!config.jevApiUrl || !config.jevApiKey) {
    throw new AppError(503, 'JEV_NOT_CONFIGURED', '未配置 JEV_API_URL/JEV_API_KEY', { retryable: false });
  }
  const candidateCriteria = Object.fromEntries(candidates.map((c, i) => [
    `c${i}`, `候选 ${i + 1}：${[c.company_name, c.job_title].filter(Boolean).join(' · ') || c.application_id}；当前状态 ${c.status}`
  ]));
  const questions = {
    actual_progress: {
      type: 'noul',
      instructions: '这段内容是否明确描述了当前用户本人的招聘进展？收到笔试/测评/面试邀请、录用或拒绝通知都属于已发生的进展，即使考试或面试尚未进行；招聘流程说明、广告、转发、历史引用或纯未来条件句不算。',
      criteria: { true: '已经发生的本人招聘进展', false: '流程介绍/广告/转发/历史/未来条件或无法判断' }
    },
    company_valid: {
      type: 'noul',
      instructions: '提取出的公司名是否被原文直接支持，并且确实是公司/组织名？如果它是“面试、通知、未知、待补充、提醒”等阶段/页面词，或原文没有公司证据，回答否。',
      criteria: { true: '原文明确支持的公司名', false: '缺失、占位或字段错位' }
    },
    job_title_valid: {
      type: 'noul',
      instructions: '提取出的岗位名是否被原文直接支持，并且确实是岗位/职位名？如果它是“面试、通知、未知、待补充、加分项或注意事项”等阶段/页面/标题词，或原文没有岗位证据，回答否。',
      criteria: { true: '原文明确支持的岗位名', false: '缺失、占位或字段错位' }
    },
    fields_consistent: {
      type: 'noul',
      instructions: '公司字段和岗位字段是否没有互换、串行或明显错位？只有字段映射合理时回答是。',
      criteria: { true: '字段映射合理', false: '疑似错位/无法核对' }
    },
    status: {
      type: 'choice',
      instructions: '这段内容最支持哪个当前招聘阶段？收到测评邀请选 assessment，收到面试邀请选 interview；只有明确证据才选择，流程说明不能推断为已发生。',
      criteria: {
        applied: '已投递/申请已收到', assessment: '笔试或测评', interview: '面试',
        offer: '录用/Offer', rejected: '拒绝/未通过', closed: '岗位关闭/流程结束', no_status: '没有可确定的阶段'
      }
    },
    evidence_support: {
      type: 'noul',
      instructions: '原文证据是否直接支持“这是当前用户的实际进展”以及所选阶段？仅有泛泛措辞或流程介绍时回答否。',
      criteria: { true: '证据直接支持', false: '证据不足或只支持流程介绍' }
    },
    newness: {
      type: 'choice',
      instructions: '相对于候选记录的当前状态，这条信息是新进展、重复/旧信息，还是无法判断？',
      criteria: { new: '新的、时间更晚的进展', duplicate_or_old: '重复或旧信息', uncertain: '无法判断新旧' }
    },
    candidate: {
      type: 'choice',
      instructions: '这条进展属于哪个候选岗位？不能确定时必须选择 uncertain；没有任何候选匹配时选择 no_match。不要为了凑匹配而选公司名相同的其他岗位。',
      criteria: { ...candidateCriteria, no_match: '不属于任何候选', uncertain: '无法确定' }
    }
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.jevTimeoutMs);
  let res;
  try {
    res = await fetch(config.jevApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.jevApiKey}` },
      body: JSON.stringify({ model: config.jevModel || 'jev-latest', state, questions }),
      signal: controller.signal
    });
  } catch {
    throw new AppError(503, 'JEV_UNAVAILABLE', 'Jev 判断服务连接失败', { retryable: true });
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    if ([401, 403].includes(res.status)) throw new AppError(503, 'JEV_UNAUTHORIZED', 'Jev 判断服务鉴权失败', { retryable: false });
    throw new AppError(503, 'JEV_UNAVAILABLE', 'Jev 判断服务暂时不可用', { retryable: res.status >= 500 || res.status === 429 });
  }
  let data;
  try { data = await res.json(); } catch { throw new AppError(502, 'JEV_INVALID_RESPONSE', 'Jev 返回无法解析', { retryable: true }); }
  const answers = data?.answers || {};
  const noul = (key) => Number(answers[key]?.noul);
  const noulOrNull = (key) => Number.isFinite(noul(key)) ? noul(key) : null;
  const choice = (key) => ({
    value: answers[key]?.choice || null,
    confidence: Number(answers[key]?.confidence) || 0,
    probabilities: answers[key]?.probabilities || null
  });
  if (!Number.isFinite(noul('actual_progress')) || !choice('status').value || !choice('candidate').value) {
    throw new AppError(502, 'JEV_INVALID_RESPONSE', 'Jev 缺少必要判断字段', { retryable: true });
  }
  return {
    actual_progress: noul('actual_progress'),
    evidence_support: Number.isFinite(noul('evidence_support')) ? noul('evidence_support') : 0,
    company_valid: noulOrNull('company_valid'),
    job_title_valid: noulOrNull('job_title_valid'),
    fields_consistent: noulOrNull('fields_consistent'),
    status: choice('status'),
    newness: choice('newness'),
    candidate: choice('candidate'),
    model: data.model || config.jevModel || null,
    request_id: data.request_id || null,
    usage: data.usage || null
  };
}
