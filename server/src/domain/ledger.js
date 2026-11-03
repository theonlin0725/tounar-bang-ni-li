import { all, dataRevision, getApplication, one } from '../db.js';
import { config } from '../config.js';
import {
  AppError, STATUSES, STATUS_LABELS, TERMINAL, daysBetweenShanghai, isDueForReview, nowIso, safeJsonParse, stageFollowupState
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
    due_for_review: allApps.filter((a) => isDueForReview(a, preferences.review_threshold_days, asOf) || stageFollowupState(a, preferences.stage_followup_days, asOf).due).length
  };
  let rows = viewRows(ownerId, view)
    .filter((a) => matchesQuery(a, q))
    .filter((a) => !status || a.status === status)
    .filter((a) => !source || safeJsonParse(a.source_methods_json, []).includes(source))
    .filter((a) => !dueFilter || isDueForReview(a, preferences.review_threshold_days, asOf) || stageFollowupState(a, preferences.stage_followup_days, asOf).due);
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
  const sources = all(`SELECT field, source_method, event_id, updated_at, confidence, source_detail FROM application_field_sources
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
      jd_text: app.jd_text || null,
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


const SITE_LABELS = {
  tencent: '腾讯招聘', bytedance: '字节跳动招聘', alibaba: '阿里巴巴招聘', meituan: '美团招聘',
  jd: '京东招聘', xiaomi: '小米招聘', baidu: '百度招聘', netease: '网易招聘', generic: '招聘网站',
  boss: 'BOSS直聘', nowcoder: '牛客', shixiseng: '实习僧', xiaohongshu: '小红书招聘',
  mihoyo: '米哈游招聘', airbnb: 'Airbnb Careers'
};
function siteLabel(siteKey, url, domain) {
  if (siteKey && siteKey !== 'generic' && SITE_LABELS[siteKey]) return SITE_LABELS[siteKey];
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    return host || domain || null;
  } catch { return domain || null; }
}
function clipPlain(value, max = 280) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function reviewPresentation(row, { full = false } = {}) {
  const evidence = safeJsonParse(row.evidence_json, {}) || {};
  const suggested = safeJsonParse(row.suggested_changes_json, {}) || {};
  const payload = safeJsonParse(row.source_payload_json, {}) || {};
  const source = sourceFromRow(row);
  const isMail = source.type === 'mail';
  const page = source.type === 'page' ? source : (evidence.page || {});
  const jobTitle = isMail ? (payload.job_title || page.job_title || '') : (page.job_title || payload.job_title || '');
  const company = isMail ? (payload.company_name || page.company_name || '') : (page.company_name || payload.company_name || '');
  const location = isMail ? (payload.location || page.location || '') : (page.location || payload.location || '');
  const batch = isMail ? (payload.recruitment_batch || page.recruitment_batch || '') : (page.recruitment_batch || payload.recruitment_batch || '');
  const salary = payload.salary || page.salary || null;
  const subject = isMail ? (source.subject_excerpt || payload.subject_excerpt || '') : '';
  const body = isMail
    ? (source.body_excerpt || evidence.body_excerpt || payload.body_excerpt || '')
    : (payload.jd_text || page.jd_excerpt || payload.jd_summary || page.status_text || '');
  const preview = clipPlain(body, 260);
  const link = isMail ? (payload.job_url || null) : (page.job_url || payload.job_url || null);
  const time = isMail
    ? (source.received_at || row.mail_received_at || payload.source_received_at || null)
    : (page.captured_at || row.source_observed_at || row.source_occurred_at || null);
  const suggestedStatus = suggested.status || (isMail ? 'applied' : 'pending');
  let appliedHint = suggested.applied_at || null;
  if (!appliedHint && row.source_event_type === 'application_submitted') appliedHint = row.source_occurred_at || null;
  if (!appliedHint && isMail && config.d12AllowMailInferredAppliedAt) appliedHint = row.mail_received_at || null;
  if (appliedHint && !Number.isFinite(Date.parse(appliedHint))) appliedHint = null;
  const appliedPrecisionHint = appliedHint
    ? (suggested.applied_at_precision || (row.source_event_type === 'application_submitted' ? 'exact' : 'inferred_before'))
    : null;
  let linked = null;
  let matchedApplication = null;
  const candidates = safeJsonParse(row.candidates_json, []);
  if (candidates.length === 1) {
    const c = candidates[0];
    const strong = ['site_application_id', 'site_job_id', 'canonical_job_url'].includes(c.match_reason)
      || Number(c.matching_confidence || 0) >= 0.8;
    if (strong) {
      const app = one('SELECT id, version, company_name, job_title, jd_text, job_url, has_applied, status FROM applications WHERE id = ? AND owner_id = ?', [c.application_id, row.owner_id]);
      if (app) {
        matchedApplication = {
          id: app.id, version: app.version, company_name: app.company_name, job_title: app.job_title,
          has_applied: !!app.has_applied, status: app.status
        };
        if (isMail && app.jd_text) linked = { application_id: app.id, job_title: app.job_title, jd_text: app.jd_text, job_url: app.job_url || null };
      }
    }
  }
  const fullText = linked ? linked.jd_text : body;
  return {
    source: isMail ? 'mail' : 'plugin',
    source_label: isMail ? '邮件' : '插件',
    site_name: isMail ? (source.from_domain || null) : siteLabel(row.source_site_key, link, page.site_key ? null : null),
    title: isMail ? (subject || jobTitle || company || '招聘邮件') : (jobTitle || subject || company || '网页线索'),
    company: company || null,
    job_title: jobTitle || null,
    location: location || null,
    recruitment_batch: batch || null,
    salary: salary || null,
    subject: subject || null,
    preview,
    time,
    time_label: isMail ? '收信时间' : '采集时间',
    link: link && /^https?:\/\//i.test(link) ? link : null,
    has_full_text: Boolean(fullText && fullText.length > preview.length),
    full_text: full ? fullText : null,
    linked_application: linked ? { id: linked.application_id, job_title: linked.job_title, job_url: linked.job_url } : null,
    matched_application: matchedApplication,
    suggested_status: suggestedStatus,
    suggested_status_label: STATUS_LABELS[suggestedStatus] || suggestedStatus,
    applied_at_hint: appliedHint,
    applied_at_precision_hint: appliedPrecisionHint,
    source_event_type: row.source_event_type || null,
    read_mode: isMail ? (source.read_mode || null) : null
  };
}

export function reviewList(ownerId, query = {}) {
  const limit = Math.min(50, Math.max(1, Number.parseInt(query.limit || '20', 10) || 20));
  const status = query.status || 'open';
  const offset = Math.max(0, Number.parseInt(query.cursor || '0', 10) || 0);
  if (!['open', 'resolved', 'dismissed', 'all'].includes(status)) throw new AppError(400, 'VALIDATION_ERROR', 'status 无效');
  const rows = all(`SELECT r.*, m.received_at AS mail_received_at, e.payload_json AS source_payload_json,
      e.occurred_at AS source_occurred_at, e.observed_at AS source_observed_at, e.site_key AS source_site_key,
      e.event_type AS source_event_type, e.source_method AS source_event_method
    FROM review_items r
    LEFT JOIN mail_messages m ON m.id = r.source_mail_id AND m.owner_id = r.owner_id
    LEFT JOIN events e ON e.id = r.source_event_id
    WHERE r.owner_id = ? ${status === 'all' ? '' : 'AND r.status = ?'}
    ORDER BY COALESCE(m.received_at, r.created_at) DESC, r.id DESC LIMIT ? OFFSET ?`, status === 'all' ? [ownerId, limit + 1, offset] : [ownerId, status, limit + 1, offset]);
  return {
    data: rows.slice(0, limit).map((row) => ({
      id: row.id,
      mail_inferred_applied_at_enabled: config.d12AllowMailInferredAppliedAt,
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
      mail_received_at: row.mail_received_at || null,
      classification_confidence: safeJsonParse(row.evidence_json, {}).classification_confidence ?? safeJsonParse(row.evidence_json, {}).confidence ?? null,
      matching_confidence: safeJsonParse(row.evidence_json, {}).matching_confidence ?? null,
      total_confidence: safeJsonParse(row.evidence_json, {}).total_confidence ?? safeJsonParse(row.evidence_json, {}).confidence ?? null,
      suggested_application_id: safeJsonParse(row.candidates_json, []).length === 1 ? safeJsonParse(row.candidates_json, [])[0].application_id : null,
      resolved_at: row.resolved_at,
      source: sourceFromRow(row),
      display: reviewPresentation(row)
    })),
    page: { next_cursor: rows.length > limit ? String(offset + limit) : null, has_more: rows.length > limit },
    total: one(`SELECT COUNT(*) AS n FROM review_items WHERE owner_id = ? ${status === 'all' ? '' : 'AND status = ?'}`, status === 'all' ? [ownerId] : [ownerId, status]).n
  };
}

export function reviewDetail(ownerId, reviewId) {
  const row = one(`SELECT r.*, m.received_at AS mail_received_at, e.payload_json AS source_payload_json,
      e.occurred_at AS source_occurred_at, e.observed_at AS source_observed_at, e.site_key AS source_site_key,
      e.event_type AS source_event_type, e.source_method AS source_event_method
    FROM review_items r
    LEFT JOIN mail_messages m ON m.id = r.source_mail_id AND m.owner_id = r.owner_id
    LEFT JOIN events e ON e.id = r.source_event_id
    WHERE r.id = ? AND r.owner_id = ?`, [reviewId, ownerId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', '复核项不存在');
  return {
    data: {
      ...row,
      mail_inferred_applied_at_enabled: config.d12AllowMailInferredAppliedAt,
      classification_confidence: safeJsonParse(row.evidence_json, {}).classification_confidence ?? safeJsonParse(row.evidence_json, {}).confidence ?? null,
      matching_confidence: safeJsonParse(row.evidence_json, {}).matching_confidence ?? null,
      total_confidence: safeJsonParse(row.evidence_json, {}).total_confidence ?? safeJsonParse(row.evidence_json, {}).confidence ?? null,
      suggested_application_id: safeJsonParse(row.candidates_json, []).length === 1 ? safeJsonParse(row.candidates_json, [])[0].application_id : null,
      evidence: safeJsonParse(row.evidence_json, {}),
      suggested_changes: safeJsonParse(row.suggested_changes_json, {}),
      candidates: safeJsonParse(row.candidates_json, []),
      resolution: safeJsonParse(row.resolution_json, null),
      source: sourceFromRow(row),
      display: reviewPresentation(row, { full: true })
    }
  };
}

/* 复核项的来源：邮件与页面必须区分开。
 * 判据优先级：review.source_mail_id → 事件 source_method==='mail' → 事件类型以 mail_ 开头。
 * 只看「有没有 payload」会把邮件误判成页面（邮件事件同样带 payload）。 */
function sourceFromRow(row) {
  const evidence = safeJsonParse(row.evidence_json, {}) || {};
  const eventIsMail = row.source_event_method === 'mail' || String(row.source_event_type || '').startsWith('mail_');
  const isMail = Boolean(row.source_mail_id) || eventIsMail;
  if (!isMail && row.source_payload_json) {
    const p = safeJsonParse(row.source_payload_json, {}) || {};
    const page = evidence.page || {
      type: 'page',
      site_key: row.source_site_key || null,
      job_title: p.job_title || null,
      company_name: p.company_name || null,
      job_url: p.job_url || null,
      location: p.location || null,
      recruitment_batch: p.recruitment_batch || null,
      channel: p.channel || null,
      jd_excerpt: (p.jd_text || p.jd_summary || '').slice(0, 400) || null,
      jd_chars: (p.jd_text || '').length || null,
      jd_status: p.jd_status || null,
      status_text: p.status_text || null,
      field_confidence: p.field_confidence || null,
      field_sources: p.field_sources || null,
      missing_fields: ['company_name', 'job_title', 'location', 'recruitment_batch', 'jd_summary'].filter((k) => !p[k]),
      captured_at: row.source_observed_at || row.source_occurred_at || null
    };
    return { ...page, event_type: row.source_event_type || null, occurred_at: row.source_occurred_at || null };
  }
  if (isMail) {
    const payload = safeJsonParse(row.source_payload_json || '{}', {}) || {};
    const readMode = evidence.read_mode || payload.read_mode || null;
    const body = evidence.body_excerpt || payload.body_excerpt || null;
    return {
      type: 'mail',
      subject_excerpt: evidence.subject_excerpt || payload.subject_excerpt || null,
      from_domain: evidence.from_domain || payload.from_domain || null,
      body_excerpt: body,
      read_mode: readMode,
      category: evidence.category || payload.category || null,
      received_at: row.mail_received_at || payload.source_received_at || payload.occurred_at || null,
      status_text: evidence.status_text || null,
      missing_fields: body ? [] : ['body_excerpt'],
      mail_available: Boolean(row.source_mail_id)
    };
  }
  return {
    type: 'unknown',
    missing_fields: ['source'],
    note: '来源记录不可用（原始事件或邮件可能已被删除）'
  };
}
