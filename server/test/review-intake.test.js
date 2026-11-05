import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, strongViewEvent } from './helpers.js';

let fake, fakePort, server, cookie, token;
let fail = false;
const calls = [];
before(async () => {
  fake = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    calls.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (fail) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'fake failure' } })); return; }
    if (req.url === '/v1/chat/completions') {
      const content = String(body.messages?.[1]?.content || '');
      let ex;
      if (content.includes('ONLY_COMPANY')) ex = { is_recruitment: true, content_role: 'actual_progress', company_name: '招商银行', job_title: null, status: 'assessment', evidence: [{ field: 'company_name', quote: '招商银行' }], uncertainties: [] };
      else if (content.includes('MISALIGNED')) ex = { is_recruitment: true, content_role: 'actual_progress', company_name: '面试', job_title: '招商银行', status: 'interview', evidence: [{ field: 'company_name', quote: '面试' }, { field: 'job_title', quote: '招商银行' }], uncertainties: [] };
      else ex = { is_recruitment: true, content_role: 'actual_progress', company_name: '星河科技', job_title: '数据产品实习生', status: 'applied', evidence: [{ field: 'company_name', quote: '星河科技' }, { field: 'job_title', quote: '数据产品实习生' }], uncertainties: [] };
      res.end(JSON.stringify({ model: 'fake-llm', choices: [{ message: { content: JSON.stringify(ex) } }] })); return;
    }
    if (req.url === '/v1/systemone') {
      const state = body.state || {};
      const ex = state.extracted || {};
      const badFields = ex.company_name === '面试' || ex.job_title === '招商银行';
      const candidates = state.candidates || [];
      res.end(JSON.stringify({
        model: 'jev-1.14.0',
        answers: {
          actual_progress: { type: 'noul', noul: 0.96 }, evidence_support: { type: 'noul', noul: 0.95 },
          company_valid: { type: 'noul', noul: badFields ? 0.08 : 0.96 },
          job_title_valid: { type: 'noul', noul: badFields ? 0.07 : (ex.job_title ? 0.95 : 0.02) },
          fields_consistent: { type: 'noul', noul: badFields ? 0.1 : 0.95 },
          status: { type: 'choice', choice: ex.status || 'no_status', confidence: 0.95, probabilities: {} },
          newness: { type: 'choice', choice: 'new', confidence: 0.9, probabilities: {} },
          candidate: { type: 'choice', choice: candidates.length ? 'c0' : 'no_match', confidence: 0.9, probabilities: {} }
        }
      })); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakePort = fake.address().port;
  server = await startTestServer({ name: 'review-intake', env: {
    AI_API_URL: `http://127.0.0.1:${fakePort}/v1`, AI_API_KEY: 'test', AI_MODEL: 'fake',
    JEV_API_URL: `http://127.0.0.1:${fakePort}/v1/systemone`, JEV_API_KEY: 'test', JEV_MODEL: 'jev-latest',
    AUTO_INTAKE_ENABLED: 'true', AI_LLM_TIMEOUT_MS: '5000'
  } });
  cookie = (await server.login('demo@tounar.local')).cookie;
  token = (await server.pairDevice(cookie, 'intake ui')).device_token;
});
after(async () => { await server?.stop(); await new Promise((r) => fake?.close(r)); });

async function reviewFor(payload, evidence_level = 'weak', event_type = 'job_viewed') {
  const r = await server.eventBatch(token, [strongViewEvent({ event_type, evidence_level, payload: { ...payload, visible_dwell_ms: 4200 } })]);
  return r.json.results[0];
}
function intake(id, version, key = crypto.randomUUID()) {
  return server.request(`/api/v1/review-items/${id}/intake`, { method: 'POST', cookie, headers: { 'Idempotency-Key': key }, body: { expected_version: version } });
}

