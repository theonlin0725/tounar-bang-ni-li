import { clipText, normalizeWhitespace } from '../../../util.js';

const POSITIVE_KEYWORDS = [
  '笔试', '测评', '在线考试', '面试', '邀请', '录用', 'offer', '意向书', '录取', '感谢',
  '遗憾', '未通过', '不合适', '流程结束', '岗位关闭', '撤回', '进展', '申请', '简历', '招聘',
  'assessment', 'interview', 'offer', 'application', 'recruitment', 'unfortunately', 'not selected'
];

const RECRUITMENT_DOMAIN_HINTS = ['jobs.', 'careers.', 'campus.', 'recruit.', 'hr.', 'talent.', 'zhaopin.', 'hire.'];
const COMMON_RECRUITING_DOMAINS = [
  'boss直聘', 'boss.com', 'nowcoder.com', 'shixiseng.com', 'lagou.com', 'zhaopin.com', '51job.com',
  'liepin.com', 'maimai.cn', 'hotjob.cn', 'yingjiesheng.com'
];

export function stripHtml(value = '', keepLines = false) {
  const text = String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return keepLines ? text.replace(/[^\S\n]+/g, " ").trim().slice(0, 12000) : normalizeWhitespace(text, 12000);
}

export function isRecruitmentHeader(subject = '', fromDomain = '', bodyText = '') {
  const s = String(subject || '').toLowerCase();
  const d = String(fromDomain || '').toLowerCase();
  const b = String(bodyText || '').toLowerCase();
  const hasKeyword = POSITIVE_KEYWORDS.some((k) => s.includes(k.toLowerCase()) || b.includes(k.toLowerCase()));
  const domainLike = RECRUITMENT_DOMAIN_HINTS.some((h) => d.includes(h))
    || COMMON_RECRUITING_DOMAINS.some((h) => d.includes(h))
    || /\.edu\.cn$/.test(d);
  if (!hasKeyword && !domainLike) return false;
  if (/newsletter|unsubscribe|广告|促销|优惠券|发票|订单|发货|验证码/.test(s) && !/面试|笔试|offer|录用|申请|岗位/.test(s)) return false;
  return true;
}

function hasAny(text, list) {
  return list.some((word) => text.includes(word));
}

export function classifyRecruitmentMail({ subject = '', fromDomain = '', bodyText = '', mode = 'headers_only' }) {
  const s = String(subject || '');
  const text = `${s}\n${mode === 'recruitment_body' ? bodyText : ''}`.toLowerCase();
  if (!isRecruitmentHeader(s, fromDomain, mode === 'recruitment_body' ? bodyText : '')) {
    return { relevant: false, category: 'other', confidence: 0, round_label: null, status: null, reason: 'not_recruitment' };
  }
  const offer = hasAny(text, ['录用', 'offer', '意向书', '录取通知', '正式录用']);
  const closed = hasAny(text, ['流程结束', '岗位关闭', '职位关闭', '撤回', 'withdrawn', 'position closed']);
  const interview = hasAny(text, ['面试', 'interview', '面谈']);
  const assessment = hasAny(text, ['笔试', '测评', '在线考试', 'online assessment', 'written test']);
  // 「感谢您的应聘」类最常见于拒信，但也可能是收简历回执。
  // 只有确认没有面试/笔试/录用信息时才当拒信，而且置信度封顶 0.88（低于自动终态 0.9，必进待确认）。
  const explicitNegative = hasAny(text, ['未通过', '不合适', '很遗憾', '遗憾地', 'not selected', 'unfortunately', '感谢信', '拒绝', '进入人才库', '暂不匹配']);
  // 投递成功回执：明确的“已提交/已收到申请”才算已投递；仅“感谢投递”不算（可能是拒信或营销）。
  const appliedReceipt = hasAny(text, [
    '投递成功', '申请成功', '提交成功', '已成功提交', '申请已收到', '已收到您的简历', '已收到您的申请',
    '简历已收到', '申请已提交', 'successfully submitted', 'application submitted', 'application has been submitted',
    'we have received your application', 'received your resume'
  ]);
  const thankYouOnly = !explicitNegative && !interview && !assessment && !offer && !closed
    && hasAny(text, ['感谢您的应聘', '感谢您应聘', '感谢您的投递', '感谢您投递', '感谢您参加本次', 'thank you for your application', 'thanks for applying']);
  const negative = explicitNegative || thankYouOnly;
  const genericInvite = hasAny(text, ['恭喜', '邀请', 'invite', 'congratulations']);
  let category = 'other';
  if (!explicitNegative && appliedReceipt) category = 'applied';
  else if (negative) category = 'rejected';
  else if (closed) category = 'closed';
  else if (offer) category = 'offer';
  else if (interview) category = 'interview';
  else if (assessment) category = 'assessment';
  else if (genericInvite && hasAny(text, ['申请', '岗位', '职位', 'application'])) category = 'application_update';
  const roundMatch = text.match(/(一面|二面|三面|终面|hr面|群面|初面|复试|终试)/i)
    || text.match(/\b(first|second|third|final)\s+round\b/i);
  const roundLabel = roundMatch ? roundMatch[1] : null;
  const scheduleMatch = text.match(/(20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}[日]?(?:\s*[T ]?\d{1,2}:\d{2})?)/);
  let scheduled = null;
  if (scheduleMatch) {
    const raw = scheduleMatch[1].replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-');
    const parsed = Date.parse(raw.length <= 10 ? raw + 'T09:00:00+08:00' : raw + ':00+08:00');
    if (Number.isFinite(parsed)) scheduled = new Date(parsed).toISOString();
  }
  let status = null;
  if (category === 'applied') status = 'applied';
  else if (category === 'assessment') status = 'assessment';
  else if (category === 'interview') status = 'interview';
  else if (category === 'offer') status = 'offer';
  else if (category === 'rejected') status = 'rejected';
  else if (category === 'closed') status = 'closed';
  return {
    relevant: true,
    category,
    status,
    round_label: roundLabel,
    interview_scheduled_at: scheduled,
    confidence: category === 'other' || category === 'application_update' ? 0.4 : (category === 'applied' ? 0.94 : (negative || offer ? (explicitNegative || offer ? 0.95 : 0.88) : (/面试邀请|笔试邀请|测评邀请|invitation to interview/i.test(text) ? 0.94 : 0.88))),
    reason: category
  };
}


