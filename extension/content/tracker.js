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
    lastProbeAt: 0
  };


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
      url.username = ''; url.password = '';
      url.pathname = url.pathname.replace(/;(?:jsessionid|phpsessid|sessionid|sid)=[^/;?#]*/gi, '');
      const drop = /^(utm_|spm|from|source|track|scm|share|ref|share_|weibo|gclid|fbclid|sid$|session|jsessionid$|phpsessid$|token$|access_token$|auth|code$|state$|email$|phone$)/i;
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
      const url = new URL(canonicalUrl(jobUrl) || jobUrl);
      const route = /^#!?\//.test(url.hash) ? new URL(url.hash.replace(/^#!/, '#').slice(1), url.origin) : url;
      const parts = route.pathname.split('/').filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const part = parts[i];
        if (/^\d{4,}$/.test(part) || /^[0-9a-f-]{8,}$/i.test(part)) return part;
      }
      return route.searchParams.get('jobId') || route.searchParams.get('positionId') || route.searchParams.get('postId') || route.searchParams.get('jobUnionId') || route.searchParams.get('id') || '';
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
  const APPLY_SIGNAL = /^(投递|投个简历|立即投递|投递简历|申请|立即申请|申请职位|申请岗位|我要申请|网申|报名|立即报名|apply|apply now|apply for|sign up)/i;
  function findApplySignal() {
    let nodes;
    try { nodes = document.querySelectorAll(['a', 'button', '[role="button"]', 'input[type="submit"]', 'input[type="button"]', ...(adapter.applySelectors || [])].join(',')); } catch { return false; }
    const limit = Math.min(nodes.length, 400);
    for (let i = 0; i < limit; i += 1) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const text = ((el.tagName === 'INPUT' ? el.value : textOf(el)) || '').replace(/\s+/g, '');
      if (text && text.length <= 15 && APPLY_SIGNAL.test(text.trim())) return true;
      const hint = `${el.id || ''} ${el.className || ''}`;
      if (/apply|deliver|toudi/i.test(hint) && text && text.length <= 15) return true;
    }
    return false;
  }

  function visible(node) {
    if (!node || node.closest('nav,footer,aside,[role="navigation"],[class*="recommend"],[class*="skeleton"],[aria-busy="true"],form,input:not([type="button"]):not([type="submit"]),textarea,select')) return false;
    if(node.closest('header')&&!node.closest('main,article'))return false;
    // A global region/login modal is not job content, even when its stylesheet
    // fails to load. Keep actual job-detail drawers eligible.
    const modal=node.closest('[role="dialog"],[class*="modal"],[class*="Modal"]');
    if(modal&&!modal.querySelector('[data-tounar-job-id],[class*="job-detail"],[class*="position-detail"]'))return false;
    const style=getComputedStyle(node);
    return style.display!=='none' && style.visibility!=='hidden' && node.getClientRects().length>0;
  }
  function validTitle(value) {
    const t=String(value||'').trim();
    return t.length>=2&&t.length<=60&&!/招聘|官网|首页|加载|loading|skeleton|职位推荐|热门岗位|职位列表|职位详情|岗位详情|岗位职责|工作职责|职位描述|岗位描述|任职要求|岗位要求|工作内容|job description|requirements/i.test(t);
  }
  function nodesFor(selectors) {
    const result=[];
    for(const selector of selectors||[])try{for(const node of document.querySelectorAll(selector))if(visible(node))result.push(node);}catch{}
    return [...new Set(result)];
  }
  function labelled(pattern) {
    const result=[];
    for(const node of nodesFor(['main dt','main label','main p','main li','article p','table td','table th','[class*="job-info"]','[class*="job-info"] span','[class*="job-meta"] span','[data-job-label]','[class*="location"]','[class*="batch"]'])) {
      const text=textOf(node);
      if(text.length>160)continue;
      const m=text.match(pattern);
      if(m?.[1])result.push(m[1].trim());
      else if(node.nextElementSibling&&visible(node.nextElementSibling)){const pair=(text.replace(/[:：]$/, '')+': '+textOf(node.nextElementSibling)).match(pattern);if(pair?.[1])result.push(pair[1].trim());}
    }
    return result.filter(t=>t&&t.length<=80);
  }
  function detectJob() {
    if(/\/chat\b|\/im\b|\/message\b/i.test(location.pathname))return null;
    const hook=document.querySelector('[data-tounar-job-id]');
    const ld=readJobPostingJsonLd();
    const posting=ld&&!ld.multiple?ld:null;
    if (ld?.multiple && !hook) return null;
    const list=(adapter.listUrlPatterns||[]).some(p=>p.test(location.href));
    if(!hook&&!posting&&(list||!findApplySignal()))return null;
    const verifiedAdapter=adapter.site_verified&&(!adapter.verifiedUrlPatterns||adapter.verifiedUrlPatterns.some(pattern=>pattern.test(location.href)));
    const candidates={};
    const add=(field,value,score,source)=>{
      const v=String(value||'').replace(/\s+/g,' ').trim();
      if(!v||/^(加载中[.…]*|loading[.…]*|--|…|待加载)$/i.test(v))return;
      // Font-obfuscated glyphs are not readable field values. Never upload
      // their private-use code points as a confident title/company/JD.
      if(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u.test(v))return;
      if(field==='job_title'&&!validTitle(v))return;
      if(field==='location'&&(v.length>40||/职位|职责|要求|公司介绍/.test(v)))return;
      if(field==='company_name'&&(v.length>60||/登录|注册|招聘平台|直聘|牛客|实习僧/.test(v)))return;
      (candidates[field]||=[]).push({value:field==='jd_summary'?clipJd(v):v,score,source});
    };
    if(hook)for(const [f,attr] of Object.entries({company_name:'company',job_title:'job-title',site_job_id:'job-id',jd_summary:'jd',location:'location',recruitment_batch:'batch'}))add(f,hook.getAttribute('data-tounar-'+attr),100,'explicit_hook');
    const aggregator=['boss','nowcoder','shixiseng'].includes(adapter.key);
    const fixed=Adapters.companyForHost(location.hostname);
    if(adapter.company_name&&!aggregator)add('company_name',adapter.company_name,98,'adapter_company');
    if(fixed&&!aggregator)add('company_name',fixed,91,'known_company_host');
    if(posting){
      add('job_title',posting.title,95,'json_ld');
      if(!aggregator)add('company_name',posting.hiringOrganization?.name,93,'json_ld');
      add('jd_summary',posting.description,95,'json_ld');add('site_job_id',identifierValue(posting),95,'json_ld');
      add('location',locationText(posting),95,'json_ld');add('recruitment_batch',batchFromText(posting.title||''),90,'json_ld');
    }
    const applyButtons=nodesFor(['button','a','[role="button"]','input[type="button"]','input[type="submit"]',...(adapter.applySelectors||[])]).filter(n=>{
      const label=n.tagName==='INPUT'?n.value:textOf(n);
      return APPLY_SIGNAL.test(label.replace(/\s+/g,''))&&label.length<=20;
    });
    const headingNodes=nodesFor(['h1','h2','h3','[role="heading"]',...(adapter.selectors.title||[])]).filter(n=>validTitle(textOf(n))&&(verifiedAdapter||/^H[1-3]$/.test(n.tagName)||n.getAttribute('role')==='heading'||Number.parseFloat(getComputedStyle(n).fontSize)>=20));
    const headings=headingNodes.filter(node=>!headingNodes.some(other=>other!==node&&node.contains(other)));
    function headingScore(node){
      const text=textOf(node);if(headings.filter(n=>textOf(n)===text&&!n.contains(node)&&!node.contains(n)).length>=1)return 0;
      const r=node.getBoundingClientRect();
      const distance=applyButtons.length?Math.min(...applyButtons.map(b=>{const a=b.getBoundingClientRect();return Math.abs(r.top-a.top)+Math.abs(r.left-a.left)*0.2;})):1000;
      return 82-Math.min(12,distance/100)+(node.tagName==='H1'?3:0);
    }
    for(const node of headings){const score=headingScore(node);if(score)add('job_title',textOf(node),score,'heading_near_apply');}
    const companyLabels=labelled(/(?:公司名称|公司名|雇主|Company)\s*[:：]\s*(.{2,50})/i);
    for(const node of [...document.querySelectorAll('main div,main span,main strong,article div,article span')].slice(0,200)){
      if(node.children.length||!visible(node)||!validTitle(textOf(node)))continue;
      const fontSize=Number.parseFloat(getComputedStyle(node).fontSize);
      if(fontSize<22||textOf(node)===fixed||companyLabels.includes(textOf(node)))continue;
      add('job_title',textOf(node),71+Math.min(fontSize,100)/100,'large_visible_text');
    }
    for(const node of nodesFor(adapter.selectors.title)){
      // A broad draft selector cannot outrank a scoped heading or structured posting.
      if(validTitle(textOf(node)))add('job_title',textOf(node),verifiedAdapter?88:65,'site_selector');
    }
    if(aggregator){for(const n of nodesFor(adapter.selectors.company))if(!n.querySelector('h1,h2,form')&&textOf(n).length<=60)add('company_name',textOf(n),85,'company_card');}
    else for(const n of nodesFor(adapter.selectors.company))add('company_name',textOf(n),verifiedAdapter?89:67,'site_selector');
    const jdHeading=/^(职位描述|岗位描述|岗位职责|工作职责|任职要求|岗位要求|职位要求|工作内容|Job Description|Responsibilities|Requirements)\s*[:：]?$/i;
    for(const n of nodesFor(['h2','h3','h4','strong','dt','[class*="title"]'])){
      if(!jdHeading.test(textOf(n)))continue;
      const chunks=[];let section=n,next=n.nextElementSibling;
      for(let i=0;!next&&i<3;i++){
        if(!section.parentElement||textOf(section.parentElement)!==textOf(n))break;
        section=section.parentElement;next=section.nextElementSibling;
      }
      for(let i=0;next&&i<5;i++,next=next.nextElementSibling){if(jdHeading.test(textOf(next)))break;if(!visible(next)||next.querySelector('form,input,textarea'))continue;chunks.push(textOf(next));}
      const text=chunks.join(' ');if(text.length>=10)add('jd_summary',text,86,'jd_heading_section');
    }
    if(verifiedAdapter)for(const n of nodesFor(adapter.selectors.jd))if(!n.querySelector('nav,aside,form,input,textarea'))add('jd_summary',textOf(n),88,'verified_site_selector');
    for(const value of labelled(/(?:工作地点|工作城市|城市|Location)\s*[:：]\s*([^，,;；\n]{1,40})/i))add('location',value,84,'label');
    for(const value of labelled(/(?:招聘类型|招聘批次|批次)\s*[:：]\s*(.{1,50})/i))add('recruitment_batch',batchFromText(value)||value,84,'label');
    for(const value of labelled(/(?:职位\s*ID|岗位编号|职位编号|Job\s*ID|Position\s*ID)\s*[:：]\s*([A-Za-z0-9_-]+)/i))add('site_job_id',value,84,'label');
    if(!aggregator)for(const value of labelled(/(?:公司名称|公司名|雇主|Company)\s*[:：]\s*(.{2,50})/i))add('company_name',value,80,'label');
    // Refinement is useful only for the adapter with recorded real-page evidence.
    if(verifiedAdapter&&typeof adapter.refine==='function'){
      const seed={site_job_id:identifierValue(posting)||idFromUrl(location.href)};
      try{const refined=adapter.refine(seed)||seed;for(const f of ['company_name','location','recruitment_batch','site_job_id'])add(f,refined[f],90,'verified_refine');}catch{}
    }
    add('site_job_id',idFromUrl(location.href),80,'url_identifier');
    add('job_title',cleanPageTitle(metaContent(['og:title','twitter:title'])),55,'meta');
    add('job_title',cleanPageTitle(document.title),40,'document_title');
    const job={job_url:canonicalUrl(hook?.getAttribute('data-tounar-job-url')||posting?.url||location.href),channel:adapter.channel,field_confidence:{job_url:'high'},field_sources:{job_url:'canonical_url'}};
    for(const field of ['company_name','job_title','site_job_id','jd_summary','location','recruitment_batch']){
      const best=(candidates[field]||[]).sort((a,b)=>b.score-a.score)[0];
      const confidence=!best||best.score<70?'low':best.score>=90?'high':'medium';
      job[field]=confidence==='low'?'':best.value;job.field_confidence[field]=confidence;job.field_sources[field]=best?.source||'unavailable';
    }
    // Ambiguous generic list-like pages must not manufacture a single job.
    if(!job.job_title)return null;
    return job;
  }

  // ---------- sending ----------

  function sendEvent(event) {
    if (['job_viewed','form_started','application_submitted'].includes(event.event_type)) {
      const current=detectJob();
      if ((current && current.job_title !== event.payload.job_title) || (!current && event.event_type !== 'application_submitted') || Date.now()-lastDomChange<800) {
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
      adapter_version: adapter.version+'+capture-2',
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
  let previousRouteTitle = null;
  function resetJob(job = null) {
    pageState.job=job;pageState.detectedAt=job?Date.now():null;pageState.viewStartedAt=job?nowIso():null;
    pageState.visibleMs=0;pageState.viewSent=false;pageState.formSent=false;pageState.submitSent=false;pageState.statusSent=new Set();pageState.lastTickAt=Date.now();
    if(job){try{pageState.submitSent=!!sessionStorage.getItem('tounar:submitted:'+job.job_url);}catch{}rememberLastJob(job);}
  }
  function detectAndTrackRoute() {
    if(location.href!==pageState.href){
      previousRouteTitle=pageState.job?.job_title||null;pageState.href=location.href;pageState.routeKey=routeKey();lastDomChange=Date.now();
      resetJob();
      if(!/success|submitted|complete|finish/i.test(location.pathname))pageState.submitScanUntil=0;
    }
    if(Date.now()-lastDomChange<800)return null;
    const job=detectJob();
    // Route changed while a SPA still shows the previous job: wait for the new title.
    if(previousRouteTitle&&job?.job_title===previousRouteTitle)return null;
    if(job)previousRouteTitle=null;
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
    if (document.visibilityState === 'visible' && Date.now()-lastDomChange>=800 && !previousRouteTitle && pageState.job && !pageState.viewSent) {
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
      if (pageState.job) host.setAttribute('data-tounar-job-detected', pageState.job.site_job_id || pageState.job.job_title || 'unknown');
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
