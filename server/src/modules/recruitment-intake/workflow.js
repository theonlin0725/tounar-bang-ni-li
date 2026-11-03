import { config } from '../../config.js';
import { all, getApplication, markApplicationChanged, one, run, transaction } from '../../db.js';
import {
  applyStatusTransition, createApplication, createReviewForEvent, fillMissingFields
} from '../../domain/applications.js';
import { companyIdentity, similarJob } from '../../domain/mailMatching.js';
import {
  AppError, TERMINAL, canonicalJobUrl, isSafeHttpUrl, newId, normalizeCompanyKey,
  nowIso, parseIso, safeJsonParse
} from '../../util.js';
import { extractRecruitmentSignal } from './llm.js';
import { judgeRecruitment } from './jev.js';

const STATUS_SET = new Set(['applied', 'assessment', 'interview', 'offer', 'rejected', 'closed']);
const APPLIED_SET = new Set(['applied', 'assessment', 'interview', 'offer', 'rejected']);
const TERMINAL_SET = new Set(['offer', 'rejected', 'closed']);

function sourceAt(event) {
  const p = event.payload || {};
  return parseIso(p.source_received_at) || parseIso(event.occurred_at) || nowIso();
}
function evidenceAt(event) {
  const p = event.payload || {};
  return parseIso(p.event_time) || parseIso(p.source_received_at) || parseIso(event.occurred_at) || null;
}
function eventPayload(event) {
  if (event.payload) return event.payload;
  return safeJsonParse(event.payload_json, {}) || {};
}
function reviewCandidates(candidates) {
  // createReviewForEvent 需要 { application, reason, confidence }；展示投影由领域层生成。
  return candidates.map((c) => ({ application: c, reason: c.reason, confidence: c.confidence }));
}

export function findCandidates(ownerId, ex) {
  const rows = all('SELECT * FROM applications WHERE owner_id = ? AND archived_at IS NULL ORDER BY updated_at DESC', [ownerId]);
  const found = new Map();
  const add = (app, reason, confidence) => {
    if (!app || found.has(app.id)) return;
    found.set(app.id, { ...app, reason, confidence });
  };
  if (ex.site_application_id) {
    for (const app of rows.filter((a) => a.site_application_id === ex.site_application_id)) add(app, 'site_application_id', 1);
  }
  const cUrl = canonicalJobUrl(ex.job_url);
  if (cUrl) for (const app of rows.filter((a) => a.canonical_job_url === cUrl)) add(app, 'canonical_job_url', 1);
  const companyKey = normalizeCompanyKey(ex.company_name);
  if (companyKey) {
    const same = rows.filter((a) => a.company_key === companyKey || normalizeCompanyKey(a.company_name) === companyKey);
    if (ex.job_title) {
      for (const app of same.filter((a) => similarJob(a.job_title, ex.job_title))) add(app, 'company_similar_title', 0.9);
    }
    if (ex.recruitment_batch) {
      for (const app of same.filter((a) => a.recruitment_batch && a.recruitment_batch === ex.recruitment_batch)) add(app, 'company_batch', 0.72);
    }
    for (const app of same) add(app, 'company_only', 0.45);
  }
  return [...found.values()].slice(0, 8);
}

function identityReliable(ex) {
  return Boolean(
    ex.site_application_id || ex.job_url ||
    (ex.company_name && ex.job_title) ||
    (ex.company_name && ex.recruitment_batch) ||
    (ex.job_title && ex.recruitment_batch)
  );
}

