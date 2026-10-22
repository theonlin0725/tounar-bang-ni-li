/* Tounar 帮你理 · MV3 service worker（classic，importScripts 共享 lib） */
importScripts('../lib/common.js', '../lib/queue.js', '../lib/api.js');

const { getSettings, setSettings, clearPairing } = globalThis.TounarCommon;
const Queue = globalThis.TounarQueue;
const Api = globalThis.TounarApi;

const FLUSH_ALARM = 'tounar-flush';
const HEARTBEAT_ALARM = 'tounar-heartbeat';
const PAIRING_ALARM = 'tounar-pairing-poll';
const MAX_BATCH = 50;
const MAX_ATTEMPTS = 5;
let flushing = false;

async function updateBadge() {
  try {
    const count = await Queue.count();
    await chrome.action.setBadgeText({ text: count ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: count ? '#b45309' : '#00000000' });
  } catch { /* ignore */ }
}

async function flushQueue() {
  if (flushing) return { skipped: 'flush_in_progress' };
  flushing = true;
  try {
    const settings = await getSettings();
    if (!settings.deviceToken) {
      await updateBadge();
      return { skipped: 'not_paired', queued: await Queue.count() };
    }
    const pending = await Queue.list(MAX_BATCH);
    if (!pending.length) return { flushed: 0 };
    let response;
    try {
      response = await Api.uploadEvents(settings.serverUrl, settings.deviceToken, pending.map(stripLocalFields));
    } catch (err) {
      await setSettings({ lastError: { code: err.code || 'UPLOAD_FAILED', message: err.message, at: new Date().toISOString() } });
      if (err.status === 401 || err.status === 403) {
        await setSettings({ lastError: { code: 'DEVICE_REVOKED_OR_INVALID', message: '设备凭证被服务端拒绝；如已撤销请在网页确认后解除本设备', at: new Date().toISOString() } });
      }
      await updateBadge();
      return { failed: pending.length, error: err.code || 'UPLOAD_FAILED' };
    }
    const acceptedIds = [];
    const dropped = [];
    for (const item of response.results || []) {
      const local = pending.find((p) => p.client_event_id === item.client_event_id);
      if (!local) continue;
      if (item.accepted || item.duplicate) {
        acceptedIds.push(item.client_event_id);
      } else if (item.error && item.error.retryable === false) {
        await Queue.markAttempt(item.client_event_id, item.error.code || 'REJECTED');
        const refreshed = (await Queue.list(200)).find((p) => p.client_event_id === item.client_event_id);
        if (!refreshed || (refreshed.attempts || 0) >= MAX_ATTEMPTS) dropped.push(item.client_event_id);
      } else {
        await Queue.markAttempt(item.client_event_id, item.error?.code || 'RETRYABLE');
      }
    }
    await Queue.remove([...acceptedIds, ...dropped]);
    if (acceptedIds.length) {
      await setSettings({ lastUploadAt: new Date().toISOString(), lastError: null });
    }
    await updateBadge();
    return { flushed: acceptedIds.length, dropped: dropped.length, remaining: await Queue.count() };
  } finally {
    flushing = false;
  }
}

function stripLocalFields(event) {
  const { attempts, last_error, last_attempt_at, created_at, ...clean } = event;
  return clean;
}

async function heartbeat() {
  const settings = await getSettings();
  if (!settings.deviceToken) return { skipped: 'not_paired' };
  try {
    await Api.heartbeat(settings.serverUrl, settings.deviceToken);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.code || 'HEARTBEAT_FAILED' };
  }
}

async function checkRevocation() {
  const settings = await getSettings();
  if (!settings.deviceToken) return { skipped: 'not_paired' };
  let self;
  try {
    self = await Api.deviceSelf(settings.serverUrl, settings.deviceToken);
  } catch (err) {
    return { ok: false, error: err.code };
  }
  const device = self.data?.device || self.device || {};
  await setSettings({ bindingVersion: device.binding_version ?? settings.bindingVersion, deviceId: device.id || settings.deviceId });
  if (!device.server_revoked_at) return { ok: true, server_revoked: false };
  // 已撤销：停止上传并回执清理；回执成功后才清空本地队列。
  try {
    await Api.cleanupAck(settings.serverUrl, settings.deviceToken, device.binding_version);
    await Queue.clear();
    await clearPairing();
    await setSettings({ lastError: { code: 'DEVICE_REVOKED', message: '服务端已撤销本设备，本地队列已按清理协议删除', at: new Date().toISOString() } });
    await updateBadge();
    return { ok: true, server_revoked: true, cleaned: true };
  } catch (err) {
    await setSettings({ lastError: { code: 'CLEANUP_ACK_FAILED', message: '撤销回执失败，将在下次心跳重试；本地队列暂不清理', at: new Date().toISOString() } });
    return { ok: false, server_revoked: true, error: err.code };
  }
}

async function startPairing({ serverUrl, deviceName }) {
  const settings = await getSettings();
  const base = String(serverUrl || settings.serverUrl || '').replace(/\/$/, '');
  if (!base) throw { code: 'NO_SERVER', message: '请先填写后台地址' };
  await setSettings({ serverUrl: base });
  const created = await Api.createPairing(base, deviceName || `Chrome 扩展 ${new Date().toLocaleDateString('zh-CN')}`);
  const pair = created.data || created;
  const pending = {
    pairing_id: pair.pairing_id,
    request_id: pair.request_id,
    request_secret: pair.request_secret,
    code: pair.code,
    expires_at: pair.expires_at,
    device_name: deviceName || null,
    created_at: new Date().toISOString()
  };
  await setSettings({ pendingPairing: pending, lastError: null });
  chrome.alarms.create(PAIRING_ALARM, { periodInMinutes: 0.5 });
  return pending;
}

