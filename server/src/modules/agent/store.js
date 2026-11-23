import { all, bumpRevision, getApplication, one, run, transaction } from '../../db.js';
import { AppError, newId, nowIso, safeJsonParse } from '../../util.js';
import { currentResume, getResume, listResumes } from '../career-ai/service.js';
import { applicationDetail, ledgerResponse } from '../../domain/ledger.js';
import { correctApplication, setApplicationStatusManually } from '../../domain/reviews.js';
import { createResumeVersionFromText } from '../career-ai/service.js';
import { getProfile, profilePayload, saveProfile } from '../profile/service.js';
import { writeResumeDocx } from '../career-ai/docx-exporter.js';

export function sessionProjection(row) {
  if (!row) return null;
  return {
    id: row.id, title: row.title || '新的求职对话',
    context_resume_id: row.context_resume_id || null,
    context_application_id: row.context_application_id || null,
    summary_text: row.summary_text || null,
    created_at: row.created_at, updated_at: row.updated_at, archived_at: row.archived_at || null
  };
}
export function messageProjection(row) {
  if (!row) return null;
  return {
    id: row.id, session_id: row.session_id, role: row.role, content: row.content,
    meta: safeJsonParse(row.meta_json, {}) || {}, created_at: row.created_at
  };
}
export function actionProjection(row) {
  if (!row) return null;
  return {
    id: row.id, session_id: row.session_id, message_id: row.message_id || null,
    action_type: row.action_type, payload: safeJsonParse(row.payload_json, {}) || {},
    summary: safeJsonParse(row.summary_json, {}) || {}, status: row.status,
    result: safeJsonParse(row.result_json, null),
    expires_at: row.expires_at, created_at: row.created_at, resolved_at: row.resolved_at || null
  };
}
function ownedSession(ownerId, sessionId, includeArchived = false) {
  const row = one('SELECT * FROM agent_sessions WHERE id = ? AND owner_id = ?', [String(sessionId), ownerId]);
  if (!row || (!includeArchived && row.archived_at)) throw new AppError(404, 'AGENT_SESSION_NOT_FOUND', '对话不存在或已归档');
  return row;
}
export function listSessions(ownerId, { limit = 30 } = {}) {
  return all(`SELECT * FROM agent_sessions WHERE owner_id = ? AND archived_at IS NULL
    ORDER BY updated_at DESC LIMIT ?`, [ownerId, Math.max(1, Math.min(50, Number(limit) || 30))]).map(sessionProjection);
}
export function createSession(ownerId, { title = null, contextResumeId = null, contextApplicationId = null } = {}) {
  if (contextApplicationId && !getApplication(ownerId, contextApplicationId)) throw new AppError(404, 'NOT_FOUND', '岗位不存在或不属于当前账号');
  if (contextResumeId && !getResume(ownerId, contextResumeId, { includeText: false })) throw new AppError(404, 'NOT_FOUND', '简历不存在或不属于当前账号');
  const id = newId('agsess');
  const at = nowIso();
  const resume = contextResumeId || currentResume(ownerId)?.id || null;
  run(`INSERT INTO agent_sessions (id, owner_id, title, context_resume_id, context_application_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, ownerId, title ? String(title).slice(0, 120) : null, resume, contextApplicationId || null, at, at]);
  return sessionProjection(one('SELECT * FROM agent_sessions WHERE id = ? AND owner_id = ?', [id, ownerId]));
}
export function getSession(ownerId, sessionId) { return sessionProjection(ownedSession(ownerId, sessionId, true)); }
export function archiveSession(ownerId, sessionId) {
  ownedSession(ownerId, sessionId, true);
  run('UPDATE agent_sessions SET archived_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?', [nowIso(), nowIso(), sessionId, ownerId]);
  return { archived: true, id: sessionId };
}
export function updateContext(ownerId, sessionId, { contextResumeId = undefined, contextApplicationId = undefined } = {}) {
  return transaction(() => {
    const session = ownedSession(ownerId, sessionId);
    if (contextApplicationId && !getApplication(ownerId, contextApplicationId)) throw new AppError(404, 'NOT_FOUND', '岗位不存在或不属于当前账号');
    if (contextResumeId && !getResume(ownerId, contextResumeId, { includeText: false })) throw new AppError(404, 'NOT_FOUND', '简历不存在或不属于当前账号');
    const nextResume = contextResumeId === undefined ? session.context_resume_id : contextResumeId;
    const nextApp = contextApplicationId === undefined ? session.context_application_id : contextApplicationId;
    const changedApp = nextApp !== session.context_application_id;
    run('UPDATE agent_sessions SET context_resume_id = ?, context_application_id = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
      [nextResume || null, nextApp || null, nowIso(), session.id, ownerId]);
    if (changedApp) {
      const app = nextApp ? getApplication(ownerId, nextApp) : null;
      appendMessage({ ownerId, sessionId, role: 'context_boundary', content: app ? `上下文已切换到：${app.company_name || '未命名公司'} · ${app.job_title || '岗位'}` : '上下文已切换到全部岗位', meta: { context_application_id: nextApp || null } });
    }
    return getSession(ownerId, sessionId);
  });
}
export function appendMessage({ ownerId, sessionId, role, content, meta = {} }) {
  const id = newId('agmsg');
  const at = nowIso();
  run(`INSERT INTO agent_messages (id, session_id, owner_id, role, content, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, sessionId, ownerId, role, String(content || ''), JSON.stringify(meta || {}), at]);
  run('UPDATE agent_sessions SET updated_at = ? WHERE id = ? AND owner_id = ?', [at, sessionId, ownerId]);
  return messageProjection(one('SELECT * FROM agent_messages WHERE id = ? AND owner_id = ?', [id, ownerId]));
}
export function listMessages(ownerId, sessionId) {
  ownedSession(ownerId, sessionId);
  return all('SELECT * FROM agent_messages WHERE session_id = ? AND owner_id = ? ORDER BY created_at ASC, id ASC', [sessionId, ownerId]).map(messageProjection);
}
export function listPendingActions(ownerId, sessionId) {
  run("UPDATE agent_pending_actions SET status='expired', resolved_at=? WHERE owner_id=? AND session_id=? AND status='pending' AND expires_at <= ?",
    [nowIso(), ownerId, sessionId, nowIso()]);
  return all("SELECT * FROM agent_pending_actions WHERE owner_id = ? AND session_id = ? AND status = 'pending' ORDER BY created_at ASC", [ownerId, sessionId]).map(actionProjection);
}
export function createPendingAction({ ownerId, sessionId, messageId = null, actionType, payload, summary, ttlMinutes = 15 }) {
  if (!['update_status', 'rewrite_resume', 'update_profile', 'update_job_fields'].includes(actionType)) throw new AppError(400, 'VALIDATION_ERROR', '未知写操作类型');
  const id = newId('agact');
  const at = nowIso();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
  run(`INSERT INTO agent_pending_actions
    (id, session_id, message_id, owner_id, action_type, payload_json, summary_json, status, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  [id, sessionId, messageId || null, ownerId, actionType, JSON.stringify(payload || {}), JSON.stringify(summary || {}), expiresAt, at]);
  return actionProjection(one('SELECT * FROM agent_pending_actions WHERE id = ? AND owner_id = ?', [id, ownerId]));
}
export function getPendingAction(ownerId, actionId) {
  const row = one('SELECT * FROM agent_pending_actions WHERE id = ? AND owner_id = ?', [String(actionId), ownerId]);
  if (!row) throw new AppError(404, 'AGENT_ACTION_NOT_FOUND', '待确认操作不存在');
  return row;
}
function actionExpired(row) { return !row.expires_at || Date.parse(row.expires_at) <= Date.now(); }
function writeAgentAudit(ownerId, action, targetType, targetId, meta) {
  run(`INSERT INTO audit_log (id, owner_id, actor, action, target_type, target_id, meta_json, created_at)
       VALUES (?, ?, 'agent_confirmed', ?, ?, ?, ?, ?)`,
  [newId('aud'), ownerId, action, targetType, targetId, JSON.stringify(meta || {}), nowIso()]);
}
export function cancelAction(ownerId, actionId) {
  return transaction(() => {
    const row = getPendingAction(ownerId, actionId);
    if (row.status !== 'pending') throw new AppError(409, 'AGENT_ACTION_RESOLVED', '该操作已经处理');
    run("UPDATE agent_pending_actions SET status='cancelled', resolved_at=? WHERE id=? AND owner_id=?", [nowIso(), row.id, ownerId]);
    return actionProjection(one('SELECT * FROM agent_pending_actions WHERE id=? AND owner_id=?', [row.id, ownerId]));
  });
}
export function confirmAction(ownerId, actionId, options = {}) {
  // Expiry is a committed state transition, not a transaction that is rolled
  // back by the following 409 (otherwise the card stays pending forever).
  const pre = getPendingAction(ownerId, actionId);
  if (pre.status !== 'pending') throw new AppError(409, 'AGENT_ACTION_RESOLVED', '该操作已经处理');
  if (actionExpired(pre)) {
    run("UPDATE agent_pending_actions SET status='expired', resolved_at=? WHERE id=? AND owner_id=?", [nowIso(), pre.id, ownerId]);
    throw new AppError(409, 'AGENT_ACTION_EXPIRED', '该操作已过期，请重新发起');
  }
  return transaction(() => {
    const row = getPendingAction(ownerId, actionId);
    if (row.status !== 'pending') throw new AppError(409, 'AGENT_ACTION_RESOLVED', '该操作已经处理');
    const payload = safeJsonParse(row.payload_json, {}) || {};
    let result;
    if (row.action_type === 'update_status') {
      const items = Array.isArray(payload.items) ? payload.items : [];
      if (!items.length) throw new AppError(400, 'VALIDATION_ERROR', '待确认操作没有目标记录');
      const results = [];
      for (const item of items) {
        const app = getApplication(ownerId, item.application_id);
        if (!app) { results.push({ application_id: item.application_id, ok: false, reason: 'NOT_FOUND' }); continue; }
        if (Number(item.expected_version) !== Number(app.version)) {
          results.push({ application_id: item.application_id, ok: false, reason: 'VERSION_CONFLICT', current_version: app.version });
          continue;
        }
        try {
          const updated = setApplicationStatusManually({
            ownerId, applicationId: app.id, expectedVersion: item.expected_version,
            status: item.status, reason: 'AI 助手确认修改状态', actor: 'agent_confirmed'
          }).application;
          writeAgentAudit(ownerId, 'application.status.agent', 'application', app.id, { action_id: row.id, from: app.status, to: item.status });
          results.push({ application_id: app.id, ok: true, status: updated.status, version: updated.version });
        } catch (error) {
          results.push({ application_id: app.id, ok: false, reason: error?.code || 'UPDATE_FAILED', message: error?.message || '更新失败' });
        }
      }
      const ok = results.filter((item) => item.ok).length;
      result = { action_type: row.action_type, ok_count: ok, skipped_count: results.length - ok, items: results, mutated_entities: ok ? ['applications'] : [] };
      const finalStatus = ok ? 'confirmed' : 'failed';
      run("UPDATE agent_pending_actions SET status=?, result_json=?, resolved_at=? WHERE id=?", [finalStatus, JSON.stringify(result), nowIso(), row.id]);
      if (ok) bumpRevision();
    } else if (row.action_type === 'update_job_fields') {
      const items = Array.isArray(payload.items) ? payload.items : [];
      if (!items.length) throw new AppError(400, 'VALIDATION_ERROR', '待确认操作没有目标记录');
      const results = [];
      for (const item of items) {
        const app = getApplication(ownerId, item.application_id);
        if (!app) { results.push({ application_id: item.application_id, ok: false, reason: 'NOT_FOUND' }); continue; }
        if (Number(item.expected_version) !== Number(app.version)) {
          results.push({ application_id: item.application_id, ok: false, reason: 'VERSION_CONFLICT', current_version: app.version });
          continue;
        }
        try {
          const updated = correctApplication({
            ownerId, applicationId: app.id, expectedVersion: item.expected_version,
            changes: item.changes || {}, reason: payload.reason || 'AI 助手确认修改岗位字段', actor: 'agent_confirmed'
          }).application;
          writeAgentAudit(ownerId, 'application.fields.agent', 'application', app.id, { action_id: row.id, fields: Object.keys(item.changes || {}) });
          results.push({ application_id: app.id, ok: true, version: updated.version });
        } catch (error) {
          results.push({ application_id: app.id, ok: false, reason: error?.code || 'UPDATE_FAILED', message: error?.message || '更新失败' });
        }
      }
      const ok = results.filter((item) => item.ok).length;
      result = { action_type: row.action_type, ok_count: ok, skipped_count: results.length - ok, items: results, mutated_entities: ok ? ['applications'] : [] };
      const finalStatus = ok ? 'confirmed' : 'failed';
      run("UPDATE agent_pending_actions SET status=?, result_json=?, resolved_at=? WHERE id=?", [finalStatus, JSON.stringify(result), nowIso(), row.id]);
      if (ok) bumpRevision();
    } else if (row.action_type === 'update_profile') {
      const profile = saveProfile(ownerId, payload.profile || {}, { status: 'confirmed' });
      writeAgentAudit(ownerId, 'profile.save.agent', 'user_profile', ownerId, { action_id: row.id });
      result = { action_type: row.action_type, profile, mutated_entities: ['profile'] };
      run("UPDATE agent_pending_actions SET status='confirmed', result_json=?, resolved_at=? WHERE id=?", [JSON.stringify(result), nowIso(), row.id]);
      bumpRevision();
    } else if (row.action_type === 'rewrite_resume') {
      const resumeId = payload.parent_resume_id || payload.resume_id;
      if (!resumeId) throw new AppError(400, 'VALIDATION_ERROR', '改写操作缺少原简历');
      const target = payload.target_application_id || payload.application_id;
      const setCurrent = options.set_current === true || payload.set_current === true;
      const created = createResumeVersionFromText({
        ownerId, text: payload.full_rewritten_text, filename: payload.version_label,
        parentResumeId: resumeId, targetApplicationId: target,
        rewriteSummary: { sections: payload.sections || [], target_application_id: target, created_from: 'agent' },
        setCurrent
      });
      const docx = writeResumeDocx({ ownerId, resumeId: created.id, text: created.text, title: created.filename });
      run('UPDATE resumes SET export_docx_path = ? WHERE id = ? AND owner_id = ?', [docx.relativePath, created.id, ownerId]);
      writeAgentAudit(ownerId, 'resume.rewrite.agent', 'resume', created.id, { parent_resume_id: resumeId, target_application_id: target, action_id: row.id });
      if (setCurrent) {
        run('UPDATE agent_sessions SET context_resume_id = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
          [created.id, nowIso(), row.session_id, ownerId]);
        appendMessage({ ownerId, sessionId: row.session_id, role: 'context_boundary', content: `当前简历已切换为：${created.filename}`, meta: { context_resume_id: created.id } });
      }
      const safeCreated = getResume(ownerId, created.id);
      result = { action_type: row.action_type, resume: safeCreated, mutated_entities: ['resumes'] };
      run("UPDATE agent_pending_actions SET status='confirmed', result_json=?, resolved_at=? WHERE id=?", [JSON.stringify(result), nowIso(), row.id]);
      bumpRevision();
    } else {
      throw new AppError(400, 'VALIDATION_ERROR', '未知操作类型');
    }
    return { action: actionProjection(one('SELECT * FROM agent_pending_actions WHERE id=? AND owner_id=?', [row.id, ownerId])), result };
  });
}
export function agentContext(ownerId, session = null) {
  const resume = session?.context_resume_id ? getResume(ownerId, session.context_resume_id, { includeText: true }) : currentResume(ownerId);
  const focused = session?.context_application_id ? applicationDetail(ownerId, session.context_application_id).data : null;
  const ledger = ledgerResponse(ownerId, { view: 'applied', limit: 100 });
  const profile = getProfile(ownerId).profile;
  const recent = ledger.data.items.slice(0, 8).map((app) => ({
    id: app.id, company_name: app.company_name, job_title: app.job_title,
    status: app.status, status_label: app.status_label, location: app.location,
    applied_at: app.applied_at, last_progress_at: app.last_progress_at,
    round_label: app.round_label, days_since_applied: app.days_since_applied
  }));
  const resumes = listResumes(ownerId, { limit: 20 }).items.map((item) => ({
    id: item.id, filename: item.filename, is_current: item.is_current, status: item.status,
    updated_at: item.updated_at, parent_resume_id: item.parent_resume_id || null
  }));
  return {
    resume: resume ? { id: resume.id, filename: resume.filename, status: resume.status, text_chars: resume.text_chars, is_current: resume.is_current, updated_at: resume.updated_at, text_preview: String(resume.text || '').slice(0, 1200) } : null,
    resumes,
    application: focused ? {
      id: focused.id, company_name: focused.company_name, job_title: focused.job_title,
      status: focused.status, jd_summary: focused.jd_summary, jd_text: focused.jd_text,
      location: focused.location, round_label: focused.round_label,
      interview_scheduled_at: focused.interview_scheduled_at,
      history: (focused.history || []).slice(0, 20)
    } : null,
    recent_applications: recent,
    profile: profile ? { status: profile.status, ...profilePayload(profile) } : { status: 'missing' },
    counts: ledger.data.counts,
    stats: ledger.data.stats,
    data_revision: ledger.data.data_revision
  };
}
export function recordToolRun({ ownerId, sessionId, messageId = null, toolName, input, output, status = 'ok', latencyMs = null, usage = null }) {
  const id = newId('agtool');
  run(`INSERT INTO agent_tool_runs
    (id, session_id, message_id, owner_id, tool_name, input_json, output_summary_json, status, latency_ms, prompt_tokens, completion_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, sessionId || null, messageId || null, ownerId, toolName, JSON.stringify(input || {}), JSON.stringify(output || {}), status,
    latencyMs, usage?.prompt_tokens || null, usage?.completion_tokens || null, nowIso()]);
  return id;
}
