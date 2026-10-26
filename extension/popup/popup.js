/* Popup（classic）。所有状态来自 service worker + chrome.storage。 */
const $ = (id) => document.getElementById(id);
let pollTimer = null;
let serverUrlEdited = false;
let refreshSequence = 0;
$('server-url').addEventListener('input', () => { serverUrlEdited = true; });

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: { code: 'SW_UNAVAILABLE', message: chrome.runtime.lastError.message } });
      else resolve(response || { ok: false });
    });
  });
}

function show(el, visible) {
  el.classList.toggle('hidden', !visible);
}

async function refresh() {
  const sequence = ++refreshSequence;
  const status = await send({ type: 'get_status' });
  if (!status.ok || sequence !== refreshSequence) return;
  const s = status.settings;
  // Background health/pairing refreshes must not overwrite an unsaved address.
  if (!serverUrlEdited) $('server-url').value = s.serverUrl || '';
  $('health').textContent = status.health?.ok
    ? `后台可达 · ${s.serverUrl || ''} · ${new Date().toLocaleTimeString('zh-CN')}`
    : `后台不可达：${status.health?.message || status.health?.error || '未知原因'}${s.serverUrl ? `（当前地址 ${s.serverUrl}）` : ''}`;
  $('health').className = status.health?.ok ? 'hint' : 'error';
  $('queue-count').textContent = String(status.queue ?? 0);
  if (s.lastError) {
    $('last-error').textContent = `最近错误：${s.lastError.message || s.lastError.code}`;
    show($('last-error'), true);
  } else {
    show($('last-error'), false);
  }

  const pending = s.pendingPairing;
  show($('paired'), !!s.paired);
  show($('unpaired'), !s.paired);
  if (s.paired) {
    $('owner-hint').textContent = s.pairedOwnerHint || '已绑定账号';
    $('device-id').textContent = s.deviceId || '—';
    $('binding-version').textContent = s.bindingVersion ?? '—';
    $('last-upload').textContent = s.lastUploadAt ? new Date(s.lastUploadAt).toLocaleString('zh-CN') : '尚无';
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  } else if (pending) {
    show($('pairing-box'), true);
    $('pairing-code').textContent = pending.code;
    $('pairing-expire').textContent = `有效期至 ${new Date(pending.expires_at).toLocaleTimeString('zh-CN')}；在网页确认后自动完成`;
    if (!pollTimer) {
      pollTimer = setInterval(async () => {
        const result = await send({ type: 'poll_pairing_now' });
        if (result?.result?.paired || result?.result?.expired || result?.result?.failed) refresh();
      }, 3000);
    }
  } else {
    show($('pairing-box'), false);
  }
  renderSites(status.grantedOrigins || []);
  $('toggle-pause').textContent = s.capturePaused ? '恢复采集' : '暂停采集';
  $('toggle-pause').dataset.paused = s.capturePaused ? '1' : '0';
  if(s.lastCapture) {
    if (s.lastCapture.client_event_ids?.length) {
      const receipts = s.lastCapture.client_event_ids.map(id=>s.lastEventResults?.[id]);
      s.lastCapture.counts = {
        entered:receipts.filter(r=>r?.application_id && r.processing_state==='applied').length,
        review:receipts.filter(r=>r?.review_item_id).length,
        rejected:receipts.filter(r=>r?.error && !r.error.retryable).length,
        queued:receipts.filter(r=>!r || r.error?.retryable).length
      };
    }
    const receipt = s.lastEventResults?.[s.lastCapture.client_event_id];
    const state = receipt?.processing_state === 'cancelled' ? 'cancelled' : receipt?.application_id && receipt.processing_state === 'applied' ? 'entered' : receipt?.review_item_id ? 'review' : receipt?.error && !receipt.error.retryable ? 'rejected' : s.lastCapture.status;
    showCapture({...s.lastCapture,status:state,result:receipt||s.lastCapture});
  }
}

