import { config } from '../../config.js';
import { one } from '../../db.js';
import { assignReview, reviewSourceFields } from '../../domain/reviews.js';
import { AppError, normalizeWhitespace, parseIso, safeJsonParse } from '../../util.js';
import { extractRecruitmentSignal } from './llm.js';
import { judgeRecruitment } from './jev.js';
import { verifyViaDify } from './dify.js';
import { findCandidates } from './workflow.js';

const STATUS_SET = new Set(['pending', 'applied', 'assessment', 'interview', 'offer', 'rejected', 'closed']);
const APPLIED_LIKE = new Set(['applied', 'assessment', 'interview', 'offer', 'rejected']);
const INVALID_FIELD = /^(?:待补充|未知|不详|未填写|未识别|系统判断|面试|通知|提醒|加分项或注意事项|批次待补充|城市待补充|还没有投递记录|无|—|-)?$/i;

function validField(value, min = 2) {
  const text = normalizeWhitespace(value, 400);
  return text.length >= min && !INVALID_FIELD.test(text)
    && !/系统判断|批次待补充|城市待补充|还没有投递记录|招聘邮件更新候选|加分项或注意事项|基本信息/i.test(text);
}
function text(value, max = 3000) {
  return normalizeWhitespace(value, max);
}
function sourceContext(review, event) {
  const p = event?.payload || safeJsonParse(event?.payload_json, {}) || {};
  const mail = review.source_mail_id ? one('SELECT * FROM mail_messages WHERE id=? AND owner_id=?', [review.source_mail_id, review.owner_id]) : null;
  const fields = reviewSourceFields(review, event);
  const subject = p.subject_excerpt || mail?.subject_excerpt || '';
  const body = p.ai_body_excerpt || p.body_excerpt || mail?.body_excerpt || '';
  const reviewEvidence = safeJsonParse(review.evidence_json, {}) || {};
  const page = reviewEvidence.page || {};
  const existingCompany = p.company_name || page.company_name || fields.company_name || '';
  const existingTitle = p.job_title || page.job_title || fields.job_title || '';
  return {
    event, p, fields, mail, subject, body,
    jd: p.jd_text || p.jd_summary || page.jd_excerpt || fields.jd_text || '',
    statusText: p.status_text || '',
    link: p.job_url || page.job_url || fields.job_url || null,
    existingCompany, existingTitle,
    receivedAt: p.source_received_at || mail?.received_at || event?.occurred_at || null
  };
}
function publicCandidates(candidates) {
  return candidates.slice(0, 8).map((c) => ({
    application_id: c.id, application_version: c.version,
    company_name: c.company_name, job_title: c.job_title, status: c.status,
    has_applied: !!c.has_applied, job_url: c.job_url || null,
    match_reason: c.reason, matching_confidence: c.confidence
  }));
}
function analysisState(ctx, extracted, judged, candidates) {
  const company = validField(extracted.company_name) ? extracted.company_name
    : (validField(ctx.existingCompany) ? ctx.existingCompany : null);
  const title = validField(extracted.job_title) ? extracted.job_title
    : (validField(ctx.existingTitle) ? ctx.existingTitle : null);
  const companyValid = company && (judged.company_valid == null ? true : judged.company_valid >= 0.6);
  const titleValid = title && (judged.job_title_valid == null ? true : judged.job_title_valid >= 0.6);
  const fieldsConsistent = judged.fields_consistent == null ? true : judged.fields_consistent >= 0.6;
  const status = STATUS_SET.has(judged.status?.value) ? judged.status.value : null;
  const progressReliable = Number(judged.actual_progress) >= 0.45 && Number(judged.evidence_support) >= 0.25;
  const statusConfident = status && Number(judged.status?.confidence) >= config.autoIntakeMinStatus && progressReliable;
  const chosen = judged.candidate?.value;
  let target = null;
  if (chosen && /^c\d+$/.test(chosen)) target = candidates[Number(chosen.slice(1))] || null;
  const candidateConfident = target && Number(judged.candidate?.confidence) >= config.autoIntakeMinCandidate;
  const missing = [];
  if (!companyValid) missing.push('company_name');
  if (!titleValid) missing.push('job_title');
  if (!status || !statusConfident) missing.push('status');
  const ambiguous = (chosen === 'uncertain' || (chosen === 'no_match' && candidates.length > 0)
    || (target && !candidateConfident) || !fieldsConsistent);
  if (ambiguous) missing.push('application_id');
  const finalCompany = companyValid ? company : null;
  const finalTitle = titleValid ? title : null;
  const finalStatus = statusConfident ? status : null;
  return {
    company_name: finalCompany, job_title: finalTitle, status: finalStatus,
    status_suggestion: status, status_confidence: judged.status?.confidence ?? null,
    progress_reliable: progressReliable,
    company_valid: judged.company_valid, job_title_valid: judged.job_title_valid,
    fields_consistent: judged.fields_consistent,
    missing: [...new Set(missing)], target, candidate_confident: !!candidateConfident,
    ambiguous, candidates: publicCandidates(candidates),
    extracted, judged
  };
}

