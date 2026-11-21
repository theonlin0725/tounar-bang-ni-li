import { clipText, normalizeWhitespace } from '../../../util.js';
import { companyIdentity } from '../../../domain/mailMatching.js';

const POSITIVE_KEYWORDS = [
  '笔试', '测评', '在线考试', '面试', '邀请', '录用', 'offer', '意向书', '录取', '感谢',
  '遗憾', '未通过', '不合适', '流程结束', '岗位关闭', '撤回', '进展', '申请', '简历', '招聘',
  '网申', '校招', '秋招', '春招', '实习', '管培', '行测', '机试', 'ai面', '一面', '二面', '终面',
  '群面', '复试', '资格审查', '谈薪', '意向', '背调', '体检', '人才库', '测评通知', '笔试通知',
  '面试通知', '面试安排', '录用通知', '感谢信', 'next steps', 'coding challenge', 'superday',
  'assessment', 'interview', 'offer', 'application', 'recruitment', 'unfortunately', 'not selected'
];

const COMPOSITE_ROLE_WORDS = '管理培训生|管培生|实习生|工程师|产品经理|项目经理|运营|设计师|研究员|分析师|顾问|开发|算法|测试|财务|人力|销售|市场|策划';
const RECRUITMENT_DOMAIN_HINTS = ['jobs.', 'careers.', 'campus.', 'recruit.', 'hr.', 'talent.', 'zhaopin.', 'hire.'];
const ATS_DOMAINS = ['mokahr.com','beisen.com','italent.cn','hotjob.cn','workday.com','myworkdayjobs.com','greenhouse.io','lever.co','ashbyhq.com','smartrecruiters.com','shl.com','acmcoder.com','hackerrank.com','codility.com','hirevue.com','nowcoder.com','cmbchina.com','95555.com'];
const COMMON_RECRUITING_DOMAINS = [
  'boss直聘', 'boss.com', 'nowcoder.com', 'shixiseng.com', 'lagou.com', 'zhaopin.com', '51job.com',
  'liepin.com', 'maimai.cn', 'hotjob.cn', 'yingjiesheng.com', ...ATS_DOMAINS
];

export function stripHtml(value = '', keepLines = false) {
  const text = String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|tr)>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return keepLines ? text.replace(/[^\S\n]+/g, " ").trim().slice(0, 12000) : normalizeWhitespace(text, 12000);
}

