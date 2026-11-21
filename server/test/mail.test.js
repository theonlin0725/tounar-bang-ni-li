import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { startTestServer } from './helpers.js';
import { encoderForTest } from '../src/modules/data-capture/mail/sync.js';
import { resolveMailProvider, imapHostFor } from '../src/modules/data-capture/mail/providers.js';
import {
  classifyRecruitmentMail, extractMailFields, isRecruitmentHeader, publicEvidence, stripHtml, confirmedMailProgress
} from '../src/domain/mailParser.js';

describe('招聘邮箱只读连接生命周期（无真实 IMAP：只验证失败可见、不假装成功）', () => {
  let server;
  let cookie;
  before(async () => {
    server = await startTestServer({ name: 'mail' });
    cookie = (await server.login('demo@tounar.local')).cookie;
  });
  after(async () => { await server.stop(); });

  it('参数校验：非 QQ 域名、短授权码、缺同意版本都拒绝', async () => {
    const badDomain = await server.request('/api/v1/mail-connections', { method: 'POST', cookie, body: { email: 'demo@gmail.com', auth_code: 'abcdefghijklmnop', mode: 'headers_only', consent_version: 'QQ_MAIL_READ_CONSENT_V1' } });
    assert.equal(badDomain.status, 400);
    const shortCode = await server.request('/api/v1/mail-connections', { method: 'POST', cookie, body: { email: 'demo@qq.com', auth_code: 'abc', mode: 'headers_only', consent_version: 'QQ_MAIL_READ_CONSENT_V1' } });
    assert.equal(shortCode.status, 400);
    const noConsent = await server.request('/api/v1/mail-connections', { method: 'POST', cookie, body: { email: 'demo@qq.com', auth_code: 'abcdefghijklmnop', mode: 'headers_only' } });
    assert.equal(noConsent.status, 400);
  });

  it('创建连接（本机无真实 IMAP）：返回 202，失败在状态里可见，响应不泄露授权码', async () => {
    const created = await server.request('/api/v1/mail-connections', {
      method: 'POST', cookie,
      body: { email: 'demo@qq.com', auth_code: 'abcdefghijklmnop', mode: 'headers_only', consent_version: 'QQ_MAIL_READ_CONSENT_V1' }
    });
    assert.equal(created.status, 202);
    const id = created.json.data.id;
    assert.ok(!/abcdefghijklmnop/.test(JSON.stringify(created.json)));
    let status = created.json.data.status;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const detail = await server.request(`/api/v1/mail-connections/${id}`, { cookie });
      status = detail.json.data.status;
      if (status !== 'connecting') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(['reauth_required', 'degraded', 'error', 'failed'].includes(status), `status=${status}`);
    const detail = await server.request(`/api/v1/mail-connections/${id}`, { cookie });
    assert.ok(detail.json.data.last_error_code, '失败必须留下错误码，不能假装已连接');
    assert.notEqual(detail.json.data.status, 'connected');
    const conflict = await server.request('/api/v1/mail-connections', {
      method: 'POST', cookie,
      body: { email: 'demo@qq.com', auth_code: 'abcdefghijklmnop', mode: 'headers_only', consent_version: 'QQ_MAIL_READ_CONSENT_V1' }
    });
    assert.equal(conflict.status, 409);
  });

  it('新邮件入账后不能因 aiCandidate 作用域错误中断，重复邮件保持幂等', async () => {
    const script = `
      import { one, run } from './server/src/db.js';
      import { encoderForTest } from './server/src/modules/data-capture/mail/sync.js';
      import { classifyRecruitmentMail, extractMailFields } from './server/src/domain/mailParser.js';
      const connection = one('SELECT * FROM mail_connections ORDER BY created_at LIMIT 1');
      if (!connection) throw new Error('missing test connection');
      const subject = '【同步修复测试】投递成功通知';
      const parsed = { uidvalidity: 'test-uid-validity', subject, tentativeHeader: true,
        classification: classifyRecruitmentMail({ subject, fromDomain: 'hr.example.com', bodyText: '', mode: 'headers_only' }),
        fields: extractMailFields({ subject, fromAddress: 'hr@hr.example.com', bodyText: '' }) };
      const message = { uid: 987654, messageId: '<mail-scope-regression@example.com>' };
      const receivedAt = new Date().toISOString();
      const result = await encoderForTest().ingestMessage(connection, message, parsed, '', receivedAt);
      const duplicate = await encoderForTest().ingestMessage(connection, message, parsed, '', receivedAt);
      // Recreate the crash window left by the old scope bug: mail + event were
      // committed, but no review/application pipeline result was produced.
      run('DELETE FROM review_items WHERE source_event_id = ?', [result.event.id]);
      run("UPDATE events SET processing_state = 'pending', review_reason = NULL, processed_at = NULL WHERE id = ?", [result.event.id]);
      run("UPDATE mail_messages SET processing_state = 'pending', review_item_id = NULL WHERE id = ?", [result.mail.id]);
      const recovered = await encoderForTest().ingestMessage(connection, message, parsed, '', receivedAt);
      const duplicateAfterRecovery = await encoderForTest().ingestMessage(connection, message, parsed, '', receivedAt);
      const reviewCount = one('SELECT COUNT(*) AS n FROM review_items WHERE source_event_id = ?', [result.event.id]).n;
      const uniqueCount = encoderForTest().firstScanProcessedCount(connection.id, 'test-uid-validity', 1);
      console.log(JSON.stringify({
        ingested: Boolean(result.event || result.mail), duplicate: duplicate.duplicate === true,
        recovered: recovered.recovered === true && recovered.result?.state === 'applied',
        duplicate_after_recovery: duplicateAfterRecovery.duplicate === true && duplicateAfterRecovery.recovered !== true,
        review_count: Number(reviewCount), unique_first_scan_processed: Number(uniqueCount)
      }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, DATA_DIR: server.dir, APP_ENV: 'test', CLOUD_LLM_ENABLED: 'false', AUTO_INTAKE_ENABLED: 'false' }
    });
    assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)), {
      ingested: true, duplicate: true, recovered: true, duplicate_after_recovery: true,
      review_count: 0, unique_first_scan_processed: 1
    });
  });

  it('T2 离线强规则：无台账时明确测评邀请直接新建投递明细，重复邮件幂等', async () => {
    const script = `
      import { one, run } from './server/src/db.js';
      import { encoderForTest } from './server/src/modules/data-capture/mail/sync.js';
      import { classifyRecruitmentMail, extractMailFields, confirmedMailProgress } from './server/src/domain/mailParser.js';
      const connection = one("SELECT * FROM mail_connections WHERE status <> 'disconnected' ORDER BY created_at LIMIT 1");
      if (!connection) throw new Error('missing test connection');
      run("UPDATE mail_connections SET mode='recruitment_body' WHERE id=?", [connection.id]);
      const subject = '【新机会科技】后端实习生 测评邀请';
      const body = '公司：新机会科技\\n岗位：后端实习生\\n邀请您于 2026-11-30 前完成在线测评。';
      const parsed = { uidvalidity: 'offline-strong-uid', subject, tentativeHeader: true,
        classification: classifyRecruitmentMail({ subject, fromDomain: 'hr.example.com', bodyText: body, mode: 'recruitment_body' }),
        fields: extractMailFields({ subject, fromAddress: 'hr@hr.example.com', bodyText: body }),
        confirmed: confirmedMailProgress(subject, body) };
      const message = { uid: 777001, messageId: '<offline-strong@example.com>' };
      const first = await encoderForTest().ingestMessage(connection, message, parsed, body, new Date().toISOString());
      const second = await encoderForTest().ingestMessage(connection, message, parsed, body, new Date().toISOString());
      const app = one("SELECT * FROM applications WHERE owner_id=? AND company_name='新机会科技'", [connection.owner_id]);
      const reviews = one("SELECT COUNT(*) n FROM review_items WHERE source_event_id=?", [first.event?.id || 'none']);
      run("UPDATE mail_connections SET mode='headers_only' WHERE id=?", [connection.id]);
      console.log(JSON.stringify({ created: Boolean(first.result?.application || app), state: first.result?.state || null,
        duplicate: second.duplicate === true, status: app?.status || null, has_applied: Number(app?.has_applied || 0),
        channel: app?.channel || null, applied_at: app?.applied_at || null, reviews: Number(reviews.n) }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, DATA_DIR: server.dir, APP_ENV: 'test', CLOUD_LLM_ENABLED: 'false', AUTO_INTAKE_ENABLED: 'false' }
    });
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(result.created, true);
    assert.equal(result.state, 'applied');
    assert.equal(result.duplicate, true);
    assert.equal(result.status, 'assessment');
    assert.equal(result.has_applied, 1);
    assert.equal(result.channel, '邮件');
    assert.ok(result.applied_at);
    assert.equal(result.reviews, 0);
  });

  it('T2 历史待确认邮件回填正文后可用强规则自动入账并关闭复核项', async () => {
    const script = `
      import { all, one, run } from './server/src/db.js';
      import { encoderForTest } from './server/src/modules/data-capture/mail/sync.js';
      import { classifyRecruitmentMail, extractMailFields, confirmedMailProgress } from './server/src/domain/mailParser.js';
      const connection = one("SELECT * FROM mail_connections WHERE status <> 'disconnected' ORDER BY created_at LIMIT 1");
      run("UPDATE mail_connections SET mode='recruitment_body' WHERE id=?", [connection.id]);
      const bodyConnection = one('SELECT * FROM mail_connections WHERE id=?', [connection.id]);
      const uid = 777101;
      const firstSubject = '招聘进展通知';
      const firstBody = '邀请您完成在线测评。';
      const firstParsed = { uidvalidity: 'backfill-uid', subject: firstSubject, tentativeHeader: true,
        classification: classifyRecruitmentMail({ subject: firstSubject, fromDomain: 'hr.example.com', bodyText: firstBody, mode: 'recruitment_body' }),
        fields: extractMailFields({ subject: firstSubject, fromAddress: 'hr@hr.example.com', bodyText: firstBody }), confirmed: null, backfill: false };
      const message = { uid, messageId: '<backfill@example.com>' };
      const first = await encoderForTest().ingestMessage(bodyConnection, message, firstParsed, firstBody, new Date().toISOString());
      const review = one('SELECT id,status FROM review_items WHERE source_event_id=?', [first.event.id]);
      const subject = '【回填科技】后端实习生 测评邀请';
      const body = '公司：回填科技\\n岗位：后端实习生\\n邀请您完成在线测评。';
      const backfillParsed = { uidvalidity: 'backfill-uid', subject, tentativeHeader: true,
        classification: classifyRecruitmentMail({ subject, fromDomain: 'hr.example.com', bodyText: body, mode: 'recruitment_body' }),
        fields: extractMailFields({ subject, fromAddress: 'hr@hr.example.com', bodyText: body }),
        confirmed: confirmedMailProgress(subject, body), backfill: true };
      const back = await encoderForTest().ingestMessage(bodyConnection, message, backfillParsed, body, new Date().toISOString());
      const app = one("SELECT * FROM applications WHERE owner_id=? AND company_name='回填科技'", [connection.owner_id]);
      const afterReview = one('SELECT status FROM review_items WHERE id=?', [review.id]);
      const mail = one('SELECT processing_state FROM mail_messages WHERE id=?', [first.mail.id]);
      run("UPDATE mail_connections SET mode='headers_only' WHERE id=?", [connection.id]);
      console.log(JSON.stringify({ review_open: review.status, applied: back.result?.state || null,
        app_status: app?.status || null, has_applied: Number(app?.has_applied || 0),
        review_after: afterReview?.status || null, mail_state: mail?.processing_state || null }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, DATA_DIR: server.dir, APP_ENV: 'test', CLOUD_LLM_ENABLED: 'false', AUTO_INTAKE_ENABLED: 'false' }
    });
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(result.review_open, 'open');
    assert.equal(result.applied, 'applied', JSON.stringify(result));
    assert.equal(result.app_status, 'assessment');
    assert.equal(result.has_applied, 1);
    assert.equal(result.review_after, 'resolved');
    assert.equal(result.mail_state, 'applied');
  });

  it('单封 ingest 抛错被隔离并继续，统计 errors=1，后续邮件仍可完成', async () => {
    const { ingestMessageIsolated, recordIngestFailure } = encoderForTest();
    const stats = { errors: 0, scanned: 0, total: 2, percent: 0, remaining: 2 };
    const seen = [];
    const first = await ingestMessageIsolated({ id: 'c' }, { uid: 1 }, {}, '', '', {
      ingest: async () => { throw Object.assign(new Error('bad mail'), { code: 'BAD_MAIL' }); }
    });
    if (first.error) recordIngestFailure(stats, stats.total, 1);
    const second = await ingestMessageIsolated({ id: 'c' }, { uid: 2 }, {}, '', '', {
      ingest: async () => { seen.push(2); return { created: true }; }
    });
    seen.push(2);
    assert.equal(first.error.code, 'BAD_MAIL');
    assert.equal(stats.errors, 1);
    assert.equal(stats.scanned, 1);
    assert.equal(second.ingested.created, true);
    assert.deepEqual(seen, [2, 2]);
    assert.equal(stats.total, 2);
  });

  it('D3 离线 processMailEvent 0 候选时也能自动建立投递明细', async () => {
    const script = `
      import { one } from './server/src/db.js';
      import { processMailEvent } from './server/src/domain/applications.js';
      const connection = one("SELECT * FROM mail_connections WHERE status <> 'disconnected' ORDER BY created_at LIMIT 1");
      const owner = connection.owner_id;
      const event = { id: 'evt_offline_auto_create', owner_id: owner, source_method: 'mail', occurred_at: '2026-11-03T00:00:00Z',
        payload: { company_name: '离线自动公司', job_title: '后端实习生', mapped_status: 'assessment',
          status_text: '在线测评', confidence: 0.94, source_received_at: '2026-11-03T00:00:00Z', from_domain: 'hr.example.com' } };
      const result = processMailEvent(event);
      const app = one("SELECT * FROM applications WHERE owner_id=? AND company_name='离线自动公司'", [owner]);
      console.log(JSON.stringify({ state: result.state, created: result.change, status: app?.status || null, has_applied: Number(app?.has_applied || 0) }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, DATA_DIR: server.dir, APP_ENV: 'test', CLOUD_LLM_ENABLED: 'false', AUTO_INTAKE_ENABLED: 'false' }
    });
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(result.state, 'applied');
    assert.equal(result.created, 'created');
    assert.equal(result.status, 'assessment');
    assert.equal(result.has_applied, 1);
  });

  it('同公司新岗位不误判歧义；单活跃公司可推进；多活跃才待确认', async () => {
    const script = `
      import { one } from './server/src/db.js';
      import { createApplication, recordConfirmedMail } from './server/src/domain/applications.js';
      import { resolveMailApplication } from './server/src/domain/mailMatching.js';
      const connection = one("SELECT * FROM mail_connections WHERE status <> 'disconnected' ORDER BY created_at LIMIT 1");
      const owner = connection.owner_id;
      const make = (company, title, status='pending') => createApplication({ ownerId: owner, sourceMethod: 'manual', status,
        fields: { company_name: company, job_title: title, applied_at: '2026-10-01T00:00:00Z', applied_at_precision: 'date' }, at: '2026-10-01T00:00:00Z' });
      const a = make('路由公司', '游戏策划');
      const newJob = resolveMailApplication(owner, { company_name: '路由公司', job_title: '产品经理' });
      const single = resolveMailApplication(owner, { company_name: '路由公司' });
      const b = make('路由公司', '数据分析');
      const multi = resolveMailApplication(owner, { company_name: '路由公司' });
      const pending = make('单活跃公司', '游戏策划', 'pending');
      const event = { id: 'evt_company_only_upgrade', owner_id: owner, occurred_at: '2026-11-02T00:00:00Z',
        payload: { from_domain: 'hr.example.com', subject_excerpt: '测评邀请', body_excerpt: '请完成测评' } };
      const upgrade = recordConfirmedMail(event, { company_name: '单活跃公司', job_title: null, company_only_progress: true, status: 'assessment' });
      const upgraded = one('SELECT status,has_applied,stage_received_at,stage_anchor_at FROM applications WHERE id=?', [pending.id]);
      console.log(JSON.stringify({ new_job_reason: newJob.reason, new_job_target: Boolean(newJob.target), new_job_ambiguous: newJob.ambiguous,
        single_reason: single.reason, single_target: single.target?.id === a.id,
        multi_ambiguous: multi.ambiguous, multi_target: Boolean(multi.target),
        upgrade_state: upgrade.state, upgrade_id: upgrade.application?.id === pending.id,
        upgraded_status: upgraded?.status, upgraded_has_applied: Number(upgraded?.has_applied || 0),
        stage_received: Boolean(upgraded?.stage_received_at), stage_anchor: Boolean(upgraded?.stage_anchor_at) }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, DATA_DIR: server.dir, APP_ENV: 'test', CLOUD_LLM_ENABLED: 'false', AUTO_INTAKE_ENABLED: 'false' }
    });
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(result.new_job_reason, 'new_job_same_company');
    assert.equal(result.new_job_target, false);
    assert.equal(result.new_job_ambiguous, false);
    assert.equal(result.single_reason, 'single_active_company');
    assert.equal(result.single_target, true);
    assert.equal(result.multi_ambiguous, true);
    assert.equal(result.multi_target, false);
    assert.equal(result.upgrade_state, 'applied');
    assert.equal(result.upgrade_id, true);
    assert.equal(result.upgraded_status, 'assessment');
    assert.equal(result.upgraded_has_applied, 1);
    assert.equal(result.stage_received, true);
    assert.equal(result.stage_anchor, true);
  });

  it('相似岗位名命中后按同一流程推进，不因严格标题不等误报冲突', async () => {
    const script = `
      import { one } from './server/src/db.js';
      import { createApplication, recordConfirmedMail } from './server/src/domain/applications.js';
      import { nowIso } from './server/src/util.js';
      const connection = one("SELECT * FROM mail_connections WHERE status <> 'disconnected' ORDER BY created_at LIMIT 1");
      const owner = connection.owner_id;
      const app = createApplication({ ownerId: owner, sourceMethod: 'manual', status: 'applied',
        fields: { company_name: '相似公司', job_title: '数据产品实习生', applied_at: '2026-10-01T00:00:00Z', applied_at_precision: 'date' },
        at: '2026-10-01T00:00:00Z' });
      const at = '2026-11-02T00:00:00Z';
      const event = { id: 'evt_similar_fixture', owner_id: owner, occurred_at: at,
        payload: { from_domain: 'hr.example.com', subject_excerpt: '测评邀请', body_excerpt: '邀请完成测评' } };
      const result = recordConfirmedMail(event, { company_name: '相似公司', job_title: '数据产品实习', status: 'assessment' });
      const after = one('SELECT status FROM applications WHERE id=?', [app.id]);
      console.log(JSON.stringify({ state: result.state, review: result.review?.reason_code || null, status: after?.status }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, DATA_DIR: server.dir, APP_ENV: 'test', CLOUD_LLM_ENABLED: 'false', AUTO_INTAKE_ENABLED: 'false' }
    });
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(result.state, 'applied');
    assert.equal(result.review, null);
    assert.equal(result.status, 'assessment');
  });

  it('读取模式可显式切换，切换会递增绑定版本并作废旧租约', async () => {
    const list = await server.request('/api/v1/mail-connections', { cookie });
    const id = list.json.data[0].id;
    const before = list.json.data[0];
    assert.ok('sync_stats' in before);
    const noConsent = await server.request(`/api/v1/mail-connections/${id}/mode`, {
      method: 'POST', cookie, body: { mode: 'recruitment_body' }
    });
    assert.equal(noConsent.status, 400);
    const switched = await server.request(`/api/v1/mail-connections/${id}/mode`, {
      method: 'POST', cookie, body: { mode: 'recruitment_body', consent_version: 'QQ_MAIL_READ_CONSENT_V1' }
    });
    assert.equal(switched.status, 202, switched.text);
    assert.equal(switched.json.data.mode, 'recruitment_body');
    assert.equal(switched.json.data.binding_version, before.binding_version + 1);
    const back = await server.request(`/api/v1/mail-connections/${id}/mode`, {
      method: 'POST', cookie, body: { mode: 'headers_only' }
    });
    assert.equal(back.status, 202, back.text);
    assert.equal(back.json.data.mode, 'headers_only');
  });

  it('断开后的旧同步租约不能写入邮件或提交游标', async () => {
    const script = `
      import { one, run } from './server/src/db.js';
      import { encoderForTest } from './server/src/modules/data-capture/mail/sync.js';
      import { classifyRecruitmentMail, extractMailFields } from './server/src/domain/mailParser.js';
      const connection = one("SELECT * FROM mail_connections WHERE status <> 'disconnected' ORDER BY created_at LIMIT 1");
      if (!connection) throw new Error('missing test connection');
      run("UPDATE mail_connections SET sync_lease_owner='lease-old', sync_lease_until=? WHERE id=?", [
        new Date(Date.now() + 600000).toISOString(), connection.id
      ]);
      const subject = '【租约测试】投递成功通知';
      const parsed = { uidvalidity: 'lease-uid-validity', subject, tentativeHeader: true,
        classification: classifyRecruitmentMail({ subject, fromDomain: 'hr.example.com', bodyText: '', mode: 'headers_only' }),
        fields: extractMailFields({ subject, fromAddress: 'hr@hr.example.com', bodyText: '' }) };
      const stale = await encoderForTest().ingestMessage(connection,
        { uid: 555001, messageId: '<lease-stale@example.com>' }, parsed, '', new Date().toISOString(),
        { leaseId: 'lease-other' });
      const freshConnection = one('SELECT * FROM mail_connections WHERE id=?', [connection.id]);
      const current = await encoderForTest().ingestMessage(freshConnection,
        { uid: 555002, messageId: '<lease-current@example.com>' }, parsed, '', new Date().toISOString(),
        { leaseId: 'lease-old' });
      const staleMail = one("SELECT COUNT(*) n FROM mail_messages WHERE uid='555001'").n;
      const currentMail = one("SELECT COUNT(*) n FROM mail_messages WHERE uid='555002'").n;
      console.log(JSON.stringify({ stale_aborted: stale.aborted === true, stale_mail: Number(staleMail), current_created: Boolean(current.event || current.mail), current_mail: Number(currentMail) }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, DATA_DIR: server.dir, APP_ENV: 'test', CLOUD_LLM_ENABLED: 'false', AUTO_INTAKE_ENABLED: 'false' }
    });
    assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)), {
      stale_aborted: true, stale_mail: 0, current_created: true, current_mail: 1
    });
  });

  it('重新授权 / 断开 / 断开后同步被拒；历史台账不受影响', async () => {
    const list = await server.request('/api/v1/mail-connections', { cookie });
    const id = list.json.data[0].id;
    const reauth = await server.request(`/api/v1/mail-connections/${id}/reauthorize`, {
      method: 'POST', cookie, body: { auth_code: 'ponmlkjihgfedcba', consent_version: 'QQ_MAIL_READ_CONSENT_V1' }
    });
    assert.equal(reauth.status, 202);
    await new Promise((r) => setTimeout(r, 300));
    const disconnected = await server.request(`/api/v1/mail-connections/${id}/disconnect`, { method: 'POST', cookie, body: {} });
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.json.data.status, 'disconnected');
    assert.equal(disconnected.json.data.historical_ledger_retained, true);
    const sync = await server.request(`/api/v1/mail-connections/${id}/sync`, { method: 'POST', cookie, body: {} });
    assert.equal(sync.status, 409);
    assert.equal(sync.json.error.code, 'MAIL_DISCONNECTED');
  });

  it('跨用户隔离：他人邮箱连接不可见', async () => {
    const peer = await server.login('peer@tounar.local');
    const list = await server.request('/api/v1/mail-connections', { cookie });
    const id = list.json.data[0].id;
    const cross = await server.request(`/api/v1/mail-connections/${id}`, { cookie: peer.cookie });
    assert.equal(cross.status, 404);
    const peerList = await server.request('/api/v1/mail-connections', { cookie: peer.cookie });
    assert.equal(peerList.json.data.length, 0);
  });
});

describe('多邮箱服务商路由与 IMAP 安全分类', () => {
  it('QQ/Foxmail/163/126/yeah.net 路由到对应 IMAP，不支持域名明确拒绝', () => {
    assert.equal(imapHostFor('a@qq.com'), 'imap.qq.com');
    assert.equal(imapHostFor('a@vip.qq.com'), 'imap.qq.com');
    assert.equal(imapHostFor('a@foxmail.com'), 'imap.qq.com');
    assert.equal(resolveMailProvider('a@163.com').key, 'netease_163');
    assert.equal(imapHostFor('a@163.com'), 'imap.163.com');
    assert.equal(imapHostFor('a@126.com'), 'imap.126.com');
    assert.equal(imapHostFor('a@yeah.net'), 'imap.yeah.net');
    assert.equal(resolveMailProvider('a@163.com').requiresImapId, true);
    assert.equal(imapHostFor('a@gmail.com'), null);
  });
  it('网易 Unsafe Login 归类为需重新授权，不会当成网络抖动', () => {
    const { classifyError } = encoderForTest();
    const err = Object.assign(new Error('Unsafe Login. Please contact kefu@188.com'), { serverResponseCode: 'NO' });
    const result = classifyError(err);
    assert.equal(result.status, 'reauth_required');
    assert.equal(result.code, 'IMAP_UNSAFE_LOGIN');
    assert.match(result.message, /IMAP/);
  });
});

describe('邮件解析纯函数（fixtures 单测，不访问网络）', () => {
  it('stripHtml 去标签、脚本样式与实体', () => {
    const text = stripHtml('<style>p{}</style><script>x()</script><p>你好&nbsp;&amp; 世界</p>');
    assert.equal(text, '你好 & 世界');
  });

  it('招聘邮件头识别：关键词/域名命中，促销邮件被排除', () => {
    assert.equal(isRecruitmentHeader('面试邀请函', 'qq.com', ''), true);
    assert.equal(isRecruitmentHeader('你好', 'jobs.example.com', ''), true);
    assert.equal(isRecruitmentHeader('本周热卖，优惠券', 'shop.example.com', ''), false);
    assert.equal(isRecruitmentHeader('【某某】本周促销优惠券', 'shop.example.com', ''), false);
  });

  it('分类：面试/笔试/Offer/拒绝/关闭与轮次、时间抽取', () => {
    const interview = classifyRecruitmentMail({ subject: '面试邀请：后端实习生（二面）', fromDomain: 'jobs.example.com', bodyText: '', mode: 'headers_only' });
    assert.equal(interview.category, 'interview');
    assert.equal(interview.status, 'interview');
    assert.equal(interview.round_label, '二面');
    assert.ok(interview.confidence >= 0.8);
    const assessment = classifyRecruitmentMail({ subject: '在线测评通知', fromDomain: 'hr.example.com', mode: 'headers_only' });
    assert.equal(assessment.status, 'assessment');
    const offer = classifyRecruitmentMail({ subject: '录用意向书 Offer', fromDomain: 'hr.example.com', mode: 'headers_only' });
    assert.equal(offer.status, 'offer');
    const rejected = classifyRecruitmentMail({ subject: '很遗憾，本次未通过', fromDomain: 'jobs.example.com', mode: 'headers_only' });
    assert.equal(rejected.status, 'rejected');
    assert.ok(rejected.confidence >= 0.9);
    const closed = classifyRecruitmentMail({ subject: '岗位关闭通知', fromDomain: 'jobs.example.com', mode: 'headers_only' });
    assert.equal(closed.status, 'closed');
    const irrelevant = classifyRecruitmentMail({ subject: '发票已开具', fromDomain: 'shop.example.com', mode: 'headers_only' });
    assert.equal(irrelevant.relevant, false);
    const scheduled = classifyRecruitmentMail({ subject: '面试通知 2026-11-03 14:30', fromDomain: 'jobs.example.com', mode: 'headers_only' });
    assert.ok(scheduled.interview_scheduled_at);
    // 明确的投递成功回执：必须映射到 applied，而不是 other
    const receipt = classifyRecruitmentMail({ subject: '【测试科技】投递成功通知', fromDomain: 'hr.example.com',
      bodyText: '您的软件工程师岗位申请已成功提交，我们已收到您的简历。', mode: 'recruitment_body' });
    assert.equal(receipt.category, 'applied');
    assert.equal(receipt.status, 'applied');
    assert.ok(receipt.confidence >= 0.9);
    // 真实数据里抓到的假阴性：「感谢您的应聘」被当成 other 丢弃。
    // 现在按拒信处理，但置信度封顶 0.88（低于自动终态 0.9），必须进待确认。
    const thankYou = classifyRecruitmentMail({ subject: '合合信息感谢您的应聘', fromDomain: 'shmail.ibeisen.com', mode: 'headers_only' });
    assert.equal(thankYou.category, 'rejected');
    assert.equal(thankYou.status, 'rejected');
    assert.ok(thankYou.confidence < 0.9, `必须低于自动终态阈值，实际 ${thankYou.confidence}`);
    // 收到简历回执里带面试安排时，不能被误判成拒信
    const ack = classifyRecruitmentMail({ subject: '感谢您的应聘，我们已收到简历，将尽快安排面试', fromDomain: 'hr.example.com', mode: 'headers_only' });
    assert.notEqual(ack.category, 'rejected');
    // 明确写「未通过」的拒信仍保持高置信度（允许自动终态）
    const explicit = classifyRecruitmentMail({ subject: '感谢您的投递，很遗憾您未通过本次筛选', fromDomain: 'hr.example.com', mode: 'headers_only' });
    assert.equal(explicit.category, 'rejected');
    assert.ok(explicit.confidence >= 0.9);
  });

  it('字段抽取：正文优先，主题兜底，申请号与域名', () => {
    const fromBody = extractMailFields({
      subject: '面试通知', fromAddress: 'hr@jobs.example.com',
      bodyText: '公司：星河科技\n岗位：后端实习生\n申请编号：APP-7788'
    });
    assert.equal(fromBody.company_name, '星河科技');
    assert.equal(fromBody.job_title, '后端实习生');
    assert.equal(fromBody.site_application_id, 'APP-7788');
    assert.equal(fromBody.from_domain, 'jobs.example.com');
    const fromSubject = extractMailFields({ subject: '【银河网络】前端开发实习生 面试邀请', fromAddress: 'campus@hr.example.com', bodyText: '' });
    assert.equal(fromSubject.company_name, '银河网络');
    assert.ok(fromSubject.job_title.includes('前端开发实习生'), fromSubject.job_title);
  });

  it('ImapFlow 结构化鉴权/网络错误必须准确分类', () => {
    const { classifyError } = encoderForTest();
    const auth = Object.assign(new Error('Command failed'), {
      authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'AUTHENTICATIONFAILED'
    });
    assert.equal(classifyError(auth).code, 'IMAP_AUTH_FAILED');
    const network = Object.assign(new Error('Command failed'), { code: 'ECONNREFUSED' });
    assert.equal(classifyError(network).code, 'IMAP_NETWORK_ERROR');
    assert.equal(classifyError(new TypeError('unexpected')).code, 'IMAP_SYNC_FAILED');
  });

  it('单段邮件无 part 编号时按 TEXT 读取，空正文必须报错而不是静默吞掉', async () => {
    const { downloadPart } = encoderForTest();
    const seen = [];
    const client = {
      download: async (uid, part) => {
        seen.push(part);
        return { content: Readable.from([Buffer.from('单段正文')]) };
      }
    };
    const text = await downloadPart(client, 7, { type: 'text/plain' });
    assert.equal(text, '单段正文');
    assert.deepEqual(seen, ['1']);
    const empty = { download: async () => ({ content: Readable.from([]) }) };
    await assert.rejects(() => downloadPart(empty, 7, { type: 'text/html' }), /正文/);
  });

  it('HTML 正文保留换行；公共邮箱域名、占位词和状态词不会变成公司/岗位', () => {
    const html = stripHtml('<p>公司：星河科技</p><p>岗位：后端实习生</p><div>邀请您参加测评</div>', true);
    assert.match(html, /公司：星河科技/);
    assert.match(html, /岗位：后端实习生/);
    const fields = extractMailFields({
      subject: '【通知】测评邀请', fromAddress: 'hr@qq.com',
      bodyText: '公司：qq.com\n岗位：测评邀请\n公司：星河科技\n岗位：后端实习生'
    });
    assert.equal(fields.company_name, '星河科技');
    assert.equal(fields.job_title, '后端实习生');
    const missing = extractMailFields({
      subject: '【招聘】测评邀请', fromAddress: 'hr@163.com',
      bodyText: '公司：163.com\n岗位：待补充'
    });
    assert.equal(missing.company_name, null);
    assert.equal(missing.job_title, null);
  });

  it('S1/S2/S4：页脚免责声明不误杀，中文自然语言岗位与公司级无岗位名可提取', () => {
    const body = '您好，感谢您应聘网易「游戏策划」岗位，请于11月25日前完成测评。如您已取消应聘请忽略。\\n招聘流程：网申→测评→面试';
    const s1 = confirmedMailProgress('【网易】2027届校招在线测评通知', body, {
      fromName: '网易校园招聘', fromDomain: 'service.netease.com'
    });
    assert.equal(s1.company_name, '网易');
    assert.equal(s1.job_title, '游戏策划');
    assert.equal(s1.status, 'assessment');
    assert.equal(s1.recruitment_batch, '2027届校招');
    const s2 = confirmedMailProgress('【网易】2027届校招线上测评通知', '请于 11 月 25 日前完成综合素质测评', {
      fromName: '网易校园招聘', fromDomain: 'service.netease.com'
    });
    assert.equal(s2.company_name, '网易');
    assert.equal(s2.job_title, null);
    assert.equal(s2.company_only_progress, true);
    const s4 = confirmedMailProgress('【网易】产品经理在线测评通知', '请于 11 月 25 日前完成测评', {
      fromName: '网易招聘', fromDomain: 'service.netease.com'
    });
    assert.equal(s4.job_title, '产品经理');
    assert.equal(s4.company_only_progress, undefined);
  });

  it('离线强规则只接受明确个人进展，忽略转发/流程/条件句；面试改期提示“时间不合适”不误判为拒信', () => {
    assert.equal(confirmedMailProgress('【星河科技】后端实习生 面试邀请', '公司：星河科技\n岗位：后端实习生\n邀请您参加面试。如该时间不合适，请联系HR改期。')?.status, 'interview');
    assert.equal(confirmedMailProgress('【星河科技】后端实习生 测评邀请', '公司：星河科技\n岗位：后端实习生\n请于 11 月 30 日前完成在线测评。')?.status, 'assessment');
    assert.equal(confirmedMailProgress('Re: 【星河科技】后端实习生 测评邀请', '公司：星河科技\n岗位：后端实习生\n邀请您参加测评。'), null);
    assert.equal(confirmedMailProgress('招聘流程介绍', '这是流程介绍，不代表您已通过。'), null);
    assert.equal(confirmedMailProgress('【星河科技】后端实习生 测评邀请', '公司：星河科技\n岗位：后端实习生\n如果您通过筛选，将邀请您参加测评。'), null);
  });

  it('终态邮件命中已有申请时不抛出 MAIL_STAGE_CONFLICT 中断同步', async () => {
    const script = `
      import { one, run } from './server/src/db.js';
      import { nowIso } from './server/src/util.js';
      import { createApplication, recordConfirmedMail } from './server/src/domain/applications.js';
      const owner = one('SELECT id FROM users ORDER BY created_at LIMIT 1')?.id || 'u_terminal_test';
      const app = createApplication({ ownerId: owner, sourceMethod: 'manual', status: 'applied',
        fields: { company_name: '终态保护公司', job_title: '测试工程师', applied_at: '2026-10-01T00:00:00Z', applied_at_precision: 'date' },
        at: '2026-10-01T00:00:00Z' });
      const event = { id: 'evt_terminal_no_crash', owner_id: owner, source_method: 'mail', occurred_at: '2026-11-05T00:00:00Z',
        payload: { from_domain: 'hr.example.com', subject_excerpt: '【终态保护公司】很遗憾未通过', body_excerpt: '很遗憾您未通过本次筛选' } };
      run("INSERT INTO events (id, owner_id, client_event_id, source_method, event_type, occurred_at, observed_at, received_at, schema_version, evidence_level, payload_json, payload_hash, processing_state) VALUES (?, ?, 'mail:term-no-crash', 'mail', 'mail_progress_detected', ?, ?, ?, 'C1', 'strong', ?, 'h-term', 'pending')",
        [event.id, owner, event.occurred_at, nowIso(), nowIso(), JSON.stringify(event.payload)]);
      const res = recordConfirmedMail(event, { company_name: '终态保护公司', job_title: '测试工程师', status: 'rejected' });
      const after = one('SELECT status FROM applications WHERE id=?', [app.id]);
      console.log(JSON.stringify({ state: res.state, status: after?.status, has_review: Boolean(res.review) }));
    `;
    const srv = await startTestServer({ name: 'mail-terminal-no-crash' });
    try {
      await srv.login('demo@tounar.local');
      const { stdout: outAuto } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: { ...process.env, DATA_DIR: srv.dir, APP_ENV: 'test', AUTO_TERMINAL_FROM_MAIL: 'true', AUTO_INTAKE_ENABLED: 'false' }
      });
      const autoRes = JSON.parse(outAuto.trim().split('\n').at(-1));
      assert.equal(autoRes.state, 'applied');
      assert.equal(autoRes.status, 'rejected');

      const srv2 = await startTestServer({ name: 'mail-terminal-review' });
      try {
        await srv2.login('demo@tounar.local');
        const { stdout: outReview } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
          cwd: fileURLToPath(new URL('../..', import.meta.url)),
          env: { ...process.env, DATA_DIR: srv2.dir, APP_ENV: 'test', AUTO_TERMINAL_FROM_MAIL: 'false', AUTO_INTAKE_ENABLED: 'false' }
        });
        const revRes = JSON.parse(outReview.trim().split('\n').at(-1));
        assert.equal(revRes.state, 'pending');
        assert.equal(revRes.has_review, true);
        assert.equal(revRes.status, 'applied');
      } finally { await srv2.stop(); }
    } finally { await srv.stop(); }
  });

  it('证据留存：headers_only 不保留正文，recruitment_body 只留摘要', () => {
    const headersOnly = publicEvidence({ subject: '面试通知', bodyText: '<p>正文内容</p>', mode: 'headers_only' });
    assert.equal(headersOnly.body_retained, false);
    assert.equal(headersOnly.body_excerpt, null);
    const bodyMode = publicEvidence({ subject: '面试通知', bodyText: '<p>正文内容</p>', mode: 'recruitment_body' });
    assert.equal(bodyMode.body_retained, false);
    assert.match(bodyMode.body_excerpt, /正文内容/);
  });
});
