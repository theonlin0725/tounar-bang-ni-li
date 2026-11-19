import { config } from '../../config.js';
import { all, getApplication, one, run, transaction } from '../../db.js';
import {
  AppError, clipText, newId, normalizeWhitespace, nowIso, safeJsonParse
} from '../../util.js';
import { extractResumeText, MAX_RESUME_TEXT } from './resume-parser.js';
import { aiAvailable, analyzeResumeProfile, compareJobs, generateInterviewQuestions, matchJob, recommendJobs } from './llm.js';

const MATCH_DIMENSIONS = ['hard_gate', 'skills', 'experience', 'industry', 'preference', 'achievements'];
const CORRECTION_FIELDS = ['skill', 'experience', 'industry', 'achievement', 'preference', 'other'];
const CORRECTION_SCOPES = ['application', 'all'];

function profileOf(row) {
  return row?.profile_json ? safeJsonParse(row.profile_json, null) : null;
}
function projection(row, { includeText = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    text_chars: row.text_chars,
    status: row.status,
    profile: profileOf(row),
    error_code: row.error_code,
    error_message: row.error_message,
    is_current: !!row.is_current,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(includeText ? { text: row.text } : { text_preview: String(row.text || '').slice(0, 800) })
  };
}

function storeResume({ ownerId, filename, mime, size, text, truncated }) {
  return transaction(() => {
    const id = newId('resume');
    const at = nowIso();
    run('UPDATE resumes SET is_current = 0, updated_at = ? WHERE owner_id = ? AND is_current = 1', [at, ownerId]);
    run(`INSERT INTO resumes
      (id, owner_id, filename, mime, size, text, text_chars, profile_json, status, is_current, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'parsed', 1, ?, ?)`,
    [id, ownerId, normalizeWhitespace(filename || '简历', 200) || '简历', clipText(mime, 120) || null,
      size, text, text.length, at, at]);
    return { ...projection(one('SELECT * FROM resumes WHERE id = ? AND owner_id = ?', [id, ownerId]), { includeText: true }), truncated: !!truncated };
  });
}

export async function createResumeFromBuffer({ ownerId, filename, mime, buffer }) {
  const parsed = await extractResumeText({ filename, mime, buffer });
  return storeResume({ ownerId, filename, mime, size: buffer.length, text: parsed.text, truncated: parsed.truncated });
}

