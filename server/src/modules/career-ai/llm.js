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

const MATCH_DIMENSIONS = [
  ['hard_gate', '硬性门槛'],
  ['skills', '技能工具'],
  ['experience', '经历项目'],
  ['industry', '行业业务'],
  ['preference', '偏好地点'],
  ['achievements', '成果量化']
];
const MATCH_LEVELS = ['匹配', '部分匹配', '不匹配', '无法判断'];
const GATE_RESULTS = ['满足', '不满足', '信息不足', '需要用户确认'];
const PRIORITY_LEVELS = ['优先投', '适合投', '暂缓', '待确认'];

const MATCH_SYSTEM = `你是严谨的单岗位求职匹配分析助手。用户给你一份已结构化简历画像、简历原文、一个真实岗位的 JD，以及用户在此前报告中明确确认的补充。
只能根据输入材料判断，不得编造经历、技能、公司、时间、录用概率、百分比、评分或排名。不要把“简历没写”推断成“用户不会”，要写成“信息不足”或“暂未发现案例”。
只输出 JSON，不要 Markdown，不要解释。结构：
{
  "ability": {"conclusion":"匹配|部分匹配|不匹配|无法判断", "summary":"一句话能力结论（≤120字）", "basis":"依据（≤180字）"},
  "priority": {"conclusion":"优先投|适合投|暂缓|待确认", "summary":"一句话投递优先级结论（≤120字）", "basis":"只根据已确认偏好与当前条件说明依据（≤180字）"},
  "overall_advice": "一句总体建议（≤160字）",
  "hard_gates": [
    {"requirement":"JD 明确写出的硬性门槛", "jd_evidence":"JD 原文逐字短句", "user_info":"用户对应信息", "resume_evidence":"简历原文逐字短句，没有就留空", "result":"满足|不满足|信息不足|需要用户确认", "basis":"判断依据", "blocking":true}
  ],
  "dimensions": [
    {"key":"hard_gate|skills|experience|industry|preference|achievements", "requirement":"岗位要求", "user_evidence":"用户侧对应信息", "conclusion":"匹配|部分匹配|不匹配|无法判断", "strengths":["有证据的优势"], "gaps":["有证据的缺口或暂缺案例"], "evidence":[{"source":"jd|resume|user_confirmed","quote":"逐字引文"}], "next_step":"下一步建议"}
  ],
  "limitations":["本次判断的限制"]
}
规则：
1. hard_gates 只收录 JD 明确写出的门槛（工作许可、最低年限、指定城市线下办公、学历/证书等）。JD 没写就不要编。没有门槛时输出空数组。
2. 六维 dimensions 必须恰好覆盖 hard_gate、skills、experience、industry、preference、achievements 各一次，顺序一致。
3. evidence.quote 必须是输入 JD、简历原文或用户确认补充中逐字出现的文字；不能改写。source=user_confirmed 时才可引用“用户确认补充”。
4. 用户没有明确确认城市/通勤/远程偏好时，preference 维度要写无法判断，投递优先级不得写成无条件的“优先投”；可以说“适合投，但偏好待确认”。
5. 只要有 hard_gates.result=不满足，priority.conclusion 必须是“暂缓”，overall_advice 必须明确指出该门槛影响投递。需要用户确认或信息不足时，priority 不得超过“待确认”。
6. 能力结论与投递优先级是两件事，可以不同。弱材料不能写成肯定匹配；资料矛盾或需本人表态写“需要用户确认”。
7. 不得输出任何百分比、分数、录用概率或权重。
8. 六维的具体问法：硬性门槛只引用上一节检查项；技能工具区分“提到工具”和“用工具完成过项目”，并对照 JD 要求的熟练程度；经历项目对照职责、承担范围和交付物；行业业务说明哪些经验可迁移或不可迁移；偏好地点把“本人偏好”与“雇主强制要求”分开；成果量化只引用原文指标或可验证交付物，没有数字时不得补造数字。
9. 优势必须能回到某个维度、JD 原文和用户证据。对于“未发现案例”，要写成“查过的简历版本中未发现”，不能写成“用户不会”。`;

