import { h, clear, openModal } from '../util.js';
import { api, errorText } from '../api.js';
import { PLUGIN_VERSION, pluginDownloadLink } from './plugin-help.js?v=20261125-1';
import { App } from '../app.js?v=20261125-1';

export function extensionRequest(action, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => { window.removeEventListener('message', receive); reject(new Error('尚未检测到可用插件。请在 Chrome 中安装或更新插件后刷新此页，无需先打开插件栏。')); }, 6000);
    function receive(event) {
      if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'tounar-access-response' || event.data.id !== id) return;
      clearTimeout(timeout); window.removeEventListener('message', receive);
      if (event.data.ok) resolve(event.data.data); else reject(new Error(event.data.error || '插件操作失败'));
    }
    window.addEventListener('message', receive);
    window.postMessage({channel:'tounar-access-request', id, action, payload}, location.origin);
  });
}

/**
 * Manual pairing is the compatibility path for older plugins, restricted host
 * access, or a tab that was open before the extension was installed. It only
 * uses the logged-in web session and the 8-character code shown in the popup;
 * it never depends on the page bridge.
 */
function manualPairingFallback({testid = 'plugin-manual-fallback'} = {}) {
  const wrap = h('details', {class:'tn-small', style:{marginTop:'12px'}, 'data-test':testid});
  const input = h('input', {class:'tn-input', maxlength:'8', placeholder:'8 位配对码（A–Z / 2–9）',
    style:{maxWidth:'220px', textTransform:'uppercase'}, 'data-test':'pair-code', 'aria-label':'插件配对码'});
  const msg = h('p', {class:'tn-small', role:'status'});
  const button = h('button', {class:'tn-btn', type:'button', text:'确认绑定', 'data-test':'pair-approve', onclick:async()=>{
    const code = input.value.trim().toUpperCase();
    clear(msg);
    if (!/^[A-Z2-9]{8}$/.test(code)) { msg.append(h('span',{class:'tn-small', text:'配对码是 8 位，仅含 A–Z / 2–9（不含 0/1）。'})); return; }
    button.disabled = true; button.textContent = '绑定中…';
    try {
      const res = await api.post('/api/v1/plugin-pairings/approve', {code});
      msg.append(h('span',{class:'tn-small', text:`已绑定设备：${res.data?.device?.name || res.data?.device_name || '插件设备'}。回到插件检查状态即可。`}));
      input.value = '';
    } catch (error) {
      msg.append(h('span',{class:'tn-small', text:errorText(error)}));
    } finally {button.disabled = false; button.textContent = '确认绑定';}
  }});
  wrap.append(
    h('summary', {style:{cursor:'pointer'}, text:'自动检测不到？用手动配对码连接'}),
    h('p', {class:'tn-small tn-muted', text:'打开插件栏，点「连接帮你理账号」，把显示的 8 位配对码填在这里。这条路径不依赖网页自动检测。'}),
    h('div', {class:'tn-action-row'}, input, button),
    msg
  );
  return wrap;
}

function dismissKey() { return 'tounar.plugin.onboarding.' + (App.user?.email || ''); }
function dismissal() { try {return sessionStorage.getItem(dismissKey());} catch {return null;} }
function dismissForVisit(reason = 'connection') {try {sessionStorage.setItem(dismissKey(), reason);} catch { /* storage unavailable */ } }

export async function promptPluginConnection({automatic = false} = {}) {
  const gen = App.gen;
  // On the ledger the first-run guide owns plugin onboarding. Never stack the
  // legacy install/connect modal on top of the four-step card.
  if (automatic && document.querySelector('#tn-onboarding')) return;
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
      h('p', {text:'尚未检测到可用插件。先确认 Chrome 里已启用插件，再刷新本页；如果仍检测不到，可以用配对码手动连接。'}),
      h('p', {class:'tn-small tn-muted', text:'请使用安装了插件的 Chrome 窗口；浏览器尚未允许插件访问此页时，也可能暂时检测不到。'}));
    let modal;
    body.append(h('div', {class:'tn-action-row'},
      pluginDownloadLink({class:'tn-btn tn-btn-primary', label:`下载新版插件（${PLUGIN_VERSION}）`}),
      h('button', {class:'tn-btn', text:'已安装，刷新页面重新检测', onclick:() => {
        try {sessionStorage.removeItem(dismissKey());} catch {}
        location.reload();
      }}),
      h('button', {class:'tn-btn', text:'暂不连接', onclick:() => modal.close()})));
    body.append(manualPairingFallback());
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
        if (webFirst) { modal.close(); openSiteManager({onboarding:true, onClose: maybeProfileOnboarding}); return; }
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

