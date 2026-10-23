import { all, dataRevision, getApplication, one } from '../db.js';
import {
  AppError, STATUSES, STATUS_LABELS, TERMINAL, daysBetweenShanghai, isDueForReview, nowIso, safeJsonParse
} from '../util.js';
import { applicationProjection, getPreferences, reviewAnchor } from './applications.js';

/* P1（2026-10-22）：待确认卡片要能一句话说清「系统猜的是哪条、把握度多少」。
   匹配把握度按候选来源分档；分类置信度沿用邮件解析的 confidence。
   总把握度 = 分类置信度 × 匹配把握度（缺分类置信度时，插件线索直接用匹配把握度）。 */
const MATCH_CONFIDENCE = {
  site_application_id: 1,
  site_job_id: 0.9,
  canonical_job_url: 0.9,
  company_title_similar: 0.9,
  company_single_active: 0.85,
  company_title_only: 0.5,
  company_multi: 0.5
};

function matchConfidenceFor(reason) {
  return Object.hasOwn(MATCH_CONFIDENCE, reason) ? MATCH_CONFIDENCE[reason] : 0.3;
}

function reviewProjection(row) {
  const candidates = safeJsonParse(row.candidates_json, []);
  const evidence = safeJsonParse(row.evidence_json, {});
  const suggested = safeJsonParse(row.suggested_changes_json, {});
  const classification = Number.isFinite(Number(evidence.confidence)) && evidence.confidence !== null
    ? Number(evidence.confidence) : null;
  const ranked = candidates
    .map((c) => ({
      ...c,
      match_confidence: Number.isFinite(Number(c.match_confidence)) && c.match_confidence !== null
        ? Number(c.match_confidence) : matchConfidenceFor(c.match_reason)
    }))
    .sort((a, b) => b.match_confidence - a.match_confidence);
  const top = ranked[0] || null;
  // P2：只有「唯一候选」才预选目标。多个候选（哪怕最高分唯一）也必须让用户明确选一条，
  // 否则一键确认会把邮件套到错误的记录上。
  const suggestedTarget = ranked.length === 1 ? top : null;
  const matchConfidence = top ? top.match_confidence : null;
  const totalConfidence = matchConfidence == null
    ? null
    : Number(((classification == null ? 1 : classification) * matchConfidence).toFixed(3));
  return {
    id: row.id,
    kind: row.kind,
    reason_code: row.reason_code,
    summary: row.summary,
    evidence,
    suggested_changes: suggested,
    candidates: ranked,
    candidate_count: ranked.length,
    source_event_id: row.source_event_id,
    status: row.status,
    resolution: safeJsonParse(row.resolution_json, null),
    version: row.version,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    mail_received_at: row.mail_received_at || null,
    mail_company_name: evidence.company_name || null,
    mail_job_title: evidence.job_title || null,
    classification_confidence: classification,
    match_confidence: matchConfidence,
    total_confidence: totalConfidence,
    suggested_status: suggested.status || null,
    suggested_application_id: suggestedTarget ? suggestedTarget.application_id : null,
    suggested_application: suggestedTarget
      ? {
        id: suggestedTarget.application_id,
        company_name: suggestedTarget.company_name,
        job_title: suggestedTarget.job_title,
        status: suggestedTarget.status,
        status_label: STATUS_LABELS[suggestedTarget.status] || suggestedTarget.status,
        has_applied: suggestedTarget.has_applied,
        version: suggestedTarget.application_version
      }
      : null
  };
}