function jdLineFor(jdText, pattern) {
  return String(jdText || '').split(/\n+/).map((line) => line.replace(/^\s*\d{1,2}[、.．）)]\s*/, '')).find((line) => pattern.test(line)) || '';
}
function inferredHardGates(jdText, resumeText, existing = []) {
  const gates = [];
  const seen = new Set(existing.map((g) => simplify(g.requirement)));
  const soft = (line) => /优先|加分|更佳|非必须/.test(line);
  const add = (requirement, result, userInfo, resumeEvidence = '', basis = '', evidence = requirement) => {
    if (!requirement || seen.has(simplify(requirement))) return;
    seen.add(simplify(requirement));
    gates.push({
      requirement, jd_evidence: evidence, user_info: userInfo,
      resume_evidence: resumeEvidence, result, basis, blocking: result === '不满足'
    });
  };
  const degreeLine = jdLineFor(jdText, /(本科|硕士|博士)(?:及以上)?学历|学历要求/);
  if (degreeLine && !soft(degreeLine)) {
    const degree = /博士/.test(degreeLine) ? '博士' : /硕士/.test(degreeLine) ? '硕士' : '本科';
    const exists = existing.some((g) => simplify(g.requirement).includes(simplify(degree)) && simplify(g.requirement).includes('学历'));
    if (!exists) {
      const resumeLine = String(resumeText || '').split(/\n+/).find((line) => line.includes(degree));
      add(`${degree}及以上学历`, resumeLine ? '满足' : '信息不足',
        resumeLine ? `简历提到：${resumeLine.trim().slice(0, 120)}` : '简历没有可核验的学历信息',
        resumeLine ? resumeLine.trim().slice(0, 120) : '',
        'JD 原文明确列出学历条件；只按简历原文核对。', degreeLine);
    }
  }
  const yearsLine = jdLineFor(jdText, /\d+\s*年(?:以上)?[^。；\n]{0,30}(?:经验|经历)|(?:至少|最低)\s*\d+\s*年/);
  if (yearsLine && !soft(yearsLine)) {
    const required = Number((yearsLine.match(/(\d+)\s*年/) || [])[1] || 0);
    const exists = existing.some((g) => required > 0 && simplify(g.requirement).includes(String(required)) && /年|经验/.test(g.requirement));
    if (!exists) {
      const resumeLines = String(resumeText || '').split(/\n+/);
      const yearLine = resumeLines.find((line) => required > 0 && new RegExp(`${required}\\s*年[^。；\\n]{0,30}(?:经验|经历)`).test(line));
      const requirement = (yearsLine.match(/\d+\s*年(?:以上)?[^，。；\n]{0,24}(?:经验|经历)/) || [])[0] || yearsLine;
      add(requirement, yearLine ? '满足' : '信息不足',
        yearLine ? `简历提到：${yearLine.trim().slice(0, 120)}` : '简历没有可核验的完整年限',
        yearLine ? yearLine.trim().slice(0, 120) : '',
        'JD 原文明确列出最低年限；年限按简历原文核对，缺失时不推断为满足。', yearsLine);
    }
  }
  const locationLine = jdLineFor(jdText, /(工作地点|办公地点|base)[：:\s]*(上海|北京|深圳|广州|杭州|成都|南京|武汉|苏州|西安|厦门|长沙|青岛|天津|重庆)|(?:上海|北京|深圳|广州|杭州).{0,8}(?:线下|现场|坐班|到岗)/i);
  if (locationLine && !soft(locationLine)) {
    const city = (locationLine.match(/(上海|北京|深圳|广州|杭州|成都|南京|武汉|苏州|西安|厦门|长沙|青岛|天津|重庆)/) || [])[1];
    const onsite = /线下|现场|坐班|到岗/.test(locationLine);
    const exists = existing.some((g) => {
      const requirement = simplify(g.requirement);
      return city && requirement.includes(simplify(city)) && (!onsite || /线下|现场|坐班|到岗/.test(g.requirement));
    });
    if (!exists) {
      const resumeLine = city ? String(resumeText || '').split(/\n+/)
        .find((line) => line.includes(city) && /现居|目前|所在地|现住|base|可接受|愿意|能够|常住/i.test(line)) : '';
      add(`${city || ''}${onsite ? '线下办公' : '工作地点'}`, resumeLine ? '满足' : '需要用户确认',
        resumeLine ? `简历提到：${resumeLine.trim().slice(0, 120)}` : `需要本人确认${onsite ? '能否线下办公' : '工作地点'}${city ? `（${city}）` : ''}`,
        resumeLine ? resumeLine.trim().slice(0, 120) : '',
        '只把 JD 明确写出的地点/办公方式作为门槛；简历没有确认时交还用户确认。', locationLine);
    }
  }
  const licenseLine = jdLineFor(jdText, /(?:必须|须|要求).{0,16}(?:证书|资格|执照|工作许可|签证)/);
  if (licenseLine && !soft(licenseLine)) {
    const exists = existing.some((g) => /证书|资格|执照|许可|签证/.test(g.requirement));
    if (!exists) {
      const resumeLine = String(resumeText || '').split(/\n+/).find((line) => /(证书|资格|执照|许可|签证)/.test(line));
      add(licenseLine, resumeLine ? '满足' : '信息不足',
        resumeLine ? `简历提到：${resumeLine.trim().slice(0, 120)}` : '简历没有可核验的许可或证书信息',
        resumeLine ? resumeLine.trim().slice(0, 120) : '',
        'JD 原文明确列出许可/证书条件；没有证据时不推断为满足。', licenseLine);
    }
  }
  return gates;
}

