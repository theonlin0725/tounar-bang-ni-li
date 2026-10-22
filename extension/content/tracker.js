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
      url.hash = '';
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
      }
      return url.searchParams.get('jobId') || url.searchParams.get('positionId') || url.searchParams.get('id') || '';
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
    return `${match[1]} 校招`;
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
  const APPLY_SIGNAL = /^(投递|立即投递|投递简历|申请|立即申请|申请职位|申请岗位|我要申请|网申|报名|立即报名|apply|apply now|apply for|sign up)/i;
  function findApplySignal() {
    let nodes;
    try { nodes = document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]'); } catch { return false; }
    const limit = Math.min(nodes.length, 400);
    for (let i = 0; i < limit; i += 1) {
      const el = nodes[i];
      const text = (el.tagName === 'INPUT' ? el.value : textOf(el)) || '';
      if (text && text.length <= 15 && APPLY_SIGNAL.test(text.trim())) return true;
      const hint = `${el.id || ''} ${el.className || ''}`;
      if (/apply|deliver|toudi/i.test(hint) && text && text.length <= 15) return true;
    }
    return false;
  }

  function titleFromPage(adapterSelectors) {
    const fromSelectors = firstText(adapterSelectors);
    if (fromSelectors) return fromSelectors;
    const og = metaContent(['og:title', 'twitter:title']);
    if (og) return cleanPageTitle(og);
    return cleanPageTitle(document.title);
  }

  function hostAsCompany() {
    const host = String(location.hostname || '').replace(/^www\./, '');
    const main = host.split('.')[0] || '';
    return main ? main.charAt(0).toUpperCase() + main.slice(1) : '';
  }

  /* D12 兜底链：页面结构化数据 → meta → 正文最长段落。
     只为提高自动采集命中率，不读取表单内容、不上传正文。 */
  function longestTextBlock() {
    const roots = [document.querySelector('main'), document.querySelector('article'), document.getElementById('content'), document.body].filter(Boolean);
    let best = '';
    for (const root of roots) {
      let nodes;
      try { nodes = root.querySelectorAll('p, li, section, div'); } catch { continue; }
      for (const node of nodes) {
        const text = textOf(node);
        if (text.length > best.length && text.length > 40) best = text;
        if (best.length > 400) break;
      }
      if (best.length > 200) break;
    }
    return best;
  }

  /* 站点专属精修：把页面上「一整行」的信息拆成结构化字段。
     只读取可见文本，不读取表单内容、不上传正文。 */
  function applyAdapterRefine(job) {
    if (typeof adapter.refine !== 'function') return job;
    try {
      const refined = adapter.refine(job);
      if (refined && typeof refined === 'object') return refined;
    } catch { /* 精修失败不影响主链路 */ }
    return job;
  }

  // 公司名清洗：「图拉斯招聘」「XX校园招聘」→「图拉斯」
  function cleanCompanyName(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    const m = t.match(/^(.{2,30}?)(招聘|校园招聘|校招|人才招聘|社会招聘|官网|求职)$/);
    return (m ? m[1] : t).trim();
  }

  function fillJobFallbacks(job) {
    if (typeof adapter.refine === 'function') applyAdapterRefine(job);
    if (!job.company_name) {
      job.company_name = cleanCompanyName(
        firstText(adapter.selectors.company)
          || metaContent(['og:site_name', 'application-name', 'twitter:site'])
      ) || Adapters.companyForHost(location.hostname)
        || companyFromTitleSuffix()
        || hostAsCompany();
    }
    if (!job.jd_summary) {
      job.jd_summary = clipJd(metaContent(['description', 'og:description', 'twitter:description']) || longestTextBlock());
    }
    if (!job.location) job.location = firstText(adapter.selectors.location) || '';
    if (!job.recruitment_batch) job.recruitment_batch = batchFromText(`${job.job_title || ''} ${document.title || ''}`);
    return job;
  }

  function detectJob() {
    const hook = document.querySelector('[data-tounar-job-id]');
    if (hook) {
      const jobUrl = hook.getAttribute('data-tounar-job-url') || canonicalUrl(location.href);
      const job = {
        company_name: hook.getAttribute('data-tounar-company') || '',
        job_title: hook.getAttribute('data-tounar-job-title') || firstText(adapter.selectors.title),
        site_job_id: hook.getAttribute('data-tounar-job-id') || '',
        job_url: canonicalUrl(jobUrl),
        jd_summary: clipJd(hook.getAttribute('data-tounar-jd') || ''),
        location: hook.getAttribute('data-tounar-location') || '',
        recruitment_batch: hook.getAttribute('data-tounar-batch') || '',
        channel: adapter.channel
      };
      if (job.job_title) return fillJobFallbacks(job);
    }

    const ld = readJobPostingJsonLd();
    if (ld && !ld.multiple) {
      const title = String(ld.title || '').trim();
      if (title) {
        const jobUrl = canonicalUrl(ld.url || location.href);
        return fillJobFallbacks({
          company_name: String(ld.hiringOrganization?.name || '').trim(),
          job_title: title.length > 120 ? title.slice(0, 120) : title,
          site_job_id: identifierValue(ld) || idFromUrl(jobUrl || ''),
          job_url: jobUrl,
          jd_summary: clipJd(ld.description || ''),
          location: locationText(ld),
          recruitment_batch: batchFromText(`${title} ${ld.description || ''}`),
          channel: adapter.channel
        });
      }
    }

    const urlLooksDetail = (adapter.jobUrlPatterns || []).some((p) => p.test(location.href));
    const urlLooksList = (adapter.listUrlPatterns || []).some((p) => p.test(location.href))
      || (adapter !== Adapters.GENERIC && (Adapters.GENERIC.listUrlPatterns || []).some((p) => p.test(location.href)));
    if (urlLooksDetail && !urlLooksList) {
      const title = firstText(adapter.selectors.title);
      if (title) {
        const jd = firstText(adapter.selectors.jd);
        return fillJobFallbacks({
          company_name: firstText(adapter.selectors.company),
          job_title: title,
          site_job_id: idFromUrl(location.href),
          job_url: canonicalUrl(location.href),
          jd_summary: clipJd(jd),
          location: firstText(adapter.selectors.location),
          recruitment_batch: batchFromText(title),
          channel: adapter.channel
        });
      }
    }

    /* 通用兜底（2026-10-22）：站点适配器没命中时，对**所有**已授权站点启用。
       判据 = 页面上存在「投递/申请」按钮信号 且 不在列表页 —— 能投的页面才是岗位页，
       这条规则把所有已授权站点（含用户随手授权的新站点）纳入无感采集。
       标题走 适配器选择器 → h1 → og:title → document.title（去站点后缀）。
       只读取可见文本与 meta，不读取表单内容、不上传正文。 */
    const genericList = (Adapters.GENERIC.listUrlPatterns || []).some((p) => p.test(location.href));
    if (!genericList && findApplySignal()) {
      const title = titleFromPage(adapter.selectors.title);
      if (title && title.length >= 2) {
        return fillJobFallbacks({
          company_name: firstText(adapter.selectors.company),
          job_title: title,
          site_job_id: idFromUrl(location.href),
          job_url: canonicalUrl(location.href),
          jd_summary: clipJd(firstText(adapter.selectors.jd)),
          location: firstText(adapter.selectors.location),
          recruitment_batch: batchFromText(title),
          channel: adapter.channel
        });
      }
    }
    return null;
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
      channel: job.channel || adapter.channel
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
    }
    if (!pageState.job) {
      const job = detectJob();
      if (job) {
        pageState.job = job;
        pageState.detectedAt = Date.now();
        pageState.viewStartedAt = new Date().toISOString();
        rememberLastJob(job);
        probe();
      }
    }
    return pageState.job;
  }

  function tickDwell() {
    const now = Date.now();
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
