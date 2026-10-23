import { config } from '../config.js';
import { findProgressCandidates, companyIdentity, stageOfStatus } from './mailMatching.js';
import { all, bumpRevision, ensurePreferences, getApplication, markApplicationChanged, one, run, transaction } from '../db.js';
import {
  APPLIED_STATUSES, AppError, STATUSES, STATUS_LABELS, TERMINAL, addSourceMethod, canonicalJobUrl,
  clipText, daysBetweenShanghai, isDueForReview, isSafeHttpUrl, maxIso, newId, normalizeCompanyKey,
  normalizeWhitespace, nowIso, parseIso, safeJsonParse, sanitizeUrl, shanghaiDateKey, sourceMethods, stageFollowupState
} from '../util.js';

export const PUBLIC_APPLICATION_FIELDS = [
  'id', 'company_name', 'job_title', 'recruitment_batch', 'location', 'jd_summary', 'channel',
  'job_url', 'canonical_job_url', 'status_url', 'status_url_scope', 'status', 'has_applied',
  'applied_at', 'applied_at_precision', 'first_viewed_at', 'last_viewed_at', 'form_started_at',
  'last_status_changed_at', 'last_progress_at', 'last_site_observed_at', 'last_reviewed_at',
  'deadline_at', 'deadline_precision', 'interview_round', 'round_label', 'interview_scheduled_at',
  'last_interview_completed_at', 'source_methods', 'latest_event_id', 'version', 'created_at',
  'updated_at', 'archived_at', 'archive_reason', 'stage_received_at', 'stage_anchor_at'
];

export function getPreferences(ownerId) {
  ensurePreferences(ownerId);
  return one('SELECT * FROM notification_preferences WHERE owner_id = ?', [ownerId]);
}

export function reviewAnchor(app) {
  return maxIso(app.applied_at, app.last_progress_at, app.last_reviewed_at);
}

export function applicationProjection(app, preferences, asOf = new Date()) {
  const methods = safeJsonParse(app.source_methods_json, []);
  const due = isDueForReview(app, preferences.review_threshold_days, asOf) || stageFollowupState(app, preferences.stage_followup_days, asOf).due;
  const statusUrl = app.status_url && isSafeHttpUrl(app.status_url) ? app.status_url : null;
  const jobUrl = app.job_url && isSafeHttpUrl(app.job_url) ? app.job_url : null;
  const primaryStatusUrl = statusUrl || jobUrl;
  const primaryStatusUrlScope = statusUrl ? (app.status_url_scope || 'application') : (jobUrl ? 'job' : null);
  const out = {};
  for (const field of PUBLIC_APPLICATION_FIELDS) out[field] = app[field];
  out.source_methods = methods;
  out.field_confidence = Object.fromEntries(all('SELECT field, confidence FROM application_field_sources WHERE owner_id = ? AND application_id = ?', [app.owner_id, app.id]).map(x => [x.field,x.confidence]));
  out.days_since_applied = app.applied_at ? daysBetweenShanghai(app.applied_at, asOf) : null;
  out.days_since_interview = app.last_interview_completed_at
    ? daysBetweenShanghai(app.last_interview_completed_at, asOf) : null;
  out.due_for_review = due;
  out.review_anchor_at = reviewAnchor(app);
  out.primary_status_url = primaryStatusUrl;
  out.primary_status_url_scope = primaryStatusUrlScope;
  out.allowed_actions = allowedActions(app);
  out.status_label = STATUS_LABELS[app.status] || app.status;
  return out;
}

export function allowedActions(app) {
  const actions = ['view', 'correct', 'archive', 'reviewed'];
  if (TERMINAL.has(app.status)) actions.push('terminal_locked');
  if (app.archived_at) actions.push('unarchive');
  return actions;
}

export function getOwnerApplications(ownerId) {
  return all('SELECT * FROM applications WHERE owner_id = ? AND archived_at IS NULL ORDER BY updated_at DESC', [ownerId]);
}

export function normalizeStatus(value) {
  return STATUSES.includes(value) ? value : null;
}

export function mapStatusText(value) {
  const text = normalizeWhitespace(value, 200).toLowerCase();
  if (!text) return null;
  if (/offer|录用|意向书|录取/.test(text)) return 'offer';
  if (/未通过|不合适|遗憾|感谢信|拒绝|reject|not selected|unfortunately/.test(text)) return 'rejected';
  if (/流程结束|岗位关闭|已结束|撤回|closed|withdrawn/.test(text)) return 'closed';
  if (/面试|interview/.test(text)) return 'interview';
  if (/笔试|测评|考试|assessment|test/.test(text)) return 'assessment';
  if (/已投递|投递成功|申请成功|applied|submitted/.test(text)) return 'applied';
  if (/待投递|浏览|pending/.test(text)) return 'pending';
  return null;
}

function eventAppliedAt(event) {
  const payload = event.payload || {};
  return parseIso(payload.applied_at) || parseIso(payload.applied_date) || parseIso(event.occurred_at);
}

function isFormalComplete(fields) {
  const missing = [];
  if (!fields.company_name) missing.push('company_name');
  if (!fields.job_title) missing.push('job_title');
  if (!fields.jd_summary && !config.d12AllowMissingJd) missing.push('jd_summary');
  if (!fields.job_url && !config.d12AllowMissingLink) missing.push('job_url');
  if (!fields.applied_at && !config.d12AllowMissingAppliedAt) missing.push('applied_at');
  return { complete: missing.length === 0, missing };
}