export function openSiteManager({onboarding = false, onClose = null} = {}) {
  // 首次引导直接展开完整列表，用户打开即可全选或一键授权全部常见官网。
  const card = createSiteAccessCard({manager:!onboarding, expanded:onboarding});
  return openModal({title:'招聘网站授权', subtitle:'管理当前浏览器的采集权限', body:card.element, stacked:true, testid:'site-access-modal', onClose:() => { card.dispose(); onClose?.(); }});
}

async function maybeProfileOnboarding() {
  try {
    const response = await api.get('/api/v1/profile');
    if (response.data?.profile?.status === 'confirmed') return;
    if (!location.pathname.startsWith('/') || location.search.includes('panel=assistant')) return;
    // Open the half-screen assistant in place instead of switching main view.
    window.dispatchEvent(new CustomEvent('tounar:open-assistant', { detail: { onboarding: 'profile' } }));
  } catch { /* onboarding must never block normal navigation */ }
}

export function createSiteAccessCard({manager = false, expanded: initiallyExpanded = false} = {}) {
  const element = h('section', {class:'tn-pref-group', 'data-test':'site-access-card'});
  const gen = App.gen;
  let permissionDialog = null, permissionBusy = false;
  let disposed = false, timer, data, signature = '', selected = null;
  let expanded = Boolean(initiallyExpanded);
  let query = '', tab = manager ? 'granted' : 'add';
  let listScrollTop = 0;
  let refreshSeq = 0;
  const openDetails = new Set();
  const revokeSelection = new Set();
  const summary = h('p', {class:'tn-small', text:'正在读取授权范围…', 'data-test':'site-access-summary'});
  const content = h('div');
  const message = h('p', {class:'tn-small tn-muted', role:'status'});
  element.append(h('h4', {text:'招聘网站授权'}), h('p', {class:'tn-small tn-muted', text:'仅在你授权的网站采集；启用智能识别时，疑似单个岗位详情的可见正文会经帮你理后台发送给模型服务。'}), summary, content, message);
  function dispose() {disposed=true; clearTimeout(timer); permissionDialog?.close();}
  async function remember() {
    try {await extensionRequest('preferences', {selection:[...selected]});}
    catch (err) {if (!disposed) message.textContent=errorText(err);}
  }
  function captureOpenDetails() {
    for (const details of content.querySelectorAll('details[data-group-id]')) {
      if (details.open) openDetails.add(details.dataset.groupId);
      else openDetails.delete(details.dataset.groupId);
    }
  }
  function captureListState() {
    const currentList = content.querySelector('[data-test="site-access-list"]');
    if (currentList) listScrollTop = currentList.scrollTop;
    captureOpenDetails();
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
        if (event.data.type === 'complete') {
          finished=true;permissionDialog?.close();
          message.textContent=operation === 'grant' ? '授权完成，正在更新网站状态。' : '已撤销所选网站授权，已有台账保留。';
          // 插件写入 Chrome 权限可能比 complete 事件晚几十毫秒：先立即刷新，
          // 再补一次校验，避免用户还要等 2 秒轮询才看到已授权状态。
          clearTimeout(timer);
          refresh();
          setTimeout(() => {if (!disposed) refresh();}, 350);
        }
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
    captureListState();
    clear(content);
    const granted = data.groups.filter(g => g.granted.length);
    summary.textContent=`已授权 ${granted.length} 个网站`;
    if (manager) {
      const tabs=h('div', {class:'tn-action-row'});
      for (const [id,label] of [['granted','已授权'],['add','添加网站']]) tabs.append(h('button', {class:`tn-btn${tab === id ? ' tn-btn-primary' : ''}`, text:label, onclick:() => {tab=id;query='';render();}}));
      content.append(tabs);
    }
    const selectAll = h('input', {type:'checkbox', 'data-test':'site-access-select-all', 'aria-label':'全选当前列表'});
    const selectCount = h('span', {class:'tn-site-select-count', 'data-test':'site-access-select-count', text:'已选 0 个网站'});
    const clearSelection = h('button', {class:'tn-btn tn-btn-sm tn-btn-ghost', type:'button', 'data-test':'site-access-clear-selection', text:'清空选择'});
    const selectBar = h('div', {class:'tn-site-select-bar', 'data-test':'site-access-select-bar'},
      h('label', {class:'tn-site-select-all'}, selectAll, h('span', {text:'全选当前列表'})),
      selectCount,
      h('span', {class:'tn-grow'}),
      clearSelection);
    const list = h('div', {class:'tn-site-scroll', 'data-test':'site-access-list'});
    const search=h('input', {class:'tn-input', placeholder:'搜索公司或域名', value:query, 'aria-label':'搜索公司或域名', oninput:e => {query=e.target.value; renderList();}});
    if (manager || expanded) content.append(search);
    content.append(selectBar, list);
    const count=h('span', {class:'tn-small'});
    const grantButton=h('button', {class:'tn-btn', text:'授权选中网站', 'data-test':'site-access-grant', onclick:() => act('grant',[...selected].filter(p => missingOrigins().includes(p)))});
    const grantAllButton=h('button', {class:'tn-btn tn-btn-primary', type:'button', text:'一键授权全部', 'data-test':'site-access-grant-all', onclick:() => act('grant',missingOrigins())});
    const groupChecks = new Map();
    const domainChecks = new Map();
    let visibleGroups = [];
    let revokeSelectedButton = null;

    function missingOriginsFor(group) {
      return group.domains.filter(d => !d.granted).map(d => 'https://'+d.host+'/*');
    }
    function missingOrigins() {
      return [...new Set(data.groups.flatMap(group => missingOriginsFor(group)))];
    }
    function currentGroups() {
      if (tab === 'granted') return data.groups.filter(g => g.granted.length);
      if (!manager && !expanded) {
        const granted = data.groups.filter(g => g.granted.length);
        return granted.length ? [granted.find(g => g.id === 'bytedance') || granted[0]] : data.groups.filter(g => g.id === 'bytedance');
      }
      return data.groups;
    }
    function matchesQuery(group) {
      return `${group.label} ${group.hosts.join(' ')}`.toLowerCase().includes(query.toLowerCase());
    }
    function paintGroupRow(group, check, row) {
      if (tab === 'granted') {
        check.checked = revokeSelection.has(group.id);
        check.indeterminate = false;
        row.classList.toggle('is-selected', check.checked);
        return;
      }
      const missing = missingOriginsFor(group);
      if (!missing.length) {
        check.checked = true;
        check.indeterminate = false;
        row.classList.remove('is-selected');
        return;
      }
      const selectedCount = missing.filter(p => selected.has(p)).length;
      check.checked = selectedCount === missing.length;
      check.indeterminate = selectedCount > 0 && !check.checked;
      row.classList.toggle('is-selected', selectedCount > 0);
    }
    function syncSelectionUI() {
      if (!data) return;
      if (tab === 'granted') {
        const total = visibleGroups.length;
        const selectedCount = visibleGroups.filter(g => revokeSelection.has(g.id)).length;
        selectAll.checked = total > 0 && selectedCount === total;
        selectAll.indeterminate = selectedCount > 0 && selectedCount < total;
        selectAll.disabled = total === 0;
        selectCount.textContent = `已选 ${selectedCount} / ${total} 个已授权网站`;
        clearSelection.disabled = revokeSelection.size === 0;
        if (revokeSelectedButton) revokeSelectedButton.disabled = revokeSelection.size === 0;
      } else {
        const candidates = visibleGroups.flatMap(group => missingOriginsFor(group));
        const selectedCandidates = candidates.filter(p => selected.has(p));
        const totalSites = visibleGroups.filter(group => missingOriginsFor(group).length > 0).length;
        const selectedSites = visibleGroups.filter(group => missingOriginsFor(group).some(p => selected.has(p))).length;
        selectAll.checked = candidates.length > 0 && selectedCandidates.length === candidates.length;
        selectAll.indeterminate = selectedCandidates.length > 0 && !selectAll.checked;
        selectAll.disabled = candidates.length === 0;
        selectCount.textContent = `已选 ${selectedSites} / ${totalSites} 个待授权网站`;
        clearSelection.disabled = selected.size === 0;
      }
      const selectedSitesAll = data.groups.filter(group => missingOriginsFor(group).some(p => selected.has(p))).length;
      count.textContent = `已选 ${selectedSitesAll} 个网站`;
      grantButton.textContent = `授权选中网站（${selectedSitesAll}）`;
      grantButton.disabled = selectedSitesAll === 0;
      const totalMissing = missingOrigins().length;
      grantAllButton.hidden = tab !== 'add' || totalMissing === 0;
      grantAllButton.disabled = totalMissing === 0;
    }
    function renderList({restoreTop = null} = {}) {
      if (restoreTop === null) {
        if (list.isConnected) listScrollTop = list.scrollTop;
        captureOpenDetails();
      } else {
        listScrollTop = restoreTop;
      }
      clear(list);
      groupChecks.clear();
      domainChecks.clear();
      visibleGroups = currentGroups().filter(matchesQuery);
      if (!visibleGroups.length) {
        list.append(h('p', {class:'tn-small tn-muted', 'data-test':'site-access-empty', text:query ? '未找到匹配的网站。可在招聘页面通过插件授权当前网站。' : '尚未授权网站，切换到「添加网站」开始授权。'}));
      }
      for (const group of visibleGroups) {
        const missing = missingOriginsFor(group);
        const row = h('div', {class:'tn-site-row'});
        const check = h('input', {type:'checkbox', 'aria-label':group.label, 'data-test':`site-access-group-${group.id}`});
        groupChecks.set(group.id, check);
        check.disabled = tab !== 'granted' && !missing.length;
        check.addEventListener('change', () => {
          if (tab === 'granted') {
            if (check.checked) revokeSelection.add(group.id); else revokeSelection.delete(group.id);
            row.classList.toggle('is-selected', check.checked);
            syncSelectionUI();
            return;
          }
          for (const p of missing) {
            if (check.checked) selected.add(p); else selected.delete(p);
          }
          const inputs = domainChecks.get(group.id);
          if (inputs) for (const [origin, input] of inputs) if (missing.includes(origin)) input.checked = check.checked;
          row.classList.toggle('is-selected', check.checked);
          remember();
          syncSelectionUI();
        });
        const state = group.granted.length ? (group.domains.every(d => d.granted) ? '已授权' : '部分域名已授权') : '待授权';
        row.append(h('label', {class:'tn-check tn-site-row-label'}, check, h('strong', {text:group.label}), h('span', {class:`tn-small tn-muted tn-site-state${group.domains.every(d => d.granted) ? ' is-granted' : ''}`, text:state})));
        const details = h('details', {class:'tn-site-domains'}, h('summary', {class:'tn-small tn-muted', text:'查看域名'}));
        details.dataset.groupId = group.id;
        details.open = openDetails.has(group.id);
        details.addEventListener('toggle', () => {
          if (details.open) openDetails.add(group.id); else openDetails.delete(group.id);
        });
        if (group.entryUrl) {
          details.append(h('p', {class:'tn-small'}, h('a', {href:group.entryUrl, target:'_blank', rel:'noopener noreferrer', text:group.campusFirst ? '打开校招入口' : '打开招聘入口'})));
        }
        if (group.socialUrl && group.socialUrl !== group.entryUrl) {
          details.append(h('p', {class:'tn-small'}, h('a', {href:group.socialUrl, target:'_blank', rel:'noopener noreferrer', text:'打开社招入口'})));
        }
        const inputs = new Map();
        domainChecks.set(group.id, inputs);
        for (const domain of group.domains) {
          const origin='https://'+domain.host+'/*';
          const domainCheck = h('input', {type:'checkbox', 'aria-label':domain.host, 'data-test':`site-access-domain-${domain.host}`});
          inputs.set(origin, domainCheck);
          domainCheck.checked = domain.granted || selected.has(origin);
          domainCheck.disabled = domain.granted || tab === 'granted';
          domainCheck.addEventListener('change', () => {
            if (domainCheck.checked) selected.add(origin); else selected.delete(origin);
            const anySelected = missing.some(p => selected.has(p));
            row.classList.toggle('is-selected', anySelected);
            check.checked = missing.length > 0 && missing.every(p => selected.has(p));
            check.indeterminate = anySelected && !check.checked;
            remember();
            syncSelectionUI();
          });
          const domainRow = h('div', {class:'tn-action-row tn-site-domain-row'}, h('label', {class:'tn-check'}, domainCheck, domain.host));
          if (domain.granted && manager) domainRow.append(h('button', {class:'tn-btn tn-btn-sm', text:'撤销', onclick:() => act('revoke',domain.origins || group.granted)}));
          details.append(domainRow);
        }
        row.append(details);
        if (tab === 'granted') row.append(h('button', {class:'tn-btn tn-btn-sm', text:'撤销此网站', onclick:() => act('revoke',group.granted)}));
        paintGroupRow(group, check, row);
        list.append(row);
      }
      list.scrollTop = listScrollTop;
      requestAnimationFrame(() => {if (!disposed && list.isConnected) list.scrollTop = listScrollTop;});
      syncSelectionUI();
    }
    selectAll.addEventListener('change', () => {
      if (tab === 'granted') {
        for (const group of visibleGroups) {
          if (selectAll.checked) revokeSelection.add(group.id); else revokeSelection.delete(group.id);
          const check = groupChecks.get(group.id);
          const row = check?.closest('.tn-site-row');
          if (check && row) paintGroupRow(group, check, row);
        }
        syncSelectionUI();
        return;
      }
      for (const group of visibleGroups) {
        const missing = missingOriginsFor(group);
        for (const p of missing) {
          if (selectAll.checked) selected.add(p); else selected.delete(p);
        }
        const check = groupChecks.get(group.id);
        const row = check?.closest('.tn-site-row');
        const inputs = domainChecks.get(group.id);
        if (inputs) for (const [origin, input] of inputs) if (missing.includes(origin)) input.checked = selectAll.checked;
        if (check && row) paintGroupRow(group, check, row);
      }
      remember();
      syncSelectionUI();
    });
    clearSelection.addEventListener('click', () => {
      if (tab === 'granted') {
        revokeSelection.clear();
        for (const [id, check] of groupChecks) {
          const group = visibleGroups.find(item => item.id === id);
          const row = check.closest('.tn-site-row');
          if (group && row) paintGroupRow(group, check, row);
        }
        syncSelectionUI();
        return;
      }
      selected.clear();
      for (const [id, check] of groupChecks) {
        const group = visibleGroups.find(item => item.id === id);
        const row = check.closest('.tn-site-row');
        if (group && row) paintGroupRow(group, check, row);
        const inputs = domainChecks.get(id);
        if (inputs) for (const input of inputs.values()) if (!input.disabled) input.checked = false;
      }
      remember();
      syncSelectionUI();
    });
    renderList({restoreTop:listScrollTop});
    if (!manager) content.append(h('button', {class:'tn-btn tn-btn-sm', text:expanded ? '收起更多 ▴' : '展开更多招聘网站 ▾', style:{marginTop:'10px'}, onclick:() => {expanded=!expanded; query=''; render();}}));
    const actions=h('div', {class:'tn-action-row', style:{marginTop:'12px'}});
    if (tab === 'add') {
      actions.append(count, grantAllButton, grantButton);
    } else {
      revokeSelectedButton = h('button', {class:'tn-btn', text:'撤销选中网站', onclick:() => act('revoke',granted.filter(g => revokeSelection.has(g.id)).flatMap(g => g.granted))});
      actions.append(revokeSelectedButton, h('button', {class:'tn-btn tn-btn-danger', text:'全部撤销', onclick:() => act('revoke',granted.flatMap(g => g.granted))}));
    }
    if (!manager) actions.append(h('button', {class:'tn-btn', text:'管理授权', onclick:openSiteManager}));
    content.append(actions);
    syncSelectionUI();
  }
  async function refresh() {
    if (disposed || gen !== App.gen) {dispose();return;}
    const seq = ++refreshSeq;
    clearTimeout(timer);
    try {
      const next=await extensionRequest('status');
      if (seq !== refreshSeq || disposed || gen !== App.gen) return;
      if (selected === null) {
        selected=new Set(next.selection ?? (next.groups.some(g => g.granted.length) ? [] : next.groups.find(g => g.id === 'bytedance')?.hosts.map(h => 'https://'+h+'/*') || []));
        await remember();
      }
      const changed=JSON.stringify(next.groups);
      data=next;
      if (changed !== signature) {signature=changed; for(const group of data.groups) for(const domain of group.domains) if(domain.granted) selected.delete('https://'+domain.host+'/*'); await remember();render();}
    } catch (error) {if(!disposed) {summary.textContent='尚未读取到插件授权状态'; message.textContent=errorText(error);}}
    finally {if (seq === refreshSeq && !disposed) timer=setTimeout(refresh,2000);}
  }
  refresh();
  return {element,dispose};
}
