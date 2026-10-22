/* Popup（classic）。所有状态来自 service worker + chrome.storage。 */
const $ = (id) => document.getElementById(id);
let pollTimer = null;

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
  const status = await send({ type: 'get_status' });
  if (!status.ok) return;
  const s = status.settings;
  $('server-url').value = s.serverUrl || '';
  $('health').textContent = status.health?.ok
    ? `后台可达 · ${new Date().toLocaleTimeString('zh-CN')}`
    : `后台不可达${status.health?.error ? `（${status.health.error}）` : ''}`;
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

async function ensureContentScript(origins) {
  // 先按已授权来源全量重建注册，避免重复 id 与陈旧 matches。
  const all = await chrome.permissions.getAll();
  const patterns = (all.origins || []).filter((o) => o !== '*://*/*');
  try { await chrome.scripting.unregisterContentScripts({ ids: (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id) }); } catch { /* ignore */ }
  if (!patterns.length) return;
  try {
    await chrome.scripting.registerContentScripts([{
      id: 'tounar-tracker',
      matches: patterns,
      js: ['content/adapters.js', 'content/tracker.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true
    }]);
  } catch (err) {
    $('sites-status').textContent = `脚本注册失败：${err.message || err}`;
  }
}

$('save-server').addEventListener('click', async () => {
  const url = $('server-url').value.trim();
  if (!/^https?:\/\//.test(url)) { alert('请输入以 http(s):// 开头的后台地址'); return; }
  await send({ type: 'set_server_url', serverUrl: url });
  await refresh();
});

$('start-pairing').addEventListener('click', async () => {
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
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tabs[0]?.url;
  if (!url || !/^https?:/.test(url)) { $('sites-status').textContent = '当前标签页不是 http(s) 页面'; return; }
  const origin = `${new URL(url).origin}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  $('sites-status').textContent = granted ? `已授权 ${origin}` : '未授权（用户取消）';
  await ensureContentScript();
  await refresh();
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
  const origins = (all.origins || []).filter((o) => o !== '*://*/*');
  if (origins.length) await chrome.permissions.remove({ origins });
  await chrome.scripting.unregisterContentScripts().catch(() => {});
  $('sites-status').textContent = '已撤销全部站点授权';
  await refresh();
});

refresh();
setInterval(refresh, 5000);
