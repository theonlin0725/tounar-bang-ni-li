import crypto from 'node:crypto';
import { config } from './config.js';
import { all, one, run, transaction } from './db.js';
import {
  AppError, assert, canonicalJobUrl, hashSecret, isSafeHttpUrl, newId, normalizeWhitespace, nowIso,
  parseIso, payloadHash, randomToken, safeEqualHex, sanitizeUrl, sha256, stableStringify
} from './util.js';
import { mapStatusText, processPluginEvent } from './domain/applications.js';
import { finalizeDeletionForOwner } from './domain/deletion.js';

const ALLOWED_EVENT_TYPES = new Set(['job_viewed', 'job_captured', 'form_started', 'application_submitted', 'site_status_observed']);

export function createPairing(body = {}) {
  const deviceName = normalizeWhitespace(body.device_name || 'Chrome 扩展', 80) || 'Chrome 扩展';
  const pairingId = newId('pair');
  const requestId = 'pairreq_' + randomToken(18);
  const requestSecret = 'pairsec_' + randomToken(32);
  const code = Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(0, 32)]).join('');
  const expiresAt = new Date(Date.now() + config.pairingTtlMinutes * 60000).toISOString();
  run(`INSERT INTO plugin_pairings
    (id, request_id, request_secret_hash, code_hash, device_name, status, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  [pairingId, requestId, hashSecret(requestSecret), hashSecret(code), deviceName, expiresAt, nowIso()]);
  return {
    pairing_id: pairingId,
    request_id: requestId,
    request_secret: requestSecret,
    code,
    expires_at: expiresAt,
    instructions: '在已登录的帮你理网页中输入此配对码；不要通过网址或聊天转发。'
  };
}

export function approvePairing(ownerId, pairingId, code) {
  const normalizedCode = String(code || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(normalizedCode)) throw new AppError(400, 'PAIRING_CODE_INVALID', '配对码格式不正确');
  const actual = hashSecret(normalizedCode);
  let pairing = null;
  if (pairingId) {
    pairing = one('SELECT * FROM plugin_pairings WHERE id = ?', [pairingId]);
  } else {
    const pending = all(`SELECT * FROM plugin_pairings WHERE status = 'pending'
      ORDER BY created_at DESC LIMIT 50`, []);
    pairing = pending.find((p) => safeEqualHex(actual, p.code_hash)) || null;
  }
  if (!pairing) throw new AppError(404, 'NOT_FOUND', '配对请求不存在或已过期');
  if (pairing.status !== 'pending') throw new AppError(409, 'PAIRING_ALREADY_USED', '配对请求已使用');
  if (Date.parse(pairing.expires_at) < Date.now()) {
    run("UPDATE plugin_pairings SET status = 'expired' WHERE id = ?", [pairing.id]);
    throw new AppError(409, 'PAIRING_EXPIRED', '配对码已过期，请在插件中重新发起');
  }
  if (!safeEqualHex(actual, pairing.code_hash)) throw new AppError(400, 'PAIRING_CODE_INVALID', '配对码不正确');
  run(`UPDATE plugin_pairings SET status = 'approved', owner_id = ?, approved_at = ? WHERE id = ? AND status = 'pending'`,
    [ownerId, nowIso(), pairing.id]);
  return { pairing_id: pairing.id, status: 'approved', device_name: pairing.device_name };
}

export function exchangePairing(body = {}) {
  const pairing = one('SELECT * FROM plugin_pairings WHERE request_id = ?', [body.request_id]);
  if (!pairing) throw new AppError(404, 'NOT_FOUND', '配对请求不存在');
  const hash = hashSecret(String(body.request_secret || ''));
  if (!safeEqualHex(hash, pairing.request_secret_hash)) throw new AppError(403, 'FORBIDDEN', '配对凭据无效');
  if (Date.parse(pairing.expires_at) < Date.now()) {
    run("UPDATE plugin_pairings SET status = 'expired' WHERE id = ?", [pairing.id]);
    throw new AppError(409, 'PAIRING_EXPIRED', '配对已过期');
  }
  if (pairing.status === 'exchanged') {
    throw new AppError(409, 'PAIRING_ALREADY_USED', '配对凭据已兑换；如设备丢失请在网页撤销');
  }
  if (pairing.status !== 'approved') throw new AppError(403, 'PAIRING_NOT_APPROVED', '请先在网页确认此设备');
  const token = 'dev_' + randomToken(40);
  const deviceId = newId('dev');
  const expiresAt = new Date(Date.now() + config.deviceTokenDays * 86400000).toISOString();
  transaction(() => {
    run(`INSERT INTO plugin_devices
      (id, owner_id, device_name, token_hash, binding_version, pairing_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    [deviceId, pairing.owner_id, pairing.device_name, sha256(token), pairing.id, expiresAt, nowIso()]);
    run("UPDATE plugin_pairings SET status = 'exchanged', exchanged_at = ? WHERE id = ?", [nowIso(), pairing.id]);
  });
  return {
    device_id: deviceId,
    device_token: token,
    binding_version: 1,
    expires_at: expiresAt,
    owner: { email: one('SELECT email_display FROM users WHERE id = ?', [pairing.owner_id])?.email_display }
  };
}