export function findCandidates(ownerId, fields) {
  const candidates = [];
  const seen = new Set();
  const add = (rows, reason) => {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      candidates.push({ application: row, reason });
    }
  };
  if (fields.site_key && fields.site_application_id) {
    add(all(`SELECT * FROM applications WHERE owner_id = ? AND site_key = ? AND site_application_id = ?
      ORDER BY updated_at DESC`, [ownerId, fields.site_key, fields.site_application_id]), 'site_application_id');
  }
  if (fields.site_key && fields.site_job_id) {
    add(all(`SELECT * FROM applications WHERE owner_id = ? AND site_key = ? AND site_job_id = ?
      ORDER BY updated_at DESC`, [ownerId, fields.site_key, fields.site_job_id]), 'site_job_id');
  }
  if (fields.canonical_job_url) {
    add(all('SELECT * FROM applications WHERE owner_id = ? AND canonical_job_url = ? ORDER BY updated_at DESC',
      [ownerId, fields.canonical_job_url]), 'canonical_job_url');
  }
  const companyKey = normalizeCompanyKey(fields.company_name);
  if (companyKey && fields.job_title) {
    add(all(`SELECT * FROM applications WHERE owner_id = ? AND company_key = ?
      AND lower(job_title) = lower(?) ORDER BY updated_at DESC`,
    [ownerId, companyKey, normalizeWhitespace(fields.job_title, 200)]), 'company_title_only');
  }
  return candidates;
}

export function createReviewForEvent(event, { kind, reasonCode, summary, suggested = {}, fields = {}, evidence = {}, progressCandidates = null }) {
  if (event.source_method === 'mail') {
    suggested = { ...Object.fromEntries(['company_name', 'job_title', 'location', 'recruitment_batch', 'job_url', 'jd_summary', 'interview_scheduled_at', 'round_label'].filter(k => fields[k] || event.payload?.[k]).map(k => [k, fields[k] || event.payload[k]])), ...suggested };
  }
  const existing = one(`SELECT * FROM review_items WHERE owner_id = ? AND source_event_id = ? AND status = 'open'`,
    [event.owner_id, event.id]);
  if (existing) return existing;
  const candidates = (progressCandidates || findCandidates(event.owner_id, fields)).map(({ application, reason, confidence }) => ({
    application_id: application.id,
    application_version: application.version,
    company_name: application.company_name,
    job_title: application.job_title,
    location: application.location,
    recruitment_batch: application.recruitment_batch,
    status: application.status,
    has_applied: !!application.has_applied,
    match_reason: reason
    ,matching_confidence: confidence ?? null
  }));
  const id = newId('rev');
  run(`INSERT INTO review_items
    (id, owner_id, kind, reason_code, summary, evidence_json, suggested_changes_json, candidates_json,
     source_event_id, source_mail_id, status, version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?)`,
  [id, event.owner_id, kind, reasonCode, clipText(summary, 240), JSON.stringify(evidence),
    JSON.stringify(suggested), JSON.stringify(candidates), event.id,
    event.source_method === 'mail' ? (event.payload?.source_mail_id || one(`SELECT id FROM mail_messages WHERE owner_id = ? AND connection_id = ? AND mailbox = ? AND uidvalidity = ? AND uid = ?`,
      [event.owner_id, event.connection_id || '', event.mailbox || 'INBOX', event.uidvalidity || '', event.uid || ''])?.id || null) : null, nowIso()]);
  run(`UPDATE events SET processing_state = 'pending', review_reason = ?, processed_at = ? WHERE id = ? AND owner_id = ?`,
    [reasonCode, nowIso(), event.id, event.owner_id]);
  bumpRevision();
  return one('SELECT * FROM review_items WHERE id = ? AND owner_id = ?', [id, event.owner_id]);
}

