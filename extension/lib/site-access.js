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
  // Chrome match patterns cannot contain a port. Convert any URL/origin to the
  // host-level pattern used by permissions.contains/request and content scripts.
  function hostPattern(raw) {
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.hostname}/*`;
    } catch { return ''; }
  }
  // Static manifest content scripts (the app bridge) are injected without a
  // host_permissions entry, so permissions.contains() reports false for them.
  // Check the manifest matches before asking the user for a redundant grant.
  function staticCovered(host) {
    try {
      const scripts = globalThis.chrome?.runtime?.getManifest?.().content_scripts || [];
      return scripts.some(script => (script.matches || []).some(pattern => covers(pattern, host)));
    } catch { return false; }
  }
  function captureOrigins(origins, base) {
    const appHosts = ['127.0.0.1', 'localhost', 'bangnili.app.workbuddy.host'];
    return origins.filter(p => !isBackend(p, base) && !appHosts.some(host => covers(p, host)));
  }
  function groups(origins, base) {
    const usable = captureOrigins(origins, base);
    const registry = new Map(TounarAdapters.ADAPTERS.filter(adapter => adapter.hosts.length).map(adapter => [
      adapter.key, {id: adapter.key, label: adapter.label, hosts: [...adapter.hosts]}
    ]));
    for (const {id, company, entryUrl, socialUrl, adapterKey, linkedUrls} of TounarAdapters.RECRUITMENT_DIRECTORY) {
      const key = adapterKey || 'directory-' + id;
      const group = registry.get(key) || {id:key, label:company + '招聘', hosts:[]};
      group.entryUrl = entryUrl;
      group.socialUrl = socialUrl;
      group.campusFirst = entryUrl !== socialUrl || TounarAdapters.recruitmentTrack(entryUrl) === 'campus';
      const hosts = [entryUrl, ...linkedUrls].map(url => new URL(url).hostname);
      group.hosts = [...new Set([...group.hosts, ...hosts])];
      registry.set(key, group);
    }
    const list = [...registry.values()].map(group => ({
      ...group,
      granted: usable.filter(pattern => group.hosts.some(host => covers(pattern, host))),
      domains: group.hosts.map(host => {
        const granted = usable.filter(pattern => covers(pattern, host));
        return {host, granted:granted.length > 0, origins:granted};
      })
    }));
    for (const pattern of usable) {
      if (!list.some(g => g.granted.includes(pattern))) {
        const host = pattern.replace(/^.*?:\/\//, '').replace(/\/\*$/, '');
        list.push({ id: pattern, label: host, hosts: [host], granted: [pattern], domains: [{host, granted:true}] });
      }
    }
    return list.sort((a,b) => (b.id === 'bytedance') - (a.id === 'bytedance'));
  }
  globalThis.TounarSiteAccess = { covers, isBackend, hostPattern, staticCovered, groups, captureOrigins };
})();
