import crypto from 'node:crypto';
import { config } from '../config.js';
import { all, bumpRevision, getApplication, markApplicationChanged, one, run, transaction } from '../db.js';
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
  for (const field of ['company_name', 'job_title']) {
    if (field in changes && !requiredField(changes[field])) {
      throw new AppError(422, 'REVIEW_FIELDS_REQUIRED', '公司和岗位都是必填项，不能使用空值或占位文字', { details: { missing: [field] } });
    }
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
    if (updates.status && updates.status !== app.status) updates.manual_status_at = nowIso();
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

export function setApplicationStatusManually({ ownerId, applicationId, expectedVersion, status: rawStatus,
  appliedAt = null, appliedAtPrecision = null, reason = '用户手动修改状态', actor = 'user' }) {
  const status = normalizeStatus(rawStatus);
  if (!status) throw new AppError(400, 'VALIDATION_ERROR', '未知状态');
  if (status === 'pending') {
    const app = getApplication(ownerId, applicationId);
    if (!app) throw new AppError(404, 'NOT_FOUND', '记录不存在');
  }
  const changes = { status };
  if (appliedAt) {
    changes.applied_at = appliedAt;
    changes.applied_at_precision = appliedAtPrecision || 'date';
  }
  return correctApplication({
    ownerId, applicationId, expectedVersion, changes,
    reason, actor
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
    if (changes.applied_at_precision === 'inferred_before' && !config.d12AllowMailInferredAppliedAt) {
      throw new AppError(422, 'D12_NOT_FROZEN', '当前关闭了邮件推断，请填写实际投递时间');
    }
    const sourceMail = review.source_mail_id ? one('SELECT received_at FROM mail_messages WHERE id = ? AND owner_id = ?', [review.source_mail_id, ownerId]) : null;
    const inferredAt = sourceMail?.received_at || (review.source_mail_id ? one('SELECT occurred_at FROM events WHERE id = ? AND owner_id = ?', [review.source_event_id, ownerId])?.occurred_at : null);
    const resolution = (data, before = null, after = null) => JSON.stringify({ ...data,
      undo_until: new Date(Date.now() + 10000).toISOString(), before, after_version: after?.version || null });
    if (action === 'dismiss') {
      run(`UPDATE review_items SET status = 'dismissed', resolution_json = ?, resolved_at = ?, version = version + 1
           WHERE id = ? AND owner_id = ?`,
      [resolution({ resolution: 'dismissed', reason: reason || null }), nowIso(), reviewId, ownerId]);
      bumpRevision();
      setEventIgnored(ownerId, review.source_event_id);
      audit(ownerId, actor, 'review.dismiss', 'review', reviewId, { idempotency_key: idempotencyKey });
      return { review: one('SELECT * FROM review_items WHERE id = ? AND owner_id = ?', [reviewId, ownerId]) };
    }
    if (action === 'create') {
      const fields = { ...suggested, ...(changes || {}) };
      // 允许公司和岗位为空：线索本身（事件/邮件/标题/正文）仍是可追溯的台账记录。
      const candidates = findCandidates(ownerId, { ...fields, canonical_job_url: canonicalJobUrl(fields.job_url) });
      const distinctJobOnSharedPage = review.reason_code === 'PAGE_CONTENT_IDENTITY_UNCERTAIN'
        && candidates.every(c => c.application.job_title !== fields.job_title);
      if (candidates.length && !distinctJobOnSharedPage) {
        throw new AppError(409, 'VERSION_CONFLICT', '创建时发现新的候选记录，不能强行新增', {
          details: { candidates: candidates.map((c) => ({ application_id: c.application.id, reason: c.reason })) }
        });
      }
      const targetStatus = normalizeStatus(fields.status) || (fields.has_applied ? 'applied' : 'pending');
      if (targetStatus !== 'pending' && !fields.applied_at && inferredAt && config.d12AllowMailInferredAppliedAt) {
        fields.applied_at = inferredAt;
        fields.applied_at_precision = 'inferred_before';
      }
      if (targetStatus !== 'pending' && !fields.applied_at && !config.d12AllowMissingAppliedAt) {
        throw new AppError(422, 'D12_NOT_FROZEN', '缺少可信投递时间，D12 未冻结');
      }
      fields.manual_status_at = nowIso();
      const app = createApplication({
        ownerId, fields, eventId: review.source_event_id, sourceMethod: 'manual', status: targetStatus,
        at: fields.applied_at || nowIso()
      });
      setEventEventApplication(ownerId, review.source_event_id, app.id);
      run(`UPDATE review_items SET status = 'resolved', resolution_json = ?, resolved_at = ?, version = version + 1
           WHERE id = ? AND owner_id = ?`,
      [resolution({ resolution: 'created', application_id: app.id }, null, app), nowIso(), reviewId, ownerId]);
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
    // A suggestion identifies an unknown application; linking must not rename an existing one.
    for (const field of ['company_name', 'job_title']) if (!(field in changes)) delete mergedChanges[field];
    if (!app.applied_at && !mergedChanges.applied_at && inferredAt && config.d12AllowMailInferredAppliedAt) {
      mergedChanges.applied_at = inferredAt;
      mergedChanges.applied_at_precision = 'inferred_before';
    }
    const event = one('SELECT * FROM events WHERE id = ? AND owner_id = ?', [review.source_event_id || '', ownerId]);
    const result = applyReviewChangesToApplication({
      app, review, event, mergedChanges, reason: reason || '复核确认', ownerId, actor
    });
    run(`UPDATE review_items SET status = 'resolved', resolution_json = ?, resolved_at = ?, version = version + 1
         WHERE id = ? AND owner_id = ?`,
    [resolution({ resolution: action === 'link' ? 'linked' : 'confirmed', application_id: result.application.id }, app, result.application),
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

export function reviewSourceFields(review, event) {
  const payload = event?.payload || {};
  const evidence = safeJsonParse(review.evidence_json, {}) || {};
  const page = evidence.page || {};
  const pick = (key) => payload[key] != null && payload[key] !== ''
    ? payload[key]
    : (page[key] != null && page[key] !== '' ? page[key] : null);
  const fields = {
    company_name: pick('company_name'),
    job_title: pick('job_title'),
    site_key: event?.site_key || page.site_key || null,
    site_job_id: pick('site_job_id'),
    site_application_id: pick('site_application_id'),
    job_url: pick('job_url'),
    jd_summary: pick('jd_summary'),
    jd_text: payload.jd_text || null,
    location: pick('location'),
    recruitment_batch: pick('recruitment_batch'),
    channel: pick('channel'),
    status_url: pick('status_url'),
    status_url_scope: pick('status_url_scope'),
    applied_at: payload.applied_at || null,
    applied_at_precision: payload.applied_at_precision || null
  };
  if (fields.job_url && !isSafeHttpUrl(fields.job_url)) fields.job_url = null;
  if (fields.status_url && !isSafeHttpUrl(fields.status_url)) fields.status_url = null;
  return fields;
}

/* 按“用户选择的状态”直接把待确认项落到台账。
 * 强身份（site_application_id / site_job_id / canonical_job_url）唯一时才更新已有记录；
 * 仅公司+岗位相同不合并；没有强身份则用当前线索新建。 */
const INVALID_REQUIRED_FIELD = /^(?:待补充|未知|不详|未填写|未识别|系统判断|面试|通知|提醒|无|—|-)?$/i;
function requiredField(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length >= 2 && !INVALID_REQUIRED_FIELD.test(text)
    && !/系统判断|批次待补充|城市待补充|还没有投递记录|招聘邮件更新候选|加分项或注意事项|基本信息/i.test(text);
}

export function assignReview({ ownerId, reviewId, expectedVersion, status: rawStatus, appliedAt: rawAppliedAt,
  appliedAtPrecision: rawPrecision, applicationId = null, expectedApplicationVersion = null,
  changes = {}, reason = null, actor = 'user', idempotencyKey = null }) {
  return transaction(() => {
    const review = one('SELECT * FROM review_items WHERE id = ? AND owner_id = ?', [reviewId, ownerId]);
    if (!review) throw new AppError(404, 'NOT_FOUND', '待确认项不存在');
    if (review.status !== 'open') {
      return {
        review: { ...review, resolution: safeJsonParse(review.resolution_json, null) },
        application: review.resolution_json ? safeJsonParse(review.resolution_json, {})?.application_id
          ? getApplication(ownerId, safeJsonParse(review.resolution_json, {}).application_id) : null : null,
        already_resolved: true
      };
    }
    if (Number(expectedVersion) !== review.version) {
      throw new AppError(409, 'VERSION_CONFLICT', '待确认项已更新，请刷新后重试', { details: { current_version: review.version } });
    }
    const status = normalizeStatus(rawStatus);
    if (status !== 'pending' && !APPLIED_STATUSES.has(status)) {
      throw new AppError(400, 'VALIDATION_ERROR', '状态只能是看过没投、已投递、笔试、面试、录用或拒绝');
    }
    const event = review.source_event_id
      ? one('SELECT * FROM events WHERE id = ? AND owner_id = ?', [review.source_event_id, ownerId])
      : null;
    const sourceIsMail = Boolean(review.source_mail_id) || event?.source_method === 'mail'
      || String(event?.event_type || '').startsWith('mail_');
    const suggested = safeJsonParse(review.suggested_changes_json, {}) || {};
    const fields = reviewSourceFields(review, event);
    for (const [key, value] of Object.entries(changes || {})) {
      if (['company_name', 'job_title', 'jd_summary', 'jd_text', 'job_url', 'location', 'recruitment_batch'].includes(key) && value != null) {
        fields[key] = value;
      }
    }
    const appliedLike = APPLIED_STATUSES.has(status);
    let appliedAt = parseIso(rawAppliedAt) || parseIso(suggested.applied_at) || parseIso(fields.applied_at) || null;
    let appliedPrecision = rawPrecision || suggested.applied_at_precision || fields.applied_at_precision || null;
    if (!appliedAt && appliedLike && event?.event_type === 'application_submitted') {
      appliedAt = parseIso(event.occurred_at) || null;
      appliedPrecision = 'exact';
    }
    const mail = review.source_mail_id
      ? one('SELECT received_at FROM mail_messages WHERE id = ? AND owner_id = ?', [review.source_mail_id, ownerId])
      : null;
    if (!appliedAt && appliedLike && sourceIsMail && config.d12AllowMailInferredAppliedAt) {
      appliedAt = parseIso(mail?.received_at) || null;
      if (appliedAt) appliedPrecision = 'inferred_before';
    }
    if (appliedLike && !appliedAt && !config.d12AllowMissingAppliedAt) {
      throw new AppError(422, 'APPLIED_AT_REQUIRED', '请填写实际投递时间后再确认；不会用确认入账的时间代替', {
        details: { requires_applied_at: true }
      });
    }
    if (appliedLike && !appliedPrecision) appliedPrecision = event?.event_type === 'application_submitted' ? 'exact'
      : (rawAppliedAt ? 'exact' : (sourceIsMail ? 'inferred_before' : 'exact'));

    let target = null;
    let ambiguous = null;
    if (applicationId) {
      target = getApplication(ownerId, applicationId);
      if (!target) throw new AppError(404, 'NOT_FOUND', '要更新的岗位记录不存在');
      if (target.archived_at) throw new AppError(409, 'APPLICATION_ARCHIVED', '该岗位已归档，请先恢复或选择其他记录');
      if (expectedApplicationVersion == null) throw new AppError(400, 'VALIDATION_ERROR', '缺少目标记录版本');
      validateApplicationVersion(target, expectedApplicationVersion);
    } else {
      const candidates = findCandidates(ownerId, {
        ...fields, canonical_job_url: canonicalJobUrl(fields.job_url)
      }).filter((c) => ['site_application_id', 'site_job_id', 'canonical_job_url'].includes(c.reason)
        && !c.application.archived_at);
      if (candidates.length > 1) ambiguous = candidates;
      else if (candidates.length === 1) target = candidates[0].application;
    }
    if (ambiguous) {
      throw new AppError(409, 'REVIEW_ASSIGN_AMBIGUOUS', '多个已有岗位都匹配这条线索，请选择要更新的记录', {
        details: {
          candidates: ambiguous.map((c) => ({
            application_id: c.application.id,
            application_version: c.application.version,
            company_name: c.application.company_name,
            job_title: c.application.job_title,
            status: c.application.status,
            has_applied: !!c.application.has_applied,
            match_reason: c.reason
          }))
        }
      });
    }
    // 公司、岗位是入账必填项；占位文字/阶段词不能作为名称。
    const effectiveCompany = changes.company_name !== undefined ? changes.company_name
      : (fields.company_name || target?.company_name || '');
    const effectiveTitle = changes.job_title !== undefined ? changes.job_title
      : (fields.job_title || target?.job_title || '');
    if (!requiredField(effectiveCompany) || !requiredField(effectiveTitle)) {
      throw new AppError(422, 'REVIEW_FIELDS_REQUIRED', '公司和岗位都是必填项，请根据原始线索补充或纠正后再入账', {
        details: { missing: [!requiredField(effectiveCompany) ? 'company_name' : null, !requiredField(effectiveTitle) ? 'job_title' : null].filter(Boolean) }
      });
    }
    if (changes.company_name !== undefined) fields.company_name = effectiveCompany;
    if (changes.job_title !== undefined) fields.job_title = effectiveTitle;
    if (status === 'pending' && target?.has_applied) {
      throw new AppError(403, 'APPLIED_FACT_REMOVAL', '这条岗位已经投递，不能改成看过没投');
    }
    const before = target ? { ...target } : null;
    let application = target;
    let created = false;
    if (target) {
      const merged = { status };
      for (const key of ['company_name', 'job_title', 'jd_summary', 'jd_text', 'job_url', 'location', 'recruitment_batch']) {
        if (changes[key] !== undefined) merged[key] = changes[key] === '' ? null : changes[key];
      }
      if (appliedLike) {
        merged.has_applied = true;
        if (appliedAt && !target.applied_at) {
          merged.applied_at = appliedAt;
          merged.applied_at_precision = appliedPrecision;
        }
      }
      const result = applyReviewChangesToApplication({
        app: target, review, event, mergedChanges: merged,
        reason: reason || (status === 'pending' ? '按状态确认：看过没投' : `按状态确认：${status}`),
        ownerId, actor
      });
      application = result.application;
    } else {
      // 空白公司和岗位允许入账；不要用占位公司/岗位伪造身份，也不参与候选合并。
      const createFields = { ...fields, company_name: effectiveCompany, job_title: effectiveTitle };
      createFields.manual_status_at = nowIso();
      if (appliedLike) {
        createFields.applied_at = appliedAt;
        createFields.applied_at_precision = appliedPrecision;
      }
      if (status === 'pending' && event?.event_type === 'job_viewed') {
        createFields.first_viewed_at = event.occurred_at;
        createFields.last_viewed_at = event.observed_at;
      }
      application = createApplication({
        ownerId, fields: createFields, eventId: review.source_event_id || null, sourceMethod: 'manual',
        status, at: appliedAt || event?.occurred_at || nowIso()
      });
      created = true;
      if (review.source_event_id) setEventEventApplication(ownerId, review.source_event_id, application.id);
    }
    const undoUntil = new Date(Date.now() + 10000).toISOString();
    const resolution = JSON.stringify({
      resolution: created ? 'assigned_created' : 'assigned_updated',
      assignment_status: status,
      application_id: application.id,
      idempotency_key: idempotencyKey,
      undo_until: undoUntil,
      before,
      after_version: application.version || null
    });
    run(`UPDATE review_items SET status = 'resolved', resolution_json = ?, resolved_at = ?, version = version + 1
         WHERE id = ? AND owner_id = ?`, [resolution, nowIso(), reviewId, ownerId]);
    if (!created && review.source_event_id) {
      run(`UPDATE events SET application_id = ?, processing_state = 'applied', review_reason = NULL, processed_at = ?
           WHERE id = ? AND owner_id = ?`, [application.id, nowIso(), review.source_event_id, ownerId]);
    }
    bumpRevision();
    audit(ownerId, actor, 'review.assign', 'review', reviewId, {
      application_id: application.id, status, created, idempotency_key: idempotencyKey
    });
    return {
      review: one('SELECT * FROM review_items WHERE id = ? AND owner_id = ?', [reviewId, ownerId]),
      application: getApplication(ownerId, application.id),
      created,
      already_resolved: false
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
  if (app.archive_reason === '撤销待确认新建') { updates.archived_at = null; updates.archive_reason = null; }
  if (mergedChanges.company_name) updates.company_name = normalizeWhitespace(mergedChanges.company_name, 200);
  if (mergedChanges.job_title) updates.job_title = normalizeWhitespace(mergedChanges.job_title, 200);
  if (mergedChanges.jd_summary) updates.jd_summary = clipText(mergedChanges.jd_summary, 80);
  if (mergedChanges.job_url && isSafeHttpUrl(mergedChanges.job_url)) updates.job_url = mergedChanges.job_url;
  if (mergedChanges.status_url && isSafeHttpUrl(mergedChanges.status_url)) updates.status_url = mergedChanges.status_url;
  if (mergedChanges.location) updates.location = clipText(mergedChanges.location, 100);
  if (mergedChanges.recruitment_batch) updates.recruitment_batch = clipText(mergedChanges.recruitment_batch, 100);
  if (mergedChanges.applied_at) {
    updates.applied_at = parseIso(mergedChanges.applied_at);
    if (!updates.applied_at) throw new AppError(400, 'VALIDATION_ERROR', '投递时间格式不正确');
  }
  if (mergedChanges.applied_at_precision) updates.applied_at_precision = mergedChanges.applied_at_precision;
  if (mergedChanges.interview_scheduled_at) updates.interview_scheduled_at = parseIso(mergedChanges.interview_scheduled_at);
  if (mergedChanges.last_interview_completed_at) updates.last_interview_completed_at = parseIso(mergedChanges.last_interview_completed_at);
  if (mergedChanges.interview_round) updates.interview_round = Number(mergedChanges.interview_round);
  if (mergedChanges.round_label) updates.round_label = clipText(mergedChanges.round_label, 40);
  // 同名邮件的轮次规则（2026-10-23 用户拍板）：同一公司+岗位又收到一封更晚的面试邮件，
  // 视为进入下一轮（一面→二面），用时间而不是标题区分。
  if (normalizeStatus(mergedChanges.status) === 'interview' && !mergedChanges.interview_round && !mergedChanges.round_label) {
    const mail = review.source_mail_id
      ? one('SELECT received_at FROM mail_messages WHERE id = ? AND owner_id = ?', [review.source_mail_id, ownerId])
      : null;
    const receivedAt = parseIso(mail?.received_at);
    // 用「本阶段原信收到的日期」作锚点，而不是 last_progress_at（人工确认会把它改成现在）。
    const lastProgress = parseIso(app.stage_received_at) || parseIso(app.last_progress_at) || parseIso(app.last_status_changed_at);
    if (receivedAt && (!lastProgress || receivedAt > lastProgress)) {
      const next = Math.max(1, Number(app.interview_round || 0) + 1);
      updates.interview_round = next;
      updates.round_label = `第${next}面`;
    }
  }
  const targetStatus = normalizeStatus(mergedChanges.status);
  if ((targetStatus && APPLIED_STATUSES.has(targetStatus)) && !app.applied_at && !updates.applied_at && !config.d12AllowMissingAppliedAt) {
    throw new AppError(422, 'D12_NOT_FROZEN', '请补充投递时间后提交');
  }
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
      updates.manual_status_at = nowIso();
    }
  }
  if (!Object.keys(updates).length) {
    return { application: app };
  }
  const eventId = event?.id || newId('evt');
  const updated = markApplicationChanged(ownerId, app.id, eventId, 'manual', updates, { reason });
  if (updates.status && updates.status !== app.status) {
    run(`INSERT INTO notification_outbox
      (id, owner_id, application_id, event_id, kind, summary, occurred_at, source_received_at, created_at)
      VALUES (?, ?, ?, ?, 'status_change', ?, ?, ?, ?)`,
    [newId('out'), ownerId, app.id, eventId, `${updated.company_name} · ${updated.job_title}：${app.status} → ${updated.status}`,
      nowIso(), event?.source_method === 'mail' ? event.occurred_at : nowIso(), nowIso()]);
  }
  return { application: updated };
}

export function undoReview({ ownerId, reviewId, expectedVersion }) {
  return transaction(() => {
    const review = one('SELECT * FROM review_items WHERE id = ? AND owner_id = ?', [reviewId, ownerId]);
    if (!review) throw new AppError(404, 'NOT_FOUND', '待确认项不存在');
    if (review.version !== Number(expectedVersion)) throw new AppError(409, 'VERSION_CONFLICT', '这条刚被更新过，已刷新，请再确认一次');
    const result = safeJsonParse(review.resolution_json, {});
    if (review.status === 'open' || !result.undo_until || Date.parse(result.undo_until) < Date.now()) throw new AppError(409, 'UNDO_EXPIRED', '撤销时间已过，请在台账详情中纠错');
    if (result.application_id) {
      const app = getApplication(ownerId, result.application_id);
      if (!app || app.version !== result.after_version) throw new AppError(409, 'VERSION_CONFLICT', '记录已有新变化，请在详情中纠错');
      const restore = {};
      if (result.before) {
        for (const key of [...CORRECTION_FIELDS, 'has_applied', 'company_key', 'last_status_changed_at', 'last_progress_at', 'stage_received_at', 'stage_anchor_at', 'last_reviewed_at', 'archived_at', 'archive_reason']) {
          if (app[key] !== result.before[key]) restore[key] = result.before[key] ?? null;
        }
      } else {
        restore.archived_at = nowIso(); restore.archive_reason = '撤销待确认新建';
        run('UPDATE review_items SET candidates_json = ? WHERE id = ?', [JSON.stringify([{ application_id: app.id, application_version: app.version + 1, company_name: app.company_name, job_title: app.job_title }]), reviewId]);
      }
      if (Object.keys(restore).length) markApplicationChanged(ownerId, app.id, null, 'manual', restore, { reason: '撤销待确认操作' });
      run('DELETE FROM notification_outbox WHERE owner_id = ? AND application_id = ? AND event_id = ? AND consumed_batch_id IS NULL', [ownerId, app.id, review.source_event_id]);
    }
    run("UPDATE review_items SET status = 'open', resolution_json = NULL, resolved_at = NULL, version = version + 1 WHERE id = ? AND owner_id = ?", [reviewId, ownerId]);
    if (review.source_event_id) run("UPDATE events SET processing_state = 'pending', review_reason = ? WHERE id = ? AND owner_id = ?", [review.reason_code, review.source_event_id, ownerId]);
    bumpRevision();
    audit(ownerId, 'user', 'review.undo', 'review', reviewId);
    return { undone: true };
  });
}

export function undoAutomaticMail({ ownerId, applicationId, historyId, expectedVersion }) {
  return transaction(() => {
    const app = getApplication(ownerId, applicationId);
    if (!app) throw new AppError(404, 'NOT_FOUND', '记录不存在');
    validateApplicationVersion(app, expectedVersion);
    const entry = one('SELECT rowid AS sequence, * FROM application_history WHERE id = ? AND owner_id = ? AND application_id = ? AND source_method = ?', [historyId, ownerId, applicationId, 'mail']);
    if (!entry || !entry.event_id) throw new AppError(404, 'NOT_FOUND', '自动更新历史不存在');
    const latest = one('SELECT event_id FROM application_history WHERE owner_id = ? AND application_id = ? ORDER BY rowid DESC LIMIT 1', [ownerId, applicationId]);
    if (latest?.event_id !== entry.event_id) throw new AppError(409, 'VERSION_CONFLICT', '此后已有新变化，请通过纠错处理');
    const updates = {};
    for (const h of all('SELECT changed_fields_json FROM application_history WHERE owner_id = ? AND application_id = ? AND event_id = ? ORDER BY rowid ASC', [ownerId, applicationId, entry.event_id])) {
      for (const [field, change] of Object.entries(safeJsonParse(h.changed_fields_json, {}))) {
        if (!(field in updates) && [...CORRECTION_FIELDS, 'has_applied', 'company_key', 'last_status_changed_at', 'last_progress_at', 'stage_received_at', 'stage_anchor_at', 'last_reviewed_at', 'source_methods_json'].includes(field)) updates[field] = change.from ?? null;
      }
    }
    if (TERMINAL.has(app.status) && updates.status !== app.status && !config.d05AllowTerminalCorrection) throw new AppError(409, 'D05_DISABLED', '当前关闭了终态纠错');
    markApplicationChanged(ownerId, applicationId, null, 'manual', updates, { reason: '邮件自动判定有误' });
    run('DELETE FROM notification_outbox WHERE owner_id = ? AND event_id = ? AND consumed_batch_id IS NULL', [ownerId, entry.event_id]);
    audit(ownerId, 'user', 'mail.auto_update.undo', 'application', applicationId, { history_id: historyId, reason: '邮件自动判定有误' });
    return { application: getApplication(ownerId, applicationId) };
  });
}
