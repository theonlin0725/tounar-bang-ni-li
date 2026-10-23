import crypto from 'node:crypto';
import { config } from './config.js';

export const STATUSES = ['pending', 'applied', 'assessment', 'interview', 'offer', 'rejected', 'closed'];
export const TERMINAL = new Set(['offer', 'rejected', 'closed']);
export const APPLIED_STATUSES = new Set(['applied', 'assessment', 'interview', 'offer', 'rejected']);
export const STATUS_LABELS = {
  pending: '待投递',
  applied: '已投递',
  assessment: '笔试中',
  interview: '面试中',
  offer: 'offer',
  rejected: '已拒',
  closed: '已结束'
};
export const STATUS_RANK = { pending: 0, applied: 1, assessment: 2, interview: 3, offer: 4, rejected: 4, closed: 5 };

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hashSecret(value, pepper = '') {
  return sha256(`${pepper}:${value}`);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

export function parseIso(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function parseDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const t = Date.parse(value + 'T00:00:00+08:00');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function shanghaiDateKey(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function shanghaiClock(input = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(input);
  return {
    hour: Number(parts.find((p) => p.type === 'hour')?.value || 0),
    minute: Number(parts.find((p) => p.type === 'minute')?.value || 0)
  };
}

export function daysBetweenShanghai(fromIso, toIso = new Date()) {
  if (!fromIso) return null;
  const a = shanghaiDateKey(fromIso);
  const b = shanghaiDateKey(toIso);
  if (!a || !b) return null;
  const n = Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  return n < 0 ? null : n;
}

export function maxIso(...values) {
  const valid = values.filter(Boolean).map((v) => Date.parse(v)).filter(Number.isFinite);
  if (!valid.length) return null;
  return new Date(Math.max(...valid)).toISOString();
}

export function isDueForReview(app, thresholdDays, asOf = new Date()) {
  if (!app || app.archived_at || !app.has_applied || TERMINAL.has(app.status) || !app.applied_at) return false;
  const daysApplied = daysBetweenShanghai(app.applied_at, asOf);
  const anchor = maxIso(app.applied_at, app.last_progress_at, app.last_reviewed_at);
  const daysAnchor = daysBetweenShanghai(anchor, asOf);
  return daysApplied != null && daysAnchor != null && daysApplied >= thresholdDays && daysAnchor >= thresholdDays;
}

export function stageFollowupState(app, days = 7, asOf = new Date()) {
  const anchor = maxIso(app.stage_anchor_at, app.last_reviewed_at);
  const elapsed = anchor ? daysBetweenShanghai(anchor, asOf) : null;
  return { anchor, elapsed, received_at: app.stage_received_at,
    due: [7,14].includes(Number(days)) && app.stage_last_notified_anchor !== anchor && !app.archived_at && !!app.has_applied && ['assessment','interview'].includes(app.status) && elapsed != null && elapsed >= Number(days) };
}

export function normalizeWhitespace(value, max = 2000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function clipText(value, max = 80) {
  const s = normalizeWhitespace(value, max * 4);
  return Array.from(s).slice(0, max).join('');
}

export function normalizeCompanyKey(value) {
  return normalizeWhitespace(value, 200)
    .toLowerCase()
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[\s·•,，.。有限公司股份集团]+/g, '')
    .slice(0, 80);
}

export function isSafeHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname;
  } catch {
    return false;
  }
}

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'from', 'spm', 'source', 'src', 'ref', 'referrer', 'share_token', 'scene'
]);

export function sanitizeUrl(value) {
  if (!isSafeHttpUrl(value)) return null;
  const u = new URL(value);
  u.hostname = u.hostname.toLowerCase();
  u.username = ''; u.password = '';
  u.pathname = u.pathname.replace(/;(?:jsessionid|phpsessid|sessionid|sid)=[^/;?#]*/gi, '');
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_') || /^(sid|session|sessionid|jsessionid|phpsessid|token|access_token|auth|authorization|code|state|email|phone)$/i.test(key)) {
      u.searchParams.delete(key);
    }
  }
  if (/^#!?\//.test(u.hash)) {
    const route = new URL(u.hash.replace(/^#!/, '#').slice(1), u.origin);
    route.pathname = route.pathname.replace(/;(?:jsessionid|phpsessid|sessionid|sid)=[^/;?#]*/gi, '');
    for (const key of [...route.searchParams.keys()]) if (TRACKING_PARAMS.has(key.toLowerCase()) || /^(utm_|sid$|session|jsessionid$|phpsessid$|token$|access_token$|auth|code$|state$|email$|phone$)/i.test(key)) route.searchParams.delete(key);
    u.hash = '#' + route.pathname + route.search;
  } else u.hash = '';
  return u.toString();
}

export function canonicalJobUrl(value) {
  const safe = sanitizeUrl(value);
  if (!safe) return null;
  const u = new URL(safe);
  // Keep path and semantically useful identifiers; remove common session/noise params.
  for (const key of [...u.searchParams.keys()]) {
    if (/^(sid|session|sessionid|token|auth|code|state)$/i.test(key)) u.searchParams.delete(key);
  }
  return u.toString();
}

export function extractDomain(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function safeJsonParse(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function payloadHash(payload) {
  return sha256(stableStringify(payload));
}

export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url')
  };
}

export function decryptSecret(ciphertext, ivB64, tagB64) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.masterKey, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

export function requestIpHash(req) {
  const ip = req.socket?.remoteAddress || '';
  return sha256(`${config.otpPepper}:ip:${ip}`).slice(0, 32);
}

export function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${name.slice(0, 1)}***@${domain}`;
}

export class AppError extends Error {
  constructor(status, code, message, { retryable = false, details = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function assert(condition, status, code, message, options) {
  if (!condition) throw new AppError(status, code, message, options);
}

export function isTerminal(status) {
  return TERMINAL.has(status);
}

export function sourceMethods(app) {
  return safeJsonParse(app.source_methods_json, []);
}

export function addSourceMethod(app, method) {
  const set = new Set(sourceMethods(app));
  set.add(method);
  return [...set];
}

export function sourceLabel(method) {
  return { plugin: '插件采集', mail: '招聘邮件', manual: '用户确认' }[method] || method;
}

export function errorCodeForStatus(status) {
  return {
    400: 'VALIDATION_ERROR',
    401: 'UNAUTHENTICATED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'VERSION_CONFLICT',
    429: 'RATE_LIMITED',
    503: 'UNAVAILABLE'
  }[status] || 'ERROR';
}
