import { config } from '../../config.js';
import { AppError } from '../../util.js';

/* v1.1.0 Agent gateway: OpenAI-compatible Chat Completions + tool_calls.
 * Config priority is resolved in config.js: AGENT_* > OPENROUTER_* > AI_*.
 * Keys never leave the server; the frontend only sees final text/status. */

export function agentAvailable() {
  return Boolean(config.agentApiUrl && config.agentApiKey);
}

function endpoint() {
  const base = String(config.agentApiUrl || '').replace(/\/$/, '');
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function headers() {
  const result = {
    'Content-Type': 'application/json',
    ...(config.agentApiKey ? { Authorization: `Bearer ${config.agentApiKey}` } : {})
  };
  if (config.agentProvider === 'openrouter') {
    result['HTTP-Referer'] = config.appBaseUrl || 'https://bangnili.app.workbuddy.host';
    result['X-Title'] = 'Tounar BangNiLi';
  }
  return result;
}

export async function chatAgent({ messages, tools = [], toolChoice = 'auto', temperature = 0.2, maxTokens = 1200 } = {}) {
  if (!agentAvailable()) {
    throw new AppError(503, 'AGENT_NOT_CONFIGURED', 'AI 求职助手尚未配置模型网关（AGENT_API_URL/AGENT_API_KEY 或 OPENROUTER_API_KEY）', { retryable: false });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.agentTimeoutMs);
  let response;
  try {
    response = await fetch(endpoint(), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: config.agentModel || 'default',
        temperature,
        max_tokens: maxTokens,
        messages,
        ...(tools.length ? { tools, tool_choice: toolChoice } : {})
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new AppError(504, 'AGENT_TIMEOUT', 'AI 助手响应超时，请稍后重试', { retryable: true });
    throw new AppError(503, 'AGENT_UNAVAILABLE', 'AI 助手服务连接失败，请稍后重试', { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  let payload;
  try { payload = await response.json(); } catch { throw new AppError(502, 'AGENT_INVALID_RESPONSE', 'AI 助手返回内容无法解析', { retryable: true }); }
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new AppError(503, 'AGENT_UNAUTHORIZED', 'AI 助手模型鉴权失败，请管理员检查服务端配置', { retryable: false });
    throw new AppError(503, 'AGENT_UNAVAILABLE', 'AI 助手模型暂时不可用，请稍后重试', { retryable: response.status >= 500 || response.status === 429 });
  }
  const message = payload?.choices?.[0]?.message || {};
  const content = String(message.content || '').trim();
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (!content && !toolCalls.length) throw new AppError(502, 'AGENT_INVALID_RESPONSE', 'AI 助手没有返回有效内容', { retryable: true });
  return {
    content,
    toolCalls,
    model: payload?.model || config.agentModel || null,
    usage: payload?.usage || null
  };
}
