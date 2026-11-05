import { config } from '../../config.js';
import { AppError } from '../../util.js';
import { cloudChatJson, cloudLlmAvailable } from '../data-capture/cloud/llm.js';

// 服务端没有 WorkBuddy 浏览器登录态；本功能要求显式配置 OpenAI 兼容网关。
export function aiAvailable() { return Boolean(config.aiApiUrl); }
function provider() { return config.aiApiUrl ? 'openai_compatible' : 'workbuddy_cloud'; }

function unavailable() {
  if (!aiAvailable()) {
    return new AppError(503, 'AI_NOT_CONFIGURED', '尚未配置服务端 AI 模型网关（AI_API_URL/AI_API_KEY/AI_MODEL），AI 分析不可用', { retryable: false });
  }
  return new AppError(503, 'AI_UNAVAILABLE', 'AI 分析服务暂时不可用，请稍后重试', { retryable: true });
}

function parseJsonLoose(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch { /* try extracting an object */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('AI response is not JSON');
}

async function askOpenAiCompatible(system, user) {
  const base = String(config.aiApiUrl || '').replace(/\/$/, '');
  const url = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.aiLlmTimeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.aiApiKey ? { Authorization: `Bearer ${config.aiApiKey}` } : {})
      },
      body: JSON.stringify({
        model: config.aiModel || 'default',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      }),
      signal: controller.signal
    });
  } catch (err) {
    throw new AppError(503, 'AI_UNAVAILABLE', 'AI 服务连接失败，请稍后重试', { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    if ([401, 403].includes(response.status)) {
      throw new AppError(503, 'AI_UNAUTHORIZED', 'AI 服务鉴权失败，请检查服务端 AI_API_KEY / AI_API_URL 配置', { retryable: false });
    }
    throw new AppError(503, 'AI_UNAVAILABLE', 'AI 服务暂时不可用，请稍后重试', { retryable: response.status >= 500 });
  }
  let payload;
  try { payload = await response.json(); } catch { throw new AppError(502, 'AI_INVALID_RESPONSE', 'AI 返回结果无法解析，请重试', { retryable: true }); }
  const content = payload?.choices?.[0]?.message?.content
    ?? payload?.output?.text
    ?? payload?.answer
    ?? null;
  if (!content) throw new AppError(502, 'AI_INVALID_RESPONSE', 'AI 没有返回可解析的内容，请重试', { retryable: true });
  try { return parseJsonLoose(content); } catch { throw new AppError(502, 'AI_INVALID_RESPONSE', 'AI 返回结果不是有效 JSON，请重试', { retryable: true }); }
}

async function askJson(system, user) {
  if (!aiAvailable()) throw unavailable();
  let result;
  try {
    result = config.aiApiUrl
      ? await askOpenAiCompatible(system, user)
      : await cloudChatJson(system, user, { timeoutMs: config.aiLlmTimeoutMs });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unavailable();
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new AppError(502, 'AI_INVALID_RESPONSE', 'AI 返回结果无法解析，请重试', { retryable: true });
  }
  return result;
}

const text = (value, max = 500) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
const lines = (value, max = 6) => (Array.isArray(value) ? value : []).map((v) => text(v, 300)).filter(Boolean).slice(0, max);
const simplify = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
function evidence(value, resumeText) {
  const quote = text(value, 300);
  if (quote.length < 4) return null;
  return simplify(resumeText).includes(simplify(quote)) ? quote : null;
}
function groundedItems(value, resumeText, map) {
  return (Array.isArray(value) ? value : []).map((item) => map(item, resumeText)).filter(Boolean).slice(0, 20);
}

const PROFILE_SYSTEM = `你是严谨的简历结构化助手。只根据用户提供的简历原文提取信息，不得补充、推断或编造经历、公司、时间、技能或优势。
只输出 JSON，不要 Markdown，不要解释。结构：
{
  "summary": "不超过 180 字的简历概括",
  "skills": [{"name":"技能", "evidence":"简历原文中的短句（必须逐字出现）"}],
  "experiences": [{"organization":"组织/公司", "role":"角色", "period":"时间", "highlights":["职责或成果（每个不超过 80 字）"], "evidence":"简历原文中的短句（必须逐字出现）"}],
  "industries": [{"name":"行业", "evidence":"简历原文中的短句（必须逐字出现）"}],
  "strengths": [{"point":"优势", "evidence":"简历原文中的短句（必须逐字出现）"}],
  "constraints": [{"point":"限制或不确定项", "evidence":"简历原文中的短句（必须逐字出现）"}]
}
没有证据支持的数组项不要输出；evidence 必须是原文中相邻出现的文字，不要改写。`;

export async function analyzeResumeProfile(resumeText) {
  const source = String(resumeText || '').slice(0, 16000);
  if (!source.trim()) throw new AppError(422, 'RESUME_TEXT_EMPTY', '简历文本为空');
  const result = await askJson(PROFILE_SYSTEM, `简历原文（可能截断）：\n${source}`);
  const profile = {
    summary: text(result.summary, 800),
    skills: groundedItems(result.skills, source, (item, src) => {
      const name = text(item?.name, 100);
      const quote = evidence(item?.evidence, src);
      return name && quote ? { name, evidence: quote } : null;
    }),
    experiences: groundedItems(result.experiences, source, (item, src) => {
      const organization = text(item?.organization, 180);
      const role = text(item?.role, 120);
      const quote = evidence(item?.evidence, src);
      if (!quote || (!organization && !role)) return null;
      return {
        organization: organization || null,
        role: role || null,
        period: text(item?.period, 80) || null,
        highlights: lines(item?.highlights, 6),
        evidence: quote
      };
    }),
    industries: groundedItems(result.industries, source, (item, src) => {
      const name = text(item?.name, 80);
      const quote = evidence(item?.evidence, src);
      return name && quote ? { name, evidence: quote } : null;
    }),
    strengths: groundedItems(result.strengths, source, (item, src) => {
      const point = text(item?.point, 200);
      const quote = evidence(item?.evidence, src);
      return point && quote ? { point, evidence: quote } : null;
    }),
    constraints: groundedItems(result.constraints, source, (item, src) => {
      const point = text(item?.point, 200);
      const quote = evidence(item?.evidence, src);
      return point && quote ? { point, evidence: quote } : null;
    })
  };
  profile.grounded_items = profile.skills.length + profile.experiences.length + profile.industries.length
    + profile.strengths.length + profile.constraints.length;
  profile.grounded = profile.grounded_items > 0;
  profile.source = provider();
  profile.source_chars = source.length;
  return profile;
}

const COMPARE_SYSTEM = `你是求职岗位比较助手。用户给你一份已结构化的简历画像和 2 个以上岗位的 JD。
只能根据提供的简历画像、岗位名称、JD 文本做相对匹配判断，不得编造经历、技能、录用概率或未提供的岗位信息。
JD 不足的岗位必须标记 match_level="insufficient"，不能给出确定性优势。
只输出 JSON：
{
  "overview":"不超过 180 字的整体判断",
  "jobs":[{"application_id":"必须与输入一致","match_level":"high|medium|low|insufficient","strengths":["相对优势"],"gaps":["关键缺口"],"evidence":[{"resume_evidence":"简历依据","jd_evidence":"JD 依据"}],"next_step":"下一步建议"}],
  "differences":["岗位之间的主要差异"],
  "ranking":[{"application_id":"必须与输入一致","rank":1,"reason":"排序理由"}],
  "limitations":["本次判断的限制（如 JD 不足、简历信息不足）"]
}
不要输出百分比或录用概率。`;

export async function compareJobs({ profile, jobs }) {
  const payload = {
    resume_profile: profile,
    jobs: jobs.map((job) => ({
      application_id: job.id,
      company_name: job.company_name,
      job_title: job.job_title,
      status: job.status,
      has_applied: !!job.has_applied,
      location: job.location,
      recruitment_batch: job.recruitment_batch,
      jd: String(job.jd_text || job.jd_summary || '').slice(0, 6000),
      jd_chars: String(job.jd_text || job.jd_summary || '').length,
      information_sufficient: job.information_sufficient
    }))
  };
  const result = await askJson(COMPARE_SYSTEM, JSON.stringify(payload));
  const valid = new Set(jobs.map((j) => j.id));
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const jobResults = (Array.isArray(result.jobs) ? result.jobs : []).map((item) => {
    const id = String(item?.application_id || '');
    if (!valid.has(id)) return null;
    const base = byId.get(id);
    const level = ['high', 'medium', 'low', 'insufficient'].includes(item?.match_level) ? item.match_level : 'insufficient';
    const profileHay = simplify(JSON.stringify(profile));
    const jdHay = simplify(base.jd_text || base.jd_summary || '');
    const evidenceRows = (Array.isArray(item?.evidence) ? item.evidence : []).map((e) => ({
      resume_evidence: text(e?.resume_evidence, 300),
      jd_evidence: text(e?.jd_evidence, 300)
    })).filter((e) => {
      if (e.resume_evidence && !profileHay.includes(simplify(e.resume_evidence))) return false;
      if (e.jd_evidence && !jdHay.includes(simplify(e.jd_evidence))) return false;
      return Boolean(e.resume_evidence || e.jd_evidence);
    }).slice(0, 6);
    return {
      application_id: id,
      company_name: base.company_name,
      job_title: base.job_title,
      status: base.status,
      has_applied: !!base.has_applied,
      job_url: base.job_url || null,
      information_sufficient: !!base.information_sufficient,
      match_level: base.information_sufficient ? level : 'insufficient',
      strengths: lines(item?.strengths, 6),
      gaps: lines(item?.gaps, 6),
      evidence: evidenceRows,
      next_step: text(item?.next_step, 300)
    };
  }).filter(Boolean);
  return {
    overview: text(result.overview, 800),
    jobs: jobResults,
    differences: lines(result.differences, 8),
    ranking: (Array.isArray(result.ranking) ? result.ranking : []).filter((r) => valid.has(String(r?.application_id || '')))
      .map((r) => ({ application_id: String(r.application_id), rank: Number(r.rank) || null, reason: text(r.reason, 300) })).slice(0, jobs.length),
    limitations: lines(result.limitations, 8),
    source: provider()
  };
}

const RECOMMEND_SYSTEM = `你是求职推荐助手。用户给你一份已结构化简历画像，以及系统已采集、尚未投递的岗位。只根据这些数据输出相对匹配排序，不得编造岗位、经历或录用概率。
JD 不足的岗位不得当作确定推荐；调用方已经把信息不足的岗位单独列出，不要自行补全。
只输出 JSON：
{
  "summary":"不超过 120 字的推荐概览",
  "recommendations":[{"application_id":"必须与输入一致","rank":1,"match_level":"high|medium|low","reasons":["推荐理由"],"strengths":["匹配优势"],"gaps":["主要缺口"],"next_step":"建议动作"}],
  "limitations":["信息或判断限制"]
}
没有足够 JD 的岗位不要放进 recommendations。`;

export async function recommendJobs({ profile, jobs }) {
  const payload = {
    resume_profile: profile,
    jobs: jobs.map((job) => ({
      application_id: job.id,
      company_name: job.company_name,
      job_title: job.job_title,
      location: job.location,
      recruitment_batch: job.recruitment_batch,
      jd: String(job.jd_text || job.jd_summary || '').slice(0, 6000),
      jd_chars: String(job.jd_text || job.jd_summary || '').length
    }))
  };
  const result = await askJson(RECOMMEND_SYSTEM, JSON.stringify(payload));
  const valid = new Set(jobs.map((j) => j.id));
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const recommendations = (Array.isArray(result.recommendations) ? result.recommendations : []).map((item) => {
    const id = String(item?.application_id || '');
    if (!valid.has(id)) return null;
    const base = byId.get(id);
    return {
      application_id: id,
      company_name: base.company_name,
      job_title: base.job_title,
      job_url: base.job_url || null,
      location: base.location || null,
      rank: Number(item?.rank) || null,
      match_level: ['high', 'medium', 'low'].includes(item?.match_level) ? item.match_level : 'medium',
      reasons: lines(item?.reasons, 5),
      strengths: lines(item?.strengths, 5),
      gaps: lines(item?.gaps, 5),
      next_step: text(item?.next_step, 300)
    };
  }).filter(Boolean).sort((a, b) => (a.rank || 999) - (b.rank || 999));
  return {
    summary: text(result.summary, 500),
    recommendations,
    limitations: lines(result.limitations, 8),
    source: provider()
  };
}