function addInitialHistory(ownerId, applicationId, eventId, status, sourceMethod, fields) {
  run(`INSERT INTO application_history
    (id, owner_id, application_id, event_id, from_status, to_status, changed_fields_json, changed_at, source_method, reason)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'created')`,
  [newId('hist'), ownerId, applicationId, eventId, status,
    JSON.stringify(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { from: null, to: v }]))),
    nowIso(), sourceMethod]);
  const payload = eventId ? safeJsonParse(one('SELECT payload_json FROM events WHERE id = ? AND owner_id = ?', [eventId,ownerId])?.payload_json, {}) : {};
  for (const field of Object.keys(fields)) {
    run(`INSERT OR REPLACE INTO application_field_sources
      (application_id, owner_id, field, source_method, event_id, updated_at, confidence, source_detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [applicationId, ownerId, field, sourceMethod, eventId, nowIso(), sourceMethod === 'manual' ? 'high' : payload.field_confidence?.[field] || 'medium', payload.field_sources?.[field] || null]);
  }
}

export function createApplication({ ownerId, fields, eventId = null, sourceMethod, status = 'pending', at }) {
  const id = newId('app');
  const now = at || nowIso();
  const company = normalizeWhitespace(fields.company_name, 200);
  const title = normalizeWhitespace(fields.job_title, 200);
  const canonical = canonicalJobUrl(fields.job_url);
  const methods = [sourceMethod];
  const hasApplied = APPLIED_STATUSES.has(status) ? 1 : 0;
  const sourceEvent = eventId ? one('SELECT source_method, occurred_at FROM events WHERE id = ? AND owner_id = ?', [eventId, ownerId]) : null;
  const stageReceived = sourceEvent?.source_method === 'mail' ? sourceEvent.occurred_at : nowIso();
  const appFields = {
    id, owner_id: ownerId,
    company_name: company,
    company_key: normalizeCompanyKey(company),
    job_title: title,
    site_key: fields.site_key || null,
    site_job_id: fields.site_job_id || null,
    site_application_id: fields.site_application_id || null,
    recruitment_batch: fields.recruitment_batch ? clipText(fields.recruitment_batch, 100) : null,
    location: fields.location ? clipText(fields.location, 100) : null,
    jd_summary: fields.jd_summary ? clipText(fields.jd_summary, 80) : null,
    channel: fields.channel ? clipText(fields.channel, 40) : '未知',
    job_url: sanitizeUrl(fields.job_url),
    canonical_job_url: canonical,
    status_url: sanitizeUrl(fields.status_url),
    status_url_scope: fields.status_url ? (fields.status_url_scope || 'application') : null,
    status,
    has_applied: hasApplied,
    applied_at: hasApplied ? (fields.applied_at || null) : null,
    applied_at_precision: hasApplied ? (fields.applied_at_precision || 'exact') : 'unknown',
    first_viewed_at: fields.first_viewed_at || null,
    last_viewed_at: fields.last_viewed_at || null,
    form_started_at: fields.form_started_at || null,
    last_status_changed_at: now,
    last_progress_at: now,
    stage_received_at: ['assessment','interview'].includes(status) ? stageReceived : null,
    stage_anchor_at: ['assessment','interview'].includes(status) ? maxIso(stageReceived, status === 'interview' ? fields.interview_scheduled_at : null) : null,
    last_site_observed_at: fields.last_site_observed_at || null,
    last_reviewed_at: null,
    deadline_at: parseIso(fields.deadline_at),
    deadline_precision: fields.deadline_precision || (fields.deadline_at ? 'exact' : null),
    interview_round: fields.interview_round || null,
    round_label: fields.round_label ? clipText(fields.round_label, 40) : null,
    interview_scheduled_at: parseIso(fields.interview_scheduled_at),
    last_interview_completed_at: parseIso(fields.last_interview_completed_at),
    source_methods_json: JSON.stringify(methods),
    latest_event_id: eventId || null,
    version: 1,
    created_at: now,
    updated_at: now
  };
  const keys = Object.keys(appFields);
  run(`INSERT INTO applications (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    keys.map((k) => appFields[k]));
  addInitialHistory(ownerId, id, eventId, status, sourceMethod, appFields);
  bumpRevision();
  return one('SELECT * FROM applications WHERE id = ? AND owner_id = ?', [id, ownerId]);
}

function fillMissingFields(app, fields, eventId, sourceMethod) {
  const updates = {};
  const fillable = ['company_name', 'job_title', 'jd_summary', 'job_url', 'canonical_job_url', 'status_url', 'location', 'recruitment_batch',
    'site_job_id', 'site_application_id', 'deadline_at', 'interview_scheduled_at', 'round_label', 'interview_round'];
  const ranks={low:0,medium:1,high:2};
  for (const key of fillable) {
    const source=one('SELECT source_method, confidence FROM application_field_sources WHERE application_id = ? AND owner_id = ? AND field = ?', [app.id,app.owner_id,key]);
    const confidence=fields.field_confidence?.[key] || 'medium';
    if(source?.source_method==='manual' || confidence==='low')continue;
    if(app[key]!=null && app[key]!=='' && ranks[confidence]<=(ranks[source?.confidence]??1))continue;
    let value=fields[key];
    if(key==='jd_summary'&&value)value=clipText(value,80);
    if(['job_url','status_url'].includes(key))value=sanitizeUrl(value);
    if(key==='canonical_job_url')value=canonicalJobUrl(fields.job_url);
    if(['deadline_at','interview_scheduled_at'].includes(key))value=parseIso(value);
    if(value!=null&&value!==''&&value!==app[key])updates[key]=value;
  }
  if(updates.company_name)updates.company_key=normalizeCompanyKey(updates.company_name);
  if(updates.status_url)updates.status_url_scope=fields.status_url_scope||'application';
  if(!Object.keys(updates).length)return app;
  return markApplicationChanged(app.owner_id,app.id,eventId,sourceMethod,updates,{reason:'更高把握字段补全 / 纠正',fieldConfidence:fields.field_confidence});
}

function ensureSource(app, method, eventId) {
  const methods = addSourceMethod(app, method);
  if (methods.length !== sourceMethods(app).length) {
    run('UPDATE applications SET source_methods_json = ?, updated_at = ?, version = version + 1 WHERE id = ? AND owner_id = ?',
      [JSON.stringify(methods), nowIso(), app.id, app.owner_id]);
    return getApplication(app.owner_id, app.id);
  }
  return app;
}

function outboxStatusChange(app, event, fromStatus, toStatus) {
  const existing = one(`SELECT id FROM notification_outbox WHERE event_id = ? AND kind = 'status_change'`, [event.id]);
  if (existing) return;
  run(`INSERT INTO notification_outbox
    (id, owner_id, application_id, event_id, kind, summary, occurred_at, source_received_at, created_at)
    VALUES (?, ?, ?, ?, 'status_change', ?, ?, ?, ?)`,
  [newId('out'), app.owner_id, app.id, event.id,
    `${app.company_name} · ${app.job_title}：${STATUS_LABELS[fromStatus] || fromStatus} → ${STATUS_LABELS[toStatus] || toStatus}`,
    event.occurred_at || nowIso(), event.payload?.source_received_at || event.occurred_at || nowIso(), nowIso()]);
}

function maybeSetRound(app, fields, eventId, sourceMethod) {
  const roundLabel = fields.round_label ? clipText(fields.round_label, 40) : null;
  const incomingRound = Number.isInteger(Number(fields.interview_round)) && Number(fields.interview_round) > 0
    ? Number(fields.interview_round) : null;
  const updates = {};
  if (roundLabel && roundLabel !== app.round_label) updates.round_label = roundLabel;
  if (incomingRound && (!app.interview_round || incomingRound > app.interview_round)) updates.interview_round = incomingRound;
  if (fields.interview_scheduled_at) {
    const scheduled = parseIso(fields.interview_scheduled_at);
    if (scheduled && scheduled !== app.interview_scheduled_at) updates.interview_scheduled_at = scheduled;
  }
  if (!Object.keys(updates).length) return app;
  return markApplicationChanged(app.owner_id, app.id, eventId, sourceMethod, updates, { reason: '面试属性更新' });
}

export function applyStatusTransition(app, targetStatus, event, { sourceMethod, reviewTerminal = true } = {}) {
  if (!STATUSES.includes(targetStatus)) {
    return { ok: false, review: { kind: 'status_conflict', reasonCode: 'UNKNOWN_STATUS', summary: '无法识别目标状态' } };
  }
  if (app.status === targetStatus) {
    let updated = maybeSetRound(app, event.payload || {}, event.id, sourceMethod);
    return { ok: true, app: updated, changed: false };
  }
  if (TERMINAL.has(app.status)) {
    return { ok: false, review: { kind: 'terminal_conflict', reasonCode: 'TERMINAL_LOCKED', summary: '记录已处于终态，自动事件不能覆盖' } };
  }
  if (targetStatus === 'pending') {
    return { ok: false, review: { kind: 'status_conflict', reasonCode: 'APPLIED_FACT_REMOVAL', summary: '自动事件不能撤销已投事实' } };
  }
  if (TERMINAL.has(targetStatus) && reviewTerminal) {
    return { ok: false, review: { kind: 'terminal_candidate', reasonCode: 'TERMINAL_REVIEW_REQUIRED', summary: '终态候选需要用户确认' } };
  }
  if (APPLIED_STATUSES.has(targetStatus) && !app.has_applied) {
    return { ok: false, review: { kind: 'application_confirmation', reasonCode: 'HAS_APPLIED_UNCONFIRMED', summary: '状态需要正式申请确证' } };
  }
  const oldRank = { pending: 0, applied: 1, assessment: 2, interview: 3, offer: 4, rejected: 4, closed: 5 }[app.status];
  const newRank = { pending: 0, applied: 1, assessment: 2, interview: 3, offer: 4, rejected: 4, closed: 5 }[targetStatus];
  if (newRank < oldRank && !TERMINAL.has(targetStatus)) {
    return { ok: false, review: { kind: 'status_conflict', reasonCode: 'STATUS_REGRESSION', summary: '后到事件试图回退状态' } };
  }
  const changedAt = event.occurred_at || nowIso();
  const updates = {
    status: targetStatus,
    has_applied: 1,
    last_status_changed_at: changedAt,
    last_progress_at: changedAt
  };
  if (!app.applied_at) {
    const appliedAt = eventAppliedAt(event);
    if (appliedAt) {
      updates.applied_at = appliedAt;
      updates.applied_at_precision = 'exact';
    } else if (!config.d12AllowMissingAppliedAt) {
      return { ok: false, review: { kind: 'application_confirmation', reasonCode: 'D12_MISSING_APPLIED_AT', summary: '缺少可信投递时间，D12 未冻结' } };
    }
  }
  let updated = markApplicationChanged(app.owner_id, app.id, event.id, sourceMethod, updates, { reason: sourceMethod === 'mail' ? `由 ${shanghaiDateKey(event.payload?.source_received_at || event.occurred_at)} 收到的邮件《${clipText(event.payload?.subject_excerpt || '', 80)}》自动更新` : '统一状态处理器' });
  updated = maybeSetRound(updated, event.payload || {}, event.id, sourceMethod);
  updated = ensureSource(updated, sourceMethod, event.id);
  outboxStatusChange(updated, event, app.status, targetStatus);
  return { ok: true, app: updated, changed: true };
}

function reviewForEvent(event, details) {
  return createReviewForEvent(event, {
    kind: details.kind,
    reasonCode: details.reasonCode,
    summary: details.summary,
    suggested: details.suggested || {},
    fields: details.fields || {},
    evidence: {
      evidence_level: event.evidence_level,
      evidence_code: event.evidence_code,
      site_key: event.site_key,
      occurred_at: event.occurred_at,
      adapter_version: event.adapter_version,
      status_text: event.payload?.status_text || null,
      url_origin: (() => {
        try { return event.payload?.job_url ? new URL(event.payload.job_url).origin : null; } catch { return null; }
      })()
    }
  });
}

function processView(event) {
  const p = event.payload;
  const existing = one('SELECT * FROM applications WHERE owner_id = ? AND latest_event_id = ?', [event.owner_id, event.id]);
  if (existing) return { state: 'applied', application: existing };
  if (!p.company_name || !p.job_title || (!p.job_url && !p.site_job_id)) {
    const review = reviewForEvent(event, {
      kind: 'field_missing', reasonCode: 'VIEW_FIELDS_INCOMPLETE',
      summary: '浏览线索缺少可用于识别的公司、岗位或稳定标识',
      suggested: { status: 'pending' }, fields: p
    });
    return { state: 'pending', review };
  }
  const dwellMs = Number(p.visible_dwell_ms);
  const dwellBelowThreshold = Number.isFinite(dwellMs) && dwellMs < 3000;
  if (event.evidence_level !== 'strong' || dwellBelowThreshold) {
    const review = reviewForEvent(event, {
      kind: 'suspect_view',
      reasonCode: dwellBelowThreshold ? 'VIEW_DWELL_BELOW_THRESHOLD' : 'WEAK_VIEW_EVIDENCE',
      summary: '浏览证据不足（可见累计未达阈值或证据等级不足），不建立主表记录',
      suggested: { status: 'pending', first_viewed_at: event.occurred_at, last_viewed_at: event.observed_at },
      fields: p
    });
    return { state: 'pending', review };
  }
  const fields = {
    field_confidence: p.field_confidence,
    company_name: p.company_name, job_title: p.job_title, site_key: event.site_key,
    site_job_id: p.site_job_id, site_application_id: p.site_application_id,
    job_url: p.job_url, jd_summary: p.jd_summary, location: p.location,
    recruitment_batch: p.recruitment_batch, channel: p.channel, status_url: p.status_url,
    status_url_scope: p.status_url_scope, first_viewed_at: event.occurred_at,
    last_viewed_at: event.observed_at
  };
  const candidates = findCandidates(event.owner_id, {
    ...fields, canonical_job_url: canonicalJobUrl(p.job_url)
  });
  const strong = candidates.filter((c) => ['site_application_id', 'site_job_id', 'canonical_job_url'].includes(c.reason));
  if (strong.length > 1) {
    const review = reviewForEvent(event, {
      kind: 'ambiguous_match', reasonCode: 'MULTIPLE_APPLICATION_CANDIDATES',
      summary: '同一岗位标识命中多条申请，需确认归属', suggested: { status: 'pending' }, fields
    });
    return { state: 'pending', review };
  }
  if (strong.length === 1) {
    const found = strong[0];
    const titleSource = one('SELECT source_method, confidence FROM application_field_sources WHERE application_id = ? AND field = ?', [found.application.id, 'job_title']);
    const ranks = { low: 0, medium: 1, high: 2 };
    if ((found.reason === 'canonical_job_url' || p.field_sources?.site_job_id === 'url_identifier') && found.application.job_title !== p.job_title
      && titleSource?.source_method !== 'manual' && (ranks[p.field_confidence?.job_title || 'medium'] <= ranks[titleSource?.confidence || 'medium'])) {
      return { state: 'pending', review: reviewForEvent(event, { kind: 'ambiguous_match', reasonCode: 'PAGE_CONTENT_IDENTITY_UNCERTAIN',
        summary: '同一链接出现不同岗位，请明确选择关联原记录，或按新岗位新建', fields,
        suggested: { ...p, status: 'pending' } }) };
    }
    let app = fillMissingFields(strong[0].application, fields, event.id, 'plugin');
    const updates = {};
    if (!app.first_viewed_at || Date.parse(event.occurred_at) < Date.parse(app.first_viewed_at)) updates.first_viewed_at = event.occurred_at;
    if (!app.last_viewed_at || Date.parse(event.observed_at) >= Date.parse(app.last_viewed_at)) updates.last_viewed_at = event.observed_at;
    if (Object.keys(updates).length) app = markApplicationChanged(app.owner_id, app.id, event.id, 'plugin', updates, { reason: '重复浏览' });
    app = ensureSource(app, 'plugin', event.id);
    return { state: 'applied', application: app };
  }
  if (candidates.length > 0) {
    const review = reviewForEvent(event, {
      kind: 'ambiguous_match', reasonCode: 'COMPANY_TITLE_ONLY',
      summary: '只有公司+岗位候选，不能自动合并', suggested: { status: 'pending' }, fields
    });
    return { state: 'pending', review };
  }
  const app = createApplication({
    ownerId: event.owner_id, fields, eventId: event.id, sourceMethod: 'plugin', status: 'pending',
    at: event.occurred_at
  });
  run('UPDATE applications SET first_viewed_at = ?, last_viewed_at = ? WHERE id = ? AND owner_id = ?',
    [event.occurred_at, event.observed_at, app.id, event.owner_id]);
  return { state: 'applied', application: getApplication(event.owner_id, app.id) };
}

function processFormStarted(event) {
  const p = event.payload;
  const candidates = findCandidates(event.owner_id, {
    ...p, canonical_job_url: canonicalJobUrl(p.job_url)
  }).filter((c) => ['site_application_id', 'site_job_id', 'canonical_job_url'].includes(c.reason));
  if (candidates.length !== 1) {
    const review = reviewForEvent(event, {
      kind: 'field_missing', reasonCode: 'FORM_START_UNMATCHED',
      summary: '检测到填写动作，但无法唯一归属到已有浏览线索',
      suggested: { form_started_at: event.occurred_at, status: 'pending' }, fields: p
    });
    return { state: 'pending', review };
  }
  let app = candidates[0].application;
  if (!app.form_started_at) {
    app = markApplicationChanged(app.owner_id, app.id, event.id, 'plugin',
      { form_started_at: event.occurred_at, last_viewed_at: event.observed_at }, { reason: '表单填写' });
  }
  app = ensureSource(app, 'plugin', event.id);
  return { state: 'applied', application: app };
}

function processSubmitted(event) {
  const p = event.payload;
  if (event.evidence_level !== 'strong') {
    const review = reviewForEvent(event, {
      kind: 'suspect_submission', reasonCode: 'WEAK_SUBMISSION_EVIDENCE',
      summary: '疑似投递，但成功证据不足，未计入累计投递',
      suggested: { has_applied: true, status: 'applied', applied_at: event.occurred_at }, fields: p
    });
    return { state: 'pending', review };
  }
  const fields = {
    field_confidence: p.field_confidence,
    company_name: p.company_name, job_title: p.job_title, site_key: event.site_key,
    site_job_id: p.site_job_id, site_application_id: p.site_application_id,
    job_url: p.job_url, jd_summary: p.jd_summary, location: p.location,
    recruitment_batch: p.recruitment_batch, channel: p.channel || '企业官网',
    applied_at: eventAppliedAt(event), applied_at_precision: 'exact'
  };
  const check = isFormalComplete(fields);
  const candidates = findCandidates(event.owner_id, { ...fields, canonical_job_url: canonicalJobUrl(p.job_url) });
  const strong = candidates.filter((c) => ['site_application_id', 'site_job_id', 'canonical_job_url'].includes(c.reason));
  if (!check.complete) {
    const review = reviewForEvent(event, {
      kind: 'application_confirmation', reasonCode: 'D12_MISSING_FIELDS',
      summary: `正式入账缺少字段：${check.missing.join(', ')}；D12 未冻结，不静默放行`,
      suggested: { has_applied: true, status: 'applied', applied_at: event.occurred_at }, fields
    });
    return { state: 'pending', review };
  }
  if (strong.length > 1) {
    const review = reviewForEvent(event, {
      kind: 'ambiguous_match', reasonCode: 'MULTIPLE_APPLICATION_CANDIDATES',
      summary: '提交成功命中多条申请，需确认归属',
      suggested: { has_applied: true, status: 'applied', applied_at: event.occurred_at }, fields
    });
    return { state: 'pending', review };
  }
  if (strong.length === 1) {
    let app = strong[0].application;
    // D04 已冻结（2026-10-22）：同公司同岗位在不同日期再次投递 = 独立的新记录；
    // 同一天的重复提交事件仍合并到原记录（避免同一动作被重复计数）。
    const sameShanghaiDay = app.has_applied && app.applied_at && fields.applied_at
      && shanghaiDateKey(app.applied_at) === shanghaiDateKey(fields.applied_at);
    if (app.has_applied && !sameShanghaiDay) {
      const app2 = createApplication({
        ownerId: event.owner_id, fields, eventId: event.id, sourceMethod: 'plugin',
        status: 'applied', at: event.occurred_at
      });
      outboxStatusChange(app2, event, 'pending', 'applied');
      return { state: 'applied', application: app2, note: 'D04: 不同日期的重复投递已记为新记录' };
    }
    const updates = { has_applied: 1 };
    if (app.status === 'pending') {
      updates.status = 'applied';
      updates.last_status_changed_at = event.occurred_at;
      updates.last_progress_at = event.occurred_at;
    }
    if (!app.applied_at) {
      updates.applied_at = fields.applied_at;
      updates.applied_at_precision = 'exact';
    }
    app = fillMissingFields(app, fields, event.id, 'plugin');
    if (app.status === 'pending') {
      app = markApplicationChanged(app.owner_id, app.id, event.id, 'plugin', {
        has_applied: 1,
        applied_at: app.applied_at || fields.applied_at,
        applied_at_precision: 'exact'
      }, { reason: '提交成功确证申请' });
      const applied = applyStatusTransition(app, 'applied', event, { sourceMethod: 'plugin', reviewTerminal: true });
      if (!applied.ok) {
        const review = reviewForEvent(event, { ...applied.review, fields, suggested: { has_applied: true, status: 'applied' } });
        return { state: 'pending', review };
      }
      app = applied.app;
    } else {
      app = markApplicationChanged(app.owner_id, app.id, event.id, 'plugin', updates, { reason: '提交成功补确证' });
      app = ensureSource(app, 'plugin', event.id);
    }
    return { state: 'applied', application: app };
  }
  if (candidates.length > 0) {
    const review = reviewForEvent(event, {
      kind: 'ambiguous_match', reasonCode: 'COMPANY_TITLE_ONLY',
      summary: '提交成功只有公司+岗位候选，不能自动合并',
      suggested: { has_applied: true, status: 'applied', applied_at: event.occurred_at }, fields
    });
    return { state: 'pending', review };
  }
  const app = createApplication({
    ownerId: event.owner_id, fields, eventId: event.id, sourceMethod: 'plugin', status: 'applied',
    at: event.occurred_at
  });
  outboxStatusChange(app, event, 'pending', 'applied');
  return { state: 'applied', application: app };
}

function processSiteStatus(event) {
  return processMailEvent(event);
}

export function processPluginEvent(event) {
  let result;
  switch (event.event_type) {
    case 'job_viewed': result = processView(event); break;
    case 'form_started': result = processFormStarted(event); break;
    case 'application_submitted': result = processSubmitted(event); break;
    case 'site_status_observed': result = processSiteStatus(event); break;
    default:
      result = { state: 'ignored', error: 'UNSUPPORTED_EVENT' };
  }
  if (result.review) {
    run('UPDATE events SET review_reason = ?, processed_at = ? WHERE id = ? AND owner_id = ?',
      [result.review.reason_code, nowIso(), event.id, event.owner_id]);
    return result;
  }
  if (result.application) {
    run(`UPDATE events SET application_id = ?, processing_state = 'applied', processed_at = ? WHERE id = ? AND owner_id = ?`,
      [result.application.id, nowIso(), event.id, event.owner_id]);
  } else {
    run(`UPDATE events SET processing_state = ?, processed_at = ? WHERE id = ? AND owner_id = ?`,
      [result.state, nowIso(), event.id, event.owner_id]);
  }
  return result;
}

export function manualCreate({ ownerId, body, idempotencyKey, actor = 'user' }) {
  const company = normalizeWhitespace(body.company_name, 200);
  const title = normalizeWhitespace(body.job_title, 200);
  if (!company || !title) throw new AppError(400, 'VALIDATION_ERROR', '公司和岗位为必填');
  const hasApplied = !!body.has_applied;
  let status = normalizeStatus(body.status) || (hasApplied ? 'applied' : 'pending');
  if (!hasApplied && status !== 'pending' && status !== 'closed') {
    throw new AppError(400, 'VALIDATION_ERROR', '未确认正式申请时，状态只能是待投递或已结束');
  }
  if (hasApplied && status === 'pending') throw new AppError(400, 'VALIDATION_ERROR', '已确认申请不能使用待投递状态');
  const appliedAt = body.applied_at ? parseIso(body.applied_at) : (body.applied_date ? parseIso(body.applied_date + 'T12:00:00+08:00') : null);
  if (hasApplied && !appliedAt && !config.d12AllowMissingAppliedAt) {
    throw new AppError(422, 'D12_NOT_FROZEN', '缺少可信投递时间。D12 未冻结，不会用今天或入库时间替代。', {
      details: { missing: ['applied_at'] }
    });
  }
  if (!body.jd_summary && !config.d12AllowMissingJd) {
    throw new AppError(422, 'D12_NOT_FROZEN', '缺少 JD 摘要。D12 未冻结，不会静默放宽必填要求。', {
      details: { missing: ['jd_summary'] }
    });
  }
  if (!body.job_url && !config.d12AllowMissingLink) {
    throw new AppError(422, 'D12_NOT_FROZEN', '缺少岗位链接。D12 未冻结，不会静默放宽必填要求。', {
      details: { missing: ['job_url'] }
    });
  }
  if (body.job_url && !isSafeHttpUrl(body.job_url)) throw new AppError(400, 'VALIDATION_ERROR', '岗位链接不是安全的 http(s) URL');
  if (body.status_url && !isSafeHttpUrl(body.status_url)) throw new AppError(400, 'VALIDATION_ERROR', '状态链接不是安全的 http(s) URL');
  const fields = {
    company_name: company, job_title: title,
    channel: body.channel || '手动',
    jd_summary: body.jd_summary,
    job_url: body.job_url,
    status_url: body.status_url,
    status_url_scope: body.status_url_scope,
    location: body.location,
    recruitment_batch: body.recruitment_batch,
    applied_at: appliedAt,
    applied_at_precision: body.applied_at_precision || (body.applied_date ? 'date' : (appliedAt ? 'exact' : 'unknown')),
    deadline_at: body.deadline_at,
    interview_round: body.interview_round,
    round_label: body.round_label
  };
  const canonical = canonicalJobUrl(body.job_url);
  const candidates = findCandidates(ownerId, { ...fields, canonical_job_url: canonical });
  const strong = candidates.filter((c) => ['site_application_id', 'site_job_id', 'canonical_job_url'].includes(c.reason));
  if (strong.length) {
    throw new AppError(409, 'VERSION_CONFLICT', '发现可能重复的记录，请先在待确认中处理', {
      details: { candidates: candidates.map((c) => ({ application_id: c.application.id, reason: c.reason })) }
    });
  }
  const result = transaction(() => {
    const eventId = newId('evt');
    const eventPayload = { ...fields, manual: true };
    const payloadJson = JSON.stringify(eventPayload);
    run(`INSERT INTO events
      (id, owner_id, client_event_id, source_method, event_type, occurred_at, observed_at, received_at,
       schema_version, evidence_level, evidence_code, payload_json, payload_hash, processing_state)
      VALUES (?, ?, ?, 'manual', 'manual_correction', ?, ?, ?, 'C1', 'strong', 'user-explicit', ?, ?, 'applied')`,
    [eventId, ownerId, `manual:${idempotencyKey}`, appliedAt || nowIso(), nowIso(), nowIso(),
      payloadJson, newId('ph')]);
    const app = createApplication({
      ownerId, fields, eventId, sourceMethod: 'manual', status,
      at: appliedAt || nowIso()
    });
    run('UPDATE events SET application_id = ?, processed_at = ? WHERE id = ?', [app.id, nowIso(), eventId]);
    run(`INSERT INTO notification_outbox
      (id, owner_id, application_id, event_id, kind, summary, occurred_at, created_at)
      VALUES (?, ?, ?, ?, 'status_change', ?, ?, ?)`,
    [newId('out'), ownerId, app.id, eventId, `${app.company_name} · ${app.job_title}：手动补录`,
      appliedAt || nowIso(), nowIso()]);
    run('UPDATE notification_outbox SET source_received_at = occurred_at WHERE owner_id = ? AND event_id = ?', [ownerId, eventId]);
    run(`INSERT INTO audit_log (id, owner_id, actor, action, target_type, target_id, meta_json, created_at)
         VALUES (?, ?, ?, 'application.manual_create', 'application', ?, '{}', ?)`,
    [newId('aud'), ownerId, actor, app.id, nowIso()]);
    return app;
  });
  return result;
}

/**
 * Mail progress enters the same application/history/notification pipeline as plugin events.
 * Company + title alone stays a review candidate (D04). A unique site_application_id match may apply.
 */
export function processMailEvent(event) {
  return transaction(() => {
    const p = event.payload || {};
    const source = event.source_method === 'plugin' ? 'plugin' : 'mail';
    const fields = { ...p, company_name: p.company_name || companyIdentity(null, p.from_domain), site_key: p.site_key || event.site_key };
    const status = normalizeStatus(p.mapped_status) || mapStatusText(p.status_text);
    const stage = stageOfStatus(status);
    const candidates = findProgressCandidates(event.owner_id, fields, { source, stage });
    const classification = Math.max(0, Math.min(1, Number(p.confidence ?? (source === 'plugin' && event.evidence_level === 'strong' ? 0.88 : 0)) || 0));
    const match = candidates.length === 1 ? candidates[0].confidence : 0.5;
    const total = classification * match;
    if (!status) {
      if (source === 'plugin') return { state: 'pending', review: createReviewForEvent(event, {
        kind: 'status_conflict', reasonCode: 'STATUS_UNMAPPED', summary: '官网状态暂无法识别，请确认', fields,
        evidence: { status_text: p.status_text }, progressCandidates: candidates
      }) };
      run("UPDATE events SET processing_state = 'ignored', processed_at = ? WHERE id = ? AND owner_id = ?", [nowIso(), event.id, event.owner_id]);
      return { state: 'ignored' };
    }
    const suggested = { ...fields, status, has_applied: status !== 'pending' };
    for (const key of ['source_mail_id','source_received_at','confidence','mapped_status','status_text','from_domain','subject_excerpt','body_excerpt','read_mode','category','field_confidence']) delete suggested[key];
    const evidence = { subject_excerpt: p.subject_excerpt, body_excerpt: p.body_excerpt, from_domain: p.from_domain,
      read_mode: p.read_mode, category: p.category, status_text: p.status_text,
      confidence: classification, classification_confidence: classification, matching_confidence: match, total_confidence: total,
      source_received_at: p.source_received_at || event.occurred_at };
    const review = (details) => ({ state: 'pending', review: createReviewForEvent(event, {
      kind: 'mail_progress', reasonCode: 'MAIL_MATCH_UNCONFIRMED', summary: '请确认这条招聘进展属于哪条申请',
      ...details, suggested, fields, evidence, progressCandidates: candidates
    }) });
    if (candidates.length !== 1) {
      if (candidates.length > 1) return review({ kind:'ambiguous_match', reasonCode:'MULTIPLE_APPLICATION_CANDIDATES', summary:'有多条可能的申请，请明确选择' });
      if (stage) return review({ kind:'mail_progress', reasonCode:'STAGE_SPLIT_REQUIRED',
        summary: `这封是${stage === 'interview' ? '面试' : '笔试/测评'}进展；已有记录属于另一个阶段，建议单独建一条，不要合并` });
      return review({});
    }
    const terminal = TERMINAL.has(status);
    if (total < (terminal ? config.autoTerminalConfidence : config.autoProgressConfidence) || (terminal && !config.autoTerminalFromMail)) {
      return review({ kind: terminal ? 'terminal_candidate' : 'mail_progress', reasonCode: terminal ? 'TERMINAL_LOW_CONFIDENCE' : 'MAIL_LOW_CONFIDENCE', summary: '系统把握度不足，等待人工确认' });
    }
    let app = candidates[0].application;
    // Check protections before mutating fields or inferring the applied fact.
    if (TERMINAL.has(app.status) && status !== app.status) return review({kind:'terminal_conflict',reasonCode:'TERMINAL_LOCKED',summary:'记录已处于终态，自动事件不能覆盖'});
    const rank={pending:0,applied:1,assessment:2,interview:3};
    if (status==='pending'||(!terminal&&rank[status]<rank[app.status])) return review({kind:'status_conflict',reasonCode:'STATUS_REGRESSION',summary:'后到证据不能自动回退状态'});
    if (!app.has_applied) {
      const explicit = parseIso(p.applied_at);
      const inferred = source === 'mail' && config.d12AllowMailInferredAppliedAt ? parseIso(p.source_received_at || event.occurred_at) : null;
      if (!explicit && !inferred && !config.d12AllowMissingAppliedAt) return review({kind:'application_confirmation',reasonCode:'D12_MISSING_APPLIED_AT',summary:'请补充投递时间后确认'});
      app = markApplicationChanged(app.owner_id,app.id,event.id,source,{has_applied:1,applied_at:explicit||inferred||null,applied_at_precision:explicit?'exact':inferred?'inferred_before':'unknown'}, {reason:'招聘证据确证申请；收信日期仅作投递时间上界'});
    }
    app = fillMissingFields(app,fields,event.id,source);
    const transition=applyStatusTransition(app,status,event,{sourceMethod:source,reviewTerminal:false});
    if (!transition.ok) return review(transition.review);
    app=transition.app;
    if(source==='plugin')app=markApplicationChanged(app.owner_id,app.id,event.id,source,{last_site_observed_at:event.observed_at||nowIso()},{reason:'官网状态观察'});
    run("UPDATE events SET application_id = ?, processing_state = 'applied', processed_at = ? WHERE id = ? AND owner_id = ?",[app.id,nowIso(),event.id,event.owner_id]);
    return { state:'applied', application:app };
  });
}
