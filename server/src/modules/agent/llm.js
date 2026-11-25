import { config } from '../../config.js';
import { AppError, newId } from '../../util.js';

/* v1.1.2 Agent gateway: OpenAI-compatible Chat Completions + tool_calls.
 * Handles OpenRouter array content, in-band errors, reasoning truncation,
 * bounded retries, optional fallback model and privacy-preserving diagnostics.
 * Keys never leave the server. */

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

function extractMessageText(message = {}) {
  const raw = message?.content;
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    return raw.map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      return '';
    }).join('').trim();
  }
  if (raw && typeof raw === 'object' && typeof raw.text === 'string') return raw.text.trim();
  return '';
}
function extractReasoning(message = {}) {
  const value = message?.reasoning ?? message?.reasoning_content ?? message?.reasoning_text;
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((part) => typeof part === 'string' ? part : part?.text || '').join('').trim();
  return '';
}
function retryableError(code, message, extra = {}) {
  return new AppError(503, code, message, { retryable: true, ...extra });
}
function logDiagnostic(event, fields) {
  try {
    console.error(JSON.stringify({
      level: 'warn', event,
      request_id: fields.request_id,
      provider: config.agentProvider,
      model: fields.model || config.agentModel || null,
      http_status: fields.http_status ?? null,
      finish_reason: fields.finish_reason || null,
      content_len: fields.content_len ?? null,
      reasoning_len: fields.reasoning_len ?? null,
      tool_calls_len: fields.tool_calls_len ?? null,
      attempt: fields.attempt,
      latency_ms: fields.latency_ms ?? null,
      error_code: fields.error_code || null
    }));
  } catch { /* logging must never break the request */ }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function retryDelay(attempt) { return attempt === 0 ? 600 : 1800; }

export async function chatAgent({
  messages, tools = [], toolChoice = 'auto', temperature = 0.2,
  maxTokens = config.agentMaxTokens, responseFormat = null,
  timeoutMs = config.agentTimeoutMs, reasoningEffort = config.openrouterReasoningEffort || null
} = {}) {
  if (!agentAvailable()) {
    throw new AppError(503, 'AGENT_NOT_CONFIGURED', 'AI 求职助手尚未配置模型网关（AGENT_API_URL/AGENT_API_KEY 或 OPENROUTER_API_KEY）', { retryable: false });
  }
  const requestId = newId('agentreq');
  const fallbackModel = String(config.agentFallbackModel || '').trim();
  let currentMaxTokens = Number(maxTokens) || config.agentMaxTokens;
  let useResponseFormat = Boolean(responseFormat);
  let lastError = null;
  let attempts = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    attempts = attempt + 1;
    const model = attempt > 0 && fallbackModel ? fallbackModel : (config.agentModel || 'default');
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || config.agentTimeoutMs));
    let response;
    let payload;
    let message = {};
    try {
      response = await fetch(endpoint(), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          model,
          ...(new URL(endpoint()).hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}),
          temperature,
          max_tokens: currentMaxTokens,
          messages,
          ...(tools.length ? { tools, tool_choice: toolChoice } : {}),
          ...(useResponseFormat ? { response_format: responseFormat } : {}),
          ...((reasoningEffort && (config.agentProvider === 'openrouter' || config.agentApiUrl.includes('openrouter')))
            ? { reasoning: { effort: reasoningEffort } } : {})
        }),
        signal: controller.signal
      });
      try { payload = await response.json(); } catch {
        lastError = retryableError('AGENT_INVALID_RESPONSE', 'AI 助手返回内容无法解析');
      }
    } catch (error) {
      lastError = error?.name === 'AbortError'
        ? retryableError('AGENT_TIMEOUT', 'AI 助手响应超时，请稍后重试')
        : retryableError('AGENT_UNAVAILABLE', 'AI 助手服务连接失败，请稍后重试');
    } finally {
      clearTimeout(timer);
    }
    const latency = Date.now() - started;
    if (lastError && !payload) {
      logDiagnostic('agent_llm_retry', { request_id: requestId, model, attempt: attempts, latency_ms: latency, error_code: lastError.code });
      if (attempt < 2) { await sleep(retryDelay(attempt)); continue; }
      throw lastError;
    }
    const providerError = payload?.error;
    if (providerError) {
      const providerMessage = String(providerError.message || providerError.code || '模型网关返回错误');
      lastError = retryableError(
        /auth|key|unauthor/i.test(providerMessage) ? 'AGENT_UNAUTHORIZED' : 'AGENT_PROVIDER_ERROR',
        /auth|key|unauthor/i.test(providerMessage) ? 'AI 助手模型鉴权失败，请管理员检查服务端配置' : 'AI 助手模型暂时不可用，请稍后重试',
        { retryable: !/auth|key|unauthor/i.test(providerMessage) }
      );
      logDiagnostic('agent_llm_retry', { request_id: requestId, model, attempt: attempts, latency_ms: latency, error_code: lastError.code, http_status: response?.status || 200 });
      if (useResponseFormat && response?.status === 400) {
        useResponseFormat = false;
        if (attempt < 2) { await sleep(200); continue; }
      }
      if (lastError.retryable && attempt < 2) { await sleep(retryDelay(attempt)); continue; }
      throw lastError;
    }
    if (!response?.ok) {
      const code = [401, 403].includes(response?.status) ? 'AGENT_UNAUTHORIZED' : 'AGENT_UNAVAILABLE';
      lastError = new AppError(503, code, code === 'AGENT_UNAUTHORIZED' ? 'AI 助手模型鉴权失败，请管理员检查服务端配置' : 'AI 助手模型暂时不可用，请稍后重试', { retryable: code !== 'AGENT_UNAUTHORIZED' });
      // Some OpenAI-compatible gateways reject response_format; retry once without it.
      if (useResponseFormat && response?.status === 400) {
        useResponseFormat = false;
        logDiagnostic('agent_llm_retry', { request_id: requestId, model, attempt: attempts, latency_ms: latency, http_status: 400, error_code: 'RESPONSE_FORMAT_UNSUPPORTED' });
        if (attempt < 2) { await sleep(200); continue; }
      }
      logDiagnostic('agent_llm_retry', { request_id: requestId, model, attempt: attempts, latency_ms: latency, http_status: response?.status, error_code: code });
      if (lastError.retryable && attempt < 2) { await sleep(retryDelay(attempt)); continue; }
      throw lastError;
    }
    message = payload?.choices?.[0]?.message || {};
    const content = extractMessageText(message);
    const reasoning = extractReasoning(message);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const finishReason = payload?.choices?.[0]?.finish_reason || null;
    if (!content && !toolCalls.length) {
      const reasoningTruncated = finishReason === 'length' && reasoning.length > 0;
      lastError = reasoningTruncated
        ? retryableError('AGENT_REASONING_TRUNCATED', '模型思考预算耗尽，正在重试生成正文')
        : retryableError('AGENT_INVALID_RESPONSE', 'AI 助手没有返回有效内容');
      logDiagnostic('agent_llm_retry', {
        request_id: requestId, model, attempt: attempts, latency_ms: latency, finish_reason: finishReason,
        content_len: content.length, reasoning_len: reasoning.length, tool_calls_len: toolCalls.length,
        error_code: lastError.code
      });
      if (attempt < 2) {
        currentMaxTokens = Math.min(12000, Math.max(3600, currentMaxTokens * 2));
        if (config.agentProvider === 'openrouter' || config.agentApiUrl.includes('openrouter')) reasoningEffort = 'low';
        await sleep(retryDelay(attempt));
        continue;
      }
      throw lastError;
    }
    return {
      content, toolCalls, model: payload?.model || model,
      usage: payload?.usage || null,
      finishReason, reasoningChars: reasoning.length, attempts
    };
  }
  throw lastError || new AppError(502, 'AGENT_INVALID_RESPONSE', 'AI 助手没有返回有效内容', { retryable: true });
}
