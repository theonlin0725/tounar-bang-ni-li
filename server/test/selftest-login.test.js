import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const ENV = {
  APP_ENV: 'development',
  ENABLE_SELFTEST_LOGIN: 'true',
  ALLOWED_EMAILS: 'admin@tounar.local,user@tounar.local',
  ADMIN_EMAILS: 'admin@tounar.local',
  TEST_MAIL_RECIPIENTS: 'admin@tounar.local',
  MAIL_MODE: 'outbox'
};

test('本机管理员自测登录直接回显验证码，不发 OTP 邮件；普通用户不受影响', async () => {
  const server = await startTestServer({ name: 'selftest-admin-login', env: ENV });
  try {
    const requested = await server.requestOtp('admin@tounar.local');
    assert.equal(requested.status, 200, requested.text);
    assert.equal(requested.json.selftest, true);
    assert.match(requested.json.selftest_code, /^\d{6}$/);
    assert.equal(server.latestOutbox('otp'), null, '管理员自测不应写发件箱');

    const verified = await server.request('/api/v1/auth/verify-otp', {
      method: 'POST', body: { email: 'admin@tounar.local', code: requested.json.selftest_code }
    });
    assert.equal(verified.status, 200, verified.text);
    const me = await server.request('/api/v1/me', { cookie: verified.cookie });
    assert.equal(me.json.data.user.is_admin, true);
    assert.equal((await server.request('/api/v1/ledger', { cookie: verified.cookie })).status, 200);

    const userRequested = await server.requestOtp('user@tounar.local');
    assert.equal(userRequested.status, 200, userRequested.text);
    assert.equal(userRequested.json.selftest_code, undefined);
    const userCode = await server.readOtpCode('user@tounar.local');
    const userVerified = await server.request('/api/v1/auth/verify-otp', {
      method: 'POST', body: { email: 'user@tounar.local', code: userCode }
    });
    assert.equal(userVerified.status, 200, userVerified.text);
    assert.equal((await server.request('/api/v1/me', { cookie: userVerified.cookie })).json.data.user.is_admin, false);
  } finally { await server.stop(); }
});

test('非 development 环境即使开启开关也不回显自测验证码', async () => {
  const server = await startTestServer({ name: 'selftest-admin-login-prodlike', env: { ...ENV, APP_ENV: 'test' } });
  try {
    const requested = await server.requestOtp('admin@tounar.local');
    assert.equal(requested.status, 200, requested.text);
    assert.equal(requested.json.selftest_code, undefined);
    assert.ok(server.latestOutbox('otp', 'admin@tounar.local'));
  } finally { await server.stop(); }
});
