const id = location.hash.slice(1);
const key = 'access-'+id;
let request;
const confirmButton = document.getElementById('confirm');
const status = document.getElementById('status');
function notify(type, extra = {}) {
  if (request) parent.postMessage({channel:'tounar-permission-frame', id, type, ...extra}, request.parentOrigin);
}
function resize() { notify('height', {height:Math.ceil(document.body.getBoundingClientRect().height)}); }
(async () => {
  try {
    const response = await chrome.runtime.sendMessage({type:'permission_context', id});
    if (!response?.ok) throw new Error(response?.error || '无法读取授权请求');
    request = response.data;
    const revoke = request.operation === 'revoke';
    document.getElementById('summary').textContent = `${request.labels.join('、')} · ${request.origins.length} 个域名`;
    document.getElementById('description').textContent = revoke ? '撤销后停止采集所选网站，已有台账保留。' : '仅在所选网站识别岗位和投递线索。Chrome 如需进一步确认，将显示系统权限提示。';
    confirmButton.textContent = revoke ? '确认撤销' : '确认授权';
    for (const origin of request.origins) {const li=document.createElement('li');li.textContent=origin;document.getElementById('domains').append(li);}
    document.getElementById('details').hidden=false;
    confirmButton.disabled=false;
    new ResizeObserver(resize).observe(document.body);
    notify('ready'); resize();
    confirmButton.focus();
  } catch (error) { status.textContent=error.message; }
})();
confirmButton.addEventListener('click', async () => {
  if (!request || request.expires <= Date.now()) {status.textContent='请求已过期，请关闭后重新操作。'; confirmButton.disabled=true;return;}
  confirmButton.disabled=true;
  try {
    // The click takes place inside the extension-owned iframe, preserving Chrome's user gesture.
    const result = await chrome.permissions[request.operation === 'grant' ? 'request' : 'remove']({origins:request.origins});
    if (!result) {status.textContent='未获得授权，没有开启新增网站采集。可以重试或取消。';confirmButton.disabled=false;return;}
    await chrome.runtime.sendMessage({type:'sync_permissions'});
    await chrome.storage.session.remove(key);
    notify('complete');
  } catch (error) {status.textContent=error.message;confirmButton.disabled=false;}
});
document.getElementById('cancel').addEventListener('click', () => notify('cancel'));
document.addEventListener('keydown', event => {if(event.key === 'Escape') {event.preventDefault();notify('cancel');}});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[TounarCommon.KEY] && request && changes[TounarCommon.KEY].newValue?.serverUrl !== request.base) {
    request=null;confirmButton.disabled=true;status.textContent='后台已切换，请关闭后重新操作。';
  }
});
