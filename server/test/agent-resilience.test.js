import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

describe('v1.1.2 agent LLM resilience', () => {
  let mock;
  let chatAgent;
  let mode = 'array';
  let calls = [];
  before(async () => {
    mock = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      calls.push({ model: body.model, max_tokens: body.max_tokens, response_format: body.response_format });
      const name = calls.length;
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'array') {
        res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: [{ type: 'text', text: '数组分片内容' }] }, finish_reason: 'stop' }] }));
        return;
      }
      if (mode === 'inband') {
        if (name === 1) { res.end(JSON.stringify({ error: { code: 'rate_limit', message: 'temporary rate limit' } })); return; }
        res.end(JSON.stringify({ choices: [{ message: { content: '内嵌错误后恢复' }, finish_reason: 'stop' }] }));
        return;
      }
      if (mode === 'truncate') {
        if (name === 1) { res.end(JSON.stringify({ choices: [{ message: { content: '', reasoning: 'long reasoning' }, finish_reason: 'length' }] })); return; }
        res.end(JSON.stringify({ choices: [{ message: { content: '推理截断后恢复' }, finish_reason: 'stop' }] }));
        return;
      }
      if (mode === 'format400') {
        if (name === 1) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'response_format unsupported' } })); return; }
        res.end(JSON.stringify({ choices: [{ message: { content: '无 response_format 成功' }, finish_reason: 'stop' }] }));
        return;
      }
      if (mode === 'fallback') {
        if (body.model === 'main-model') { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'upstream down' } })); return; }
        res.end(JSON.stringify({ choices: [{ message: { content: 'fallback success' }, finish_reason: 'stop' }] }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    });
    await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
    process.env.AGENT_API_URL = `http://127.0.0.1:${mock.address().port}/v1/chat/completions`;
    process.env.AGENT_API_KEY = 'test-key';
    process.env.AGENT_MODEL = 'main-model';
    process.env.AGENT_FALLBACK_MODEL = 'fallback-model';
    process.env.AGENT_FAKE_MODE = 'false';
    ({ chatAgent } = await import('../src/modules/agent/llm.js'));
  });
  after(async () => { await new Promise((resolve) => mock.close(resolve)); });
  async function ask() {
    calls = [];
    return chatAgent({ messages: [{ role: 'user', content: 'hello' }], maxTokens: 2800 });
  }

  it('兼容 OpenRouter 数组分片 content，并默认使用提升后的 token 上限', async () => {
    mode = 'array';
    const result = await ask();
    assert.equal(result.content, '数组分片内容');
    assert.equal(calls[0].max_tokens, 2800);
  });

  it('HTTP 200 内嵌 error 会自动重试并恢复', async () => {
    mode = 'inband';
    const result = await ask();
    assert.equal(result.content, '内嵌错误后恢复');
    assert.equal(calls.length, 2);
  });

  it('finish_reason=length 且 reasoning 吃光正文时自动重试', async () => {
    mode = 'truncate';
    const result = await ask();
    assert.equal(result.content, '推理截断后恢复');
    assert.equal(calls.length, 2);
  });

  it('上游拒绝 response_format 时自动降级重试且不重复透传', async () => {
    mode = 'format400';
    calls = [];
    const result = await chatAgent({ messages: [{ role: 'user', content: 'json please' }], responseFormat: { type: 'json_object' } });
    assert.equal(result.content, '无 response_format 成功');
    assert.equal(calls.length, 2, JSON.stringify(calls));
    assert.equal(calls[0].response_format?.type, 'json_object');
    assert.equal(calls[1].response_format, undefined);
  });

  it('主模型 5xx 时自动切换 AGENT_FALLBACK_MODEL', async () => {
    mode = 'fallback';
    const result = await ask();
    assert.equal(result.content, 'fallback success');
    assert.ok(calls.some((call) => call.model === 'fallback-model'));
  });
});
