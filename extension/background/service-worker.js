/* Tounar 帮你理 · MV3 service worker（classic，importScripts 共享 lib） */
importScripts('../lib/common.js', '../lib/queue.js', '../lib/api.js');

const { getSettings, setSettings, clearPairing } = globalThis.TounarCommon;
const Queue = globalThis.TounarQueue;
const Api = globalThis.TounarApi;

const FLUSH_ALARM = 'tounar-flush';
const HEARTBEAT_ALARM = 'tounar-heartbeat';
const PAIRING_ALARM = 'tounar-pairing-poll';
const MAX_BATCH = 50;
// 事件 → 来源标签页（仅内存，用于把回执送回正确页面；SW 休眠会丢，属于轻量提示的可接受降级）
const pendingTabs = new Map();
let flushPromise = null;

async function updateBadge() {
  try {
    const count = await Queue.count();
    await chrome.action.setBadgeText({ text: count ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: count ? '#b45309' : '#00000000' });
  } catch { /* ignore */ }
}


/* ---------- 轻量反馈：把服务端确认的结果送回原始标签页 ---------- */

const PENDING_KEY = 'tounar.pendingTabs.v1';
const PENDING_TTL_MS = 30 * 60 * 1000;
const FEEDBACK_REPEAT_MS = 60 * 1000;
let pendingLoaded = false;
let persistTimer = null;
const lastFeedbackAt = new Map();

async function ensurePendingLoaded() {
  if (pendingLoaded) return;
  pendingLoaded = true;
  try {
    const stored = await chrome.storage.session.get(PENDING_KEY);
    const rows = stored?.[PENDING_KEY] || {};
    const now = Date.now();
    for (const [id, t] of Object.entries(rows)) {
      if (!t || now - (t.at || 0) > PENDING_TTL_MS) continue;
      pendingTabs.set(id, t);
    }
  } catch { /* session storage 不可用时退化为内存 */ }
}

function persistPending() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      const now = Date.now();
      const rows = {};
      for (const [id, t] of pendingTabs) if (now - (t.at || 0) <= PENDING_TTL_MS) rows[id] = t;
      await chrome.storage.session.set({ [PENDING_KEY]: rows });
    } catch { /* ignore */ }
  }, 150);
}

async function clearPendingFeedback() {
  pendingTabs.clear();
  lastFeedbackAt.clear();
  try { await chrome.storage.session.remove(PENDING_KEY); } catch { /* ignore */ }
}

function jobIdentity(payload = {}, siteKey = '') {
  const id = payload.site_job_id || payload.site_application_id;
  if (id) return `${siteKey}:id:${id}`;
  try {
    const u = new URL(payload.job_url);
    return `${siteKey}:url:${u.origin}${u.pathname}${u.search}${u.hash}`;
  } catch { return null; }
}

/* 成功判定必须同时满足：accepted、processing_state=applied、有业务记录 ID。
 * 仅入队 / HTTP 200 / accepted / ignored / cancelled / 无 ID 一律不算保存成功。 */
function feedbackStatus(result) {
  if (!result) return 'unknown';
  if (result.review_item_id) return 'review';
  if (result.error && result.error.retryable === false) return 'failed';
  if (result.error) return 'queued';
  if (!result.accepted || result.processing_state !== 'applied') return 'unknown';
  if (!result.application_id) return 'unknown';
  if (result.outcome === 'created') return 'created';
  if (result.outcome === 'updated') return 'updated';
  if (result.outcome === 'unchanged') return 'unchanged';
  return 'saved';
}

// 完整 URL 比较（含 query 与 hash）：同 pathname 的 ?postId=5001/5002、#/job/1、#/job/2 都不能算同页
function samePage(a, b) {
  try { return new URL(a).href === new URL(b).href; } catch { return false; }
}

