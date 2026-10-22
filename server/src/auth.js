import crypto from 'node:crypto';
import { config } from './config.js';
import { ensurePreferences, one, run, transaction } from './db.js';
import {
  AppError, assert, hashSecret, isValidEmail, newId, normalizeEmail, nowIso, randomToken, sha256
} from './util.js';
import { sendOtpMail } from './mailer.js';

const OTP_CONTEXT = 'tounar-otp-v1';

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function sessionCookie(token, maxAgeSeconds) {
  const secure = config.appBaseUrl.startsWith('https://') ? '; Secure' : '';
  return `tounar_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearSessionCookie() {
  const secure = config.appBaseUrl.startsWith('https://') ? '; Secure' : '';
  return `tounar_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function otpHash(email, code) {
  return sha256(`${config.otpPepper}:${OTP_CONTEXT}:${email}:${code}`);
}

function rateLimit(key, windowSeconds, limit) {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const row = one('SELECT count FROM rate_limits WHERE key = ? AND window_start = ?', [key, bucket]);
  if (row && row.count >= limit) return false;
  run(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1`, [key, bucket]);
  if (Math.random() < 0.02) {
    run('DELETE FROM rate_limits WHERE window_start < ?', [bucket - 10]);
  }
  return true;
}

export async function requestOtp(emailRaw, req) {
  const email = normalizeEmail(emailRaw);
  assert(isValidEmail(email), 400, 'VALIDATION_ERROR', '请输入有效邮箱地址');
  const ipHash = sha256(`${config.otpPepper}:ip:${req.socket?.remoteAddress || ''}`).slice(0, 32);
  if (!rateLimit(`otp:ip:${ipHash}`, 3600, 20)) {
    throw new AppError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试', { retryable: true });
  }
  if (!rateLimit(`otp:email:${email}`, 3600, config.otpMaxPerHour)) {
    throw new AppError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试', { retryable: true });
  }
  const latest = one('SELECT created_at FROM otp_challenges WHERE email_normalized = ? ORDER BY created_at DESC LIMIT 1', [email]);
  if (latest) {
    const elapsed = (Date.now() - Date.parse(latest.created_at)) / 1000;
    if (elapsed < config.otpResendSeconds) {
      throw new AppError(429, 'RATE_LIMITED', '验证码发送过于频繁，请稍后再试', {
        retryable: true,
        details: { retry_after: Math.ceil(config.otpResendSeconds - elapsed) }
      });
    }
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const challengeId = newId('otp');
  const expiresAt = new Date(Date.now() + config.otpTtlMinutes * 60000).toISOString();
  run(`INSERT INTO otp_challenges
    (id, email_normalized, code_hash, expires_at, attempts, max_attempts, created_at, request_ip_hash)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
  [challengeId, email, otpHash(email, code), expiresAt, config.otpMaxAttempts, nowIso(), ipHash]);

  try {
    await sendOtpMail(email, code, config.otpTtlMinutes);
  } catch (err) {
    run('UPDATE otp_challenges SET consumed_at = ? WHERE id = ?', [nowIso(), challengeId]);
    throw new AppError(503, 'UNAVAILABLE', '验证码邮件暂时无法发送，请稍后重试', {
      retryable: true,
      details: config.appEnv === 'development' ? { reason: err.message } : null
    });
  }
  return {
    sent: true,
    expires_in: config.otpTtlMinutes * 60,
    resend_after: config.otpResendSeconds
  };
}

function verifyChallenge(email, code, { consume = true } = {}) {
  assert(/^\d{6}$/.test(String(code || '')), 400, 'VALIDATION_ERROR', '请输入 6 位验证码');
  const challenge = one(`SELECT * FROM otp_challenges
    WHERE email_normalized = ? AND consumed_at IS NULL
    ORDER BY created_at DESC LIMIT 1`, [email]);
  if (!challenge) throw new AppError(400, 'OTP_INVALID', '验证码无效或已过期，请重新获取');
  if (Date.parse(challenge.expires_at) < Date.now()) {
    run('UPDATE otp_challenges SET consumed_at = ? WHERE id = ?', [nowIso(), challenge.id]);
    throw new AppError(400, 'OTP_EXPIRED', '验证码已过期，请重新获取');
  }
  if (challenge.attempts >= challenge.max_attempts) {
    throw new AppError(429, 'OTP_TOO_MANY', '验证码尝试次数过多，请重新获取');
  }
  const actual = otpHash(email, String(code));
  if (!crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(challenge.code_hash, 'hex'))) {
    run('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?', [challenge.id]);
    throw new AppError(400, 'OTP_INVALID', '验证码不正确，请检查后重试');
  }
  if (consume) run('UPDATE otp_challenges SET consumed_at = ? WHERE id = ?', [nowIso(), challenge.id]);
  return challenge;
}

