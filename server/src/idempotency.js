import { one, run } from './db.js';
import { AppError, newId, nowIso, stableStringify } from './util.js';
import { jsonStatus, stripInternal } from './http.js';

export function requestHash(req, extra = {}) {
  return stableStringify({
    method: req.method,
    path: req.url?.split('?')[0] || '',
    params: req.params || {},
    body: req.body || {},
    extra
  });
}

export function requireIdempotencyKey(req) {
  const key = String(req.headers['idempotency-key'] || '').trim();
  if (!key || key.length < 8 || key.length > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', '缺少或无效的 Idempotency-Key');
  }
  return key;
}

/**
 * Executes a mutating handler at most once for an (owner, scope, key) tuple.
 * The stored response is replayed byte-for-byte for identical retries.
 */
export function withIdempotency({ ownerId, scope, req, handler, extra = {} }) {
  const key = requireIdempotencyKey(req);
  const hash = requestHash(req, extra);
  const existing = one('SELECT * FROM idempotency_keys WHERE owner_id = ? AND scope = ? AND key = ?', [ownerId, scope, key]);
  if (existing && Date.parse(existing.expires_at) >= Date.now()) {
    if (existing.request_hash !== hash) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键被用于不同请求，请重新发起');
    }
    return jsonStatus(existing.status_code, JSON.parse(existing.response_json));
  }
  const result = handler();
  const status = Number(result?.__status || 200);
  const payload = result?.__payload !== undefined ? result.__payload : stripInternal(result);
  run(`INSERT INTO idempotency_keys (owner_id, scope, key, request_hash, status_code, response_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, scope, key) DO UPDATE SET request_hash = excluded.request_hash,
         status_code = excluded.status_code, response_json = excluded.response_json, created_at = excluded.created_at,
         expires_at = excluded.expires_at`,
  [ownerId, scope, key, hash, status, JSON.stringify(payload), nowIso(),
    new Date(Date.now() + 24 * 3600000).toISOString()]);
  if (Math.random() < 0.02) run('DELETE FROM idempotency_keys WHERE expires_at < ?', [nowIso()]);
  return result;
}
