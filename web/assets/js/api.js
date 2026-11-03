/* A1 接口客户端：同源 Cookie 会话；错误统一为 ApiError；401 交给全局处理（最多回落一次）。 */

export class ApiError extends Error {
  constructor(status, payload = {}, fallbackMessage = '请求失败') {
    const err = payload && payload.error ? payload.error : {};
    super(err.message || fallbackMessage);
    this.name = 'ApiError';
    this.status = status;
    this.code = err.code || `HTTP_${status}`;
    this.retryable = !!err.retryable;
    this.details = err.details || null;
    this.requestId = payload && payload.request_id ? payload.request_id : null;
  }
}

export class NetworkError extends Error {
  constructor(cause) {
    super('网络请求失败，请检查网络后重试');
    this.name = 'NetworkError';
    this.code = 'NETWORK_ERROR';
    this.retryable = true;
    this.cause = cause;
  }
}

let unauthorizedHandler = null;
export function onUnauthorized(fn) { unauthorizedHandler = fn; }

async function request(method, path, options = {}) {
  const headers = { 'Accept': 'application/json', ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  if (options.tounarAction) headers['X-Tounar-Action'] = options.tounarAction;
  let res;
  const controller = options.timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller?.signal
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') {
      const timeout = new NetworkError(cause);
      timeout.code = 'TIMEOUT';
      timeout.message = '请求超时，页面没有卡死；请重试';
      throw timeout;
    }
    throw new NetworkError(cause);
  } finally {
    if (timer) clearTimeout(timer);
  }
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  if (!res.ok) {
    const error = new ApiError(res.status, payload || {});
    if (res.status === 401 && !options.silent401 && unauthorizedHandler) unauthorizedHandler(error);
    throw error;
  }
  return payload;
}

export const api = {
  get: (path, options) => request('GET', path, options),
  post: (path, body, options = {}) => request('POST', path, { ...options, body: body ?? {} }),
  put: (path, body, options = {}) => request('PUT', path, { ...options, body: body ?? {} })
};

export function errorText(error) {
  if (error instanceof ApiError) {
    const base = error.message || '请求失败';
    return error.requestId ? `${base}（code: ${error.code} · request_id: ${error.requestId}）` : `${base}（code: ${error.code}）`;
  }
  return error?.message || '未知错误';
}
