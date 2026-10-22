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
  // 发布到托管沙箱时反向代理要求监听 0.0.0.0；本地想收窄可用 HOST=127.0.0.1 覆盖
  host: process.env.HOST || '0.0.0.0',
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
  // D03 已冻结（2026-10-22）：看过未投的线索 30 天自动归档，保留可查、不计入累计投递
  browseArchiveDays: intEnv('BROWSE_ARCHIVE_DAYS', 30),
  browseArchiveSetClosed: boolEnv('BROWSE_ARCHIVE_SET_CLOSED', false),
  // D05 已冻结（2026-10-22）：终态允许人工纠错（强制填原因 + 全程留痕），机器不写死
  d05AllowTerminalCorrection: boolEnv('D05_ALLOW_TERMINAL_CORRECTION', true),
  d12AllowMissingJd: boolEnv('D12_ALLOW_MISSING_JD', false),
  d12AllowMissingLink: boolEnv('D12_ALLOW_MISSING_LINK', false),
  d12AllowMissingAppliedAt: boolEnv('D12_ALLOW_MISSING_APPLIED_AT', false),
  // P2（2026-10-22）：邮件里没有投递时间时，用「收到该邮件的时间」作为 ≤ 收信日的推断值。
  // 只用于邮件线索的自动/确认更新，并标记 applied_at_precision = inferred_before；默认开，可用环境变量关闭。
  d12AllowMailInferredAppliedAt: boolEnv('D12_ALLOW_MAIL_INFERRED_APPLIED_AT', true),
  // 待确认「确认更新」后可撤回的时间窗（界面 toast 10 秒，服务端留安全余量）
  reviewUndoMinutes: intEnv('REVIEW_UNDO_MINUTES', 10),
  // D08 已冻结（2026-10-22）：高置信度（默认 ≥0.9）自动判定终态；低置信度进待确认。
  // P2 起插件「官网投递记录页」的终态也走同一套规则，本开关同时约束两个来源。
  autoTerminalFromMail: boolEnv('AUTO_TERMINAL_FROM_MAIL', true),
  autoTerminalConfidence: Number.parseFloat(process.env.AUTO_TERMINAL_CONFIDENCE || '0.9'),
  // P2（2026-10-22）：非终态（面邀/笔试/测评）自动更新台账的总把握度阈值。
  // 总把握度 = 分类/证据置信度 × 候选匹配把握度；且必须只有 1 个候选。默认 0.8。
  // 邮件和插件状态页共用这个阈值。
  mailAutoUpdateConfidence: Number.parseFloat(process.env.MAIL_AUTO_UPDATE_CONFIDENCE || '0.8'),
  // D08 已冻结：待确认队列每 15 天随提醒邮件汇总一次
  reviewDigestDays: intEnv('REVIEW_DIGEST_DAYS', 15),
  aIncludeNewViews: boolEnv('A_INCLUDE_NEW_VIEWS', false),
  aDeadlineHours: intEnv('A_DEADLINE_HOURS', 0),
  imapClientId: process.env.IMAP_CLIENT_ID || 'Tounar-BangNiLi/0.1',
  imapConnectTimeoutMs: intEnv('IMAP_CONNECT_TIMEOUT_MS', 20000),
  maxEventBatch: intEnv('MAX_EVENT_BATCH', 50),
  pairingTtlMinutes: intEnv('PAIRING_TTL_MINUTES', 10),
  deviceTokenDays: intEnv('DEVICE_TOKEN_DAYS', 180),
  reminderLinkDays: intEnv('REMINDER_LINK_DAYS', 14),
  confirmationTtlMinutes: intEnv('CONFIRMATION_TTL_MINUTES', 10),
  // WorkBuddy 云服务（wbapp_Yw3dKlnEp4jVVAuyNDilAW）：免密钥大模型，用于邮件/页面线索的兜底识别（D09 第一阶段）。
  // endpoint/publishableKey 属于可公开配置；置空则云端能力整体关闭，自动回退纯规则解析。
  cloudEndpoint: process.env.CLOUD_ENDPOINT || '',
  cloudPublishableKey: process.env.CLOUD_PUBLISHABLE_KEY || '',
  cloudLlmEnabled: boolEnv('CLOUD_LLM_ENABLED', true),
  cloudLlmTimeoutMs: intEnv('CLOUD_LLM_TIMEOUT_MS', 20000)
};

export const featureFlags = {
  D01: 'frozen 2026-10-22: visible cumulative >=3s; background pause; per-job re-count',
  D02: 'frozen 2026-10-22: whitelist = tencent/bytedance/alibaba/meituan/jd/xiaomi/baidu/netease; chat not collected; expand-all-sites planned',
  D03: config.browseArchiveDays > 0 ? `frozen: ${config.browseArchiveDays} days auto-archive, kept queryable` : 'disabled',
  D04: 'frozen 2026-10-22: repeat submissions on different days = separate records; company+title only => review candidate; company filter planned',
  D05: config.d05AllowTerminalCorrection ? 'frozen: manual correction allowed, reason required, fully audited' : 'disabled by env',
  D06: 'frozen 2026-10-22: daily digest; status-updated records silenced next day (consumed outbox); B-class 7-day per-record throttle',
  D07: 'frozen: no inferred interview completion; 已面 N 天 as email tag only',
  D08: `frozen: auto terminal when confidence >= ${config.autoTerminalConfidence}; else review; review digest every ${config.reviewDigestDays} days`,
  D09: 'frozen direction 2026-10-22: LLM for plugin scanning (site recognition / user behavior / lead capture); phase 1 live 2026-10-22: WorkBuddy cloud keyless LLM as mail-parse fallback (never auto-terminal, always review)',
  D10: 'custom local pairing/whitelist; external platform verification blocked (G01/G03)',
  D11: 'frozen: 08:00 Asia/Shanghai trigger; same-day retry; no second-precision guarantee',
  D12: 'frozen: auto-capture default; manual entry fallback with lead autofill',
  D13: 'pending user decision (note field)'
};
