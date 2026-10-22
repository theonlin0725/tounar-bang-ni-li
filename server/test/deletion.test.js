import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const key = (name) => `test-${name}-${Math.random().toString(36).slice(2, 10)}`;

describe('数据删除：写阻断、设备回执、完成后匿名化（A1-05、G03）', () => {
  let server;
  let cookie;
  let device;
  let appId;
  before(async () => {
    server = await startTestServer({ name: 'deletion' });
    cookie = (await server.login('demo@tounar.local')).cookie;
    device = await server.pairDevice(cookie, 'Deletion Chrome');
    const created = await server.request('/api/v1/applications/manual', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('deletion-app') },
      body: {
        company_name: '删除前公司', job_title: '运营专员', has_applied: true, status: 'applied',
        applied_at: '2026-09-01T04:00:00.000Z', jd_summary: '运营执行',
        job_url: 'https://jobs.example.com/job/delete-1'
      }
    });
    assert.equal(created.status, 201);
    appId = created.json.data.id;
  });
  after(async () => { await server.stop(); });

  it('删除请求必须确认语 + 不可恢复确认 + 近期重鉴权', async () => {
    const wrongPhrase = await server.request('/api/v1/data-deletions', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('del-wrong') },
      body: { confirmation: '删除', acknowledge_irreversible: true }
    });
    assert.equal(wrongPhrase.status, 400);
    const noAck = await server.request('/api/v1/data-deletions', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('del-noack') },
      body: { confirmation: '删除全部数据' }
    });
    assert.equal(noAck.status, 400);
  });

  it('完整流程：请求 → 写阻断 → 设备回执 → 完成 → 匿名化', async () => {
    const reauth = await server.reauth(cookie, 'demo@tounar.local');
    assert.equal(reauth.status, 200);
    const request = await server.request('/api/v1/data-deletions', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'test-deletion-fixed-0001' },
      body: { confirmation: '删除全部数据', acknowledge_irreversible: true }
    });
    assert.equal(request.status, 202);
    const jobId = request.json.data.id;
    assert.ok(jobId);

    // 等待后台任务把状态推进到 awaiting_device_ack
    let job = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const status = await server.request(`/api/v1/data-deletions/${jobId}`, { cookie });
      job = status.json.data;
      if (job.status === 'awaiting_device_ack' || job.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(job.status, 'awaiting_device_ack', JSON.stringify(job));
    assert.equal(job.progress.devices, 'awaiting_device_ack');
    assert.equal(job.progress.business_records, 'deleted');

    // 写阻断：会话读业务 403；设备上传事件 403
    const me = await server.request('/api/v1/me', { cookie });
    assert.equal(me.status, 403);
    assert.equal(me.json.error.code, 'DELETION_IN_PROGRESS');
    const app = await server.request(`/api/v1/applications/${appId}`, { cookie });
    assert.equal(app.status, 403);
    const upload = await server.eventBatch(device.device_token, [{
      client_event_id: 'evt_after_deletion', event_type: 'job_viewed', source_method: 'plugin',
      site_key: 'generic', adapter_version: '1.0.0', schema_version: 'C1',
      occurred_at: '2026-10-20T02:00:00.000Z', observed_at: '2026-10-20T02:00:04.000Z',
      evidence_level: 'strong', evidence_code: 'visible-dwell-3000ms',
      payload: { company_name: '不该入库', job_title: '不该入库', site_job_id: 'x', job_url: 'https://jobs.example.com/job/x' }
    }]);
    assert.equal(upload.status, 403);
    assert.equal(upload.json.error.code, 'DELETION_IN_PROGRESS');

    // 最小清理回执通道仍可用：self 读到新 binding_version 与撤销标记
    const self = await server.request('/api/v1/plugin-devices/self', { token: device.device_token });
    assert.equal(self.status, 200);
    assert.equal(self.json.data.server_revoked, true);
    assert.equal(self.json.data.cleanup_required, true);
    const acked = await server.request('/api/v1/plugin-devices/cleanup-ack', {
      method: 'POST', token: device.device_token,
      body: { binding_version: self.json.data.device.binding_version }
    });
    assert.equal(acked.status, 200);
    assert.equal(acked.json.data.acknowledged, true);
    assert.equal(acked.json.data.deletion_job.status, 'completed');

    const finalJob = await server.request(`/api/v1/data-deletions/${jobId}`, { cookie });
    assert.equal(finalJob.json.data.status, 'completed');
    assert.equal(finalJob.json.data.progress.devices, 'acknowledged');
    assert.ok(finalJob.json.data.completed_at);

    // 原账号数据不可再访问；同邮箱重新登录是全新空账号（本地 OTP 替代实现的现状）
    const fresh = await server.login('demo@tounar.local');
    assert.ok(fresh.cookie);
    const freshLedger = await server.request('/api/v1/ledger?view=applied', { cookie: fresh.cookie });
    assert.equal(freshLedger.json.data.stats.total_applied, 0);
    const oldApp = await server.request(`/api/v1/applications/${appId}`, { cookie: fresh.cookie });
    assert.equal(oldApp.status, 404);
  });
});
