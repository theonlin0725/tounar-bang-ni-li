import { config } from '../../config.js';
import { route } from '../../http.js';
import { requireAuth } from '../../auth.js';
import { all, dataRevision, one, run } from '../../db.js';
import { AppError, newId, nowIso, sha256 } from '../../util.js';
import { getTemplate, renderTemplate, saveTemplate, templateHistory } from './templates.js';
import { templateDefaults } from './template-defaults.js';
import { sendMail, publicMailError } from './mailer.js';
import { buildReminderCandidates, previewBusinessReminder, runReminderForOwner } from './reminders.js';

const previewDocuments = new Map();
function previewResponse(ownerId, data) {
  for (const [key, value] of previewDocuments) if (value.expires < Date.now()) previewDocuments.delete(key);
  if (previewDocuments.size >= 100) previewDocuments.delete(previewDocuments.keys().next().value);
  const id = newId('mailpreview');
  previewDocuments.set(id, { ownerId, html: data.html, expires: Date.now() + 300000 });
  return { data: { ...data, preview_url: '/api/v1/admin/mail/preview-html/'+id } };
}
function admin(req) {
  const auth = requireAuth(req);
  if (!config.adminEmails.has(auth.user.email_normalized)) throw new AppError(403, 'ADMIN_REQUIRED', '仅管理员可使用邮件测试与模板管理');
  return auth;
}
function recipient(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email) || !config.testMailRecipients.has(email)) throw new AppError(403, 'TEST_RECIPIENT_FORBIDDEN', '只能发送到 TEST_MAIL_RECIPIENTS 中配置的测试邮箱；请从下拉列表选择');
  return email;
}
function checkVersions(versions) {
  if (!versions || typeof versions !== 'object' || !Object.keys(versions).length) throw new AppError(409, 'PREVIEW_REQUIRED', '请先预览当前已保存版本，再点击发送');
  for (const [id, version] of Object.entries(versions)) if (getTemplate(id).version !== version) throw new AppError(409, 'VERSION_CONFLICT', '模板版本已变化，请重新预览再发送');
}
function businessEnabled() {
  if (!config.enableMailBusinessTest) throw new AppError(403, 'BUSINESS_TEST_DISABLED', '业务测试未开启，需要配置 ENABLE_MAIL_BUSINESS_TEST=true');
}
export function registerMailAdminRoutes() {
  route('GET', '/api/v1/admin/mail', req => {
    const auth = admin(req), candidates = buildReminderCandidates(auth.ownerId);
    const eligible = new Set([...candidates.a, ...candidates.b].map(x => x.app.id));
    return { data: {
      transport: config.mailMode, smtp_configured: !!config.smtpUrl, from: config.mailFrom,
      test_recipients: [...config.testMailRecipients], business_test_enabled: config.enableMailBusinessTest,
      templates: Object.keys(templateDefaults).map(id => ({ ...getTemplate(id), history: templateHistory(id) })),
      applications: all('SELECT id,company_name,job_title,status,created_at FROM applications WHERE owner_id=? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 100', [auth.ownerId]).map(x => ({ ...x, eligible: eligible.has(x.id) })),
      data_revision: dataRevision()
    } };
  });
  route('GET', '/api/v1/admin/mail/templates/:id/versions/:version', req => {
    admin(req);
    return { data: getTemplate(req.params.id, req.params.version) };
  });
  route('PUT', '/api/v1/admin/mail/templates/:id', req => {
    const auth = admin(req);
    return { data: saveTemplate(req.params.id, req.body.template, req.body.expected_version, auth.user.email_normalized, req.body.variables) };
  });
  route('POST', '/api/v1/admin/mail/templates/:id/restore', req => {
    const auth = admin(req), old = getTemplate(req.params.id, req.body.version);
    return { data: saveTemplate(req.params.id, old, req.body.expected_version, auth.user.email_normalized + '（恢复 v'+old.version+'）', old.sample) };
  });
  route('GET', '/api/v1/admin/mail/preview-html/:id', (req, res) => {
    const auth = admin(req), doc = previewDocuments.get(req.params.id);
    if (!doc || doc.ownerId !== auth.ownerId || doc.expires < Date.now()) throw new AppError(404, 'NOT_FOUND', '预览已过期，请重新预览');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox");
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(doc.html);
  });
  route('POST', '/api/v1/admin/mail/preview', req => {
    const auth = admin(req), body = req.body;
    if (body.mode === 'business') { businessEnabled(); return previewResponse(auth.ownerId, previewBusinessReminder(auth.ownerId, body.application_id)); }
    if (body.mode !== 'template') throw new AppError(400, 'VALIDATION_ERROR', '请选择模板试发或业务通路测试');
    const rendered = renderTemplate(body.template_id, body.variables, body.draft || null);
    return previewResponse(auth.ownerId, { ...rendered, subject: '【自测·模板试发】' + rendered.subject, template_versions: { [body.template_id]: rendered.version } });
  });
  route('GET', '/api/v1/admin/mail/records', req => {
    const auth = admin(req);
    // 崩溃或请求中断后保守标记为未知，避免“发送中”永久伪装成成功。
    const cutoff = new Date(Date.now() - 120000).toISOString();
    run("UPDATE mail_test_runs SET status='delivery_unknown',updated_at=? WHERE owner_id=? AND status='sending' AND updated_at<?", [nowIso(), auth.ownerId, cutoff]);
    run("UPDATE mail_deliveries SET status='delivery_unknown',error_code='INTERRUPTED',error_message='发送过程被中断，送达状态未知，请检查收件箱。',updated_at=? WHERE owner_id=? AND status='sending' AND updated_at<?", [nowIso(), auth.ownerId, cutoff]);
    return { data: {
      runs: all('SELECT * FROM mail_test_runs WHERE owner_id=? ORDER BY created_at DESC LIMIT 50', [auth.ownerId]).map(x => ({ ...x, result: JSON.parse(x.result_json || '{}'), result_json: undefined })),
      deliveries: all('SELECT * FROM mail_deliveries WHERE owner_id=? OR (owner_id IS NULL AND recipient=?) ORDER BY created_at DESC LIMIT 50', [auth.ownerId, auth.user.email_display]).map(x => ({ ...x, template_versions: JSON.parse(x.versions_json), context: JSON.parse(x.context_json), versions_json: undefined, context_json: undefined })),
      batches: all('SELECT id,business_date,channel,status,error_code,subject,updated_at FROM notification_batches WHERE owner_id=? ORDER BY updated_at DESC LIMIT 20', [auth.ownerId])
    } };
  });
  route('POST', '/api/v1/admin/mail/send', async req => {
    const auth = admin(req), body = req.body, to = recipient(body.to);
    if (!['template', 'business'].includes(body.mode)) throw new AppError(400, 'VALIDATION_ERROR', '请选择测试模式');
    if (!/^[a-zA-Z0-9_-]{8,120}$/.test(body.request_key || '')) throw new AppError(400, 'VALIDATION_ERROR', '请求标识无效，请刷新后再试');
    const requestHash = sha256(JSON.stringify(body));
    const existing = one('SELECT * FROM mail_test_runs WHERE owner_id=? AND request_key=?', [auth.ownerId, body.request_key]);
    if (existing && existing.request_hash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一次发送请求的内容已变化，请重新预览后发送');
    if (existing) return { data: { run_id: existing.id, status: existing.status, reused: true, result: JSON.parse(existing.result_json || '{}') } };
    const recent = one('SELECT COUNT(*) AS c FROM mail_test_runs WHERE owner_id=? AND created_at>?', [auth.ownerId, new Date(Date.now()-60000).toISOString()]);
    if (recent.c >= 5) throw new AppError(429, 'RATE_LIMITED', '每分钟最多试发 5 次，请稍后重试');
    checkVersions(body.expected_versions);
    if (body.mode === 'business') {
      businessEnabled();
      if (String(body.data_revision) !== dataRevision()) throw new AppError(409, 'VERSION_CONFLICT', '台账在预览后已变化，请重新预览');
      const actual = previewBusinessReminder(auth.ownerId, body.application_id);
      for (const [id, v] of Object.entries(actual.template_versions)) if (body.expected_versions[id] !== v) throw new AppError(409, 'PREVIEW_REQUIRED', '请预览这条记录当前使用的全部模板后再发送');
    }
    // 试发必须使用已经保存的版本；请求不能覆盖模板正文。
    const rendered = body.mode === 'template' ? renderTemplate(body.template_id, body.variables) : null;
    if (rendered && body.expected_versions[body.template_id] !== rendered.version) throw new AppError(409, 'PREVIEW_REQUIRED', '请先预览所选模板的已保存版本');
    const id = newId('mailtest'), at = nowIso();
    run(`INSERT INTO mail_test_runs (id,owner_id,request_key,request_hash,mode,recipient,application_id,template_id,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'sending',?,?)`, [id, auth.ownerId, body.request_key, requestHash, body.mode, to, body.application_id || null, body.template_id || null, at, at]);
    let result;
    try {
      if (body.mode === 'business') result = await runReminderForOwner(auth.ownerId, new Date(), { force: true, test: { to, applicationId: body.application_id, runId: id } });
      else {
        const sent = await sendMail({ ...rendered, subject: '【自测·模板试发】' + rendered.subject, to, kind: 'template_test', metadata: { owner_id: auth.ownerId, test_run_id: id, test_mode: 'template_test', template_versions: { [body.template_id]: rendered.version } } });
        result = { status: sent.status, delivery_id: sent.delivery_id, provider_message_id: sent.messageId, transport: sent.transport, template_versions: { [body.template_id]: rendered.version } };
      }
    } catch (err) { const safe = publicMailError(err); result = { status: safe.status, error: safe.message, error_code: safe.code, issues: err.details?.issues || null }; }
    const status = result.delivery_status || result.status || 'failed';
    run('UPDATE mail_test_runs SET status=?,result_json=?,updated_at=? WHERE id=?', [status, JSON.stringify(result), nowIso(), id]);
    return { data: { run_id: id, status, result } };
  });
}