function issueSession(ownerId, req) {
  const token = 'sess_' + randomToken(32);
  const now = nowIso();
  const sessionId = newId('ses');
  const expiresAt = new Date(Date.now() + config.sessionDays * 86400000).toISOString();
  const uaHash = sha256(String(req.headers['user-agent'] || '')).slice(0, 32);
  run(`INSERT INTO sessions (id, token_hash, owner_id, created_at, auth_at, expires_at, user_agent_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [sessionId, sha256(token), ownerId, now, now, expiresAt, uaHash]);
  return { token, expiresAt, sessionId };
}

export async function verifyOtp(emailRaw, code, req) {
  const email = normalizeEmail(emailRaw);
  assert(isValidEmail(email), 400, 'VALIDATION_ERROR', '请输入有效邮箱地址');
  const challenge = verifyChallenge(email, code);
  if (!config.allowedEmails.has(email)) {
    throw new AppError(403, 'NOT_ALLOWLISTED', '当前账号暂未获得内测资格');
  }
  let user = one('SELECT * FROM users WHERE email_normalized = ?', [email]);
  if (user?.deletion_blocked) {
    throw new AppError(403, 'DELETION_IN_PROGRESS', '该账号的数据删除任务尚未完成，暂不能登录');
  }
  if (!user) {
    const ownerId = newId('usr');
    transaction(() => {
      run(`INSERT INTO users (id, email_normalized, email_display, allowlisted, created_at, last_login_at)
           VALUES (?, ?, ?, 1, ?, ?)`, [ownerId, email, email, nowIso(), nowIso()]);
      ensurePreferences(ownerId);
    });
    user = one('SELECT * FROM users WHERE id = ?', [ownerId]);
  } else {
    run('UPDATE users SET last_login_at = ?, allowlisted = 1 WHERE id = ?', [nowIso(), user.id]);
  }
  const session = issueSession(user.id, req);
  return {
    user: { owner_id: user.id, email: user.email_display, allowlisted: true },
    session,
    challenge_id: challenge.id
  };
}

export async function reauthenticate(req, emailRaw, code) {
  const auth = requireAuth(req);
  const email = normalizeEmail(emailRaw);
  if (email !== auth.user.email_normalized) {
    throw new AppError(403, 'FORBIDDEN', '重新验证的邮箱与当前账号不一致');
  }
  verifyChallenge(email, code);
  run('UPDATE sessions SET auth_at = ? WHERE id = ?', [nowIso(), auth.session.id]);
  return { reauthenticated: true, auth_at: nowIso() };
}

export function requireAuth(req, { allowDeletionBlocked = false } = {}) {
  if (req.auth) return req.auth;
  const cookies = parseCookies(req.headers.cookie || '');
  const header = String(req.headers.authorization || '');
  let token = null;
  if (header.startsWith('Bearer sess_')) token = header.slice(7).trim();
  else if (cookies.tounar_session) token = cookies.tounar_session;
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
  const row = one(`SELECT s.id AS session_id, s.auth_at AS session_auth_at, s.expires_at, s.revoked_at,
      u.*
    FROM sessions s JOIN users u ON u.id = s.owner_id
    WHERE s.token_hash = ?`, [sha256(token)]);
  if (!row || row.revoked_at || Date.parse(row.expires_at) < Date.now()) {
    throw new AppError(401, 'UNAUTHENTICATED', '登录状态已失效，请重新登录');
  }
  if (row.deletion_blocked && !allowDeletionBlocked) {
    throw new AppError(403, 'DELETION_IN_PROGRESS', '该账号正在进行数据删除，暂不能访问业务数据');
  }
  req.auth = {
    session: { id: row.session_id, auth_at: row.session_auth_at },
    user: row,
    ownerId: row.id
  };
  return req.auth;
}

export function requireRecentAuth(req) {
  const auth = requireAuth(req);
  const age = (Date.now() - Date.parse(auth.session.auth_at)) / 60000;
  if (age > config.sensitiveReauthMinutes) {
    throw new AppError(403, 'REAUTH_REQUIRED', '这是敏感操作，请先重新验证邮箱');
  }
  return auth;
}

export function revokeSession(req) {
  const auth = requireAuth(req);
  run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [nowIso(), auth.session.id]);
  return { revoked: true };
}

export function authMe(auth) {
  return {
    user: {
      email: auth.user.email_display,
      allowlisted: !!auth.user.allowlisted,
      created_at: auth.user.created_at
    },
    capabilities: {
      auth_mode: 'local_email_otp',
      mail: config.mailMode === 'smtp' ? 'smtp_configured' : 'development_outbox',
      plugin_pairing: 'local_protocol',
      external_qq_verified: false
    }
  };
}
