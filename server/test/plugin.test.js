import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, strongViewEvent } from './helpers.js';

describe('plugin 配对 / 撤销 / 清理回执（DATA-5.1、G03 本地协议）', () => {
  let server;
  let cookie;
  before(async () => {
    server = await startTestServer({ name: 'plugin' });
    cookie = (await server.login('demo@tounar.local')).cookie;
  });
  after(async () => { await server.stop(); });

  it('配对码格式与生命周期：未批准不能兑换', async () => {
    const created = await server.request('/api/v1/plugin-pairings', { method: 'POST', body: { device_name: 'Chrome A' } });
    assert.equal(created.status, 201);
    const pair = created.json.data;
    assert.match(pair.code, /^[A-Z2-9]{8}$/);
    assert.match(pair.request_secret, /^pairsec_/);
    const early = await server.request('/api/v1/plugin-pairings/exchange', {
      method: 'POST', body: { request_id: pair.request_id, request_secret: pair.request_secret }
    });
    assert.equal(early.status, 403);
    assert.equal(early.json.error.code, 'PAIRING_NOT_APPROVED');
  });

  it('错误配对码被拒绝，正确码批准后可兑换一次', async () => {
    const created = await server.request('/api/v1/plugin-pairings', { method: 'POST', body: { device_name: 'Chrome B' } });
    const pair = created.json.data;
    const wrong = await server.request('/api/v1/plugin-pairings/approve', { method: 'POST', cookie, body: { code: 'ZZZZZZZZ' } });
    assert.equal(wrong.status, 404);
    const approved = await server.request('/api/v1/plugin-pairings/approve', { method: 'POST', cookie, body: { code: pair.code } });
    assert.equal(approved.status, 200);
    const exchanged = await server.request('/api/v1/plugin-pairings/exchange', {
      method: 'POST', body: { request_id: pair.request_id, request_secret: pair.request_secret }
    });
    assert.equal(exchanged.status, 200);
    assert.match(exchanged.json.data.device_token, /^dev_/);
    const again = await server.request('/api/v1/plugin-pairings/exchange', {
      method: 'POST', body: { request_id: pair.request_id, request_secret: pair.request_secret }
    });
    assert.equal(again.status, 409);
  });

  it('设备心跳、自助状态、事件写入与 last_event_at', async () => {
    const device = await server.pairDevice(cookie, 'Chrome C');
    const beat = await server.request('/api/v1/plugin-devices/heartbeat', { method: 'POST', token: device.device_token, body: {} });
    assert.equal(beat.status, 200);
    const event = strongViewEvent({ payload: { company_name: '心跳公司', job_title: '测试岗', site_job_id: 'job-heartbeat', job_url: 'https://jobs.example.com/job/heartbeat' } });
    const batch = await server.eventBatch(device.device_token, [event]);
    assert.equal(batch.status, 200);
    assert.equal(batch.json.results[0].accepted, true);
    const self = await server.request('/api/v1/plugin-devices/self', { token: device.device_token });
    assert.equal(self.status, 200);
    assert.equal(self.json.data.server_revoked, false);
    assert.ok(self.json.data.device.last_heartbeat_at);
    assert.ok(self.json.data.device.last_event_at);
    const list = await server.request('/api/v1/plugin-devices', { cookie });
    assert.ok(list.json.data.some((d) => d.id === device.device_id));
  });

  it('用户撤销设备：立即拒收事件，但保留最小清理回执通道', async () => {
    const device = await server.pairDevice(cookie, 'Chrome D');
    const revoked = await server.request(`/api/v1/plugin-devices/${device.device_id}/revoke`, { method: 'POST', cookie });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.json.data.device_cleanup_state, 'unknown');
    const rejected = await server.eventBatch(device.device_token, [strongViewEvent({ payload: { company_name: '撤销公司', job_title: '不该入库', site_job_id: 'job-revoked', job_url: 'https://jobs.example.com/job/revoked' } })]);
    assert.equal(rejected.status, 403);
    assert.equal(rejected.json.error.code, 'DEVICE_REVOKED');
    const self = await server.request('/api/v1/plugin-devices/self', { token: device.device_token });
    assert.equal(self.status, 200);
    assert.equal(self.json.data.server_revoked, true);
    assert.equal(self.json.data.cleanup_required, true);
    const badAck = await server.request('/api/v1/plugin-devices/cleanup-ack', {
      method: 'POST', token: device.device_token, body: { binding_version: 99 }
    });
    assert.equal(badAck.status, 409);
    const ack = await server.request('/api/v1/plugin-devices/cleanup-ack', {
      method: 'POST', token: device.device_token, body: { binding_version: revoked.json.data.binding_version }
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.json.data.acknowledged, true);
  });

  it('设备 token 无效 / 拉黑后不可创建新事件', async () => {
    const bad = await server.eventBatch('dev_invalid_token_xxx', [strongViewEvent()]);
    assert.equal(bad.status, 401);
    const noToken = await server.request('/api/v1/events/batch', { method: 'POST', body: { schema_version: 'C1', events: [strongViewEvent()] } });
    assert.equal(noToken.status, 401);
  });

  it('跨用户不能撤销他人设备', async () => {
    const device = await server.pairDevice(cookie, 'Chrome E');
    const peer = await server.login('peer@tounar.local');
    const res = await server.request(`/api/v1/plugin-devices/${device.device_id}/revoke`, { method: 'POST', cookie: peer.cookie });
    assert.equal(res.status, 404);
  });
});

describe('plugin 配对过期', () => {
  let server;
  before(async () => { server = await startTestServer({ name: 'plugin-expiry', env: { PAIRING_TTL_MINUTES: '0' } }); });
  after(async () => { await server.stop(); });

  it('过期配对码不能批准', async () => {
    const cookie = (await server.login('demo@tounar.local')).cookie;
    const created = await server.request('/api/v1/plugin-pairings', { method: 'POST', body: { device_name: 'Chrome F' } });
    await new Promise((r) => setTimeout(r, 20));
    const res = await server.request('/api/v1/plugin-pairings/approve', { method: 'POST', cookie, body: { code: created.json.data.code } });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'PAIRING_EXPIRED');
  });
});