export function authenticateDevice(req, { allowRevoked = false } = {}) {
  // 托管平台网关会覆盖 Authorization（2026-10-24 探针实测），
  // 因此设备凭证优先走 X-Device-Token 自定义头（已证实能穿透网关），本地兜底仍支持 Bearer。
  const altHeader = String(req.headers['x-device-token'] || '').trim();
  const bearer = String(req.headers.authorization || '');
  let token = '';
  if (altHeader.startsWith('dev_')) token = altHeader;
  else if (bearer.startsWith('Bearer dev_')) token = bearer.slice(7).trim();
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', '设备凭证缺失');
  const row = one(`SELECT d.*, u.email_display, u.deletion_blocked
    FROM plugin_devices d JOIN users u ON u.id = d.owner_id
    WHERE d.token_hash = ?`, [sha256(token)]);
  if (!row) throw new AppError(401, 'UNAUTHENTICATED', '设备凭证无效');
  // 删除进行中：业务事件一律拒绝，但 deviceSelf / cleanupAck（allowRevoked）必须保留最小清理回执通道，
  // 否则设备无法读取新的 binding_version，也无法回执，删除会永远停在 awaiting_device_ack。
  if (row.deletion_blocked && !allowRevoked) throw new AppError(403, 'DELETION_IN_PROGRESS', '账号正在删除数据');
  if (row.server_revoked_at && !allowRevoked) {
    throw new AppError(403, 'DEVICE_REVOKED', '设备绑定已撤销；请在扩展中重新绑定');
  }
  if (!allowRevoked && row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    throw new AppError(403, 'DEVICE_EXPIRED', '设备凭证已过期；请重新绑定');
  }
  req.device = row;
  req.ownerId = row.owner_id;
  return row;
}

export function deviceSelf(req) {
  const device = authenticateDevice(req, { allowRevoked: true });
  return {
    device: {
      id: device.id,
      name: device.device_name,
      binding_version: device.binding_version,
      created_at: device.created_at,
      expires_at: device.expires_at,
      last_heartbeat_at: device.last_heartbeat_at,
      last_event_at: device.last_event_at,
      server_revoked_at: device.server_revoked_at,
      device_cleanup_state: device.device_cleanup_state,
      device_cleanup_ack_at: device.device_cleanup_ack_at
    },
    owner: { email: device.email_display },
    server_revoked: !!device.server_revoked_at,
    cleanup_required: !!device.server_revoked_at && device.device_cleanup_state !== 'acknowledged'
  };
}

export function heartbeat(req) {
  const device = authenticateDevice(req);
  run('UPDATE plugin_devices SET last_heartbeat_at = ? WHERE id = ?', [nowIso(), device.id]);
  return { ok: true, binding_version: device.binding_version, server_time: nowIso() };
}

export function cleanupAck(req, body = {}) {
  const device = authenticateDevice(req, { allowRevoked: true });
  if (!device.server_revoked_at) return { acknowledged: false, reason: 'DEVICE_NOT_REVOKED' };
  const expected = Number(body.binding_version);
  if (!Number.isInteger(expected) || expected !== device.binding_version) {
    throw new AppError(409, 'VERSION_CONFLICT', '绑定版本不匹配，请先校验设备状态', {
      details: { current_binding_version: device.binding_version }
    });
  }
  run(`UPDATE plugin_devices SET device_cleanup_state = 'acknowledged', device_cleanup_ack_at = ?
       WHERE id = ? AND binding_version = ?`, [nowIso(), device.id, device.binding_version]);
  let deletion_job = null;
  try { deletion_job = finalizeDeletionForOwner(device.owner_id); } catch { /* deletion finalization is best effort */ }
  return {
    acknowledged: true,
    device_cleanup_state: 'acknowledged',
    device_cleanup_ack_at: nowIso(),
    deletion_job
  };
}

