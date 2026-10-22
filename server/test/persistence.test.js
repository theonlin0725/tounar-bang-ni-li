import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, freePort, strongViewEvent } from './helpers.js';

describe('持久化：重启后台账、会话、设备与幂等记录保持（PERSIST 门禁）', () => {
  const name = 'persistence';
  let current = null;
  after(async () => { if (current) await current.stop(); });

  it('同一 DATA_DIR 重启：同一记录、同一统计、同一 cookie、事件仍幂等', async () => {
    const port = await freePort();
    let server = await startTestServer({ name, wipe: true, port });
    current = server;
    const cookie = (await server.login('demo@tounar.local')).cookie;
    const device = await server.pairDevice(cookie, 'Persist Chrome');

    const created = await server.request('/api/v1/applications/manual', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'test-persist-fixed-0001' },
      body: {
        company_name: '持久化公司', job_title: '前端实习生', has_applied: true, status: 'applied',
        applied_at: '2026-09-15T04:00:00.000Z', jd_summary: '前端开发',
        job_url: 'https://jobs.example.com/job/persist-1'
      }
    });
    assert.equal(created.status, 201);
    const appId = created.json.data.id;
    const viewEvent = strongViewEvent({
      client_event_id: 'evt_persist_view_1',
      payload: { company_name: '浏览留念公司', job_title: '数据实习生', site_job_id: 'persist-view-1', job_url: 'https://jobs.example.com/job/persist-view-1', jd_summary: '数据分析' }
    });
    const firstView = await server.eventBatch(device.device_token, [viewEvent]);
    assert.equal(firstView.json.results[0].accepted, true);
    const before = await server.request('/api/v1/ledger?view=applied', { cookie });
    const beforeViewed = await server.request('/api/v1/ledger?view=viewed', { cookie });
    assert.equal(before.json.data.stats.total_applied, 1);
    assert.equal(beforeViewed.json.data.filtered_total, 1);

    await server.stop();
    current = null;

    server = await startTestServer({ name, wipe: false, port });
    current = server;
    const me = await server.request('/api/v1/me', { cookie });
    assert.equal(me.status, 200, '重启后原会话 cookie 仍有效');
    const detail = await server.request(`/api/v1/applications/${appId}`, { cookie });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.data.company_name, '持久化公司');
    const after = await server.request('/api/v1/ledger?view=applied', { cookie });
    assert.equal(after.json.data.stats.total_applied, 1);
    const afterViewed = await server.request('/api/v1/ledger?view=viewed', { cookie });
    assert.equal(afterViewed.json.data.filtered_total, beforeViewed.json.data.filtered_total);

    const replayed = await server.eventBatch(device.device_token, [viewEvent]);
    assert.equal(replayed.json.results[0].duplicate, true, '重启后同一 client_event_id 仍幂等');
    const self = await server.request('/api/v1/plugin-devices/self', { token: device.device_token });
    assert.equal(self.status, 200, '设备凭证跨重启有效');
    const tick = await server.tick({ force: false });
    assert.equal(tick.status, 200);
  });
});