async function deliverFeedback(resultMap) {
  await ensurePendingLoaded();
  const settings = await getSettings();
  const byTab = new Map();
  for (const [clientId, result] of Object.entries(resultMap || {})) {
    const target = pendingTabs.get(clientId);
    if (!target) continue;
    const key = `${target.tabId}:${target.frameId}`;
    const bucket = byTab.get(key) || { ...target, entries: [] };
    bucket.entries.push({ ...result, client_event_id: clientId, identity: target.identity || null });
    byTab.set(key, bucket);
    // 只有最终结果才移除关联；待同步/重试中的事件保留映射，恢复后还能回到原页面
    if (feedbackStatus(result) !== 'queued') pendingTabs.delete(clientId);
  }
  persistPending();
  if (settings.pageFeedback === false) return;
  for (const bucket of byTab.values()) {
    let tab;
    try { tab = await chrome.tabs.get(bucket.tabId); } catch { continue; }
    // 页面必须还是同一个完整 URL；query/hash 变化都视为离开了原岗位
    if (!tab?.url || !samePage(tab.url, bucket.url)) continue;
    // 按业务记录/岗位身份去重：同一岗位的多个事件只算一个
    const uniq = new Map();
    for (const entry of bucket.entries) {
      const status = feedbackStatus(entry);
      const key = entry.application_id ? `app:${entry.application_id}`
        : entry.review_item_id ? `rev:${entry.review_item_id}`
          : entry.identity ? `job:${entry.identity}` : `evt:${entry.client_event_id}`;
      const prev = uniq.get(key);
      const rank = { created: 5, updated: 4, saved: 3, unchanged: 2, review: 2, queued: 1, failed: 0, unknown: 0 };
      if (!prev || rank[status] > rank[prev.status]) uniq.set(key, { ...entry, status, key });
    }
    const entries = [...uniq.values()];
    const countOf = (list) => entries.filter((e) => list.includes(e.status)).length;
    let feedback;
    if (entries.length > 1) {
      const saved = countOf(['created', 'updated', 'saved']);
      const review = countOf(['review']);
      const queued = countOf(['queued']);
      const failed = countOf(['failed']);
      feedback = { status: 'batch', saved, review, queued, failed, total: entries.length,
        url: bucket.url, serverUrl: settings.serverUrl || null, context: bucket.kind === 'job_discovered' ? 'list' : 'detail' };
    } else {
      const entry = entries[0];
      feedback = {
        status: entry.status, applicationId: entry.application_id || null, reviewId: entry.review_item_id || null,
        missing: entry.missing_fields || [], hasApplied: entry.has_applied, applicationStatus: entry.application_status,
        identity: entry.identity || null, url: bucket.url, kind: bucket.kind,
        serverUrl: settings.serverUrl || null, context: bucket.kind === 'job_discovered' ? 'list' : 'detail',
        errorMessage: entry.error?.message || null
      };
    }
    // 同一页面同一岗位的待同步/失败提示 60 秒内只发一次，避免重试刷屏
    if (['queued', 'failed'].includes(feedback.status)) {
      const key = `${bucket.tabId}:${feedback.identity || 'list'}:${feedback.status}`;
      const last = lastFeedbackAt.get(key) || 0;
      if (Date.now() - last < FEEDBACK_REPEAT_MS) continue;
      lastFeedbackAt.set(key, Date.now());
    }
    try { await chrome.tabs.sendMessage(bucket.tabId, { type: 'tounar_feedback', feedback }, { frameId: bucket.frameId }); } catch { /* 页面已关闭 */ }
  }
}

