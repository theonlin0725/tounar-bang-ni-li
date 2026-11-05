import crypto from 'node:crypto';
import { config } from '../../config.js';
import { all, bumpRevision, dataRevision, getApplication, one, run, transaction } from '../../db.js';
import {
  AppError, STATUS_LABELS, daysBetweenShanghai, decryptSecret, encryptSecret, escapeHtml, isDueForReview,
  appendShareCode, newId, nowIso, randomToken, safeJsonParse, shanghaiClock, shanghaiDateKey, sha256, sourceMethods, stageFollowupState, isSafeHttpUrl
} from '../../util.js';
import { getPreferences } from '../../domain/applications.js';
import { sendMail, publicMailError } from './mailer.js';
import { getTemplate, renderTemplate } from './templates.js';

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function appUrl(pathname = '/') {
  return appendShareCode(config.appBaseUrl + pathname, config.shareCode);
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

/* D08 已冻结（2026-10-22）：低置信度证据进待确认后，每 15 天随提醒邮件汇总一次，
   避免待确认队列默默堆积无人处理。 */
export function reviewDigestState(ownerId, now = new Date()) {
  const prefs = getPreferences(ownerId);
  // 日期标注用原始邮件的接收时间（mail_messages.received_at），不是线索入库时间；
  // 非邮件来源的线索退回用 created_at。
  const open = all(`SELECT r.*, m.received_at AS mail_received_at
    FROM review_items r LEFT JOIN mail_messages m ON m.id = r.source_mail_id AND m.owner_id = r.owner_id
    WHERE r.owner_id = ? AND r.status = 'open' ORDER BY r.created_at ASC LIMIT 20`,
    [ownerId]);
  const total = one(`SELECT COUNT(*) AS c FROM review_items WHERE owner_id = ? AND status = 'open'`, [ownerId])?.c || 0;
  const lastAt = prefs.last_review_digest_at || null;
  const due = prefs.mode !== 'off' && total > 0 && (!lastAt || daysBetweenShanghai(lastAt, now) >= config.reviewDigestDays);
  return { due, total, last_at: lastAt, items: open.map((r) => ({
    id: r.id, summary: r.summary, kind: r.kind, created_at: r.created_at,
    dated_at: r.mail_received_at || r.created_at, from_mail: !!r.mail_received_at
  })) };
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
    [ownerId, new Date(now.getTime() - 30 * 86400000).toISOString()]);
    for (const row of rows) {
      const app = byId.get(row.application_id);
      if (!app) continue;
      const event = row.event_id ? one('SELECT source_method, payload_json FROM events WHERE id = ? AND owner_id = ?', [row.event_id, ownerId]) : null;
      a.push({ app, outbox: row, payload: safeJsonParse(event?.payload_json, {}), from_mail: event?.source_method === 'mail' });
    }
  }
  const b = [];
  if (prefs.mode === 'all' || prefs.mode === 'review_only') {
      for (const app of apps) {
        const stage = stageFollowupState(app, prefs.stage_followup_days, now);
        const oldDue = (prefs.review_frequency === 'daily' || isMondayShanghai(now)) && isDueForReview(app, prefs.review_threshold_days, now);
        if (!stage.due && !oldDue) continue;
        if (!(app.status_url || app.job_url)) continue;
        if (app.last_b_notified_at && daysBetweenShanghai(app.last_b_notified_at, now) < 7) continue;
        b.push({ app, stage: stage.due ? stage : null });
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

function itemDate(x) { return x.outbox?.source_received_at || x.outbox?.occurred_at || x.stage?.received_at || x.app.stage_received_at || x.app.last_status_changed_at || x.app.applied_at; }
function receiptRange({ a, b, digest }) {
  const source = a.length ? a.map(itemDate) : b.length ? b.map(itemDate) : (digest?.items || []).map(x => x.dated_at);
  const dates = [...new Set(source.filter(Boolean).map(d => shanghaiDateKey(d)))].sort();
  return dates.length > 1 ? `${dates[0]}–${dates.at(-1)}` : dates[0] || '日期待补充';
}
function officialUrl(app) { const url=app.status_url || app.job_url; return isSafeHttpUrl(url) ? url : null; }
const INVITATION_LABELS = { assessment: '笔试', interview: '面试' };
function stageLabel(x) {
  if (!x.stage) return progressTag(x.app);
  const label = INVITATION_LABELS[x.app.status] || STATUS_LABELS[x.app.status];
  return `${label}邀请 ${shanghaiDateKey(x.stage.received_at || x.stage.anchor)}收到，已过 ${x.stage.elapsed} 天，还没有新进展`;
}
function progressDescription(x) {
  const p=x.payload || {};
  return [p.mapped_status ? STATUS_LABELS[p.mapped_status] : x.outbox.summary, p.round_label,
    p.interview_scheduled_at ? '面试时间 '+new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'short'}).format(new Date(p.interview_scheduled_at)) : null].filter(Boolean).join(' · ');
}
function cardVariables(id, x, links) {
  if (id === 'digest_item') return { summary: x.summary, date_label: x.from_mail ? '邮件收到于' : '记录创建于', date: shanghaiDateKey(x.dated_at) };
  const url = officialUrl(x.app);
  const officialLabel = id === 'progress_item' ? '打开岗位/申请状态页' : '直接打开申请状态页';
  const base = { company: x.app.company_name, job_title: x.app.job_title,
    description: id === 'progress_item' ? progressDescription(x) : stageLabel(x),
    official_text: url ? officialLabel + '：' + url : '',
    official_html: url ? `<a href="${escapeHtml(url)}">${officialLabel}</a> · ` : '',
    detail_url: appUrl('/?app='+encodeURIComponent(x.app.id)) };
  return id === 'progress_item' ? { ...base, status: STATUS_LABELS[x.app.status] || x.app.status,
    date: shanghaiDateKey(itemDate(x)), date_label: x.from_mail ? '收到' : '发生',
    location: x.app.location || '', jd_summary: x.app.jd_summary || '', applied_date: x.app.applied_at ? shanghaiDateKey(x.app.applied_at) : '' }
    : { ...base, date_line: x.stage ? `—— ${shanghaiDateKey(itemDate(x))} 收到` : '', confirm_url: appUrl('/r/'+links.get(x.app.id)) };
}
function card(id, x, links, field) { return renderTemplate(id, cardVariables(id, x, links))[field]; }
function reminderBodyText({ a, b, links, asOf, digest }) {
  const lines=[];
  if(a.length) { lines.push(`一、有进展（${a.length}）`); for(const x of a) lines.push(card('progress_item', x, links, 'text')); }
  if(b.length) { lines.push(`二、该回看了（${b.length}）`); for(const x of b) lines.push(card('review_item', x, links, 'text')); }
  if(digest?.due) { lines.push(`三、待你确认（${digest.total}）`); for(const x of digest.items.slice(0,8)) lines.push(card('digest_item', x, links, 'text')); lines.push('处理入口：'+appUrl('/?panel=reviews')); }
  return lines.join('\n');
}
function reminderBodyHtml({ a, b, links, asOf, digest }) {
  const link=(url,label)=>`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
  const section=(title,body)=>`<h2>${escapeHtml(title)}</h2>${body}`;
  const cardsA = a.map(x => card('progress_item', x, links, 'html')).join('');
  const cardsB = b.map(x => card('review_item', x, links, 'html')).join('');
  const cardsD = (digest?.items || []).slice(0,8).map(x => card('digest_item', x, links, 'html')).join('');
  return `${a.length?section('一、有进展（'+a.length+'）',cardsA):''}${b.length?section('二、该回看了（'+b.length+'）',cardsB):''}${digest?.due?section('三、待你确认（'+digest.total+'）',cardsD+link(appUrl('/?panel=reviews'),'处理待确认')):''}`;
}

export function renderReminderMessage(a, b, links, now, digest) {
  const parts = [];
  if (a.length === 1) parts.push(`${a[0].app.company_name}·${a[0].app.job_title} ${STATUS_LABELS[a[0].payload?.mapped_status] || '有进展'}`);
  else if (a.length) parts.push(`${a.length} 条进展`);
  if (b.length) parts.push(`${b.length} 条该回看了`);
  if (digest.due) parts.push(`${digest.total} 条待确认`);
  const variables = { summary: parts.join(' · '), date_range: receiptRange({a,b,digest}),
      body_text: reminderBodyText({ a, b, links, asOf: now, digest }),
      body_html: reminderBodyHtml({ a, b, links, asOf: now, digest }),
      count_progress: String(a.length), count_review: String(b.length), count_digest: String(digest.due ? digest.total : 0), pushed_at: now.toISOString(), settings_url: appUrl('/?panel=settings'), reviews_url: appUrl('/?panel=reviews'), ledger_url: appUrl('/') };
    const rendered = renderTemplate('reminder', variables);
    const versions = { reminder: rendered.version };
    if (a.length) versions.progress_item = getTemplate('progress_item').version;
    if (b.length) versions.review_item = getTemplate('review_item').version;
    if (digest.due) versions.digest_item = getTemplate('digest_item').version;
  return { rendered, versions };
}

// 兼容既有调用：对外返回完整邮件，内部 body_* 仅包含卡片分组。
export function reminderBatchText({a,b,links,asOf,digest}) { return renderReminderMessage(a,b,links,asOf,digest || {due:false,items:[]}).rendered.text; }
export function reminderBatchHtml({a,b,links,asOf,digest}) { return renderReminderMessage(a,b,links,asOf,digest || {due:false,items:[]}).rendered.html; }

export function previewBusinessReminder(ownerId, applicationId) {
  const candidates = buildReminderCandidates(ownerId);
  const a = candidates.a.filter(x => x.app.id === applicationId), b = candidates.b.filter(x => x.app.id === applicationId);
  if (!a.length && !b.length) throw new AppError(422, 'NO_CANDIDATES', '这条记录当前不满足提醒条件：请检查提醒是否开启、是否有近 30 天的未消费进展，或回看是否到期。建议今天手动补录一条新记录。');
  const { rendered, versions } = renderReminderMessage(a, b, new Map(b.map(x => [x.app.id, 'preview_only'])), new Date(), { due: false, total: 0, items: [] });
  return { ...rendered, subject: '【自测·业务通路】' + rendered.subject, template_versions: versions, progress_count: a.length, review_count: b.length, data_revision: dataRevision(), note: '来自本人台账和真实候选筛选；预览中的确认链接为占位，不执行操作。' };
}

export async function runReminderForOwner(ownerId, now = new Date(), { force = false, test = null } = {}) {
  if (test && (!config.enableMailBusinessTest || !config.adminEmails.has(one('SELECT email_normalized FROM users WHERE id=?', [ownerId])?.email_normalized) || !config.testMailRecipients.has(test.to) || !test.runId || !test.applicationId)) throw new AppError(403, 'FORBIDDEN', '业务测试仅允许管理员向指定测试邮箱发送');
  const channel = test ? 'email_test:' + test.runId : 'email';
  const businessDate = shanghaiDateKey(now);
  const user = one('SELECT * FROM users WHERE id = ?', [ownerId]);
  if (!user || user.deletion_blocked) return { owner_id: ownerId, skipped: 'deletion_in_progress' };
  const existing = one(`SELECT * FROM notification_batches WHERE owner_id = ? AND business_date = ? AND channel = ?`,
    [ownerId, businessDate, channel]);
  if (existing && ['sent', 'cancelled'].includes(existing.status)) {
    return { owner_id: ownerId, business_date: businessDate, batch_id: existing.id, status: existing.status, reused: true };
  }
  if (existing && existing.status === 'sending') {
    return { owner_id: ownerId, business_date: businessDate, batch_id: existing.id, status: 'sending', reused: true };
  }
  // 空批次（skipped_empty）不能锁死当天：外部 cron 可能在 08:00 前先打一次 tick，
  // 若被当成“已发”复用，当天的提醒就永远发不出去。允许在窗口内/force 时重试。
  const retryingEmpty = existing?.status === 'skipped_empty';
  if (!force && (!existing || retryingEmpty)) {
    const clock = shanghaiClock(now);
    if (clock.hour !== config.reminderHour || clock.minute < config.reminderMinute) {
      return { owner_id: ownerId, business_date: businessDate, skipped: 'outside_batch_window' };
    }
  }
  const candidates = buildReminderCandidates(ownerId, now);
  const { prefs } = candidates;
  const a = test ? candidates.a.filter(x => x.app.id === test.applicationId) : candidates.a;
  const b = test ? candidates.b.filter(x => x.app.id === test.applicationId) : candidates.b;
  const digest = test ? { due: false, total: 0, items: [] } : reviewDigestState(ownerId, now);
  if (!a.length && !b.length && !digest.due) {
    const batchId = existing?.id || newId('batch');
    transaction(() => {
      if (!existing) {
        run(`INSERT INTO notification_batches
          (id, owner_id, business_date, channel, status, item_count_a, item_count_b, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'skipped_empty', 0, 0, ?, ?)`, [batchId, ownerId, businessDate, channel, nowIso(), nowIso()]);
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
  const range = receiptRange({a,b,digest});
  const subjectParts = [];
  if(a.length === 1) subjectParts.push(`${a[0].app.company_name}·${a[0].app.job_title} ${STATUS_LABELS[a[0].payload?.mapped_status] || '有进展'}`);
  else if(a.length) subjectParts.push(`${a.length} 条进展`);
  if(b.length) subjectParts.push(`${b.length} 条该回看了`);
  if(digest.due) subjectParts.push(`${digest.total} 条待确认`);
  const subject = `【帮你理】${subjectParts.join(' · ')}（${range}收到）`;
  const attemptedVersions = { reminder: getTemplate('reminder').version };
  if (a.length) attemptedVersions.progress_item = getTemplate('progress_item').version;
  if (b.length) attemptedVersions.review_item = getTemplate('review_item').version;
  if (digest.due) attemptedVersions.digest_item = getTemplate('digest_item').version;

  transaction(() => {
    if (!existing) {
      run(`INSERT INTO notification_batches
        (id, owner_id, business_date, channel, status, subject, item_count_a, item_count_b, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [batchId, ownerId, businessDate, channel, subject, a.length, b.length, nowIso(), nowIso()]);
    } else {
      run(`UPDATE notification_batches SET status = 'pending', subject = ?, item_count_a = ?, item_count_b = ?, updated_at = ?
           WHERE id = ?`, [subject, a.length, b.length, nowIso(), batchId]);
    }
    for (const x of a) {
      run(`INSERT OR IGNORE INTO notification_batch_items (batch_id, owner_id, application_id, kind, snapshot_json)
           VALUES (?, ?, ?, ?, ?)`, [batchId, ownerId, x.app.id, 'status_change:'+x.outbox.id, JSON.stringify({ summary: x.outbox.summary, source_received_at: itemDate(x), event_id: x.outbox.event_id })]);
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
  try {
    const { rendered, versions } = renderReminderMessage(a, b, links, now, digest);
    run('UPDATE notification_batches SET subject=? WHERE id=?', [(test ? '【自测·业务通路】' : '') + rendered.subject, batchId]);
    const sent = await sendMail({
      to: test ? test.to : user.email_display,
      ...rendered, subject: (test ? '【自测·业务通路】' : '') + rendered.subject, kind: 'reminder',
      metadata: { batch_id: batchId, business_date: businessDate, owner_id: ownerId, template_versions: versions, test_run_id: test?.runId, test_mode: test ? 'business_test' : 'business', application_id: test?.applicationId }
    });
    transaction(() => {
      run(`UPDATE notification_batches SET status = 'sent', provider_message_id = ?, updated_at = ? WHERE id = ?`,
        [sent.messageId || null, nowIso(), batchId]);
      for (const x of test ? [] : a) {
        run(`UPDATE notification_outbox SET consumed_batch_id = ? WHERE id = ?`, [batchId, x.outbox.id]);
        run('UPDATE applications SET last_a_notified_at = ? WHERE id = ? AND owner_id = ?', [now.toISOString(), x.app.id, ownerId]);
      }
      for (const x of test ? [] : b) {
        run('UPDATE applications SET last_b_notified_at = ? WHERE id = ? AND owner_id = ?', [now.toISOString(), x.app.id, ownerId]);
        if (x.stage) run('UPDATE applications SET stage_last_notified_anchor = ? WHERE id = ? AND owner_id = ?', [x.stage.anchor, x.app.id, ownerId]);
      }
      if (digest.due) {
        run('UPDATE notification_preferences SET last_review_digest_at = ?, updated_at = ? WHERE owner_id = ?',
          [nowIso(), nowIso(), ownerId]);
      }
      bumpRevision();
    });
    return {
      owner_id: ownerId, business_date: businessDate, batch_id: batchId, status: 'sent',
      items_a: a.length, items_b: b.length, review_digest: digest.due ? digest.total : 0,
      provider_message_id: sent.messageId, transport: sent.transport, delivery_id: sent.delivery_id, delivery_status: sent.status, template_versions: versions
    };
  } catch (err) {
    const safe = publicMailError(err);
    const status = safe.status;
    run(`UPDATE notification_batches SET status = ?, error_code = ?, updated_at = ? WHERE id = ?`,
      [status, String(err.code || 'SEND_FAILED').slice(0, 100), nowIso(), batchId]);
    console.error(JSON.stringify({ level: 'error', event: 'reminder_send_failed', batch_id: batchId, code: err.code }));
    return {
      owner_id: ownerId, business_date: businessDate, batch_id: batchId, status,
      error: safe.message, error_code: safe.code, issues: err.details?.issues || null, template_versions: attemptedVersions
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
  const digest = reviewDigestState(ownerId, now);
  return {
    mode: prefs.mode,
    frequency: prefs.review_frequency,
    threshold_days: prefs.review_threshold_days,
    a: a.map((x) => ({
      application_id: x.app.id, company_name: x.app.company_name, job_title: x.app.job_title,
      summary: x.outbox.summary, occurred_at: x.outbox.occurred_at, source_received_at: itemDate(x)
    })),
    b: b.map((x) => ({
      application_id: x.app.id, company_name: x.app.company_name, job_title: x.app.job_title,
      stage_followup: x.stage, applied_at: x.app.applied_at, days_since_applied: daysBetweenShanghai(x.app.applied_at, now),
      has_safe_link: !!(x.app.status_url || x.app.job_url)
    })),
    review_digest: digest,
    would_send: a.length + b.length > 0 || digest.due,
    note: '预览只读；是否实际发送还受批次窗口、频控和发信配置影响'
  };
}

export function currentDataRevision() {
  return dataRevision();
}