it('识别公司/岗位/状态可靠：确认按钮直接入账，Jev 参与分流', async () => {
  const created = await reviewFor({ company_name: '星河科技', job_title: '数据产品实习生', jd_summary: '负责数据产品与用户研究', site_job_id: null, job_url: null, page_url: 'https://jobs.example.com/clean' }, 'weak', 'application_submitted');
  assert.ok(created.review_item_id, JSON.stringify(created));
  const detail = await server.request(`/api/v1/review-items/${created.review_item_id}`, { cookie });
  const res = await intake(created.review_item_id, detail.json.data.version);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.data.state, 'applied');
  assert.equal(res.json.data.application.company_name, '星河科技');
  assert.equal(res.json.data.application.job_title, '数据产品实习生');
  assert.equal(res.json.data.application.status, 'applied');
  assert.ok(res.json.data.analysis.models.jev === 'jev-1.14.0');
  assert.ok(calls.includes('/v1/systemone'));
  assert.equal((await detailOf(created.review_item_id)).status, 'resolved');
});

it('只能识别公司：返回补录，不创建台账，取消/保存前保持待确认', async () => {
  const created = await reviewFor({ company_name: '招商银行', job_title: null, jd_summary: 'ONLY_COMPANY 统一笔试通知', site_job_id: null, job_url: null, page_url: 'https://jobs.example.com/only-company' }, 'weak');
  assert.ok(created.review_item_id, JSON.stringify(created));
  const detail = await server.request(`/api/v1/review-items/${created.review_item_id}`, { cookie });
  const before = await server.request('/api/v1/ledger?view=applied&limit=100', { cookie });
  const res = await intake(created.review_item_id, detail.json.data.version);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.data.state, 'needs_input');
  assert.equal(res.json.data.fields.company_name, '招商银行');
  assert.equal(res.json.data.fields.job_title, '');
  assert.ok(res.json.data.missing.includes('job_title'));
  const after = await server.request('/api/v1/ledger?view=applied&limit=100', { cookie });
  assert.equal(after.json.data.filtered_total, before.json.data.filtered_total);
  assert.equal((await detailOf(created.review_item_id)).status, 'open');
  const save = await server.request(`/api/v1/review-items/${created.review_item_id}/assign`, { method: 'POST', cookie, headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { status: 'assessment', expected_version: detail.json.data.version, changes: { company_name: '招商银行', job_title: '数据分析实习生' }, applied_at: '2026-10-14T00:00:00.000Z' } });
  assert.equal(save.status, 200, save.text);
  assert.equal(save.json.data.application.job_title, '数据分析实习生');
});

it('字段疑似错位：Jev 低字段校验不直接写入，返回补录', async () => {
  const created = await reviewFor({ company_name: '面试', job_title: '招商银行', jd_summary: 'MISALIGNED 原始邮件', site_job_id: null, job_url: null, page_url: 'https://jobs.example.com/misaligned' }, 'weak');
  const detail = await server.request(`/api/v1/review-items/${created.review_item_id}`, { cookie });
  const res = await intake(created.review_item_id, detail.json.data.version);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.data.state, 'needs_input');
  assert.ok(res.json.data.analysis.fields_consistent < 0.6);
  assert.ok(res.json.data.missing.includes('company_name') || res.json.data.missing.includes('job_title'));
});

it('模型失败：返回可重试错误，不创建空白台账；重复确认幂等', async () => {
  const created = await reviewFor({ company_name: '星河科技', job_title: '数据产品实习生', jd_summary: '失败样本', site_job_id: null, job_url: null, page_url: 'https://jobs.example.com/fail' }, 'weak', 'application_submitted');
  const detail = await server.request(`/api/v1/review-items/${created.review_item_id}`, { cookie });
  fail = true;
  const failed = await intake(created.review_item_id, detail.json.data.version);
  fail = false;
  assert.equal(failed.status, 200, failed.text);
  assert.equal(failed.json.data.state, 'failed');
  assert.equal(failed.json.data.error_code, 'INTAKE_RECOGNITION_FAILED');
  assert.equal(failed.json.data.trace.llm.status, 'failed');
  assert.equal(failed.json.data.trace.jev.status, 'not_called');
  assert.match(failed.json.data.trace.request_id, /^req_/);
  assert.equal((await detailOf(created.review_item_id)).status, 'open');
  const first = await intake(created.review_item_id, detail.json.data.version);
  assert.equal(first.status, 200, first.text);
  const appId = first.json.data.application.id;
  const again = await intake(created.review_item_id, detail.json.data.version);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.data.application.id, appId);
});

async function detailOf(id) {
  return (await server.request(`/api/v1/review-items/${id}`, { cookie })).json.data;
}
