/* Shared website grouping. Counts companies, never the backend connection grant. */
(() => {
  function covers(pattern, host) {
    const match = pattern.match(/^(\*|https?):\/\/([^/]+)\/\*$/);
    if (!match) return false;
    const domain = match[2].split(':')[0];
    return domain === '*' || domain === host || (domain.startsWith('*.') && (host === domain.slice(2) || host.endsWith(domain.slice(1))));
  }
  function isBackend(pattern, base) {
    try { return covers(pattern, new URL(base).hostname); } catch { return false; }
  }
  function captureOrigins(origins, base) {
    const appHosts = ['127.0.0.1', 'localhost', 'bangnili.app.workbuddy.host'];
    return origins.filter(p => !isBackend(p, base) && !appHosts.some(host => covers(p, host)));
  }
  function groups(origins, base) {
    const usable = captureOrigins(origins, base);
    const list = TounarAdapters.ADAPTERS.filter(a => a.hosts.length).map(a => ({
      id: a.key, label: a.label, hosts: a.hosts,
      granted: usable.filter(p => a.hosts.some(host => covers(p, host))),
      domains: a.hosts.map(host => ({ host, granted: usable.some(p => covers(p, host)), origins:usable.filter(p => covers(p,host)) }))
    }));
    for (const pattern of usable) {
      if (!list.some(g => g.granted.includes(pattern))) {
        const host = pattern.replace(/^.*?:\/\//, '').replace(/\/\*$/, '');
        list.push({ id: pattern, label: host, hosts: [host], granted: [pattern], domains: [{host, granted:true}] });
      }
    }
    return list.sort((a,b) => (b.id === 'bytedance') - (a.id === 'bytedance'));
  }
  globalThis.TounarSiteAccess = { covers, isBackend, groups, captureOrigins };
})();
