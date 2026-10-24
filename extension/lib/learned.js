/* 站点模板学习 v1（content script / popup 共用，classic）
 *
 * 目标：第一次在某个站点的某种页面结构上识别成功后，记住「怎么定位字段」，
 * 下次优先用本地规则；规则失效时降级回通用识别并标记疑似改版。
 *
 * 存的是 CSS 选择器（相对稳定的 tag/class 组合），不缓存任何岗位内容。
 * 状态：trial（单页成功）→ stable（跨岗位复用成功）→ suspect（选择器失效）。
 */
(function () {
  const KEY = 'tounar.learned.v1';
  const MAX_TEMPLATES = 200;

  function routeShape(pathname) {
    // /job/12345 → /job/:id；/position/abc → /position/:id
    return String(pathname || '/')
      .split('/')
      .map((seg) => (/^[0-9]+$/.test(seg) ? ':num' : /^[0-9a-f-]{8,}$/i.test(seg) ? ':id' : seg))
      .join('/');
  }

  function keyFor(origin, pathname) {
    return `${origin}${routeShape(pathname)}`;
  }

  async function all() {
    const stored = await chrome.storage.local.get(KEY);
    return stored[KEY] || {};
  }

  async function save(map) {
    const entries = Object.entries(map).sort((a, b) => String(b[1].lastOkAt || '').localeCompare(String(a[1].lastOkAt || ''))).slice(0, MAX_TEMPLATES);
    await chrome.storage.local.set({ [KEY]: Object.fromEntries(entries) });
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6 && node !== document.body) {
      let sel = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(`${sel}#${node.id}`);
        break;
      }
      const cls = [...node.classList].filter((c) => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) sel += `.${cls.join('.')}`;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    const selector = parts.join(' > ');
    try {
      const hits = document.querySelectorAll(selector);
      return hits.length === 1 ? selector : null;
    } catch {
      return null;
    }
  }

  function textOf(el) {
    return String(el?.innerText || '').replace(/\s+/g, ' ').trim();
  }

  /* 在页面里找到「文本等于/以之开头」的最深节点，用来把字段值反查成选择器。 */
  function locate(field, value, fullText) {
    const target = String(value || '').slice(0, 60);
    if (target.length < 2) return null;
    let best = null;
    let bestLen = Infinity;
    for (const el of document.querySelectorAll('body *')) {
      if (!el.getClientRects().length) continue;
      const text = fullText ? textOf(el) : textOf(el);
      if (!text) continue;
      if (fullText ? !text.startsWith(String(value).slice(0, 40)) : text !== target) continue;
      if (text.length < bestLen) { bestLen = text.length; best = el; }
    }
    if (!best) return null;
    return cssPath(best);
  }

  function match(url) {
    const key = keyFor(url.origin, url.pathname);
    return { key, template: null };
  }

  async function getTemplate(url) {
    const map = await all();
    const key = keyFor(url.origin, url.pathname);
    return { key, template: map[key] || null };
  }

  function extractWith(template) {
    if (!template?.selectors) return null;
    const out = {};
    for (const field of ['title', 'company', 'jd']) {
      const selector = template.selectors[field];
      if (!selector) continue;
      let node = null;
      try { node = document.querySelector(selector); } catch { node = null; }
      if (!node || !node.getClientRects().length) continue;
      const text = field === 'jd'
        ? String(node.innerText || '').replace(/\r\n/g, '\n').trim()
        : textOf(node);
      if (text) out[field] = text;
    }
    return Object.keys(out).length ? out : null;
  }

  /* 模板命中后的成功记账：只有「换了一个岗位 ID 仍命中」才升级为 stable。
   * 不能因为重新生成了选择器就标记稳定。 */
  async function recordHit(url, job) {
    const key = keyFor(url.origin, url.pathname);
    const map = await all();
    const prev = map[key];
    if (!prev) return null;
    const jobId = String(job?.site_job_id || job?.job_url || '');
    const differentJob = !!(prev.lastJobId && jobId && prev.lastJobId !== jobId);
    const now = new Date().toISOString();
    map[key] = {
      ...prev,
      successes: (prev.successes || 0) + 1,
      lastJobId: jobId || prev.lastJobId,
      lastOkAt: now,
      status: differentJob ? 'stable' : (prev.status === 'suspect' ? 'trial' : prev.status || 'trial')
    };
    await save(map);
    return map[key];
  }

  async function learnFromJob(job, url) {
    if (!job?.job_title) return null;
    const selectors = {
      title: locate('title', job.job_title, false),
      company: job.company_name ? locate('company', job.company_name, false) : null,
      jd: job.jd_text ? locate('jd', job.jd_text, true) : null
    };
    if (!selectors.title) return null;
    const key = keyFor(url.origin, url.pathname);
    const map = await all();
    const prev = map[key];
    const now = new Date().toISOString();
    if (prev) {
      // 已有模板：不重新生成选择器、不在这里改稳定状态（稳定只能由 recordHit 在跨岗位命中后决定）
      return prev;
    } else {
      map[key] = {
        id: key,
        origin: url.origin,
        pathPattern: routeShape(url.pathname),
        selectors,
        status: 'trial',
        successes: 1,
        failures: 0,
        sampleJobId: job.site_job_id || job.job_url,
        lastJobId: job.site_job_id || job.job_url,
        createdAt: now,
        lastOkAt: now
      };
    }
    await save(map);
    return map[key];
  }

  async function markFailure(url) {
    const key = keyFor(url.origin, url.pathname);
    const map = await all();
    const prev = map[key];
    if (!prev) return null;
    map[key] = { ...prev, failures: (prev.failures || 0) + 1, status: 'suspect', lastFailAt: new Date().toISOString() };
    await save(map);
    return map[key];
  }

  async function list() {
    const map = await all();
    return Object.values(map).sort((a, b) => String(b.lastOkAt || '').localeCompare(String(a.lastOkAt || '')));
  }

  async function remove(key) {
    const map = await all();
    delete map[key];
    await save(map);
  }

  async function clear() {
    await chrome.storage.local.remove(KEY);
  }

  globalThis.TounarLearned = { KEY, routeShape, keyFor, getTemplate, extractWith, learnFromJob, recordHit, markFailure, list, remove, clear };
})();
