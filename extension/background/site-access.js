/* Narrow web bridge: never expose device tokens or the pairing exchange secret. */
let appBridgeSync = Promise.resolve();
function syncAppBridge() {
  appBridgeSync = appBridgeSync.catch(() => {}).then(registerAppBridge);
  return appBridgeSync;
}
async function registerAppBridge() {
  const { serverUrl } = await getSettings();
  const registered = await chrome.scripting.getRegisteredContentScripts();
  if (registered.some(s => s.id === 'tounar-app-bridge')) await chrome.scripting.unregisterContentScripts({ ids:['tounar-app-bridge'] });
  const origin = new URL(serverUrl).origin;
  const matchPattern = TounarSiteAccess.hostPattern(serverUrl);
  // The manifest's static content script covers the app backend without a
  // host_permissions grant, so permissions.contains() is not a reliable gate
  // here. Try to register and inject; failures are non-fatal because the
  // static script still covers normal page loads.
  if (matchPattern) {
    try {
      await chrome.scripting.registerContentScripts([{id:'tounar-app-bridge', matches:[matchPattern], js:['content/app-bridge.js'], runAt:'document_start', persistAcrossSessions:true}]);
    } catch { /* static bridge remains available on the next page load */ }
  }
  for (const tab of await chrome.tabs.query({})) {
    if (tab.url && new URL(tab.url).origin === origin) {
      await chrome.scripting.executeScript({target:{tabId:tab.id}, files:['content/app-bridge.js']}).catch(() => {});
    }
  }
}
/**
 * Inject the page bridge into one already-open backend tab. This covers the
 * common "install the extension while the app tab is already open" case and
 * is idempotent because app-bridge.js checks a global guard.
 */
