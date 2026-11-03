import { h, clear, openModal } from '../util.js';
import { api, errorText } from '../api.js';
import { pluginDownloadLink } from './plugin-help.js';
import { App } from '../app.js?v=20261102-1';

export function extensionRequest(action, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => { window.removeEventListener('message', receive); reject(new Error('尚未检测到可用插件。请在 Chrome 中安装或更新插件后刷新此页，无需先打开插件栏。')); }, 4000);
    function receive(event) {
      if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'tounar-access-response' || event.data.id !== id) return;
      clearTimeout(timeout); window.removeEventListener('message', receive);
      if (event.data.ok) resolve(event.data.data); else reject(new Error(event.data.error || '插件操作失败'));
    }
    window.addEventListener('message', receive);
    window.postMessage({channel:'tounar-access-request', id, action, payload}, location.origin);
  });
}

function dismissKey() { return 'tounar.plugin.onboarding.' + (App.user?.email || ''); }
function dismissal() { try {return sessionStorage.getItem(dismissKey());} catch {return null;} }
function dismissForVisit(reason = 'connection') {try {sessionStorage.setItem(dismissKey(), reason);} catch { /* storage unavailable */ } }

export async function promptPluginConnection({automatic = false} = {}) {
  const gen = App.gen;
  if (automatic && dismissal() === 'connection') return;
  let info;
  try {
    info = await extensionRequest('discovery');
    if (gen !== App.gen || !App.loggedIn) return;
    if (info.paired) {
      const me = await api.get('/api/v1/me');
      if (gen !== App.gen) return;
      if (me.data.plugin_devices?.some(d => d.id === info.deviceId && !d.server_revoked_at)) return;
    }
  } catch (error) {
    if (gen !== App.gen || !App.loggedIn || automatic && (dismissal() || document.querySelector('[role="dialog"]'))) return;
    const body = h('div', {},
      h('p', {text:'尚未检测到可用插件。安装或更新后，回到此页即可连接，不用打开插件栏。'}),
      h('p', {class:'tn-small tn-muted', text:'请使用安装了插件的 Chrome 窗口；浏览器尚未允许插件访问此页时，也可能暂时检测不到。'}));
    let modal;
    body.append(h('div', {class:'tn-action-row'},
      pluginDownloadLink({class:'tn-btn tn-btn-primary', label:'下载新版插件（0.2.5）'}),
      h('button', {class:'tn-btn', text:'已安装，重新检测', onclick:() => {modal.close(); promptPluginConnection();}}),
      h('button', {class:'tn-btn', text:'暂不连接', onclick:() => modal.close()})));
    modal = openModal({title:'连接帮你理插件', body, testid:'plugin-install-modal', onClose:() => dismissForVisit('missing')});
    return;
  }
  if (gen !== App.gen || automatic && document.querySelector('[role="dialog"]')) return;
  return confirmPluginConnection({webFirst:true, existingBinding:info.existingBinding, onDismiss:dismissForVisit});
}