function normalizeMatchEvidence(items, sources) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const quote = text(item?.quote, 300);
    if (quote.length < 2) return null;
    const declared = ['jd', 'resume', 'user_confirmed'].includes(item?.source) ? item.source : null;
    const hay = declared === 'jd' ? sources.jdText : declared === 'resume' ? sources.resumeText
      : declared === 'user_confirmed' ? sources.confirmedText : `${sources.jdText}\n${sources.resumeText}\n${sources.confirmedText}`;
    if (!simplify(hay).includes(simplify(quote))) return null;
    return { source: declared || (simplify(sources.confirmedText).includes(simplify(quote)) ? 'user_confirmed'
      : simplify(sources.resumeText).includes(simplify(quote)) ? 'resume' : 'jd'), quote };
  }).filter(Boolean).slice(0, 8);
}

export async function matchJob({ profile, resumeText, job, corrections = [] }) {
  const jdText = String(job.jd_text || job.jd_summary || '');
  const confirmedText = corrections.map((c) => String(c.user_text || '')).join('\n');
  const payload = {
    resume_profile: profile,
    resume_text: String(resumeText || '').slice(0, 16000),
    job: {
      company_name: job.company_name,
      job_title: job.job_title,
      status: job.status,
      has_applied: !!job.has_applied,
      location: job.location || null,
      recruitment_batch: job.recruitment_batch || null,
      jd: jdText.slice(0, 8000),
      jd_chars: jdText.length,
      information_sufficient: jdText.length >= 80
    },
    confirmed_additions: corrections.map((c) => ({
      dimension: c.dimension,
      user_text: c.user_text,
      proposed_field: c.proposed_field,
      scope: c.scope,
      confirmed_at: c.created_at
    }))
  };
  const result = await askJson(MATCH_SYSTEM, JSON.stringify(payload));
  const sources = { resumeText: String(resumeText || ''), jdText, confirmedText };
  const validDimensionKeys = new Set(MATCH_DIMENSIONS.map(([key]) => key));
  let hardGates = (Array.isArray(result.hard_gates) ? result.hard_gates : []).map((gate) => {
    const requirement = text(gate?.requirement, 300);
    const jdEvidence = text(gate?.jd_evidence, 300);
    const jdGrounded = jdEvidence.length >= 2 && simplify(jdText).includes(simplify(jdEvidence));
    let gateResult = GATE_RESULTS.includes(gate?.result) ? gate.result : '信息不足';
    // JD 没有逐字依据的“门槛”不是门槛，整条丢弃，避免把模型补充的要求当成雇主硬条件。
    if (!requirement || !jdGrounded) return null;
    const resumeEvidence = text(gate?.resume_evidence, 300);
    const resumeGrounded = resumeEvidence.length >= 2
      && (simplify(sources.resumeText).includes(simplify(resumeEvidence))
        || simplify(sources.confirmedText).includes(simplify(resumeEvidence)));
    if (gateResult === '满足' && !resumeGrounded) gateResult = '信息不足';
    return {
      requirement,
      jd_evidence: jdGrounded ? jdEvidence : '',
      user_info: text(gate?.user_info, 500),
      resume_evidence: resumeGrounded ? resumeEvidence : '',
      result: gateResult,
      basis: text(gate?.basis, 500),
      blocking: gateResult === '不满足'
    };
  }).filter(Boolean).slice(0, 10);
  // 模型漏掉“本科/最低年限/指定城市线下”等明确门槛时，用 JD 原文线索补足；
  // 只做门槛发现，不从简历缺失推断不满足，仍然走信息不足/需要用户确认。
  hardGates = [...hardGates, ...inferredHardGates(jdText, resumeText, hardGates)].slice(0, 10);
  const byKey = new Map();
  for (const item of Array.isArray(result.dimensions) ? result.dimensions : []) {
    const key = String(item?.key || '');
    if (!validDimensionKeys.has(key) || byKey.has(key)) continue;
    byKey.set(key, item);
  }
  let dimensions = MATCH_DIMENSIONS.map(([key, name]) => {
    const item = byKey.get(key);
    const evidenceRows = normalizeMatchEvidence(item?.evidence, sources);
    let conclusion = MATCH_LEVELS.includes(item?.conclusion) ? item.conclusion : '无法判断';
    if (!evidenceRows.length) conclusion = '无法判断';
    return {
      key,
      name,
      requirement: text(item?.requirement, 600) || 'JD 未提供足够信息',
      user_evidence: text(item?.user_evidence, 800) || '资料不足',
      conclusion,
      strengths: lines(item?.strengths, 6),
      gaps: lines(item?.gaps, 6),
      evidence: evidenceRows,
      next_step: text(item?.next_step, 400)
    };
  });
  const gateDimensionIndex = dimensions.findIndex((d) => d.key === 'hard_gate');
  const gateFails = hardGates.filter((g) => g.result === '不满足');
  const gateNeeds = hardGates.filter((g) => ['需要用户确认', '信息不足'].includes(g.result));
  let gateConclusion = '无法判断';
  if (hardGates.length) {
    if (gateFails.length) gateConclusion = '不匹配';
    else if (gateNeeds.length) gateConclusion = '无法判断';
    else gateConclusion = '匹配';
  }
  const gateEvidence = hardGates.flatMap((g) => [
    ...(g.jd_evidence ? [{ source: 'jd', quote: g.jd_evidence }] : []),
    ...(g.resume_evidence ? [{ source: 'resume', quote: g.resume_evidence }] : [])
  ]).slice(0, 8);
  const gateDimension = {
    key: 'hard_gate',
    name: '硬性门槛',
    requirement: hardGates.length ? hardGates.map((g) => g.requirement).join('；') : 'JD 未列明硬性门槛',
    user_evidence: hardGates.length ? hardGates.map((g) => `${g.requirement}：${g.user_info || '—'}（${g.result}）`).join('；') : 'JD 没有写明工作许可、最低年限、指定城市线下办公等硬性条件。',
    conclusion: gateConclusion,
    strengths: hardGates.filter((g) => g.result === '满足').map((g) => `${g.requirement}：${g.user_info || '已满足'}`),
    gaps: [...gateFails.map((g) => `${g.requirement}：${g.basis || '明确不满足'}`),
      ...gateNeeds.map((g) => `${g.requirement}：${g.result}`)],
    evidence: gateEvidence,
    next_step: gateFails.length ? '这条门槛会影响投递；先与招聘方确认是否可豁免。'
      : gateNeeds.length ? '补齐或向招聘方确认这条门槛后再决定投递优先级。'
        : hardGates.length ? '门槛信息已核对；仍需以招聘方最新要求为准。' : '补充 JD 或向招聘方确认门槛。'
  };
  if (gateDimensionIndex >= 0) dimensions[gateDimensionIndex] = gateDimension;
  else dimensions = [gateDimension, ...dimensions.filter((d) => d.key !== 'hard_gate')];

  const dimStrengths = dimensions.flatMap((d) => d.strengths.map((item) => ({
    dimension: d.name, key: d.key, text: item, evidence: d.evidence,
    kind: '有证据的优势'
  })));
  const dimGaps = dimensions.flatMap((d) => d.gaps.map((item) => ({
    dimension: d.name, key: d.key, text: item, requirement: d.requirement,
    evidence: d.evidence, next_step: d.next_step,
    kind: d.conclusion === '无法判断' || !d.user_evidence || d.user_evidence === '—' ? '资料不足' : '明确差距'
  })));
  const evidencedDimensions = dimensions.filter((d) => d.evidence.length > 0 && d.conclusion !== '无法判断');
  const ability = {
    conclusion: MATCH_LEVELS.includes(result.ability?.conclusion) ? result.ability.conclusion : '无法判断',
    summary: text(result.ability?.summary, 500),
    basis: text(result.ability?.basis, 600)
  };
  if (!evidencedDimensions.length) {
    ability.conclusion = '无法判断';
    ability.summary = '当前没有找到可逐字核验的能力证据，不能给出肯定匹配结论。';
    ability.basis = '简历或用户确认补充中没有可与 JD 要求逐字对照的证据。';
  }
  const priority = {
    conclusion: PRIORITY_LEVELS.includes(result.priority?.conclusion) ? result.priority.conclusion : '待确认',
    summary: text(result.priority?.summary, 500),
    basis: text(result.priority?.basis, 600)
  };
  if (gateFails.length) {
    priority.conclusion = '暂缓';
    priority.summary = `存在硬性门槛不满足：${gateFails.map((g) => g.requirement).join('；')}`;
  } else if (gateNeeds.length && ['优先投', '适合投'].includes(priority.conclusion)) {
    priority.conclusion = '待确认';
    priority.summary = `门槛信息需要确认：${gateNeeds.map((g) => g.requirement).join('；')}`;
  } else if (ability.conclusion === '无法判断' && ['优先投', '适合投'].includes(priority.conclusion)) {
    priority.conclusion = '待确认';
    priority.summary = '能力材料不足，先补齐与 JD 对应的证据，再判断投递优先级。';
  }
  const limitations = lines(result.limitations, 8);
  let overallAdvice = text(result.overall_advice, 600);
  if (gateFails.length && !gateFails.some((g) => overallAdvice.includes(g.requirement))) {
    overallAdvice = `存在硬性门槛不满足：${gateFails.map((g) => g.requirement).join('；')}。${overallAdvice}`.slice(0, 700);
  }
  if (jdText.trim().length < 80) limitations.push('JD 文本较短，岗位要求可能不完整；相关结论只基于已采集内容。');
  if (!dimensions.some((d) => d.evidence.some((e) => e.source === 'resume' || e.source === 'user_confirmed'))) {
    limitations.push('本次没有找到可逐字核验的简历证据，能力相关结论已降为无法判断。');
  }
  return {
    report_version: 'match-v1',
    analyzed_at: new Date().toISOString(),
    ability,
    priority,
    overall_advice: overallAdvice,
    hard_gates: hardGates,
    dimensions,
    strengths: dimStrengths.slice(0, 24),
    gaps: dimGaps.slice(0, 24),
    limitations: [...new Set(limitations)].slice(0, 10),
    corrections_used: corrections.map((c) => ({
      id: c.id, dimension: c.dimension, user_text: c.user_text, proposed_field: c.proposed_field, scope: c.scope
    })),
    source: provider()
  };
}