export function mailBodyForModel(value = '', head = 4500, tail = 1500) {
  const text = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}\n\n[...正文中部省略...]\n\n${text.slice(-tail)}`;
}

export function isSelfOrNoiseMail({ subject = '', fromAddress = '', fromName = '', bodyText = '', selfAddresses = [] } = {}) {
  const sender = `${fromAddress || ''} ${fromName || ''}`.toLowerCase();
  const text = `${subject || ''}\n${bodyText || ''}`.toLowerCase();
  const selfMailbox = (Array.isArray(selfAddresses) ? selfAddresses : [selfAddresses]).filter(Boolean).join(' ').toLowerCase();
  const selfTokens = selfMailbox.match(/[a-z0-9._%+-]+@[a-z0-9.-]+/gi) || [];
  const from = String(fromAddress || '').toLowerCase();
  const strongRecruiting = /(?:面试邀请|笔试通知|测评通知|在线测评|录用通知|offer\s*letter|申请已提交|投递成功|网申进度|面试安排|笔试安排|测评安排)/i.test(`${subject}\n${bodyText}`);
  if (from && selfTokens.some((token) => token.toLowerCase() === from)) return true;
  if (/(?:tounar\.local|tounar|帮你理)/i.test(sender)
    && !strongRecruiting
    && /(?:验证码|登录|提醒|摘要|测试|系统通知|no-?reply|donotreply)/i.test(`${sender}\n${text}`)) return true;
  if (/(?:验证码|账单|发票|快递|物流|消费|还款|订单|发货|促销|优惠券|newsletter|unsubscribe|退订)/i.test(`${subject}\n${bodyText}`)
    && !strongRecruiting) return true;
  return false;
}

export function isRecruitmentHeader(subject = '', fromDomain = '', bodyText = '', fromName = '') {
  const s = `${subject || ''} ${fromName || ''}`.toLowerCase();
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

export function classifyRecruitmentMail({ subject = '', fromDomain = '', bodyText = '', fromName = '', mode = 'headers_only' }) {
  const s = String(subject || '');
  const text = `${s}\n${mode === 'recruitment_body' ? bodyText : ''}`.toLowerCase();
  if (!isRecruitmentHeader(s, fromDomain, mode === 'recruitment_body' ? bodyText : '', fromName)) {
    return { relevant: false, category: 'other', confidence: 0, round_label: null, status: null, reason: 'not_recruitment' };
  }
  const offer = hasAny(text, ['录用', 'offer', '意向书', '录取通知', '正式录用']);
  const closed = hasAny(text, ['流程结束', '岗位关闭', '职位关闭', '撤回', 'withdrawn', 'position closed']);
  const interview = hasAny(text, ['面试', 'interview', '面谈']);
  const assessment = hasAny(text, ['笔试', '测评', '在线考试', 'online assessment', 'written test']);
  // 「感谢您的应聘」类最常见于拒信，但也可能是收简历回执。
  // 只有确认没有面试/笔试/录用信息时才当拒信，而且置信度封顶 0.88（低于自动终态 0.9，必进待确认）。
  const reschedule = hasAny(text, ['改期', '面试时间调整', '时间调整', 'reschedule', '时间不合适'])
    && !hasAny(text, ['未通过', '很遗憾', '遗憾地', 'not selected', 'unfortunately', '拒绝', '进入人才库', '暂不匹配']);
  const explicitNegative = hasAny(text, ['未通过', '不合适', '很遗憾', '遗憾地', 'not selected', 'unfortunately', '感谢信', '拒绝', '进入人才库', '暂不匹配']) && !reschedule;
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
const TITLE_PLACEHOLDERS = /^(?:通知|招聘|测评|笔试|面试|投递|申请|系统|校招|春招|秋招|社招|线上|在线|未知|待补充|待定|未填写|邀请|成功|收到|请您|岗位|职位)$/i;
export function cleanMailEntity(value, { title = false } = {}) {
  let text = String(value || '').replace(/^[【\[]|[】\]]$/g, '').replace(/\s+/g, ' ').trim();
  text = text.replace(/(?:校园招聘|社会招聘|招聘|有限公司)$/u, '').trim();
  if (!text || text.length < 2 || (title ? TITLE_PLACEHOLDERS : COMPANY_PLACEHOLDERS).test(text)) return null;
  const lower = text.toLowerCase();
  if (PUBLIC_MAIL_DOMAINS.has(lower) || /@|https?:|:\/\//i.test(text)) return null;
  if (/https?:\/\/|www\.|(?:^|[\s(])(?:[a-z0-9-]+\.)+(?:com|cn|net|org|edu)(?:\/|\b)/i.test(text)
    || /请到官网|点击(?:链接|这里)|公众号|招聘链接/i.test(text)) return null;
  if (!title && (/^\d+$/.test(text) || /^\d+\s*公司$/.test(text) || /^20\d{2}\s*(?:届|年)?(?:校园招聘|校招|社招|秋招|春招|测评)?$/.test(text) || /^(?:pm|hr|产品|运营|技术|数据|销售|市场)岗位$/i.test(text)
    || /^(?:recruitment|careers?|campus|talent|zhaopin|hr|noreply|no-reply|admin|service|notification|通知|招聘|招聘系统|管理系统|tounar|帮你理|moka|mokahr|北森|北森云|牛客|牛客网|赛码|赛码网|italent|hotjob|nowcoder|shl|hirevue|workday|greenhouse|lever)$/i.test(text))) return null;
  if (!title && ATS_DOMAINS.some((d) => lower === d || lower.endsWith(`.${d}`))) return null;
  if (title && (/^\d+$/.test(text) || /^20\d{2}\s*(?:届|年)?(?:校园招聘|校招|社招|秋招|春招|测评)?$/.test(text))) return null;
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


export function stripMailBoilerplate(bodyText) {
  return String(bodyText || '').split(/\r?\n/).filter((line) => {
    const value = line.trim();
    if (!value) return true;
    if (/^(?:此邮件|本邮件).{0,20}(?:自动发送|请勿直接回复|系统发送)/.test(value)) return false;
    if (/^(?:如需|如您|若您).{0,24}(?:取消|放弃|撤回|改期|忽略|退订)/.test(value)) return false;
    if (/^(?:招聘流程|投递流程|申请流程|流程说明|网申流程)\s*[:：]/.test(value)) return false;
    if (/^(?:unsubscribe|退订|请勿回复)/i.test(value)) return false;
    return true;
  }).join('\n').trim()
    .replace(/[。；;\s]*如您已(?:取消|放弃|撤回).{0,24}(?:忽略|无需|不必).{0,8}/g, ' ')
    .replace(/[。；;\s]*如您(?:尚未|未).{0,24}(?:忽略|无需|不必).{0,8}/g, ' ')
    .trim();
}

export function splitCompositeEntity(company, jobTitle = null, batch = null) {
  let c = cleanMailEntity(company || '');
  let t = cleanMailEntity(jobTitle || '', { title: true });
  let b = batch || null;
  if (!c) return { company_name: null, job_title: t, recruitment_batch: b };
  const roleWords = COMPOSITE_ROLE_WORDS;
  let m = c.match(new RegExp(`^(20\\d{2})\\s*届?\\s*(.+?)(${roleWords})(?:岗位|职位|项目)?$`, 'u'));
  if (m) {
    b = b || `${m[1]}届`;
    c = cleanMailEntity(m[2]);
    if (!t) t = cleanMailEntity(m[3], { title: true });
  } else if (!t) {
    m = c.match(new RegExp(`^(.{2,30}?)(${roleWords})(?:岗位|职位|项目)?$`, 'u'));
    if (m) {
      c = cleanMailEntity(m[1]);
      t = cleanMailEntity(m[2], { title: true });
    }
  }
  if (c && /^20\d{2}/.test(c) && t) {
    b = b || c.match(/^(20\d{2})/u)?.[1] + '届';
    c = cleanMailEntity(c.replace(/^20\d{2}\s*届?/u, ''));
  }
  return { company_name: c || null, job_title: t || null, recruitment_batch: b || null };
}

export function extractMailFields({ subject = '', bodyText = '', fromAddress = '', fromName = '' }) {
  const text = `${subject}\n${bodyText}`;
  const company = firstValidEntity(text, /(?:公司|企业|雇主|company)\s*[:：]\s*([^\n，,。;；]{2,40})/gi);
  const naturalCompany = text.match(/(?:感谢您|感谢你)(?:应聘|投递|申请)\s*[【「《“]?([^】」》”\n，,。；;「《【“]{2,24})/)?.[1]
    || text.match(/(?:欢迎加入|很高兴您加入|期待您加入)\s*([^，,。；;\n]{2,24})/)?.[1];
  const title = firstValidEntity(text, /(?:岗位|职位|应聘职位|position|role)\s*[:：]\s*([^\n，,。;；]{2,60})/gi, { title: true })
    || firstValidEntity(text, /您(?:应聘|投递|申请)(?:的)?(?:[^「《【“\n]{0,12})?[「《【“]([^」》】”\n]{2,40})[」》】”](?:岗位|职位)?/g, { title: true })
    || firstValidEntity(text, /您(?:应聘|投递|申请)(?:的)?([^\n，,。；;]{2,30}?)(?:岗位|职位)/g, { title: true });
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
  const subjectNatural = subject.match(/^(?:20\d{2}届?(?:校园招聘|校招|春招|秋招|社招)?[-—·\s]*)?(.{2,40}?)[-—·｜|\s]*(?:在线)?(?:测评|笔试|面试|录用|投递)(?:邀请|通知|安排|结果|成功)/u)?.[1];
  const subjectEmployer = subject.match(/^([^\s，,。；;:：【\]]{2,24}?)(?=\s*(?:20\d{2}|校园招聘|校招|春招|秋招|社招|招聘))/u)?.[1];
  const fromCompany = cleanMailEntity(String(fromName || '').replace(/(?:校园招聘|校园招聘团队|招聘团队|校招团队|招聘中心|人力资源|HR团队|招聘)$/iu, ''));
  const domain = String(fromAddress || '').split('@')[1]?.toLowerCase() || null;
  const domainCompany = companyIdentity('', domain);
  const batch = (text.match(/20\d{2}\s*届?(?:校园招聘|校招|春招|秋招|社招)?/)?.[0] || '').replace(/\s+/g, '') || null;
  const subjectCore = subject.replace(/[\s\-—·｜|]*(?:在线)?(?:测评|笔试|面试|录用|投递)(?:邀请|通知|安排|结果|成功)(?:通知)?$/u, '').trim();
  const subjectComposite = /^20\d{2}/.test(subjectCore) ? cleanMailEntity(subjectCore) : null;
  const compositeCompany = company || cleanMailEntity(naturalCompany || '') || cleanMailEntity(subjectCompany || '') || cleanMailEntity(subjectEmployer || '') || fromCompany || domainCompany || subjectComposite;
  const subjectNaturalCore = subjectNatural && !/20\d{2}|校园招聘|校招|社招|招聘/i.test(subjectNatural)
    ? (subjectNatural.match(new RegExp(`(${COMPOSITE_ROLE_WORDS})$`, 'u'))?.[1] || subjectNatural)
    : null;
  const rawSubjectTitle = cleanMailEntity(subjectTitle || '', { title: true })
    || cleanMailEntity(subjectNaturalCore || '', { title: true });
  const split = splitCompositeEntity(compositeCompany, title || rawSubjectTitle, batch);
  return {
    company_name: clipText(split.company_name || '', 80) || null,
    job_title: clipText(split.job_title || '', 100) || null,
    recruitment_batch: split.recruitment_batch,
    site_application_id: applicationId ? clipText(applicationId, 60) : null,
    from_domain: domain,
    from_name: clipText(fromName, 80) || null
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
export function confirmedMailProgress(subject, bodyText, { fromName = '', fromDomain = '' } = {}) {
  const core = stripMailBoilerplate(bodyText);
  const text = `${subject}\n${core}`;
  if (/^(?:re|fw|fwd|回复|转发)\s*[:：]/i.test(subject)) return null;
  if (/(?:模拟测评|模拟面试|宣讲会|开放日|岗位推荐|广告|招聘流程介绍|流程说明)/.test(core)) return null;
  if (/(?:如果|若|如)(?:您|你)?.{0,8}(?:通过|录取|入选|符合).{0,24}(?:将|会|才|再)/.test(core) ||
      /不代表.{0,24}(?:录用|通过|录取)/.test(core)) return null;
  if (/(?:测评|笔试|面试|申请|投递).{0,12}(?:已)?取消|取消.{0,12}(?:测评|笔试|面试|申请|投递)/.test(core)) return null;

  const stages = [
    ['offer', /(?:正式录用|录用通知|录用意向书|offer\s*letter|录取通知)/i],
    ['rejected', /(?:很遗憾.{0,24}(?:未通过|不合适|未能|遗憾)|未通过(?:本次)?(?:筛选|简历|测评|笔试|面试)|(?:岗位|职位|背景|暂)不(?:合适|匹配)|进入人才库|not\s+selected|unfortunately.{0,30}(?:not|unable))/i],
    ['closed', /(?:岗位关闭|职位关闭|流程结束|申请已撤回|position\s+closed)/i],
    ['interview', /(?:面试邀请|面试通知|面试安排|面试时间确认|邀请.{0,12}(?:一面|二面|三面|初试|复试|终面|HR面|面试)|invitation\s+to\s+interview)/i],
    ['assessment', /(?:测评邀请|笔试邀请|在线测评通知|测评通知|笔试通知|测评安排|笔试安排|测评已开启|进入测评环节|请(?:您|你)?.{0,24}完成.{0,12}(?:测评|笔试|在线考试)|online\s+assessment|written\s+test)/i],
    ['applied', /(?:投递成功|申请成功|提交成功|已成功提交|申请已收到|已收到您的(?:简历|申请)|简历已收到|申请已提交|application\s+submitted|we\s+have\s+received\s+your\s+application)/i]
  ];
  const matched = stages.filter(([, pattern]) => pattern.test(text));
  if (!matched.length) return null;
  const status = matched[0][0];

  const bodyCompany = firstValidEntity(core, /(?:公司|企业|雇主|company)\s*[:：]\s*([^\n，,。;；]{2,40})/gi);
  const naturalCompany = core.match(/(?:感谢您|感谢你)(?:应聘|投递|申请)\s*[【「《“]?([^】」》”\n，,。；;「《【“]{2,24})/)?.[1]
    || core.match(/(?:欢迎加入|很高兴您加入|期待您加入)\s*([^，,。；;\n]{2,24})/)?.[1];
  const bracket = subject.match(/^[【\[]([^】\]]{2,30})[】\]]/u);
  const subjectCore = subject.replace(/[\s\-—·｜|]*(?:在线)?(?:测评|笔试|面试|录用|投递)(?:邀请|通知|安排|结果|成功)(?:通知)?$/u, '').trim();
  const subjectEmployer = subject.match(/^([^\s，,。；;:：【\]]{2,24}?)(?=\s*(?:20\d{2}|校园招聘|校招|春招|秋招|社招|招聘))/u)?.[1];
  const fromCompany = cleanMailEntity(String(fromName || '').replace(/(?:校园招聘|校园招聘团队|招聘团队|校招团队|招聘中心|人力资源|HR团队|招聘)$/iu, ''));
  const domainCompany = companyIdentity('', fromDomain);
  const subjectComposite = /^20\d{2}/.test(subjectCore) ? cleanMailEntity(subjectCore) : null;
  let employer = cleanMailEntity(bodyCompany || naturalCompany || bracket?.[1] || '') || cleanMailEntity(subjectEmployer || '') || fromCompany || domainCompany || subjectComposite;

  const bodyTitle = firstValidEntity(core, /(?:应聘岗位|应聘职位|岗位(?:名称)?|职位(?:名称)?)\s*[:：]\s*([^\n，,。；;]{2,60})/gi, { title: true })
    || firstValidEntity(core, /您(?:应聘|投递|申请)(?:的)?(?:[^「《【“\n]{0,12})?[「《【“]([^」》】”\n]{2,40})[」》】”](?:岗位|职位)?/g, { title: true })
    || firstValidEntity(core, /您(?:应聘|投递|申请)(?:的)?([^\n，,。；;]{2,30}?)(?:岗位|职位)/g, { title: true });
  const subjectTitle = subject.match(/^[【\[][^】\]]+[】\]]\s*(?:20\d{2}届?(?:校园招聘|校招|春招|秋招|社招)?[-—·\s]*)?(.{2,36}?)[-—·｜|\s]*(?:在线)?(?:测评|笔试|面试|录用|投递)(?:邀请|通知|安排|结果|成功)/u)?.[1];
  let title = cleanMailEntity(bodyTitle || subjectTitle || '', { title: true });
  let batch = (text.match(/20\d{2}\s*届?(?:校园招聘|校招|春招|秋招|社招)?/)?.[0] || '').replace(/\s+/g, '') || null;
  const split = splitCompositeEntity(employer, title, batch);
  employer = split.company_name;
  title = split.job_title;
  batch = split.recruitment_batch;

  if (!employer) return null;
  if (!title) {
    if (['applied', 'assessment', 'interview', 'offer', 'rejected'].includes(status)) {
      return {
        company_name: employer,
        job_title: null,
        recruitment_batch: batch,
        status,
        from_domain: fromDomain || null,
        from_name: fromName || null,
        company_only_progress: true,
        title_inferred: true
      };
    }
    return null;
  }
  return {
    company_name: employer,
    job_title: title,
    recruitment_batch: batch,
    status,
    from_domain: fromDomain || null,
    from_name: fromName || null
  };
}
