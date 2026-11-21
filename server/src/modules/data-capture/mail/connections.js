import { all, one, run } from '../../../db.js';
import { AppError, encryptSecret, newId, nowIso, normalizeEmail, assert, safeJsonParse } from '../../../util.js';
import { syncConnection } from './sync.js';

import { imapHostFor, supportedMailProviderLabels } from './providers.js';

const CONSENT = 'MAIL_RECRUITMENT_READ_V2';

function projection(row) {
  const stats = safeJsonParse(row.last_sync_stats_json, null);
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
    remaining: stats?.remaining ?? null,
    sync_stats: stats,
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
  assert(email.includes('@'), 400, 'VALIDATION_ERROR', '请输入邮箱地址');
  if (!imapHostFor(email)) throw new AppError(400, 'VALIDATION_ERROR', `支持 ${supportedMailProviderLabels().join('、')}`);
  const authCode = String(body.auth_code || '').replace(/\s+/g, '');
  if (authCode.length < 8 || authCode.length > 64) throw new AppError(400, 'VALIDATION_ERROR', '请输入邮箱客户端授权码（IMAP/SMTP 授权码，非登录密码）');
  const mode = body.consent_version === CONSENT ? 'recruitment_body' : body.mode || 'headers_only';
  if (!['headers_only', 'recruitment_body'].includes(mode)) throw new AppError(400, 'VALIDATION_ERROR', 'mode 无效');
  if (body.consent_version !== CONSENT && !(imapHostFor(email) === 'imap.qq.com' && body.consent_version === 'QQ_MAIL_READ_CONSENT_V1')) {
    throw new AppError(400, 'VALIDATION_ERROR', '请先阅读并同意招聘邮箱只读授权说明');
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
    VALUES (?, ?, ?, ?, ?, 'connecting', ?, ?, ?, ?, ?, ?)`,
  [id, ownerId, email, mode, scanSince.toISOString(), body.consent_version, enc.ciphertext, enc.iv, enc.tag, nowIso(), nowIso()]);
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
  if (authCode.length < 8 || authCode.length > 64) throw new AppError(400, 'VALIDATION_ERROR', '请输入新的邮箱客户端授权码');
  if (body.consent_version && ![CONSENT, 'QQ_MAIL_READ_CONSENT_V1'].includes(body.consent_version)) {
    throw new AppError(400, 'VALIDATION_ERROR', '授权同意版本不匹配');
  }
  const other = one("SELECT id FROM mail_connections WHERE owner_id=? AND id<>? AND status<>'disconnected'", [ownerId,id]);
  if (other) throw new AppError(409,'MAIL_CONNECTION_EXISTS','已有其他邮箱连接');
  const enc = encryptSecret(authCode);
  run(`UPDATE mail_connections SET credential_ciphertext = ?, credential_iv = ?, credential_tag = ?, status = 'connecting', mode = ?, consent_version = ?,
       binding_version = binding_version + 1, last_error_code = NULL, last_error_message = NULL, sync_lease_until = NULL,
       sync_lease_owner = NULL, updated_at = ? WHERE id = ? AND owner_id = ?`,
  [enc.ciphertext, enc.iv, enc.tag, body.consent_version === CONSENT ? 'recruitment_body' : row.mode, body.consent_version || row.consent_version, nowIso(), id, ownerId]);
  kickSync(id);
  return { __status: 202, ...projection(one('SELECT * FROM mail_connections WHERE id = ?', [id])) };
}

export function updateMailConnectionMode(ownerId, id, body = {}) {
  const row = one('SELECT * FROM mail_connections WHERE id = ? AND owner_id = ?', [id, ownerId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', '邮箱连接不存在');
  if (row.status === 'disconnected') throw new AppError(409, 'MAIL_DISCONNECTED', '邮箱授权已断开，请重新授权');
  const mode = String(body.mode || '');
  if (!['headers_only', 'recruitment_body'].includes(mode)) throw new AppError(400, 'VALIDATION_ERROR', 'mode 无效');
  if (mode === 'recruitment_body' && ![CONSENT, 'QQ_MAIL_READ_CONSENT_V1'].includes(body.consent_version)) {
    throw new AppError(400, 'VALIDATION_ERROR', '切换到招聘候选正文模式前，请重新确认只读授权说明');
  }
  if (row.mode === mode) return { ...projection(row), changed: false };
  // 切换读取范围同样递增绑定版本并清掉在途租约，旧任务不得继续按旧范围写库。
  run(`UPDATE mail_connections SET mode = ?, consent_version = ?, binding_version = binding_version + 1,
       sync_lease_until = NULL, sync_lease_owner = NULL, last_error_code = NULL, last_error_message = NULL,
       updated_at = ? WHERE id = ? AND owner_id = ?`,
  [mode, body.consent_version || row.consent_version, nowIso(), id, ownerId]);
  kickSync(id);
  return { __status: 202, changed: true, ...projection(one('SELECT * FROM mail_connections WHERE id = ?', [id])) };
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
    provider: 'imap',
    providers: ['qq.com','foxmail.com','vip.qq.com','163.com','126.com','yeah.net'],
    provider_labels: supportedMailProviderLabels(),
    modes: ['headers_only', 'recruitment_body'],
    configured: true,
    external_verified: false
  };
}
