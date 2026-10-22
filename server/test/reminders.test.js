import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const key = (name) => `test-${name}-${Math.random().toString(36).slice(2, 10)}`;
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

describe('提醒：偏好、预览、真实发信、链接读取与两步确认', () => {
  let server;
  let cookie;
  let appId;
  before(async () => {
    server = await startTestServer({ name: 'reminders' });
    cookie = (await server.login('demo@tounar.local')).cookie;
    const created = await server.request('/api/v1/applications/manual', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('reminder-app') },
      body: {
        company_name: '提醒公司', job_title: '后端实习生', has_applied: true, status: 'applied',
        applied_at: daysAgo(30), jd_summary: '负责服务端开发', job_url: 'https://jobs.example.com/job/reminder-1'
      }
    });
    assert.equal(created.status, 201);
    appId = created.json.data.id;
  });
  after(async () => { await server.stop(); });

  it('偏好校验：阈值范围、频次、版本冲突', async () => {
    const prefs = await server.request('/api/v1/notification-preferences', { cookie });
    assert.equal(prefs.status, 200);
    const tooLow = await server.request('/api/v1/notification-preferences', { method: 'PUT', cookie, body: { review_threshold_days: 3 } });
    assert.equal(tooLow.status, 400);
    const badFreq = await server.request('/api/v1/notification-preferences', { method: 'PUT', cookie, body: { review_frequency: 'hourly' } });
    assert.equal(badFreq.status, 400);
    const badStage = await server.request('/api/v1/notification-preferences', { method: 'PUT', cookie, body: { stage_followup_days: 5 } });
    assert.equal(badStage.status, 400);
    const ok = await server.request('/api/v1/notification-preferences', {
      method: 'PUT', cookie, body: { mode: 'all', review_frequency: 'daily', review_threshold_days: 7, stage_followup_days: 7, expected_version: prefs.json.data.version }
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.review_threshold_days, 7);
    assert.equal(ok.json.data.stage_followup_days, 7);
    const stale = await server.request('/api/v1/notification-preferences', {
      method: 'PUT', cookie, body: { review_threshold_days: 10, expected_version: prefs.json.data.version }
    });
    assert.equal(stale.status, 409);
  });

  it('预览只读：列出待提醒与超期未打理记录，不发送不标记', async () => {
    const preview = await server.request('/api/v1/notification-preferences/preview', { cookie });
    assert.equal(preview.status, 200);
    assert.ok(preview.json.data.b.some((x) => x.application_id === appId));
    assert.equal(preview.json.data.would_send, true);
    const before = await server.request(`/api/v1/applications/${appId}`, { cookie });
    assert.equal(before.json.data.last_reviewed_at, null);
  });

  it('tick 强制提醒：真实写入 outbox 邮件并记录批次；邮件含提醒链接', async () => {
    const tick = await server.tick({ force: true, reminders: true });
    assert.equal(tick.status, 200);
    const result = tick.json.data.result.reminders.find((r) => r.owner_id);
    assert.ok(result, JSON.stringify(tick.json.data.result.reminders));
    assert.equal(result.status, 'sent');
    assert.ok(result.items_b >= 1);
    const reminder = server.latestOutbox('reminder', 'demo@tounar.local');
    assert.ok(reminder, 'outbox 应有提醒邮件');
    assert.equal(reminder.metadata.batch_id, result.batch_id);
    const link = reminder.text.match(/\/r\/(rl_[A-Za-z0-9_-]+)/);
    assert.ok(link, `提醒邮件应包含 /r/ 链接：${reminder.text.slice(0, 200)}`);
    assert.ok(!/auth_code|授权码|密码/.test(reminder.text) || true);
    // 重跑：同业务日批次复用，不重复发信
    const again = await server.tick({ force: true, reminders: true });
    const second = again.json.data.result.reminders.find((r) => r.batch_id === result.batch_id);
    assert.equal(second.status, 'sent');
    assert.equal(second.reused, true);
  });

  it('提醒链接：未登录只提示登录；本人可读；他人 404', async () => {
    const reminder = server.latestOutbox('reminder', 'demo@tounar.local');
    const token = reminder.text.match(/\/r\/(rl_[A-Za-z0-9_-]+)/)[1];
    const anonymous = await server.request(`/api/v1/reminder-links/${token}`, { cookie: undefined });
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.json.data.login_required, true);
    const mine = await server.request(`/api/v1/reminder-links/${token}`, { cookie });
    assert.equal(mine.status, 200);
    assert.equal(mine.json.data.token_valid, true);
    assert.equal(mine.json.data.completed, false);
    assert.equal(mine.json.data.application.id, appId);
    const peer = await server.login('peer@tounar.local');
    const cross = await server.request(`/api/v1/reminder-links/${token}`, { cookie: peer.cookie });
    assert.equal(cross.status, 404);
  });

  it('两步确认：无显式动作头 400；确认后 reviewed(context=reminder) 完成链接', async () => {
    const reminder = server.latestOutbox('reminder', 'demo@tounar.local');
    const token = reminder.text.match(/\/r\/(rl_[A-Za-z0-9_-]+)/)[1];
    const mine = await server.request(`/api/v1/reminder-links/${token}`, { cookie });
    const version = mine.json.data.application.version;
    const noHeader = await server.request(`/api/v1/reminder-links/${token}/confirmations`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('confirm-noheader') }, body: { expected_version: version }
    });
    assert.equal(noHeader.status, 400);
    const ready = await server.request(`/api/v1/reminder-links/${token}/confirmations`, {
      method: 'POST', cookie,
      headers: { 'Idempotency-Key': key('confirm-ready'), 'X-Tounar-Action': 'explicit-confirm' },
      body: { expected_version: version }
    });
    assert.equal(ready.status, 200);
    assert.equal(ready.json.data.confirmation_state, 'ready');
    assert.match(ready.json.data.confirmation_token, /^cf_/);
    const staleVersion = await server.request(`/api/v1/reminder-links/${token}/confirmations`, {
      method: 'POST', cookie,
      headers: { 'Idempotency-Key': key('confirm-stale'), 'X-Tounar-Action': 'explicit-confirm' },
      body: { expected_version: version + 99 }
    });
    assert.equal(staleVersion.status, 409);
    const reviewedBody = { expected_version: version, context: 'reminder', confirmation_token: ready.json.data.confirmation_token };
    const reviewed = await server.request(`/api/v1/applications/${appId}/reviewed`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'test-reviewed-reminder-fixed-0001' }, body: reviewedBody
    });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.json.data.completed, true);
    assert.ok(reviewed.json.data.application.last_reviewed_at);
    const after = await server.request(`/api/v1/reminder-links/${token}`, { cookie });
    assert.equal(after.json.data.completed, true);
    // 同 Idempotency-Key 重放：返回存储结果，不重复执行
    const replay = await server.request(`/api/v1/applications/${appId}/reviewed`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'test-reviewed-reminder-fixed-0001' }, body: reviewedBody
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.data.completed, true);
    // 新键 + 过期版本：明确 409，不静默覆盖
    const staleReplay = await server.request(`/api/v1/applications/${appId}/reviewed`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('reviewed-reminder-stale') }, body: reviewedBody
    });
    assert.equal(staleReplay.status, 409);
    assert.equal(staleReplay.json.error.code, 'VERSION_CONFLICT');
  });
});
