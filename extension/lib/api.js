/* Minimal API client for the extension. Never sends cookies; device token only. */
(function () {
  const DEFAULT_TIMEOUT_MS = 8000;

  /* 线上平台需要 sharecode 才能访问时，允许把后台地址写成
   * https://域名/?sharecode=XXXX —— 这里把它拆出来，后续每个请求自动带上，
   * 免得插件请求被平台的 403「链接不完整」拦掉。 */
  function splitServer(raw) {
    const url = new URL(raw);
    const share = url.searchParams.get('sharecode');
    url.search = '';
    url.hash = '';
    return { base: url.toString().replace(/\/$/, ''), share };
  }

  function withShare(url, share) {
    if (!share) return url;
    return url + (url.includes('?') ? '&' : '?') + 'sharecode=' + encodeURIComponent(share);
  }

  /** 把 fetch 的笼统失败拆成用户能自查的原因：地址格式 / 超时 / 连不上。 */
  function describeUrl(base) {
    let parsed;
    try { parsed = new URL(base); } catch { return { code: 'BAD_URL', message: `后台地址格式不对：${base}` }; }
    if (!/^https?:$/.test(parsed.protocol)) {
      return { code: 'BAD_URL', message: `后台地址必须以 http:// 或 https:// 开头：${base}` };
    }
    return null;
  }

  async function request(path, { method = 'GET', body, token, serverUrl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const raw = String(serverUrl || '').trim();
    if (!raw) throw { code: 'NO_SERVER', message: '尚未设置后台地址' };
    const badUrl = describeUrl(raw);
    if (badUrl) throw badUrl;
    const { base, share } = splitServer(raw);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(withShare(base + path, share), {
        method,
        headers: {
          'Content-Type': 'application/json',
          // 托管平台网关会覆盖 Authorization，设备凭证改走自定义头 X-Device-Token（已证实可穿透）；
          // 同时保留 Authorization 以兼容无网关的本地后台。
          ...(token ? { 'X-Device-Token': token, Authorization: `Bearer ${token}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        signal: controller.signal
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw {
          code: 'TIMEOUT',
          message: `${base} 在 ${Math.round(timeoutMs / 1000)} 秒内没有响应（可能被防火墙/代理拦住，或服务卡住）`,
          retryable: true
        };
      }
      throw {
        code: 'NETWORK_UNREACHABLE',
        message: `连不上 ${base}：该地址上没有服务在监听（后台可能没启动），或被浏览器拦截`,
        retryable: true
      };
    } finally {
      clearTimeout(timer);
    }
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const error = payload?.error || {};
      const fallback = response.status === 404
        ? `${base}${path} 返回 404：这个地址上的服务不是帮你理，或版本太旧`
        : `${base} 返回 HTTP ${response.status}`;
      throw {
        status: response.status,
        code: error.code || `HTTP_${response.status}`,
        message: error.message || fallback,
        retryable: !!error.retryable,
        details: error.details || null
      };
    }
    return payload;
  }

  async function health(serverUrl) {
    return request('/api/v1/health', { serverUrl });
  }
  async function createPairing(serverUrl, deviceName) {
    return request('/api/v1/plugin-pairings', { method: 'POST', serverUrl, body: { device_name: deviceName } });
  }
  async function exchangePairing(serverUrl, requestId, requestSecret) {
    return request('/api/v1/plugin-pairings/exchange', {
      method: 'POST', serverUrl, body: { request_id: requestId, request_secret: requestSecret }
    });
  }
  async function deviceSelf(serverUrl, token) {
    return request('/api/v1/plugin-devices/self', { serverUrl, token });
  }
  async function heartbeat(serverUrl, token) {
    return request('/api/v1/plugin-devices/heartbeat', { method: 'POST', serverUrl, token, body: {} });
  }
  async function cleanupAck(serverUrl, token, bindingVersion) {
    return request('/api/v1/plugin-devices/cleanup-ack', {
      method: 'POST', serverUrl, token, body: { binding_version: bindingVersion }
    });
  }
  async function uploadEvents(serverUrl, token, events) {
    return request('/api/v1/events/batch', {
      method: 'POST', serverUrl, token, body: { schema_version: 'C1', events }
    });
  }

  globalThis.TounarApi = {
    request, health, createPairing, exchangePairing, deviceSelf, heartbeat, cleanupAck, uploadEvents
  };
})();