function flushQueue() {
  if (flushPromise) return flushPromise;
  flushPromise = runFlush().finally(() => { flushPromise = null; });
  return flushPromise;
}
async function runFlush() {
  try {
    const settings = await getSettings();
    if (!settings.deviceToken) {
      await updateBadge();
      return { skipped: 'not_paired', queued: await Queue.count() };
    }
    const available = await Queue.list(MAX_BATCH);
    const pending = []; let bytes = 0;
    for (const item of available) {
      const size = new TextEncoder().encode(JSON.stringify(item)).length;
      if (pending.length && bytes + size > 1000000) break;
      pending.push(item); bytes += size;
    }
    if (!pending.length) return { flushed: 0 };
    let response;
    try {
      response = await Api.uploadEvents(settings.serverUrl, settings.deviceToken, pending.map(stripLocalFields));
    } catch (err) {
      await setSettings({ lastError: { code: err.code || 'UPLOAD_FAILED', message: err.message, at: new Date().toISOString() } });

      const authFailure = err.status === 401 || err.status === 403;
      if (authFailure) {
        await setSettings({ lastError: { code: 'DEVICE_REVOKED_OR_INVALID', message: '设备凭证被服务端拒绝；如已撤销请在网页确认后解除本设备', at: new Date().toISOString() } });
      }
      const retryable = !authFailure && (err.status == null || err.status >= 500 || err.code === 'TIMEOUT' || err.code === 'NETWORK_UNREACHABLE');
      const failureMap = Object.fromEntries(pending.map((item) => [item.client_event_id, {
        accepted: false,
        error: { code: err.code || 'UPLOAD_FAILED', message: err.message || '', retryable },
        outcome: retryable ? 'queued' : 'failed'
      }]));
      await deliverFeedback(failureMap).catch(() => {});
      await updateBadge();
      return { failed: pending.length, error: err.code || 'UPLOAD_FAILED' };
    }
    const acceptedIds = [];
    const dropped = [];
    for (const item of response.results || []) {
      const local = pending.find((p) => p.client_event_id === item.client_event_id);
      if (!local) continue;
      if ((item.accepted || item.duplicate) && item.processing_state !== 'failed') {
        acceptedIds.push(item.client_event_id);
      } else if (item.error && item.error.retryable === false) {
        dropped.push(item.client_event_id);
      } else {
        await Queue.markAttempt(item.client_event_id, item.error?.code || 'RETRYABLE');
      }
    }
    const resultMap = {};
    for (const item of response.results || []) {
      resultMap[item.client_event_id] = {
        accepted: !!item.accepted,
        duplicate: !!item.duplicate,
        application_id: item.application_id || null,
        review_item_id: item.review_item_id || null,
        review_reason: item.review_reason || null,
        processing_state: item.processing_state || null,
        outcome: item.outcome || null,
        application_status: item.application_status || null,
        has_applied: item.has_applied ?? null,
        missing_fields: item.missing_fields || [],
        error: item.error || null,
        at: new Date().toISOString()
      };
    }
    if (Object.keys(resultMap).length) {
      const prev = (await getSettings()).lastEventResults || {};
      await setSettings({ lastEventResults: Object.fromEntries(Object.entries({ ...prev, ...resultMap }).sort((a,b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0,300)), lastEventResultsAt: new Date().toISOString() });
    }
    await deliverFeedback(resultMap).catch(() => {});
    await Queue.remove([...acceptedIds, ...dropped]);
    if (acceptedIds.length) {
      await setSettings({ lastUploadAt: new Date().toISOString(), lastError: null });
    }
    await updateBadge();
    const remaining = await Queue.count();
    if (remaining && (acceptedIds.length || dropped.length)) {
      const next = await runFlush();
      return {flushed:acceptedIds.length + (next.flushed||0), dropped:dropped.length + (next.dropped||0), remaining:await Queue.count()};
    }
    return { flushed: acceptedIds.length, dropped: dropped.length, remaining };
  } finally {
    if (await Queue.count()) chrome.alarms.create(FLUSH_ALARM, { delayInMinutes: 0.5 });
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
    if (['NETWORK_UNREACHABLE','TIMEOUT','BACKEND_PERMISSION_REQUIRED'].includes(settings.lastError?.code)) await setSettings({lastError:null});
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
  await clearPendingFeedback();
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
        const settings = await getSettings();
        if (settings.capturePaused) { sendResponse({ok:false,error:'CAPTURE_PAUSED'}); return; }
        if (sender.tab) {
          const origin = new URL(sender.url || sender.tab.url).origin;
          if (!await chrome.permissions.contains({ origins:[origin+'/*'] })) { sendResponse({ok:false,error:'PERMISSION_REVOKED'}); return; }
        }
        const result = await Queue.add(message.event);
        if (!result.duplicate && sender.tab?.id && message.event?.client_event_id) {
          await ensurePendingLoaded();
          pendingTabs.set(message.event.client_event_id, {
            tabId: sender.tab.id,
            frameId: sender.frameId ?? 0,
            url: sender.tab.url || sender.url || null,
            identity: jobIdentity(message.event.payload, message.event.site_key),
            kind: message.event.event_type || null,
            at: Date.now()
          });
          if (pendingTabs.size > 200) pendingTabs.delete(pendingTabs.keys().next().value);
          persistPending();
        }
        await updateBadge();
        flushQueue().catch(() => {});
        sendResponse({ ok: true, ...result, queued: await Queue.count() });
        return;
      }
      case 'get_status': {
        const settings = await getSettings();
        const count = await Queue.count();
        let health = null;
        try { health = await Api.health(settings.serverUrl); } catch (err) {
          health = { ok: false, error: err.code || 'UNREACHABLE', message: err.message || '' };
        }
        const hostPermissions = await chrome.permissions.getAll().catch(() => ({ origins: [] }));
        sendResponse({
          ok: true,
          settings: {
            serverUrl: settings.serverUrl,
            pageFeedback: settings.pageFeedback !== false,
            deviceId: settings.deviceId,
            bindingVersion: settings.bindingVersion,
            pendingPairing: settings.pendingPairing,
            lastUploadAt: settings.lastUploadAt,
            lastError: settings.lastError,
            pairedOwnerHint: settings.pairedOwnerHint,
            paired: !!settings.deviceToken,
            capturePaused: !!settings.capturePaused,
            lastCapture: settings.lastCapture || null,
            lastEventResults: settings.lastEventResults || {}
          },
          queue: count,
          health,
          grantedOrigins: hostPermissions.origins || []
        });
        return;
      }
      case 'set_server_url': {
        await setSettings({ serverUrl: String(message.serverUrl || '').replace(/\/$/, '') });
        flushQueue().catch(() => {});
        sendResponse({ ok: true });
        return;
      }
      case 'set_page_feedback': {
        const enabled = message.enabled !== false;
        await setSettings({ pageFeedback: enabled });
        try {
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (!tab.id || !/^https?:/.test(tab.url || '')) continue;
            chrome.tabs.sendMessage(tab.id, { type: 'tounar_feedback_settings', enabled }).catch(() => {});
          }
        } catch { /* ignore */ }
        sendResponse({ ok: true, enabled });
        return;
      }
      case 'sync_permissions': {
        await syncContentScripts(); sendResponse({ok:true}); return;
      }
      case 'set_capture_paused': {
        await setSettings({capturePaused:!!message.paused});
        await syncContentScripts();
        if (!message.paused) await injectAuthorizedTabs();
        sendResponse({ok:true}); return;
      }
      case 'clear_queue': {
        // Let an in-flight upload settle before deciding which local events remain.
        await flushPromise?.catch(() => {});
        await clearPendingFeedback();
        const pending = await Queue.list(10000);
        const settings = await getSettings();
        const results = {...settings.lastEventResults};
        for (const event of pending) results[event.client_event_id] = {
          accepted:false, processing_state:'cancelled', at:new Date().toISOString(),
          error:{code:'LOCAL_QUEUE_CLEARED',message:'未上传事件已由你清空',retryable:false}
        };
        await setSettings({lastEventResults:results});
        await Queue.remove(pending.map(event => event.client_event_id));
        await updateBadge(); sendResponse({ok:true,cleared:pending.length}); return;
      }
      case 'event_result': {
        const clientEventId = String(message.clientEventId || '');
        if (!clientEventId) { sendResponse({ ok: false, error: { code: 'NO_EVENT_ID', message: '缺少 client_event_id' } }); return; }
        await flushQueue().catch(() => null);
        const stored = (await getSettings()).lastEventResults || {};
        const result = stored[clientEventId] || null;
        let status = 'queued';
        if (result) {
          // 与页面 Toast 使用同一套回执解释，避免两处对同一回执给出不同结果
          const interpreted = feedbackStatus(result);
          if (result.processing_state === 'cancelled') status = 'cancelled';
          else if (result.processing_state === 'failed') status = 'failed';
          else if (interpreted === 'review') status = 'review';
          else if (['created', 'updated', 'unchanged', 'saved'].includes(interpreted)) status = 'entered';
          else if (interpreted === 'queued') status = 'queued';
          else if (interpreted === 'failed') status = 'rejected';
          else status = 'unknown';
        }
        sendResponse({ ok: true, status, result, serverUrl: (await getSettings()).serverUrl || null, queued: await Queue.count() });
        return;
      }
      case 'read_visible_kuaishou_cards': {
        const url = new URL(sender.url || 'https://invalid.local');
        if (!sender.tab?.id || url.hostname !== 'zhaopin.kuaishou.cn' || (await getSettings()).capturePaused ||
            !await chrome.permissions.contains({origins:[url.origin+'/*']})) { sendResponse([]); return; }
        // Only the public identity bound to each rendered row is returned. Never
        // copy the component's full record (which may contain unrelated fields),
        // invoke site handlers, or replay the site's signed network requests.
        const results = await chrome.scripting.executeScript({target:{tabId:sender.tab.id},world:'MAIN',func:() => {
          if (location.hostname !== 'zhaopin.kuaishou.cn' || !/^#\/official\/social\/(?:\?|$)/.test(location.hash)) return [];
          return [...document.querySelectorAll('.ant-table-tbody > tr')].flatMap(row => {
            if (!row.getClientRects().length) return [];
            const title = row.querySelector('td:first-child')?.innerText.trim();
            const locationText = row.querySelector('td:nth-child(3)')?.innerText.trim();
            const key = Object.keys(row).find(k => /^__react(?:Fiber|InternalInstance)\$/.test(k));
            let fiber = key && row[key];
            for (let depth=0; fiber && depth<6; depth++,fiber=fiber.return) {
              const record = fiber.memoizedProps?.record;
              if (record?.name === title && /^\d+$/.test(String(record.id)))
                return [{title,location:locationText,url:`${location.origin}/#/official/social/job-info/${record.id}`}];
            }
            return [];
          });
        }});
        sendResponse(results[0]?.result || []); return;
      }
      case 'capture_current_tab': { sendResponse(await captureTab(message)); return; }
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

let registration = Promise.resolve();
function syncContentScripts() {
  registration = registration.catch(() => {}).then(async () => {
    const settings = await getSettings();
    const all = await chrome.permissions.getAll();
    const matches = settings.capturePaused ? [] : (all.origins || []);
    const registered = await chrome.scripting.getRegisteredContentScripts();
    if (registered.some(s => s.id === 'tounar-tracker')) {
      if (matches.length) await chrome.scripting.updateContentScripts([{id:'tounar-tracker',matches,js:['lib/learned.js','content/adapters.js','content/tracker.js'],runAt:'document_idle',persistAcrossSessions:true}]);
      else await chrome.scripting.unregisterContentScripts({ids:['tounar-tracker']});
    } else if(matches.length) {
      await chrome.scripting.registerContentScripts([{id:'tounar-tracker',matches,js:['lib/learned.js','content/adapters.js','content/tracker.js'],runAt:'document_idle',persistAcrossSessions:true}]);
    }
  });
  return registration;
}
chrome.permissions.onAdded.addListener(permissions => {
  (async () => {
    await syncContentScripts();
    if((await getSettings()).capturePaused) return;
    // Complete the explicit authorization even if Chrome closes the popup.
    const candidates = (await chrome.tabs.query({})).filter(tab => {
      if(!/^https?:/.test(tab.url || '')) return false;
      const url = new URL(tab.url);
      return (permissions.origins || []).some(pattern => {
        const match = pattern.match(/^(\*|https?):\/\/([^/]+)\//);
        if(!match || match[1] !== '*' && match[1] !== url.protocol.slice(0,-1)) return false;
        const host = match[2].split(':')[0];
        return host === '*' || host === url.hostname || host.startsWith('*.') && (url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)));
      });
    }).sort((a,b) => (b.lastAccessed||b.id)-(a.lastAccessed||a.id));
    const tab=candidates[0];
    if(tab) await captureTab({tabId:tab.id,origin:new URL(tab.url).origin,reason:'authorize'});
  })().catch(() => {});
});
chrome.permissions.onRemoved.addListener(() => syncContentScripts().catch(() => {}));
chrome.runtime.onStartup.addListener(() => syncContentScripts().catch(() => {}));
syncContentScripts().catch(() => {});

async function injectAuthorizedTabs() {
  for (const tab of await chrome.tabs.query({})) {
    if(!/^https?:/.test(tab.url || '')) continue;
    const origin = new URL(tab.url).origin;
    if(await chrome.permissions.contains({origins:[origin+'/*']})) {
      await chrome.scripting.executeScript({target:{tabId:tab.id},files:['lib/learned.js','content/adapters.js','content/tracker.js']}).catch(()=>{});
    }
  }
}

async function captureTab(message) {
        const tabId = Number(message.tabId);
        const origin = String(message.origin || '');
        const startedAt = Date.now();
        try {
          if (!tabId) throw Object.assign(new Error('缺少 tabId'), { code: 'NO_TAB' });
          const hasPermission = await chrome.permissions.contains({ origins: [`${origin}/*`] });
          if (!hasPermission) throw Object.assign(new Error('该站点未授权'), { code: 'NO_PERMISSION' });
          if ((await getSettings()).capturePaused) throw Object.assign(new Error('采集已暂停，请先恢复'), {code:'CAPTURE_PAUSED'});
          await syncContentScripts();
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['lib/learned.js', 'content/adapters.js', 'content/tracker.js']
          });
          let response = null;
          try {
            response = await chrome.tabs.sendMessage(tabId, { type: 'tounar_capture_now', reason: message.reason || 'authorize' });
          } catch (error) {
            throw Object.assign(new Error(`无法连接页面脚本：${error.message}`), { code: 'NO_CONTENT_SCRIPT' });
          }
          const elapsedMs = Date.now() - startedAt;
          const status = response?.status || 'failed';
          await setSettings({ lastCapture: { ...response, at: new Date().toISOString(), origin, elapsedMs, status } });
          return { ok: true, elapsedMs, status, result: response };
        } catch (error) {
          const status = error?.code === 'NO_PERMISSION' ? 'unauthorized' : 'error';
          await setSettings({ lastCapture: { at: new Date().toISOString(), origin, elapsedMs: Date.now() - startedAt, status, message: error.message } });
          return { ok: false, error: { code: error?.code || 'CAPTURE_FAILED', message: error.message } };
        }

}