function startRun(event) {
  const existing = one('SELECT * FROM ai_ingest_runs WHERE event_id = ? AND owner_id = ?', [event.id, event.owner_id]);
  if (existing) {
    run(`UPDATE ai_ingest_runs SET status='running', attempts=attempts+1, error_code=NULL, error_message=NULL, updated_at=? WHERE id=?`,
      [nowIso(), existing.id]);
    return { ...existing, attempts: existing.attempts + 1, status: 'running' };
  }
  const id = newId('airun');
  const at = nowIso();
  run(`INSERT INTO ai_ingest_runs
    (id, owner_id, event_id, source_method, status, attempts, extraction_json, jev_json, rule_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'running', 1, NULL, NULL, 'auto-intake-v1', ?, ?)`,
  [id, event.owner_id, event.id, event.source_method || 'mail', at, at]);
  return one('SELECT * FROM ai_ingest_runs WHERE id = ?', [id]);
}
function finishRun(runRow, patch) {
  const fields = { ...patch, updated_at: nowIso() };
  const keys = Object.keys(fields);
  run(`UPDATE ai_ingest_runs SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`,
    [...keys.map((k) => fields[k]), runRow.id]);
}
function retryRun(runRow, event, err) {
  const retryable = err?.retryable !== false;
  const next = new Date(Date.now() + Math.max(1, config.autoIntakeRetryMinutes) * 60000).toISOString();
  finishRun(runRow, {
    status: retryable ? 'retry' : 'failed',
    error_code: err?.code || 'AUTO_INTAKE_FAILED',
    error_message: String(err?.message || '自动处理失败').slice(0, 500),
    next_retry_at: retryable ? next : null
  });
  run("UPDATE events SET processing_state='pending', review_reason='AI_PIPELINE_RETRY', processed_at=? WHERE id=? AND owner_id=?",
    [nowIso(), event.id, event.owner_id]);
  return { state: 'retry', error_code: err?.code || 'AUTO_INTAKE_FAILED', retryable };
}

function reviewFor({ event, kind, reasonCode, summary, ex, status, candidates, appliedAt, precision, extracted, judged }) {
  const p = eventPayload(event);
  const suggested = {
    ...(ex.company_name ? { company_name: ex.company_name } : {}),
    ...(ex.job_title ? { job_title: ex.job_title } : {}),
    ...(ex.recruitment_batch ? { recruitment_batch: ex.recruitment_batch } : {}),
    ...(ex.site_application_id ? { site_application_id: ex.site_application_id } : {}),
    ...(ex.job_url ? { job_url: ex.job_url } : {}),
    status: status || 'pending',
    ...(appliedAt ? { applied_at: appliedAt, applied_at_precision: precision || 'inferred_before' } : {})
  };
  const review = createReviewForEvent(event, {
    kind, reasonCode, summary,
    suggested,
    fields: {
      ...p,
      company_name: ex.company_name || p.company_name,
      job_title: ex.job_title || p.job_title,
      recruitment_batch: ex.recruitment_batch || p.recruitment_batch,
      site_application_id: ex.site_application_id || p.site_application_id,
      job_url: ex.job_url || p.job_url,
      status_text: p.status_text
    },
    evidence: {
      ai: {
        extraction: extracted,
        judgement: judged,
        models: { llm: runRowModel?.llm_model || null, jev: judged?.model || null }
      },
      subject_excerpt: p.subject_excerpt,
      body_excerpt: p.body_excerpt,
      from_domain: p.from_domain,
      source_received_at: p.source_received_at,
      category: p.category
    },
    progressCandidates: reviewCandidates(candidates)
  });
  return review;
}

// 仅用于 review evidence 中记录本次模型名；调用 reviewFor 前设置。
let runRowModel = null;

function resolveStatus(ex, judged) {
  const s = judged.status?.value;
  if (STATUS_SET.has(s)) return s;
  return null;
}
function statusThreshold(status) {
  return TERMINAL_SET.has(status) ? Math.max(config.autoIntakeMinTerminal, config.autoIntakeMinStatus) : config.autoIntakeMinStatus;
}

