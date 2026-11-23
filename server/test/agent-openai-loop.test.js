import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startTestServer } from './helpers.js';

/* Exercises the real OpenAI-compatible function-calling loop (not AGENT_FAKE_MODE). */
describe('v1.1.0 Agent OpenAI-compatible tool loop', () => {
  let modelServer;
  let modelPort;
  let server;
  let cookie;
  let requestCount = 0;
  let sawTools = false;
  let sawAuth = false;
  let requestBodies = [];
  let app1;
  let app2;

  before(async () => {
    modelServer = http.createServer(async (req, res) => {
      requestCount += 1;
      sawAuth = req.headers.authorization === 'Bearer test-agent-key';
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      requestBodies.push(body);
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '已根据已读取的工具数据整理：当前筛选结果和下一步建议如下。' }, finish_reason: 'stop' }] }));
        return;
      }
      if (Array.isArray(body.tools) && body.tools.some((tool) => tool.function?.name === 'filter_applications')) sawTools = true;
      const userText = body.messages?.filter((message) => message.role === 'user').at(-1)?.content || '';
      if (String(userText).includes('fail-model')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'fake upstream failure' } }));
        return;
      }
      const lastRole = body.messages?.at(-1)?.role;
      const loop = String(userText).includes('loop');
      const multi = String(userText).includes('multi');
      const toolCall = {
        id: `call_${requestCount}`,
        type: 'function',
        function: { name: 'filter_applications', arguments: JSON.stringify({ inactive_days: 14 }) }
      };
      const message = (lastRole === 'tool' && !loop && !multi)
        ? { role: 'assistant', content: '模型完成：已筛选长期未反馈岗位。' }
        : { role: 'assistant', content: '', tool_calls: multi
          ? [toolCall, { ...toolCall, id: `${toolCall.id}_b` }, { ...toolCall, id: `${toolCall.id}_c` }]
          : [toolCall] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'fake-openai-model', choices: [{ message }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    });
    await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
    modelPort = modelServer.address().port;
    server = await startTestServer({
      name: 'agent-openai-loop',
      env: {
        AGENT_FAKE_MODE: 'false',
        AGENT_API_URL: `http://127.0.0.1:${modelPort}/v1/chat/completions`,
        AGENT_API_KEY: 'test-agent-key',
        AGENT_MODEL: 'fake-openai-model',
        AI_API_URL: '', AI_API_KEY: ''
      }
    });
    cookie = (await server.login('demo@tounar.local')).cookie;
    app1 = (await server.request('/api/v1/applications/manual', { method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-loop-context-1' }, body: { company_name: '上下文旧公司', job_title: '旧岗位', has_applied: true, status: 'applied', applied_at: '2026-11-01T04:00:00Z', applied_at_precision: 'date', jd_summary: '旧岗位机密JD-ALPHA 仅用于上下文隔离测试，不应出现在新轮次', job_url: 'https://jobs.example.com/agent-loop/1' } })).json.data;
    app2 = (await server.request('/api/v1/applications/manual', { method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-loop-context-2' }, body: { company_name: '上下文新公司', job_title: '新岗位', has_applied: true, status: 'applied', applied_at: '2026-11-02T04:00:00Z', applied_at_precision: 'date', jd_summary: '新岗位JD-BETA 这是当前轮次应携带的岗位要求', job_url: 'https://jobs.example.com/agent-loop/2' } })).json.data;
    assert.ok(app1?.id && app2?.id, JSON.stringify({ app1, app2 }));
  });
  after(async () => {
    await server?.stop();
    await new Promise((resolve) => modelServer?.close(resolve));
  });

  async function send(sessionId, message) {
    const response = await fetch(`${server.base}/api/v1/agent/sessions/${sessionId}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.base, Cookie: cookie },
      body: JSON.stringify({ message })
    });
    const text = await response.text();
    let final = null;
    for (const block of text.split('\n\n')) {
      const event = block.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
      const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
      if (event === 'message') final = JSON.parse(data);
    }
    return final;
  }

  it('解析 tool_calls、执行工具并把最终自然语言消息写入会话', async () => {
    requestCount = 0;
    const session = (await server.request('/api/v1/agent/sessions', { method: 'POST', cookie, body: {} })).json.data;
    const result = await send(session.id, '查询长期未反馈岗位');
    assert.ok(result?.message, 'no final message');
    assert.match(result.message.content, /模型完成/);
    assert.equal(requestCount, 2);
    assert.equal(sawTools, true);
    assert.equal(sawAuth, true);
    assert.equal(result.message.meta.read_only, true);
    const messages = (await server.request(`/api/v1/agent/sessions/${session.id}/messages`, { cookie })).json.data.messages;
    assert.equal(messages.some((message) => message.role === 'assistant' && message.content.includes('模型完成')), true);
    assert.equal(messages.some((message) => message.content.includes('tool_call_id')), false);
  });

  it('模型超时/失败时仍落盘可见错误消息与重试文本，不静默消失', async () => {
    const session = (await server.request('/api/v1/agent/sessions', { method: 'POST', cookie, body: {} })).json.data;
    const response = await fetch(`${server.base}/api/v1/agent/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.base, Cookie: cookie },
      body: JSON.stringify({ message: 'fail-model please' })
    });
    const text = await response.text();
    const events = text.split('\n\n').map((block) => {
      const event = block.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
      const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
      return { event, data: data ? JSON.parse(data) : null };
    }).filter((item) => item.event);
    const message = events.find((item) => item.event === 'message')?.data?.message;
    assert.equal(message?.meta?.is_error, true);
    assert.equal(message?.meta?.retry_text, 'fail-model please');
    assert.ok(events.some((item) => item.event === 'error'));
    const stored = (await server.request(`/api/v1/agent/sessions/${session.id}/messages`, { cookie })).json.data.messages;
    assert.ok(stored.some((item) => item.role === 'assistant' && item.meta?.is_error === true));
  });

  it('切换岗位后旧 JD 不再进入模型上下文，仅保留边界后的消息', async () => {
    const session = (await server.request('/api/v1/agent/sessions', { method: 'POST', cookie, body: { context_application_id: app1.id } })).json.data;
    await send(session.id, '先查一下旧岗位');
    const patched = await server.request(`/api/v1/agent/sessions/${session.id}/context`, {
      method: 'PATCH', cookie, body: { context_application_id: app2.id }
    });
    assert.equal(patched.status, 200, patched.text);
    requestBodies = [];
    await send(session.id, '现在看新岗位');
    const payload = JSON.stringify(requestBodies);
    assert.ok(payload.includes('新岗位JD-BETA'), payload.slice(0, 800));
    assert.ok(!payload.includes('旧岗位机密JD-ALPHA'), payload);
  });

  it('单轮多个 tool_calls 也共享 6 次总预算，避免一次调用放大成本', async () => {
    requestCount = 0;
    const session = (await server.request('/api/v1/agent/sessions', { method: 'POST', cookie, body: {} })).json.data;
    const result = await send(session.id, 'multi tools please');
    assert.ok(result?.message);
    assert.match(result.message.content, /已根据已读取的工具数据整理/);
    assert.equal(requestCount, 3);
    const db = new DatabaseSync(path.join(server.dir, 'tounar.sqlite'));
    try {
      const runs = db.prepare('SELECT COUNT(*) AS n FROM agent_tool_runs WHERE session_id = ?').get(session.id);
      assert.equal(Number(runs.n), 6);
    } finally { db.close(); }
  });

  it('模型持续返回 tool_calls 时最多执行 6 步后收敛，不死循环', async () => {
    requestCount = 0;
    const session = (await server.request('/api/v1/agent/sessions', { method: 'POST', cookie, body: {} })).json.data;
    const result = await send(session.id, 'loop please');
    assert.ok(result?.message);
    assert.match(result.message.content, /已根据已读取的工具数据整理/);
    assert.equal(requestCount, 7);
    const db = new DatabaseSync(path.join(server.dir, 'tounar.sqlite'));
    try {
      const runs = db.prepare('SELECT COUNT(*) AS n FROM agent_tool_runs WHERE session_id = ?').get(session.id);
      assert.equal(Number(runs.n), 6);
    } finally { db.close(); }
  });
});