async function pollPairing() {
  const settings = await getSettings();
  const pending = settings.pendingPairing;
  if (!pending) return { skipped: 'no_pending_pairing' };
  if (pending.expires_at && Date.parse(pending.expires_at) < Date.now()) {
    await setSettings({ pendingPairing: null, lastError: { code: 'PAIRING_EXPIRED', message: '配对码已过期，请重新发起', at: new Date().toISOString() } });
    chrome.alarms.clear(PAIRING_ALARM);
    return { expired: true };
  }
  try {
    const exchanged = await Api.exchangePairing(settings.serverUrl, pending.request_id, pending.request_secret);
    const data = exchanged.data || exchanged;
    const ownerChanged = settings.deviceId && data.device_id !== settings.deviceId;
    await setSettings({
      deviceToken: data.device_token,
      deviceId: data.device_id,
      bindingVersion: data.binding_version,
      pendingPairing: null,
      pairedOwnerHint: data.owner?.email || null,
      lastError: null
    });
    if (ownerChanged) await Queue.clear();
    chrome.alarms.clear(PAIRING_ALARM);
    await flushQueue();
    return { paired: true, device_id: data.device_id, owner: data.owner?.email || null };
  } catch (err) {
    if (err.status === 403 && err.code === 'PAIRING_NOT_APPROVED') return { waiting: true };
    if (err.code === 'NETWORK_UNREACHABLE') return { waiting: true, offline: true };
    await setSettings({ pendingPairing: null, lastError: { code: err.code || 'PAIRING_FAILED', message: err.message, at: new Date().toISOString() } });
    chrome.alarms.clear(PAIRING_ALARM);
    return { failed: true, error: err.code };
  }
}

async function unpair({ cleanup = true } = {}) {
  const settings = await getSettings();
  let cleanupResult = null;
  if (settings.deviceToken) {
    try {
      const self = await Api.deviceSelf(settings.serverUrl, settings.deviceToken);
      const device = self.data?.device || self.device || {};
      if (device.server_revoked_at) {
        cleanupResult = await Api.cleanupAck(settings.serverUrl, settings.deviceToken, device.binding_version);
      } else {
        cleanupResult = { acknowledged: false, reason: 'NOT_REVOKED_SERVER_SIDE' };
      }
    } catch (err) {
      cleanupResult = { acknowledged: false, error: err.code || 'CLEANUP_FAILED' };
    }
  }
  if (cleanup || cleanupResult?.acknowledged) {
    await Queue.clear();
  }
  await clearPairing();
  await updateBadge();
  return { unpaired: true, cleanup: cleanupResult };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'enqueue_event': {
        const result = await Queue.add(message.event);
        await updateBadge();
        if (!result.duplicate) setTimeout(() => { flushQueue().catch(() => {}); }, 300);
        sendResponse({ ok: true, ...result, queued: await Queue.count() });
        return;
      }
      case 'get_status': {
        const settings = await getSettings();
        const count = await Queue.count();
        let health = null;
        try { health = await Api.health(settings.serverUrl); } catch (err) { health = { ok: false, error: err.code || 'UNREACHABLE' }; }
        const hostPermissions = await chrome.permissions.getAll().catch(() => ({ origins: [] }));
        sendResponse({
          ok: true,
          settings: {
            serverUrl: settings.serverUrl,
            deviceId: settings.deviceId,
            bindingVersion: settings.bindingVersion,
            pendingPairing: settings.pendingPairing,
            lastUploadAt: settings.lastUploadAt,
            lastError: settings.lastError,
            pairedOwnerHint: settings.pairedOwnerHint,
            paired: !!settings.deviceToken
          },
          queue: count,
          health,
          grantedOrigins: hostPermissions.origins || []
        });
        return;
      }
      case 'set_server_url': {
        await setSettings({ serverUrl: String(message.serverUrl || '').replace(/\/$/, '') });
        sendResponse({ ok: true });
        return;
      }
      case 'start_pairing': {
        try {
          const pending = await startPairing({ serverUrl: message.serverUrl, deviceName: message.deviceName });
          sendResponse({ ok: true, pending });
        } catch (err) {
          sendResponse({ ok: false, error: { code: err.code || 'PAIRING_FAILED', message: err.message || String(err) } });
        }
        return;
      }
      case 'poll_pairing_now': {
        sendResponse({ ok: true, result: await pollPairing() });
        return;
      }
      case 'cancel_pairing': {
        chrome.alarms.clear(PAIRING_ALARM);
        await setSettings({ pendingPairing: null });
        sendResponse({ ok: true });
        return;
      }
      case 'flush_now': {
        sendResponse(await flushQueue());
        return;
      }
      case 'heartbeat_now': {
        const result = await heartbeat();
        const revocation = await checkRevocation();
        sendResponse({ ok: true, heartbeat: result, revocation });
        return;
      }
      case 'unpair': {
        sendResponse({ ok: true, result: await unpair({ cleanup: message.cleanup !== false }) });
        return;
      }
      default:
        sendResponse({ ok: false, error: { code: 'UNKNOWN_MESSAGE' } });
    }
  })().catch((err) => {
    try { sendResponse({ ok: false, error: { code: 'INTERNAL', message: String(err?.message || err) } }); } catch { /* ignore */ }
  });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 5 });
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 5 });
  checkRevocation().catch(() => {});
  flushQueue().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) flushQueue().catch(() => {});
  if (alarm.name === HEARTBEAT_ALARM) heartbeat().then(checkRevocation).catch(() => {});
  if (alarm.name === PAIRING_ALARM) pollPairing().catch(() => {});
});

updateBadge();
flushQueue().catch(() => {});
