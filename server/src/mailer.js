import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { AppError, escapeHtml, nowIso, randomToken } from './util.js';

let transport = null;

/**
 * 从 SMTP_URL 构造 nodemailer 传输配置。
 * 说明：nodemailer 在传入 URL 字符串时不会自动按端口推断 TLS，
 * 导致 465 端口以明文握手、收不到服务端问候语（Greeting never received）。
 * 因此这里显式解析 URL：465 强制 secure，587 强制 STARTTLS。
 */
function buildTransportOptions(smtpUrl) {
  const parsed = new URL(smtpUrl);
  const port = Number(parsed.port || (parsed.protocol === 'smtps:' ? 465 : 587));
  const auth = {
    user: decodeURIComponent(parsed.username || ''),
    pass: decodeURIComponent(parsed.password || '')
  };
  const opts = {
    host: parsed.hostname,
    port,
    auth,
    connectionTimeout: 25000,
    greetingTimeout: 25000,
    socketTimeout: 25000
  };
  if (port === 465) {
    opts.secure = true;
    opts.tls = { servername: parsed.hostname };
  } else {
    opts.secure = false;
    opts.requireTLS = true;
  }
  return opts;
}

function getTransport() {
  if (config.mailMode !== 'smtp') return null;
  if (!config.smtpUrl) throw new AppError(503, 'UNAVAILABLE', '提醒发信服务尚未配置（SMTP_URL 缺失）', { retryable: true });
  if (!transport) transport = nodemailer.createTransport(buildTransportOptions(config.smtpUrl));
  return transport;
}

export async function sendMail({ to, subject, text, html, kind = 'mail', metadata = {} }) {
  if (config.mailMode === 'outbox') {
    const id = `outbox_${Date.now()}_${randomToken(6)}`;
    const record = {
      id,
      kind,
      to,
      from: config.mailFrom,
      subject,
      text,
      html,
      metadata,
      created_at: nowIso(),
      transport: 'outbox'
    };
    fs.mkdirSync(config.outboxDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(config.outboxDir, `${id}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
    return { messageId: id, accepted: [to], transport: 'outbox' };
  }
  const tx = getTransport();
  const info = await tx.sendMail({ from: config.mailFrom, to, subject, text, html });
  return { messageId: info.messageId, accepted: info.accepted || [], transport: 'smtp' };
}

export async function sendOtpMail(email, code, ttlMinutes) {
  const subject = '【Tounar 帮你理】登录验证码';
  const text = `你的帮你理登录验证码是 ${code}，${ttlMinutes} 分钟内有效。\n如果不是你本人操作，请忽略这封邮件。`;
  const html = `<p>你的帮你理登录验证码是：</p><p style="font-size:28px;letter-spacing:6px;font-family:monospace"><strong>${escapeHtml(code)}</strong></p><p>${ttlMinutes} 分钟内有效。如果不是你本人操作，请忽略这封邮件。</p>`;
  return sendMail({ to: email, subject, text, html, kind: 'otp', metadata: { purpose: 'login_otp', dev_code: code } });
}
