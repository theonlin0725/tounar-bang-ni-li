import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from '../../config.js';
import { AppError, newId, nowIso, randomToken } from '../../util.js';

import { run } from '../../db.js';
import { renderTemplate } from './templates.js';

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

async function deliverMail({ to, subject, text, html, kind = 'mail', metadata = {} }) {
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

export function publicMailError(err) {
  const code = String(err?.code || 'SEND_FAILED').slice(0, 80);
  const unknown = /timeout|timed out|ECONNRESET|ETIMEDOUT|socket/i.test(String(err?.message || '') + code);
  const messages = {
    EAUTH: 'SMTP 认证失败，请检查发件邮箱和授权码。',
    ECONNECTION: '无法连接 SMTP 服务，请检查网络、主机和端口。',
    EDNS: '无法解析 SMTP 主机，请检查网络和主机名。',
    EENVELOPE: 'SMTP 拒绝了收件人或发件人，请核对邮箱与服务商限制。',
    RECIPIENT_REJECTED: 'SMTP 未接受目标收件人，请核对邮箱地址和服务商限制。',
    TEMPLATE_INVALID: err?.message || '模板校验失败，请到模板面板修正。'
  };
  return { code, status: unknown ? 'delivery_unknown' : 'failed', message: unknown ? '连接中断或超时，无法确定是否已送达；请先检查收件箱，再决定是否重发。' : messages[code] || '发信失败，请检查 SMTP 配置和服务可用性。' };
}
export async function sendMail(message) {
  const id = newId('delivery'), at = nowIso(), meta = message.metadata || {};
  // 不存正文与变量，避免真实 OTP、私人邮件或令牌进入管理日志。
  const context = { run_id: meta.test_run_id || null, batch_id: meta.batch_id || null, application_id: meta.application_id || null, mode: meta.test_mode || 'business' };
  run(`INSERT INTO mail_deliveries (id,owner_id,recipient,kind,subject,versions_json,context_json,status,transport,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'sending',?,?,?)`, [id, meta.owner_id || null, message.to, message.kind || 'mail', message.subject, JSON.stringify(meta.template_versions || {}), JSON.stringify(context), config.mailMode, at, at]);
  try {
    const result = await deliverMail(message);
    const expected = String(message.to).toLowerCase();
    if (!result.accepted.some(x => String(x?.address || x).toLowerCase() === expected)) throw new AppError(502, 'RECIPIENT_REJECTED', 'SMTP 未接受目标收件人');
    const status = result.transport === 'smtp' ? 'accepted' : 'outbox_written';
    run('UPDATE mail_deliveries SET status=?,provider_message_id=?,updated_at=? WHERE id=?', [status, result.messageId || null, nowIso(), id]);
    return { ...result, delivery_id: id, status };
  } catch (err) {
    const safe = publicMailError(err);
    run('UPDATE mail_deliveries SET status=?,error_code=?,error_message=?,updated_at=? WHERE id=?', [safe.status, safe.code, safe.message, nowIso(), id]);
    throw err;
  }
}
export async function sendOtpMail(email, code, ttlMinutes) {
  const rendered = renderTemplate('otp', { code, ttl_minutes: String(ttlMinutes) });
  return sendMail({ to: email, ...rendered, kind: 'otp', metadata: { purpose: 'login_otp', dev_code: code, template_versions: { otp: rendered.version } } });
}