async function injectAppBridgeForTab(tabId, url) {
  try {
    const { serverUrl } = await getSettings();
    if (new URL(url).origin !== new URL(serverUrl).origin) return false;
    await chrome.scripting.executeScript({ target:{tabId}, files:['content/app-bridge.js'] });
    return true;
  } catch { return false; }
}
async function openAccessPage(panel) {
  await syncAppBridge();
  const {serverUrl} = await getSettings();
  const url = new URL(serverUrl);
  url.searchParams.set('panel', panel === 'plugin-connect' ? 'plugin-connect' : 'plugin-sites');
  await chrome.tabs.create({url:url.href});
}
async function webAccess(message, sender) {
  const settings = await getSettings();
  if (!sender.tab || sender.frameId !== 0) throw new Error('仅支持帮你理网页主窗口');
  const pageUrl = new URL(sender.url);
  const sameBackend = pageUrl.origin === new URL(settings.serverUrl).origin;
  // An unrelated local web server must not be able to replace the backend or
  // clear an existing pairing. Local review works after its exact URL is set.
  const bootstrap = ['https://bangnili.app.workbuddy.host', 'https://bangnili.theonlin.top'].includes(pageUrl.origin);
  if (!sameBackend && !(bootstrap && ['discovery','begin'].includes(message.action))) throw new Error('此页面不是插件当前连接的帮你理后台');
  const payload = message.payload || {};
  switch (message.action) {
    case 'discovery':
      return {webFirst:true, inlinePermissions:true, paired:sameBackend && !!settings.deviceToken, deviceId:sameBackend ? settings.deviceId : null, existingBinding:!!settings.deviceToken, backendMismatch:!sameBackend};
    case 'begin': {
      // Never move queued events to a different account or backend.
      if (await Queue.count()) throw new Error('插件还有未同步事件，请先同步或明确清空后再连接，避免混入其他账号。');
      if (sameBackend && settings.pendingPairing && Date.parse(settings.pendingPairing.expires_at) > Date.now()) {
        const p = settings.pendingPairing;
        return {pairing_id:p.pairing_id, code:p.code, device_name:p.device_name, expires_at:p.expires_at};
      }
      const target = new URL(pageUrl.origin);
      if (pageUrl.searchParams.has('sharecode')) target.searchParams.set('sharecode', pageUrl.searchParams.get('sharecode'));
      const p = await startPairing({serverUrl:target.href, deviceName:'Chrome · 网页连接'});
      return {pairing_id:p.pairing_id, code:p.code, device_name:p.device_name, expires_at:p.expires_at};
    }
    case 'status': {
      const all = await chrome.permissions.getAll();
      return { groups:TounarSiteAccess.groups(all.origins || [], settings.serverUrl), selection:settings.siteSelection ?? null, paired:!!settings.deviceToken };
    }
    case 'preferences': {
      if (!Array.isArray(payload.selection) || payload.selection.length > 200 || payload.selection.some(x => typeof x !== 'string' || x.length > 300)) throw new Error('网站选择无效');
      await setSettings({siteSelection:payload.selection}); return {};
    }
    case 'pairing': {
      const p = settings.pendingPairing;
      if (!p || Date.parse(p.expires_at) <= Date.now()) throw new Error('连接请求已取消或过期，请在插件中重新发起');
      return {pairing_id:p.pairing_id, code:p.code, device_name:p.device_name, expires_at:p.expires_at};
    }
    case 'cancel':
      if (payload.pairing_id !== settings.pendingPairing?.pairing_id) throw new Error('连接请求已更新');
      await setSettings({pendingPairing:null}); chrome.alarms.clear(PAIRING_ALARM); return {};
    case 'exchange': {
      if (settings.deviceToken && !settings.pendingPairing) return {paired:true};
      if (payload.pairing_id !== settings.pendingPairing?.pairing_id) throw new Error('连接请求已更新');
      return await pollPairing();
    }
    case 'cancel-permission': {
      const key = 'access-'+String(payload.id || '');
      const request = (await chrome.storage.session.get(key))[key];
      if (request && request.tabId === sender.tab.id && request.parentOrigin === pageUrl.origin) await chrome.storage.session.remove(key);
      return {};
    }
    case 'permissions': {
      const origins = [...new Set(payload.origins || [])];
      if (!['grant','revoke'].includes(payload.operation) || !origins.length || origins.length > 200) throw new Error('请选择网站');
      const all = await chrome.permissions.getAll();
      const groups = TounarSiteAccess.groups(all.origins || [], settings.serverUrl);
      const allowed = payload.operation === 'grant' ? groups.flatMap(g => g.hosts.map(h => 'https://'+h+'/*')) : groups.flatMap(g => g.granted);
      if (origins.some(p => !allowed.includes(p) || TounarSiteAccess.isBackend(p, settings.serverUrl))) throw new Error('授权范围无效');
      const id = crypto.randomUUID();
      const selectedGroups = groups.filter(g => g.hosts.some(host => origins.some(p => TounarSiteAccess.covers(p, host)))).map(g => g.label);
      await chrome.storage.session.set({['access-'+id]:{origins, labels:selectedGroups, operation:payload.operation, base:settings.serverUrl, tabId:sender.tab.id, parentOrigin:pageUrl.origin, expires:Date.now()+120000}});
      return {id, frameUrl:chrome.runtime.getURL('popup/permissions.html')+'#'+id};
    }
    default: throw new Error('不支持的操作');
  }
}

async function permissionContext(id, sender) {
  const url = new URL(sender.url || 'about:blank');
  if (url.href.split('#')[0] !== chrome.runtime.getURL('popup/permissions.html') || !sender.tab || !sender.frameId) throw new Error('请在帮你理网页中确认授权');
  const key = 'access-'+String(id || '');
  const request = (await chrome.storage.session.get(key))[key];
  const settings = await getSettings();
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!request || request.tabId !== sender.tab.id || new URL(tab.url).origin !== request.parentOrigin || request.expires <= Date.now() || request.base !== settings.serverUrl) throw new Error('请求已失效，请关闭后重新操作');
  return request;
}
