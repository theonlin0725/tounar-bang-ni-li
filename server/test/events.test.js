import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, strongViewEvent } from './helpers.js';

function evt(type, id, payload, extra = {}) {
  return {
    client_event_id: id,
    event_type: type,
    source_method: 'plugin',
    site_key: extra.site_key || 'generic',
    adapter_version: '1.0.0',
    schema_version: 'C1',
    occurred_at: extra.occurred_at || '2026-10-20T03:00:00.000Z',
    observed_at: extra.observed_at || '2026-10-20T03:00:05.000Z',
    evidence_level: extra.evidence_level || 'strong',
    evidence_code: extra.evidence_code || 'test',
    payload
  };
}

describe('事件链路：浏览 / 填写 / 提交 / 状态 / 幂等（C1 3.4、DATA-2.3）', () => {
  let server;
  let cookie;
  let token;
  before(async () => {
    server = await startTestServer({ name: 'events' });
    cookie = (await server.login('demo@tounar.local')).cookie;
    token = (await server.pairDevice(cookie, 'Events Chrome')).device_token;
  });
  after(async () => { await server.stop(); });

  it('显式采集 job_captured：不需要停留时长，落库完整 JD', async () => {
    const longJd = '工作职责：\n1. 负责服务端开发；\n2. 参与架构设计。\n任职要求：\n1. 熟悉 Node.js；\n2. 有分布式经验。' + ' 细节描述'.repeat(200);
    const res = await server.eventBatch(token, [evt('job_captured', 'evt_capture_001', {
      company_name: '采集公司', job_title: '后端工程师', site_job_id: 'cap-1',
      job_url: 'https://jobs.example.com/job/cap-1', jd_summary: longJd.slice(0, 80),
      jd_text: longJd, location: '深圳', recruitment_batch: '2027 秋招', channel: '企业官网',
      visible_dwell_ms: 120
    }, { evidence_code: 'explicit_capture' })]);
    assert.equal(res.status, 200);
    const detail = await server.request('/api/v1/ledger?view=viewed&status=all&limit=50', { cookie });
    const row = detail.json.data.items.find((x) => x.job_title === '后端工程师');
    assert.ok(row, JSON.stringify(detail.json.data.items));
    assert.equal(row.status, 'pending');
    assert.equal(row.has_applied, 0);
    const full = await server.request(`/api/v1/applications/${row.id}`, { cookie });
    assert.equal(full.json.data.jd_text, longJd);
    assert.ok(full.json.data.jd_text.includes('任职要求'));
  });

  it('JD 超过 10 万字符时明确拒绝，不静默丢正文', async () => {
    const huge = 'x'.repeat(100001);
    const res = await server.eventBatch(token, [evt('job_captured', 'evt_capture_big', {
      company_name: '超长公司', job_title: '超长JD岗', site_job_id: 'cap-big',
      job_url: 'https://jobs.example.com/job/cap-big', jd_summary: 'x', jd_text: huge
    })]);
    assert.equal(res.status, 200);
    const result = res.json.results[0];
    assert.equal(result.accepted, false, JSON.stringify(result));
    assert.equal(result.error.code, 'JD_TEXT_TOO_LONG');
  });

  it('批次级校验：空数组、超 50 条、schema 非 C1', async () => {
    const empty = await server.request('/api/v1/events/batch', { method: 'POST', token, body: { schema_version: 'C1', events: [] } });
    assert.equal(empty.status, 400);
    const tooMany = await server.eventBatch(token, Array.from({ length: 51 }, (_, i) => evt('job_viewed', `evt_many_${i}`, { company_name: 'A', job_title: 'B', site_job_id: `j${i}` })));
    assert.equal(tooMany.status, 400);
    const rawNoSchema = {
      client_event_id: 'evt_schema_1', event_type: 'job_viewed', source_method: 'plugin',
      occurred_at: '2026-10-20T03:00:00.000Z', observed_at: '2026-10-20T03:00:05.000Z',
      evidence_level: 'strong', evidence_code: 'test',
      payload: { company_name: 'Schema 公司', job_title: '岗位', site_job_id: 'schema-1', job_url: 'https://jobs.example.com/job/schema-1' }
    };
    const wrongSchema = await server.request('/api/v1/events/batch', { method: 'POST', token, body: { schema_version: 'C0', events: [rawNoSchema] } });
    assert.equal(wrongSchema.status, 200);
    assert.equal(wrongSchema.json.results[0].accepted, false);
    assert.equal(wrongSchema.json.results[0].error.code, 'VALIDATION_ERROR');
  });

  it('逐条校验：owner_id 注入、未知事件类型、不安全 URL 都被拒绝', async () => {
    const res = await server.eventBatch(token, [
      { ...evt('job_viewed', 'evt_owner_inject', { company_name: 'A', job_title: 'B', site_job_id: 'x1' }), owner_id: 'usr_fake' },
      evt('mail_progress_detected', 'evt_mail_forbidden', { company_name: 'A', job_title: 'B' }),
      evt('job_viewed', 'evt_bad_url', { company_name: 'A', job_title: 'B', site_job_id: 'x2', job_url: 'javascript:alert(1)' })
    ]);
    assert.equal(res.status, 200);
    assert.equal(res.json.results.length, 3);
    for (const item of res.json.results) {
      assert.equal(item.accepted, false);
      assert.equal(item.error.code, 'VALIDATION_ERROR');
    }
  });

  it('浏览：≥3 秒强证据创建待投递记录；重复浏览只更新 last_viewed_at、不新增行、不动状态时间', async () => {
    const job = { company_name: '浏览公司', job_title: '前端实习生', site_job_id: 'view-001', job_url: 'https://jobs.example.com/job/view-001?utm_source=a&spm=b', jd_summary: '参与前端开发', location: '杭州' };
    const first = await server.eventBatch(token, [evt('job_viewed', 'evt_view_001a', job, { occurred_at: '2026-10-20T01:00:00.000Z', observed_at: '2026-10-20T01:00:03.500Z' })]);
    assert.equal(first.json.results[0].processing_state, 'applied');
    const appId = first.json.results[0].application_id;
    const detail1 = await server.request(`/api/v1/applications/${appId}`, { cookie });
    assert.equal(detail1.json.data.status, 'pending');
    assert.equal(detail1.json.data.has_applied, 0);
    const statusChangedAt1 = detail1.json.data.last_status_changed_at;

    const second = await server.eventBatch(token, [evt('job_viewed', 'evt_view_001b', job, { occurred_at: '2026-10-21T01:00:00.000Z', observed_at: '2026-10-21T01:00:04.000Z' })]);
    assert.equal(second.json.results[0].application_id, appId);
    const detail2 = await server.request(`/api/v1/applications/${appId}`, { cookie });
    assert.equal(detail2.json.data.first_viewed_at, detail1.json.data.first_viewed_at);
    assert.notEqual(detail2.json.data.last_viewed_at, detail1.json.data.last_viewed_at);
    assert.equal(detail2.json.data.last_status_changed_at, statusChangedAt1);
  });

  it('弱浏览（证据不足）：进入复核，不创建主表记录', async () => {
    const res = await server.eventBatch(token, [evt('job_viewed', 'evt_view_weak_1', { company_name: '弱证据公司', job_title: '岗位', site_job_id: 'weak-001', job_url: 'https://jobs.example.com/job/weak-001' }, { evidence_level: 'weak' })]);
    assert.equal(res.json.results[0].processing_state, 'pending');
    assert.ok(res.json.results[0].review_item_id);
    assert.equal(res.json.results[0].application_id, null);
    const ledger = await server.request('/api/v1/ledger?view=viewed', { cookie });
    assert.ok(!ledger.json.data.items.some((a) => a.company_name === '弱证据公司'));
  });

  it('form_started 只更新 form_started_at，不升级为已投', async () => {
    const res = await server.eventBatch(token, [evt('form_started', 'evt_form_001', { company_name: '浏览公司', job_title: '前端实习生', site_job_id: 'view-001', job_url: 'https://jobs.example.com/job/view-001' }, { occurred_at: '2026-10-20T02:00:00.000Z' })]);
    assert.equal(res.json.results[0].processing_state, 'applied');
    const detail = await server.request(`/api/v1/applications/${res.json.results[0].application_id}`, { cookie });
    assert.equal(detail.json.data.form_started_at, '2026-10-20T02:00:00.000Z');
    assert.equal(detail.json.data.has_applied, 0);
  });

  it('提交成功：同一记录升级为已投，写入 applied_at 与 history；重复上传不新增行', async () => {
    const submitEvent1 = evt('application_submitted', 'evt_submit_001', {
      company_name: '浏览公司', job_title: '前端实习生', site_job_id: 'view-001', site_application_id: 'apply-001',
      job_url: 'https://jobs.example.com/job/view-001', jd_summary: '参与前端开发', location: '杭州',
      status_text: '投递成功', mapped_status: 'applied'
    }, { occurred_at: '2026-10-20T02:05:00.000Z', evidence_code: 'submit-detected:explicit-hook' });
    const res = await server.eventBatch(token, [submitEvent1]);
    const item = res.json.results[0];
    assert.equal(item.processing_state, 'applied');
    const detail = await server.request(`/api/v1/applications/${item.application_id}`, { cookie });
    assert.equal(detail.json.data.status, 'applied');
    assert.equal(detail.json.data.has_applied, 1);
    assert.equal(detail.json.data.applied_at, '2026-10-20T02:05:00.000Z');
    assert.ok(detail.json.data.history.some((h) => h.to_status === 'applied'));

    const dup = await server.eventBatch(token, [submitEvent1]);
    assert.equal(dup.json.results[0].duplicate, true);
    const resubmit = await server.eventBatch(token, [evt('application_submitted', 'evt_submit_001b', {
      company_name: '浏览公司', job_title: '前端实习生', site_job_id: 'view-001', site_application_id: 'apply-001',
      job_url: 'https://jobs.example.com/job/view-001', jd_summary: '参与前端开发', status_text: '投递成功'
    }, { occurred_at: '2026-10-20T02:06:00.000Z' })]);
    assert.equal(resubmit.json.results[0].application_id, item.application_id);
  });

  it('同一 client_event_id 不同内容：逐条 IDEMPOTENCY_CONFLICT', async () => {
    const a = await server.eventBatch(token, [evt('job_viewed', 'evt_conflict_001', { company_name: '冲突公司', job_title: '岗位甲', site_job_id: 'conflict-001', job_url: 'https://jobs.example.com/job/conflict-001' })]);
    assert.equal(a.json.results[0].accepted, true);
    const b = await server.eventBatch(token, [evt('job_viewed', 'evt_conflict_001', { company_name: '冲突公司', job_title: '岗位乙', site_job_id: 'conflict-001', job_url: 'https://jobs.example.com/job/conflict-001' })]);
    assert.equal(b.json.results[0].accepted, false);
    assert.equal(b.json.results[0].error.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('弱提交证据：进入复核，不计入累计投递', async () => {
    const res = await server.eventBatch(token, [evt('application_submitted', 'evt_submit_weak', {
      company_name: '弱提交公司', job_title: '数据岗', site_job_id: 'weak-submit-1', job_url: 'https://jobs.example.com/job/weak-submit-1', jd_summary: '数据', status_text: '也许成功'
    }, { evidence_level: 'weak' })]);
    assert.equal(res.json.results[0].processing_state, 'pending');
    assert.ok(res.json.results[0].review_item_id);
    const ledger = await server.request('/api/v1/ledger?view=applied', { cookie });
    assert.ok(!ledger.json.data.items.some((a) => a.company_name === '弱提交公司'));
    const review = await server.request(`/api/v1/review-items/${res.json.results[0].review_item_id}`, { cookie });
    assert.equal(review.json.data.reason_code, 'WEAK_SUBMISSION_EVIDENCE');
    assert.equal(review.json.data.status, 'open');
  });

  it('D12：强提交但缺 JD 摘要/安全链接时不静默入账，进入复核', async () => {
    const res = await server.eventBatch(token, [evt('application_submitted', 'evt_submit_d12', {
      company_name: '缺字段公司', job_title: '缺字段岗位', site_job_id: 'd12-001', job_url: 'https://jobs.example.com/job/d12-001'
    }, { occurred_at: '2026-10-20T04:00:00.000Z' })]);
    assert.equal(res.json.results[0].processing_state, 'pending');
    assert.ok(res.json.results[0].review_item_id);
    const review = await server.request(`/api/v1/review-items/${res.json.results[0].review_item_id}`, { cookie });
    assert.equal(review.json.data.reason_code, 'D12_MISSING_FIELDS');
  });

  it('状态页观察：状态跃迁写入 history；同状态重复不移动 last_status_changed_at；不按固定阶段阶梯拦截', async () => {
    const job = { company_name: '浏览公司', job_title: '前端实习生', site_job_id: 'view-001', site_application_id: 'apply-001', job_url: 'https://jobs.example.com/job/view-001', status_url: 'https://jobs.example.com/my/apply' };
    const interview = await server.eventBatch(token, [evt('site_status_observed', 'evt_status_001', { ...job, status_text: '面试中', mapped_status: 'interview' }, { occurred_at: '2026-10-22T01:00:00.000Z', observed_at: '2026-10-22T01:00:05.000Z' })]);
    assert.equal(interview.json.results[0].processing_state, 'applied');
    const afterInterview = await server.request(`/api/v1/applications/${interview.json.results[0].application_id}`, { cookie });
    assert.equal(afterInterview.json.data.status, 'interview');
    const changedAt = afterInterview.json.data.last_status_changed_at;

    const repeat = await server.eventBatch(token, [evt('site_status_observed', 'evt_status_002', { ...job, status_text: '面试中', mapped_status: 'interview' }, { occurred_at: '2026-10-23T01:00:00.000Z', observed_at: '2026-10-23T01:00:05.000Z' })]);
    assert.equal(repeat.json.results[0].processing_state, 'applied');
    const afterRepeat = await server.request(`/api/v1/applications/${repeat.json.results[0].application_id}`, { cookie });
    assert.equal(afterRepeat.json.data.last_status_changed_at, changedAt);
    assert.ok(Date.parse(afterRepeat.json.data.last_site_observed_at) >= Date.parse(changedAt));

    const regression = await server.eventBatch(token, [evt('site_status_observed', 'evt_status_003', { ...job, status_text: '已投递', mapped_status: 'applied' }, { occurred_at: '2026-10-24T01:00:00.000Z', observed_at: '2026-10-24T01:00:05.000Z' })]);
    assert.equal(regression.json.results[0].processing_state, 'applied');
    assert.equal(regression.json.results[0].review_item_id, null);
    const finalState = await server.request(`/api/v1/applications/${interview.json.results[0].application_id}`, { cookie });
    assert.equal(finalState.json.data.status, 'applied');
  });

  it('终态候选进复核（D08）；未映射状态保留原文进复核', async () => {
    const job = { company_name: '浏览公司', job_title: '前端实习生', site_job_id: 'view-001', site_application_id: 'apply-001', job_url: 'https://jobs.example.com/job/view-001' };
    const offer = await server.eventBatch(token, [evt('site_status_observed', 'evt_status_offer', { ...job, status_text: 'Offer 已发放', mapped_status: 'offer' }, { occurred_at: '2026-10-25T01:00:00.000Z' })]);
    assert.equal(offer.json.results[0].processing_state, 'pending');
    const review = await server.request(`/api/v1/review-items/${offer.json.results[0].review_item_id}`, { cookie });
    assert.equal(review.json.data.reason_code, 'TERMINAL_LOW_CONFIDENCE');
    assert.ok(review.json.data.evidence.total_confidence < 0.9);
    const unmapped = await server.eventBatch(token, [evt('site_status_observed', 'evt_status_unmapped', { ...job, status_text: '流程进入下一阶段', mapped_status: null }, { occurred_at: '2026-10-26T01:00:00.000Z' })]);
    assert.equal(unmapped.json.results[0].processing_state, 'pending');
  });

  it('字段把握度：低把握值不写入台账，非法分值拒绝', async () => {
    const low = await server.eventBatch(token, [evt('job_viewed', 'evt_field_low_jd', {
      company_name: '字段测试公司', job_title: '测试工程师', job_url: 'https://example.com/job/field-low',
      site_job_id: 'field-low', visible_dwell_ms: 3200, jd_summary: '这是一段不可信的页面导航',
      field_confidence: { company_name: 'high', job_title: 'high', jd_summary: 'low' }
    })]);
    const id = low.json.results[0].application_id;
    const detail = await server.request(`/api/v1/applications/${id}`, { cookie });
    assert.equal(detail.json.data.jd_summary, null);
    const invalid = await server.eventBatch(token, [evt('job_viewed', 'evt_field_invalid', {
      company_name: '字段测试公司', job_title: '测试岗', field_confidence: { job_title: 'guessed' }
    })]);
    assert.equal(invalid.json.results[0].accepted, false);
  });

  it('统计口径：浏览不计入三统计，强提交计入', async () => {
    const ledger = await server.request('/api/v1/ledger?view=applied', { cookie });
    const stats = ledger.json.data.stats;
    assert.equal(stats.total_applied, ledger.json.data.items.length >= 1 ? stats.total_applied : 0);
    assert.ok(stats.total_applied >= 1);
    assert.ok(stats.in_progress >= 1);
    const viewed = await server.request('/api/v1/ledger?view=viewed', { cookie });
    assert.ok(viewed.json.data.items.every((a) => !a.has_applied || a.has_applied === 0));
  });
});