const PUBLIC_MAIL_DOMAINS = new Set(['qq.com', 'vip.qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'gmail.com', 'outlook.com', 'hotmail.com']);
const COMPANY_PLACEHOLDERS = /^(?:通知|招聘|测评|笔试|面试|投递|申请|系统|校招|春招|秋招|社招|未知|待补充|待定|未填写|招聘系统|校园招聘|社会招聘|hr|noreply|no-reply)$/i;
const TITLE_PLACEHOLDERS = /^(?:通知|招聘|测评|笔试|面试|投递|申请|系统|校招|春招|秋招|社招|未知|待补充|待定|未填写|邀请|成功|收到|请您|岗位|职位)$/i;
function cleanMailEntity(value, { title = false } = {}) {
  let text = String(value || '').replace(/^[【\[]|[】\]]$/g, '').replace(/\s+/g, ' ').trim();
  text = text.replace(/(?:校园招聘|社会招聘|招聘|有限公司)$/u, '').trim();
  if (!text || text.length < 2 || (title ? TITLE_PLACEHOLDERS : COMPANY_PLACEHOLDERS).test(text)) return null;
  const lower = text.toLowerCase();
  if (PUBLIC_MAIL_DOMAINS.has(lower) || /@|https?:|:\/\//i.test(text)) return null;
  if (title) {
    text = text.replace(/[\s\-—·｜|]*(?:测评邀请|笔试邀请|面试邀请|投递成功|申请成功|录用通知|面试通知|笔试通知|测评通知)(?:通知)?$/u, '').trim();
    if (!text || TITLE_PLACEHOLDERS.test(text) || /(?:邀请|通知|成功|收到|请您)/.test(text)) return null;
  }
  return text;
}


function firstValidEntity(text, pattern, options = {}) {
  for (const match of String(text || '').matchAll(pattern)) {
    const value = cleanMailEntity(match[1], options);
    if (value) return value;
  }
  return null;
}

export function extractMailFields({ subject = '', bodyText = '', fromAddress = '' }) {
  const text = `${subject}\n${bodyText}`;
  const company = firstValidEntity(text, /(?:公司|企业|雇主|company)\s*[:：]\s*([^\n，,。;；]{2,40})/gi);
  const title = firstValidEntity(text, /(?:岗位|职位|应聘职位|position|role)\s*[:：]\s*([^\n，,。;；]{2,60})/gi, { title: true });
  const applicationId = text.match(/(?:申请编号|申请号|application\s*(?:id|no\.?)|reference)\s*[:：#]?\s*([A-Za-z0-9_-]{4,40})/i)?.[1] || null;
  // A conservative subject fallback: 【公司】岗位 or 公司 · 岗位. It stays a candidate, not an auto-merge key.
  let subjectCompany = null;
  let subjectTitle = null;
  const bracket = subject.match(/【([^】]{2,30})】\s*([^，,。;；]{2,60})?/);
  if (bracket) {
    subjectCompany = bracket[1].trim();
    subjectTitle = bracket[2]?.trim() || null;
  }
  const dotted = subject.match(/^([^·|｜]{2,30})\s*[·|｜]\s*([^，,。;；]{2,60})/);
  if (!subjectCompany && dotted) {
    subjectCompany = dotted[1].trim();
    subjectTitle = dotted[2].trim();
  }
  const domain = String(fromAddress || '').split('@')[1]?.toLowerCase() || null;
  return {
    company_name: clipText(company || cleanMailEntity(subjectCompany || ''), 80) || null,
    job_title: clipText(title || cleanMailEntity(subjectTitle || '', { title: true }), 100) || null,
    site_application_id: applicationId ? clipText(applicationId, 60) : null,
    from_domain: domain
  };
}

export function publicEvidence({ subject, bodyText, mode }) {
  return {
    subject_excerpt: clipText(subject, 120),
    body_excerpt: mode === 'recruitment_body' ? clipText(stripHtml(bodyText), 300) : null,
    body_retained: false,
    read_mode: mode
  };
}

export function candidateApplicationsForText(ownerId, text, allApplications) {
  const haystack = String(text || '').toLowerCase();
  return allApplications.filter((app) => {
    const company = String(app.company_name || '').toLowerCase();
    const title = String(app.job_title || '').toLowerCase();
    const appId = String(app.site_application_id || '').toLowerCase();
    if (appId && haystack.includes(appId)) return true;
    return company.length >= 2 && haystack.includes(company) && (!title || haystack.includes(title));
  });
}

// Only explicit personal receipts/invitations qualify for offline automatic entry.
export function confirmedMailProgress(subject, bodyText) {
  const text = subject + '\n' + bodyText;
  if (/^(?:re|fw|fwd|回复|转发)\s*[:：]/i.test(subject) ||
      /(?:流程介绍|招聘流程|模拟测评|模拟面试|宣讲会|未通过|取消|很遗憾|未获|尚未|未收到|不代表|广告|岗位推荐|如(?:果)?(?:您|你)?通过|若(?:您|你)?通过|若您|如您)/.test(text)) return null;
  const stages = [
    ['assessment', /(?:邀请(?:您|你)(?:参加|完成)|请(?:您|你)?(?:于[^。\n]{0,30})?(?:参加|完成)).{0,22}(?:测评|笔试|在线考试)|(?:测评|笔试)邀请/],
    ['interview', /(?:邀请(?:您|你)参加|请(?:您|你)?参加).{0,22}面试|面试邀请/],
    ['applied', /(?:已收到您(?:提交)?的(?:简历|申请)|您的(?:岗位)?申请已(?:成功提交|收到)|投递成功)/]
  ].filter(([, pattern]) => pattern.test(text));
  if (stages.length !== 1 || /offer|录用通知|流程结束|人才库/i.test(text)) return null;
  const company = bodyText.match(/(?:^|[\n，,；;。])\s*(?:公司(?:名称)?|企业名称|招聘单位)\s*[:：]\s*([^\n，,；;。:：]{2,48})/m)?.[1]?.trim();
  const bracket = subject.match(/^【([^】]{2,30})】/u);
  const title = bodyText.match(/(?:^|[\n，,；;。])\s*(?:应聘岗位|应聘职位|岗位(?:名称)?|职位(?:名称)?)\s*[:：]\s*([^\n，,；;。:：]{2,60})/m)?.[1]?.trim()
    || subject.match(/^【[^】]+】\s*(.{2,40}?)\s*[-—·｜| ]*(?:测评邀请|笔试邀请|面试邀请|投递成功)(?:通知)?$/u)?.[1]?.trim();
  const employer = cleanMailEntity(company || bracket?.[1] || '');
  const safeTitle = cleanMailEntity(title, { title: true });
  if (!employer || !safeTitle) return null;
  return { company_name: employer, job_title: safeTitle, status: stages[0][0] };
}
