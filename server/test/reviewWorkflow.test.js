/* P1（2026-10-22）：待确认交互重做的服务端配套。
   覆盖：把握度投影、建议记录、任意本人记录关联、撤回恢复、撤回过期、本人台账搜索。 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const key = (name) => `test-${name}-${Math.random().toString(36).slice(2, 10)}`;
const APP_URL = 'https://jobs.example.com/p1/xinghai-fe';

function weakSubmission(tag, payload) {
  const now = Date.now();
  return {
    client_event_id: `evt_p1_${tag}_${now}`,
    event_type: 'application_submitted',
    source_method: 'plugin',
    site_key: 'generic',
    adapter_version: '1.0.0',
    schema_version: 'C1',
    occurred_at: new Date(now - 20 * 60000).toISOString(),
    observed_at: new Date(now).toISOString(),
    evidence_level: 'weak',
    evidence_code: 'success-text-visible-unconfirmed',
    payload
  };
}

async function seedManual(server, cookie, { company = '星海科技', title = '前端实习生', url = APP_URL } = {}) {
  const res = await server.request('/api/v1/applications/manual', {
    method: 'POST', cookie,
    headers: { 'Idempotency-Key': key('p1-manual') },
    body: {
      company_name: company, job_title: title, channel: '官网',
      has_applied: true, status: 'applied', applied_date: '2026-10-01',
      jd_summary: '前端页面开发', job_url: url, location: '杭州'
    }
  });
  assert.equal(res.status, 201, JSON.stringify(res.json?.error));
  return res.json.data;
}

describe('待确认 P1：把握度 / 任意记录关联 / 撤回 / 台账搜索', () => {
  let server;
  let cookie;
  let token;
  let app;

  before(async () => {
    server = await startTestServer({ name: 'review-p1' });
    cookie = (await server.login('demo@tounar.local')).cookie;
    token = (await server.pairDevice(cookie, 'P1 Chrome')).device_token;
    app = await seedManual(server, cookie);
  });
  after(async () => { await server.stop(); });

  it('复核项返回分类/匹配/总把握度与建议记录（总把握度 = 分类 × 匹配）', async () => {
    const res = await server.eventBatch(token, [weakSubmission('confidence', {
      company_name: '星海科技', job_title: '前端实习生',
      site_job_id: 'p1-confidence-1', job_url: APP_URL,
      jd_summary: '前端页面开发'
    })]);
    const reviewId = res.json.results[0].review_item_id;
    assert.ok(reviewId);
    const detail = await server.request(`/api/v1/review-items/${reviewId}`, { cookie });
    assert.equal(detail.status, 200);
    const review = detail.json.data;
    assert.equal(review.classification_confidence, null);
    assert.equal(review.match_confidence, 0.9);
    assert.equal(review.total_confidence, 0.9);
    assert.equal(review.suggested_application_id, app.id);
    assert.equal(review.suggested_application.company_name, '星海科技');
    assert.equal(review.suggested_application.status_label, '已投递');
    assert.equal(review.suggested_status, 'applied');
    assert.equal(review.mail_received_at, null);
    assert.ok(review.candidates[0].match_confidence >= 0.9);
  });

  it('无候选也能关联本人任意记录；撤回恢复状态并重新打开复核项；驳回不能撤回', async () => {
    const res = await server.eventBatch(token, [weakSubmission('nocand', {
      company_name: '无候选公司', job_title: '神秘岗位',
      site_job_id: 'p1-nocand-1', job_url: 'https://jobs.example.com/p1/unknown-role',
      jd_summary: '无'
    })]);
    const reviewId = res.json.results[0].review_item_id;
    const open = await server.request(`/api/v1/review-items/${reviewId}`, { cookie });
    assert.equal(open.json.data.candidates.length, 0);
    assert.equal(open.json.data.suggested_application_id, null);

    const search = await server.request('/api/v1/application-search?q=星海', { cookie });
    assert.equal(search.status, 200);
    assert.ok(search.json.data.some((row) => row.id === app.id));
    const peer = await server.login('peer@tounar.local');
    const peerSearch = await server.request('/api/v1/application-search?q=星海', { cookie: peer.cookie });
    assert.equal(peerSearch.json.data.length, 0, '不能搜到他人台账');

    const freshApp = await server.request(`/api/v1/applications/${app.id}`, { cookie });
    const resolved = await server.request(`/api/v1/review-items/${reviewId}/resolve`, {
      method: 'POST', cookie,
      headers: { 'Idempotency-Key': key('p1-link') },
      body: {
        expected_version: open.json.data.version,
        action: 'confirm',
        application_id: app.id,
        expected_application_version: freshApp.json.data.version,
        changes: { status: 'interview' },
        reason: '用户手动选择记录'
      }
    });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.json?.error));
    assert.equal(resolved.json.data.application.status, 'interview');

    const undo = await server.request(`/api/v1/review-items/${reviewId}/undo`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('p1-undo') }, body: {}
    });
    assert.equal(undo.status, 200, JSON.stringify(undo.json?.error));
    assert.equal(undo.json.data.undone, true);
    assert.equal(undo.json.data.application_id, app.id);
    const reopened = await server.request(`/api/v1/review-items/${reviewId}`, { cookie });
    assert.equal(reopened.json.data.status, 'open');
    const restored = await server.request(`/api/v1/applications/${app.id}`, { cookie });
    assert.equal(restored.json.data.status, 'applied');
    assert.equal(restored.json.data.version, freshApp.json.data.version + 2);

    /* 驳回的项没有「恢复台账」语义，不允许走撤回 */
    const dismissed = await server.request(`/api/v1/review-items/${reviewId}/resolve`, {
      method: 'POST', cookie,
      headers: { 'Idempotency-Key': key('p1-dismiss') },
      body: { expected_version: reopened.json.data.version, action: 'dismiss', reason: '不是招聘进展' }
    });
    assert.equal(dismissed.status, 200);
    const badUndo = await server.request(`/api/v1/review-items/${reviewId}/undo`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': key('p1-undo-bad') }, body: {}
    });
    assert.equal(badUndo.status, 400);
    assert.equal(badUndo.json.error.code, 'UNDO_NOT_AVAILABLE');
  });
});

