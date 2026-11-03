import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer } from './helpers.js';

let server;
function db() { return new DatabaseSync(server.dir + '/tounar.sqlite'); }
function codeHash(code) {
  const key = fs.readFileSync(server.dir + '/master.key', 'utf8').trim();
  return crypto.createHash('sha256').update(`${key}:beta-invite:${String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')}`).digest('hex');
}
function activeInvite({ id, code, max = 10 }) {
  const d = db();
  try {
    d.prepare('UPDATE beta_invites SET active = 0').run();
    d.prepare(`INSERT INTO beta_invites (id, code_hash, max_uses, used_count, active, created_at)
      VALUES (?, ?, ?, 0, 1, ?)`).run(id, codeHash(code), max, new Date().toISOString());
  } finally { d.close(); }
}
function inviteState(id) {
  const d = db();
  try { return d.prepare('SELECT used_count, max_uses, active FROM beta_invites WHERE id=?').get(id); } finally { d.close(); }
}
async function otpAndVerify(email, inviteCode) {
  const requested = await server.requestOtp(email);
  assert.equal(requested.status, 200, requested.text);
  const code = await server.readOtpCode(email);
  return server.request('/api/v1/auth/verify-otp', { method: 'POST', body: { email, code, invite_code: inviteCode } });
}
before(async () => { server = await startTestServer({ name: 'beta-invite', env: { ADMIN_EMAILS: 'admin@tounar.local' } }); });
after(async () => { await server?.stop(); });

it('缺失/错误邀请码不激活、不消耗名额；正确邀请码激活并保持资格', async () => {
  const code = 'BNL-TEST-0001-0001';
  activeInvite({ id: 'inv_basic', code, max: 10 });
  const email = 'invitee1@example.com';
  const requested = await server.requestOtp(email);
  assert.equal(requested.status, 200);
  const otp = await server.readOtpCode(email);
  const missing = await server.request('/api/v1/auth/verify-otp', { method: 'POST', body: { email, code: otp } });
  assert.equal(missing.status, 403);
  assert.equal(missing.json.error.code, 'INVITE_REQUIRED');
  assert.equal(inviteState('inv_basic').used_count, 0);
  const wrongCode = await server.requestOtp(email);
  assert.equal(wrongCode.status, 200, wrongCode.text);
  const wrongOtp = await server.readOtpCode(email);
  const wrong = await server.request('/api/v1/auth/verify-otp', { method: 'POST', body: { email, code: wrongOtp, invite_code: 'BNL-WRONG-0000-0000' } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.error.code, 'INVITE_INVALID');
  assert.equal(inviteState('inv_basic').used_count, 0);
  // OTP is single-use; request a fresh one for successful activation.
  const ok = await otpAndVerify(email, 'BNL-TEST-0001-0001');
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.user.email, email);
  assert.equal(ok.json.user.allowlisted, true);
  assert.equal(inviteState('inv_basic').used_count, 1);
  // Same email again: no invite field, no extra quota.
  const again = await otpAndVerify(email, '');
  assert.equal(again.status, 200, again.text);
  assert.equal(inviteState('inv_basic').used_count, 1);
});

it('管理员不依赖邀请码、不占名额；管理员不是普通体验者', async () => {
  const admin = await otpAndVerify('admin@tounar.local', '');
  assert.equal(admin.status, 200, admin.text);
  assert.equal(admin.json.user.email, 'admin@tounar.local');
  assert.equal(inviteState('inv_basic').used_count, 1);
  const me = await server.request('/api/v1/me', { cookie: admin.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.data.user.is_admin, true);
});

it('第 11 个新邮箱被拒绝，前 10 个并发激活不超额', async () => {
  activeInvite({ id: 'inv_concurrent', code: 'BNL-CONC-2026-0001', max: 10 });
  const emails = Array.from({ length: 11 }, (_, i) => `concurrent${i}@example.com`);
  const otps = await Promise.all(emails.map(async (email) => {
    const r = await server.requestOtp(email);
    assert.equal(r.status, 200, `${email}: ${r.text}`);
    return server.readOtpCode(email);
  }));
  const results = await Promise.all(emails.map((email, i) => server.request('/api/v1/auth/verify-otp', {
    method: 'POST', body: { email, code: otps[i], invite_code: 'BNL-CONC-2026-0001' }
  })));
  const ok = results.filter((r) => r.status === 200);
  const full = results.filter((r) => r.status === 403 && r.json?.error?.code === 'INVITE_FULL');
  assert.equal(ok.length, 10, results.map((r) => `${r.status}:${r.text}`).join('\n'));
  assert.equal(full.length, 1, results.map((r) => `${r.status}:${r.text}`).join('\n'));
  assert.equal(inviteState('inv_concurrent').used_count, 10);
});

it('邀请关闭时新邮箱不能回落到静态白名单激活', async () => {
  const d = db();
  try { d.prepare('UPDATE beta_invites SET active = 0').run(); } finally { d.close(); }
  const requested = await server.requestOtp('closed@example.com');
  assert.equal(requested.status, 200);
  const code = await server.readOtpCode('closed@example.com');
  const res = await server.request('/api/v1/auth/verify-otp', { method: 'POST', body: { email: 'closed@example.com', code, invite_code: 'BNL-CONC-2026-0001' } });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'INVITE_CLOSED');
});

it('重复初始化不会重置已用名额或已激活资格', async () => {
  const beforeState = inviteState('inv_concurrent');
  const d = db();
  try {
    d.prepare(`INSERT OR IGNORE INTO beta_invites (id, code_hash, max_uses, used_count, active, created_at)
      VALUES ('inv_concurrent', ?, 10, 0, 1, ?)`).run(codeHash('BNL-CONC-2026-0001'), new Date().toISOString());
  } finally { d.close(); }
  const afterState = inviteState('inv_concurrent');
  assert.equal(afterState.used_count, beforeState.used_count);
  assert.equal(afterState.max_uses, beforeState.max_uses);
  const login = await server.login('concurrent0@example.com');
  assert.ok(login.cookie);
});
