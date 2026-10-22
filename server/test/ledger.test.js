import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, strongViewEvent } from './helpers.js';

const key = (name) => `test-${name}-${Math.random().toString(36).slice(2, 10)}`;

describe('ledger / 台账、手动补录、纠错、归档、已查看', () => {
  let server;
  let cookie;
  let token;
  before(async () => {
    server = await startTestServer({ name: 'ledger' });
    cookie = (await server.login('demo@tounar.local')).cookie;
    token = (await server.pairDevice(cookie, 'Ledger Chrome')).device_token;
  });
  after(async () => { await server.stop(); });

  it('手动补录：D12 缺字段拒绝，完整字段创建成功', async () => {
    const missing = (body) => server.request('/api/v1/applications/manual', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('manual-missing') }, body
    });
    const noJd = await missing({ company_name: '甲乙科技', job_title: '测试工程师', has_applied: true, applied_at: '2026-09-20T04:00:00.000Z', job_url: 'https://jobs.example.com/job/manual-1' });
    assert.equal(noJd.status, 422);
    assert.equal(noJd.json.error.code, 'D12_NOT_FROZEN');
    const noUrl = await missing({ company_name: '甲乙科技', job_title: '测试工程师', has_applied: true, applied_at: '2026-09-20T04:00:00.000Z', jd_summary: '负责测试' });
    assert.equal(noUrl.status, 422);
    const noAppliedAt = await missing({ company_name: '甲乙科技', job_title: '测试工程师', has_applied: true, jd_summary: '负责测试', job_url: 'https://jobs.example.com/job/manual-1' });
    assert.equal(noAppliedAt.status, 422);
    const badStatus = await missing({ company_name: '甲乙科技', job_title: '测试工程师', has_applied: false, status: 'interview', jd_summary: '负责测试', job_url: 'https://jobs.example.com/job/manual-1' });
    assert.equal(badStatus.status, 400);

    const ok = await server.request('/api/v1/applications/manual', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'test-manual-ok-fixed-key-0001' },
      body: {
        company_name: '甲乙科技', job_title: '测试工程师', has_applied: true, status: 'applied',
        applied_at: '2026-09-20T04:00:00.000Z', applied_at_precision: 'date',
        jd_summary: '负责自动化测试与质量保障', job_url: 'https://jobs.example.com/job/manual-1?utm_medium=share',
        location: '上海', channel: '手动'
      }
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.data.status, 'applied');
    assert.equal(ok.json.data.applied_at, '2026-09-20T04:00:00.000Z');
    assert.ok(ok.json.data.history.length >= 1);
    assert.equal(ok.json.data.history.at(-1).to_status, 'applied');

    // 幂等重放：同 key + 同内容返回同一条；同 key 不同内容 409
    const replay = await server.request('/api/v1/applications/manual', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'test-manual-ok-fixed-key-0001' },
      body: {
        company_name: '甲乙科技', job_title: '测试工程师', has_applied: true, status: 'applied',
        applied_at: '2026-09-20T04:00:00.000Z', applied_at_precision: 'date',
        jd_summary: '负责自动化测试与质量保障', job_url: 'https://jobs.example.com/job/manual-1?utm_medium=share',
        location: '上海', channel: '手动'
      }
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.json.data.id, ok.json.data.id);
    const conflict = await server.request('/api/v1/applications/manual', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'test-manual-ok-fixed-key-0001' },
      body: { company_name: '别的公司', job_title: '别的岗位', has_applied: false, jd_summary: 'x', job_url: 'https://jobs.example.com/job/manual-2' }
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('重复检测：相同安全链接的手动补录被拒绝', async () => {
    const res = await server.request('/api/v1/applications/manual', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('dup-manual') },
      body: { company_name: '甲乙科技', job_title: '测试工程师（重复）', has_applied: false, jd_summary: 'x', job_url: 'https://jobs.example.com/job/manual-1' }
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'VERSION_CONFLICT');
  });

  it('浏览事件生成"看过没投"；统计只计已投', async () => {
    const res = await server.eventBatch(token, [strongViewEvent({
      client_event_id: 'evt_ledger_view_1',
      payload: { company_name: '看过公司', job_title: '运营实习生', site_job_id: 'ledger-view-1', job_url: 'https://jobs.example.com/job/ledger-view-1', jd_summary: '运营支持' }
    })]);
    assert.equal(res.json.results[0].processing_state, 'applied');

    const viewed = await server.request('/api/v1/ledger?view=viewed', { cookie });
    assert.ok(viewed.json.data.items.some((a) => a.company_name === '看过公司'));
    assert.equal(viewed.json.data.items.find((a) => a.company_name === '看过公司').has_applied, 0);
    assert.ok(viewed.json.data.counts.viewed >= 1);

    const applied = await server.request('/api/v1/ledger?view=applied', { cookie });
    assert.ok(!applied.json.data.items.some((a) => a.company_name === '看过公司'));
    assert.equal(applied.json.data.stats.total_applied, 1);
    assert.equal(applied.json.data.stats.in_progress, 1);
    assert.equal(applied.json.data.stats.in_interview, 0);
  });

  it('检索、来源过滤、排序与游标分页', async () => {
    const search = await server.request('/api/v1/ledger?view=viewed&q=' + encodeURIComponent('看过公司'), { cookie });
    assert.equal(search.json.data.filtered_total, 1);
    const source = await server.request('/api/v1/ledger?view=viewed&source=manual', { cookie });
    assert.equal(source.json.data.filtered_total, 0);
    const page1 = await server.request('/api/v1/ledger?view=viewed&limit=1', { cookie });
    assert.equal(page1.json.data.items.length, 1);
    assert.equal(page1.json.data.page.has_more, false);
    const badStatus = await server.request('/api/v1/ledger?status=unknown_status', { cookie });
    assert.equal(badStatus.status, 400);
  });

  it('纠错：白名单字段、原因必填、版本冲突、禁止直接撤销已投事实', async () => {
    const applied = await server.request('/api/v1/ledger?view=applied', { cookie });
    const app = applied.json.data.items[0];
    const base = { expected_version: app.version, changes: { location: '北京市' }, reason: '用户修正城市' };
    const badField = await server.request(`/api/v1/applications/${app.id}/corrections`, { method: 'POST', cookie, headers: { 'Idempotency-Key': key('corr-bad') }, body: { ...base, changes: { owner_id: 'usr_x' } } });
    assert.equal(badField.status, 400);
    const noReason = await server.request(`/api/v1/applications/${app.id}/corrections`, { method: 'POST', cookie, headers: { 'Idempotency-Key': key('corr-noreason') }, body: { expected_version: app.version, changes: { location: '北京市' } } });
    assert.equal(noReason.status, 400);
    const okCorrection = await server.request(`/api/v1/applications/${app.id}/corrections`, { method: 'POST', cookie, headers: { 'Idempotency-Key': key('corr-ok') }, body: base });
    assert.equal(okCorrection.status, 200);
    assert.equal(okCorrection.json.data.location, '北京市');
    assert.ok(okCorrection.json.data.version > app.version || okCorrection.json.data.changed === true);
    const staleCorrection = await server.request(`/api/v1/applications/${app.id}/corrections`, { method: 'POST', cookie, headers: { 'Idempotency-Key': key('corr-stale') }, body: { ...base, changes: { location: '广州市' } } });
    assert.equal(staleCorrection.status, 409);
    assert.equal(staleCorrection.json.error.code, 'VERSION_CONFLICT');
    const latest = await server.request(`/api/v1/applications/${app.id}`, { cookie });
    const removal = await server.request(`/api/v1/applications/${app.id}/corrections`, { method: 'POST', cookie, headers: { 'Idempotency-Key': key('corr-removal') }, body: { expected_version: latest.json.data.version, changes: { status: 'pending' }, reason: '试图撤销已投' } });
    assert.equal(removal.status, 403);
    assert.equal(removal.json.error.code, 'APPLIED_FACT_REMOVAL');
  });

  it('归档与恢复：浏览记录可归档，台账计数正确', async () => {
    const viewed = await server.request('/api/v1/ledger?view=viewed', { cookie });
    const app = viewed.json.data.items.find((a) => a.company_name === '看过公司');
    const archive = await server.request(`/api/v1/applications/${app.id}/archive`, { method: 'POST', cookie, headers: { 'Idempotency-Key': key('archive') }, body: { expected_version: app.version, archive: true, reason: '不再关注该岗位' } });
    assert.equal(archive.status, 200);
    assert.ok(archive.json.data.archived_at);
    const counts = await server.request('/api/v1/ledger?view=viewed', { cookie });
    assert.ok(counts.json.data.counts.archived >= 1);
    const restore = await server.request(`/api/v1/applications/${app.id}/archive`, { method: 'POST', cookie, headers: { 'Idempotency-Key': key('unarchive') }, body: { expected_version: archive.json.data.version, archive: false, reason: '重新关注' } });
    assert.equal(restore.status, 200);
    assert.equal(restore.json.data.archived_at, null);
  });

  it('标记已打理：写入 last_reviewed_at，幂等重放不再改版本', async () => {
    const applied = await server.request('/api/v1/ledger?view=applied', { cookie });
    const app = applied.json.data.items[0];
    const first = await server.request(`/api/v1/applications/${app.id}/reviewed`, { method: 'POST', cookie, headers: { 'Idempotency-Key': 'test-reviewed-fixed-0001' }, body: { expected_version: app.version, context: 'ledger' } });
    assert.equal(first.status, 200);
    assert.ok(first.json.data.application.last_reviewed_at);
    const replay = await server.request(`/api/v1/applications/${app.id}/reviewed`, { method: 'POST', cookie, headers: { 'Idempotency-Key': 'test-reviewed-fixed-0001' }, body: { expected_version: app.version, context: 'ledger' } });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.data.application.last_reviewed_at, first.json.data.application.last_reviewed_at);
  });

  it('跨用户隔离：另一账号读不到任何记录', async () => {
    const peer = await server.login('peer@tounar.local');
    const applied = await server.request('/api/v1/ledger?view=applied', { cookie });
    const appId = applied.json.data.items[0].id;
    const cross = await server.request(`/api/v1/applications/${appId}`, { cookie: peer.cookie });
    assert.equal(cross.status, 404);
    const peerLedger = await server.request('/api/v1/ledger?view=applied', { cookie: peer.cookie });
    assert.equal(peerLedger.json.data.stats.total_applied, 0);
  });
});
