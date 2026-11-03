/* Only registered on the configured backend; the worker also checks the exact origin. */
(() => {
  if (globalThis.__tounarAccessBridge) return;
  globalThis.__tounarAccessBridge = true;
  const actions = new Set(['discovery', 'begin', 'status', 'pairing', 'cancel', 'exchange', 'preferences', 'permissions', 'cancel-permission']);
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (msg?.channel !== 'tounar-access-request' || typeof msg.id !== 'string' || !actions.has(msg.action)) return;
    try {
      const response = await chrome.runtime.sendMessage({ type:'web_access', action:msg.action, payload:msg.payload });
      window.postMessage({channel:'tounar-access-response', id:msg.id, ...response}, location.origin);
    } catch {
      window.postMessage({channel:'tounar-access-response', id:msg.id, ok:false, error:'插件已更新，请刷新网页后重试'}, location.origin);
    }
  });
})();