export async function confirmPluginConnection({webFirst = false, existingBinding = false, onDismiss} = {}) {
  const gen = App.gen;
  const body = h('div', {}, h('p', {text:'正在读取插件连接请求…'}));
  let request, approved = false, busy = false, closed = false;
  const modal = openModal({title:'允许此插件连接你的账号？', body, testid:'plugin-connect-modal', onClose:() => {
    closed = true;
    if (!approved) onDismiss?.();
    if (request && !approved && !busy) extensionRequest('cancel', {pairing_id:request.pairing_id}).catch(() => {});
  }});
  try {
    request = webFirst ? null : await extensionRequest('pairing');
    if (closed || gen !== App.gen) return;
    const message = h('p', {role:'status'});
    const confirm = h('button', {class:'tn-btn tn-btn-primary', text:'确认连接', 'data-test':'plugin-connect-confirm', onclick:async () => {
      if (busy || gen !== App.gen) return;
      busy = true; confirm.disabled = true; cancel.disabled = true;
      try {
        if (webFirst) request = await extensionRequest('begin');
        const current = await extensionRequest('pairing');
        if (current.pairing_id !== request.pairing_id) throw new Error('连接请求已更新，请从插件重新打开确认窗口');
        await api.post('/api/v1/plugin-pairings/approve', {pairing_id:request.pairing_id, code:request.code});
        approved = true;
        const result = await extensionRequest('exchange', {pairing_id:request.pairing_id});
        if (!result.paired) throw new Error('网页已确认，插件尚未完成连接，请在插件检查状态');
        if (gen !== App.gen || closed) return;
        try {sessionStorage.removeItem(dismissKey());} catch {}
        if (webFirst) { modal.close(); openSiteManager({onboarding:true}); return; }
        clear(body);
        body.append(h('p', {text:'连接成功！接下来选择允许采集的招聘网站。'}), h('button', {class:'tn-btn tn-btn-primary', text:'去授权招聘网站', onclick:() => {modal.close(); openSiteManager();}}));
      } catch (error) { message.textContent = errorText(error); }
      finally {busy=false; confirm.disabled=approved; cancel.disabled=false;}
    }});
    const cancel = h('button', {class:'tn-btn', text:webFirst ? '暂不连接' : '取消', onclick:() => modal.close()});
    clear(body);
    body.append(...[h('p', {text:`当前账号：${App.user?.email || ''}`}), h('p', {text:`设备：${request?.device_name || '当前浏览器插件'}`}), h('p', {text:'连接后，插件采集的岗位和投递线索将同步到此账号。'}), request ? h('p', {class:'tn-small tn-muted', text:`请求有效期至 ${new Date(request.expires_at).toLocaleTimeString('zh-CN')}`}) : null, existingBinding ? h('p', {class:'tn-small', text:'插件已有其他连接。确认后将连接到当前账号和网页，已有台账保留。'}) : null, message, h('div', {class:'tn-action-row'}, cancel, confirm)].filter(Boolean));
  } catch (error) { if (!closed && gen === App.gen) { clear(body); body.append(h('p', {text:errorText(error)})); } }
}

export function openSiteManager({onboarding = false} = {}) {
  const card = createSiteAccessCard({manager:!onboarding});
  return openModal({title:'招聘网站授权', subtitle:'管理当前浏览器的采集权限', body:card.element, stacked:true, testid:'site-access-modal', onClose:card.dispose});
}

