import { config } from '../../config.js';
import { AppError } from '../../util.js';

/* 当本机到 TypeSafe Jev 被 451/区域限制阻断时，用 Dify 云上的同一确认流程
 * （LLM 提取 + 真实 Jev HTTP 节点）做核验。Dify 只返回判断，不写台账。 */
export async function verifyViaDify({ subject, body, companyHint, jobTitleHint, candidates = [] }) {
  if (!config.difyApiUrl || !config.difyApiKey) {
    throw new AppError(503, 'DIFY_NOT_CONFIGURED', '未配置 Dify 兜底工作流', { retryable: false });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.difyTimeoutMs);
  let res;
  try {
    res = await fetch(`${config.difyApiUrl.replace(/\/$/, '')}/workflows/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.difyApiKey}` },
      body: JSON.stringify({
        inputs: {
          subject: String(subject || ''),
          body: String(body || ''),
          company_hint: String(companyHint || ''),
          job_title_hint: String(jobTitleHint || ''),
          candidates_json: JSON.stringify(candidates.slice(0, 8).map((c) => ({
            application_id: c.id, company_name: c.company_name, job_title: c.job_title,
            status: c.status, has_applied: !!c.has_applied
          })))
        },
        response_mode: 'blocking',
        user: config.difyUserId || 'tounar-confirm'
      }),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') throw new AppError(503, 'DIFY_TIMEOUT', 'Dify 核验超时', { retryable: true });
    throw new AppError(503, 'DIFY_UNAVAILABLE', 'Dify 核验服务连接失败', { retryable: true });
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    throw new AppError(503, 'DIFY_UNAVAILABLE', 'Dify 核验服务暂时不可用', { retryable: res.status >= 500 || res.status === 429 });
  }
  let data;
  try { data = await res.json(); } catch { throw new AppError(502, 'DIFY_INVALID_RESPONSE', 'Dify 返回无法解析', { retryable: true }); }
  if (data?.data?.status !== 'succeeded' || !data?.data?.outputs) {
    throw new AppError(502, 'DIFY_INVALID_RESPONSE', 'Dify 工作流未成功完成', { retryable: true });
  }
  const out = data.data.outputs;
  const missing = String(out.missing || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    company_name: out.company_name || null,
    job_title: out.job_title || null,
    status: out.status || null,
    missing,
    matched_candidate: out.matched_candidate || 'uncertain',
    candidate_confidence: Number(out.candidate_confidence) || 0,
    actual_progress: Number(out.actual_progress) || 0,
    evidence_support: Number(out.evidence_support) || 0,
    fields_consistent: Number(out.fields_consistent) || 0,
    decision: out.decision || '',
    error: out.error || '',
    model: 'dify-workflow+jev-1.14.0',
    workflow_run_id: data.workflow_run_id || null,
    elapsed_time: data.data.elapsed_time || null
  };
}
