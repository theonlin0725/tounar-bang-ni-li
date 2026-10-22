import { clipText, normalizeCompanyKey, normalizeWhitespace } from '../util.js';

const POSITIVE_KEYWORDS = [
  '笔试', '测评', '在线考试', '面试', '邀请', '录用', 'offer', '意向书', '录取', '感谢',
  '遗憾', '未通过', '不合适', '流程结束', '岗位关闭', '撤回', '进展', '申请', '简历', '招聘',
  '管理培训生', '管培生', '校招', '秋招', '春招', '校园招聘',
  'assessment', 'interview', 'offer', 'application', 'recruitment', 'unfortunately', 'not selected'
];

const RECRUITMENT_DOMAIN_HINTS = ['jobs.', 'careers.', 'campus.', 'recruit.', 'hr.', 'talent.', 'zhaopin.', 'hire.'];
const COMMON_RECRUITING_DOMAINS = [
  'boss直聘', 'boss.com', 'nowcoder.com', 'nowcoder.net', 'shixiseng.com', 'lagou.com', 'zhaopin.com', '51job.com',
  'liepin.com', 'maimai.cn', 'hotjob.cn', 'yingjiesheng.com'
];

/* P2（2026-10-22）：邮件匹配升级。
   国内招聘邮件几乎不带申请编号，公司名又有中英文/子品牌多种写法（字节跳动 / ByteDance / 抖音）。
   这里维护一张「别名 → 台账标准公司名」表，只用于邮件匹配和展示，不改变用户台账里的原始公司名。
   注意：招聘平台域名（nowcoder.com 等）不映射到具体公司——它们只是转发渠道，映射会制造假匹配。 */
const COMPANY_ALIAS_GROUPS = [
  ['字节跳动', ['字节跳动', '字节', 'bytedance', '抖音', '抖音集团', '今日头条', '头条', '火山引擎', '飞书', 'lark']],
  ['腾讯', ['腾讯', 'tencent', '腾讯音乐', 'tme', 'qq音乐', '腾讯视频', '腾讯云', '微信', 'wechat']],
  ['阿里巴巴', ['阿里巴巴', '阿里', 'alibaba', '淘宝', '天猫', '蚂蚁集团', '蚂蚁金服', '支付宝', '钉钉', '饿了么', '高德']],
  ['美团', ['美团', 'meituan', '大众点评']],
  ['京东', ['京东', 'jd.com', '京东集团', '京东科技']],
  ['小米', ['小米', 'xiaomi', 'redmi', '红米']],
  ['百度', ['百度', 'baidu', '小度']],
  ['网易', ['网易', 'netease', '网易游戏', '雷火', '有道']],
  ['华为', ['华为', 'huawei']],
  ['荣耀', ['荣耀', 'honor']],
  ['OPPO', ['oppo', '欧珀']],
  ['vivo', ['vivo', '维沃']],
  ['大疆', ['大疆', 'dji']],
  ['快手', ['快手', 'kuaishou']],
  ['滴滴', ['滴滴', '滴滴出行', 'didi']],
  ['拼多多', ['拼多多', 'pinduoduo', 'pdd']],
  ['哔哩哔哩', ['哔哩哔哩', 'bilibili', 'b站']],
  ['小红书', ['小红书', 'xiaohongshu', 'rednote']],
  ['携程', ['携程', 'ctrip', 'trip.com']],
  ['去哪儿', ['去哪儿', 'qunar']],
  ['蔚来', ['蔚来', 'nio']],
  ['理想汽车', ['理想汽车', '理想', 'lixiang', 'li auto']],
  ['小鹏汽车', ['小鹏汽车', '小鹏', 'xpeng']],
  ['比亚迪', ['比亚迪', 'byd']],
  ['宁德时代', ['宁德时代', 'catl']],
  ['特斯拉', ['特斯拉', 'tesla']],
  ['招商银行', ['招商银行', '招行', 'cmbchina', 'cmb']],
  ['中国电信', ['中国电信', '电信', '天翼云', '天翼', 'china telecom', 'chinatelecom']],
  ['中国农业银行', ['中国农业银行', '农业银行', '农行', 'abchina']],
  ['中国工商银行', ['中国工商银行', '工商银行', '工行', 'icbc']],
  ['中国建设银行', ['中国建设银行', '建设银行', '建行', 'ccb']],
  ['中国银行', ['中国银行', '中行', 'boc']],
  ['中国电子云', ['中国电子云', '中国电子', 'ceccloud', '中电云']],
  ['欧莱雅', ['欧莱雅', 'loreal', "l'oréal", 'l’oréal']],
  ['图拉斯', ['图拉斯', 'torras']],
  ['香港中文大学', ['香港中文大学', '港中大', 'cuhk']],
  ['微软', ['微软', 'microsoft']],
  ['谷歌', ['谷歌', 'google']],
  ['亚马逊', ['亚马逊', 'amazon', 'aws']],
  ['苹果', ['苹果公司', 'apple']],
  ['英特尔', ['英特尔', 'intel']],
  ['英伟达', ['英伟达', 'nvidia']],
  ['联想', ['联想', 'lenovo']],
  ['中兴', ['中兴', 'zte']],
  ['科大讯飞', ['科大讯飞', '讯飞', 'iflytek']],
  ['商汤', ['商汤', 'sensetime']],
  ['海康威视', ['海康威视', '海康', 'hikvision']],
  ['宝洁', ['宝洁', 'procter']],
  ['联合利华', ['联合利华', 'unilever']],
  ['玛氏', ['玛氏', 'mars']],
  ['雀巢', ['雀巢', 'nestle']],
  ['德勤', ['德勤', 'deloitte']],
  ['普华永道', ['普华永道', 'pwc']],
  ['安永', ['安永', 'ey']],
  ['毕马威', ['毕马威', 'kpmg']],
  ['麦肯锡', ['麦肯锡', 'mckinsey']]
];

