import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(DATA_DIR, 'outbox'), { recursive: true, mode: 0o700 });

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback = false) {
  if (process.env[name] == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name]).toLowerCase());
}

function loadOrCreateSecret(fileName) {
  const file = path.join(DATA_DIR, fileName);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const value = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, value + '\n', { mode: 0o600 });
  return value;
}

const masterKeyHex = process.env.MASTER_KEY || loadOrCreateSecret('master.key');
if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
  throw new Error('MASTER_KEY must be 64 hex characters (32 bytes).');
}
const internalTickToken = process.env.INTERNAL_TICK_TOKEN || loadOrCreateSecret('internal-tick.token');
const allowedEmails = new Set(
  (process.env.ALLOWED_EMAILS || 'demo@tounar.local,peer@tounar.local')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

export const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'tounar.sqlite'),
  webDir: path.join(ROOT, 'web'),
  host: process.env.HOST || '127.0.0.1',
  port: intEnv('PORT', 4310),
  appBaseUrl: (process.env.APP_BASE_URL || `http://127.0.0.1:${intEnv('PORT', 4310)}`).replace(/\/$/, ''),
  appEnv: process.env.APP_ENV || 'development',
  allowedEmails,
  masterKey: Buffer.from(masterKeyHex, 'hex'),
  otpPepper: process.env.OTP_PEPPER || crypto.createHash('sha256').update(masterKeyHex + ':otp').digest('hex'),
  sessionDays: intEnv('SESSION_DAYS', 30),
  otpTtlMinutes: intEnv('OTP_TTL_MINUTES', 10),
  otpMaxAttempts: intEnv('OTP_MAX_ATTEMPTS', 5),
  otpResendSeconds: intEnv('OTP_RESEND_SECONDS', 60),
  otpMaxPerHour: intEnv('OTP_MAX_PER_HOUR', 5),
  sensitiveReauthMinutes: intEnv('SENSITIVE_REAUTH_MINUTES', 10),
  internalTickToken,
  mailMode: process.env.MAIL_MODE || (process.env.SMTP_URL ? 'smtp' : 'outbox'),
  smtpUrl: process.env.SMTP_URL || '',
  mailFrom: process.env.MAIL_FROM || 'Tounar 帮你理 <no-reply@tounar.local>',
  outboxDir: path.join(DATA_DIR, 'outbox'),
  mailSyncMinutes: intEnv('MAIL_SYNC_MINUTES', 25),
  reminderHour: intEnv('REMINDER_HOUR', 8),
  reminderMinute: intEnv('REMINDER_MINUTE', 0),
  reminderTickSeconds: intEnv('REMINDER_TICK_SECONDS', 30),
  enableScheduler: boolEnv('ENABLE_SCHEDULER', true),
  browseArchiveDays: intEnv('BROWSE_ARCHIVE_DAYS', 0),
  browseArchiveSetClosed: boolEnv('BROWSE_ARCHIVE_SET_CLOSED', false),
  d05AllowTerminalCorrection: boolEnv('D05_ALLOW_TERMINAL_CORRECTION', false),
  d12AllowMissingJd: boolEnv('D12_ALLOW_MISSING_JD', false),
  d12AllowMissingLink: boolEnv('D12_ALLOW_MISSING_LINK', false),
  d12AllowMissingAppliedAt: boolEnv('D12_ALLOW_MISSING_APPLIED_AT', false),
  autoTerminalFromMail: boolEnv('AUTO_TERMINAL_FROM_MAIL', false),
  aIncludeNewViews: boolEnv('A_INCLUDE_NEW_VIEWS', false),
  aDeadlineHours: intEnv('A_DEADLINE_HOURS', 0),
  imapClientId: process.env.IMAP_CLIENT_ID || 'Tounar-BangNiLi/0.1',
  imapConnectTimeoutMs: intEnv('IMAP_CONNECT_TIMEOUT_MS', 20000),
  maxEventBatch: intEnv('MAX_EVENT_BATCH', 50),
  pairingTtlMinutes: intEnv('PAIRING_TTL_MINUTES', 10),
  deviceTokenDays: intEnv('DEVICE_TOKEN_DAYS', 180),
  reminderLinkDays: intEnv('REMINDER_LINK_DAYS', 14),
  confirmationTtlMinutes: intEnv('CONFIRMATION_TTL_MINUTES', 10)
};

export const featureFlags = {
  D01: 'provisional: visible cumulative >=3s; exact semantics pending',
  D02: 'pending: supported Web details + confirmed submission only; chat not collected',
  D03: config.browseArchiveDays > 0 ? `enabled: ${config.browseArchiveDays} days` : 'disabled pending decision',
  D04: 'provisional: stable IDs/canonical URL only; company+title is review candidate',
  D05: config.d05AllowTerminalCorrection ? 'enabled by env' : 'disabled pending decision',
  D06: 'provisional: weekly_monday, threshold 14, 7-day B frequency; parameterized',
  D07: 'no inferred interview completion; explicit confirmation only',
  D08: 'provisional: terminal transitions require review unless configured',
  D09: 'no OCR; headers-only or matched body; body not retained; 30-day first scan',
  D10: 'custom local pairing/whitelist; external platform verification blocked (G01/G03)',
  D11: '08:00 Asia/Shanghai trigger; delivery not guaranteed',
  D12: 'formal entry requires complete core fields unless env override',
  D13: 'keep +归档线索 label; no note field'
};
