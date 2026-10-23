/*
 * Tounar 帮你理 · 页面线索采集（content script，classic）
 *
 * 采集边界（对应 PRD 数据稿）：
 * - 只在识别为「岗位详情」的页面开启计时；
 * - job_viewed 需要客户端可见累计 ≥ 3 秒；
 * - form_started 只记录「用户在某投递表单里开始输入」这一事实，不读取任何输入内容；
 * - application_submitted 只在检测到明确的成功标记时发出，并区分强/弱证据；
 * - site_status_observed 只读取显式 data-tounar-* 状态块或站点适配器声明的投递记录行；
 * - 不上传页面正文、表单值、Cookie 或账号信息。
 */
(function () {
  if (globalThis.__tounarTrackerLoaded) return;
  globalThis.__tounarTrackerLoaded = true;

  const Adapters = globalThis.TounarAdapters;
  if (!Adapters || !chrome?.runtime?.sendMessage) return;

  const DWELL_MS = 3000;
  const TICK_MS = 250;
  const SETTLE_MS = 800;
  const SUBMIT_SCAN_MS = 1000;
  const SUBMIT_WINDOW_MS = 5 * 60 * 1000;
  const MAX_JD_CHARS = 80;
  const SUCCESS_TEXT = /投递成功|申请成功|提交成功|已成功提交|感谢(您|你)的?投递|简历投递成功|报名成功|application\s+(has been\s+)?submitted|successfully\s+submitted|submitted\s+successfully/i;

  const adapter = Adapters.resolveAdapter(location.hostname);
  const pageState = {
    href: location.href,
    routeKey: routeKey(),
    detectedAt: null,
    viewStartedAt: null,
    visibleMs: 0,
    lastTickAt: Date.now(),
    viewSent: false,
    formSent: false,
    submitSent: false,
    submitScanUntil: 0,
    job: null,
    statusSent: new Set(),
    lastProbeAt: 0,
    lastMutationAt: 0,
    lastTitleCheckAt: 0,
    lastRedetectAt: 0
  };
  try {
    const stored = sessionStorage.getItem('tounar:submitSent');
    if (stored) pageState.submitSent = true;
  } catch { /* sessionStorage may be unavailable */ }

  // ---------- helpers ----------

  function routeKey() {
    return `${location.pathname}${location.search}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function newEventId() {
    try {
      return `evt_${crypto.randomUUID()}`;
    } catch {
      return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  function canonicalUrl(raw) {
    try {
      const url = new URL(raw, location.origin);
      if (!/^https?:$/.test(url.protocol)) return null;
      /* hash 路由（campus.jd.com/#/details?id=...）里的 hash 是岗位地址，不能清掉；
         纯锚点/分享片段才丢弃。 */
      if (!/^#\/?(details|job|jobs|position|positions|apply|detail)([\/?]|$)/i.test(url.hash)) url.hash = '';
      const drop = /^(utm_|spm|from|source|track|scm|share|ref|share_|weibo|gclid|fbclid)/i;
      const kept = new URLSearchParams();
      for (const [key, value] of url.searchParams.entries()) {
        if (!drop.test(key)) kept.append(key, value);
      }
      url.search = kept.toString();
      return url.toString();
    } catch {
      return null;
    }
  }

  function textOf(el) {
    if (!el) return '';
    return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function firstText(selectors) {
    for (const selector of selectors || []) {
      let nodes;
      try { nodes = document.querySelectorAll(selector); } catch { continue; }
      for (const node of nodes) {
        const text = textOf(node);
        if (text) return text.length > 160 ? text.slice(0, 160) : text;
      }
    }
    return '';
  }

  function clipJd(text) {
    const clean = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return clean.length > MAX_JD_CHARS ? clean.slice(0, MAX_JD_CHARS) : clean;
  }

  function readJobPostingJsonLd() {
    const postings = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(script.textContent || 'null'); } catch { continue; }
      const items = Array.isArray(data) ? data : (data && Array.isArray(data['@graph']) ? data['@graph'] : [data]);
      for (const item of items) {
        if (!item) continue;
        const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
        if (types.includes('JobPosting')) postings.push(item);
      }
    }
    if (postings.length !== 1) return postings.length ? { multiple: true } : null;
    return postings[0];
  }

  function locationText(ld) {
    const loc = ld?.jobLocation;
    if (!loc) return '';
    const first = Array.isArray(loc) ? loc[0] : loc;
    const address = first?.address || first;
    if (typeof address === 'string') return address;
    return address?.addressLocality || address?.addressRegion || address?.streetAddress || '';
  }

  function identifierValue(ld) {
    const id = ld?.identifier;
    if (!id) return '';
    if (typeof id === 'string') return id;
    if (Array.isArray(id)) return identifierValue({ identifier: id[0] });
    return String(id.value || id.name || '');
  }

  function idFromUrl(jobUrl) {
    try {
      const url = new URL(jobUrl);
      const parts = url.pathname.split('/').filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const part = parts[i];
        if (/^\d{4,}$/.test(part) || /^[0-9a-f-]{8,}$/i.test(part)) return part;
        if (/^(inn|job|position|post)_[A-Za-z0-9_-]{6,}$/i.test(part)) return part;
      }
      const named = url.searchParams.get('jobId') || url.searchParams.get('positionId')
        || url.searchParams.get('postId') || url.searchParams.get('postid') || url.searchParams.get('jobUnionId') || url.searchParams.get('id');
      if (named) return named;
      const hashQuery = url.hash.includes('?') ? new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1)) : null;
      const hashId = hashQuery?.get('id') || hashQuery?.get('jobId') || hashQuery?.get('positionId');
      if (hashId) return hashId;
      const last = parts[parts.length - 1] || '';
      if (/^[A-Za-z0-9_-]{6,}$/.test(last) && /[_-]/.test(last)) return last;
      return '';
    } catch {
      return '';
    }
  }

  function batchFromText(text) {
    const value = String(text || '');
    const withBatch = value.match(/(20\d{2})\s*届\s*(应届生|毕业生|校园招聘|校招|秋招|春招|实习)?/);
    if (withBatch) return `${withBatch[1]}届${withBatch[2] || ''}`.trim();
    const match = value.match(/(20\d{2})\s*(秋招|春招|暑期实习|实习|校招|校园招聘)/);
    if (match) {
      if (/秋招/.test(match[2])) return `${match[1]} 秋招`;
      if (/春招/.test(match[2])) return `${match[1]} 春招`;
      if (/实习/.test(match[2])) return `${match[1]} 实习`;
      return `${match[1]} 校招`;
    }
    return '';
  }

  function metaContent(names) {
    for (const name of names) {
      let el;
      try { el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`); } catch { continue; }
      const value = el && el.getAttribute('content');
      if (value && value.trim()) return value.trim();
    }
    return '';
  }

  // 标题清洗：去掉「- 某公司招聘」「_XX官网」这类站点后缀，但保留岗位本身的副标题。
  function cleanPageTitle(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/\s*更新于\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}.*$/, '').trim();
    const parts = t.split(/\s+[-_—–·｜|]\s+/);
    if (parts.length > 1 && /(招聘|校园招聘|校招|官网|人才招聘|社会招聘|求职|猎聘)\s*$/.test(parts[parts.length - 1])) {
      t = parts.slice(0, -1).join(' - ').trim();
    }
    t = t.replace(/[-_—–·｜|]?\s*[^-_—–·｜|]{0,20}(招聘|校园招聘|校招|官网|人才招聘|社会招聘|求职|猎聘)\s*$/, '').trim();
    return t.length > 120 ? t.slice(0, 120) : t;
  }

  function normalizedKey(text) {
    return String(text || '').toLowerCase().replace(/[\s\u3000·•,，.。|｜/\\_\-—–()（）【】\[\]]+/g, '');
  }

  const TITLE_BLOCKLIST = /^(岗位详情|职位详情|职位信息|职位介绍|职位|岗位|招聘|招聘首页|社会招聘|校园招聘|校招|实习招聘|首页|主页|登录|注册|搜索|投递|申请|立即投递|立即申请|查看详情|查看更多|loading|加载中|请稍候|暂无数据|暂无职位|没有找到|not found)$/i;
  const COMPANY_BLOCKLIST = /^(招聘|招聘首页|社会招聘|校园招聘|校招|首页|主页|登录|注册|搜索|投递|申请|立即投递|查看详情|查看更多|loading|加载中|BOSS直聘|牛客|牛客网|实习僧|猎聘|智联招聘|前程无忧|拉勾|领英|LinkedIn|Indeed)$/i;
  const JD_HEADING = /^(职位描述|岗位职责|工作职责|工作内容|职位要求|岗位要求|任职要求|任职资格|Job Description|Responsibilities|Requirements|Qualifications|About the role|What you.ll do)\s*[:：]?$/i;
  const NAV_HINT = /(^|\s)(首页|登录|注册|搜索|招聘首页|校园招聘|社会招聘|隐私政策|关于我们|联系我们|意见反馈|查看更多|猜你想搜|热门职位|相关推荐|其他职位|为你推荐)(\s|$)/;
  const AGGREGATOR_KEYS = new Set(['boss', 'nowcoder', 'shixiseng']);

  function cleanCompanyName(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/^(公司名称|企业名称|所属公司|招聘企业|公司)\s*[:：]\s*/, '');
    t = t.split(/\s*[·•|｜]\s*/)[0].trim();
    t = t.replace(/\s*(校园招聘|社会招聘|人才招聘|招聘官网|招聘|官网|求职)$/,'').trim();
    return t.length > 50 ? t.slice(0, 50) : t;
  }

  function cleanTitleValue(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/\s*更新于\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}.*$/, '').trim();
    t = t.replace(/\s*(校园招聘|社会招聘|招聘官网)\s*$/, '').trim();
    return t.length > 100 ? t.slice(0, 100) : t;
  }

  function isValidTitle(text, company) {
    const value = cleanTitleValue(text);
    if (value.length < 2 || value.length > 80) return false;
    if (TITLE_BLOCKLIST.test(value)) return false;
    if (/^(20\d{2}\s*届?\s*)?(校园招聘|社会招聘|实习生招聘|招聘)(官网|首页|网站)?$/i.test(value)) return false;
    if (/招聘(官网|首页|网站)$/.test(value)) return false;
    if (/^(首页|主页)\s*[|｜·-]/.test(value)) return false;
    if (/^https?:/i.test(value) || /[<>{}]/.test(value)) return false;
    if (/^(loading|加载中|请稍候|暂无|没有找到)/i.test(value)) return false;
    if (company && normalizedKey(value) === normalizedKey(company)) return false;
    return true;
  }

  function isValidCompany(text) {
    const value = cleanCompanyName(text);
    if (value.length < 2 || value.length > 50) return false;
    if (COMPANY_BLOCKLIST.test(value)) return false;
    if (/^\d+$/.test(value) || /^https?:/i.test(value)) return false;
    return true;
  }

  function isValidLocation(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length < 2 || value.length > 50) return false;
    if (/^(工作地点|地点|城市|Location|更新于|招聘)$/i.test(value)) return false;
    if (/更新时间|更新于|招聘人数|职位类别|学历|经验/i.test(value)) return false;
    return true;
  }

  function isNavContext(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.closest('header, nav, footer, aside')) return true;
      const root = el.closest('[class]');
      let node = root;
      let depth = 0;
      while (node && depth < 8) {
        const cls = String(node.className || '');
        /* 只认真正的站点导航/页脚，避免把 job-header/detail-header 这种岗位标题容器误判。 */
        if (/(^|[\s_-])(nav|navbar|menu|footer|breadcrumb|sidebar|recommend|related|hot-job|hotjob|logo)([\s_-]|$)/i.test(cls)
          || /(site|page|global|top|main|header-wrap|header-nav)[-_]?header/i.test(cls)) return true;
        node = node.parentElement;
        depth += 1;
      }
    } catch { /* ignore */ }
    return false;
  }

  function isDetailContext(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      return !!el.closest('main, article, [role="main"], [class*="detail"], [class*="Detail"], [class*="job-detail"], [class*="jobDetail"], [class*="position-detail"], [class*="positionDetail"]');
    } catch { return false; }
  }

  function addCandidate(bucket, field, raw, { source = 'heuristic', score = 0.6, el = null } = {}) {
    let value = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!value) return;
    if (field === 'company_name') value = cleanCompanyName(value);
    if (field === 'job_title') value = cleanTitleValue(value);
    if (field === 'jd_summary') value = clipJd(value);
    if (field === 'location') value = value.slice(0, 50);
    if (field === 'job_title' && !isValidTitle(value)) return;
    if (field === 'company_name' && !isValidCompany(value)) return;
    if (field === 'location' && !isValidLocation(value)) return;
    if (field === 'jd_summary' && (value.length < 12 || NAV_HINT.test(value))) return;
    let adjusted = score;
    if (el) {
      if (isNavContext(el)) adjusted -= 0.45;
      if (isDetailContext(el)) adjusted += 0.04;
      if (field === 'job_title' && el.tagName === 'H1') adjusted += 0.08;
      if (field === 'job_title' && el.tagName === 'H2') adjusted += 0.03;
    }
    adjusted = Math.max(0, Math.min(0.99, adjusted));
    bucket.push({ value, score: adjusted, source, el });
  }

  function chooseCandidate(bucket) {
    if (!bucket.length) return null;
    const deduped = new Map();
    for (const c of bucket) {
      const key = normalizedKey(c.value);
      const existing = deduped.get(key);
      if (!existing || c.score > existing.score) deduped.set(key, c);
    }
    return Array.from(deduped.values()).sort((a, b) => b.score - a.score)[0] || null;
  }

  const APPLY_SIGNAL = /^(投递|立即投递|投递简历|申请|立即申请|申请职位|申请岗位|我要申请|网申|报名|立即报名|apply|apply now|apply for|sign up)/i;
  function findApplyElement() {
    let nodes;
    try { nodes = document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]'); } catch { return null; }
    const limit = Math.min(nodes.length, 500);
    for (let i = 0; i < limit; i += 1) {
      const el = nodes[i];
      const text = (el.tagName === 'INPUT' ? el.value : textOf(el)) || '';
      if (text && text.length <= 20 && APPLY_SIGNAL.test(text.trim())) return el;
      const hint = `${el.id || ''} ${el.className || ''}`;
      if (/apply|deliver|toudi/i.test(hint) && text && text.length <= 20) return el;
    }
    return null;
  }

  function hasApplySignal() {
    return !!findApplyElement();
  }

  function collectTitleCandidates(ld) {
    const out = [];
    const hook = document.querySelector('[data-tounar-job-id]');
    if (hook?.getAttribute('data-tounar-job-title')) {
      addCandidate(out, 'job_title', hook.getAttribute('data-tounar-job-title'), { source: 'data-hook', score: 0.99, el: hook });
    }
    if (ld && !ld.multiple && ld.title) {
      addCandidate(out, 'job_title', ld.title, { source: 'jsonld', score: 0.96 });
    }
    for (const selector of adapter.selectors?.title || []) {
      let nodes;
      try { nodes = document.querySelectorAll(selector); } catch { continue; }
      let count = 0;
      for (const node of nodes) {
        if (count >= 6) break;
        addCandidate(out, 'job_title', textOf(node), { source: 'adapter', score: 0.9, el: node });
        count += 1;
      }
    }
    const semantic = document.querySelectorAll('main h1, article h1, [role="main"] h1, main h2, article h2, [itemprop="name"], [class*="job-title"], [class*="jobTitle"], [class*="position-title"], [class*="positionTitle"], [class*="post-title"], [class*="detail-title"]');
    let semanticCount = 0;
    for (const node of semantic) {
      if (semanticCount >= 20) break;
      addCandidate(out, 'job_title', textOf(node), { source: 'semantic', score: node.tagName === 'H1' ? 0.82 : 0.7, el: node });
      semanticCount += 1;
    }
    for (const node of document.querySelectorAll('h1, h2')) {
      addCandidate(out, 'job_title', textOf(node), { source: 'heading', score: node.tagName === 'H1' ? 0.78 : 0.62, el: node });
    }
    const og = metaContent(['og:title', 'twitter:title']);
    if (og) addCandidate(out, 'job_title', cleanPageTitle(og), { source: 'meta', score: 0.62 });
    addCandidate(out, 'job_title', cleanPageTitle(document.title), { source: 'document-title', score: 0.45 });

    const apply = findApplyElement();
    if (apply) {
      const applyY = apply.getBoundingClientRect().top;
      for (const candidate of out) {
        if (!candidate.el) continue;
        const y = candidate.el.getBoundingClientRect().top;
        const distance = Math.abs(y - applyY);
        if (distance < 160) candidate.score = Math.min(0.99, candidate.score + 0.08);
        else if (distance < 500) candidate.score = Math.min(0.99, candidate.score + 0.03);
      }
    }
    return out;
  }

  function collectCompanyCandidates(ld) {
    const out = [];
    const hook = document.querySelector('[data-tounar-job-id]');
    if (hook?.getAttribute('data-tounar-company')) {
      addCandidate(out, 'company_name', hook.getAttribute('data-tounar-company'), { source: 'data-hook', score: 0.99, el: hook });
    }
    if (adapter.company) {
      addCandidate(out, 'company_name', adapter.company, { source: 'adapter-constant', score: 0.96 });
    }
    if (ld && !ld.multiple && ld.hiringOrganization?.name) {
      addCandidate(out, 'company_name', ld.hiringOrganization.name, { source: 'jsonld', score: 0.95 });
    }
    for (const selector of adapter.selectors?.company || []) {
      let nodes;
      try { nodes = document.querySelectorAll(selector); } catch { continue; }
      let count = 0;
      for (const node of nodes) {
        if (count >= 6) break;
        addCandidate(out, 'company_name', textOf(node), { source: 'adapter', score: 0.88, el: node });
        count += 1;
      }
    }
    const semantic = document.querySelectorAll('[itemprop="hiringOrganization"], [class*="company-name"], [class*="companyName"], [class*="com-name"], [class*="comName"], [class*="company"]');
    let count = 0;
    for (const node of semantic) {
      if (count >= 24) break;
      if (!isDetailContext(node) && !isNavContext(node)) {
        addCandidate(out, 'company_name', textOf(node), { source: 'semantic', score: 0.72, el: node });
        count += 1;
      }
    }
    const bodyText = textOf(document.body).slice(0, 12000);
    const labeled = bodyText.match(/(?:公司名称|企业名称|所属公司|招聘企业)\s*[:：]\s*([^\s|｜·]{2,40})/);
    if (labeled) addCandidate(out, 'company_name', labeled[1], { source: 'label', score: 0.78 });
    if (!adapter.platform) {
      const hostCompany = Adapters.companyForHost(location.hostname);
      if (hostCompany) addCandidate(out, 'company_name', hostCompany, { source: 'host-map', score: 0.72 });
      const siteName = metaContent(['og:site_name']);
      if (siteName) addCandidate(out, 'company_name', siteName, { source: 'og:site_name', score: 0.45 });
    }
    return out;
  }

  function textAfterHeading(node) {
    const own = textOf(node);
    let collected = '';
    let sibling = node.nextElementSibling;
    let steps = 0;
    while (sibling && steps < 4 && collected.length < 220) {
      const text = textOf(sibling);
      if (text && text.length > 8) collected = `${collected} ${text}`.trim();
      sibling = sibling.nextElementSibling;
      steps += 1;
    }
    if (!collected) {
      const parent = node.parentElement;
      if (parent) collected = textOf(parent).replace(own, ' ').trim();
    }
    return collected;
  }

  function collectJdCandidates(ld) {
    const out = [];
    const hook = document.querySelector('[data-tounar-job-id]');
    const hookJd = hook?.getAttribute('data-tounar-jd');
    if (hookJd) addCandidate(out, 'jd_summary', hookJd, { source: 'data-hook', score: 0.99 });
    if (ld && !ld.multiple && ld.description) {
      addCandidate(out, 'jd_summary', String(ld.description).replace(/<[^>]+>/g, ' '), { source: 'jsonld', score: 0.94 });
    }
    for (const selector of adapter.selectors?.jd || []) {
      let nodes;
      try { nodes = document.querySelectorAll(selector); } catch { continue; }
      let count = 0;
      for (const node of nodes) {
        if (count >= 5) break;
        addCandidate(out, 'jd_summary', textOf(node), { source: 'adapter', score: 0.9, el: node });
        count += 1;
      }
    }
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, strong, b, dt, [class*="title"], [class*="Title"]');
    let headingCount = 0;
    for (const node of headings) {
      if (headingCount >= 40) break;
      const text = textOf(node);
      if (text.length <= 24 && JD_HEADING.test(text)) {
        addCandidate(out, 'jd_summary', textAfterHeading(node), { source: 'heading-block', score: 0.88, el: node });
        headingCount += 1;
      }
    }
    const paragraphs = document.querySelectorAll('main p, main li, article p, article li, [class*="detail"] p, [class*="detail"] li, [class*="job-detail"] p, [class*="job-detail"] li');
    let pCount = 0;
    for (const node of paragraphs) {
      if (pCount >= 12) break;
      addCandidate(out, 'jd_summary', textOf(node), { source: 'detail-paragraph', score: 0.68, el: node });
      pCount += 1;
    }
    const desc = metaContent(['description', 'og:description', 'twitter:description']);
    if (desc && desc.length >= 20) addCandidate(out, 'jd_summary', desc, { source: 'meta', score: 0.48 });
    return out;
  }

  function extractLabeledValue(text, labels) {
    const escaped = labels.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const match = String(text || '').match(new RegExp(`(?:${escaped})\\s*[:：]\\s*([^\\n|｜]{2,50})`, 'i'));
    return match ? match[1].trim() : '';
  }

  function collectLocationCandidates(ld) {
    const out = [];
    const hook = document.querySelector('[data-tounar-job-id]');
    if (hook?.getAttribute('data-tounar-location')) {
      addCandidate(out, 'location', hook.getAttribute('data-tounar-location'), { source: 'data-hook', score: 0.99 });
    }
    if (ld && !ld.multiple) addCandidate(out, 'location', locationText(ld), { source: 'jsonld', score: 0.92 });
    for (const selector of adapter.selectors?.location || []) {
      let nodes;
      try { nodes = document.querySelectorAll(selector); } catch { continue; }
      let count = 0;
      for (const node of nodes) {
        if (count >= 5) break;
        addCandidate(out, 'location', textOf(node), { source: 'adapter', score: 0.86, el: node });
        count += 1;
      }
    }
    const infoText = firstText(adapter.selectors?.info || ['.job-info', '[class*="basicInfo"]', '[class*="job-detail-infos"]', '[class*="job-info"]']);
    const labeled = extractLabeledValue(infoText || textOf(document.body).slice(0, 6000), ['工作地点', '办公地点', '工作城市', '城市', 'Location', '地点']);
    if (labeled) addCandidate(out, 'location', labeled, { source: 'label', score: 0.78 });
    const semantic = document.querySelectorAll('[itemprop="jobLocation"], [class*="job-location"], [class*="jobLocation"], [class*="position-address"], [class*="job-area"], [class*="jobArea"]');
    let count = 0;
    for (const node of semantic) {
      if (count >= 12) break;
      addCandidate(out, 'location', textOf(node), { source: 'semantic', score: 0.7, el: node });
      count += 1;
    }
    return out;
  }

  function applyAdapterRefine(job) {
    if (typeof adapter.refine !== 'function') return job;
    try {
      const refined = adapter.refine(job);
      if (refined && typeof refined === 'object') {
        for (const key of ['company_name', 'job_title', 'location', 'recruitment_batch', 'site_job_id']) {
          if (refined[key] && (!job.field_confidence || !job.field_confidence[key])) {
            refined.field_confidence = { ...(refined.field_confidence || {}), [key]: 0.9 };
          }
        }
        return refined;
      }
    } catch { /* 精修失败不影响主链路 */ }
    return job;
  }

  function detailUrlMatches() {
    return (adapter.jobUrlPatterns || []).some((p) => p.test(location.href));
  }

  function listUrlMatches() {
    return (adapter.listUrlPatterns || []).some((p) => p.test(location.href))
      || (adapter !== Adapters.GENERIC && (Adapters.GENERIC.listUrlPatterns || []).some((p) => p.test(location.href)));
  }

  function detectJob() {
    const hook = document.querySelector('[data-tounar-job-id]');
    const ld = readJobPostingJsonLd();
    if (ld?.multiple && !hook) return null;
    if (listUrlMatches() && !hook && !ld) return null;

    const titleC = chooseCandidate(collectTitleCandidates(ld));
    const companyC = chooseCandidate(collectCompanyCandidates(ld));
    if (!titleC || !companyC) return null;
    /* 标题必须来自可信来源：适配器/JSON-LD/h1 等。document.title / og:title 只作为候选，
       不足以单独建立记录；否则 SPA 首屏会先抓到站点名，3 秒后错误入库。 */
    if (titleC.score < 0.65) return null;
    if (!isValidTitle(titleC.value, companyC.value) || !isValidCompany(companyC.value)) return null;
    if (normalizedKey(titleC.value) === normalizedKey(companyC.value)) return null;

    const jdC = chooseCandidate(collectJdCandidates(ld));
    const locationC = chooseCandidate(collectLocationCandidates(ld));
    const infoText = firstText(adapter.selectors?.info || ['.job-info', '[class*="basicInfo"]', '[class*="job-detail-infos"]', '[class*="job-info"]']);
    const batchText = `${titleC.value} ${infoText || ''} ${jdC?.value || ''}`;
    const batch = batchFromText(batchText);
    const jobUrl = canonicalUrl(hook?.getAttribute('data-tounar-job-url') || (ld && !ld.multiple && ld.url) || location.href);
    const siteJobId = hook?.getAttribute('data-tounar-job-id')
      || (ld && !ld.multiple ? (identifierValue(ld) || idFromUrl(jobUrl || '')) : '') || idFromUrl(jobUrl || '');
    const detailSignal = !!hook || !!(ld && !ld.multiple) || detailUrlMatches() || hasApplySignal();
    if (!detailSignal) return null;
    if (adapter === Adapters.GENERIC && !hasApplySignal() && !ld && !hook) return null;

    const fieldConfidence = {
      company_name: Math.round(companyC.score * 100) / 100,
      job_title: Math.round(titleC.score * 100) / 100,
      job_url: 0.95
    };
    if (jdC) fieldConfidence.jd_summary = Math.round(jdC.score * 100) / 100;
    if (locationC) fieldConfidence.location = Math.round(locationC.score * 100) / 100;
    if (batch) fieldConfidence.recruitment_batch = 0.72;
    if (siteJobId) fieldConfidence.site_job_id = 0.9;

    let job = {
      company_name: companyC.value,
      job_title: titleC.value,
      site_job_id: siteJobId,
      job_url: jobUrl,
      jd_summary: jdC?.value || '',
      location: locationC?.value || '',
      recruitment_batch: batch,
      channel: adapter.channel,
      field_confidence: fieldConfidence,
      detection: {
        title_source: titleC.source,
        company_source: companyC.source,
        jd_source: jdC?.source || null,
        location_source: locationC?.source || null,
        apply_signal: hasApplySignal(),
        site_verified: !!adapter.site_verified
      }
    };
    job = applyAdapterRefine(job);
    job.field_confidence = job.field_confidence || fieldConfidence;
    job.detection_score = Math.round(((job.field_confidence.company_name + job.field_confidence.job_title) / 2) * 100) / 100;
    job.detection_key = `${job.site_job_id || job.job_url || ''}|${normalizedKey(job.company_name)}|${normalizedKey(job.job_title)}`;
    return job;
  }

  function currentTitleFromDom() {
    const adapterTitle = firstText(adapter.selectors?.title || []);
    if (adapterTitle) return cleanTitleValue(adapterTitle);
    const h1 = document.querySelector('main h1, article h1, h1');
    return h1 ? cleanTitleValue(textOf(h1)) : '';
  }

  function titlesEquivalent(a, b) {
    return normalizedKey(a) === normalizedKey(b);
  }

  // ---------- sending ----------

  function sendEvent(event) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'enqueue_event', event }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: true });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err?.message || err) });
      }
    });
  }

  function basePayload(job) {
    return {
      company_name: job.company_name || undefined,
      job_title: job.job_title || undefined,
      site_job_id: job.site_job_id || undefined,
      job_url: job.job_url || undefined,
      jd_summary: job.jd_summary || undefined,
      location: job.location || undefined,
      recruitment_batch: job.recruitment_batch || undefined,
      channel: job.channel || adapter.channel,
      field_confidence: job.field_confidence || undefined,
      detection: job.detection || undefined
    };
  }

  function buildEvent(job, eventType, { evidenceLevel, evidenceCode, occurredAt, payload = {} }) {
    return {
      client_event_id: newEventId(),
      event_type: eventType,
      source_method: 'plugin',
      site_key: adapter.key,
      adapter_version: adapter.version,
      schema_version: 'C1',
      occurred_at: occurredAt || nowIso(),
      observed_at: nowIso(),
      evidence_level: evidenceLevel,
      evidence_code: evidenceCode,
      payload: { ...basePayload(job), ...payload }
    };
  }

  function rememberLastJob(job) {
    try {
      sessionStorage.setItem('tounar:lastJob', JSON.stringify({ job, at: Date.now() }));
    } catch { /* ignore */ }
  }

  function lastKnownJob() {
    try {
      const raw = sessionStorage.getItem('tounar:lastJob');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Date.now() - (parsed.at || 0) > 30 * 60 * 1000) return null;
      return parsed.job || null;
    } catch {
      return null;
    }
  }

  // ---------- view dwell ----------

  function beginJob(job) {
    pageState.job = job;
    pageState.detectedAt = Date.now();
    pageState.viewStartedAt = new Date().toISOString();
    pageState.visibleMs = 0;
    pageState.viewSent = false;
    pageState.lastTitleCheckAt = 0;
    pageState.lastRedetectAt = Date.now();
    rememberLastJob(job);
    probe();
  }

  function mergeBetterDetection(next) {
    const current = pageState.job;
    if (!current || !next) return;
    if (next.detection_key !== current.detection_key) {
      if ((next.detection_score || 0) > (current.detection_score || 0) + 0.05 || (current.detection_score || 0) < 0.7) {
        beginJob(next);
      }
      return;
    }
    const betterScore = (next.detection_score || 0) > (current.detection_score || 0) + 0.05;
    const fillsJd = !current.jd_summary && next.jd_summary;
    const fillsLocation = !current.location && next.location;
    const fillsBatch = !current.recruitment_batch && next.recruitment_batch;
    if (!betterScore && !fillsJd && !fillsLocation && !fillsBatch) return;
    pageState.job = {
      ...current,
      ...next,
      detectedAt: current.detectedAt,
      field_confidence: { ...(current.field_confidence || {}), ...(next.field_confidence || {}) }
    };
    probe();
  }

  function detectAndTrackRoute() {
    if (location.href !== pageState.href) {
      pageState.href = location.href;
      pageState.routeKey = routeKey();
      pageState.job = null;
      pageState.detectedAt = null;
      pageState.viewStartedAt = null;
      pageState.visibleMs = 0;
      pageState.viewSent = false;
      pageState.formSent = false;
      pageState.submitScanUntil = 0;
      pageState.statusSent = new Set();
      pageState.lastTickAt = Date.now();
      pageState.lastMutationAt = Date.now();
    }
    /* SPA 安静期：DOM 变化后至少等 800ms，避免抓到骨架屏/上一个岗位。首次进入
       （lastMutationAt = 0）不额外等待，E2E 和静态页仍能快速识别。 */
    if (Date.now() - pageState.lastMutationAt < SETTLE_MS) return pageState.job;
    if (!pageState.job) {
      const job = detectJob();
      if (job) beginJob(job);
      return pageState.job;
    }
    /* 同一 URL 下弹窗/抽屉切换岗位：内容稳定后重新打分，若换了岗位就重新计时。
       另外在首次上报前每秒重检一次：首屏可能先只有 document.title，随后才渲染
       出岗位标题/JD（字节、小米这类 SPA），用更高分结果补全，不把低把握值锁死。 */
    const now = Date.now();
    const shouldRefresh = pageState.lastMutationAt > pageState.detectedAt
      || (!pageState.viewSent && now - pageState.lastRedetectAt >= 1000);
    if (shouldRefresh) {
      pageState.lastRedetectAt = now;
      mergeBetterDetection(detectJob());
    }
    return pageState.job;
  }

  function tickDwell() {
    const now = Date.now();
    /* 发事件前再校验一次：当前 DOM 的岗位名必须仍是检测时的岗位名。 */
    if (pageState.job && !pageState.viewSent && now - pageState.lastTitleCheckAt >= 1000) {
      pageState.lastTitleCheckAt = now;
      const current = currentTitleFromDom();
      if (current && isValidTitle(current, pageState.job.company_name)
        && !titlesEquivalent(current, pageState.job.job_title)) {
        pageState.job = null;
        pageState.detectedAt = null;
        pageState.viewStartedAt = null;
        pageState.visibleMs = 0;
        pageState.viewSent = false;
        return;
      }
    }
    const wasVisible = pageState.lastVisible !== false;
    if (document.visibilityState === 'visible' && pageState.job && !pageState.viewSent) {
      if (wasVisible) {
        const delta = now - pageState.lastTickAt;
        if (delta > 0 && delta < 30000) pageState.visibleMs += delta;
      }
      if (pageState.visibleMs >= DWELL_MS) {
        pageState.viewSent = true;
        const job = pageState.job;
        sendEvent(buildEvent(job, 'job_viewed', {
          evidenceLevel: 'strong',
          evidenceCode: 'visible-dwell-3000ms',
          occurredAt: pageState.viewStartedAt || nowIso(),
          payload: { visible_dwell_ms: pageState.visibleMs }
        }));
        probe();
      }
    }
    pageState.lastVisible = document.visibilityState === 'visible';
    pageState.lastTickAt = now;
  }

  // ---------- form started ----------

  function looksLikeSearchInput(el) {
    const hint = `${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('name') || ''} ${el.className || ''}`;
    return /search|搜索|关键词|query/i.test(hint);
  }

  function onUserInput(event) {
    const el = event.target;
    if (!el || !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
    if (el.type === 'password' || el.type === 'hidden') return;
    if (looksLikeSearchInput(el)) return;
    const job = detectAndTrackRoute();
    if (!job || pageState.formSent) return;
    const inForm = el.closest('form');
    const contextHint = `${el.closest('[class*="apply"], [class*="submit"], [class*="deliver"], [id*="apply"], [id*="submit"], [class*="form"], [id*="form"]') ? 'context' : ''}`;
    if (!inForm && !contextHint) return;
    pageState.formSent = true;
    pageState.submitScanUntil = Date.now() + SUBMIT_WINDOW_MS;
    sendEvent(buildEvent(job, 'form_started', {
      evidenceLevel: 'strong',
      evidenceCode: 'user-input-on-apply-form'
    }));
    probe();
  }

  // ---------- submission detection ----------

  function findSuccessMarker() {
    if (document.querySelector('[data-tounar-submitted="true"]')) return 'explicit-hook';
    const urlSuccess = /(success|submitted|complete|result|finish)/i.test(location.pathname + location.search);
    for (const selector of adapter.selectors.success || []) {
      let nodes;
      try { nodes = document.querySelectorAll(selector); } catch { continue; }
      for (const node of nodes) {
        const text = textOf(node);
        if (text && (SUCCESS_TEXT.test(text) || (urlSuccess && text))) return 'success-element';
      }
    }
    if (urlSuccess) {
      const bodyHint = textOf(document.querySelector('main') || document.body).slice(0, 4000);
      if (SUCCESS_TEXT.test(bodyHint)) return 'success-text';
    }
    return null;
  }

  function applicationIdFromPage() {
    const hook = document.querySelector('[data-tounar-application-id]');
    if (hook) return hook.getAttribute('data-tounar-application-id') || '';
    const params = new URLSearchParams(location.search);
    return params.get('applyId') || params.get('applicationId') || params.get('apply_id') || '';
  }

  function scanForSubmission() {
    if (pageState.submitSent) return;
    if (!pageState.submitScanUntil || Date.now() > pageState.submitScanUntil) return;
    const marker = findSuccessMarker();
    if (!marker) return;
    const job = pageState.job || lastKnownJob();
    if (!job) return;
    pageState.submitSent = true;
    try { sessionStorage.setItem('tounar:submitSent', '1'); } catch { /* ignore */ }
    const strong = marker === 'explicit-hook' || (job.company_name && job.job_title && job.job_url);
    sendEvent(buildEvent(job, 'application_submitted', {
      evidenceLevel: strong ? 'strong' : 'weak',
      evidenceCode: `submit-detected:${marker}`,
      payload: {
        site_application_id: applicationIdFromPage() || undefined,
        status_text: '投递成功',
        mapped_status: 'applied'
      }
    }));
    probe();
  }

  // ---------- site status observation ----------

  function statusJobFromHook(block) {
    return {
      company_name: block.getAttribute('data-tounar-company') || '',
      job_title: block.getAttribute('data-tounar-job-title') || firstText(adapter.selectors.title),
      site_job_id: block.getAttribute('data-tounar-job-id') || '',
      job_url: canonicalUrl(block.getAttribute('data-tounar-job-url') || block.querySelector('a[href]')?.href || ''),
      jd_summary: '',
      location: '',
      recruitment_batch: '',
      channel: adapter.channel
    };
  }

  function scanStatusHooks() {
    for (const block of document.querySelectorAll('[data-tounar-status]')) {
      const statusText = block.getAttribute('data-tounar-status') || textOf(block);
      const mapped = Adapters.statusTextToCanonical(statusText) || block.getAttribute('data-tounar-status-canonical');
      const job = statusJobFromHook(block);
      if (!mapped || !job.job_title) continue;
      const key = `${job.site_job_id || job.job_title}|${mapped}`;
      if (pageState.statusSent.has(key)) continue;
      pageState.statusSent.add(key);
      sendEvent(buildEvent(job, 'site_status_observed', {
        evidenceLevel: 'strong',
        evidenceCode: 'structured-status-block',
        payload: {
          site_application_id: block.getAttribute('data-tounar-application-id') || undefined,
          status_text: statusText,
          mapped_status: mapped,
          status_url: canonicalUrl(location.href) || undefined,
          status_url_scope: location.hostname,
          round_label: block.getAttribute('data-tounar-round') || undefined
        }
      }));
    }
  }

  function scanAdapterStatusPage() {
    const page = adapter.statusPage;
    if (!page) return;
    const urlMatches = (page.urlPatterns || []).some((p) => p.test(location.href));
    if (!urlMatches) return;
    let rows;
    try { rows = document.querySelectorAll(page.rowSelector); } catch { return; }
    let count = 0;
    for (const row of rows) {
      if (count >= 20) break;
      const statusText = textOf(row.querySelector(page.statusSelector));
      const mapped = Adapters.statusTextToCanonical(statusText);
      if (!mapped) continue;
      const title = textOf(row.querySelector(page.titleSelector));
      if (!title) continue;
      const link = row.querySelector(page.linkSelector);
      const href = link ? canonicalUrl(link.href) : null;
      const key = `${title}|${mapped}|${href || ''}`;
      if (pageState.statusSent.has(key)) continue;
      pageState.statusSent.add(key);
      count += 1;
      const strong = !!href && !!title;
      sendEvent(buildEvent({
        company_name: firstText(adapter.selectors.company) || '',
        job_title: title.slice(0, 120),
        site_job_id: idFromUrl(href || ''),
        job_url: href || undefined,
        jd_summary: '',
        location: '',
        recruitment_batch: '',
        channel: adapter.channel
      }, 'site_status_observed', {
        evidenceLevel: strong ? 'strong' : 'weak',
        evidenceCode: strong ? 'adapter-status-row' : 'adapter-status-row-weak',
        payload: {
          status_text: statusText,
          mapped_status: mapped,
          status_url: canonicalUrl(location.href) || undefined,
          status_url_scope: location.hostname
        }
      }));
    }
  }

  // ---------- test / probe ----------

  function probe() {
    try {
      const host = document.documentElement;
      host.setAttribute('data-tounar-adapter', adapter.key);
      host.setAttribute('data-tounar-adapter-version', adapter.version);
      if (pageState.job) {
        host.setAttribute('data-tounar-job-detected', pageState.job.site_job_id || pageState.job.job_title || 'unknown');
        host.setAttribute('data-tounar-job-title', pageState.job.job_title || '');
        host.setAttribute('data-tounar-detection-score', String(pageState.job.detection_score || ''));
      }
      if (pageState.detectedAt) host.setAttribute('data-tounar-detected-at', String(pageState.detectedAt));
      host.setAttribute('data-tounar-visible-ms', String(Math.round(pageState.visibleMs)));
      host.setAttribute('data-tounar-view-sent', pageState.viewSent ? '1' : '0');
      host.setAttribute('data-tounar-form-sent', pageState.formSent ? '1' : '0');
      host.setAttribute('data-tounar-submit-sent', pageState.submitSent ? '1' : '0');
    } catch { /* ignore */ }
  }

  // ---------- lifecycle ----------

  document.addEventListener('focusin', onUserInput, true);
  document.addEventListener('change', onUserInput, true);
  document.addEventListener('visibilitychange', () => { pageState.lastTickAt = Date.now(); });

  try {
    const observer = new MutationObserver(() => { pageState.lastMutationAt = Date.now(); });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  } catch { /* MutationObserver 不可用时退回 250ms 轮询 */ }

  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function patchedPush() {
    const out = origPush.apply(this, arguments);
    try { setTimeout(detectAndTrackRoute, 50); } catch { /* ignore */ }
    return out;
  };
  history.replaceState = function patchedReplace() {
    const out = origReplace.apply(this, arguments);
    try { setTimeout(detectAndTrackRoute, 50); } catch { /* ignore */ }
    return out;
  };
  window.addEventListener('popstate', () => setTimeout(detectAndTrackRoute, 50));
  window.addEventListener('hashchange', () => setTimeout(detectAndTrackRoute, 50));

  window.addEventListener('pagehide', () => {
    if (pageState.job && !pageState.viewSent && pageState.visibleMs >= DWELL_MS) {
      pageState.viewSent = true;
      sendEvent(buildEvent(pageState.job, 'job_viewed', {
        evidenceLevel: 'strong',
        evidenceCode: 'visible-dwell-3000ms-pagehide',
        occurredAt: pageState.viewStartedAt || nowIso()
      }));
    }
  });

  setInterval(() => {
    detectAndTrackRoute();
    tickDwell();
    scanForSubmission();
    scanStatusHooks();
    scanAdapterStatusPage();
    if (Date.now() - pageState.lastProbeAt > 1000) {
      pageState.lastProbeAt = Date.now();
      probe();
    }
  }, TICK_MS);

  detectAndTrackRoute();
  probe();
})();
