import { config } from '../../config.js';
import { all, getApplication, one, run, transaction } from '../../db.js';
import {
  AppError, clipText, newId, normalizeWhitespace, nowIso, safeJsonParse
} from '../../util.js';
import { extractResumeText, MAX_RESUME_TEXT } from './resume-parser.js';
import { aiAvailable, analyzeResumeProfile, compareJobs, recommendJobs } from './llm.js';

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

function reportProjection(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    resume_id: row.resume_id,
    application_ids: safeJsonParse(row.application_ids_json, []),
    status: row.status,
    result: safeJsonParse(row.result_json, null),
    error_code: row.error_code,
    error_message: row.error_message,
    created_at: row.created_at,
    completed_at: row.completed_at
  };
}

function startReport({ ownerId, kind, resumeId, applicationIds }) {
  const id = newId('aireport');
  run(`INSERT INTO ai_reports (id, owner_id, kind, resume_id, application_ids_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`,
  [id, ownerId, kind, resumeId || null, JSON.stringify(applicationIds || []), nowIso()]);
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
  return reportProjection(row);
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
