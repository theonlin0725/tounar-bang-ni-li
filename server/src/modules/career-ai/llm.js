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
9. 优势必须能回到某个维度、JD 原文和用户证据。对于“未发现案例”，要写成“查过的简历版本中未发现”，不能写成“用户不会”。
10. 工作许可、线下办公、学历、最低年限、指定证书等门槛：只有对应用户侧原文才能支持“满足/不满足”；没有原文写“信息不足”。“仅接受远程”与强制线下冲突可写“不满足”；“未取得工作许可”可写“不满足”；境外许可不能冒充中国境内许可。
11. 优势、缺口、用户事实中的技能名和数字必须能在对应 JD、简历或用户确认补充中找到；没有证据的营收、百分比、技能和成果不要输出。
12. 顶部总体建议必须服从门槛结论：任一硬门槛“不满足”只能建议暂缓；门槛“信息不足/需要用户确认”不能建议优先投递或适合投递。
13. 岗位技能、研究方向、职责描述、任职要求中的普通能力项不是硬门槛，应放进对应六维；不要把“未呈现/专业不同/未提及”判成“不满足”，否则输出“信息不足”或“需要用户确认”。只有不可妥协的资格条件（工作许可、强制地点、最低学历/年限、必要证书等）才放 hard_gates。`;

const CITY_RE = /(上海|北京|深圳|广州|杭州|成都|南京|武汉|苏州|西安|厦门|长沙|青岛|天津|重庆)/;
const PERMIT_RE = /(工作许可|就业资格|工作签证|居留许可|劳工证|执业许可)/;
const CREDENTIAL_RE = /(证书|资格|执照|许可证|许可|签证)/;
const SOFT_RE = /优先|加分|更佳|非必须/;
const HARD_OTHER_MARKER = /必须|须|持有|不接受|最低|至少|不得超过|不超过|硬性|门槛/;
const SOURCE_LABELS = { jd: 'JD 原文', resume: '简历原文', user_confirmed: '用户确认补充' };

function sourceText(...values) {
  return values.filter(Boolean).map((v) => String(v)).join('\n');
}
function sourceLines(textValue) {
  return String(textValue || '').split(/\r?\n+/).map((line) => line.trim()).filter(Boolean);
}
function lineMatching(textValue, pattern) {
  return sourceLines(textValue).find((line) => pattern.test(line)) || '';
}
function jdLineFor(jdText, pattern) {
  return sourceLines(jdText).map((line) => line.replace(/^\s*\d{1,2}[、.．）)]\s*/, '')).find((line) => pattern.test(line)) || '';
}
function gateCategory(requirement, evidence = '') {
  const classify = (s) => {
    if (PERMIT_RE.test(s)) return 'work_auth';
    if (/(线下|现场|坐班|到岗|远程办公|办公地点|工作地点|\bbase\b)/i.test(s)) return 'location';
    if (/(学历|本科|硕士|博士)/.test(s)) return 'degree';
    if (/(\d+\s*年|至少|最低).{0,20}(经验|经历)/.test(s)) return 'years';
    if (CREDENTIAL_RE.test(s)) return 'license';
    return '';
  };
  return classify(String(requirement || '')) || classify(String(evidence || '')) || 'other';
}
function isSoftRequirement(requirement, evidence = '') {
  const s = `${requirement || ''} ${evidence || ''}`;
  if (!SOFT_RE.test(s)) return false;
  const req = simplify(requirement);
  const ev = simplify(evidence);
  const index = req ? ev.indexOf(req) : -1;
  if (index >= 0) {
    const after = ev.slice(index + req.length, index + req.length + 8);
    const suffix = ev.slice(index);
    const before = ev.slice(Math.max(0, index - 14), index);
    if (/^(?:优先|加分|更佳|非必须)/.test(after)) return true;
    if (/^.{0,12}(?:优先|加分|更佳|非必须)/.test(suffix)
      && !/必须|须|要求|需要|需|及以上|最低|至少|以上|不接受远程/.test(requirement)
      && !/必须|须|要求|需要|需|最低|至少/.test(before)) return true;
    if (!SOFT_RE.test(requirement) && /必须|须|要求|需要|需|及以上|最低|至少|以上|不接受远程/.test(requirement)) return false;
    if (/必须|须|要求|需要|需|最低|至少/.test(before)) return false;
    // 同一行后面的“住宿优先”等无关软条件不应抹掉前面的硬性要求。
    return false;
  }
  return !/必须|须|及以上|最低|至少|以上|不接受远程/.test(requirement);
}
function claimTextGrounded(value, { userText = '', jdText = '', allowJd = false } = {}) {
  const claim = text(value, 800);
  if (!claim) return false;
  const hay = simplify(`${userText}\n${allowJd ? jdText : ''}`);
  const numbers = claim.match(/\d+(?:\.\d+)?\s*(?:万|亿|%|小时|天|年|个月|人|个|元|次|倍)?/g) || [];
  for (const token of numbers) if (!hay.includes(simplify(token))) return false;
  const latin = claim.match(/[A-Za-z][A-Za-z0-9+#._/-]{1,}/g) || [];
  for (const token of latin) {
    if (/^(?:jd|ai|pdf|docx)$/i.test(token)) continue;
    if (!hay.includes(simplify(token))) return false;
  }
  return true;
}
function uniqueEvidence(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (!row?.quote) return false;
    const key = `${row.source || ''}\u0000${simplify(row.quote)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function userSourceLines(resumeText, confirmedText) {
  return sourceLines(sourceText(resumeText, confirmedText));
}
function evidenceResult(result, userInfo, resumeEvidence, basis, category, extra = {}) {
  return {
    result, user_info: userInfo, resume_evidence: resumeEvidence || '', basis,
    blocking: result === '不满足', category, ...extra
  };
}

/* 用 JD 原文发现门槛；这里只负责“发现”，具体满足/不满足统一由 evaluateGate 核验。 */
function inferredHardGates(jdText, resumeText, existing = []) {
  const gates = [];
  const seen = new Set(existing.map((g) => simplify(g.requirement)));
  const hasCategory = (category, matcher = () => true) => existing.some((g) => gateCategory(g.requirement, g.jd_evidence) === category && matcher(g));
  const add = (requirement, evidence, category) => {
    if (!requirement || seen.has(simplify(requirement))) return;
    seen.add(simplify(requirement));
    gates.push({
      requirement, jd_evidence: evidence || requirement, user_info: '', resume_evidence: '',
      result: '信息不足', basis: '', blocking: false, category
    });
  };
  const degreeLine = jdLineFor(jdText, /(本科|硕士|博士)(?:及以上)?学历(?!\s*优先)|学历要求(?!\s*优先)/);
  if (degreeLine && !hasCategory('degree')) {
    const degree = /博士/.test(degreeLine) ? '博士' : /硕士/.test(degreeLine) ? '硕士' : '本科';
    add(`${degree}及以上学历`, degreeLine, 'degree');
  }
  const yearsLine = jdLineFor(jdText, /\d+\s*年(?:以上)?[^，。；\n]{0,24}(?:经验|经历)(?!\s*优先)|(?:至少|最低)\s*\d+\s*年/);
  if (yearsLine && !hasCategory('years')) {
    const requirement = (yearsLine.match(/\d+\s*年(?:以上)?[^，。；\n]{0,24}(?:经验|经历)/) || [])[0] || yearsLine;
    add(requirement, yearsLine, 'years');
  }
  const locationLine = jdLineFor(jdText, /(?:必须|须|要求|需要|需|不接受远程).{0,16}(?:线下|现场|坐班|到岗)|(?:线下|现场|坐班|到岗).{0,10}(?:必须|要求|需要|需)/);
  if (locationLine && !hasCategory('location')) {
    const city = (locationLine.match(CITY_RE) || [])[1];
    const onsite = /线下|现场|坐班|到岗/.test(locationLine);
    const softLocation = /(?:线下|现场|坐班|到岗)[^，。；\n]{0,4}(?:优先|加分)|(?:优先|加分)[^，。；\n]{0,4}(?:线下|现场|坐班|到岗)/.test(locationLine);
    if (onsite && !softLocation) add(`${city || ''}线下办公`, locationLine, 'location');
  }
  const licenseLine = jdLineFor(jdText, /(?:必须|须|要求).{0,20}(?:证书|资格|执照|工作许可|签证|就业资格)/);
  if (licenseLine && !/(?:证书|资格|执照|许可|签证)[^，。；\n]{0,4}(?:优先|加分)/.test(licenseLine)) {
    const category = gateCategory(licenseLine, licenseLine);
    if (!hasCategory(category)) {
      const requirement = (licenseLine.match(/(?:必须|须|要求).{0,20}(?:证书|资格|执照|工作许可|签证|就业资格)[^，。；\n]*/) || [])[0] || licenseLine;
      add(requirement, licenseLine, category);
    }
  }
  return gates;
}

function parseDegreeRank(value) {
  if (/博士/.test(value)) return 3;
  if (/硕士/.test(value)) return 2;
  if (/本科/.test(value)) return 1;
  if (/大专|专科/.test(value)) return 0;
  return null;
}
function gateYearsDomain(requirement, evidence) {
  const source = `${requirement || ''} ${evidence || ''}`;
  const m = source.match(/\d+\s*年(?:以上)?([^，。；\n]{0,24}?)(?:工作)?(?:经验|经历)/);
  return (m?.[1] || '').replace(/相关|以上|左右|的/g, '').trim();
}
function evaluateGate(gate, sources) {
  const requirement = gate.requirement || '';
  const jdEvidence = gate.jd_evidence || '';
  const combinedJD = `${requirement}\n${jdEvidence}`;
  const category = gate.category || gateCategory(requirement, jdEvidence);
  const userLines = userSourceLines(sources.resumeText, sources.confirmedText);
  const userText = userLines.join('\n');
  const modelResult = GATE_RESULTS.includes(gate.result) ? gate.result : '信息不足';
  const modelEvidence = gate.resume_evidence && (
    simplify(sources.resumeText).includes(simplify(gate.resume_evidence))
    || simplify(sources.confirmedText).includes(simplify(gate.resume_evidence))
  ) ? gate.resume_evidence : '';

  if (category === 'work_auth') {
    const line = lineMatching(userText, PERMIT_RE);
    if (!line) {
      return evidenceResult('信息不足', '简历没有可核验的工作许可/就业资格信息', '', 'JD 明确要求工作许可；简历未提供对应许可原文。', category);
    }
    const negative = /未取得|没有|无|尚未|不具备|暂无|未持有/.test(line);
    const positive = /(持有|已取得|取得|拥有|具备|有)/.test(line) && !negative;
    const needsChina = /中国|境内/.test(combinedJD);
    const foreign = /美国|加拿大|英国|澳大利亚|新加坡|境外|其他国家/.test(line) && !/中国|境内/.test(line);
    if (negative) return evidenceResult('不满足', `简历原文：${line}`, line, '简历明确表示未取得对应工作许可。', category);
    if (needsChina && foreign) return evidenceResult('信息不足', `简历原文：${line}`, line, '简历提到境外许可，但没有中国境内有效工作许可原文。', category);
    if (positive) return evidenceResult('满足', `简历原文：${line}`, line, '简历原文明确持有对应工作许可。', category);
    return evidenceResult('信息不足', `简历提到：${line}`, line, '简历提到许可信息，但未说明是否持有 JD 要求的许可。', category);
  }

  if (category === 'location') {
    const mandatory = /(必须|须|要求|需要|需|不接受远程).{0,16}(线下|现场|坐班|到岗)|(线下|现场|坐班|到岗)/.test(combinedJD);
    if (!mandatory) return null; // 普通“工作地点上海”不升级为硬门槛。
    const city = (combinedJD.match(CITY_RE) || [])[1];
    const remoteOnly = lineMatching(userText, /(?:仅|只)(?:接受|可|能)?远程|不接受线下|无法(?:线下|到岗|现场)|只远程|仅远程/);
    if (remoteOnly) return evidenceResult('不满足', `简历原文：${remoteOnly}`, remoteOnly, 'JD 要求线下办公，但简历明确表示仅接受远程/无法线下。', category);
    const onsiteLine = lineMatching(userText, /(可接受|接受|可以|能够|能).{0,6}(线下|现场|到岗|坐班)|(线下|现场|到岗|坐班).{0,6}(可接受|接受|可以|能够|能)/);
    const cityLine = city ? lineMatching(userText, new RegExp(city)) : '';
    if (!onsiteLine) {
      if (cityLine) return evidenceResult('信息不足', `简历只写到：${cityLine}；未说明是否接受线下办公`, cityLine, '现居城市不等于接受线下办公，需本人确认。', category);
      return evidenceResult('信息不足', '简历没有可核验的线下办公意愿', '', 'JD 要求线下办公；简历未提供接受线下办公的原文。', category);
    }
    if (city && !cityLine) {
      return evidenceResult('需要用户确认', `简历原文：${onsiteLine}；未确认当前所在城市`, onsiteLine, `简历接受线下，但没有确认能在${city}办公。`, category);
    }
    if (city && cityLine && !new RegExp(city).test(onsiteLine) && !new RegExp(city).test(cityLine)) {
      return evidenceResult('需要用户确认', `简历原文：${onsiteLine}`, onsiteLine, `简历接受线下，但未确认能在${city}办公。`, category);
    }
    return evidenceResult('满足', `简历原文：${onsiteLine}`, onsiteLine, '简历明确接受线下办公，与 JD 要求一致。', category);
  }

  if (category === 'degree') {
    const required = parseDegreeRank(combinedJD);
    if (required == null) return evidenceResult('信息不足', 'JD 没有可解析的学历要求', '', '无法解析学历门槛。', category);
    const line = lineMatching(userText, /(本科|硕士|博士|大专|专科)/);
    const actual = parseDegreeRank(line);
    if (actual == null) return evidenceResult('信息不足', '简历没有可核验的学历信息', '', 'JD 明确要求学历；简历未提供对应学历原文。', category);
    if (actual >= required) return evidenceResult('满足', `简历原文：${line}`, line, '简历学历层级满足 JD 要求。', category);
    return evidenceResult('不满足', `简历原文：${line}`, line, '简历学历层级低于 JD 明确要求。', category);
  }

  if (category === 'years') {
    const required = Number((combinedJD.match(/(\d+)\s*年/) || [])[1] || 0);
    const domain = gateYearsDomain(requirement, jdEvidence);
    const yearLines = userLines.map((line) => ({ line, years: Number((line.match(/(\d+)\s*年/) || [])[1] || 0) }))
      .filter((x) => x.years > 0 && /(经验|经历)/.test(x.line));
    if (!yearLines.length) return evidenceResult('信息不足', '简历没有可核验的完整年限', '', 'JD 明确列出最低年限；简历未提供年限原文。', category);
    const matching = yearLines.find((x) => x.years >= required && (!domain || x.line.includes(domain)));
    if (matching) return evidenceResult('满足', `简历原文：${matching.line}`, matching.line, '简历年限和对应领域满足 JD 要求。', category);
    const enoughDifferent = yearLines.find((x) => x.years >= required);
    if (enoughDifferent) {
      return evidenceResult('信息不足', `简历原文：${enoughDifferent.line}；但未提供「${domain || '对应领域'}」经历`, enoughDifferent.line,
        '有足够年限，但简历没有提供与 JD 对应领域的经历原文，不能直接判满足。', category);
    }
    const sameDomainLower = yearLines.find((x) => domain && x.line.includes(domain));
    if (sameDomainLower) return evidenceResult('不满足', `简历原文：${sameDomainLower.line}`, sameDomainLower.line, '简历对应领域年限低于 JD 要求。', category);
    return evidenceResult('信息不足', `简历原文：${yearLines[0].line}`, yearLines[0].line, '简历有工作年限，但未提供与 JD 对应领域的年限。', category);
  }

  if (category === 'license') {
    const line = lineMatching(userText, CREDENTIAL_RE);
    if (!line) return evidenceResult('信息不足', '简历没有可核验的证书/资格信息', '', 'JD 明确列出证书/资格门槛；简历未提供原文。', category);
    const negative = /未取得|没有|无|尚未|不具备|暂无|未持有/.test(line);
    if (negative) return evidenceResult('不满足', `简历原文：${line}`, line, '简历明确表示未取得该证书/资格。', category);
    const requiredToken = (combinedJD.match(/([\u4e00-\u9fa5]{2,12}(?:证书|资格|执照|许可))/))?.[1] || '';
    const positive = /(持有|已取得|取得|拥有|具备|有)/.test(line);
    if (positive && (!requiredToken || line.includes(requiredToken))) {
      return evidenceResult('满足', `简历原文：${line}`, line, '简历原文明确持有对应证书/资格。', category);
    }
    return evidenceResult('信息不足', `简历原文：${line}`, line, '简历提到其他证书/资格，但没有 JD 要求的对应原文。', category);
  }

  // 非固定类型：只有用户侧证据才允许支持“满足/不满足”，没有证据时降为信息不足。
  const evidence = modelEvidence;
  if (!evidence && ['满足', '不满足'].includes(modelResult)) {
    return evidenceResult('信息不足', gate.user_info || '简历没有可核验的对应证据', '', '模型结论没有对应用户侧证据，不能作为硬门槛判断。', category);
  }
  if (!evidence) return evidenceResult(modelResult === '需要用户确认' ? modelResult : '信息不足', gate.user_info || '资料不足', '', '没有可核验的用户侧证据。', category);
  if (modelResult === '不满足' && !/(不具备|未取得|未持有|尚未|不接受|无法|不符合|不满足|没有)/.test(evidence)) {
    return evidenceResult('信息不足', gate.user_info || `现有材料只显示：${evidence}`, evidence,
      '现有材料没有明确冲突，不能据此判“不满足”；需补充或由本人确认。', category);
  }
  return evidenceResult(modelResult, gate.user_info || `简历原文：${evidence}`, evidence, gate.basis || '按简历原文核验。', category);
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
  const normalizeGate = (gate) => {
    const requirement = text(gate?.requirement, 300);
    const jdEvidence = text(gate?.jd_evidence, 300);
    const jdGrounded = jdEvidence.length >= 2 && simplify(jdText).includes(simplify(jdEvidence));
    if (!requirement || !jdGrounded || isSoftRequirement(requirement, jdEvidence)) return null;
    const category = gate.category || gateCategory(requirement, jdEvidence);
    // 岗位技能、研究方向、职责描述不是不可妥协门槛；只有明确硬性措辞的“其他”才保留。
    if (category === 'other' && !HARD_OTHER_MARKER.test(`${requirement} ${jdEvidence}`)) return null;
    const evaluated = evaluateGate({
      requirement, jd_evidence: jdEvidence,
      resume_evidence: text(gate?.resume_evidence, 300),
      user_info: text(gate?.user_info, 500), basis: text(gate?.basis, 500),
      result: GATE_RESULTS.includes(gate?.result) ? gate.result : '信息不足',
      category
    }, sources);
    return evaluated ? { requirement, jd_evidence: jdEvidence, ...evaluated } : null;
  };
  let hardGates = (Array.isArray(result.hard_gates) ? result.hard_gates : [])
    .map(normalizeGate).filter(Boolean).slice(0, 10);
  // 模型漏掉“本科/最低年限/指定城市线下/工作许可”等明确门槛时，用 JD 原文线索补足；
  // 兜底只发现门槛，满足/不满足统一走 evaluateGate，并由用户侧证据决定。
  const inferred = inferredHardGates(jdText, resumeText, hardGates)
    .map(normalizeGate).filter(Boolean);
  hardGates = [...hardGates, ...inferred].filter((gate, index, arr) => {
    const key = `${gate.category}\u0000${simplify(gate.requirement)}`;
    return arr.findIndex((x) => `${x.category}\u0000${simplify(x.requirement)}` === key) === index;
  }).slice(0, 10);
  const byKey = new Map();
  for (const item of Array.isArray(result.dimensions) ? result.dimensions : []) {
    const key = String(item?.key || '');
    if (!validDimensionKeys.has(key) || byKey.has(key)) continue;
    byKey.set(key, item);
  }
  let dimensions = MATCH_DIMENSIONS.map(([key, name]) => {
    const item = byKey.get(key);
    const evidenceRows = normalizeMatchEvidence(item?.evidence, sources);
    const userEvidenceRows = evidenceRows.filter((e) => e.source === 'resume' || e.source === 'user_confirmed');
    let conclusion = MATCH_LEVELS.includes(item?.conclusion) ? item.conclusion : '无法判断';
    if (!evidenceRows.length || (key !== 'hard_gate' && !userEvidenceRows.length)) conclusion = '无法判断';
    const modelUserEvidence = text(item?.user_evidence, 800);
    const userEvidence = userEvidenceRows.length
      ? (claimTextGrounded(modelUserEvidence, { userText: sourceText(resumeText, confirmedText) })
        ? modelUserEvidence : userEvidenceRows.map((e) => e.quote).join('；'))
      : '资料不足';
    const strengths = conclusion === '无法判断' ? []
      : lines(item?.strengths, 6).filter((lineValue) => claimTextGrounded(lineValue, {
        userText: sourceText(resumeText, confirmedText)
      }));
    const gaps = lines(item?.gaps, 6).filter((lineValue) => claimTextGrounded(lineValue, {
      userText: sourceText(resumeText, confirmedText), jdText, allowJd: true
    }));
    return {
      key,
      name,
      requirement: text(item?.requirement, 600) || 'JD 未提供足够信息',
      user_evidence: userEvidence,
      conclusion,
      strengths,
      gaps,
      evidence: evidenceRows,
      next_step: text(item?.next_step, 400)
    };
  });
  const gateDimensionIndex = dimensions.findIndex((d) => d.key === 'hard_gate');
  const gateFails = hardGates.filter((g) => g.result === '不满足');
  const gateNeeds = hardGates.filter((g) => g.result === '需要用户确认');
  const gateInfo = hardGates.filter((g) => g.result === '信息不足');
  const gateUnresolved = [...gateNeeds, ...gateInfo];
  let gateConclusion = '无法判断';
  if (hardGates.length) {
    if (gateFails.length) gateConclusion = '不匹配';
    else if (gateUnresolved.length) gateConclusion = '无法判断';
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
    strengths: hardGates.filter((g) => g.result === '满足').map((g) => `${g.requirement}：${g.user_info || '已满足'}`)
      .filter((lineValue) => claimTextGrounded(lineValue, { userText: sourceText(resumeText, confirmedText) })),
    gaps: [...gateFails.map((g) => `${g.requirement}：${g.basis || '明确不满足'}`),
      ...gateUnresolved.map((g) => `${g.requirement}：${g.result}`)]
      .filter((lineValue) => claimTextGrounded(lineValue, { userText: sourceText(resumeText, confirmedText), jdText, allowJd: true })),
    evidence: gateEvidence,
    next_step: gateFails.length ? '这条门槛会影响投递；先与招聘方确认是否可豁免。'
      : gateUnresolved.length ? '补齐或向招聘方确认这条门槛后再决定投递优先级。'
        : hardGates.length ? '门槛信息已核对；仍需以招聘方最新要求为准。' : '补充 JD 或向招聘方确认门槛。'
  };
  if (gateDimensionIndex >= 0) dimensions[gateDimensionIndex] = gateDimension;
  else dimensions = [gateDimension, ...dimensions.filter((d) => d.key !== 'hard_gate')];

  const dimStrengths = dimensions.flatMap((d) => d.strengths.map((item) => ({
    dimension: d.name, key: d.key, dimension_key: d.key, text: item,
    evidence: d.evidence,
    user_evidence: d.evidence.filter((e) => e.source === 'resume' || e.source === 'user_confirmed'),
    kind: '有证据的优势'
  })));
  const dimGaps = dimensions.flatMap((d) => d.gaps.map((item) => ({
    dimension: d.name, key: d.key, dimension_key: d.key, text: item, requirement: d.requirement,
    evidence: d.evidence,
    user_evidence: d.evidence.filter((e) => e.source === 'resume' || e.source === 'user_confirmed'),
    next_step: d.next_step,
    kind: d.conclusion === '无法判断' || d.user_evidence === '资料不足' ? '资料不足' : '明确差距'
  })));
  const userTextAll = sourceText(resumeText, confirmedText);
  const evidencedDimensions = dimensions.filter((d) => d.key !== 'hard_gate'
    && d.conclusion !== '无法判断'
    && d.evidence.some((e) => e.source === 'resume' || e.source === 'user_confirmed'));
  const verifiedUserQuotes = [...new Set(dimensions.flatMap((d) => d.evidence
    .filter((e) => e.source === 'resume' || e.source === 'user_confirmed')
    .map((e) => e.quote)))].slice(0, 4);
  const ability = {
    conclusion: MATCH_LEVELS.includes(result.ability?.conclusion) ? result.ability.conclusion : '无法判断',
    summary: text(result.ability?.summary, 500),
    basis: text(result.ability?.basis, 600)
  };
  if (!evidencedDimensions.length) {
    ability.conclusion = '无法判断';
    ability.summary = '当前没有找到可逐字核验的用户侧能力证据，不能给出肯定匹配结论。';
    ability.basis = '简历或用户确认补充中没有可与 JD 要求逐字对照的证据。';
  } else {
    if (!claimTextGrounded(ability.summary, { userText: userTextAll })) {
      ability.summary = `已核验的用户侧证据覆盖：${evidencedDimensions.map((d) => d.name).join('、')}；未核验的模型表述已移除。`;
    }
    if (!claimTextGrounded(ability.basis, { userText: userTextAll })) {
      ability.basis = `简历/用户确认原文：${verifiedUserQuotes.join('；') || '暂无可核验引文'}`;
    }
  }
  const priority = {
    conclusion: PRIORITY_LEVELS.includes(result.priority?.conclusion) ? result.priority.conclusion : '待确认',
    summary: text(result.priority?.summary, 500),
    basis: text(result.priority?.basis, 600)
  };
  let overallAdvice = text(result.overall_advice, 600);
  if (gateFails.length) {
    priority.conclusion = '暂缓';
    priority.summary = `存在硬性门槛不满足：${gateFails.map((g) => g.requirement).join('；')}`;
    priority.basis = `硬门槛原文核验：${gateFails.map((g) => `${g.requirement}（${g.resume_evidence || g.basis}）`).join('；')}`;
    overallAdvice = `先处理硬性门槛：${gateFails.map((g) => g.requirement).join('；')}。在这些条件满足前，暂不要按优先投递推进。`;
  } else if (gateUnresolved.length) {
    if (['优先投', '适合投'].includes(priority.conclusion)) priority.conclusion = '待确认';
    priority.summary = `硬性门槛需要确认或补充：${gateUnresolved.map((g) => g.requirement).join('；')}`;
    priority.basis = `硬门槛尚未核验：${gateUnresolved.map((g) => `${g.requirement}（${g.result}）`).join('；')}；不能据此建议优先投递。`;
    overallAdvice = `先确认或补齐硬性门槛：${gateUnresolved.map((g) => g.requirement).join('；')}。在确认前不要按优先投递推进。`;
  } else if (ability.conclusion === '无法判断' && ['优先投', '适合投'].includes(priority.conclusion)) {
    priority.conclusion = '待确认';
    priority.summary = '能力材料不足，先补齐与 JD 对应的用户侧证据，再判断投递优先级。';
    overallAdvice = '先补齐与岗位要求对应的简历或用户确认证据，再判断投递优先级。';
  } else {
    if (!claimTextGrounded(priority.summary, { userText: userTextAll })) priority.summary = '当前证据支持继续了解岗位，但偏好与条件仍需结合本人确认。';
    if (!claimTextGrounded(priority.basis, { userText: userTextAll })) priority.basis = `已核验用户侧原文：${verifiedUserQuotes.join('；') || '暂无'}`;
    if (!claimTextGrounded(overallAdvice, { userText: userTextAll })) {
      overallAdvice = '基于已核验的简历证据与硬门槛结果，建议按当前匹配结论准备材料，再结合本人偏好决定投递。';
    }
  }
  const limitations = lines(result.limitations, 8);
  if (!claimTextGrounded(ability.summary, { userText: userTextAll })) {
    limitations.push('模型的部分能力表述缺少用户侧原文，已从事实结论中移除。');
  }
  if (jdText.trim().length < 80) limitations.push('JD 文本较短，岗位要求可能不完整；相关结论只基于已采集内容。');
  if (!dimensions.some((d) => d.evidence.some((e) => e.source === 'resume' || e.source === 'user_confirmed'))) {
    limitations.push('本次没有找到可逐字核验的简历证据，能力相关结论已降为无法判断。');
  }
  return {
    report_version: 'match-v2',
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

export async function generateInterviewQuestions({ profile, job, report, resumeText = '', confirmedText = '' }) {
  const jd = String(job.jd_text || job.jd_summary || '').slice(0, 7000);
  const answer = await askJson(INTERVIEW_SYSTEM, JSON.stringify({
    resume_profile: profile,
    job: {
      company_name: job.company_name, job_title: job.job_title,
      jd
    },
    match_report: {
      ability: report.ability, priority: report.priority,
      gaps: report.gaps?.slice(0, 12),
      dimensions: report.dimensions?.map((d) => ({
        key: d.key, name: d.name, conclusion: d.conclusion,
        requirement: d.requirement, user_evidence: d.user_evidence, gaps: d.gaps,
        evidence: d.evidence
      }))
    }
  }));
  const validKeys = new Set(MATCH_DIMENSIONS.map(([key]) => key));
  const userText = sourceText(resumeText, confirmedText);
  return {
    questions: (Array.isArray(answer.questions) ? answer.questions : []).map((item) => {
      const question = text(item?.question, 300);
      const basis = text(item?.basis, 400);
      if (!question) return null;
      if (!claimTextGrounded(question, { userText, jdText: jd, allowJd: true })) return null;
      if (basis && !claimTextGrounded(basis, { userText, jdText: jd, allowJd: true })) return null;
      return {
        question, basis,
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
