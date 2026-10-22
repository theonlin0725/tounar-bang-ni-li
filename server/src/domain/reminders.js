import crypto from 'node:crypto';
import { config } from '../config.js';
import { all, bumpRevision, dataRevision, getApplication, one, run, transaction } from '../db.js';
import {
  AppError, STATUS_LABELS, daysBetweenShanghai, decryptSecret, encryptSecret, escapeHtml, isDueForReview,
  newId, nowIso, randomToken, safeJsonParse, shanghaiClock, shanghaiDateKey, sha256, sourceMethods
} from '../util.js';
import { getPreferences } from './applications.js';
import { sendMail } from '../mailer.js';

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function appUrl(pathname = '/') {
  return config.appBaseUrl + pathname;
}

export function createReminderLink(ownerId, applicationId) {
  const token = 'rl_' + randomToken(28);
  const expiresAt = new Date(Date.now() + config.reminderLinkDays * 86400000).toISOString();
  run(`INSERT INTO reminder_links (id, token_hash, owner_id, application_id, action, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'reviewed_no_change', ?, ?)`,
  [newId('rlink'), tokenHash(token), ownerId, applicationId, expiresAt, nowIso()]);
  return { token, expires_at: expiresAt };
}

export function reminderLinkRead(ownerId, token) {
  const link = one('SELECT * FROM reminder_links WHERE token_hash = ?', [tokenHash(token)]);
  if (!link) throw new AppError(404, 'NOT_FOUND', '提醒链接无效或已过期');
  if (link.owner_id !== ownerId) throw new AppError(404, 'NOT_FOUND', '提醒链接无效或无权访问');
  if (Date.parse(link.expires_at) < Date.now()) throw new AppError(410, 'LINK_EXPIRED', '提醒链接已过期，请到本人台账继续');
  const app = getApplication(ownerId, link.application_id);
  if (!app) throw new AppError(404, 'NOT_FOUND', '记录不存在');
  const prefs = getPreferences(ownerId);
  return {
    token_valid: true,
    completed: !!link.completed_at,
    completed_result: safeJsonParse(link.confirmation_result_json, null),
    expires_at: link.expires_at,
    application: {
      id: app.id,
      company_name: app.company_name,
      job_title: app.job_title,
      status: app.status,
      status_label: STATUS_LABELS[app.status],
      applied_at: app.applied_at,
      days_since_applied: app.applied_at ? daysBetweenShanghai(app.applied_at) : null,
      last_progress_at: app.last_progress_at,
      last_site_observed_at: app.last_site_observed_at,
      last_reviewed_at: app.last_reviewed_at,
      version: app.version,
      status_url: app.status_url,
      status_url_scope: app.status_url_scope,
      job_url: app.job_url,
      primary_status_url: app.status_url || app.job_url,
      primary_status_url_scope: app.status_url ? (app.status_url_scope || 'application') : (app.job_url ? 'job' : null),
      review_threshold_days: prefs.review_threshold_days,
      source_methods: sourceMethods(app)
    }
  };
}

