import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const key = (name) => `test-${name}-${Math.random().toString(36).slice(2, 10)}`;

function evt(type, id, payload, extra = {}) {
  return {
    client_event_id: id,
    event_type: type,
    source_method: 'plugin',
    site_key: 'generic',
    adapter_version: '1.0.0',
    schema_version: 'C1',
    occurred_at: extra.occurred_at || '2026-10-18T02:00:00.000Z',
    observed_at: extra.observed_at || '2026-10-18T02:00:04.000Z',
    evidence_level: extra.evidence_level || 'weak',
    evidence_code: extra.evidence_code || 'test-weak',
    payload
  };
}

describe('复核项：列表、确认、驳回、并发与幂等', () => {
  let server;
  let cookie;
  let token;
  before(async () => {
    server = await startTestServer({ name: 'reviews' });
    cookie = (await server.login('demo@tounar.local')).cookie;
    token = (await server.pairDevice(cookie, 'Review Chrome')).device_token;
  });
  after(async () => { await server.stop(); });

  it('弱提交形成复核，不自动入账；列表与详情可见证据', async () => {
    const res = await server.eventBatch(token, [evt('application_submitted', 'evt_review_weak_1', {
      company_name: '复核公司', job_title: '算法实习生', site_job_id: 'review-1',
      job_url: 'https://jobs.example.com/job/review-1', jd_summary: '参与算法开发', status_text: '投递完成（未确认）'
    })]);
    assert.equal(res.json.results[0].processing_state, 'pending');
    const reviewId = res.json.results[0].review_item_id;
    const list = await server.request('/api/v1/review-items?status=open', { cookie });
    assert.ok(list.json.data.some((r) => r.id === reviewId));
    const detail = await server.request(`/api/v1/review-items/${reviewId}`, { cookie });
    assert.equal(detail.json.data.reason_code, 'WEAK_SUBMISSION_EVIDENCE');
    assert.ok(detail.json.data.evidence);
    const ledger = await server.request('/api/v1/ledger?view=applied', { cookie });
    assert.equal(ledger.json.data.stats.total_applied, 0);
  });

  it('确认（create）：用户补全字段后建正式记录并计入统计', async () => {
    const list = await server.request('/api/v1/review-items?status=open', { cookie });
    const review = list.json.data.find((r) => r.summary.includes('疑似投递') || r.reason_code === 'WEAK_SUBMISSION_EVIDENCE');
    assert.ok(review);
    const detail = await server.request(`/api/v1/review-items/${review.id}`, { cookie });
    const resolved = await server.request(`/api/v1/review-items/${review.id}/resolve`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('review-create') },
      body: {
        expected_version: detail.json.data.version,
        action: 'create',
        changes: {
          company_name: '复核公司', job_title: '算法实习生', has_applied: true, status: 'applied',
          applied_at: '2026-10-18T02:00:00.000Z', jd_summary: '参与算法开发',
          job_url: 'https://jobs.example.com/job/review-1'
        },
        reason: '用户确认已投递'
      }
    });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.json?.error));
    assert.equal(resolved.json.data.review.status, 'resolved');
    assert.ok(resolved.json.data.application);
    const ledger = await server.request('/api/v1/ledger?view=applied', { cookie });
    assert.equal(ledger.json.data.stats.total_applied, 1);
    const replay = await server.request(`/api/v1/review-items/${review.id}/resolve`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('review-create') },
      body: {
        expected_version: detail.json.data.version,
        action: 'create',
        changes: {
          company_name: '复核公司', job_title: '算法实习生', has_applied: true, status: 'applied',
          applied_at: '2026-10-18T02:00:00.000Z', jd_summary: '参与算法开发',
          job_url: 'https://jobs.example.com/job/review-1'
        },
        reason: '用户确认已投递'
      }
    });
    assert.equal(replay.status, 200);
  });

  it('驳回（dismiss）：复核关闭，事件标记忽略，不产生记录', async () => {
    const res = await server.eventBatch(token, [evt('application_submitted', 'evt_review_dismiss', {
      company_name: '驳回公司', job_title: '前端实习生', site_job_id: 'review-dismiss-1',
      job_url: 'https://jobs.example.com/job/review-dismiss-1', jd_summary: '前端'
    })]);
    const reviewId = res.json.results[0].review_item_id;
    const detail = await server.request(`/api/v1/review-items/${reviewId}`, { cookie });
    const dismissed = await server.request(`/api/v1/review-items/${reviewId}/resolve`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('review-dismiss') },
      body: { expected_version: detail.json.data.version, action: 'dismiss', reason: '不是我的投递' }
    });
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.json.data.review.status, 'dismissed');
    const again = await server.request(`/api/v1/review-items/${reviewId}/resolve`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('review-dismiss-2') },
      body: { expected_version: detail.json.data.version, action: 'dismiss', reason: '重复点击' }
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.data.already_resolved, true);
    const ledger = await server.request('/api/v1/ledger?view=applied', { cookie });
    assert.ok(!ledger.json.data.items.some((a) => a.company_name === '驳回公司'));
  });

  it('版本冲突：旧版本复核项被拒绝', async () => {
    const res = await server.eventBatch(token, [evt('application_submitted', 'evt_review_conflict', {
      company_name: '并发公司', job_title: '测试岗', site_job_id: 'review-conflict-1',
      job_url: 'https://jobs.example.com/job/review-conflict-1', jd_summary: '测试'
    })]);
    const reviewId = res.json.results[0].review_item_id;
    const conflict = await server.request(`/api/v1/review-items/${reviewId}/resolve`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('review-conflict') },
      body: { expected_version: 999, action: 'dismiss', reason: '旧版本' }
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'VERSION_CONFLICT');
  });

  it('跨用户隔离：他人复核项不可见不可操作', async () => {
    const peer = await server.login('peer@tounar.local');
    const list = await server.request('/api/v1/review-items?status=open', { cookie });
    const reviewId = list.json.data[0]?.id;
    if (reviewId) {
      const cross = await server.request(`/api/v1/review-items/${reviewId}`, { cookie: peer.cookie });
      assert.equal(cross.status, 404);
    }
    const peerList = await server.request('/api/v1/review-items?status=open', { cookie: peer.cookie });
    assert.equal(peerList.json.data.length, 0);
  });
});