function encodeCursor(offset, revision) {
  return Buffer.from(JSON.stringify({ v: 1, o: offset, r: revision }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (value.v !== 1 || !Number.isInteger(value.o) || value.o < 0) return 0;
    return value.o;
  } catch {
    return 0;
  }
}

function matchesQuery(app, q) {
  if (!q) return true;
  const term = q.trim().toLowerCase();
  return `${app.company_name} ${app.job_title} ${app.location || ''} ${app.recruitment_batch || ''}`
    .toLowerCase().includes(term);
}

function viewRows(ownerId, view) {
  if (view === 'applied') {
    return all(`SELECT * FROM applications WHERE owner_id = ? AND has_applied = 1 AND archived_at IS NULL
      ORDER BY updated_at DESC, id DESC`, [ownerId]);
  }
  if (view === 'viewed') {
    return all(`SELECT * FROM applications WHERE owner_id = ? AND has_applied = 0 AND archived_at IS NULL
      ORDER BY updated_at DESC, id DESC`, [ownerId]);
  }
  if (view === 'archived') {
    return all(`SELECT * FROM applications WHERE owner_id = ? AND archived_at IS NOT NULL
      ORDER BY archived_at DESC, id DESC`, [ownerId]);
  }
  throw new AppError(400, 'VALIDATION_ERROR', 'view 只能是 applied/viewed/archived');
}

export function ledgerResponse(ownerId, query = {}) {
  const view = query.view || 'applied';
  const status = query.status && query.status !== 'all' ? String(query.status) : null;
  if (status && !STATUSES.includes(status)) throw new AppError(400, 'VALIDATION_ERROR', 'status 无效');
  const source = query.source && query.source !== 'all' ? String(query.source) : null;
  if (source && !['plugin', 'mail', 'manual'].includes(source)) throw new AppError(400, 'VALIDATION_ERROR', 'source 无效');
  const dueFilter = ['1', 'true'].includes(String(query.due_for_review || '').toLowerCase());
  const q = String(query.q || '').trim().slice(0, 100);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit || '20', 10) || 20));
  const cursor = decodeCursor(query.cursor);
  const preferences = getPreferences(ownerId);
  const asOf = new Date();
  const revision = dataRevision();
  const allApps = all('SELECT * FROM applications WHERE owner_id = ? ORDER BY updated_at DESC, id DESC', [ownerId]);
  const appliedAll = allApps.filter((a) => a.has_applied);
  const stats = {
    total_applied: appliedAll.length,
    in_progress: appliedAll.filter((a) => ['applied', 'assessment', 'interview'].includes(a.status)).length,
    in_interview: appliedAll.filter((a) => a.status === 'interview').length
  };
  const counts = {
    viewed: allApps.filter((a) => !a.has_applied && !a.archived_at).length,
    archived: allApps.filter((a) => !!a.archived_at).length,
    pending_review: one("SELECT COUNT(*) AS n FROM review_items WHERE owner_id = ? AND status = 'open'", [ownerId]).n,
    due_for_review: allApps.filter((a) => isDueForReview(a, preferences.review_threshold_days, asOf)).length
  };
  let rows = viewRows(ownerId, view)
    .filter((a) => matchesQuery(a, q))
    .filter((a) => !status || a.status === status)
    .filter((a) => !source || safeJsonParse(a.source_methods_json, []).includes(source))
    .filter((a) => !dueFilter || isDueForReview(a, preferences.review_threshold_days, asOf));
  if (query.sort === 'applied_desc') {
    rows = [...rows].sort((a, b) => String(b.applied_at || '').localeCompare(String(a.applied_at || '')));
  } else if (query.sort === 'company_asc') {
    rows = [...rows].sort((a, b) => a.company_name.localeCompare(b.company_name, 'zh-CN'));
  }
  const filteredTotal = rows.length;
  const pageRows = rows.slice(cursor, cursor + limit);
  const items = pageRows.map((app) => applicationProjection(app, preferences, asOf));
  const mail = one(`SELECT last_sync_success_at, status FROM mail_connections WHERE owner_id = ?
    ORDER BY updated_at DESC LIMIT 1`, [ownerId]);
  const plugin = one(`SELECT MAX(last_event_at) AS last_event_at FROM plugin_devices WHERE owner_id = ?`, [ownerId]);
  return {
    data: {
      items,
      page: {
        next_cursor: cursor + limit < filteredTotal ? encodeCursor(cursor + limit, revision) : null,
        has_more: cursor + limit < filteredTotal
      },
      filtered_total: filteredTotal,
      stats,
      counts,
      as_of: asOf.toISOString(),
      data_revision: revision,
      time_zone: 'Asia/Shanghai',
      review_threshold_days: preferences.review_threshold_days,
      freshness: {
        mail_last_success_at: mail?.last_sync_success_at || null,
        mail_status: mail?.status || null,
        plugin_last_received_at: plugin?.last_event_at || null
      },
      filters: { view, q, status, source, due_for_review: dueFilter }
    }
  };
}

