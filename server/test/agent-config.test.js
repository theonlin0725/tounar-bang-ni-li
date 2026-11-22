import { it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ROOT = path.resolve(import.meta.dirname, '../..');
const run = promisify(execFile);
async function probe(extra) {
  const script = `import { config } from './server/src/config.js'; console.log(JSON.stringify({ agentApiUrl: config.agentApiUrl, agentApiKey: config.agentApiKey, agentModel: config.agentModel, agentProvider: config.agentProvider, aiApiUrl: config.aiApiUrl, aiApiKey: config.aiApiKey, aiModel: config.aiModel, aiProvider: config.aiProvider }));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENT_API_URL: '', AGENT_API_KEY: '', AGENT_MODEL: '',
      OPENROUTER_API_URL: '', OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '',
      AI_API_URL: '', AI_API_KEY: '', AI_MODEL: '', AI_PROVIDER: '',
      ...extra
    }
  });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

it('OpenRouter-only 配置同时供 Agent 与 career-ai 使用', async () => {
  const result = await probe({ OPENROUTER_API_KEY: 'test-key', OPENROUTER_MODEL: 'google/gemini-2.5-flash' });
  assert.equal(result.agentProvider, 'openrouter');
  assert.equal(result.agentApiUrl, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(result.agentModel, 'google/gemini-2.5-flash');
  assert.equal(result.aiApiUrl, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(result.aiApiKey, 'test-key');
  assert.equal(result.aiModel, 'google/gemini-2.5-flash');
  assert.equal(result.aiProvider, 'openai_compatible');
});

it('显式 AGENT_* 优先于 OpenRouter；AI_* 仍可独立指向其他网关', async () => {
  const result = await probe({
    AGENT_API_URL: 'http://127.0.0.1:9/v1/chat/completions', AGENT_API_KEY: 'agent-key', AGENT_MODEL: 'agent-model',
    OPENROUTER_API_KEY: 'or-key', OPENROUTER_MODEL: 'or-model',
    AI_API_URL: 'http://127.0.0.1:8/v1', AI_API_KEY: 'ai-key', AI_MODEL: 'ai-model'
  });
  assert.equal(result.agentApiUrl, 'http://127.0.0.1:9/v1/chat/completions');
  assert.equal(result.agentApiKey, 'agent-key');
  assert.equal(result.agentModel, 'agent-model');
  assert.equal(result.agentProvider, 'agent_custom');
  assert.equal(result.aiApiUrl, 'http://127.0.0.1:8/v1');
  assert.equal(result.aiApiKey, 'ai-key');
});