export function revokeDevice(ownerId, deviceId) {
  const device = one('SELECT * FROM plugin_devices WHERE id = ? AND owner_id = ?', [deviceId, ownerId]);
  if (!device) throw new AppError(404, 'NOT_FOUND', '设备不存在');
  const revokedAt = device.server_revoked_at || nowIso();
  run(`UPDATE plugin_devices SET server_revoked_at = COALESCE(server_revoked_at, ?),
       device_cleanup_state = CASE WHEN device_cleanup_state = 'acknowledged' THEN 'acknowledged' ELSE 'unknown' END,
       binding_version = binding_version + 1
       WHERE id = ? AND owner_id = ?`, [revokedAt, deviceId, ownerId]);
  const updated = one('SELECT * FROM plugin_devices WHERE id = ? AND owner_id = ?', [deviceId, ownerId]);
  return {
    device_id: updated.id,
    server_revoked_at: updated.server_revoked_at,
    device_cleanup_state: updated.device_cleanup_state,
    device_cleanup_ack_at: updated.device_cleanup_ack_at,
    binding_version: updated.binding_version,
    note: '服务端已撤销旧绑定并拒收后续事件；离线设备清理状态需设备回执确认'
  };
}

function normalizeEvent(raw, batchSchemaVersion) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'VALIDATION_ERROR', '事件必须是对象');
  if (raw.owner_id || raw.ownerId) throw new AppError(400, 'VALIDATION_ERROR', '客户端不可提交 owner_id');
  const schemaVersion = String(raw.schema_version || batchSchemaVersion || '');
  if (schemaVersion !== 'C1') throw new AppError(400, 'VALIDATION_ERROR', 'schema_version 必须为 C1');
  const eventType = String(raw.event_type || '');
  if (!ALLOWED_EVENT_TYPES.has(eventType)) throw new AppError(400, 'VALIDATION_ERROR', '插件不允许提交该事件类型');
  if (raw.source_method !== 'plugin') throw new AppError(400, 'VALIDATION_ERROR', '插件事件 source_method 必须为 plugin');
  const clientEventId = String(raw.client_event_id || '');
  if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(clientEventId)) throw new AppError(400, 'VALIDATION_ERROR', 'client_event_id 无效');
  const occurredAt = parseIso(raw.occurred_at);
  const observedAt = parseIso(raw.observed_at);
  if (!occurredAt || !observedAt) throw new AppError(400, 'VALIDATION_ERROR', '事件时间必须是带时区 ISO 8601');
  const evidenceLevel = String(raw.evidence_level || 'unknown');
  if (!['strong', 'weak', 'unknown'].includes(evidenceLevel)) throw new AppError(400, 'VALIDATION_ERROR', 'evidence_level 无效');
  const payload = raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload) ? raw.payload : {};
  if (Buffer.byteLength(JSON.stringify(payload)) > 200_000) throw new AppError(400, 'VALIDATION_ERROR', 'payload 过大');
  const normalizedPayload = { ...payload };
  if (payload.field_confidence != null) {
    if (typeof payload.field_confidence !== 'object' || Array.isArray(payload.field_confidence)) throw new AppError(400, 'VALIDATION_ERROR', '字段把握度格式错误');
    normalizedPayload.field_confidence = {};
    normalizedPayload.field_sources = {};
    for (const field of ['company_name','job_title','location','recruitment_batch','jd_summary','jd_text','site_job_id','job_url']) {
      const value = payload.field_confidence[field];
      if (value != null && !['low','medium','high'].includes(value)) throw new AppError(400, 'VALIDATION_ERROR', '未知字段把握度');
      if (value) normalizedPayload.field_confidence[field] = value;
      if (value === 'low') normalizedPayload[field] = null;
      if (typeof payload.field_sources?.[field] === 'string') normalizedPayload.field_sources[field] = normalizeWhitespace(payload.field_sources[field], 60);
    }
  }
  for (const key of ['company_name', 'job_title', 'recruitment_batch', 'location']) {
    if (normalizedPayload[key] != null) normalizedPayload[key] = normalizeWhitespace(normalizedPayload[key], 200);
  }
  if (normalizedPayload.jd_summary != null) normalizedPayload.jd_summary = normalizeWhitespace(normalizedPayload.jd_summary, 80);
  if (normalizedPayload.jd_text != null) {
    // 完整 JD：保留段落，只做长度上限（超限时置空并标记，不能静默截断）
    const raw = String(normalizedPayload.jd_text).replace(/\r\n/g, '\n').trim();
    if (raw.length > 20000 && normalizedPayload.jd_text_truncated !== true) {
      // 客户端没声明截断却超限：拒绝，避免静默丢正文
      throw new AppError(400, 'JD_TEXT_TOO_LONG', 'jd_text 超过 20000 字符且未声明截断，请分段提交');
    }
    if (normalizedPayload.jd_text_truncated === true) normalizedPayload.jd_text = raw.slice(0, 20000);
    normalizedPayload.jd_text = raw || null;
  }
  for (const key of ['job_url', 'status_url']) {
    if (normalizedPayload[key] != null) {
      if (!isSafeHttpUrl(normalizedPayload[key])) throw new AppError(400, 'VALIDATION_ERROR', `${key} 必须是安全 http(s) URL`);
      normalizedPayload[key] = sanitizeUrl(normalizedPayload[key]);
    }
  }
  if (normalizedPayload.job_url) normalizedPayload.job_url = normalizedPayload.job_url;
  const mapped = normalizedPayload.mapped_status || mapStatusText(normalizedPayload.status_text);
  if (mapped) normalizedPayload.mapped_status = mapped;
  const siteKey = raw.site_key ? normalizeWhitespace(raw.site_key, 80).toLowerCase() : null;
  if (siteKey && !/^[a-z0-9._-]+$/.test(siteKey)) throw new AppError(400, 'VALIDATION_ERROR', 'site_key 无效');
  const normal = {
    client_event_id: clientEventId,
    event_type: eventType,
    source_method: 'plugin',
    site_key: siteKey,
    adapter_version: normalizeWhitespace(raw.adapter_version || 'unknown', 80),
    occurred_at: occurredAt,
    observed_at: observedAt,
    evidence_level: evidenceLevel,
    evidence_code: normalizeWhitespace(raw.evidence_code || '', 120) || null,
    payload: normalizedPayload,
    schema_version: schemaVersion
  };
  normal.payload_hash = payloadHash({ ...normal, payload_hash: undefined });
  return normal;
}

