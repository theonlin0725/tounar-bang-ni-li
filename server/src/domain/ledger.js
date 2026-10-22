import { all, dataRevision, getApplication, one } from '../db.js';
import {
  AppError, STATUSES, TERMINAL, daysBetweenShanghai, isDueForReview, nowIso, safeJsonParse
} from '../util.js';
import { applicationProjection, getPreferences, reviewAnchor } from './applications.js';

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
  const sources = all(`SELECT field, source_method, event_id, updated_at FROM application_field_sources
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
  const rows = all(`SELECT * FROM review_items WHERE owner_id = ? ${status === 'all' ? '' : 'AND status = ?'}
    ORDER BY created_at DESC LIMIT ?`, status === 'all' ? [ownerId, limit] : [ownerId, status, limit]);
  return {
    data: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      reason_code: row.reason_code,
      summary: row.summary,
      evidence: safeJsonParse(row.evidence_json, {}),
      suggested_changes: safeJsonParse(row.suggested_changes_json, {}),
      candidates: safeJsonParse(row.candidates_json, []),
      source_event_id: row.source_event_id,
      status: row.status,
      resolution: safeJsonParse(row.resolution_json, null),
      version: row.version,
      created_at: row.created_at,
      resolved_at: row.resolved_at
    })),
    page: { next_cursor: null, has_more: false }
  };
}

export function reviewDetail(ownerId, reviewId) {
  const row = one('SELECT * FROM review_items WHERE id = ? AND owner_id = ?', [reviewId, ownerId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', '复核项不存在');
  return {
    data: {
      ...row,
      evidence: safeJsonParse(row.evidence_json, {}),
      suggested_changes: safeJsonParse(row.suggested_changes_json, {}),
      candidates: safeJsonParse(row.candidates_json, []),
      resolution: safeJsonParse(row.resolution_json, null)
    }
  };
}