export async function processIntakeEvent(event, { bodyText = '', subject = '', fromDomain = '', statusText = '' } = {}) {
  if (!config.autoIntakeEnabled) throw new AppError(409, 'AUTO_INTAKE_DISABLED', '自动入账未启用');
  const runRow = startRun(event);
  const p = eventPayload(event);
  const rules = {
    company_name: p.company_name || null,
    job_title: p.job_title || null,
    site_application_id: p.site_application_id || null,
    job_url: p.job_url || null,
    status: p.mapped_status || null,
    status_text: p.status_text || null
  };
  let extracted, judged;
  try {
    const llm = await extractRecruitmentSignal({
      source: event.source_method || 'mail', subject: subject || p.subject_excerpt || '',
      fromDomain: fromDomain || p.from_domain || '', statusText: statusText || p.status_text || '',
      bodyText: bodyText || p.ai_body_excerpt || p.body_excerpt || '',
      receivedAt: p.source_received_at || event.occurred_at, ruleFields: rules
    });
    extracted = llm.extraction;
    runRowModel = { llm_model: llm.model };
    finishRun(runRow, { llm_model: llm.model, extraction_json: JSON.stringify(extracted) });
    if (!extracted.is_recruitment) {
      finishRun(runRow, { status: 'ignored', decision: 'ignored', reason_code: 'AI_NOT_RECRUITMENT' });
      run("UPDATE events SET processing_state='ignored', review_reason='AI_NOT_RECRUITMENT', processed_at=? WHERE id=? AND owner_id=?", [nowIso(), event.id, event.owner_id]);
      return { state: 'ignored', reason: 'not_recruitment' };
    }
    const candidates = findCandidates(event.owner_id, extracted);
    judged = await judgeRecruitment({
      state: {
        source: event.source_method || 'mail',
        subject: subject || p.subject_excerpt || null,
        from_domain: fromDomain || p.from_domain || null,
        received_at: p.source_received_at || event.occurred_at || null,
        status_text: statusText || p.status_text || null,
        body_text: String(bodyText || p.ai_body_excerpt || p.body_excerpt || '').slice(0, 6000),
        extracted,
        candidates: candidates.map((c) => ({
          application_id: c.id, company_name: c.company_name, job_title: c.job_title,
          recruitment_batch: c.recruitment_batch, status: c.status, has_applied: !!c.has_applied,
          job_url: c.job_url, match_reason: c.reason, match_confidence: c.confidence
        }))
      },
      candidates
    });
    finishRun(runRow, { jev_model: judged.model, jev_json: JSON.stringify(judged) });
    const status = resolveStatus(extracted, judged);
    const rejectedRole = ['advertisement', 'forwarded_or_historical'].includes(extracted.content_role);
    const processDescription = extracted.content_role === 'process_description';
    if (rejectedRole) {
      finishRun(runRow, { status: 'ignored', decision: 'ignored', reason_code: 'AI_CONTENT_NOT_PROGRESS' });
      run("UPDATE events SET processing_state='ignored', review_reason='AI_CONTENT_NOT_PROGRESS', processed_at=? WHERE id=? AND owner_id=?", [nowIso(), event.id, event.owner_id]);
      return { state: 'ignored', reason: 'content_not_progress' };
    }
    if (processDescription && judged.actual_progress < 0.8) {
      finishRun(runRow, { status: 'ignored', decision: 'ignored', reason_code: 'AI_PROCESS_DESCRIPTION' });
      run("UPDATE events SET processing_state='ignored', review_reason='AI_PROCESS_DESCRIPTION', processed_at=? WHERE id=? AND owner_id=?", [nowIso(), event.id, event.owner_id]);
      return { state: 'ignored', reason: 'process_description' };
    }
    if (judged.actual_progress < 0.4) {
      const subjectText = `${subject || p.subject_excerpt || ''}`;
      // 只有邮件头的明确面试/笔试/测评邀请仍是有效线索；没有正文时 Jev 可能保守。
      // 但用户自己的 Re:/转发线程不算新的用户进展。
      const headerProgress = event.source_method === 'mail'
        && !/^(?:re|fw|fwd|回复|转发)\s*[:：]/i.test(subjectText)
        && /(面试|笔试|测评|录用|offer|拒绝|未通过).{0,18}(通知|邀请|安排|提醒|时间|收集|确认)|(通知|邀请|提醒).{0,18}(面试|笔试|测评)/i.test(subjectText)
        && Boolean(extracted.company_name);
      if (headerProgress) {
        const review = reviewFor({ event, kind: 'mail_progress', reasonCode: 'AI_HEADER_PROGRESS_UNCERTAIN', summary: '邮件头显示明确招聘进展，但缺少正文/岗位归属，请确认', ex: extracted, status: status || 'pending', candidates, extracted, judged });
        finishRun(runRow, { status: 'review', decision: 'review', reason_code: 'AI_HEADER_PROGRESS_UNCERTAIN' });
        return { state: 'pending', review };
      }
      finishRun(runRow, { status: 'ignored', decision: 'ignored', reason_code: 'AI_NOT_ACTUAL_PROGRESS' });
      run("UPDATE events SET processing_state='ignored', review_reason='AI_NOT_ACTUAL_PROGRESS', processed_at=? WHERE id=? AND owner_id=?", [nowIso(), event.id, event.owner_id]);
      return { state: 'ignored', reason: 'not_progress' };
    }
    // 先做“旧证据/重复/同状态”的无变更判断，再决定是否需要因把握度低而进待确认。
    // 否则一封旧邮件会因为模型保守而被错误地重新变成用户任务。
    const newness = judged.newness?.value;
    const chosen = judged.candidate?.value;
    let target = null;
    if (chosen && /^c\d+$/.test(chosen)) {
      target = candidates[Number(chosen.slice(1))] || null;
      if (!target) throw new AppError(502, 'AI_CANDIDATE_INVALID', 'Jev 返回了不存在的候选岗位', { retryable: true });
    }
    if (target) {
      const targetAt = parseIso(target.manual_status_at) || parseIso(target.last_status_changed_at) || parseIso(target.stage_received_at);
      const incomingAt = evidenceAt(event);
      if (target.manual_status_at && incomingAt && Date.parse(incomingAt) <= Date.parse(target.manual_status_at)) {
        finishRun(runRow, { status: 'completed', decision: 'no_change', reason_code: 'AI_MANUAL_PROTECTED', application_id: target.id, before_status: target.status, after_status: target.status });
        run("UPDATE events SET application_id=?, processing_state='ignored', review_reason='AI_MANUAL_PROTECTED', processed_at=? WHERE id=? AND owner_id=?", [target.id, nowIso(), event.id, event.owner_id]);
        return { state: 'ignored', reason: 'manual_protected' };
      }
      if (targetAt && incomingAt && Date.parse(incomingAt) < Date.parse(targetAt)) {
        finishRun(runRow, { status: 'completed', decision: 'no_change', reason_code: 'AI_OLDER_THAN_CURRENT', application_id: target.id, before_status: target.status, after_status: target.status });
        run("UPDATE events SET application_id=?, processing_state='ignored', review_reason='AI_OLDER_THAN_CURRENT', processed_at=? WHERE id=? AND owner_id=?", [target.id, nowIso(), event.id, event.owner_id]);
        return { state: 'ignored', reason: 'older_than_current' };
      }
      if (status && target.status === status) {
        finishRun(runRow, { status: 'completed', decision: 'no_change', reason_code: 'AI_NO_STATUS_CHANGE', application_id: target.id, before_status: target.status, after_status: target.status });
        run("UPDATE events SET application_id=?, processing_state='applied', review_reason=NULL, processed_at=? WHERE id=? AND owner_id=?", [target.id, nowIso(), event.id, event.owner_id]);
        return { state: 'applied', application: target, change: 'unchanged' };
      }
    }
    if (newness === 'duplicate_or_old') {
      finishRun(runRow, { status: 'completed', decision: 'no_change', reason_code: 'AI_DUPLICATE_OR_OLD' });
      run("UPDATE events SET processing_state='ignored', review_reason='AI_DUPLICATE_OR_OLD', processed_at=? WHERE id=? AND owner_id=?", [nowIso(), event.id, event.owner_id]);
      return { state: 'ignored', reason: 'duplicate_or_old' };
    }
    const lowConfidence = processDescription || judged.actual_progress < config.autoIntakeMinProgress
      || judged.evidence_support < config.autoIntakeMinEvidence;
    if (lowConfidence) {
      const review = reviewFor({ event, kind: 'mail_progress', reasonCode: 'AI_PROGRESS_UNCERTAIN', summary: '这条招聘线索的进展或证据不够确定，请确认', ex: extracted, status: status || 'pending', candidates, extracted, judged });
      finishRun(runRow, { status: 'review', decision: 'review', reason_code: 'AI_PROGRESS_UNCERTAIN' });
      return { state: 'pending', review };
    }
    if (!status) {
      const review = reviewFor({ event, kind: 'mail_progress', reasonCode: 'AI_STATUS_UNCERTAIN', summary: '系统识别到招聘进展，但无法确定具体阶段', ex: extracted, status: 'pending', candidates, extracted, judged });
      finishRun(runRow, { status: 'review', decision: 'review', reason_code: 'AI_STATUS_UNCERTAIN' });
      return { state: 'pending', review };
    }
    if (judged.status.confidence < statusThreshold(status)) {
      const review = reviewFor({ event, kind: 'mail_progress', reasonCode: 'AI_STATUS_LOW_CONFIDENCE', summary: '阶段判断把握度不足，请确认', ex: extracted, status, candidates, extracted, judged });
      finishRun(runRow, { status: 'review', decision: 'review', reason_code: 'AI_STATUS_LOW_CONFIDENCE' });
      return { state: 'pending', review };
    }
    if (target && judged.candidate.confidence < config.autoIntakeMinCandidate) {
      const review = reviewFor({ event, kind: 'ambiguous_match', reasonCode: 'AI_CANDIDATE_UNCERTAIN', summary: '岗位归属把握度不足，请确认', ex: extracted, status, candidates, extracted, judged });
      finishRun(runRow, { status: 'review', decision: 'review', reason_code: 'AI_CANDIDATE_UNCERTAIN' });
      return { state: 'pending', review };
    }
    if (!target && chosen === 'uncertain' && candidates.length > 0) {
      const review = reviewFor({ event, kind: 'ambiguous_match', reasonCode: 'AI_MATCH_UNCERTAIN', summary: '这条进展可能属于多个岗位，请确认归属', ex: extracted, status, candidates, extracted, judged });
      finishRun(runRow, { status: 'review', decision: 'review', reason_code: 'AI_MATCH_UNCERTAIN' });
      return { state: 'pending', review };
    }
    if (newness === 'uncertain' && target) {
      const review = reviewFor({ event, kind: 'mail_progress', reasonCode: 'AI_NEWNESS_UNCERTAIN', summary: '无法确认这条进展和现有记录的新旧关系，请确认', ex: extracted, status, candidates, extracted, judged });
      finishRun(runRow, { status: 'review', decision: 'review', reason_code: 'AI_NEWNESS_UNCERTAIN' });
      return { state: 'pending', review };
    }
    if (!target && chosen === 'no_match' && candidates.length > 0) {
      const review = reviewFor({ event, kind: 'ambiguous_match', reasonCode: 'AI_NO_MATCH_WITH_CANDIDATES', summary: '系统找到相似岗位，但判断不属于其中任何一条，请确认是否新增', ex: extracted, status, candidates, extracted, judged });
      finishRun(runRow, { status: 'review', decision: 'review', reason_code: 'AI_NO_MATCH_WITH_CANDIDATES' });
      return { state: 'pending', review };
    }
    if (!target && !identityReliable(extracted)) {
      const review = reviewFor({ event, kind: 'mail_progress', reasonCode: 'AI_IDENTITY_INSUFFICIENT', summary: '识别到招聘进展，但岗位身份不足，请确认', ex: extracted, status, candidates, extracted, judged });
      finishRun(runRow, { status: 'review', decision: 'review', reason_code: 'AI_IDENTITY_INSUFFICIENT' });
      return { state: 'pending', review };
    }
    const at = sourceAt(event);
    let appliedAt = null;
    let precision = 'inferred_before';
    if (APPLIED_SET.has(status) && !target?.applied_at) {
      if (status === 'applied' && parseIso(extracted.event_time)) { appliedAt = parseIso(extracted.event_time); precision = 'exact'; }
      else appliedAt = at;
    }
    if (target) {
      if (TERMINAL_SET.has(target.status) && target.status !== status) {
        const review = reviewFor({ event, kind: 'terminal_conflict', reasonCode: 'AI_TERMINAL_CONFLICT', summary: '记录已处于终态，这条更新的证据与终态冲突，请确认', ex: extracted, status, candidates, appliedAt, precision, extracted, judged });
        finishRun(runRow, { status: 'review', decision: 'review', reason_code: 'AI_TERMINAL_CONFLICT', application_id: target.id, before_status: target.status });
        return { state: 'pending', review };
      }
      let app = target;
      // 用领域函数补字段；fillMissingFields 会跳过人工字段。
      app = fillMissingFields(app, {
        ...eventPayload(event), company_name: extracted.company_name, job_title: extracted.job_title,
        recruitment_batch: extracted.recruitment_batch, job_url: extracted.job_url,
        site_application_id: extracted.site_application_id
      }, event.id, event.source_method === 'plugin' ? 'plugin' : 'mail');
      if (!app.has_applied && APPLIED_SET.has(status)) {
        // applyStatusTransition 要求已有“已投”事实；先由领域函数标记，再走统一状态机。
        app = markApplicationChanged(app.owner_id, app.id, event.id, event.source_method === 'plugin' ? 'plugin' : 'mail', {
          has_applied: 1, ...(appliedAt ? { applied_at: appliedAt, applied_at_precision: precision } : {})
        }, { reason: '招聘进展确证申请' });
      }
      const evt = { ...event, payload: { ...eventPayload(event), ...(appliedAt ? { applied_at: appliedAt, applied_at_precision: precision } : {}) } };
      const transition = applyStatusTransition(app, status, evt, { sourceMethod: event.source_method === 'plugin' ? 'plugin' : 'mail', reviewTerminal: false });
      if (!transition.ok) {
        const review = reviewFor({ event, kind: 'status_conflict', reasonCode: transition.review?.reasonCode || 'AI_STATUS_CONFLICT', summary: transition.review?.summary || '状态冲突，请确认', ex: extracted, status, candidates, appliedAt, precision, extracted, judged });
        finishRun(runRow, { status: 'review', decision: 'review', reason_code: transition.review?.reasonCode || 'AI_STATUS_CONFLICT', application_id: target.id, before_status: target.status });
        return { state: 'pending', review };
      }
      const after = transition.app;
      finishRun(runRow, { status: 'completed', decision: 'updated', reason_code: 'AI_AUTO_UPDATE', application_id: after.id, before_status: target.status, after_status: after.status });
      run("UPDATE events SET application_id=?, processing_state='applied', review_reason=NULL, processed_at=? WHERE id=? AND owner_id=?", [after.id, nowIso(), event.id, event.owner_id]);
      return { state: 'applied', application: after, change: transition.changed ? 'updated' : 'unchanged' };
    }
    // 新建：必须有可追溯身份；空白公司/岗位本身不阻止创建。
    const fields = {
      ...eventPayload(event),
      company_name: extracted.company_name,
      job_title: extracted.job_title,
      recruitment_batch: extracted.recruitment_batch,
      site_application_id: extracted.site_application_id,
      job_url: extracted.job_url,
      channel: event.source_method === 'plugin' ? '插件' : '邮件',
      applied_at: appliedAt || undefined,
      applied_at_precision: appliedAt ? precision : undefined
    };
    delete fields.source_mail_id; delete fields.confidence; delete fields.mapped_status;
    const app = transaction(() => createApplication({
      ownerId: event.owner_id, fields, eventId: event.id,
      sourceMethod: event.source_method === 'plugin' ? 'plugin' : 'mail',
      status, at
    }));
    run("UPDATE events SET application_id=?, processing_state='applied', review_reason=NULL, processed_at=? WHERE id=? AND owner_id=?", [app.id, nowIso(), event.id, event.owner_id]);
    finishRun(runRow, { status: 'completed', decision: 'created', reason_code: 'AI_AUTO_CREATE', application_id: app.id, before_status: null, after_status: app.status });
    return { state: 'applied', application: app, change: 'created' };
  } catch (err) {
    return retryRun(runRow, event, err);
  } finally {
    runRowModel = null;
  }
}

export async function retryPendingIntakes(limit = 10) {
  const rows = all(`SELECT r.*, e.payload_json, e.occurred_at, e.observed_at, e.site_key, e.event_type, e.source_method
    FROM ai_ingest_runs r JOIN events e ON e.id = r.event_id AND e.owner_id = r.owner_id
    WHERE r.status='retry' AND (r.next_retry_at IS NULL OR r.next_retry_at <= ?)
    ORDER BY r.updated_at ASC LIMIT ?`, [nowIso(), limit]);
  const results = [];
  for (const row of rows) {
    const event = {
      ...row, id: row.event_id, owner_id: row.owner_id,
      payload: safeJsonParse(row.payload_json, {}) || {},
      payload_json: row.payload_json
    };
    try {
      results.push(await processIntakeEvent(event, {
        subject: event.payload.subject_excerpt || '', statusText: event.payload.status_text || '',
        fromDomain: event.payload.from_domain || '', bodyText: event.payload.ai_body_excerpt || event.payload.body_excerpt || ''
      }));
    } catch (err) {
      results.push({ state: 'retry', error: err?.code || err?.message });
    }
  }
  return results;
}