function showCapture(status) {
  const el = $('capture-status');
  if (!el) return;
  if (!status) { el.textContent = '尚未采集'; return; }
  const title = status.job?.job_title ? `：${status.job.job_title}` : '';
  const map = {
    list_result: `列表发现 ${status.count || 0} 条：已入账 ${status.counts?.entered || 0}，待确认 ${status.counts?.review || 0}，待上传 ${status.counts?.queued || 0}，失败 ${status.counts?.rejected || 0}`,
    entered: `已自动入账（${status.elapsedMs}ms）${title}`,
    accepted: `服务端已接受，正在处理（${status.elapsedMs}ms）${title}`,
    unknown: `尚未确认保存，请查看插件状态（${status.elapsedMs}ms）${title}`,
    review: `待确认${title}（${status.result?.review_reason || status.review_reason || '关键字段或岗位身份需要核对'}）`,
    queued: `已入本地队列，等待上传（${status.elapsedMs}ms）${title}`,
    cancelled: '未上传事件已清空',
    rejected: `服务端拒绝：${status.result?.error?.message || '校验未通过'}`,
    failed: `采集失败：${status.message || status.result?.error?.message || '未知错误'}`,
    no_job: '当前页面没有识别到可靠的岗位详情或列表卡片',
    unauthorized: '该站点未授权，先点「将本站设为招聘网站并授权」',
    error: `采集失败：${status.message || '未知错误'}`
  };
  el.textContent = (map[status.status] || `状态：${status.status}`) + (status.count ? ` · ${status.count} 条列表发现` : '') + (status.jd_status === 'too_long' ? ' · JD 超出 100000 字上限，正文未保存' : '');
}

async function captureCurrentTab(reason) {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // popup 本身被当成标签页打开时（自动化测试就是这种情形），回退到最近打开的 http(s) 标签页
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    tab = tabs.filter((t) => /^https?:/.test(t.url || '')).sort((a, b) => (b.id || 0) - (a.id || 0))[0];
  }
  if (!tab?.url || !/^https?:/.test(tab.url)) { $('capture-status').textContent = '当前标签页不是网页'; return { ok: false, error: { message: '当前标签页不是网页' } }; }
  const origin = new URL(tab.url).origin;
  $('capture-status').textContent = '已授权，正在识别当前页…';
  const result = await send({ type: 'capture_current_tab', tabId: tab.id, origin, reason });
  if (result?.ok) {
    showCapture({ ...result.result, status: result.result?.status || result.status, elapsedMs: result.elapsedMs, job: result.result?.job, result: result.result });
  } else {
    showCapture({ status: 'error', message: result?.error?.message });
  }
  await refresh();
  return result;
}

async function renderLearned() {
  const list = await globalThis.TounarLearned?.list?.() || [];
  const container = $('learned-list');
  if (!container) return;
  container.textContent = '';
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '还没有学习记录：授权后浏览岗位，成功采集时会自动学习。';
    container.append(p);
    return;
  }
  for (const item of list.slice(0, 8)) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.className = 'hint';
    label.textContent = `${new URL(item.origin).host} ${item.pathPattern} · ${item.status} · 成功${item.successes || 0}/失败${item.failures || 0}`;
    const btn = document.createElement('button');
    btn.className = 'link';
    btn.textContent = '删除';
    btn.addEventListener('click', async () => { await globalThis.TounarLearned.remove(item.id); await renderLearned(); });
    row.append(label, btn);
    container.append(row);
  }
}

