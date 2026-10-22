import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

describe('auth / 准入（BT01、BT02、G01 替代实现）', () => {
  let server;
  before(async () => { server = await startTestServer({ name: 'auth' }); });
  after(async () => { await server.stop(); });

  it('未登录访问业务接口返回 401，且不泄露存在性', async () => {
    const me = await server.request('/api/v1/me');
    assert.equal(me.status, 401);
    assert.equal(me.json.error.code, 'UNAUTHENTICATED');
    const ledger = await server.request('/api/v1/ledger');
    assert.equal(ledger.status, 401);
    const app = await server.request('/api/v1/applications/app_nonexistent');
    assert.equal(app.status, 401);
  });

  it('邮箱格式错误直接 400', async () => {
    const res = await server.request('/api/v1/auth/request-otp', { method: 'POST', body: { email: 'not-an-email' } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'VALIDATION_ERROR');
  });

  it('未准入邮箱：OTP 中性响应，但校验时 403 且不建业务数据', async () => {
    const res = await server.requestOtp('outsider@example.com');
    assert.equal(res.status, 200);
    const code = await server.readOtpCode('outsider@example.com');
    const verify = await server.request('/api/v1/auth/verify-otp', { method: 'POST', body: { email: 'outsider@example.com', code } });
    assert.equal(verify.status, 403);
    assert.equal(verify.json.error.code, 'NOT_ALLOWLISTED');
    assert.equal(verify.cookie, null);
  });

  it('验证码错误计数，超过尝试上限后锁定', async () => {
    await server.requestOtp('demo@tounar.local');
    const code = await server.readOtpCode('demo@tounar.local');
    const wrong = String(Number(code) + 1).padStart(6, '0');
    for (let i = 1; i <= 4; i += 1) {
      const res = await server.request('/api/v1/auth/verify-otp', { method: 'POST', body: { email: 'demo@tounar.local', code: wrong } });
      assert.equal(res.status, 400, `attempt ${i}`);
      assert.equal(res.json.error.code, 'OTP_INVALID');
    }
    const fifth = await server.request('/api/v1/auth/verify-otp', { method: 'POST', body: { email: 'demo@tounar.local', code: wrong } });
    assert.equal(fifth.status, 400);
    const locked = await server.request('/api/v1/auth/verify-otp', { method: 'POST', body: { email: 'demo@tounar.local', code } });
    assert.equal(locked.status, 429);
    assert.equal(locked.json.error.code, 'OTP_TOO_MANY');
  });

  it('登录成功：HttpOnly 会话 + 会话接口 + logout 撤销', async () => {
    const login = await server.login('demo@tounar.local');
    assert.match(login.cookie, /^tounar_session=/);
    const me = await server.request('/api/v1/me', { cookie: login.cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.data.user.email, 'demo@tounar.local');
    assert.equal(me.json.data.capabilities.auth_mode, 'local_email_otp');
    const logout = await server.request('/api/v1/auth/logout', { method: 'POST', cookie: login.cookie });
    assert.equal(logout.status, 200);
    const after = await server.request('/api/v1/me', { cookie: login.cookie });
    assert.equal(after.status, 401);
  });

  it('CSRF：带会话但无 Origin 的写请求被拒绝', async () => {
    const login = await server.login('peer@tounar.local');
    const res = await server.request('/api/v1/plugin-pairings/approve', {
      method: 'POST', cookie: login.cookie, origin: 'null', body: { code: 'ABCDEFGH' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'CSRF_REJECTED');
  });

  it('重鉴权邮箱不一致被拒绝', async () => {
    const login = await server.login('demo@tounar.local');
    await server.requestOtp('peer@tounar.local');
    const code = await server.readOtpCode('peer@tounar.local');
    const res = await server.request('/api/v1/auth/reauthenticate', {
      method: 'POST', cookie: login.cookie, body: { email: 'peer@tounar.local', code }
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'FORBIDDEN');
  });
});

describe('auth / 限流', () => {
  let server;
  before(async () => { server = await startTestServer({ name: 'auth-rate', env: { OTP_MAX_PER_HOUR: '2' } }); });
  after(async () => { await server.stop(); });

  it('超过每小时上限后 429', async () => {
    assert.equal((await server.requestOtp('demo@tounar.local')).status, 200);
    assert.equal((await server.requestOtp('demo@tounar.local')).status, 200);
    const third = await server.request('/api/v1/auth/request-otp', { method: 'POST', body: { email: 'demo@tounar.local' } });
    assert.equal(third.status, 429);
    assert.equal(third.json.error.code, 'RATE_LIMITED');
  });
});

describe('auth / 验证码过期', () => {
  let server;
  before(async () => { server = await startTestServer({ name: 'auth-expiry', env: { OTP_TTL_MINUTES: '0' } }); });
  after(async () => { await server.stop(); });

  it('过期验证码返回 OTP_EXPIRED，不得登录', async () => {
    await server.requestOtp('demo@tounar.local');
    const code = await server.readOtpCode('demo@tounar.local');
    await new Promise((r) => setTimeout(r, 30));
    const res = await server.request('/api/v1/auth/verify-otp', { method: 'POST', body: { email: 'demo@tounar.local', code } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'OTP_EXPIRED');
  });
});
