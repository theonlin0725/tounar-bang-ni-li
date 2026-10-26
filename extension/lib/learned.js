/* Versioned, route-scoped selector templates. Validate a replay before promotion. */
(function () {
  const KEY = 'tounar.learned.v1';
  const normalized = value => String(value || '').replace(/\s+/g, ' ').trim();
  function routeShape(pathname) {
    return String(pathname || '/').split('/').map(seg => /^\d+$/.test(seg) ? ':num' : /^[\da-f-]{8,}$/i.test(seg) ? ':id' : seg).join('/');
  }
  function keyFor(origin, pathname) { return `${origin}${routeShape(pathname)}`; }
  function routeKey(url) {
    const route = /^#!?\//.test(url.hash) ? new URL(url.hash.replace(/^#!/, '#').slice(1), url.origin) : url;
    const keys = [...new Set([...route.searchParams.keys()].filter(k => !/^(utm_|from|source|ref|token|auth)/i.test(k)))].sort();
    return keyFor(url.origin, (route === url ? '' : '/#') + route.pathname) + (keys.length ? '?' + keys.join('&') : '');
  }
  async function all() { return (await chrome.storage.local.get(KEY))[KEY] || {}; }
  async function save(map) {
    await chrome.storage.local.set({ [KEY]: Object.fromEntries(Object.entries(map).sort((a,b) => String(b[1].lastOkAt).localeCompare(String(a[1].lastOkAt))).slice(0,200)) });
  }
  function cssPath(el) {
    const parts = [];
    for (let node = el; node && node !== document.body && parts.length < 8; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) { parts.unshift(part+'#'+node.id); break; }
      const classes = [...node.classList].filter(c => /^[A-Za-z][\w-]*$/.test(c)).slice(0,2);
      if(classes.length) part += '.'+classes.join('.');
      const same = [...(node.parentElement?.children || [])].filter(n => n.tagName === node.tagName);
      if(same.length > 1) part += `:nth-of-type(${same.indexOf(node)+1})`;
      parts.unshift(part);
    }
    const selector = parts.join(' > ');
    try { return document.querySelectorAll(selector).length === 1 ? selector : null; } catch { return null; }
  }
  function locate(value) {
    const target = normalized(value);
    if (target.length < 2) return null;
    const matches = [...document.querySelectorAll('body *')].filter(n => n.getClientRects().length && !n.closest('form,nav,footer') && normalized(n.innerText) === target);
    return matches.length ? cssPath(matches.at(-1)) : null;
  }
  async function getTemplate(url) {
    const key = routeKey(url), map = await all();
    return { key, template: map[key] || null };
  }
  function extractWith(template) {
    if (!template?.selectors) return null;
    const out = {};
    for (const [field, selector] of Object.entries(template.selectors)) {
      if(!selector) continue;
      try {
        const nodes = document.querySelectorAll(selector);
        if(nodes.length !== 1 || !nodes[0].getClientRects().length) continue;
        out[field] = field === 'jd' ? String(nodes[0].innerText || '').trim() : normalized(nodes[0].innerText);
      } catch { /* broken selectors are a failed replay */ }
    }
    return out;
  }
  function validateHit(template, picked, job) {
    const expected = { title:job?.job_title, company:job?.company_name, jd:job?.jd_text };
    const fields = Object.keys(template?.selectors || {}).filter(k => template.selectors[k]);
    const ok = fields.includes('title') && fields.includes('jd') && fields.every(k => picked?.[k] && normalized(picked[k]) === normalized(expected[k]));
    return { ok, fields: fields.filter(k => picked?.[k] && normalized(picked[k]) === normalized(expected[k])) };
  }
  async function recordHit(url, job, audit) {
    if(!audit?.ok) return null;
    const key = routeKey(url), map = await all(), prev = map[key];
    if(!prev || prev.status === 'suspect') return null;
    const identity = job.site_job_id || job.job_url;
    if(prev.lastJobId === identity) return prev;
    map[key] = { ...prev, status:'stable', lastJobId:identity, successes:(prev.successes||0)+1, lastOkAt:new Date().toISOString(), lastReplayFields:audit.fields };
    await save(map); return map[key];
  }
  async function learnFromJob(job, url) {
    if(!job?.job_title || !job.jd_text) return null;
    const selectors = { title:locate(job.job_title), company:locate(job.company_name), jd:locate(job.jd_text) };
    if(!selectors.title || !selectors.jd) return null;
    const key=routeKey(url), map=await all(), prev=map[key];
    if(prev && prev.status !== 'suspect') return prev;
    const now=new Date().toISOString();
    map[key]={ id:key, origin:url.origin, pathPattern:key.slice(url.origin.length), selectors,
      version:(prev?.version||0)+1, status:'trial', successes:1, failures:prev?.failures||0,
      sampleJobId:job.site_job_id||job.job_url, lastJobId:job.site_job_id||job.job_url, createdAt:now, lastOkAt:now };
    await save(map);return map[key];
  }
  async function markFailure(url) {
    const key=routeKey(url), map=await all(), prev=map[key];
    if(!prev) return null;
    map[key]={...prev,status:'suspect',failures:(prev.failures||0)+1,lastFailAt:new Date().toISOString()};
    await save(map);return map[key];
  }
  async function list(){ return Object.values(await all()).sort((a,b)=>String(b.lastOkAt).localeCompare(String(a.lastOkAt))); }
  async function remove(key){ const map=await all();delete map[key];await save(map); }
  async function clear(){ await chrome.storage.local.remove(KEY); }
  globalThis.TounarLearned={KEY,routeShape,keyFor,routeKey,getTemplate,extractWith,validateHit,learnFromJob,recordHit,markFailure,list,remove,clear};
})();