const SENDER_DOMAIN_COMPANIES = {
  'bytedance.com': '字节跳动',
  'tencent.com': '腾讯',
  'alibaba-inc.com': '阿里巴巴',
  'alibaba.com': '阿里巴巴',
  'meituan.com': '美团',
  'jd.com': '京东',
  'xiaomi.com': '小米',
  'baidu.com': '百度',
  'netease.com': '网易',
  'huawei.com': '华为',
  'cmbchina.com': '招商银行',
  'chinatelecom.cn': '中国电信',
  'abchina.com': '中国农业银行',
  'ceccloud.com': '中国电子云',
  'loreal.com': '欧莱雅',
  'torras.com': '图拉斯',
  'cuhk.edu.hk': '香港中文大学'
};

const TITLE_WORDS = [
  '管理培训生', '管培生', '产品经理', '产品运营', '数据分析师', '数据科学', '算法工程师',
  '前端开发', '后端开发', '全栈工程师', '软件工程师', '研发工程师', '测试开发', '测试工程师',
  '交互设计师', '视觉设计师', 'ui设计师', '设计师', '运营专员', '运营经理', '人力资源',
  'hrbp', '财务', '法务', '销售', '市场', '咨询顾问', '商业分析', '策略', '研究',
  '工程师', '实习生', '校招生', 'developer', 'engineer', 'manager', 'analyst', 'designer'
];
const TITLE_HINT = new RegExp(TITLE_WORDS.join('|'), 'i');
const CATEGORY_WORDS = /面试|笔试|测评|考试|通知|感谢|录用|offer|招聘|申请|进度|内推|宣讲|邀请|恭喜|提醒|重要|结果|入职|体检|背景调查|简历|校园|校招|社招/i;
const COMPANY_HINT = /大学|学院|公司|集团|银行|科技|电子|网络|信息|通信|云|汽车|地产|证券|保险|医药|生物|教育|咨询|会计|事务所|研究院|实验室|控股|实业|能源|航空|电气|传媒|娱乐|游戏/i;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasInText(text, alias) {
  if (/^[a-z0-9 .&'’+-]+$/i.test(alias)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}([^a-z0-9]|$)`, 'i').test(text);
  }
  return text.includes(alias);
}

const ALIAS_INDEX = COMPANY_ALIAS_GROUPS
  .flatMap(([canonical, aliases]) => aliases.map((alias) => ({ canonical, alias, key: normalizeCompanyKey(alias) })))
  .sort((a, b) => b.alias.length - a.alias.length);

/* 把任意公司写法归一到台账标准名：字节/ByteDance/抖音 → 字节跳动。未知公司保留原名。 */
export function canonicalCompany(name) {
  const raw = normalizeWhitespace(name, 200);
  if (!raw) return null;
  const key = normalizeCompanyKey(raw);
  if (!key) return raw;
  for (const item of ALIAS_INDEX) {
    if (!item.key) continue;
    const latinShort = /^[a-z0-9]+$/.test(item.key) && item.key.length < 4;
    if (key === item.key) return item.canonical;
    if (!latinShort && key.includes(item.key)) return item.canonical;
  }
  return raw;
}

export function companyFromSender(domain) {
  const d = String(domain || '').toLowerCase();
  if (!d) return null;
  for (const [suffix, company] of Object.entries(SENDER_DOMAIN_COMPANIES)) {
    if (d === suffix || d.endsWith(`.${suffix}`)) return company;
  }
  return null;
}

function looksLikeCompanyToken(value) {
  const s = normalizeWhitespace(value, 60);
  if (!s || s.length < 2 || s.length > 30) return false;
  if (CATEGORY_WORDS.test(s)) return false;
  if (TITLE_HINT.test(s)) return false;
  if (/[，,。;；!！?？]/.test(s)) return false;
  if (/(同学|您好|你好|我们|贵司|邀请|恭喜|感谢|通过|参加)/.test(s)) return false;
  return COMPANY_HINT.test(s) || s.length <= 12;
}

function looksLikeJobTitle(value) {
  const s = normalizeWhitespace(value, 100);
  if (!s || s.length < 2 || s.length > 40) return false;
  if (/(同学|您好|你好|恭喜|感谢|邀请|预约|通知|安排|时间|面试|笔试|测评|考试)/.test(s)) return false;
  return TITLE_HINT.test(s);
}

/* 从邮件主题里认公司：先查别名表，再看【】、开头的「公司+年份/校招」、Re: 公司- 格式。 */
export function companyFromSubject(subject = '') {
  const s = normalizeWhitespace(subject, 300);
  if (!s) return null;
  for (const item of ALIAS_INDEX) {
    if (aliasInText(s, item.alias)) return item.canonical;
  }
  const brackets = [...s.matchAll(/【([^】]{2,30})】/g)].map((m) => m[1].trim());
  for (const bracket of brackets) {
    const cleaned = bracket
      .replace(/^20\d{2}\s*(?:届|年度|年)?\s*/i, '')
      .replace(/^(?:校招|社招|校园招聘|社会招聘|春季招聘|秋季招聘)[·|｜:\s-]*/i, '')
      .trim();
    if (looksLikeCompanyToken(cleaned)) return cleaned;
  }
  const leading = s.match(/^([\u4e00-\u9fa5A-Za-z0-9（）()·&.'’\-]{2,24}?)(?=\s*(?:20\d{2}|校园招聘|校招|春季招聘|秋季招聘|社会招聘|招聘|实习生招聘))/);
  if (leading) {
    const cleaned = leading[1].replace(/[·|｜:\-—\s]+$/, '').trim();
    if (looksLikeCompanyToken(cleaned) && !looksLikeJobTitle(cleaned)) return cleaned;
  }
  const re = s.match(/^Re:\s*([^-—:：]{2,24})[-—:：]/i);
  if (re && looksLikeCompanyToken(re[1].trim())) return re[1].trim();
  return null;
}

/* 从主题里认岗位：只认明确的岗位词，避免把「预约面试时间」当成岗位名。 */
export function jobTitleFromSubject(subject = '') {
  const s = normalizeWhitespace(subject, 300);
  if (!s) return null;
  const bracketTail = s.match(/【[^】]{2,30}】\s*([^，,。;；]{2,60})/);
  if (bracketTail) {
    const tail = bracketTail[1]
      .split(/\s*(?:面试|笔试|测评|考试|邀请|通知|安排|时间)[：:\s]?/)[0]
      .trim();
    if (looksLikeJobTitle(tail)) return tail;
  }
  const lower = s.toLowerCase();
  for (const word of [...TITLE_WORDS].sort((a, b) => b.length - a.length)) {
    if (lower.includes(word.toLowerCase())) return word;
  }
  return null;
}

/* 岗位规范化：去掉年份、校招/社招、实习/应届、城市后缀，只留核心岗位词。 */
export function normalizeTitleForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/管培生/g, '管理培训生')
    .replace(/20\d{2}\s*(?:届|年度|年)?/g, '')
    .replace(/(?:校园|社会|春季|秋季|春招|秋招|校招|社招|全球)\s*招聘/g, '')
    .replace(/(?:实习生|实习|应届生|毕业生|校招生)/g, '')
    .replace(/[（(][^）)]{1,12}[）)]\s*$/g, '')
    .replace(/[-—–_·|｜/][^\-—–_·|｜/]{1,12}$/g, '')
    .replace(/[\s\-—–_·•|｜,，.。;；:：!！?？'"“”‘’()（）\[\]【】<>《》]/g, '');
}

/* 岗位相似度：包含关系 0.95；否则用字符二元组 Dice 系数（中英文都适用）。 */
export function titleSimilarity(a, b) {
  const x = normalizeTitleForMatch(a);
  const y = normalizeTitleForMatch(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return 0.95;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const gx = grams(x);
  const gy = grams(y);
  if (!gx.size || !gy.size) return 0;
  let overlap = 0;
  for (const gram of gx) if (gy.has(gram)) overlap += 1;
  return (2 * overlap) / (gx.size + gy.size);
}


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
  const negative = hasAny(text, ['未通过', '不合适', '很遗憾', '遗憾地', 'not selected', 'unfortunately', '感谢信', '拒绝', '进入人才库', '暂不匹配']);
  const offer = hasAny(text, ['录用', 'offer', '意向书', '录取通知', '正式录用']);
  const closed = hasAny(text, ['流程结束', '岗位关闭', '职位关闭', '撤回', 'withdrawn', 'position closed']);
  const interview = hasAny(text, ['面试', 'interview', '面谈']);
  const assessment = hasAny(text, ['笔试', '测评', '在线考试', 'online assessment', 'written test']);
  const genericInvite = hasAny(text, ['恭喜', '邀请', 'invite', 'congratulations']);
  let category = 'other';
  if (negative) category = 'rejected';
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
  if (category === 'assessment') status = 'assessment';
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
    confidence: category === 'other' || category === 'application_update' ? 0.4 : (negative || offer ? 0.95 : 0.92),
    reason: category
  };
}

export function extractMailFields({ subject = '', bodyText = '', fromAddress = '' }) {
  const text = `${subject}\n${bodyText}`;
  const explicitCompany = text.match(/(?:公司|企业|雇主|company)\s*[:：]\s*([^\n，,。;；]{2,40})/i)?.[1]?.trim() || null;
  // 「公司：面试通知」这类是分类词，不是公司名。
  const company = explicitCompany && !CATEGORY_WORDS.test(explicitCompany) ? explicitCompany : null;
  const title = text.match(/(?:岗位|职位|应聘职位|position|role)\s*[:：]\s*([^\n，,。;；]{2,60})/i)?.[1]?.trim() || null;
  const applicationId = text.match(/(?:申请编号|申请号|application\s*(?:id|no\.?)|reference)\s*[:：#]?\s*([A-Za-z0-9_-]{4,40})/i)?.[1] || null;
  const domain = String(fromAddress || '').split('@')[1]?.toLowerCase() || null;
  // 正文显式字段优先；发件域名是强信号（如 cmbchina.com 的邮件主题里提到「香港中文大学」只是候选人学校）；
  // 主题兜底认别名/【】/公司+校招；招聘平台域名不映射到具体公司。
  const subjectCompany = companyFromSubject(subject);
  const senderCompany = companyFromSender(domain);
  const subjectTitle = jobTitleFromSubject(subject);
  return {
    company_name: clipText(company || senderCompany || subjectCompany || '', 80) || null,
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