function renderSites(grantedOrigins) {
  const container = $('site-list');
  if (container.childElementCount === 0) {
    for (const host of TounarAdapters.supportedHosts()) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = `https://${host}/*`;
      checkbox.dataset.host = host;
      const adapter = TounarAdapters.ADAPTERS.find((a) => a.hosts.includes(host));
      label.append(checkbox, document.createTextNode(`${adapter?.label || host}（${host}）`));
      container.append(label);
    }
  }
  const granted = new Set(grantedOrigins.map((o) => o.replace(/\/\*$/, '').replace(/^https?:\/\//, '')));
  for (const checkbox of container.querySelectorAll('input[type="checkbox"]')) {
    const host = checkbox.dataset.host;
    const isGranted = [...granted].some((g) => g === host || g.endsWith(`.${host}`) || host.endsWith(`.${g}`));
    checkbox.checked = isGranted;
  }
}

async function ensureContentScript() {
  const result = await send({type:'sync_permissions'});
  if(!result.ok) throw new Error(result.error?.message || '脚本注册失败');
}

/* 本机服务探测：4311 是验收默认端口，4310 是历史默认端口。 */
const LOCAL_CANDIDATES = [4311, 4310];

async function authorizeBackend(raw) {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) throw new Error('后台地址必须以 http:// 或 https:// 开头');
    // Called directly from a click handler, before any asynchronous work, so
    // Chrome retains the user gesture required for optional permissions.
    const granted = await chrome.permissions.request({origins:[url.origin+'/*']});
    if (!granted) throw new Error('未获得后台连接权限，请再次点击并允许；后台地址未更改。');
    return true;
  } catch (error) {
    $('health').textContent=error.message || '后台地址格式不正确';
    $('health').className='error';
    return false;
  }
}

