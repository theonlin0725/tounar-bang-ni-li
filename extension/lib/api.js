/* Minimal API client for the extension. Never sends cookies; device token only. */
(function () {
  async function request(path, { method = 'GET', body, token, serverUrl } = {}) {
    const base = String(serverUrl || '').replace(/\/$/, '');
    if (!base) throw { code: 'NO_SERVER', message: '尚未设置后台地址' };
    let response;
    try {
      response = await fetch(base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit'
      });
    } catch (err) {
      throw { code: 'NETWORK_UNREACHABLE', message: '后台暂时不可达，事件已留在本地队列', retryable: true };
    }
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const error = payload?.error || {};
      throw {
        status: response.status,
        code: error.code || `HTTP_${response.status}`,
        message: error.message || '请求失败',
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
