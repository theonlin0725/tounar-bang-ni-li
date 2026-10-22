import crypto from 'node:crypto';
import { config } from '../config.js';
import { all, bumpRevision, dataRevision, getApplication, one, run, transaction } from '../db.js';
import {
  AppError, STATUS_LABELS, daysBetweenShanghai, decryptSecret, encryptSecret, escapeHtml, isDueForReview,
  maxIso, newId, nowIso, randomToken, safeJsonParse, shanghaiClock, shanghaiDateKey, sha256, sourceMethods
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

/* D08 已冻结（2026-10-22）：低置信度证据进待确认后，每 15 天随提醒邮件汇总一次，
   避免待确认队列默默堆积无人处理。 */
export function reviewDigestState(ownerId, now = new Date()) {
  const prefs = getPreferences(ownerId);
  // 日期标注用原始邮件的接收时间（mail_messages.received_at），不是线索入库时间；
  // 非邮件来源的线索退回用 created_at。
  const open = all(`SELECT r.*, m.received_at AS mail_received_at
    FROM review_items r LEFT JOIN mail_messages m ON m.id = r.source_mail_id
    WHERE r.owner_id = ? AND r.status = 'open' ORDER BY r.created_at ASC LIMIT 20`,
    [ownerId]);
  const total = one(`SELECT COUNT(*) AS c FROM review_items WHERE owner_id = ? AND status = 'open'`, [ownerId])?.c || 0;
  const lastAt = prefs.last_review_digest_at || null;
  const due = total > 0 && (!lastAt || daysBetweenShanghai(lastAt, now) >= config.reviewDigestDays);
  return { due, total, last_at: lastAt, items: open.map((r) => ({
    id: r.id, summary: r.summary, kind: r.kind, created_at: r.created_at,
    dated_at: r.mail_received_at || r.created_at, from_mail: !!r.mail_received_at
  })) };
}

export function buildReminderCandidates(ownerId, now = new Date()) {
  const prefs = getPreferences(ownerId);
  if (prefs.mode === 'off') return { prefs, a: [], b: [], c: [] };
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
  /* P3：笔试/面试后的阶段回看。锚点优先用 stage_followup_anchor（状态进入时写入，
     邮件来源就是邀请邮件收到日期），面试时间更晚时在写入侧已取面试时间。 */
  const c = [];
  if ((prefs.mode === 'all' || prefs.mode === 'review_only')
    && Number(prefs.stage_followup_days) > 0
    && (prefs.review_frequency === 'daily' || isMondayShanghai(now))) {
    const followupDays = Number(prefs.stage_followup_days);
    for (const app of apps) {
      if (!['assessment', 'interview'].includes(app.status)) continue;
      const anchor = app.stage_followup_anchor
        || (app.status === 'interview' ? maxIso(app.interview_scheduled_at, app.last_status_changed_at) : app.last_status_changed_at);
      if (!anchor) continue;
      const days = daysBetweenShanghai(anchor, now);
      if (days == null || days < followupDays) continue;
      if (!(app.status_url || app.job_url)) continue;
      if (app.last_b_notified_at && daysBetweenShanghai(app.last_b_notified_at, now) < 7) continue;
      c.push({ app, anchor, days });
    }
  }
  const cIds = new Set(c.map((x) => x.app.id));
  const b = [];
  if (prefs.mode === 'all' || prefs.mode === 'review_only') {
    if (prefs.review_frequency === 'daily' || isMondayShanghai(now)) {
      for (const app of apps) {
        if (cIds.has(app.id)) continue;
        if (!isDueForReview(app, prefs.review_threshold_days, now)) continue;
        if (!(app.status_url || app.job_url)) continue;
        if (app.last_b_notified_at && daysBetweenShanghai(app.last_b_notified_at, now) < 7) continue;
        b.push({ app });
      }
    }
  }
  return { prefs, a, b, c, owner: one('SELECT * FROM users WHERE id = ?', [ownerId]) };
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

/* ---------- P3：推送邮件的日期口径 ---------- */
const STAGE_LABELS = { assessment: '笔试/测评邀请', interview: '面试邀请' };
const SUBJECT_STATUS_LABELS = {
  applied: '已投递', assessment: '笔试/测评邀请', interview: '面试邀请',
  rejected: '拒绝通知', offer: 'Offer', closed: '流程关闭'
};

function receivedAtOf(outbox) {
  return outbox?.source_received_at || outbox?.occurred_at || null;
}

function dateParts(iso) {
  const key = iso ? shanghaiDateKey(new Date(iso)) : null;
  if (!key) return null;
  const [year, month, day] = key.split('-');
  return { year, month, day, key };
}

function dateLabel(iso) {
  const p = dateParts(iso);
  return p ? `${p.month}月${p.day}日` : '';
}

function fullDateLabel(iso) {
  const p = dateParts(iso);
  return p ? `${p.year}年${p.month}月${p.day}日` : '';
}

function dateRangeLabel(isoList) {
  const keys = isoList.map((x) => dateParts(x)?.key).filter(Boolean).sort();
  if (!keys.length) return '';
  if (keys[0] === keys[keys.length - 1]) return dateLabel(keys[0]);
  const a = dateParts(keys[0]);
  const b = dateParts(keys[keys.length - 1]);
  return `${a.month}月${a.day}日–${b.month}月${b.day}日`;
}

function progressKind(outbox) {
  const parts = String(outbox?.summary || '').split('→');
  if (parts.length < 2) return '有新进展';
  const to = parts[parts.length - 1].trim();
  const key = Object.keys(SUBJECT_STATUS_LABELS).find((k) => STATUS_LABELS[k] === to);
  return SUBJECT_STATUS_LABELS[key] || to || '有新进展';
}

function stageAnchorLine(item) {
  const stage = STAGE_LABELS[item.app.status] || STATUS_LABELS[item.app.status] || '阶段进展';
  return `${stage} ${dateLabel(item.anchor)}收到，已过 ${item.days} 天，还没有新进展`;
}

function pushTimeLine(asOf) {
  return `推送时间：${shanghaiDateKey(asOf)} 08:00（北京时间）`;
}

function reminderBatchText({ owner, a, b, c, links, digest, asOf = new Date() }) {
  const lines = [];
  const ordinals = ['一', '二', '三', '四', '五'];
  let section = 0;
  const sectionTitle = (label, count) => `${ordinals[section++]}、${label}（${count}）`;
  const aDates = a.map((x) => receivedAtOf(x.outbox)).filter(Boolean).sort();
  const headerDate = a.length === 1
    ? `${fullDateLabel(aDates[0])} 收到`
    : a.length > 1 ? `收信日期 ${dateRangeLabel(aDates)}` : `${shanghaiDateKey(asOf)} 回看`;
  lines.push(`Tounar 帮你理 · ${headerDate}`);
  if (a.length) {
    lines.push(sectionTitle('有进展', a.length));
    for (const x of a) {
      lines.push(`· ${x.app.company_name} · ${x.app.job_title}  [${progressTag(x.app, asOf)}]`);
      lines.push(`  ${x.outbox.summary}`);
      lines.push(`  —— ${fullDateLabel(receivedAtOf(x.outbox))} 收到`);
    }
  }
  if (c.length) {
    lines.push(sectionTitle('该回看了', c.length));
    for (const x of c) {
      lines.push(`· ${x.app.company_name} · ${x.app.job_title}  [${STATUS_LABELS[x.app.status] || x.app.status}]`);
      lines.push(`  ${stageAnchorLine(x)}`);
      lines.push(`  直接打开申请状态页：${x.app.status_url || x.app.job_url}`);
      lines.push(`  我看过了，没变化：${appUrl('/r/' + links.get(x.app.id))}`);
      lines.push(`  结果出来了，去更新：${appUrl('/?app=' + x.app.id)}`);
    }
  }
  if (b.length) {
    lines.push(sectionTitle('等待回看', b.length));
    for (const x of b) {
      lines.push(`· ${x.app.company_name} · ${x.app.job_title}  [${progressTag(x.app, asOf)}]`);
      lines.push(`  状态没有变化：${appUrl('/r/' + links.get(x.app.id))}`);
    }
  }
  if (digest && digest.due) {
    lines.push(sectionTitle('待你确认', digest.total));
    for (const item of digest.items.slice(0, 8)) {
      const date = String(item.dated_at || '').slice(0, 10);
      lines.push(`· ${item.summary}`);
      lines.push(`  ${item.kind} · ${item.from_mail ? '邮件收到于' : '记录创建于'} ${date}`);
    }
    if (digest.total > digest.items.length) lines.push(`  …及其余 ${digest.total - digest.items.length} 条`);
    lines.push(`  处理入口：${appUrl('/?panel=reviews')}`);
  }
  lines.push('没有进展、也没到回看节点的岗位，不会出现在这封邮件里。');
  lines.push(`${pushTimeLine(asOf)} · 提醒设置：${appUrl('/?panel=settings')}  打开台账：${appUrl('/')}`);
  return lines.join('\n');
}

function reminderBatchHtml({ owner, a, b, c, links, asOf, digest }) {
  const tagHtml = (app) => {
    const tag = progressTag(app, asOf);
    const isInterview = String(tag).startsWith('已面');
    return `<span style="display:inline-block;margin-left:8px;background:${isInterview ? '#eaf2ef' : '#f1efe8'};color:${isInterview ? '#17594c' : '#5f5e5a'};border:1px solid ${isInterview ? '#cfe0da' : '#e2e7e1'};border-radius:999px;padding:2px 10px;font-size:12px;vertical-align:2px">${escapeHtml(tag)}</span>`;
  };
  const rowsA = a.map((x) => `
    <tr><td style="padding:14px 0;border-bottom:1px solid #e2e7e1">
      <div style="font-size:15px;color:#151a19"><strong>${escapeHtml(x.app.company_name)}</strong> · ${escapeHtml(x.app.job_title)}${tagHtml(x.app)}</div>
      <div style="margin-top:5px;color:#66716d;font-size:13px">${escapeHtml(x.outbox.summary)}</div>
      <div style="margin-top:5px;color:#8a938f;font-size:12px">—— ${escapeHtml(fullDateLabel(receivedAtOf(x.outbox)))} 收到</div>
    </td></tr>`).join('');
  const rowsC = c.map((x) => {
    const statusLink = x.app.status_url || x.app.job_url;
    return `
    <tr><td style="padding:14px 0;border-bottom:1px solid #e2e7e1">
      <div style="font-size:15px;color:#151a19"><strong>${escapeHtml(x.app.company_name)}</strong> · ${escapeHtml(x.app.job_title)}
        <span style="display:inline-block;margin-left:8px;background:#f1efe8;color:#5f5e5a;border:1px solid #e2e7e1;border-radius:999px;padding:2px 10px;font-size:12px;vertical-align:2px">${escapeHtml(STATUS_LABELS[x.app.status] || x.app.status)}</span></div>
      <div style="margin-top:5px;color:#66716d;font-size:13px">${escapeHtml(stageAnchorLine(x))}</div>
      <div style="margin-top:9px">
        <a href="${escapeHtml(statusLink)}" style="display:inline-block;background:#17594c;color:#fff;text-decoration:none;padding:8px 14px;border-radius:4px;font-size:13px;margin:0 6px 6px 0">直接打开申请状态页</a>
        <a href="${appUrl('/r/' + links.get(x.app.id))}" style="display:inline-block;background:#fff;color:#17594c;border:1px solid #17594c;text-decoration:none;padding:7px 13px;border-radius:4px;font-size:13px;margin:0 6px 6px 0">我看过了，没变化</a>
        <a href="${appUrl('/?app=' + x.app.id)}" style="display:inline-block;background:#fff;color:#17594c;border:1px solid #cfd8d2;text-decoration:none;padding:7px 13px;border-radius:4px;font-size:13px;margin:0 6px 6px 0">结果出来了，去更新</a>
      </div>
    </td></tr>`;
  }).join('');
  const rowsB = b.map((x) => `
    <tr><td style="padding:14px 0;border-bottom:1px solid #e2e7e1">
      <div style="font-size:15px;color:#151a19"><strong>${escapeHtml(x.app.company_name)}</strong> · ${escapeHtml(x.app.job_title)}${tagHtml(x.app)}</div>
      <div style="margin-top:5px;color:#66716d;font-size:13px">状态没有变化</div>
      <div style="margin-top:9px"><a href="${appUrl('/r/' + links.get(x.app.id))}" style="display:inline-block;background:#17594c;color:#fff;text-decoration:none;padding:8px 14px;border-radius:4px;font-size:13px">查看状态并确认</a></div>
    </td></tr>`).join('');
  const rowsD = digest && digest.due
    ? digest.items.slice(0, 8).map((item) => `
      <tr><td style="padding:10px 0;border-bottom:1px solid #e2e7e1">
        <div style="font-size:14px;color:#151a19">${escapeHtml(item.summary || '')}</div>
        <div style="margin-top:3px;color:#66716d;font-size:12px">${escapeHtml(item.kind || '')} · ${item.from_mail ? '邮件收到于' : '记录创建于'} ${escapeHtml(String(item.dated_at || '').slice(0, 10))}</div>
      </td></tr>`).join('') +
      (digest.total > digest.items.length
        ? `<tr><td style="padding:10px 0;color:#66716d;font-size:13px">…及其余 ${digest.total - digest.items.length} 条</td></tr>` : '')
    : '';
  const ordinals = ['一', '二', '三', '四', '五'];
  let section = 0;
  const heading = (label, count) => `<h2 style="font-size:15px;margin:26px 0 4px;color:#17594c">${ordinals[section++]}、${label}（${count}）</h2>`;
  const aDates = a.map((x) => receivedAtOf(x.outbox)).filter(Boolean).sort();
  const topDate = a.length === 1
    ? `${fullDateLabel(aDates[0])} 收到`
    : a.length > 1 ? `收信日期 ${dateRangeLabel(aDates)}` : `${shanghaiDateKey(asOf)} 回看`;
  const titleParts = [];
  if (a.length) titleParts.push(`${a.length} 个岗位有进展`);
  if (c.length) titleParts.push(`${c.length} 个岗位该回看了`);
  if (b.length) titleParts.push(`${b.length} 个岗位等待回看`);
  if (digest && digest.due) titleParts.push(`${digest.total} 条待确认`);
  return `<!doctype html><html lang="zh-CN"><body style="margin:0;background:#f4f6f2;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#151a19">
  <div style="max-width:620px;margin:0 auto;padding:32px 22px">
    <div style="font-size:13px;letter-spacing:.16em;color:#17594c;text-transform:uppercase">Tounar · 帮你理</div>
    <h1 style="font-family:Georgia,'Songti SC',serif;font-size:26px;font-weight:600;margin:12px 0 4px">${escapeHtml(titleParts.join(' · '))}</h1>
    <p style="color:#66716d;font-size:13px;line-height:1.7">${escapeHtml(topDate)} · 没有进展、也没到回看节点的岗位不会出现在这里。</p>
    ${a.length ? `${heading('有进展', a.length)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsA}</table>` : ''}
    ${c.length ? `${heading('该回看了', c.length)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsC}</table>` : ''}
    ${b.length ? `${heading('等待回看', b.length)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsB}</table>` : ''}
    ${digest && digest.due ? `${heading('待你确认', digest.total)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsD}</table><p style="margin:8px 0 0;font-size:12px;color:#66716d">这些是系统拿不准、等你裁决的线索（每 ${config.reviewDigestDays} 天汇总一次）。</p>` : ''}
    <p style="margin:28px 0 0;font-size:12px;line-height:1.8;color:#66716d">只有你明确点击“已确认，状态无变化”后，才会刷新回看时间。打开邮件里的链接不会自动标记。<br>
    ${escapeHtml(pushTimeLine(asOf))}<br>
    <a href="${appUrl('/?panel=settings')}" style="color:#17594c">提醒设置</a> · <a href="${appUrl('/?panel=reviews')}" style="color:#17594c">待确认队列</a> · <a href="${appUrl('/')}" style="color:#17594c">打开台账</a></p>
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
  const { prefs, a, b, c } = buildReminderCandidates(ownerId, now);
  const digest = reviewDigestState(ownerId, now);
  if (!a.length && !b.length && !c.length && !digest.due) {
    const batchId = existing?.id || newId('batch');
    transaction(() => {
      if (!existing) {
        run(`INSERT INTO notification_batches
          (id, owner_id, business_date, channel, status, item_count_a, item_count_b, item_count_c, created_at, updated_at)
          VALUES (?, ?, ?, 'email', 'skipped_empty', 0, 0, 0, ?, ?)`, [batchId, ownerId, businessDate, nowIso(), nowIso()]);
      } else {
        run(`UPDATE notification_batches SET status = 'skipped_empty', item_count_a = 0, item_count_b = 0,
             item_count_c = 0, updated_at = ? WHERE id = ?`, [nowIso(), existing.id]);
      }
    });
    return { owner_id: ownerId, business_date: businessDate, batch_id: batchId, status: 'skipped_empty', sent: 0 };
  }
  const links = new Map();
  for (const x of [...b, ...c]) links.set(x.app.id, createReminderLink(ownerId, x.app.id).token);
  const batchId = existing?.id || newId('batch');
  const subjectParts = [];
  if (a.length === 1) {
    const x = a[0];
    subjectParts.push(`${x.app.company_name}·${x.app.job_title} ${progressKind(x.outbox)}（${dateLabel(receivedAtOf(x.outbox))}收到）`);
  } else if (a.length > 1) {
    const dates = a.map((x) => receivedAtOf(x.outbox)).filter(Boolean).sort();
    subjectParts.push(`${a.length} 条进展（${dateRangeLabel(dates)}收到）`);
  }
  if (c.length) subjectParts.push(`${c.length} 个岗位该回看了`);
  if (b.length) subjectParts.push(`${b.length} 个岗位已投 ${prefs.review_threshold_days} 天以上`);
  if (digest.due) subjectParts.push(`${digest.total} 条待确认`);
  const subject = `【Tounar】${subjectParts.join(' · ')}`;
  transaction(() => {
    if (!existing) {
      run(`INSERT INTO notification_batches
        (id, owner_id, business_date, channel, status, subject, item_count_a, item_count_b, item_count_c, created_at, updated_at)
        VALUES (?, ?, ?, 'email', 'pending', ?, ?, ?, ?, ?, ?)`,
      [batchId, ownerId, businessDate, subject, a.length, b.length, c.length, nowIso(), nowIso()]);
    } else {
      run(`UPDATE notification_batches SET status = 'pending', subject = ?, item_count_a = ?, item_count_b = ?,
           item_count_c = ?, updated_at = ? WHERE id = ?`,
      [subject, a.length, b.length, c.length, nowIso(), batchId]);
    }
    for (const x of a) {
      run(`INSERT OR IGNORE INTO notification_batch_items (batch_id, owner_id, application_id, kind, snapshot_json)
           VALUES (?, ?, ?, 'status_change', ?)`, [batchId, ownerId, x.app.id, JSON.stringify({
        summary: x.outbox.summary,
        source_received_at: receivedAtOf(x.outbox)
      })]);
    }
    for (const x of c) {
      run(`INSERT OR IGNORE INTO notification_batch_items (batch_id, owner_id, application_id, kind, snapshot_json)
           VALUES (?, ?, ?, 'followup', ?)`, [batchId, ownerId, x.app.id, JSON.stringify({
        anchor: x.anchor,
        days_since_stage: x.days,
        stage: x.app.status,
        stage_label: STAGE_LABELS[x.app.status] || STATUS_LABELS[x.app.status] || x.app.status,
        status_url: x.app.status_url || null,
        job_url: x.app.job_url || null,
        stage_followup_days: prefs.stage_followup_days
      })]);
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
  const text = reminderBatchText({ owner: user, a, b, c, links, asOf: now, digest });
  const html = reminderBatchHtml({ owner: user, a, b, c, links, asOf: now, digest });
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
      for (const x of [...b, ...c]) {
        run('UPDATE applications SET last_b_notified_at = ? WHERE id = ? AND owner_id = ?', [nowIso(), x.app.id, ownerId]);
      }
      if (digest.due) {
        run('UPDATE notification_preferences SET last_review_digest_at = ?, updated_at = ? WHERE owner_id = ?',
          [nowIso(), nowIso(), ownerId]);
      }
      bumpRevision();
    });
    return {
      owner_id: ownerId, business_date: businessDate, batch_id: batchId, status: 'sent',
      items_a: a.length, items_b: b.length, items_c: c.length,
      review_digest: digest.due ? digest.total : 0,
      provider_message_id: sent.messageId, transport: sent.transport
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
  const { prefs, a, b, c } = buildReminderCandidates(ownerId, now);
  const digest = reviewDigestState(ownerId, now);
  return {
    mode: prefs.mode,
    frequency: prefs.review_frequency,
    threshold_days: prefs.review_threshold_days,
    stage_followup_days: prefs.stage_followup_days,
    a: a.map((x) => ({
      application_id: x.app.id, company_name: x.app.company_name, job_title: x.app.job_title,
      summary: x.outbox.summary, occurred_at: x.outbox.occurred_at,
      source_received_at: receivedAtOf(x.outbox), received_at_label: fullDateLabel(receivedAtOf(x.outbox))
    })),
    b: b.map((x) => ({
      application_id: x.app.id, company_name: x.app.company_name, job_title: x.app.job_title,
      applied_at: x.app.applied_at, days_since_applied: daysBetweenShanghai(x.app.applied_at, now),
      has_safe_link: !!(x.app.status_url || x.app.job_url)
    })),
    c: c.map((x) => ({
      application_id: x.app.id, company_name: x.app.company_name, job_title: x.app.job_title,
      status: x.app.status, stage_label: STAGE_LABELS[x.app.status] || x.app.status,
      anchor: x.anchor, anchor_label: dateLabel(x.anchor), days_since_stage: x.days,
      status_url: x.app.status_url || x.app.job_url,
      has_safe_link: !!(x.app.status_url || x.app.job_url)
    })),
    review_digest: digest,
    would_send: a.length + b.length + c.length > 0 || digest.due,
    note: '预览只读；是否实际发送还受批次窗口、频控和发信配置影响'
  };
}

export function currentDataRevision() {
  return dataRevision();
}
