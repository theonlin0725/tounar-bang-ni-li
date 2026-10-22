import { config } from '../config.js';
import { all, one, run } from '../db.js';
import { AppError, encryptSecret, newId, nowIso, normalizeEmail, assert } from '../util.js';
import { syncConnection } from './mailSync.js';

const QQ_DOMAINS = new Set(['qq.com', 'foxmail.com', 'vip.qq.com']);

function projection(row) {
  return {
    id: row.id,
    email: row.email,
    mode: row.mode,
    scan_since: row.scan_since,
    status: row.status,
    consent_version: row.consent_version,
    last_sync_attempt_at: row.last_sync_attempt_at,
    last_sync_success_at: row.last_sync_success_at,
    last_error_code: row.last_error_code,
    last_error_message: row.last_error_message,
    first_scan_total: row.first_scan_total,
    first_scan_processed: row.first_scan_processed,
    binding_version: row.binding_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    credential_stored: !!row.credential_ciphertext
  };
}

function kickSync(connectionId) {
  setImmediate(() => {
    syncConnection(connectionId).catch((err) => {
      console.error(JSON.stringify({ level: 'error', event: 'mail_sync_kick_failed', connection_id: connectionId, message: err.message }));
    });
  });
}

export function createMailConnection(ownerId, body = {}) {
  const email = normalizeEmail(body.email);
  assert(email.includes('@'), 400, 'VALIDATION_ERROR', '请输入 QQ 邮箱地址');
  const domain = email.split('@')[1];
  if (!QQ_DOMAINS.has(domain)) throw new AppError(400, 'VALIDATION_ERROR', '一期仅支持 QQ 邮箱（qq.com / foxmail.com / vip.qq.com）');
  const authCode = String(body.auth_code || '').replace(/\s+/g, '');
  if (authCode.length < 8 || authCode.length > 64) throw new AppError(400, 'VALIDATION_ERROR', '请输入 QQ 邮箱授权码，而不是 QQ 登录密码');
  const mode = body.mode || 'headers_only';
  if (!['headers_only', 'recruitment_body'].includes(mode)) throw new AppError(400, 'VALIDATION_ERROR', 'mode 无效');
  if (body.consent_version !== 'QQ_MAIL_READ_CONSENT_V1') {
    throw new AppError(400, 'VALIDATION_ERROR', '请先阅读并同意 QQ 邮箱只读授权说明');
  }
  const scanSince = body.scan_since ? new Date(body.scan_since) : new Date(Date.now() - 30 * 86400000);
  if (Number.isNaN(scanSince.getTime())) throw new AppError(400, 'VALIDATION_ERROR', '首扫起始日无效');
  const active = one(`SELECT * FROM mail_connections WHERE owner_id = ? AND status <> 'disconnected'`, [ownerId]);
  if (active) throw new AppError(409, 'MAIL_CONNECTION_EXISTS', '当前账号已有邮箱连接；请先断开或重新授权', { details: { connection_id: active.id } });
  const enc = encryptSecret(authCode);
  const id = newId('mailconn');
  run(`INSERT INTO mail_connections
    (id, owner_id, email, mode, scan_since, status, consent_version, credential_ciphertext, credential_iv,
     credential_tag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'connecting', 'QQ_MAIL_READ_CONSENT_V1', ?, ?, ?, ?, ?)`,
  [id, ownerId, email, mode, scanSince.toISOString(), enc.ciphertext, enc.iv, enc.tag, nowIso(), nowIso()]);
  kickSync(id);
  return { __status: 202, ...projection(one('SELECT * FROM mail_connections WHERE id = ?', [id])) };
}

export function listMailConnections(ownerId) {
  return all('SELECT * FROM mail_connections WHERE owner_id = ? ORDER BY created_at DESC', [ownerId]).map(projection);
}

export function getMailConnection(ownerId, id) {
  const row = one('SELECT * FROM mail_connections WHERE id = ? AND owner_id = ?', [id, ownerId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', '邮箱连接不存在');
  return projection(row);
}

export function disconnectMailConnection(ownerId, id) {
  const row = one('SELECT * FROM mail_connections WHERE id = ? AND owner_id = ?', [id, ownerId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', '邮箱连接不存在');
  if (row.status === 'disconnected') {
    return { ...projection(row), historical_ledger_retained: true, message: '已断开；历史台账保留' };
  }
  run(`UPDATE mail_connections SET status = 'disconnected', credential_ciphertext = NULL, credential_iv = NULL,
       credential_tag = NULL, binding_version = binding_version + 1, sync_lease_until = NULL, sync_lease_owner = NULL,
       last_error_code = 'DISCONNECTED', last_error_message = NULL, updated_at = ? WHERE id = ? AND owner_id = ?`,
  [nowIso(), id, ownerId]);
  return {
    ...projection(one('SELECT * FROM mail_connections WHERE id = ?', [id])),
    historical_ledger_retained: true,
    message: '已停止授权并终止在途同步；历史台账不会被删除'
  };
}

export function reauthorizeMailConnection(ownerId, id, body = {}) {
  const row = one('SELECT * FROM mail_connections WHERE id = ? AND owner_id = ?', [id, ownerId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', '邮箱连接不存在');
  const authCode = String(body.auth_code || '').replace(/\s+/g, '');
  if (authCode.length < 8 || authCode.length > 64) throw new AppError(400, 'VALIDATION_ERROR', '请输入新的 QQ 邮箱授权码');
  if (body.consent_version && body.consent_version !== 'QQ_MAIL_READ_CONSENT_V1') {
    throw new AppError(400, 'VALIDATION_ERROR', '授权同意版本不匹配');
  }
  const enc = encryptSecret(authCode);
  run(`UPDATE mail_connections SET credential_ciphertext = ?, credential_iv = ?, credential_tag = ?, status = 'connecting',
       binding_version = binding_version + 1, last_error_code = NULL, last_error_message = NULL, sync_lease_until = NULL,
       sync_lease_owner = NULL, updated_at = ? WHERE id = ? AND owner_id = ?`,
  [enc.ciphertext, enc.iv, enc.tag, nowIso(), id, ownerId]);
  kickSync(id);
  return { __status: 202, ...projection(one('SELECT * FROM mail_connections WHERE id = ?', [id])) };
}

export function triggerMailSync(ownerId, id) {
  const row = one('SELECT * FROM mail_connections WHERE id = ? AND owner_id = ?', [id, ownerId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', '邮箱连接不存在');
  if (row.status === 'disconnected') throw new AppError(409, 'MAIL_DISCONNECTED', '邮箱授权已断开，请重新授权');
  kickSync(id);
  return { __status: 202, accepted: true, connection_id: id, note: '异步同步已受理，不代表已连接' };
}

export function mailCapabilities() {
  return {
    provider: 'qq_imap',
    host: process.env.IMAP_HOST || 'imap.qq.com',
    modes: ['headers_only', 'recruitment_body'],
    configured: config.mailMode === 'smtp',
    external_verified: false
  };
}