export function applicationDetail(ownerId, applicationId) {
  const app = getApplication(ownerId, applicationId);
  if (!app) throw new AppError(404, 'NOT_FOUND', '记录不存在或无权访问');
  const preferences = getPreferences(ownerId);
  const history = all(`SELECT id, event_id, from_status, to_status, changed_fields_json, changed_at, source_method, reason
    FROM application_history WHERE owner_id = ? AND application_id = ?
    ORDER BY changed_at DESC LIMIT 100`, [ownerId, applicationId]);
  const sources = all(`SELECT field, source_method, confidence, event_id, updated_at FROM application_field_sources
    WHERE owner_id = ? AND application_id = ? ORDER BY field`, [ownerId, applicationId]);
  const reviews = all(`SELECT id, kind, reason_code, summary, status, version, created_at
    FROM review_items WHERE owner_id = ? AND (
      source_event_id IN (SELECT id FROM events WHERE owner_id = ? AND application_id = ?)
      OR candidates_json LIKE ?
    ) ORDER BY created_at DESC LIMIT 20`,
  [ownerId, ownerId, applicationId, `%${applicationId}%`]);
  return {
    data: {
      ...applicationProjection(app, preferences),
      history: history.map((h) => ({
        ...h,
        changed_fields: safeJsonParse(h.changed_fields_json, {})
      })),
      field_sources: sources,
      open_reviews: reviews,
      review_anchor_at: reviewAnchor(app),
      time_zone: 'Asia/Shanghai',
      as_of: nowIso()
    }
  };
}

export function reviewList(ownerId, query = {}) {
  const limit = Math.min(50, Math.max(1, Number.parseInt(query.limit || '20', 10) || 20));
  const status = query.status || 'open';
  if (!['open', 'resolved', 'dismissed', 'all'].includes(status)) throw new AppError(400, 'VALIDATION_ERROR', 'status 无效');
  const rows = all(`SELECT r.*, m.received_at AS mail_received_at
    FROM review_items r LEFT JOIN mail_messages m ON m.id = r.source_mail_id
    WHERE r.owner_id = ? ${status === 'all' ? '' : 'AND r.status = ?'}
    ORDER BY r.created_at DESC LIMIT ?`, status === 'all' ? [ownerId, limit] : [ownerId, status, limit]);
  return {
    data: rows.map(reviewProjection),
    page: { next_cursor: null, has_more: false }
  };
}

export function reviewDetail(ownerId, reviewId) {
  const row = one(`SELECT r.*, m.received_at AS mail_received_at
    FROM review_items r LEFT JOIN mail_messages m ON m.id = r.source_mail_id
    WHERE r.id = ? AND r.owner_id = ?`, [reviewId, ownerId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', '复核项不存在');
  return { data: reviewProjection(row) };
}

/* 待确认里「不对，我来改」的台账搜索：本人全部记录（含看过没投），按公司/岗位/城市模糊匹配。
   只返回下拉框需要的最小字段，不带证据与正文。 */
export function searchApplications(ownerId, query = {}) {
  const q = String(query.q || '').trim().slice(0, 100);
  const limit = Math.min(50, Math.max(1, Number.parseInt(query.limit || '20', 10) || 20));
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const rows = q
    ? all(`SELECT * FROM applications WHERE owner_id = ?
        AND (company_name LIKE ? ESCAPE '\\' OR job_title LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\')
        ORDER BY has_applied DESC, updated_at DESC LIMIT ?`, [ownerId, like, like, like, limit])
    : all(`SELECT * FROM applications WHERE owner_id = ?
        ORDER BY has_applied DESC, updated_at DESC LIMIT ?`, [ownerId, limit]);
  return {
    data: rows.map((a) => ({
      id: a.id,
      company_name: a.company_name,
      job_title: a.job_title,
      location: a.location,
      status: a.status,
      status_label: STATUS_LABELS[a.status] || a.status,
      has_applied: !!a.has_applied,
      applied_at: a.applied_at,
      applied_at_precision: a.applied_at_precision,
      version: a.version
    }))
  };
}