export async function createResumeFromText({ ownerId, text, filename = '粘贴的简历' }) {
  const clean = String(text || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  if (clean.length < 20) throw new AppError(422, 'RESUME_TEXT_TOO_SHORT', '简历文本太短，无法分析');
  const clipped = clean.length > MAX_RESUME_TEXT;
  return storeResume({
    ownerId, filename: filename || '粘贴的简历', mime: 'text/plain',
    size: Buffer.byteLength(clean), text: clean.slice(0, MAX_RESUME_TEXT), truncated: clipped
  });
}

export function listResumes(ownerId) {
  return all('SELECT * FROM resumes WHERE owner_id = ? ORDER BY created_at DESC LIMIT 20', [ownerId]).map((row) => projection(row));
}

export function currentResume(ownerId) {
  return projection(one('SELECT * FROM resumes WHERE owner_id = ? AND is_current = 1', [ownerId]), { includeText: true });
}

export function getResume(ownerId, resumeId, { includeText = false } = {}) {
  const row = one('SELECT * FROM resumes WHERE id = ? AND owner_id = ?', [resumeId, ownerId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', '简历不存在');
  return projection(row, { includeText });
}

export async function analyzeResume(ownerId, resumeId) {
  const row = one('SELECT * FROM resumes WHERE id = ? AND owner_id = ?', [resumeId, ownerId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', '简历不存在');
  if (!aiAvailable()) throw new AppError(503, 'AI_NOT_CONFIGURED', '尚未配置云端模型，暂时无法分析简历', { retryable: false });
  run("UPDATE resumes SET status = 'analyzing', error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  try {
    const profile = await analyzeResumeProfile(row.text);
    run("UPDATE resumes SET status = 'ready', profile_json = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND owner_id = ?",
      [JSON.stringify(profile), nowIso(), row.id, ownerId]);
    return projection(one('SELECT * FROM resumes WHERE id = ? AND owner_id = ?', [row.id, ownerId]));
  } catch (err) {
    run("UPDATE resumes SET status = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
      [err.code || 'AI_FAILED', clipText(err.message || '简历分析失败', 300), nowIso(), row.id, ownerId]);
    throw err;
  }
}

export function correctResumeText(ownerId, resumeId, text) {
  const clean = String(text || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  if (clean.length < 20) throw new AppError(422, 'RESUME_TEXT_TOO_SHORT', '简历文本太短，无法分析');
  return transaction(() => {
    const row = one('SELECT * FROM resumes WHERE id = ? AND owner_id = ?', [resumeId, ownerId]);
    if (!row) throw new AppError(404, 'NOT_FOUND', '简历不存在');
    run(`UPDATE resumes SET text = ?, text_chars = ?, profile_json = NULL, status = 'parsed',
         error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND owner_id = ?`,
    [clean.slice(0, MAX_RESUME_TEXT), Math.min(clean.length, MAX_RESUME_TEXT), nowIso(), resumeId, ownerId]);
    return projection(one('SELECT * FROM resumes WHERE id = ? AND owner_id = ?', [resumeId, ownerId]), { includeText: true });
  });
}

function requireReadyResume(ownerId) {
  const row = one('SELECT * FROM resumes WHERE owner_id = ? AND is_current = 1', [ownerId]);
  if (!row) throw new AppError(409, 'RESUME_REQUIRED', '请先上传并分析一份简历');
  if (row.status !== 'ready' || !profileOf(row)) throw new AppError(409, 'RESUME_NOT_READY', '当前简历尚未完成分析，请先在简历页分析或重试');
  return { row, profile: profileOf(row) };
}

function reportProjection(row, { includeContext = true } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    resume_id: row.resume_id,
    application_ids: safeJsonParse(row.application_ids_json, []),
    parent_report_id: row.parent_report_id || null,
    report_version: row.report_version || null,
    status: row.status,
    result: safeJsonParse(row.result_json, null),
    ...(includeContext ? { context: safeJsonParse(row.context_json, null) } : {}),
    error_code: row.error_code,
    error_message: row.error_message,
    created_at: row.created_at,
    completed_at: row.completed_at
  };
}

function startReport({ ownerId, kind, resumeId, applicationIds, parentReportId = null, reportVersion = null, context = null }) {
  const id = newId('aireport');
  run(`INSERT INTO ai_reports
    (id, owner_id, kind, resume_id, application_ids_json, parent_report_id, report_version, context_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
  [id, ownerId, kind, resumeId || null, JSON.stringify(applicationIds || []), parentReportId || null,
    reportVersion || null, context ? JSON.stringify(context) : null, nowIso()]);
  return id;
}
function finishReport(id, ownerId, result) {
  run("UPDATE ai_reports SET status = 'ready', result_json = ?, error_code = NULL, error_message = NULL, completed_at = ? WHERE id = ? AND owner_id = ?",
    [JSON.stringify(result), nowIso(), id, ownerId]);
  return reportProjection(one('SELECT * FROM ai_reports WHERE id = ? AND owner_id = ?', [id, ownerId]));
}
function failReport(id, ownerId, err) {
  run("UPDATE ai_reports SET status = 'failed', error_code = ?, error_message = ?, completed_at = ? WHERE id = ? AND owner_id = ?",
    [err.code || 'AI_FAILED', clipText(err.message || 'AI 分析失败', 300), nowIso(), id, ownerId]);
}

export async function compareApplications({ ownerId, applicationIds }) {
  const ids = [...new Set((Array.isArray(applicationIds) ? applicationIds : []).map(String))];
  if (ids.length < 2 || ids.length > 6) throw new AppError(400, 'VALIDATION_ERROR', '请选择 2–6 个岗位进行对比');
  const { row: resume, profile } = requireReadyResume(ownerId);
  if (!aiAvailable()) throw new AppError(503, 'AI_NOT_CONFIGURED', '尚未配置 AI 模型，暂时无法进行岗位对比', { retryable: false });
  const jobs = ids.map((id) => {
    const app = getApplication(ownerId, id);
    if (!app) throw new AppError(404, 'NOT_FOUND', '所选岗位不存在或不属于当前账号');
    const jd = String(app.jd_text || app.jd_summary || '');
    return {
      id: app.id, company_name: app.company_name, job_title: app.job_title, status: app.status,
      has_applied: !!app.has_applied, location: app.location, recruitment_batch: app.recruitment_batch,
      job_url: app.job_url || null, jd_text: app.jd_text || '', jd_summary: app.jd_summary || '',
      information_sufficient: jd.length >= 80
    };
  });
  const reportId = startReport({ ownerId, kind: 'compare', resumeId: resume.id, applicationIds: ids });
  try {
    const result = await compareJobs({ profile, jobs });
    result.selected_jobs = jobs.map((j) => ({
      application_id: j.id, company_name: j.company_name, job_title: j.job_title,
      status: j.status, has_applied: j.has_applied, job_url: j.job_url,
      information_sufficient: j.information_sufficient
    }));
    result.resume_id = resume.id;
    return finishReport(reportId, ownerId, result);
  } catch (err) {
    failReport(reportId, ownerId, err);
    throw err;
  }
}

function matchCorrections(ownerId, applicationId) {
  const rows = all(`SELECT * FROM ai_match_corrections
    WHERE owner_id = ? AND (application_id = ? OR scope = 'all')
    ORDER BY created_at ASC`, [ownerId, applicationId]);
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.dimension}\u0000${row.user_text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function correctionProjection(row) {
  return {
    id: row.id,
    report_id: row.report_id,
    application_id: row.application_id,
    dimension: row.dimension,
    original_judgment: row.original_judgment,
    user_text: row.user_text,
    proposed_field: row.proposed_field,
    scope: row.scope,
    created_at: row.created_at
  };
}

export async function matchApplication({ ownerId, applicationId, parentReportId = null }) {
  const id = String(applicationId || '');
  if (!id) throw new AppError(400, 'VALIDATION_ERROR', '请选择一个台账岗位');
  const app = getApplication(ownerId, id);
  if (!app) throw new AppError(404, 'NOT_FOUND', '所选岗位不存在或不属于当前账号');
  const { row: resume, profile } = requireReadyResume(ownerId);
  const jdText = String(app.jd_text || app.jd_summary || '').trim();
  if (!jdText) throw new AppError(409, 'JD_REQUIRED', '这个岗位还没有 JD，无法做单岗位匹配；请先在详情里补充岗位 JD。', { retryable: false });
  if (!aiAvailable()) throw new AppError(503, 'AI_NOT_CONFIGURED', '尚未配置 AI 模型，暂时无法进行岗位匹配', { retryable: false });
  const parent = parentReportId
    ? one("SELECT * FROM ai_reports WHERE id = ? AND owner_id = ? AND kind = 'match'", [String(parentReportId), ownerId])
    : null;
  if (parentReportId && !parent) throw new AppError(404, 'NOT_FOUND', '上次匹配报告不存在或不属于当前账号');
  if (parent && !safeJsonParse(parent.application_ids_json, []).includes(id)) {
    throw new AppError(400, 'VALIDATION_ERROR', '上次匹配报告不是这个岗位的，不能作为重跑依据');
  }
  const corrections = matchCorrections(ownerId, id);
  const job = {
    id: app.id, company_name: app.company_name, job_title: app.job_title, status: app.status,
    has_applied: !!app.has_applied, location: app.location, recruitment_batch: app.recruitment_batch,
    job_url: app.job_url || null, jd_text: app.jd_text || '', jd_summary: app.jd_summary || '',
    information_sufficient: jdText.length >= 80
  };
  const context = {
    schema_version: 'match-context-v1',
    application: job,
    resume: {
      id: resume.id, filename: resume.filename, updated_at: resume.updated_at,
      text_chars: resume.text_chars, profile, text: String(resume.text || '').slice(0, 16000)
    },
    corrections: corrections.map(correctionProjection),
    confirmed_preferences: corrections.filter((c) => c.dimension === 'preference').map(correctionProjection)
  };
  const reportId = startReport({
    ownerId, kind: 'match', resumeId: resume.id, applicationIds: [id],
    parentReportId: parent?.id || null, reportVersion: 'match-v1', context
  });
  try {
    const result = await matchJob({
      profile, resumeText: String(resume.text || ''), job,
      corrections: corrections.map(correctionProjection)
    });
    result.job = {
      application_id: app.id, company_name: app.company_name, job_title: app.job_title,
      status: app.status, has_applied: !!app.has_applied, location: app.location,
      recruitment_batch: app.recruitment_batch, job_url: job.job_url,
      information_sufficient: job.information_sufficient,
      jd_chars: jdText.length
    };
    result.resume = {
      id: resume.id, filename: resume.filename, updated_at: resume.updated_at,
      text_chars: resume.text_chars, profile_version: resume.updated_at
    };
    result.corrections_used = corrections.map(correctionProjection);
    result.parent_report_id = parent?.id || null;
    const finished = finishReport(reportId, ownerId, result);
    finished.corrections = matchCorrections(ownerId, id).map(correctionProjection);
    return finished;
  } catch (err) {
    failReport(reportId, ownerId, err);
    throw err;
  }
}

export function listMatchReports(ownerId, applicationId) {
  const rows = all("SELECT * FROM ai_reports WHERE owner_id = ? AND kind = 'match' ORDER BY created_at DESC LIMIT 20", [ownerId]);
  return rows.filter((row) => {
    const ids = safeJsonParse(row.application_ids_json, []);
    return !applicationId || ids.includes(applicationId);
  }).slice(0, 10).map((row) => {
    const report = reportProjection(row, { includeContext: false });
    return {
      id: report.id, status: report.status, created_at: report.created_at,
      completed_at: report.completed_at, parent_report_id: report.parent_report_id,
      report_version: report.report_version,
      application_ids: report.application_ids,
      ability: report.result?.ability || null,
      priority: report.result?.priority || null,
      job: report.result?.job || null,
      error_code: report.error_code, error_message: report.error_message
    };
  });
}

export function addMatchCorrection({
  ownerId, reportId, dimension, originalJudgment, userText, proposedField = 'other', scope = 'application'
}) {
  const report = one("SELECT * FROM ai_reports WHERE id = ? AND owner_id = ? AND kind = 'match'", [String(reportId), ownerId]);
  if (!report) throw new AppError(404, 'NOT_FOUND', '匹配报告不存在或不属于当前账号');
  if (report.status !== 'ready') throw new AppError(409, 'REPORT_NOT_READY', '报告尚未完成，暂时不能补充或纠错');
  const dim = String(dimension || '');
  if (!MATCH_DIMENSIONS.includes(dim)) throw new AppError(400, 'VALIDATION_ERROR', '请选择要纠正的匹配维度');
  const field = String(proposedField || 'other');
  if (!CORRECTION_FIELDS.includes(field)) throw new AppError(400, 'VALIDATION_ERROR', '补充字段类型无效');
  const useScope = String(scope || 'application');
  if (!CORRECTION_SCOPES.includes(useScope)) throw new AppError(400, 'VALIDATION_ERROR', '补充证据的适用范围无效');
  const clean = String(userText || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  if (clean.length < 5) throw new AppError(422, 'VALIDATION_ERROR', '请至少写 5 个字，说明你实际做过什么');
  if (clean.length > 1200) throw new AppError(422, 'VALIDATION_ERROR', '补充内容不能超过 1200 字');
  const applicationId = safeJsonParse(report.application_ids_json, [])[0];
  if (!applicationId || !getApplication(ownerId, applicationId)) {
    throw new AppError(404, 'NOT_FOUND', '报告关联的岗位不存在或不属于当前账号');
  }
  const original = String(originalJudgment || '').trim().slice(0, 1200);
  const existing = one(`SELECT * FROM ai_match_corrections
    WHERE owner_id = ? AND report_id = ? AND dimension = ? AND user_text = ?`,
  [ownerId, report.id, dim, clean]);
  if (existing) return { correction: correctionProjection(existing), already_saved: true };
  const correctionId = newId('aimatchfix');
  run(`INSERT INTO ai_match_corrections
    (id, owner_id, report_id, application_id, dimension, original_judgment, user_text, proposed_field, scope, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [correctionId, ownerId, report.id, applicationId, dim, original, clean, field, useScope, nowIso()]);
  return {
    correction: correctionProjection(one('SELECT * FROM ai_match_corrections WHERE id = ? AND owner_id = ?', [correctionId, ownerId])),
    already_saved: false
  };
}

export function listMatchCorrections(ownerId, reportId) {
  const report = one("SELECT * FROM ai_reports WHERE id = ? AND owner_id = ? AND kind = 'match'", [String(reportId), ownerId]);
  if (!report) throw new AppError(404, 'NOT_FOUND', '匹配报告不存在或不属于当前账号');
  return all('SELECT * FROM ai_match_corrections WHERE owner_id = ? AND report_id = ? ORDER BY created_at ASC', [ownerId, report.id])
    .map(correctionProjection);
}

export async function interviewQuestionsForReport(ownerId, reportId) {
  const report = one("SELECT * FROM ai_reports WHERE id = ? AND owner_id = ? AND kind = 'match'", [String(reportId), ownerId]);
  if (!report) throw new AppError(404, 'NOT_FOUND', '匹配报告不存在或不属于当前账号');
  if (report.status !== 'ready') throw new AppError(409, 'REPORT_NOT_READY', '匹配报告尚未完成，暂时不能生成面试问题');
  if (!aiAvailable()) throw new AppError(503, 'AI_NOT_CONFIGURED', '尚未配置 AI 模型，暂时无法生成面试问题', { retryable: false });
  const context = safeJsonParse(report.context_json, null);
  const result = safeJsonParse(report.result_json, null);
  if (!context?.resume?.profile || !context?.application) {
    throw new AppError(409, 'REPORT_CONTEXT_MISSING', '这份报告缺少岗位或简历快照，请重新运行匹配分析后再生成问题');
  }
  return generateInterviewQuestions({
    profile: context.resume.profile,
    job: context.application,
    report: result
  });
}

function resumeKeywords(profile) {
  const words = [];
  for (const s of profile.skills || []) if (s?.name) words.push(String(s.name));
  for (const s of profile.industries || []) if (s?.name) words.push(String(s.name));
  for (const s of profile.strengths || []) if (s?.point) words.push(String(s.point));
  for (const e of profile.experiences || []) {
    if (e?.role) words.push(String(e.role));
    for (const h of e?.highlights || []) words.push(String(h));
  }
  return [...new Set(words.map((w) => w.toLowerCase()).filter((w) => w.length >= 2))];
}
function scoreJob(keywords, app) {
  const hay = `${app.job_title || ''}\n${app.jd_summary || ''}\n${app.jd_text || ''}`.toLowerCase();
  let score = 0;
  for (const word of keywords) if (hay.includes(word)) score += Math.min(4, word.length / 3);
  return score;
}

export async function recommendForOwner(ownerId) {
  const { row: resume, profile } = requireReadyResume(ownerId);
  const rows = all(`SELECT * FROM applications WHERE owner_id = ? AND has_applied = 0 AND archived_at IS NULL
    ORDER BY updated_at DESC, created_at DESC`, [ownerId]);
  const sufficient = [];
  const insufficient = [];
  for (const app of rows) {
    const jd = String(app.jd_text || app.jd_summary || '').trim();
    const item = {
      id: app.id, company_name: app.company_name, job_title: app.job_title,
      location: app.location, recruitment_batch: app.recruitment_batch,
      job_url: app.job_url || null, jd_text: app.jd_text || '', jd_summary: app.jd_summary || '',
      jd_chars: jd.length, source: safeJsonParse(app.source_methods_json, []),
      capture_source: app.capture_source || null
    };
    if (jd.length >= 80) sufficient.push(item);
    else insufficient.push({ ...item, application_id: item.id, id: undefined, reason: jd ? 'JD 过短，无法做充分匹配判断' : '没有采集到 JD，信息不足' });
  }
  const keywords = resumeKeywords(profile);
  sufficient.sort((a, b) => scoreJob(keywords, b) - scoreJob(keywords, a) || String(b.jd_chars).localeCompare(String(a.jd_chars)));
  const rankedInput = sufficient.slice(0, Math.max(1, config.aiMaxJobs));
  const skippedSufficient = sufficient.slice(rankedInput.length).map((x) => ({
    application_id: x.id, company_name: x.company_name, job_title: x.job_title,
    job_url: x.job_url, information_sufficient: true, reason: '候选中 JD 充分，但本次只分析排序靠前的岗位'
  }));
  if (!rankedInput.length) {
    return {
      report: null,
      result: {
        summary: insufficient.length
          ? '当前没有足够 JD 的未投递岗位；已列出信息不足的岗位，不能据此做确定推荐。'
          : '当前没有尚未投递的岗位。',
        recommendations: [],
        insufficient: insufficient.slice(0, 50),
        limitations: ['推荐只使用系统已采集、尚未投递的岗位；不访问外部招聘网站。'],
        resume_id: resume.id,
        source: 'none'
      }
    };
  }
  if (!aiAvailable()) throw new AppError(503, 'AI_NOT_CONFIGURED', '尚未配置云端模型，暂时无法生成推荐', { retryable: false });
  const reportId = startReport({ ownerId, kind: 'recommend', resumeId: resume.id, applicationIds: rankedInput.map((x) => x.id) });
  try {
    const result = await recommendJobs({ profile, jobs: rankedInput });
    result.insufficient = [...insufficient.slice(0, 50), ...skippedSufficient].slice(0, 60);
    result.resume_id = resume.id;
    result.candidate_count = rows.length;
    result.analyzed_count = rankedInput.length;
    return { report: finishReport(reportId, ownerId, result), result };
  } catch (err) {
    failReport(reportId, ownerId, err);
    throw err;
  }
}

export function getReport(ownerId, reportId) {
  const row = one('SELECT * FROM ai_reports WHERE id = ? AND owner_id = ?', [reportId, ownerId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', '报告不存在');
  const report = reportProjection(row);
  if (report.kind === 'match') {
    const applicationId = report.application_ids[0] || null;
    report.corrections = applicationId
      ? matchCorrections(ownerId, applicationId).map(correctionProjection)
      : [];
  }
  return report;
}

export function aiStatus(ownerId) {
  const resume = currentResume(ownerId);
  return {
    available: aiAvailable(),
    provider: aiAvailable() ? config.aiProvider : 'unconfigured',
    model_configured: Boolean(config.aiApiUrl && config.aiModel),
    resume_ready: resume?.status === 'ready',
    resume_id: resume?.id || null,
    supported_formats: ['pdf', 'docx', 'text'],
    max_resume_bytes: 5 * 1024 * 1024
  };
}
