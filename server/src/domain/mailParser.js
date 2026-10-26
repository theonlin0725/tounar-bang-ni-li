import { clipText, normalizeWhitespace } from '../util.js';

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

export function stripHtml(value = '') {
  return normalizeWhitespace(String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"), 12000);
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

export function extractMailFields({ subject = '', bodyText = '', fromAddress = '' }) {
  const text = `${subject}\n${bodyText}`;
  const company = text.match(/(?:公司|企业|雇主|company)\s*[:：]\s*([^\n，,。;；]{2,40})/i)?.[1]?.trim() || null;
  const title = text.match(/(?:岗位|职位|应聘职位|position|role)\s*[:：]\s*([^\n，,。;；]{2,60})/i)?.[1]?.trim() || null;
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
    company_name: clipText(company || subjectCompany || '', 80) || null,
    job_title: clipText(title || subjectTitle || '', 100) || null,
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