export function createSiteAccessCard({manager = false} = {}) {
  const element = h('section', {class:'tn-pref-group', 'data-test':'site-access-card'});
  const gen = App.gen;
  let permissionDialog = null, permissionBusy = false;
  let disposed = false, timer, data, signature = '', selected = null, expanded = false, query = '', tab = manager ? 'granted' : 'add';
  const revokeSelection = new Set();
  const summary = h('p', {class:'tn-small', text:'正在读取授权范围…', 'data-test':'site-access-summary'});
  const content = h('div');
  const message = h('p', {class:'tn-small tn-muted', role:'status'});
  element.append(h('h4', {text:'招聘网站授权'}), h('p', {class:'tn-small tn-muted', text:'仅在你授权的招聘网站采集岗位与投递线索。'}), summary, content, message);
  function dispose() {disposed=true; clearTimeout(timer); permissionDialog?.close();}
  async function remember() {
    try {await extensionRequest('preferences', {selection:[...selected]});}
    catch (err) {if (!disposed) message.textContent=errorText(err);}
  }
  async function act(operation, origins) {
    if (permissionBusy || disposed) return;
    permissionBusy=true;
    try {
      if (!origins.length) throw new Error(operation === 'grant' ? '请先选择要授权的网站' : '请先选择要撤销的网站');
      const capability = await extensionRequest('discovery');
      if (!capability.inlinePermissions) throw new Error('请将插件更新到 0.2.5 并刷新网页，即可在当前页面确认授权。');
      const prepared = await extensionRequest('permissions', {operation, origins:[...new Set(origins)]});
      if (disposed || gen !== App.gen) {await extensionRequest('cancel-permission', {id:prepared.id});return;}
      const url = new URL(prepared.frameUrl);
      if (url.protocol !== 'chrome-extension:' || url.pathname !== '/popup/permissions.html' || url.hash !== '#'+prepared.id) throw new Error('插件返回了无效的确认界面');
      const origin = 'chrome-extension://'+url.host;
      const focusBefore = document.activeElement;
      const loading = h('p', {class:'tn-small tn-muted', text:'正在准备授权确认…'});
      const frame = h('iframe', {src:url.href, title:'网站授权确认', 'data-test':'permission-frame', style:{width:'100%',height:'250px',border:'0',display:'block'}});
      let readyTimer, finished=false;
      const cancelRequest=() => extensionRequest('cancel-permission',{id:prepared.id}).catch(()=>{});
      const receive=event => {
        if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.channel !== 'tounar-permission-frame' || event.data.id !== prepared.id) return;
        if (event.data.type === 'ready') {clearTimeout(readyTimer);loading.remove();}
        if (event.data.type === 'height' && Number.isFinite(event.data.height)) frame.style.height=Math.min(390,Math.max(180,event.data.height))+'px';
        if (event.data.type === 'complete') {finished=true;permissionDialog?.close();message.textContent=operation === 'grant' ? '授权完成，正在更新网站状态。' : '已撤销所选网站授权，已有台账保留。';}
        if (event.data.type === 'cancel') permissionDialog?.close();
      };
      const escape=event => {if(event.key === 'Escape') {event.preventDefault();event.stopImmediatePropagation();permissionDialog?.close();}};
      window.addEventListener('message',receive);
      document.addEventListener('keydown',escape,true);
      permissionDialog=openModal({
        title:operation === 'grant' ? '允许采集这些招聘网站？' : '撤销这些网站的授权？',
        body:h('div',{},loading,frame), narrow:true, stacked:true, testid:'permission-confirm-modal',
        onClose:() => {
          clearTimeout(readyTimer);window.removeEventListener('message',receive);document.removeEventListener('keydown',escape,true);
          cancelRequest();permissionDialog=null;permissionBusy=false;
          if (!finished) message.textContent='';
          if (focusBefore?.isConnected) focusBefore.focus();
        }
      });
      const layer=permissionDialog.body.closest('.tn-modal-layer');
      layer.style.alignItems='center';
      layer.style.padding='16px';
      readyTimer=setTimeout(()=>{loading.textContent='确认界面尚未就绪，请确认插件已更新并允许访问此页，或关闭后重试。';},5000);
      message.textContent='';
    } catch (error) {message.textContent=errorText(error);}
    finally {if (!permissionDialog) permissionBusy=false;}
  }
  function render() {
    if (!data) return;
    clear(content);
    const granted = data.groups.filter(g => g.granted.length);
    summary.textContent=`已授权 ${granted.length} 个网站`;
    if (manager) {
      const tabs=h('div', {class:'tn-action-row'});
      for (const [id,label] of [['granted','已授权'],['add','添加网站']]) tabs.append(h('button', {class:`tn-btn${tab === id ? ' tn-btn-primary' : ''}`, text:label, onclick:() => {tab=id;query='';render();}}));
      content.append(tabs);
    }
    const list = h('div', {style:{maxHeight:'300px', overflowY:'auto', marginTop:'12px'}, 'data-test':'site-access-list'});
    const search=h('input', {class:'tn-input', placeholder:'搜索公司或域名', value:query, 'aria-label':'搜索公司或域名', oninput:e => {query=e.target.value; renderList();}});
    if (manager || expanded) content.append(search);
    content.append(list);
    const count=h('span', {class:'tn-small'});
    const grantButton=h('button', {class:'tn-btn tn-btn-primary', text:'授权选中网站', 'data-test':'site-access-grant', onclick:() => act('grant',[...selected].filter(p => data.groups.some(g => g.domains.some(d => 'https://'+d.host+'/*' === p && !d.granted))))});
    function selectionCount() {
      const countValue=data.groups.filter(g => g.domains.some(d => !d.granted && selected.has('https://'+d.host+'/*'))).length;
      count.textContent=`已选 ${countValue} 个网站`; grantButton.disabled=!countValue;
    }
    function renderList() {
      clear(list);
      let groups = data.groups;
      if (tab === 'granted') groups=granted;
      if (!manager && !expanded) groups=granted.length ? [granted.find(g => g.id === 'bytedance') || granted[0]] : groups.filter(g => g.id === 'bytedance');
      groups=groups.filter(g => `${g.label} ${g.hosts.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
      if (!groups.length) list.append(h('p', {class:'tn-small tn-muted', text:query ? '未找到匹配的网站。可在招聘页面通过插件授权当前网站。' : '尚未授权网站，切换到「添加网站」开始授权。'}));
      for (const group of groups) {
        const row=h('div', {style:{padding:'12px 0', borderBottom:'1px solid var(--tn-border, #e5e7eb)'}});
        const missing=group.domains.filter(d => !d.granted).map(d => 'https://'+d.host+'/*');
        const check=h('input', {type:'checkbox', 'aria-label':group.label});
        check.checked=tab === 'granted' ? revokeSelection.has(group.id) : missing.length ? missing.every(p => selected.has(p)) : true;
        check.indeterminate=tab !== 'granted' && missing.some(p => selected.has(p)) && !check.checked;
        check.disabled=tab !== 'granted' && !missing.length;
        check.addEventListener('change', () => {
          if (tab === 'granted') {if(check.checked) revokeSelection.add(group.id); else revokeSelection.delete(group.id);}
          else {for(const p of missing) {if(check.checked) selected.add(p); else selected.delete(p);} remember(); renderList();selectionCount();}
        });
        const state=group.granted.length ? (group.domains.every(d => d.granted) ? '已授权' : '部分域名已授权') : '待授权';
        row.append(h('label', {class:'tn-check', style:{margin:'0'}}, check, h('strong', {text:group.label}), h('span', {class:'tn-small tn-muted', text:state})));
        const details=h('details', {style:{marginLeft:'24px', marginTop:'6px'}}, h('summary', {class:'tn-small tn-muted', style:{cursor:'pointer'}, text:'查看域名'}));
        for (const domain of group.domains) {
          const origin='https://'+domain.host+'/*';
          const domainCheck=h('input', {type:'checkbox', 'aria-label':domain.host});
          domainCheck.checked=domain.granted || selected.has(origin); domainCheck.disabled=domain.granted || tab === 'granted';
          domainCheck.addEventListener('change', () => {if(domainCheck.checked) selected.add(origin); else selected.delete(origin); remember();check.checked=missing.every(p => selected.has(p));check.indeterminate=missing.some(p => selected.has(p))&&!check.checked; selectionCount();});
          const domainRow=h('div', {class:'tn-action-row'}, h('label', {class:'tn-check'}, domainCheck, domain.host));
          if (domain.granted && manager) domainRow.append(h('button', {class:'tn-btn tn-btn-sm', text:'撤销', onclick:() => act('revoke',domain.origins || group.granted)}));
          details.append(domainRow);
        }
        row.append(details);
        if (tab === 'granted') row.append(h('button', {class:'tn-btn tn-btn-sm', text:'撤销此网站', onclick:() => act('revoke',group.granted)}));
        list.append(row);
      }
    }
    renderList(); selectionCount();
    if (!manager) content.append(h('button', {class:'tn-btn tn-btn-sm', text:expanded ? '收起更多 ▴' : '展开更多招聘网站 ▾', style:{marginTop:'10px'}, onclick:() => {expanded=!expanded; query=''; render();}}));
    const actions=h('div', {class:'tn-action-row', style:{marginTop:'12px'}});
    if (tab === 'add') actions.append(count, grantButton);
    else actions.append(h('button', {class:'tn-btn', text:'撤销选中网站', onclick:() => act('revoke',granted.filter(g => revokeSelection.has(g.id)).flatMap(g => g.granted))}), h('button', {class:'tn-btn tn-btn-danger', text:'全部撤销', onclick:() => act('revoke',granted.flatMap(g => g.granted))}));
    if (!manager) actions.append(h('button', {class:'tn-btn', text:'管理授权', onclick:openSiteManager}));
    content.append(actions);
  }
  async function refresh() {
    if (disposed || gen !== App.gen) {dispose();return;}
    try {
      const next=await extensionRequest('status');
      if (disposed || gen !== App.gen) return;
      if (selected === null) {
        selected=new Set(next.selection ?? (next.groups.some(g => g.granted.length) ? [] : next.groups.find(g => g.id === 'bytedance')?.hosts.map(h => 'https://'+h+'/*') || []));
        await remember();
      }
      const changed=JSON.stringify(next.groups);
      data=next;
      if (changed !== signature) {signature=changed; for(const group of data.groups) for(const domain of group.domains) if(domain.granted) selected.delete('https://'+domain.host+'/*'); await remember();render();}
    } catch (error) {if(!disposed) {summary.textContent='尚未读取到插件授权状态'; message.textContent=errorText(error);}}
    finally {if(!disposed) timer=setTimeout(refresh,2000);}
  }
  refresh();
  return {element,dispose};
}