const INTERVIEW_SYSTEM = `你是面试准备助手。根据给定岗位、JD、简历画像和已经生成的匹配报告，生成与岗位要求及能力缺口直接相关的问题。
只输出 JSON：{"questions":[{"question":"面试问题","basis":"对应的 JD 要求或报告依据","dimension":"hard_gate|skills|experience|industry|preference|achievements"}]}
不得编造用户经历；不得生成与岗位无关的泛泛问题；最多 8 个问题。`;

export async function generateInterviewQuestions({ profile, job, report }) {
  const answer = await askJson(INTERVIEW_SYSTEM, JSON.stringify({
    resume_profile: profile,
    job: {
      company_name: job.company_name, job_title: job.job_title,
      jd: String(job.jd_text || job.jd_summary || '').slice(0, 7000)
    },
    match_report: {
      ability: report.ability, priority: report.priority,
      gaps: report.gaps?.slice(0, 12),
      dimensions: report.dimensions?.map((d) => ({
        key: d.key, name: d.name, conclusion: d.conclusion,
        requirement: d.requirement, user_evidence: d.user_evidence, gaps: d.gaps
      }))
    }
  }));
  const validKeys = new Set(MATCH_DIMENSIONS.map(([key]) => key));
  return {
    questions: (Array.isArray(answer.questions) ? answer.questions : []).map((item) => {
      const question = text(item?.question, 300);
      if (!question) return null;
      return {
        question,
        basis: text(item?.basis, 400),
        dimension: validKeys.has(item?.dimension) ? item.dimension : 'experience'
      };
    }).filter(Boolean).slice(0, 8)
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