export function prepareReminderConfirmation({ ownerId, token, expectedVersion, idempotencyKey }) {
  return transaction(() => {
    const link = one('SELECT * FROM reminder_links WHERE token_hash = ? AND owner_id = ?', [tokenHash(token), ownerId]);
    if (!link) throw new AppError(404, 'NOT_FOUND', '提醒链接无效');
    if (Date.parse(link.expires_at) < Date.now()) throw new AppError(410, 'LINK_EXPIRED', '提醒链接已过期');
    if (link.completed_at) {
      return {
        confirmation_state: 'completed',
        application_id: link.application_id,
        result: safeJsonParse(link.confirmation_result_json, null),
        completed_at: link.completed_at
      };
    }
    const app = getApplication(ownerId, link.application_id);
    if (!app) throw new AppError(404, 'NOT_FOUND', '记录不存在');
    if (Number(expectedVersion) !== app.version) {
      throw new AppError(409, 'VERSION_CONFLICT', '记录已更新，请刷新后重新确认', {
        details: { current_version: app.version }
      });
    }
    const existing = one('SELECT * FROM reminder_confirmations WHERE link_id = ? AND idempotency_key = ?',
      [link.id, idempotencyKey]);
    if (existing) {
      if (existing.state === 'consumed') {
        return {
          confirmation_state: 'completed',
          application_id: existing.application_id,
          result: safeJsonParse(link.confirmation_result_json, null)
        };
      }
      if (existing.state === 'ready' && Date.parse(existing.expires_at) >= Date.now()) {
        const raw = decryptSecret(existing.token_ciphertext, existing.token_iv, existing.token_tag);
        return {
          confirmation_state: 'ready',
          confirmation_token: raw,
          expires_at: existing.expires_at,
          application_id: existing.application_id,
          application_version: existing.application_version
        };
      }
      run("UPDATE reminder_confirmations SET state = 'expired' WHERE id = ?", [existing.id]);
    }
    const confirmationToken = 'cf_' + randomToken(32);
    const enc = encryptSecret(confirmationToken);
    const expiresAt = new Date(Date.now() + config.confirmationTtlMinutes * 60000).toISOString();
    run(`INSERT INTO reminder_confirmations
      (id, link_id, owner_id, application_id, application_version, idempotency_key, token_hash,
       token_ciphertext, token_iv, token_tag, state, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
    [newId('rcf'), link.id, ownerId, app.id, app.version, idempotencyKey, tokenHash(confirmationToken),
      enc.ciphertext, enc.iv, enc.tag, expiresAt, nowIso()]);
    return {
      confirmation_state: 'ready',
      confirmation_token: confirmationToken,
      expires_at: expiresAt,
      application_id: app.id,
      application_version: app.version,
      note: '仅准备确认资格，尚未更新最近确认时间'
    };
  });
}

function isMondayShanghai(date = new Date()) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(date);
  return name === 'Mon';
}

export function buildReminderCandidates(ownerId, now = new Date()) {
  const prefs = getPreferences(ownerId);
  if (prefs.mode === 'off') return { prefs, a: [], b: [] };
  const apps = all('SELECT * FROM applications WHERE owner_id = ? AND archived_at IS NULL ORDER BY updated_at DESC', [ownerId]);
  const byId = new Map(apps.map((a) => [a.id, a]));
  const a = [];
  if (prefs.mode === 'all' || prefs.mode === 'changes_only') {
    const rows = all(`SELECT * FROM notification_outbox WHERE owner_id = ? AND consumed_batch_id IS NULL
      AND occurred_at >= ? ORDER BY occurred_at ASC LIMIT 100`,
    [ownerId, new Date(Date.now() - 30 * 86400000).toISOString()]);
    const seen = new Set();
    for (const row of rows) {
      const app = byId.get(row.application_id);
      if (!app || seen.has(app.id)) continue;
      seen.add(app.id);
      a.push({ app, outbox: row });
    }
  }
  const b = [];
  if (prefs.mode === 'all' || prefs.mode === 'review_only') {
    if (prefs.review_frequency === 'daily' || isMondayShanghai(now)) {
      for (const app of apps) {
        if (!isDueForReview(app, prefs.review_threshold_days, now)) continue;
        if (!(app.status_url || app.job_url)) continue;
        if (app.last_b_notified_at && daysBetweenShanghai(app.last_b_notified_at, now) < 7) continue;
        b.push({ app });
      }
    }
  }
  return { prefs, a, b, owner: one('SELECT * FROM users WHERE id = ?', [ownerId]) };
}

/* 回看标签：面试中显示「已面 N 天」，其余显示「已投 N 天」。
   面试锚点取面试时间 → 面试完成时间 → 进入面试状态的时间；都不存在就退回投递时间。 */
function progressTag(app, asOf) {
  if (app.status === 'interview') {
    const anchor = app.interview_scheduled_at || app.last_interview_completed_at || app.last_status_changed_at;
    const n = daysBetweenShanghai(anchor, asOf);
    if (n != null) return `已面 ${n} 天`;
  }
  const n = daysBetweenShanghai(app.applied_at, asOf);
  if (n != null) return `已投 ${n} 天`;
  return '投递时间未知';
}

function reminderBatchText({ owner, a, b, links }) {
  const today = shanghaiDateKey(new Date());
  const lines = [];
  lines.push(`Tounar 帮你理 · ${today} 08:00（北京时间）`);
  if (a.length) {
    lines.push(`一、有进展（${a.length}）`);
    for (const x of a) {
      lines.push(`· ${x.app.company_name} · ${x.app.job_title}  [${progressTag(x.app)}]`);
      lines.push(`  ${x.outbox.summary}`);
    }
  }
  if (b.length) {
    lines.push(`二、等待回看（${b.length}）`);
    for (const x of b) {
      lines.push(`· ${x.app.company_name} · ${x.app.job_title}  [${progressTag(x.app)}]`);
      lines.push(`  ${appUrl('/r/' + links.get(x.app.id))}`);
    }
  }
  lines.push('没有进展、也没到回看节点的岗位，不会出现在这封邮件里。');
  lines.push(`提醒设置：${appUrl('/?panel=settings')}  打开台账：${appUrl('/')}`);
  return lines.join('\n');
}

function reminderBatchHtml({ owner, a, b, links, asOf }) {
  const tagHtml = (app) => {
    const tag = progressTag(app, asOf);
    const isInterview = String(tag).startsWith('已面');
    return `<span style="display:inline-block;margin-left:8px;background:${isInterview ? '#eaf2ef' : '#f1efe8'};color:${isInterview ? '#17594c' : '#5f5e5a'};border:1px solid ${isInterview ? '#cfe0da' : '#e2e7e1'};border-radius:999px;padding:2px 10px;font-size:12px;vertical-align:2px">${escapeHtml(tag)}</span>`;
  };
  const rowsA = a.map((x) => `
    <tr><td style="padding:14px 0;border-bottom:1px solid #e2e7e1">
      <div style="font-size:15px;color:#151a19"><strong>${escapeHtml(x.app.company_name)}</strong> · ${escapeHtml(x.app.job_title)}${tagHtml(x.app)}</div>
      <div style="margin-top:5px;color:#66716d;font-size:13px">${escapeHtml(x.outbox.summary)}</div>
    </td></tr>`).join('');
  const rowsB = b.map((x) => `
    <tr><td style="padding:14px 0;border-bottom:1px solid #e2e7e1">
      <div style="font-size:15px;color:#151a19"><strong>${escapeHtml(x.app.company_name)}</strong> · ${escapeHtml(x.app.job_title)}${tagHtml(x.app)}</div>
      <div style="margin-top:5px;color:#66716d;font-size:13px">状态没有变化</div>
      <div style="margin-top:9px"><a href="${appUrl('/r/' + links.get(x.app.id))}" style="display:inline-block;background:#17594c;color:#fff;text-decoration:none;padding:8px 14px;border-radius:4px;font-size:13px">查看状态并确认</a></div>
    </td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><body style="margin:0;background:#f4f6f2;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#151a19">
  <div style="max-width:620px;margin:0 auto;padding:32px 22px">
    <div style="font-size:13px;letter-spacing:.16em;color:#17594c;text-transform:uppercase">Tounar · 帮你理</div>
    <h1 style="font-family:Georgia,'Songti SC',serif;font-size:26px;font-weight:600;margin:12px 0 4px">${a.length ? `${a.length} 个岗位有进展` : ''}${a.length && b.length ? ' · ' : ''}${b.length ? `${b.length} 个岗位等待回看` : ''}</h1>
    <p style="color:#66716d;font-size:13px;line-height:1.7">${escapeHtml(shanghaiDateKey(asOf))} 08:00 批次 · 没有进展、也没到回看节点的岗位不会出现在这里。</p>
    ${a.length ? `<h2 style="font-size:15px;margin:26px 0 4px;color:#17594c">一、有进展（${a.length}）</h2><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsA}</table>` : ''}
    ${b.length ? `<h2 style="font-size:15px;margin:26px 0 4px;color:#17594c">二、等待回看（${b.length}）</h2><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsB}</table>` : ''}
    <p style="margin:28px 0 0;font-size:12px;line-height:1.8;color:#66716d">只有你明确点击“已确认，状态无变化”后，才会刷新回看时间。打开邮件里的链接不会自动标记。<br>
    <a href="${appUrl('/?panel=settings')}" style="color:#17594c">提醒设置</a> · <a href="${appUrl('/')}" style="color:#17594c">打开台账</a></p>
  </div></body></html>`;
}

function statusForBatchError(err) {
  const message = String(err?.message || '');
  if (/timeout|timed out|ECONNRESET|ETIMEDOUT|socket/i.test(message)) return 'delivery_unknown';
  return 'failed';
}

export async function runReminderForOwner(ownerId, now = new Date(), { force = false } = {}) {
  const businessDate = shanghaiDateKey(now);
  const user = one('SELECT * FROM users WHERE id = ?', [ownerId]);
  if (!user || user.deletion_blocked) return { owner_id: ownerId, skipped: 'deletion_in_progress' };
  const existing = one(`SELECT * FROM notification_batches WHERE owner_id = ? AND business_date = ? AND channel = 'email'`,
    [ownerId, businessDate]);
  if (existing && ['sent', 'skipped_empty', 'cancelled'].includes(existing.status)) {
    return { owner_id: ownerId, business_date: businessDate, batch_id: existing.id, status: existing.status, reused: true };
  }
  if (existing && existing.status === 'sending') {
    return { owner_id: ownerId, business_date: businessDate, batch_id: existing.id, status: 'sending', reused: true };
  }
  if (!force && !existing) {
    const clock = shanghaiClock(now);
    if (clock.hour !== config.reminderHour || clock.minute < config.reminderMinute) {
      return { owner_id: ownerId, business_date: businessDate, skipped: 'outside_batch_window' };
    }
  }
  const { prefs, a, b } = buildReminderCandidates(ownerId, now);
  if (!a.length && !b.length) {
    const batchId = existing?.id || newId('batch');
    transaction(() => {
      if (!existing) {
        run(`INSERT INTO notification_batches
          (id, owner_id, business_date, channel, status, item_count_a, item_count_b, created_at, updated_at)
          VALUES (?, ?, ?, 'email', 'skipped_empty', 0, 0, ?, ?)`, [batchId, ownerId, businessDate, nowIso(), nowIso()]);
      } else {
        run(`UPDATE notification_batches SET status = 'skipped_empty', item_count_a = 0, item_count_b = 0, updated_at = ?
             WHERE id = ?`, [nowIso(), existing.id]);
      }
    });
    return { owner_id: ownerId, business_date: businessDate, batch_id: batchId, status: 'skipped_empty', sent: 0 };
  }
  const links = new Map();
  for (const x of b) links.set(x.app.id, createReminderLink(ownerId, x.app.id).token);
  const batchId = existing?.id || newId('batch');
  const subjectParts = [];
  if (a.length) subjectParts.push(`${a.length} 个岗位有进展`);
  if (b.length) subjectParts.push(`${b.length} 个岗位已投 ${prefs.review_threshold_days} 天以上`);
  const subject = `【Tounar】${subjectParts.join(' · ')}`;
  transaction(() => {
    if (!existing) {
      run(`INSERT INTO notification_batches
        (id, owner_id, business_date, channel, status, subject, item_count_a, item_count_b, created_at, updated_at)
        VALUES (?, ?, ?, 'email', 'pending', ?, ?, ?, ?, ?)`,
      [batchId, ownerId, businessDate, subject, a.length, b.length, nowIso(), nowIso()]);
    } else {
      run(`UPDATE notification_batches SET status = 'pending', subject = ?, item_count_a = ?, item_count_b = ?, updated_at = ?
           WHERE id = ?`, [subject, a.length, b.length, nowIso(), batchId]);
    }
    for (const x of a) {
      run(`INSERT OR IGNORE INTO notification_batch_items (batch_id, owner_id, application_id, kind, snapshot_json)
           VALUES (?, ?, ?, 'status_change', ?)`, [batchId, ownerId, x.app.id, JSON.stringify({ summary: x.outbox.summary })]);
    }
    for (const x of b) {
      run(`INSERT OR IGNORE INTO notification_batch_items (batch_id, owner_id, application_id, kind, snapshot_json)
           VALUES (?, ?, ?, 'review', ?)`, [batchId, ownerId, x.app.id, JSON.stringify({
        days_since_applied: daysBetweenShanghai(x.app.applied_at, now),
        days_since_interview: x.app.status === 'interview'
          ? daysBetweenShanghai(x.app.interview_scheduled_at || x.app.last_interview_completed_at || x.app.last_status_changed_at, now)
          : null,
        tag: progressTag(x.app, now),
        threshold: prefs.review_threshold_days
      })]);
    }
    run(`UPDATE notification_batches SET status = 'sending', updated_at = ? WHERE id = ?`, [nowIso(), batchId]);
  });
  const text = reminderBatchText({ owner: user, a, b, links, asOf: now });
  const html = reminderBatchHtml({ owner: user, a, b, links, asOf: now });
  try {
    const sent = await sendMail({
      to: user.email_display,
      subject, text, html, kind: 'reminder',
      metadata: { batch_id: batchId, business_date: businessDate, owner_id: ownerId }
    });
    transaction(() => {
      run(`UPDATE notification_batches SET status = 'sent', provider_message_id = ?, updated_at = ? WHERE id = ?`,
        [sent.messageId || null, nowIso(), batchId]);
      for (const x of a) {
        run(`UPDATE notification_outbox SET consumed_batch_id = ? WHERE id = ?`, [batchId, x.outbox.id]);
        run('UPDATE applications SET last_a_notified_at = ? WHERE id = ? AND owner_id = ?', [nowIso(), x.app.id, ownerId]);
      }
      for (const x of b) {
        run('UPDATE applications SET last_b_notified_at = ? WHERE id = ? AND owner_id = ?', [nowIso(), x.app.id, ownerId]);
      }
      bumpRevision();
    });
    return {
      owner_id: ownerId, business_date: businessDate, batch_id: batchId, status: 'sent',
      items_a: a.length, items_b: b.length, provider_message_id: sent.messageId, transport: sent.transport
    };
  } catch (err) {
    const status = statusForBatchError(err);
    run(`UPDATE notification_batches SET status = ?, error_code = ?, updated_at = ? WHERE id = ?`,
      [status, String(err.code || 'SEND_FAILED').slice(0, 100), nowIso(), batchId]);
    console.error(JSON.stringify({ level: 'error', event: 'reminder_send_failed', batch_id: batchId, code: err.code }));
    return {
      owner_id: ownerId, business_date: businessDate, batch_id: batchId, status,
      error: '发信服务未确认受理，未假装成功'
    };
  }
}

export async function runReminders(now = new Date(), { force = false, ownerId = null } = {}) {
  if (ownerId) return [await runReminderForOwner(ownerId, now, { force })];
  const users = all('SELECT id FROM users WHERE deletion_blocked = 0 ORDER BY created_at');
  const results = [];
  for (const user of users) {
    try {
      results.push(await runReminderForOwner(user.id, now, { force }));
    } catch (err) {
      results.push({ owner_id: user.id, error: err.message, status: 'failed' });
    }
  }
  return results;
}

export function batchPreview(ownerId, now = new Date()) {
  const { prefs, a, b } = buildReminderCandidates(ownerId, now);
  return {
    mode: prefs.mode,
    frequency: prefs.review_frequency,
    threshold_days: prefs.review_threshold_days,
    a: a.map((x) => ({
      application_id: x.app.id, company_name: x.app.company_name, job_title: x.app.job_title,
      summary: x.outbox.summary, occurred_at: x.outbox.occurred_at
    })),
    b: b.map((x) => ({
      application_id: x.app.id, company_name: x.app.company_name, job_title: x.app.job_title,
      applied_at: x.app.applied_at, days_since_applied: daysBetweenShanghai(x.app.applied_at, now),
      has_safe_link: !!(x.app.status_url || x.app.job_url)
    })),
    would_send: a.length + b.length > 0,
    note: '预览只读；是否实际发送还受批次窗口、频控和发信配置影响'
  };
}

export function currentDataRevision() {
  return dataRevision();
}