describe('待确认 P1：撤回时间窗过期', () => {
  it('超过 REVIEW_UNDO_MINUTES 后撤回返回 409，台账保持在确认后的状态', async () => {
    const expired = await startTestServer({ name: 'review-p1-expired', env: { REVIEW_UNDO_MINUTES: '0' } });
    try {
      const cookie = (await expired.login('demo@tounar.local')).cookie;
      const token = (await expired.pairDevice(cookie, 'Expired Chrome')).device_token;
      const app = await seedManual(expired, cookie, {
        company: '过期测试公司', title: '测试岗', url: 'https://jobs.example.com/p1/expired-role'
      });
      const res = await expired.eventBatch(token, [weakSubmission('expired', {
        company_name: '过期测试公司', job_title: '测试岗',
        site_job_id: 'p1-expired-1', job_url: 'https://jobs.example.com/p1/expired-role'
      })]);
      const reviewId = res.json.results[0].review_item_id;
      const review = await expired.request(`/api/v1/review-items/${reviewId}`, { cookie });
      const freshApp = await expired.request(`/api/v1/applications/${app.id}`, { cookie });
      const resolved = await expired.request(`/api/v1/review-items/${reviewId}/resolve`, {
        method: 'POST', cookie,
        headers: { 'Idempotency-Key': key('p1-expired-resolve') },
        body: {
          expected_version: review.json.data.version,
          action: 'confirm',
          application_id: app.id,
          expected_application_version: freshApp.json.data.version,
          changes: { status: 'interview' },
          reason: '确认更新'
        }
      });
      assert.equal(resolved.status, 200, JSON.stringify(resolved.json?.error));
      const undo = await expired.request(`/api/v1/review-items/${reviewId}/undo`, {
        method: 'POST', cookie, headers: { 'Idempotency-Key': key('p1-expired-undo') }, body: {}
      });
      assert.equal(undo.status, 409);
      assert.equal(undo.json.error.code, 'UNDO_EXPIRED');
      const still = await expired.request(`/api/v1/applications/${app.id}`, { cookie });
      assert.equal(still.json.data.status, 'interview');
    } finally {
      await expired.stop();
    }
  });
});
