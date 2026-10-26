/*
 * Tounar 帮你理 · 页面线索采集（content script，classic）
 *
 * 采集边界（对应 PRD 数据稿）：
 * - 只在识别为「岗位详情」的页面开启计时；
 * - job_viewed 需要客户端可见累计 ≥ 3 秒；
 * - form_started 只记录「用户在某投递表单里开始输入」这一事实，不读取任何输入内容；
 * - application_submitted 只在检测到明确的成功标记时发出，并区分强/弱证据；
 * - site_status_observed 只读取显式 data-tounar-* 状态块或站点适配器声明的投递记录行；
 * - 上传识别到的岗位字段与 JD 正文；不读取表单值、Cookie 或账号信息。
 */
(function () {
  if (globalThis.__tounarTrackerLoaded) return;
  globalThis.__tounarTrackerLoaded = true;

  const Adapters = globalThis.TounarAdapters;
  if (!Adapters || !chrome?.runtime?.sendMessage) return;

  const DWELL_MS = 3000;
  const TICK_MS = 250;
  const SUBMIT_SCAN_MS = 1000;
  const SUBMIT_WINDOW_MS = 5 * 60 * 1000;
  const MAX_JD_CHARS = 80;
  const MAX_JD_TEXT = 100000;
  const SUCCESS_TEXT = /投递成功|申请成功|提交成功|已成功提交|感谢(您|你)的?投递|简历投递成功|报名成功|application\s+(has been\s+)?submitted|successfully\s+submitted|submitted\s+successfully/i;

  const adapter = Adapters.resolveAdapter(location.hostname);
  let capturePaused = false;
  chrome.storage?.local?.get('tounar.settings.v1').then(value => { capturePaused = !!value['tounar.settings.v1']?.capturePaused; }).catch(() => {});

  // 已学习模板（异步加载；命中时作为快速路径）
  let learnedTemplate = null;
  async function loadTemplate() {
    const href = location.href;
    try {
      const res = await globalThis.TounarLearned?.getTemplate(new URL(href));
      if (href === location.href) learnedTemplate = res?.template || null;
    } catch { learnedTemplate = null; }
  }
  const learnedReady = loadTemplate();
  async function auditTemplate(job) {
    const url = new URL(job.job_url);
    try {
      if (learnedTemplate && learnedTemplate.status !== 'suspect') {
        const audit = globalThis.TounarLearned?.validateHit(learnedTemplate, globalThis.TounarLearned?.extractWith(learnedTemplate), job);
        if (audit?.ok) return await globalThis.TounarLearned.recordHit(url, job, audit);
        await globalThis.TounarLearned?.markFailure(url);
      }
      const learned = await globalThis.TounarLearned?.learnFromJob(job, url);
      if (learned) learnedTemplate = learned;
      return learned;
    } catch { return null; }
  }
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
    lastProbeAt: 0
  };


  // ---------- helpers ----------

  function routeKey() {
    return `${location.pathname}${location.search}${location.hash}`;
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
      url.username = ''; url.password = '';
      url.pathname = url.pathname.replace(/;(?:jsessionid|phpsessid|sessionid|sid)=[^/;?#]*/gi, '');
      const drop = /^(utm_|spm|from|source|track|scm|share|ref|share_|weibo|gclid|fbclid|sid$|session|jsessionid$|phpsessid$|token$|access_token$|auth|state$|email$|phone$)/i;
      const kept = new URLSearchParams();
      for (const [key, value] of url.searchParams.entries()) {
        if (!drop.test(key)) kept.append(key, value);
      }
      url.search = kept.toString();
      if (/^#!?\//.test(url.hash)) {
        const route = new URL(url.hash.replace(/^#!/, '#').slice(1), url.origin);
        route.pathname = route.pathname.replace(/;(?:jsessionid|phpsessid|sessionid|sid)=[^/;?#]*/gi, '');
        for (const key of [...route.searchParams.keys()]) if (drop.test(key)) route.searchParams.delete(key);
        url.hash = '#' + route.pathname + route.search;
      } else url.hash = '';
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
    return [...new Set((Array.isArray(loc) ? loc : [loc]).map(item => {
      const address = item?.address || item;
      return typeof address === 'string' ? address : address?.addressLocality || address?.addressRegion || '';
    }).filter(Boolean))].join('、');
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
      const url = new URL(canonicalUrl(jobUrl) || jobUrl);
      const route = /^#!?\//.test(url.hash) ? new URL(url.hash.replace(/^#!/, '#').slice(1), url.origin) : url;
      const parts = route.pathname.split('/').filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const part = parts[i];
        if (/^\d{4,}$/.test(part) || /^[0-9a-f-]{8,}$/i.test(part)) return part;
      }
      const slug = route.pathname.match(/\/(?:jobs?|positions?|post|opening|intern|job_detail|job-detail|job-info|jobdesc)\/(?:detail\/)?([\w-]+)(?:\/detail)?\/?$/i);
      if (slug && !/^(list|search|detail|index|all)$/i.test(slug[1])) return slug[1];
      const numberedSlug = route.pathname.match(/\/(\d{6,})-[^/]+\/?$/);
      if (numberedSlug) return numberedSlug[1];
      return route.searchParams.get('code') || route.searchParams.get('job_id') || route.searchParams.get('requementId') || route.searchParams.get('jobId') || route.searchParams.get('positionId') || route.searchParams.get('postId') || route.searchParams.get('jobUnionId') || route.searchParams.get('id') || '';
    } catch {
      return '';
    }
  }

  function batchFromText(text) {
    const match = String(text || '').match(/(20\d{2})\s*(届|年)?\s*(秋招|春招|暑期实习|实习|校招|校园招聘)?/);
    if (!match) return '';
    if (/秋招/.test(text)) return `${match[1]} 秋招`;
    if (/春招/.test(text)) return `${match[1]} 春招`;
    if (/实习/.test(text)) return `${match[1]} 实习`;
    return /校招|校园招聘/.test(text) ? `${match[1]} 校招` : '';
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

  /* 通用识别辅助（任意已授权站点生效，不依赖站点适配器） */

  // 标题清洗：去掉「- 某公司招聘」「_XX官网」这类站点后缀
  function cleanPageTitle(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    const parts = t.split(/\s+[-_—–·｜|]\s+/);
    if (parts.length > 1) t = parts[0].trim();
    t = t.replace(/[-_—–·｜|]?\s*[^-_—–·｜|]{0,20}(招聘|校园招聘|校招|官网|人才招聘|社会招聘|求职|猎聘)\s*$/, '').trim();
    return t.length > 120 ? t.slice(0, 120) : t;
  }

  // 从标题尾段拆公司：「产品经理 - 字节跳动招聘」→ 字节跳动
  function companyFromTitleSuffix() {
    const title = String(document.title || '');
    const parts = title.split(/\s+[-_—–·｜|]\s+/);
    if (parts.length < 2) return '';
    const last = parts[parts.length - 1].trim();
    const m = last.match(/^(.{2,20}?)(招聘|校园招聘|校招|官网|人才招聘|社会招聘|求职|猎聘)$/);
    return m ? m[1].trim() : '';
  }

  // 投递按钮信号：页面上存在「投递/申请/Apply」类按钮，是岗位详情页的强信号
  const APPLY_SIGNAL = /^(投递|投个简历|立即投递|投递简历|简历投递|申请|立即申请|申请职位|申请岗位|我要申请|网申|报名|立即报名|apply|apply now|apply for|sign up|application$)/i;
  function findApplySignal() {
    let nodes;
    try { nodes = document.querySelectorAll(['a', 'button', '[role="button"]', 'input[type="submit"]', 'input[type="button"]', ...(adapter.applySelectors || [])].join(',')); } catch { return false; }
    const limit = Math.min(nodes.length, 400);
    for (let i = 0; i < limit; i += 1) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const text = ((el.tagName === 'INPUT' ? el.value : textOf(el)) || '').replace(/\s+/g, '');
      // An Application tab can open the form on an actual job detail page.
      // The same word on account/software dashboards is not an apply signal.
      if (/^application$/i.test(text) && !(adapter.jobUrlPatterns || []).some(pattern => pattern.test(location.href))) continue;
      if (text && text.length <= 15 && APPLY_SIGNAL.test(text.trim())) return true;
      const hint = `${el.id || ''} ${el.className || ''}`;
      if (/apply|deliver|toudi/i.test(hint) && text && text.length <= 15) return true;
    }
    return false;
  }

  function visible(node) {
    // 表单/输入类排除要包含节点自身（避免把表单内容当岗位文本）；
    // 容器类排除只看祖先——按钮自己的类名可能叫 recommend-btn，但那仍是真实投递按钮。
    if (!node || node.closest('form,input:not([type="button"]):not([type="submit"]),textarea,select')) return false;
    if (node.parentElement && node.parentElement.closest('nav,footer,aside,[role="navigation"],[class*="recommend"],[class*="skeleton"],[aria-busy="true"]')) return false;
    if(node.closest('header')&&!node.closest('main,article'))return false;
    // A global region/login modal is not job content, even when its stylesheet
    // fails to load. Keep actual job-detail drawers eligible.
    const modal=node.closest('[role="dialog"],[class*="modal"],[class*="Modal"]');
    if(modal && !modal.matches('[data-job-id],[class*="job-detail"],[class*="position-detail"]') && !modal.querySelector('[data-job-id],[data-tounar-job-id],[class*="job-detail"],[class*="position-detail"]') && !/岗位职责|职位描述|任职要求|Responsibilities|Requirements/i.test(modal.innerText || ''))return false;
    const style=getComputedStyle(node);
    return style.display!=='none' && style.visibility!=='hidden' && node.getClientRects().length>0;
  }
  function validTitle(value) {
    const t=String(value||'').trim();
    return t.length>=2&&t.length<=200&&!/^(?:.*(?:校园招聘|社会招聘|招聘官网)|招聘|官网|首页|加载中[.…]*|loading[.…]*|skeleton|职位推荐|热门岗位|职位列表|职位详情|岗位详情|岗位职责|工作职责|职位描述|岗位描述|任职要求|岗位要求|工作内容|job description|requirements)$/i.test(t);
  }
  let detectionScope = document;
  function nodesFor(selectors) {
    const result=[];
    for(const selector of selectors||[])try{for(const node of detectionScope.querySelectorAll(selector))if(visible(node))result.push(node);}catch{}
    return [...new Set(result)];
  }
  function labelled(pattern) {
    const result=[];
    for(const node of nodesFor(['main dt','main label','main p','main li','article p','table td','table th','[class*="job-info"]','[class*="job-info"] span','[class*="job-meta"] span','[data-job-label]','[class*="location"]','[class*="batch"]'])) {
      const text=textOf(node);
      if(text.length>160)continue;
      const m=text.match(pattern);
      if(m?.[1])result.push(m[1].trim());
      else if(node.matches('dt,label,th,td,[data-job-label]')&&node.nextElementSibling&&visible(node.nextElementSibling)){const pair=(text.replace(/[:：]$/, '')+': '+textOf(node.nextElementSibling)).match(pattern);if(pair?.[1])result.push(pair[1].trim());}
    }
    return result.filter(t=>t&&t.length<=80);
  }
  function titleClassNearApply(buttons){
    if(!buttons||buttons.length!==1)return null;
    const btn=buttons[0];
    const btnRect=btn.getBoundingClientRect();
    let scope=btn;
    for(let i=0;i<6&&scope.parentElement&&scope.parentElement!==document.body;i++)scope=scope.parentElement;
    const candidates=[];
    for(const node of scope.querySelectorAll('[class*="title"],[class*="Title"]')){
      if(!visible(node))continue;
      const text=textOf(node);
      if(text.length<2||text.length>200||!validTitle(text))continue;
      if(/[：:]$/.test(text)||/(工作地点|项目|职位方向|子方向|薪资|人数)\s*[：:]/.test(text))continue;
      if(/^(相关链接|相关职位|相似职位|热门职位|职位推荐|公司介绍|公司信息|招聘流程|投递须知|温馨提示|分享|收藏)$/.test(text))continue;
      const r=node.getBoundingClientRect();
      if(r.top>btnRect.top+80)continue;
      const distance=Math.abs(btnRect.top-r.top)+Math.abs(btnRect.left-r.left)*0.2;
      if(distance>900)continue;
      candidates.push({text,distance});
    }
    // 按 DOM 顺序取第一个：详情页的面包屑/主标题在版式上先于副标题与“相关链接”。
    return candidates[0]?.text||null;
  }

  function repeatedTitleNearApply(buttons){
    if(!buttons||buttons.length!==1)return null;
    let scope=buttons[0];
    for(let i=0;i<5&&scope.parentElement&&scope.parentElement!==document.body;i++)scope=scope.parentElement;
    const bodyText=textOf(document.body);
    const seen=new Set();
    for(const node of scope.querySelectorAll('div,span,p,strong')){
      if(node.children.length||!visible(node))continue;
      const text=textOf(node);
      if(text.length<6||text.length>200||!validTitle(text))continue;
      if(/[：:]$/.test(text)||/(工作地点|项目|职位方向|子方向|薪资|人数)\s*[：:]/.test(text))continue;
      if(seen.has(text))continue;
      seen.add(text);
      if(bodyText.split(text).length-1>=2)return text;
    }
    return null;
  }

  function blockedPage() {
    if (/\/(?:chat|im|message|login|signin|captcha)(?:[/?#]|$)/i.test(location.pathname + location.hash)) return true;
    const text = String(document.querySelector('main')?.innerText || document.body?.innerText || '').trim();
    return text.length < 4000 && /职位已过期|岗位已下线|职位不存在|岗位不存在|职位已关闭|职位已停止招聘|验证后继续访问|完成安全验证|安全验证|访问异常|job (?:is )?(?:expired|no longer available)/i.test(text);
  }
  function detectJob({ useTemplate = true } = {}) {
    if (blockedPage()) return null;
    detectionScope = [...document.querySelectorAll('[role="dialog"],[class*="drawer"],[class*="Drawer"]')]
      .find(n => visible(n) && /岗位职责|职位描述|任职要求|Responsibilities|Requirements/i.test(n.innerText || '')) || document;
    const hook=document.querySelector('[data-tounar-job-id]');
    const ld=readJobPostingJsonLd();
    const posting=ld&&!ld.multiple?ld:null;
    if (ld?.multiple && !hook) return null;
    const list=(adapter.listUrlPatterns||[]).some(p=>p.test(location.href));
    const verifiedAdapter=adapter.site_verified&&(!adapter.verifiedUrlPatterns||adapter.verifiedUrlPatterns.some(pattern=>pattern.test(location.href)));
    const semanticDetail = !!idFromUrl(location.href) && /岗位职责|职位描述|任职要求|Job Description|Responsibilities|Requirements/i.test(detectionScope.body?.innerText || detectionScope.innerText || '') && nodesFor(['h1']).length === 1;
    const adapterDetail = verifiedAdapter && !!idFromUrl(location.href) && nodesFor(adapter.selectors.title).length === 1;
    if(!hook&&!posting&&((list && detectionScope === document)||(!findApplySignal()&&!semanticDetail&&!adapterDetail&&detectionScope===document)))return null;
    const candidates={};
    const add=(field,value,score,source,rawValue)=>{
      if(field==='jd_summary'){
        // JD 要保留段落：不做整段空白折叠，只清掉行尾空格和过多空行
        let raw=String(rawValue ?? value ?? '').replace(/\r\n/g,'\n').replace(/[ \t]+$/gm,'').replace(/\n{3,}/g,'\n\n').trim();
        if(raw.length<10)return;
        (candidates.jd_summary||=[]).push({value:clipJd(value),raw,score,source});
        return;
      }
      const v=String(value||'').replace(/\s+/g,' ').trim();
      if(!v||/^(加载中[.…]*|loading[.…]*|--|…|待加载)$/i.test(v))return;
      // Font-obfuscated glyphs are not readable field values. Never upload
      // their private-use code points as a confident title/company/JD.
      if(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u.test(v))return;
      if(field==='job_title'&&!validTitle(v))return;
      if(field==='location'&&(v.length>40||/职位|职责|要求|公司介绍/.test(v)))return;
      if(field==='company_name'&&(v.length>60||/登录|注册|招聘平台|直聘|牛客|实习僧/.test(v)))return;
      (candidates[field]||=[]).push({value:v,raw:null,score,source});
    };
    // Replay is audited against independent extraction below. A title-only hit is insufficient.
    const picked = useTemplate && learnedTemplate?.status !== 'suspect'
      ? globalThis.TounarLearned?.extractWith(learnedTemplate) : null;
    if(hook)for(const [f,attr] of Object.entries({company_name:'company',job_title:'job-title',site_job_id:'job-id',jd_summary:'jd',location:'location',recruitment_batch:'batch'}))add(f,hook.getAttribute('data-tounar-'+attr),100,'explicit_hook');
    const aggregator=['boss','nowcoder','shixiseng'].includes(adapter.key);
    const fixed=Adapters.companyForHost(location.hostname);
    if(adapter.company_name&&!aggregator)add('company_name',adapter.company_name,98,'adapter_company');
    if(fixed&&!aggregator)add('company_name',fixed,91,'known_company_host');
    if(posting){
      add('job_title',posting.title,95,'json_ld');
      add('company_name',posting.hiringOrganization?.name,99,'json_ld');
      add('jd_summary',plainDescription(posting.description),95,'json_ld',plainDescription(posting.description));add('site_job_id',identifierValue(posting),95,'json_ld');
      add('location',locationText(posting),95,'json_ld');add('recruitment_batch',batchFromText(posting.title||''),90,'json_ld');
    }
    const microdataCompany = document.querySelector('[itemprop="hiringOrganization"] [itemprop="name"]');
    if (microdataCompany) add('company_name',microdataCompany.content || textOf(microdataCompany),98,'schema_microdata');
    const microdataCity = document.querySelector('[itemprop="jobLocation"] [itemprop="addressLocality"]');
    if (microdataCity) add('location',microdataCity.content || textOf(microdataCity),98,'schema_microdata');
    // A declared employer in the page title must name the same visible job.
    const applicationTitle = document.title.match(/^Job Application for (.+) at (.+)$/i);
    if (applicationTitle && nodesFor(['h1','h2']).some(n=>textOf(n)===applicationTitle[1])) add('company_name',applicationTitle[2],92,'page_title_employer');
    for(const n of nodesFor(['[itemprop="title"]'])) if(n.matches('h1,h2')) add('job_title',textOf(n),94,'schema_microdata');
    const places = [...new Set(nodesFor(['[class*="job"][class*="location"]']).filter(n=>!n.closest('form')&&!n.querySelector('input,select')).map(textOf).filter(t=>t.length<=40))];
    if(places.length===1)add('location',places[0],82,'job_location');
    const applyButtons=nodesFor(['button','a','[role="button"]','input[type="button"]','input[type="submit"]',...(adapter.applySelectors||[])]).filter(n=>{
      const label=n.tagName==='INPUT'?n.value:textOf(n);
      return APPLY_SIGNAL.test(label.replace(/\s+/g,''))&&label.length<=20;
    });
    const headingNodes=nodesFor(['h1','h2','h3','[role="heading"]',...(adapter.selectors.title||[])]).filter(n=>validTitle(textOf(n))&&(verifiedAdapter||/^H[1-3]$/.test(n.tagName)||n.getAttribute('role')==='heading'||Number.parseFloat(getComputedStyle(n).fontSize)>=20));
    const headings=headingNodes.filter(node=>!headingNodes.some(other=>other!==node&&node.contains(other)));
    function headingScore(node){
      const text=textOf(node);if(node.tagName!=='H1'&&headings.filter(n=>textOf(n)===text&&!n.contains(node)&&!node.contains(n)).length>=1)return 0;
      const r=node.getBoundingClientRect();
      const distance=applyButtons.length?Math.min(...applyButtons.map(b=>{const a=b.getBoundingClientRect();return Math.abs(r.top-a.top)+Math.abs(r.left-a.left)*0.2;})):1000;
      return 82-Math.min(12,distance/100)+(node.tagName==='H1'?3:0);
    }
    for(const node of headings){const score=headingScore(node);if(score)add('job_title',textOf(node),score,'heading_near_apply');}
    if(!(candidates.job_title||[]).some(c=>c.score>=70)){
      // 通用兜底：SPA 详情页常常没有 h1/h2，岗位名以普通 div 重复出现（面包屑 + 标题），
      // 且整页只有一个投递按钮。只在还没有中高把握标题时启用，避免把弹窗/列表标题当岗位。
      const repeated=repeatedTitleNearApply(applyButtons)||titleClassNearApply(applyButtons);
      if(repeated)add('job_title',repeated,74,'title_near_apply');
    }
    const companyLabels=labelled(/(?:公司名称|公司名|雇主|Company)\s*[:：]\s*(.{2,50})/i);
    for(const node of [...detectionScope.querySelectorAll('main div,main span,main strong,article div,article span')].slice(0,200)){
      if(node.children.length||!visible(node)||!validTitle(textOf(node)))continue;
      const fontSize=Number.parseFloat(getComputedStyle(node).fontSize);
      if(fontSize<22||textOf(node)===fixed||companyLabels.includes(textOf(node)))continue;
      add('job_title',textOf(node),71+Math.min(fontSize,100)/100,'large_visible_text');
    }
    for(const node of nodesFor(adapter.selectors.title)){
      // A broad draft selector cannot outrank a scoped heading or structured posting.
      if(validTitle(textOf(node)))add('job_title',textOf(node),verifiedAdapter?88:65,'site_selector');
    }
    if(aggregator){for(const n of nodesFor(adapter.selectors.company))if(!n.querySelector('h1,h2,form')&&textOf(n).length<=60)add('company_name',textOf(n),verifiedAdapter?92:85,'company_card');}
    else for(const n of nodesFor(adapter.selectors.company))add('company_name',textOf(n),verifiedAdapter?89:67,'site_selector');
    const jdHeading=/^(职位描述|岗位描述|岗位职责|工作职责|任职要求|岗位要求|职位要求|工作内容|Job Description|Responsibilities|Requirements|Qualifications|What you['’]ll do|What you will do|What you have|About the role|Your responsibilities|A typical day|Your qualifications|Your expertise)\s*[:：]?$/i;
    const jdSections = [];
    for(const n of nodesFor(['h2','h3','h4','strong','dt','[class*="title"]'])){
      if(!jdHeading.test(textOf(n)))continue;
      const chunks=[];let section=n,next=n.nextElementSibling;
      for(let i=0;!next&&i<3;i++){
        if(!section.parentElement||textOf(section.parentElement)!==textOf(n))break;
        section=section.parentElement;next=section.nextElementSibling;
      }
      for(let i=0;next&&i<40;i++,next=next.nextElementSibling){if(jdHeading.test(textOf(next)) || next.matches('h1,h2,h3,h4') || /推荐职位|相关职位|公司介绍|投递须知|^#LI-/i.test(textOf(next).slice(0,30)))break;if(!visible(next)||next.matches('button,a')||next.querySelector('form,input,textarea,button'))continue;chunks.push(String(next.innerText||textOf(next)).trim());}
      const text=chunks.join('\n\n');if(text.length>=10)jdSections.push(textOf(n) + '\n' + text);
    }
    if(jdSections.length) add('jd_summary', jdSections[0].split('\n').slice(1).join('\n'), 86, 'jd_heading_sections', jdSections.join('\n\n'));
    if(verifiedAdapter) {
      const nodes = nodesFor(adapter.selectors.jd).filter(n => !n.querySelector('nav,aside,form,input,textarea') && !(adapter.jdExcludeHeaders||[]).includes(textOf(n.firstElementChild)));
      const leaves = nodes.filter(n => !nodes.some(other => other !== n && n.contains(other)));
      // 章节标题通常不在正文节点里，用父容器语义补回「岗位职责 / 任职要求 / 项目介绍」，
      // 保证 JD 全文能看出职责与要求的分界（摘要值仍取第一段，兼容旧回归）。
      const labelFor = (node) => {
        const cls = String(node.parentElement?.className || '');
        if (/requirement/i.test(cls)) return '任职要求';
        if (/introduction/i.test(cls)) return '项目介绍';
        if (/duty/i.test(cls)) return '岗位职责';
        return null;
      };
      const parts = leaves.map(n => {
        const text = String(n.innerText || '').trim();
        if (!text) return '';
        const label = labelFor(n);
        return label ? `${label}\n${text}` : text;
      }).filter(Boolean);
      const text = parts.join('\n\n');
      if (text) add('jd_summary', textOf(leaves[0]), 88, 'verified_site_selector', text);
    }
    for(const value of labelled(/(?:工作地点|工作城市|城市|Location)\s*[:：]\s*([^，,;；\n]{1,40})/i))add('location',value,84,'label');
    for(const value of labelled(/(?:招聘类型|招聘批次|批次)\s*[:：]\s*(.{1,50})/i))add('recruitment_batch',batchFromText(value)||value,84,'label');
    for(const value of labelled(/(?:职位\s*ID|岗位编号|职位编号|Job\s*ID|Position\s*ID)\s*[:：]\s*([A-Za-z0-9_-]+)/i))add('site_job_id',value,84,'label');
    if(!aggregator)for(const value of labelled(/(?:公司名称|公司名|雇主|Company)\s*[:：]\s*(.{2,50})/i))add('company_name',value,80,'label');
    // Refinement is useful only for the adapter with recorded real-page evidence.
    if(verifiedAdapter&&typeof adapter.refine==='function'){
      const seed={site_job_id:identifierValue(posting)||idFromUrl(location.href)};
      try{const refined=adapter.refine(seed)||seed;for(const f of ['company_name','location','recruitment_batch','site_job_id'])add(f,refined[f],90,'verified_refine');}catch{}
    }
    const scopedId = detectionScope.querySelector('[data-job-id],[data-position-id]') ||
      (detectionScope.matches?.('[data-job-id],[data-position-id]') ? detectionScope : null);
    if (scopedId) add('site_job_id', scopedId.getAttribute('data-job-id') || scopedId.getAttribute('data-position-id'), 95, 'visible_job_identifier');
    add('site_job_id',idFromUrl(location.href),80,'url_identifier');
    add('job_title',cleanPageTitle(metaContent(['og:title','twitter:title'])),55,'meta');
    add('job_title',cleanPageTitle(document.title),40,'document_title');
    const job={job_url:canonicalUrl(hook?.getAttribute('data-tounar-job-url')||posting?.url||location.href),channel:adapter.channel,field_confidence:{job_url:'high'},field_sources:{job_url:'canonical_url'}};
    for(const field of ['company_name','job_title','site_job_id','jd_summary','location','recruitment_batch']){
      const best=(candidates[field]||[]).sort((a,b)=>b.score-a.score)[0];
      const confidence=!best||best.score<70?'low':best.score>=90?'high':'medium';
      job[field]=confidence==='low'?'':best.value;job.field_confidence[field]=confidence;job.field_sources[field]=best?.source||'unavailable';
      if(field==='jd_summary'){const rawJd=(candidates.jd_summary||[]).sort((a,b)=>b.score-a.score)[0]?.raw||'';job.jd_text=rawJd&&rawJd.length>=10&&rawJd.length<=MAX_JD_TEXT?rawJd:'';job.jd_status=rawJd.length>MAX_JD_TEXT?'too_long':job.jd_text?'complete':'missing';job.jd_text_truncated=false;job.field_confidence.jd_text=job.field_confidence.jd_summary;job.field_sources.jd_text=job.jd_text?job.field_sources.jd_summary:'unavailable';}
    }
    // Ambiguous generic list-like pages must not manufacture a single job.
    if(!job.job_title)return null;
    if (useTemplate && learnedTemplate && picked) {
      const audit = globalThis.TounarLearned?.validateHit(learnedTemplate, picked, job);
      job.template_version = learnedTemplate.version || 1;
      job.template_fields = audit?.fields || [];
      job.template_status = audit?.ok ? learnedTemplate.status : 'suspect';
      if (audit?.ok) for (const [field, key] of [['job_title','title'],['company_name','company'],['jd_text','jd']]) {
        if (audit.fields.includes(key)) job.field_sources[field] = 'learned_template';
      }
    }
    return job;
  }

  function plainDescription(value) {
    const doc = new DOMParser().parseFromString(String(value || ''), 'text/html');
    doc.querySelectorAll('script,style,form,input,textarea,nav,aside').forEach(n => n.remove());
    doc.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
    doc.querySelectorAll('p,div,li,h1,h2,h3,h4,section,ul,ol').forEach(n => n.append('\n'));
    return (doc.body.textContent || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g,'\n\n').trim();
  }

  const discoveredJobs = new Set();
  let listBusy = false;
  let lastListAttempt = 0;
  let listLookup = {key:null,items:[]};
  async function captureList(explicit = false) {
    if (capturePaused || listBusy || blockedPage() || (!explicit && document.visibilityState !== 'visible')) return [];
    if (!explicit && Date.now()-lastListAttempt < 1500) return [];
    lastListAttempt = Date.now();
    listBusy = true;
    const ids = [];
    try {
      const listHref = location.href;
      const cards = [...document.querySelectorAll(['li','article','[class*="job-card"]','[class*="position-item"]','[class*="job-item"]','[class*="position-card"]', ...(adapter.listCardSelector ? [adapter.listCardSelector] : [])].join(','))];
      const lookupKey = location.href + '|' + cards.map(c => textOf(c.querySelector(adapter.listTitleSelector || 'h2,h3'))).join('|');
      if (adapter.listIdentities && cards.length && listLookup.key !== lookupKey) {
        const items = await adapter.listIdentities().catch(() => []);
        if(items.length) listLookup = {key:lookupKey,items};
      }
      for (const card of cards) {
        if (location.href !== listHref || !card.isConnected) break;
        if (!visible(card) || card.closest('nav,footer,[class*="recommend"]')) continue;
        const links = [...card.querySelectorAll('a[href]')].filter(a => idFromUrl(a.href) && /\/(?:jobs?|positions?|intern|job_detail|job-detail|jobdesc)|(?:jobId|postId|positionId|jobUnionId|code)=/i.test(a.href));
        const title = textOf(card.querySelector(adapter.listTitleSelector || '[class*="job-title"],[class*="position-title"],h2,h3,h4') || links[0]);
        const place = textOf(card.querySelector(adapter.listLocationSelector || '[class*="location"],[class*="job-area"]'));
        const batch = adapter.listBatchSelector ? textOf(card.querySelector(adapter.listBatchSelector)) : '';
        let matched = listLookup.key === lookupKey ? listLookup.items.filter(p => p.title === title && p.location === place) : [];
        if (!matched.length && adapter.lookupIdentity) {
          const items=await adapter.lookupIdentity(title).catch(()=>[]);
          if(location.href!==listHref || !card.isConnected || textOf(card.querySelector(adapter.listTitleSelector))!==title) continue;
          matched=items.filter(p=>p.title===title&&p.location===place);
          if(matched.length===1)listLookup.items.push(matched[0]);
        }
        const identity = adapter.listIdentity?.(card);
        const urls = [...new Set(links.map(a => canonicalUrl(a.href)))];
        if (!urls.length && identity?.url) urls.push(canonicalUrl(identity.url));
        if (!urls.length && matched.length === 1) urls.push(canonicalUrl(matched[0].url));
        if (urls.length !== 1) continue;
        const url = urls[0], id = idFromUrl(url);
        if (!id || discoveredJobs.has(url)) continue;
        if (!validTitle(title)) continue;
        const companyNode = card.querySelector('[class*="company-name"],[class*="companyName"],[class*="employer"]');
        const company = textOf(companyNode) || Adapters.companyForHost(location.hostname) || '';

        const job = { job_title: title, company_name: company, job_url: url, site_job_id: id, location: place, recruitment_batch: batch,
          jd_summary: clipJd(textOf(card.querySelector('.recruit-text'))), jd_status: 'missing', field_confidence: { job_title:'high', company_name: company?'high':'low', job_url:'high', site_job_id:'high', location: place?'medium':'low' },
          field_sources: { job_title:'list_card', company_name:companyNode?'list_card':'known_company_host', job_url:links.length?'list_link':identity?'list_dom_identifier':adapter.listIdentitySource||'visible_card_public_api', site_job_id:'url_identifier', location:'list_card' } };
        const event = buildEvent(job, 'job_discovered', { evidenceLevel:'strong', evidenceCode:'loaded-list-card' });
        const result = await sendEvent(event);
        if (result?.ok) { discoveredJobs.add(url); ids.push(event.client_event_id); }
      }
    } finally { listBusy = false; }
    return ids;
  }

  // ---------- sending ----------

  function sendEvent(event) {
    if (['job_viewed','form_started','application_submitted'].includes(event.event_type)) {
      const current=detectJob();
      if ((current && (current.job_title !== event.payload.job_title || current.site_job_id !== (event.payload.site_job_id || '') || current.job_url !== event.payload.job_url)) || (!current && event.event_type !== 'application_submitted') || Date.now()-lastDomChange<800) {
        detectAndTrackRoute(); return Promise.resolve({ok:false,skipped:'job_changed'});
      }
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'enqueue_event', event }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: 'NO_QUEUE_ACK' });
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
      jd_text: job.jd_text || undefined,
      jd_text_truncated: job.jd_text_truncated || undefined,
      jd_status: job.jd_status,
      template_version: job.template_version,
      template_fields: job.template_fields,
      location: job.location || undefined,
      recruitment_batch: job.recruitment_batch || undefined,
      field_confidence: job.field_confidence || undefined,
      field_sources: job.field_sources || undefined,
      channel: job.channel || adapter.channel
    };
  }

  function buildEvent(job, eventType, { evidenceLevel, evidenceCode, occurredAt, payload = {} }) {
    return {
      client_event_id: newEventId(),
      event_type: eventType,
      source_method: 'plugin',
      site_key: adapter.key,
      adapter_version: adapter.version+'+capture-4',
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

  let lastDomChange = Date.now();
  let previousRouteContent = null;
  const contentIdentity = job => job ? JSON.stringify([job.job_title, job.company_name, job.jd_text, job.location, job.field_sources?.site_job_id !== 'url_identifier' ? job.site_job_id : null]) : null;
  function resetJob(job = null) {
    pageState.job=job;pageState.detectedAt=job?Date.now():null;pageState.viewStartedAt=job?nowIso():null;
    pageState.visibleMs=0;pageState.viewSent=false;pageState.formSent=false;pageState.submitSent=false;pageState.statusSent=new Set();pageState.lastTickAt=Date.now();
    if(job){try{pageState.submitSent=!!sessionStorage.getItem('tounar:submitted:'+job.job_url);}catch{}rememberLastJob(job);}
  }
  function detectAndTrackRoute() {
    if(location.href!==pageState.href){
      previousRouteContent=contentIdentity(pageState.job);
      loadTemplate();pageState.href=location.href;pageState.routeKey=routeKey();lastDomChange=Date.now();
      resetJob();
      if(!/success|submitted|complete|finish/i.test(location.pathname))pageState.submitScanUntil=0;
    }
    if(Date.now()-lastDomChange<800)return null;
    const job=detectJob();
    // A route can change before the SPA replaces the previous job's content.
    if(previousRouteContent&&contentIdentity(job)===previousRouteContent)return null;
    if(job)previousRouteContent=null;
    if(!job){if(pageState.job)resetJob();return null;}
    if(!pageState.job||pageState.job.job_title!==job.job_title||pageState.job.site_job_id!==job.site_job_id){resetJob(job);probe();}
    else pageState.job=job;
    return pageState.job;
  }
  const observer=new MutationObserver(records=>{
    if(records.some(r=>{const target=r.target.nodeType===1?r.target:r.target.parentElement;return target&&!target.closest('script,style,header,nav,footer,aside');}))lastDomChange=Date.now();
  });
  observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});

  function tickDwell() {
    const now = Date.now();
    const wasVisible = pageState.lastVisible !== false;
    if (document.visibilityState === 'visible' && Date.now()-lastDomChange>=800 && !previousRouteContent && pageState.job && !pageState.viewSent) {
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
        })).then(result => { if (!result?.ok && pageState.job?.site_job_id === job.site_job_id && pageState.job?.job_url === job.job_url) pageState.viewSent = false; else if (result?.ok) auditTemplate(job); });
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
    if (Date.now() - lastDomChange < 800) return;
    if (!pageState.submitScanUntil || Date.now() > pageState.submitScanUntil) return;
    const marker = findSuccessMarker();
    if (!marker) return;
    const job = pageState.job || lastKnownJob();
    if (!job) return;
    pageState.submitSent = true;
    try { sessionStorage.setItem('tounar:submitted:'+job.job_url, '1'); } catch { /* ignore */ }
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
        company_name: adapter.company_name || firstText(adapter.selectors.company) || '',
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
      if (!pageState.job) host.removeAttribute('data-tounar-job-detected');
      if (pageState.job) host.setAttribute('data-tounar-job-detected', pageState.job.site_job_id || pageState.job.job_title || 'unknown');
      if (pageState.detectedAt) host.setAttribute('data-tounar-detected-at', String(pageState.detectedAt));
      host.setAttribute('data-tounar-visible-ms', String(Math.round(pageState.visibleMs)));
      host.setAttribute('data-tounar-view-sent', pageState.viewSent ? '1' : '0');
      host.setAttribute('data-tounar-form-sent', pageState.formSent ? '1' : '0');
      host.setAttribute('data-tounar-submit-sent', pageState.submitSent ? '1' : '0');
    } catch { /* ignore */ }
  }


  // ---------- 页面轻量反馈（Toast，Shadow DOM 隔离） ----------

  const toastState = { host: null, shadow: null, hideTimer: null, lastKey: '', lastAt: 0, pendingTimer: null };

  function ensureToast() {
    if (toastState.host && document.documentElement.contains(toastState.host)) return toastState;
    const host = document.createElement('div');
    host.setAttribute('data-tounar-toast', '1');
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:min(360px,calc(100vw - 32px));';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{all:initial}
      .box{font:13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:#0f172a;color:#f8fafc;border-radius:10px;box-shadow:0 8px 28px rgba(15,23,42,.28);padding:10px 12px;display:flex;gap:10px;align-items:flex-start;pointer-events:auto}
      .brand{font-weight:600;color:#5eead4;white-space:nowrap}
      .msg{flex:1;min-width:0;word-break:break-word}
      .actions{display:flex;gap:8px;align-items:center;margin-top:6px}
      button{all:unset;cursor:pointer;font-size:12px;color:#5eead4;text-decoration:underline;padding:2px 0}
      .close{color:#94a3b8;text-decoration:none;font-size:14px;line-height:1;padding:0 2px}
      @media (prefers-reduced-motion: reduce){.box{transition:none}}
    </style><div class="box" role="status" aria-live="polite" aria-atomic="true">
      <span class="brand">帮你理</span>
      <div class="msg"><span class="text"></span><div class="actions"><button class="open" hidden>查看台账</button></div></div>
      <button class="close" aria-label="关闭提示">×</button>
    </div>`;
    shadow.querySelector('.close').addEventListener('click', hideToast);
    document.documentElement.append(host);
    toastState.host = host; toastState.shadow = shadow;
    return toastState;
  }

  function hideToast() {
    if (toastState.hideTimer) clearTimeout(toastState.hideTimer);
    toastState.hideTimer = null;
    if (toastState.host) { toastState.host.remove(); toastState.host = null; toastState.shadow = null; }
  }

  function showToast(text, { action = null, ttl = 4000 } = {}) {
    const state = ensureToast();
    const box = state.shadow.querySelector('.box');
    state.shadow.querySelector('.text').textContent = text;
    const openBtn = state.shadow.querySelector('.open');
    if (action) {
      openBtn.hidden = false;
      openBtn.onclick = () => { try { window.open(action, '_blank', 'noopener'); } catch { /* ignore */ } };
    } else {
      openBtn.hidden = true; openBtn.onclick = null;
    }
    if (state.hideTimer) clearTimeout(state.hideTimer);
    state.hideTimer = ttl ? setTimeout(hideToast, ttl) : null;
    return box;
  }

  function feedbackText(feedback, kind) {
    const missing = Array.isArray(feedback.missing) && feedback.missing.length > 0;
    const tail = missing ? '，部分信息待补充' : '';
    switch (feedback.status) {
      case 'created':
        return `当前岗位已计入「看过没投」${tail}`;
      case 'updated':
        return '当前岗位信息已更新';
      case 'unchanged':
        return kind === 'job_captured' ? '该岗位已在台账中' : null;
      case 'review':
        return '当前岗位信息需要确认';
      case 'queued':
        return '当前岗位待同步，连接恢复后自动重试';
      case 'failed':
        return '尚未保存，请打开插件查看原因';
      case 'batch': {
        const parts = [];
        if (feedback.entered) parts.push(`${feedback.entered} 个岗位已保存`);
        if (feedback.review) parts.push(`${feedback.review} 个需要确认`);
        if (feedback.queued) parts.push(`${feedback.queued} 个待同步`);
        return `本页 ${parts.join('，') || '没有新的岗位'}`;
      }
      case 'saved':
      default:
        return '当前岗位已保存到台账';
    }
  }

  function showFeedback(feedback = {}) {
    const text = feedbackText(feedback, feedback.kind);
    if (!text) return;
    const key = `${feedback.status}|${feedback.applicationId || feedback.reviewId || ''}|${text}`;
    const now = Date.now();
    if (key === toastState.lastKey && now - toastState.lastAt < 5000) return; // 去重，避免重复刷屏
    toastState.lastKey = key; toastState.lastAt = now;
    const base = String(feedback.serverUrl || '').replace(/\/$/, '');
    let action = null;
    if (feedback.status === 'review' && base) action = `${base}/?panel=reviews`;
    else if (feedback.applicationId && base) action = `${base}/?app=${encodeURIComponent(feedback.applicationId)}`;
    else if (feedback.status === 'failed') action = base || null;
    const ttl = (feedback.status === 'review' || feedback.status === 'queued' || feedback.status === 'failed') ? 8000 : 4000;
    showToast(text, { action, ttl });
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === 'tounar_feedback') { showFeedback(msg.feedback || {}); sendResponse?.({ ok: true }); return false; }
      return false;
    });
  } catch { /* ignore */ }

  // ---------- 显式采集（用户点「采集当前页」，不要求停留时长） ----------

  async function captureNow(reason = 'user') {
    await loadTemplate();
    const job = detectJob();
    if (!job || !job.job_title) {
      const discovered = await captureList(true);
      if(discovered.length) {
        const results = [];
        for (const id of discovered) results.push(await chrome.runtime.sendMessage({type:'event_result',clientEventId:id}));
        return { ok:true, detected:true, status:'list_result', count:discovered.length, client_event_ids:discovered,
          counts:{entered:results.filter(r=>r?.status==='entered').length,review:results.filter(r=>r?.status==='review').length,queued:results.filter(r=>r?.status==='queued').length,rejected:results.filter(r=>r?.status==='rejected'||r?.status==='failed').length} };
      }
      return { ok: false, detected: false, status: 'no_job', reason: 'no_job' };
    }
    pageState.job = job;
    pageState.detectedAt = Date.now();
    const event = buildEvent(job, 'job_captured', {
      evidenceLevel: 'strong',
      evidenceCode: 'explicit_capture',
      payload: { capture_reason: reason, visible_dwell_ms: pageState.visibleMs }
    });
    if (toastState.pendingTimer) clearTimeout(toastState.pendingTimer);
    toastState.pendingTimer = setTimeout(() => {
      if (toastState.lastKey && Date.now() - toastState.lastAt < 1000) return;
      showToast('正在整理当前岗位…', { ttl: 12000 });
    }, 800);
    const queued = await sendEvent(event);
    if (toastState.pendingTimer) { clearTimeout(toastState.pendingTimer); toastState.pendingTimer = null; }
    if (!queued?.ok) {
      return { ok: false, detected: true, status: 'failed', error: queued?.error || 'ENQUEUE_FAILED', job: { job_title: job.job_title } };
    }
    // 入队 ≠ 入账：等一次 flush 拿到服务端对这条 event 的处理结果
    const result = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'event_result', clientEventId: event.client_event_id }, (response) => resolve(response || null));
      } catch { resolve(null); }
    });
    const status = result?.status || 'queued';
    if (status === 'queued' || status === 'failed') {
      showFeedback({ status, serverUrl: result?.serverUrl, kind: 'job_captured' });
    }
    pageState.viewSent = true;
    const learned = await auditTemplate(job);
    return {
      ok: status !== 'rejected' && status !== 'failed',
      detected: true,
      status,
      client_event_id: event.client_event_id,
      processing_state: result?.result?.processing_state || null,
      review_reason: result?.result?.review_reason || null,
      jd_status: job.jd_status,
      application_id: result?.result?.application_id || null,
      review_item_id: result?.result?.review_item_id || null,
      error: result?.result?.error || null,
      learned: learned ? learned.status : null,
      job: { job_title: job.job_title, company_name: job.company_name || '', jd_chars: (job.jd_text || '').length }
    };
  }

  // 供自动化验收调用（不产生副作用，只是暴露同一入口）
  globalThis.__tounarCapture = captureNow;

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === 'tounar_capture_now') {
        captureNow(msg.reason || 'user').then(sendResponse).catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
        return true;
      }
      if (msg?.type === 'tounar_ping') { sendResponse({ ok: true, tracker: true, url: location.href }); return false; }
      return false;
    });
  } catch { /* ignore */ }

  window.addEventListener('online', () => { try { chrome.runtime.sendMessage({type:'flush_now'}); } catch {} });
  if (chrome.storage?.onChanged) chrome.storage.onChanged.addListener((changes, area) => {
    if(area !== 'local') return;
    if(changes['tounar.learned.v1']) loadTemplate();
    if(changes['tounar.settings.v1']) {
      capturePaused = !!changes['tounar.settings.v1'].newValue?.capturePaused;
      if (capturePaused !== !!changes['tounar.settings.v1'].oldValue?.capturePaused) resetJob();
    }
  });

  // ---------- lifecycle ----------

  document.addEventListener('focusin', onUserInput, true);
  document.addEventListener('change', onUserInput, true);
  document.addEventListener('visibilitychange', () => { pageState.lastTickAt = Date.now(); });

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
    if (capturePaused) return;
    detectAndTrackRoute();
    tickDwell();
    if (!pageState.job && document.visibilityState === 'visible' && Date.now()-lastDomChange>=800) captureList().catch(() => {});
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
  learnedReady.then(() => { if (learnedTemplate) setTimeout(detectAndTrackRoute, 0); });
})();
