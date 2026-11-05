import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, strongViewEvent } from './helpers.js';

let fake, fakePort, server, cookie, token;
before(async () => {
  fake = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/chat/completions') {
      const text = String(body.messages?.[1]?.content || '');
      const answer = {
        is_recruitment: true, content_role: 'actual_progress',
        company_name: '自动科技', job_title: '自动岗位', status: 'interview',
        progress_description: '收到面试邀请', evidence: [{ field: 'status', quote: '面试邀请' }], uncertainties: []
      };
      res.end(JSON.stringify({ model: 'fake-llm', choices: [{ message: { content: JSON.stringify(answer) } }] }));
      return;
    }
    if (req.url === '/v1/systemone') {
      res.end(JSON.stringify({
        model: 'jev-1.14.0',
        answers: {
          actual_progress: { type: 'noul', noul: 0.95 },
          status: { type: 'choice', choice: 'interview', confidence: 0.98, probabilities: {} },
          evidence_support: { type: 'noul', noul: 0.95 },
          newness: { type: 'choice', choice: 'new', confidence: 0.95, probabilities: {} },
          candidate: { type: 'choice', choice: 'c0', confidence: 0.95, probabilities: {} }
        }
      }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  fakePort = fake.address().port;
  server = await startTestServer({
    name: 'plugin-auto-intake',
    env: {
      AI_API_URL: `http://127.0.0.1:${fakePort}/v1`, AI_API_KEY: 'test', AI_MODEL: 'fake',
      JEV_API_URL: `http://127.0.0.1:${fakePort}/v1/systemone`, JEV_API_KEY: 'test', JEV_MODEL: 'jev-latest',
      AUTO_INTAKE_ENABLED: 'true', AI_LLM_TIMEOUT_MS: '5000'
    }
  });
  cookie = (await server.login('demo@tounar.local')).cookie;
  token = (await server.pairDevice(cookie, 'auto intake device')).device_token;
});
after(async () => {
  await server?.stop();
  await new Promise((resolve) => fake?.close(resolve));
});

async function waitApp(id, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const res = await server.request(`/api/v1/applications/${id}`, { cookie });
    last = res.json?.data;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`application did not converge: ${JSON.stringify(last)}`);
}

it('插件官网状态事件走后端异步 AI+Jev，自动更新原记录且不生成待确认', async () => {
  const base = {
    company_name: '自动科技', job_title: '自动岗位', site_job_id: 'plugin-auto-1',
    job_url: 'https://jobs.example.com/plugin-auto-1', jd_summary: '自动流程测试', location: '上海'
  };
  const captured = await server.eventBatch(token, [strongViewEvent({
    event_type: 'job_captured', payload: { ...base, visible_dwell_ms: 4200 }
  })]);
  const appId = captured.json.results[0].application_id;
  assert.ok(appId, captured.text);
  const statusEvent = await server.eventBatch(token, [strongViewEvent({
    event_type: 'site_status_observed',
    occurred_at: '2026-10-31T10:00:00.000Z', observed_at: '2026-10-31T10:00:04.000Z',
    payload: { ...base, status_text: '面试中' }
  })]);
  assert.equal(statusEvent.status, 200, statusEvent.text);
  assert.equal(statusEvent.json.results[0].accepted, true);
  const app = await waitApp(appId, (x) => x.status === 'interview');
  assert.equal(app.has_applied, 1);
  const reviews = await server.request('/api/v1/review-items?status=open&limit=50', { cookie });
  assert.equal((reviews.json.data || []).length, 0);
});