export function ingestBatch(device, body) {
  if (!Array.isArray(body.events) || body.events.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'events 必须是非空数组');
  }
  if (body.events.length > config.maxEventBatch) {
    throw new AppError(400, 'VALIDATION_ERROR', `单批最多 ${config.maxEventBatch} 条`);
  }
  const results = [];
  for (const raw of body.events) {
    let normal;
    try {
      normal = normalizeEvent(raw, body.schema_version);
    } catch (err) {
      results.push({
        client_event_id: raw?.client_event_id || null,
        accepted: false,
        duplicate: false,
        error: {
          code: err.code || 'VALIDATION_ERROR',
          message: err.message,
          retryable: false
        }
      });
      continue;
    }
    try {
      const result = transaction(() => {
        const existing = one(`SELECT * FROM events WHERE owner_id = ? AND source_method = 'plugin' AND client_event_id = ?`,
          [device.owner_id, normal.client_event_id]);
        if (existing) {
          if (existing.payload_hash !== normal.payload_hash) {
            throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一事件 ID 被用于不同内容');
          }
          return {
            client_event_id: normal.client_event_id,
            accepted: true,
            duplicate: true,
            event_id: existing.id,
            processing_state: existing.processing_state,
            application_id: existing.application_id || null
          };
        }
        const eventId = newId('evt');
        const receivedAt = nowIso();
        const skew = Math.abs(Date.parse(normal.observed_at) - Date.parse(normal.occurred_at)) > 2 * 3600_000
          || Date.parse(normal.observed_at) > Date.now() + 5 * 60_000;
        run(`INSERT INTO events
          (id, owner_id, client_event_id, source_method, event_type, site_key, occurred_at, observed_at, received_at,
           schema_version, adapter_version, evidence_level, evidence_code, payload_json, payload_hash,
           processing_state, clock_skew_flag)
          VALUES (?, ?, ?, 'plugin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [eventId, device.owner_id, normal.client_event_id, normal.event_type, normal.site_key,
          normal.occurred_at, normal.observed_at, receivedAt, normal.schema_version, normal.adapter_version,
          normal.evidence_level, normal.evidence_code, JSON.stringify(normal.payload), normal.payload_hash,
          skew ? 1 : 0]);
        run('UPDATE plugin_devices SET last_event_at = ? WHERE id = ?', [receivedAt, device.id]);
        const event = one('SELECT * FROM events WHERE id = ? AND owner_id = ?', [eventId, device.owner_id]);
        event.payload = JSON.parse(event.payload_json);
        const processed = processPluginEvent(event);
        const current = one('SELECT * FROM events WHERE id = ?', [eventId]);
        return {
          client_event_id: normal.client_event_id,
          accepted: true,
          duplicate: false,
          event_id: eventId,
          processing_state: current.processing_state,
          application_id: current.application_id || null,
          review_item_id: processed.review?.id || null
        };
      });
      results.push(result);
    } catch (err) {
      if (err instanceof AppError) {
        results.push({
          client_event_id: normal.client_event_id,
          accepted: false,
          duplicate: false,
          error: { code: err.code, message: err.message, retryable: !!err.retryable, details: err.details || undefined }
        });
      } else {
        console.error(JSON.stringify({ level: 'error', event: 'plugin_event_failed', message: err.message }));
        results.push({
          client_event_id: normal.client_event_id,
          accepted: true,
          duplicate: false,
          processing_state: 'failed',
          error: { code: 'EVENT_PROCESSING_FAILED', message: '事件已持久受理但处理失败，可联系支持排查', retryable: false }
        });
      }
    }
  }
  return { results, request_id: null };
}