export async function confirmReviewIntake({ ownerId, reviewId, expectedVersion, idempotencyKey = null }) {
  const review = one('SELECT * FROM review_items WHERE id=? AND owner_id=?', [reviewId, ownerId]);
  if (!review) throw new AppError(404, 'NOT_FOUND', '待确认项不存在');
  if (review.status !== 'open') {
    const resolution = safeJsonParse(review.resolution_json, {}) || {};
    return { state: 'applied', already_resolved: true, review: { ...review, resolution }, application: resolution.application_id ? { id: resolution.application_id } : null };
  }
  if (Number(expectedVersion) !== review.version) {
    throw new AppError(409, 'VERSION_CONFLICT', '待确认项已更新，请刷新后重试', { details: { current_version: review.version } });
  }
  const event = review.source_event_id ? one('SELECT * FROM events WHERE id=? AND owner_id=?', [review.source_event_id, ownerId]) : null;
  if (event && !event.payload) event.payload = safeJsonParse(event.payload_json, {}) || {};
  const ctx = sourceContext(review, event);
  const sourceText = [ctx.subject, ctx.statusText, ctx.body, ctx.jd].filter(Boolean).join('\n');
  const source = {
    title: ctx.subject || ctx.existingTitle || ctx.existingCompany || '待确认线索',
    subject: ctx.subject || null, body: ctx.body || null, link: ctx.link || null,
    company_hint: ctx.existingCompany || null, job_title_hint: ctx.existingTitle || null
  };
  const trace = {
    started_at: new Date().toISOString(), duration_ms: null, request_id: null,
    llm: { status: 'not_called', model: null, duration_ms: null, error: null },
    jev: { status: 'not_called', via: null, model: null, duration_ms: null, error: null, request_id: null },
    dify: { status: 'not_called', used: false, run_id: null, duration_ms: null, error: null }
  };
  let extracted, judged;
  let candidates = [];
  let verification = 'direct';
  let directJevError = null;
  try {
    trace.llm.status = 'running';
    const llmStarted = Date.now();
    let llm;
    try {
      llm = await extractRecruitmentSignal({
        source: event?.source_method || (review.source_mail_id ? 'mail' : 'plugin'),
        subject: ctx.subject, bodyText: [ctx.body, ctx.jd].filter(Boolean).join('\n'), statusText: ctx.statusText,
        fromDomain: ctx.p.from_domain || '', receivedAt: ctx.receivedAt,
        ruleFields: { company_name: ctx.existingCompany, job_title: ctx.existingTitle, status_text: ctx.statusText }
      });
      trace.llm.status = 'success';
      trace.llm.model = llm.model || null;
      trace.llm.duration_ms = Date.now() - llmStarted;
    } catch (llmErr) {
      trace.llm.status = 'failed';
      trace.llm.duration_ms = Date.now() - llmStarted;
      trace.llm.error = String(llmErr?.code || llmErr?.message || llmErr).slice(0, 200);
      throw llmErr;
    }
    extracted = llm.extraction;
    candidates = findCandidates(ownerId, {
      company_name: extracted.company_name, job_title: extracted.job_title,
      recruitment_batch: extracted.recruitment_batch, site_application_id: extracted.site_application_id,
      job_url: extracted.job_url || ctx.link
    });
    trace.jev.status = 'running';
    trace.jev.via = 'direct';
    const jevStarted = Date.now();
    try {
      judged = await judgeRecruitment({
        state: {
          source: event?.source_method || (review.source_mail_id ? 'mail' : 'plugin'),
          subject: ctx.subject, body_text: ctx.body, status_text: ctx.statusText,
          received_at: ctx.receivedAt, source_text: sourceText,
          extracted, existing_fields: { company_name: ctx.existingCompany, job_title: ctx.existingTitle },
          candidates: candidates.map((c) => ({
            application_id: c.id, company_name: c.company_name, job_title: c.job_title,
            recruitment_batch: c.recruitment_batch, status: c.status, has_applied: !!c.has_applied,
            job_url: c.job_url, match_reason: c.reason, match_confidence: c.confidence
          }))
        },
        candidates
      });
      trace.jev.status = 'success';
      trace.jev.model = judged.model || null;
      trace.jev.request_id = judged.request_id || null;
      trace.jev.duration_ms = Date.now() - jevStarted;
    } catch (jevErr) {
      trace.jev.status = 'failed';
      trace.jev.duration_ms = Date.now() - jevStarted;
      trace.jev.error = String(jevErr?.code || jevErr?.message || jevErr).slice(0, 200);
      directJevError = trace.jev.error;
      // 本机 IP 对 TypeSafe 地区受限（实测 HTTP 451）时，Dify 云上的同一流程可实际调用 Jev。
      if (!/^JEV_/.test(directJevError)) throw jevErr;
      trace.dify.status = 'running';
      trace.dify.used = true;
      const difyStarted = Date.now();
      let dify;
      try {
        dify = await verifyViaDify({
        subject: ctx.subject,
        body: [ctx.body, ctx.jd].filter(Boolean).join('\n'),
        companyHint: extracted.company_name || ctx.existingCompany,
        jobTitleHint: extracted.job_title || ctx.existingTitle,
          candidates
        });
        trace.dify.status = 'success';
        trace.dify.run_id = dify.workflow_run_id || null;
        trace.dify.duration_ms = Date.now() - difyStarted;
        trace.jev.status = 'success';
        trace.jev.via = 'dify';
        trace.jev.model = dify.model || null;
        trace.jev.request_id = dify.workflow_run_id || null;
        trace.jev.duration_ms = Date.now() - difyStarted;
        trace.jev.error = null;
      } catch (difyErr) {
        trace.dify.status = 'failed';
        trace.dify.duration_ms = Date.now() - difyStarted;
        trace.dify.error = String(difyErr?.code || difyErr?.message || difyErr).slice(0, 200);
        trace.jev.status = 'failed';
        trace.jev.via = 'dify';
        trace.jev.error = trace.dify.error;
        throw difyErr;
      }
      verification = 'dify_fallback';
      extracted = {
        ...extracted,
        company_name: dify.company_name || null,
        job_title: dify.job_title || null,
        status: dify.status || extracted.status,
        evidence: extracted.evidence || []
      };
      judged = {
        actual_progress: dify.actual_progress,
        evidence_support: dify.evidence_support,
        company_valid: dify.missing.includes('company_name') ? 0 : (dify.company_name ? 1 : 0),
        job_title_valid: dify.missing.includes('job_title') ? 0 : (dify.job_title ? 1 : 0),
        fields_consistent: dify.fields_consistent,
        status: { value: dify.status || 'no_status', confidence: dify.status ? 1 : 0, probabilities: null },
        candidate: { value: dify.matched_candidate || (candidates.length ? 'uncertain' : 'no_match'), confidence: dify.candidate_confidence },
        model: dify.model,
        request_id: dify.workflow_run_id,
        usage: { workflow_run_id: dify.workflow_run_id, elapsed_time: dify.elapsed_time }
      };
    }
    const state = analysisState(ctx, extracted, judged, candidates);
    const appliedAtHint = parseIso(ctx.p.applied_at) || parseIso(ctx.p.applied_date)
      || (event?.event_type === 'application_submitted' ? parseIso(event.occurred_at) : null)
      || (ctx.mail ? parseIso(ctx.mail.received_at) : null);
    const appliedPrecisionHint = ctx.p.applied_at_precision
      || (event?.event_type === 'application_submitted' ? 'exact' : (appliedAtHint ? 'inferred_before' : null));
    const needsDate = APPLIED_LIKE.has(state.status) && !state.target?.applied_at && !appliedAtHint;
    const missing = [...state.missing];
    if (needsDate) missing.push('applied_at');
    const analysis = {
      models: { llm: llm.model, jev: judged.model },
      verification, direct_jev_error: directJevError, jev_request_id: judged.request_id || null,
      actual_progress: judged.actual_progress, evidence_support: judged.evidence_support, progress_reliable: state.progress_reliable,
      status_suggestion: state.status_suggestion, status_confidence: state.status_confidence,
      company_valid: judged.company_valid, job_title_valid: judged.job_title_valid,
      fields_consistent: judged.fields_consistent,
      status_probabilities: judged.status?.probabilities || null,
      candidate_confidence: judged.candidate?.confidence ?? null,
      evidence: extracted.evidence || [], uncertainties: extracted.uncertainties || [],
      extracted: { company_name: extracted.company_name || null, job_title: extracted.job_title || null, status: extracted.status || null }
    };
    if (missing.length || state.ambiguous || !state.target && state.candidates.length > 0) {
      trace.duration_ms = Date.now() - Date.parse(trace.started_at);
      return {
        state: 'needs_input',
        review: { id: review.id, version: review.version },
        fields: {
          company_name: state.company_name || '', job_title: state.job_title || '',
          status: state.status || '', applied_at_hint: appliedAtHint, applied_at_precision_hint: appliedPrecisionHint
        },
        missing, candidates: state.candidates, source, analysis, trace,
        message: state.ambiguous ? '发现岗位归属或字段映射不确定，请核对后选择' : '公司或岗位/状态需要补充'
      };
    }
    const target = state.target;
    const changes = {
      company_name: state.company_name,
      job_title: state.job_title,
      ...(validField(ctx.p.recruitment_batch) ? { recruitment_batch: ctx.p.recruitment_batch } : {})
    };
    // 已有可靠字段不因模型结果被覆盖；仅补齐空/占位字段。
    if (target) delete changes.recruitment_batch;
    if (target && validField(target.company_name) && validField(target.job_title)) {
      delete changes.company_name; delete changes.job_title;
    } else if (target) {
      if (validField(target.company_name)) delete changes.company_name;
      if (validField(target.job_title)) delete changes.job_title;
    }
    const result = assignReview({
      ownerId, reviewId, expectedVersion: review.version,
      status: state.status, appliedAt: appliedAtHint, appliedAtPrecision: appliedPrecisionHint,
      applicationId: target?.id || null,
      expectedApplicationVersion: target?.version ?? null,
      changes, reason: '确认入账：LLM 提取 + Jev 字段/归属/状态核验',
      actor: 'user', idempotencyKey
    });
    trace.duration_ms = Date.now() - Date.parse(trace.started_at);
    return {
      state: 'applied', review: { ...result.review, resolution: safeJsonParse(result.review.resolution_json, null) },
      application: result.application, created: !!result.created, already_resolved: !!result.already_resolved,
      source, analysis, trace
    };
  } catch (err) {
    if (err instanceof AppError && !/^(?:AUTO_AI_|AI_|JEV_|DIFY_)/.test(err.code || '')) throw err;
    const cause = String(err?.code || err?.message || err).slice(0, 200);
    trace.duration_ms = Date.now() - Date.parse(trace.started_at);
    trace.error = cause;
    // 识别失败不写库，但以结构化结果返回，前端可以展示到底哪一步失败。
    return {
      state: 'failed', review: { id: review.id, version: review.version },
      retryable: !/UNAUTHORIZED|NOT_CONFIGURED/.test(cause),
      error_code: 'INTAKE_RECOGNITION_FAILED', cause,
      message: '识别或核验失败，未创建台账；可以重试或手动填写',
      source, trace
    };
  }
}