async function probeOne(port, timeoutMs = 1500) {
  const url = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/api/v1/health`, { signal: controller.signal, cache: 'no-store', credentials: 'omit' });
    if (!response.ok) return { url, ok: false, reason: `HTTP ${response.status}` };
    const body = await response.json().catch(() => null);
    if (body?.ok === true) return { url, ok: true, reason: '' };
    return { url, ok: false, reason: '返回内容不是帮你理后台' };
  } catch (err) {
    return { url, ok: false, reason: err?.name === 'AbortError' ? '超时无响应' : '连接被拒绝' };
  } finally {
    clearTimeout(timer);
  }
}

$('probe-local').addEventListener('click', async () => {
  if (!await authorizeBackend('http://127.0.0.1')) return;
  const button = $('probe-local');
  button.disabled = true;
  $('probe-result').textContent = '正在检测 127.0.0.1:4311 / 4310…';
  show($('probe-result'), true);
  const results = await Promise.all(LOCAL_CANDIDATES.map((port) => probeOne(port)));
  button.disabled = false;
  const usable = results.filter((r) => r.ok);
  const lines = results.map((r) => `${r.ok ? '✅' : '❌'} ${r.url}${r.ok ? '' : `（${r.reason}）`}`);
  if (!usable.length) {
    $('probe-result').textContent = `${lines.join('；')}。本次未连接成功；请核对后台是否运行，以及 Chrome 对本机网络的访问权限。`;
    return;
  }
  const target = usable[0];
  $('server-url').value = target.url;
  const saved = await send({ type: 'set_server_url', serverUrl: target.url });
  if (saved.ok) serverUrlEdited = false;
  $('probe-result').textContent = `${lines.join('；')}。已填入并保存 ${target.url}`;
  await refresh();
});

$('save-server').addEventListener('click', async () => {  const url = $('server-url').value.trim();
  if (!/^https?:\/\//.test(url)) { alert('请输入以 http(s):// 开头的后台地址'); return; }
  if (!await authorizeBackend(url)) return;
  const result = await send({ type: 'set_server_url', serverUrl: url });
  if (!result.ok) {
    $('health').textContent = result.error?.message || '后台地址保存失败，请重试';
    $('health').className = 'error';
    return;
  }
  if ($('server-url').value.trim() === url) serverUrlEdited = false;
  await refresh();
});

$('start-pairing').addEventListener('click', async () => {
  if (!await authorizeBackend($('server-url').value.trim())) return;
  const button = $('start-pairing');
  button.disabled = true;
  const result = await send({ type: 'start_pairing', serverUrl: $('server-url').value.trim(), deviceName: `Chrome · ${navigator.platform}` });
  button.disabled = false;
  if (!result.ok) {
    $('pair-error').textContent = result.error?.message || '配对发起失败';
    show($('pair-error'), true);
    return;
  }
  show($('pair-error'), false);
  await refresh();
});

$('poll-pairing').addEventListener('click', async () => {
  const result = await send({ type: 'poll_pairing_now' });
  if (result?.result?.waiting) $('pairing-expire').textContent = '尚未在网页确认；确认后会自动绑定';
  await refresh();
});

$('cancel-pairing').addEventListener('click', async () => {
  await send({ type: 'cancel_pairing' });
  await refresh();
});

$('flush-now').addEventListener('click', async () => {
  const result = await send({ type: 'flush_now' });
  $('last-upload').textContent = result.flushed != null ? `刚刚同步 ${result.flushed} 条` : '暂无新事件';
  await refresh();
});

$('heartbeat').addEventListener('click', async () => {
  await send({ type: 'heartbeat_now' });
  await refresh();
});

$('unpair').addEventListener('click', async () => {
  if (!confirm('解除本设备绑定？未上传事件将留在本地队列，直到你确认清理或重新配对。')) return;
  await send({ type: 'unpair', cleanup: false });
  await refresh();
});

$('grant-current').addEventListener('click', async () => {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/^https?:/.test(tab?.url || '')) tab = (await chrome.tabs.query({currentWindow:true})).filter(t => /^https?:/.test(t.url || '')).sort((a,b) => (b.lastAccessed||b.id)-(a.lastAccessed||a.id))[0];
  const url = tab?.url;
  if (!url || !/^https?:/.test(url)) { $('sites-status').textContent = '当前标签页不是 http(s) 页面'; return; }
  const origin = `${new URL(url).origin}/*`;
  const startedAt = Date.now();
  $('sites-status').textContent = '等待浏览器授权…';
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) { $('sites-status').textContent = '未授权（用户取消）'; return; }
  $('sites-status').textContent = `已授权 ${origin}（${Date.now() - startedAt}ms），正在识别当前页…`;
  await ensureContentScript();
  await captureCurrentTab('authorize');
  $('sites-status').textContent = `已授权 ${origin}`;
});

$('capture-now').addEventListener('click', async () => { await captureCurrentTab('manual'); });

async function loadPageFeedback() {
  const status = await send({ type: 'get_status' });
  if (status?.ok) $('page-feedback').checked = status.settings.pageFeedback !== false;
}
$('page-feedback').addEventListener('change', async () => {
  await send({ type: 'set_page_feedback', enabled: $('page-feedback').checked });
  $('capture-status').textContent = $('page-feedback').checked ? '已开启页面采集提示' : '已关闭页面采集提示（仍可在插件里查看状态）';
});

$('clear-learned').addEventListener('click', async () => {
  await globalThis.TounarLearned?.clear?.();
  await renderLearned();
  $('capture-status').textContent = '已清除学习记录，下次采集会重新学习';
});

$('grant-selected').addEventListener('click', async () => {
  const origins = [...document.querySelectorAll('#site-list input:checked')].map((c) => c.value);
  if (!origins.length) { $('sites-status').textContent = '请先勾选要授权的站点'; return; }
  const granted = await chrome.permissions.request({ origins });
  $('sites-status').textContent = granted ? `已授权 ${origins.length} 个站点` : '未授权（用户取消）';
  await ensureContentScript();
  await refresh();
});

$('revoke-all').addEventListener('click', async () => {
  const all = await chrome.permissions.getAll();
  const origins = all.origins || [];
  if (origins.length) await chrome.permissions.remove({ origins });
  await chrome.scripting.unregisterContentScripts().catch(() => {});
  $('sites-status').textContent = '已撤销全部站点授权';
  await refresh();
});

$('toggle-pause').addEventListener('click', async () => { await send({type:'set_capture_paused',paused:$('toggle-pause').dataset.paused !== '1'}); await refresh(); });
$('clear-queue').addEventListener('click', async () => { if(confirm('清空未上传事件？已入账记录和模板不受影响。')) { await send({type:'clear_queue'}); await refresh(); } });
refresh();
loadPageFeedback();
renderLearned();
setInterval(refresh, 5000);
