import crypto from 'node:crypto';
import { config } from '../config.js';
import { bumpRevision, getApplication, markApplicationChanged, one, run, transaction } from '../db.js';
import {
  APPLIED_STATUSES, AppError, TERMINAL, canonicalJobUrl, clipText, isSafeHttpUrl, newId,
  normalizeWhitespace, nowIso, parseIso, safeJsonParse, shanghaiDateKey
} from '../util.js';
import { createApplication, findCandidates, mapStatusText, normalizeStatus } from './applications.js';

const CORRECTION_FIELDS = new Set([
  'company_name', 'job_title', 'recruitment_batch', 'location', 'jd_summary', 'channel', 'job_url',
  'status_url', 'status_url_scope', 'status', 'applied_at', 'applied_at_precision', 'deadline_at',
  'deadline_precision', 'interview_round', 'round_label', 'interview_scheduled_at', 'last_interview_completed_at'
]);

function audit(ownerId, actor, action, targetType, targetId, meta = {}) {
  run(`INSERT INTO audit_log (id, owner_id, actor, action, target_type, target_id, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [newId('aud'), ownerId, actor, action, targetType, targetId, JSON.stringify(meta), nowIso()]);
}

function validateApplicationVersion(app, expected) {
  if (expected == null) throw new AppError(400, 'VALIDATION_ERROR', '缺少 expected_version');
  if (Number(expected) !== app.version) {
    throw new AppError(409, 'VERSION_CONFLICT', '记录已更新，请刷新后重试', { details: { current_version: app.version } });
  }
}

function changesForCorrection(app, changes) {
  const updates = {};
  for (const [rawKey, rawValue] of Object.entries(changes)) {
    if (!CORRECTION_FIELDS.has(rawKey)) throw new AppError(400, 'VALIDATION_ERROR', `不允许修改字段：${rawKey}`);
    const key = rawKey;
    let value = rawValue;
    if (['company_name', 'job_title'].includes(key)) {
      value = normalizeWhitespace(value, 200);
      if (!value) throw new AppError(400, 'VALIDATION_ERROR', `${key} 不能为空`);
    } else if (key === 'jd_summary') {
      value = clipText(value, 80);
    } else if (['job_url', 'status_url'].includes(key)) {
      if (value === '' || value === null) value = null;
      else if (!isSafeHttpUrl(value)) throw new AppError(400, 'VALIDATION_ERROR', '链接必须是安全的 http(s) URL');
      else value = value;
    } else if (key === 'status') {
      value = normalizeStatus(value);
      if (!value) throw new AppError(400, 'VALIDATION_ERROR', '未知状态');
    } else if (['applied_at', 'deadline_at', 'interview_scheduled_at', 'last_interview_completed_at'].includes(key)) {
      value = value == null || value === '' ? null : parseIso(value);
      if (value === undefined) throw new AppError(400, 'VALIDATION_ERROR', `${key} 时间格式错误`);
    } else if (key === 'interview_round') {
      value = value == null ? null : Number(value);
      if (value != null && (!Number.isInteger(value) || value <= 0)) throw new AppError(400, 'VALIDATION_ERROR', '面次必须是正整数');
    } else if (['round_label', 'location', 'recruitment_batch', 'channel', 'status_url_scope', 'applied_at_precision', 'deadline_precision'].includes(key)) {
      value = value == null ? null : normalizeWhitespace(value, 100);
    }
    updates[key] = value;
  }
  return updates;
}

export function correctApplication({ ownerId, applicationId, expectedVersion, changes, reason, actor = 'user', eventId = null }) {
  if (!reason || normalizeWhitespace(reason, 500).length < 2) {
    throw new AppError(400, 'VALIDATION_ERROR', '纠错原因必填');
  }
  if (!changes || typeof changes !== 'object' || !Object.keys(changes).length) {
    throw new AppError(400, 'VALIDATION_ERROR', '没有要修改的字段');
  }
  return transaction(() => {
    const app = getApplication(ownerId, applicationId);
    if (!app) throw new AppError(404, 'NOT_FOUND', '记录不存在');
    validateApplicationVersion(app, expectedVersion);
    const updates = changesForCorrection(app, changes);
    if (updates.status) {
      if (updates.status === 'pending') {
        if (app.has_applied) {
          throw new AppError(403, 'APPLIED_FACT_REMOVAL', '不能在纠错中直接撤销已投事实；请走明确的终态纠错评审');
        }
      } else if (APPLIED_STATUSES.has(updates.status)) {
        updates.has_applied = 1;
      }
      if (app.status === updates.status) delete updates.status;
    }
    if (TERMINAL.has(app.status) && (updates.status && updates.status !== app.status || updates.has_applied === 0)) {
      if (!config.d05AllowTerminalCorrection) {
        throw new AppError(409, 'D05_DISABLED', '终态纠错已被环境变量关闭（D05_ALLOW_TERMINAL_CORRECTION=false）', {
          details: { current_status: app.status, requested_status: updates.status || app.status }
        });
      }
    }
    if ((updates.has_applied === 1 || APPLIED_STATUSES.has(updates.status)) && !app.applied_at && !updates.applied_at && !config.d12AllowMissingAppliedAt) {
      throw new AppError(422, 'D12_NOT_FROZEN', '缺少可信投递时间，不能把记录改为已投；D12 未冻结');
    }
    if (updates.status && APPLIED_STATUSES.has(updates.status)) {
      updates.last_status_changed_at = nowIso();
      updates.last_progress_at = nowIso();
    }
    if (updates.last_interview_completed_at && updates.last_interview_completed_at !== app.last_interview_completed_at) {
      updates.last_progress_at = nowIso();
    }
    if (updates.company_name) {
      updates.company_key = normalizeWhitespace(updates.company_name, 200).toLowerCase().replace(/[\s·•,，.。有限公司股份集团]+/g, '');
    }
    if (!Object.keys(updates).length) {
      return { application: app, changed: false };
    }
    const occurredAt = nowIso();
    const correctionEventId = eventId || newId('evt');
    run(`INSERT INTO events
      (id, owner_id, client_event_id, source_method, event_type, occurred_at, observed_at, received_at,
       schema_version, evidence_level, evidence_code, payload_json, payload_hash, processing_state, application_id, processed_at)
      VALUES (?, ?, ?, 'manual', 'manual_correction', ?, ?, ?, 'C1', 'strong', 'user-explicit', ?, ?, 'applied', ?, ?)`,
    [correctionEventId, ownerId, `correction:${correctionEventId}`, occurredAt, occurredAt, nowIso(),
      JSON.stringify({ changes, reason }), newId('ph'), applicationId, occurredAt]);
    const updated = markApplicationChanged(ownerId, applicationId, correctionEventId, 'manual', updates, { reason });
    audit(ownerId, actor, 'application.correction', 'application', applicationId, { fields: Object.keys(updates), reason });
    return { application: updated, changed: true, event_id: correctionEventId };
  });
}

export function archiveApplication({ ownerId, applicationId, expectedVersion, archive, reason, actor = 'user' }) {
  return transaction(() => {
    const app = getApplication(ownerId, applicationId);
    if (!app) throw new AppError(404, 'NOT_FOUND', '记录不存在');
    validateApplicationVersion(app, expectedVersion);
    const wantsArchive = Boolean(archive);
    if (wantsArchive && (!reason || normalizeWhitespace(reason, 500).length < 2)) {
      throw new AppError(400, 'VALIDATION_ERROR', '归档原因必填');
    }
    if (wantsArchive && app.archived_at) return { application: app, changed: false };
    if (!wantsArchive && !app.archived_at) return { application: app, changed: false };
    const updates = wantsArchive
      ? { archived_at: nowIso(), archive_reason: clipText(reason, 200) }
      : { archived_at: null, archive_reason: null };
    const eventId = newId('evt');
    run(`INSERT INTO events
      (id, owner_id, client_event_id, source_method, event_type, occurred_at, observed_at, received_at,
       schema_version, evidence_level, evidence_code, payload_json, payload_hash, processing_state, application_id, processed_at)
      VALUES (?, ?, ?, 'manual', 'manual_correction', ?, ?, ?, 'C1', 'strong', 'user-explicit', ?, ?, 'applied', ?, ?)`,
    [eventId, ownerId, `archive:${eventId}`, nowIso(), nowIso(), nowIso(),
      JSON.stringify({ archive: wantsArchive, reason }), newId('ph'), applicationId, nowIso()]);
    const updated = markApplicationChanged(ownerId, applicationId, eventId, 'manual', updates, { reason: wantsArchive ? '归档' : '恢复归档' });
    audit(ownerId, actor, wantsArchive ? 'application.archive' : 'application.unarchive', 'application', applicationId, { reason });
    return { application: updated, changed: true };
  });
}

export function markApplicationReviewed({ ownerId, applicationId, expectedVersion, context, confirmationToken, actor = 'user' }) {
  return transaction(() => {
    const app = getApplication(ownerId, applicationId);
    if (!app) throw new AppError(404, 'NOT_FOUND', '记录不存在');
    validateApplicationVersion(app, expectedVersion);
    let confirmation = null;
    let link = null;
    if (context === 'reminder') {
      if (!confirmationToken) throw new AppError(400, 'VALIDATION_ERROR', '邮件确认缺少动作凭据');
      confirmation = one('SELECT * FROM reminder_confirmations WHERE token_hash = ? AND owner_id = ? AND application_id = ?',
        [sha256Token(confirmationToken), ownerId, applicationId]);
      if (!confirmation) throw new AppError(409, 'CONFIRMATION_INVALID', '确认资格无效，请重新从邮件打开');
      link = one('SELECT * FROM reminder_links WHERE id = ? AND owner_id = ?', [confirmation.link_id, ownerId]);
      if (!link) throw new AppError(404, 'NOT_FOUND', '提醒链接不存在');
      if (link.completed_at) {
        return {
          application: app,
          reviewed_at: app.last_reviewed_at,
          changed: false,
          completed: true,
          reminder_result: safeJsonParse(link.confirmation_result_json, null)
        };
      }
      if (confirmation.state !== 'ready') throw new AppError(409, 'CONFIRMATION_CONSUMED', '确认资格已使用，请重新打开邮件');
      if (Date.parse(confirmation.expires_at) < Date.now()) {
        run("UPDATE reminder_confirmations SET state = 'expired' WHERE id = ?", [confirmation.id]);
        throw new AppError(409, 'CONFIRMATION_EXPIRED', '确认资格已过期，请重新点击确认');
      }
      if (confirmation.application_version !== app.version) {
        throw new AppError(409, 'VERSION_CONFLICT', '记录已更新，请刷新后重新确认');
      }
    } else if (context !== 'ledger') {
      throw new AppError(400, 'VALIDATION_ERROR', 'context 只能是 ledger 或 reminder');
    }
    const today = shanghaiDateKey(new Date());
    if (app.last_reviewed_at && shanghaiDateKey(app.last_reviewed_at) === today) {
      if (confirmation) {
        run("UPDATE reminder_confirmations SET state = 'consumed', consumed_at = ? WHERE id = ?", [nowIso(), confirmation.id]);
        const result = { reviewed_at: app.last_reviewed_at, application_version: app.version, same_day: true };
        run(`UPDATE reminder_links SET completed_at = ?, confirmation_result_json = ? WHERE id = ?`,
          [nowIso(), JSON.stringify(result), link.id]);
      }
      return { application: app, reviewed_at: app.last_reviewed_at, changed: false, completed: !!confirmation };
    }
    const reviewedAt = nowIso();
    run('UPDATE applications SET last_reviewed_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND owner_id = ?',
      [reviewedAt, reviewedAt, applicationId, ownerId]);
    bumpRevision();
    run(`INSERT INTO application_history
      (id, owner_id, application_id, event_id, from_status, to_status, changed_fields_json, changed_at, source_method, reason)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'manual', '用户确认状态无变化')`,
    [newId('hist'), ownerId, applicationId, app.status, app.status,
      JSON.stringify({ last_reviewed_at: { from: app.last_reviewed_at, to: reviewedAt } }), reviewedAt]);
    if (confirmation) {
      run("UPDATE reminder_confirmations SET state = 'consumed', consumed_at = ? WHERE id = ?", [nowIso(), confirmation.id]);
      const result = { reviewed_at: reviewedAt, application_version: app.version + 1, same_day: false };
      run('UPDATE reminder_links SET completed_at = ?, confirmation_result_json = ? WHERE id = ?',
        [reviewedAt, JSON.stringify(result), link.id]);
    }
    audit(ownerId, actor, 'application.reviewed_no_change', 'application', applicationId, { context: context || 'ledger' });
    const updated = getApplication(ownerId, applicationId);
    return { application: updated, reviewed_at: reviewedAt, changed: true, completed: !!confirmation };
  });
}

function sha256Token(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function setEventIgnored(ownerId, eventId) {
  if (!eventId) return;
  run(`UPDATE events SET processing_state = 'ignored', processed_at = ? WHERE id = ? AND owner_id = ?`,
    [nowIso(), eventId, ownerId]);
}

export function resolveReview({ ownerId, reviewId, expectedVersion, action, applicationId, expectedApplicationVersion,
  changes = {}, reason, actor = 'user', idempotencyKey }) {
  return transaction(() => {
    const review = one('SELECT * FROM review_items WHERE id = ? AND owner_id = ?', [reviewId, ownerId]);
    if (!review) throw new AppError(404, 'NOT_FOUND', '复核项不存在');
    if (review.status !== 'open') {
      return {
        review: { ...review, resolution: safeJsonParse(review.resolution_json, null) },
        already_resolved: true
      };
    }
    if (Number(expectedVersion) !== review.version) {
      throw new AppError(409, 'VERSION_CONFLICT', '复核项已更新，请刷新后重试', { details: { current_version: review.version } });
    }
    if (!['confirm', 'dismiss', 'link', 'create'].includes(action)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'action 无效');
    }
    const suggested = safeJsonParse(review.suggested_changes_json, {});
    if (action === 'dismiss') {
      run(`UPDATE review_items SET status = 'dismissed', resolution_json = ?, resolved_at = ?, version = version + 1
           WHERE id = ? AND owner_id = ?`,
      [JSON.stringify({ resolution: 'dismissed', reason: reason || null }), nowIso(), reviewId, ownerId]);
      setEventIgnored(ownerId, review.source_event_id);
      audit(ownerId, actor, 'review.dismiss', 'review', reviewId, { idempotency_key: idempotencyKey });
      return { review: one('SELECT * FROM review_items WHERE id = ? AND owner_id = ?', [reviewId, ownerId]) };
    }
    if (action === 'create') {
      const fields = { ...suggested, ...(changes || {}) };
      if (!fields.company_name || !fields.job_title) throw new AppError(400, 'VALIDATION_ERROR', '创建记录需要公司和岗位');
      const candidates = findCandidates(ownerId, { ...fields, canonical_job_url: canonicalJobUrl(fields.job_url) });
      if (candidates.length) {
        throw new AppError(409, 'VERSION_CONFLICT', '创建时发现新的候选记录，不能强行新增', {
          details: { candidates: candidates.map((c) => ({ application_id: c.application.id, reason: c.reason })) }
        });
      }
      const targetStatus = normalizeStatus(fields.status) || (fields.has_applied ? 'applied' : 'pending');
      if (targetStatus !== 'pending' && !fields.applied_at && !config.d12AllowMissingAppliedAt) {
        throw new AppError(422, 'D12_NOT_FROZEN', '缺少可信投递时间，D12 未冻结');
      }
      const app = createApplication({
        ownerId, fields, eventId: review.source_event_id, sourceMethod: 'manual', status: targetStatus,
        at: fields.applied_at || nowIso()
      });
      setEventEventApplication(ownerId, review.source_event_id, app.id);
      run(`UPDATE review_items SET status = 'resolved', resolution_json = ?, resolved_at = ?, version = version + 1
           WHERE id = ? AND owner_id = ?`,
      [JSON.stringify({ resolution: 'created', application_id: app.id }), nowIso(), reviewId, ownerId]);
      audit(ownerId, actor, 'review.create', 'review', reviewId, { application_id: app.id });
      return { review: one('SELECT * FROM review_items WHERE id = ? AND owner_id = ?', [reviewId, ownerId]), application: app };
    }
    let targetId = applicationId;
    if (!targetId) {
      const candidates = safeJsonParse(review.candidates_json, []);
      if (action === 'confirm' && candidates.length === 1) targetId = candidates[0].application_id;
      else if (action === 'link') throw new AppError(400, 'VALIDATION_ERROR', '请选择要关联的本人申请');
      else if (candidates.length > 0) throw new AppError(400, 'VALIDATION_ERROR', '该复核项有多个候选，请明确选择');
    }
    if (!targetId) throw new AppError(400, 'VALIDATION_ERROR', '缺少目标申请');
    const app = getApplication(ownerId, targetId);
    if (!app) throw new AppError(404, 'NOT_FOUND', '目标申请不存在');
    if (expectedApplicationVersion == null) {
      throw new AppError(400, 'VALIDATION_ERROR', '缺少 expected_application_version');
    }
    if (Number(expectedApplicationVersion) !== app.version) {
      throw new AppError(409, 'VERSION_CONFLICT', '目标申请已更新，请刷新后重试', {
        details: { current_version: app.version }
      });
    }
    const mergedChanges = { ...suggested, ...(changes || {}) };
    const event = one('SELECT * FROM events WHERE id = ? AND owner_id = ?', [review.source_event_id || '', ownerId]);
    const result = applyReviewChangesToApplication({
      app, review, event, mergedChanges, reason: reason || '复核确认', ownerId, actor
    });
    run(`UPDATE review_items SET status = 'resolved', resolution_json = ?, resolved_at = ?, version = version + 1
         WHERE id = ? AND owner_id = ?`,
    [JSON.stringify({ resolution: action === 'link' ? 'linked' : 'confirmed', application_id: result.application.id }),
      nowIso(), reviewId, ownerId]);
    if (review.source_event_id) {
      run(`UPDATE events SET application_id = ?, processing_state = 'applied', review_reason = NULL, processed_at = ?
           WHERE id = ? AND owner_id = ?`, [result.application.id, nowIso(), review.source_event_id, ownerId]);
    }
    audit(ownerId, actor, `review.${action}`, 'review', reviewId,
      { application_id: result.application.id, idempotency_key: idempotencyKey });
    return {
      review: one('SELECT * FROM review_items WHERE id = ? AND owner_id = ?', [reviewId, ownerId]),
      application: result.application
    };
  });
}

function setEventEventApplication(ownerId, eventId, applicationId) {
  if (!eventId) return;
  run(`UPDATE events SET application_id = ?, processing_state = 'applied', review_reason = NULL, processed_at = ?
       WHERE id = ? AND owner_id = ?`, [applicationId, nowIso(), eventId, ownerId]);
}

function applyReviewChangesToApplication({ app, review, event, mergedChanges, reason, ownerId, actor }) {
  const updates = {};
  if (mergedChanges.company_name) updates.company_name = normalizeWhitespace(mergedChanges.company_name, 200);
  if (mergedChanges.job_title) updates.job_title = normalizeWhitespace(mergedChanges.job_title, 200);
  if (mergedChanges.jd_summary) updates.jd_summary = clipText(mergedChanges.jd_summary, 80);
  if (mergedChanges.job_url && isSafeHttpUrl(mergedChanges.job_url)) updates.job_url = mergedChanges.job_url;
  if (mergedChanges.status_url && isSafeHttpUrl(mergedChanges.status_url)) updates.status_url = mergedChanges.status_url;
  if (mergedChanges.location) updates.location = clipText(mergedChanges.location, 100);
  if (mergedChanges.recruitment_batch) updates.recruitment_batch = clipText(mergedChanges.recruitment_batch, 100);
  if (mergedChanges.applied_at) updates.applied_at = parseIso(mergedChanges.applied_at);
  if (mergedChanges.applied_at_precision) updates.applied_at_precision = mergedChanges.applied_at_precision;
  if (mergedChanges.interview_scheduled_at) updates.interview_scheduled_at = parseIso(mergedChanges.interview_scheduled_at);
  if (mergedChanges.last_interview_completed_at) updates.last_interview_completed_at = parseIso(mergedChanges.last_interview_completed_at);
  if (mergedChanges.interview_round) updates.interview_round = Number(mergedChanges.interview_round);
  if (mergedChanges.round_label) updates.round_label = clipText(mergedChanges.round_label, 40);
  const targetStatus = normalizeStatus(mergedChanges.status);
  const shouldConfirmApplied = mergedChanges.has_applied === true || (targetStatus && APPLIED_STATUSES.has(targetStatus));
  if (shouldConfirmApplied && !app.has_applied) {
    updates.has_applied = 1;
    if (!app.applied_at && !updates.applied_at) {
      if (!config.d12AllowMissingAppliedAt) throw new AppError(422, 'D12_NOT_FROZEN', '缺少可信投递时间，D12 未冻结');
    }
    if (!targetStatus && app.status === 'pending') {
      updates.status = 'applied';
      updates.last_status_changed_at = nowIso();
      updates.last_progress_at = nowIso();
    }
  }
  if (targetStatus) {
    if (TERMINAL.has(app.status) && targetStatus !== app.status && !config.d05AllowTerminalCorrection && review.kind !== 'terminal_candidate') {
      throw new AppError(409, 'D05_DISABLED', '终态纠错已被环境变量关闭（D05_ALLOW_TERMINAL_CORRECTION=false）');
    }
    // D05 已冻结：从终态改走是人工纠错，历史与审计里要留清晰痕迹
    if (TERMINAL.has(app.status) && targetStatus !== app.status && (!reason || reason === '复核确认')) {
      reason = `终态人工纠错：${app.status} → ${targetStatus}`;
    }
    if (targetStatus === 'pending' && app.has_applied) {
      throw new AppError(403, 'APPLIED_FACT_REMOVAL', '不能通过复核撤销已投事实');
    }
    updates.status = targetStatus;
    if (APPLIED_STATUSES.has(targetStatus)) updates.has_applied = 1;
    if (targetStatus !== app.status) {
      updates.last_status_changed_at = nowIso();
      updates.last_progress_at = nowIso();
    }
  }
  if (!Object.keys(updates).length) {
    return { application: app };
  }
  const eventId = event?.id || newId('evt');
  const updated = markApplicationChanged(ownerId, app.id, eventId, 'manual', updates, { reason });
  if (updates.status && updates.status !== app.status) {
    run(`INSERT INTO notification_outbox
      (id, owner_id, application_id, event_id, kind, summary, occurred_at, created_at)
      VALUES (?, ?, ?, ?, 'status_change', ?, ?, ?)`,
    [newId('out'), ownerId, app.id, eventId, `${updated.company_name} · ${updated.job_title}：${app.status} → ${updated.status}`,
      nowIso(), nowIso()]);
  }
  return { application: updated };
}
