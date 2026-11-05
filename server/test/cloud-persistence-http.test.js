import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, strongViewEvent } from './helpers.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tounar-cloud-http-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
process.env.DATA_DIR = dir;
process.env.PORT = String(port);
process.env.APP_BASE_URL = base;
process.env.APP_ENV = 'development';
process.env.ENABLE_SCHEDULER = 'false';
process.env.ENABLE_SELFTEST_LOGIN = 'true';
process.env.ALLOWED_EMAILS = 'admin@tounar.local';
process.env.ADMIN_EMAILS = 'admin@tounar.local';
process.env.MASTER_KEY = 'ef'.repeat(32);
process.env.CLOUD_SNAPSHOT_STREAM = 'http-unit-test-stream';
process.env.CLOUD_PERSISTENCE_ENABLED = 'false';

const db = await import('../src/db.js');
const persistence = await import('../src/cloud/persistence.js');
const { createServer } = await import('../src/http.js');
const { registerRoutes } = await import('../src/routes/index.js');

const rows = [];
let insertError = null;
const client = {
  database: {
    from(table) {
      assert.equal(table, 'app_sqlite_snapshot_vault');
      return {
        select() { return this; },
        eq(_field, value) { this.stream = value; return this; },
        order() { return this; },
        limit(value) { this.take = value; return this; },
        then(resolve) {
          const data = rows.filter((row) => row.stream === this.stream)
            .sort((a, b) => b.revision - a.revision).slice(0, this.take)
            .map((row) => ({ ...row }));
          return Promise.resolve(resolve({ data, error: null }));
        }
      };
    },
    async rpc(name, args) {
      assert.equal(name, 'append_app_sqlite_snapshot');
      if (insertError) return { data: null, error: insertError };
      const current = Math.max(0, ...rows.filter((row) => row.stream === args.p_stream).map((row) => row.revision));
      if (current !== args.p_expected_revision) return { data: null, error: { code: 'DATABASE_SNAP1' } };
      rows.push({
        id: args.p_id, stream: args.p_stream, revision: args.p_revision,
        payload: args.p_payload, content_sha256: args.p_content_sha256
      });
      return { data: args.p_revision, error: null };
    }
  }
};

let server = null;
async function listen() {
  server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}
async function closeServer() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
}
async function request(route, { method = 'GET', body, cookie, token } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Origin: base,
      Connection: 'close',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const setCookie = response.headers.get('set-cookie');
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null,
    cookie: setCookie ? setCookie.split(';')[0] : null,
    text
  };
}
async function pairDevice(cookie) {
  const created = await request('/api/v1/plugin-pairings', { method: 'POST', body: { device_name: 'Cloud HTTP test' } });
  assert.equal(created.status, 201, created.text);
  const pair = created.json.data;
  const approved = await request('/api/v1/plugin-pairings/approve', { method: 'POST', cookie, body: { code: pair.code } });
  assert.equal(approved.status, 200, approved.text);
  const exchanged = await request('/api/v1/plugin-pairings/exchange', {
    method: 'POST', body: { request_id: pair.request_id, request_secret: pair.request_secret }
  });
  assert.equal(exchanged.status, 200, exchanged.text);
  return exchanged.json.data;
}

after(async () => {
  await closeServer();
  db.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('HTTP 全链路：失败不 ACK；会话、设备、台账和幂等随云快照恢复', async () => {
  await persistence.initCloudPersistence({ injectedClient: client });
  db.getDb();
  persistence.markCloudSnapshotDirty();
  await persistence.flushCloudPersistence();
  registerRoutes();
  await listen();

  const requested = await request('/api/v1/auth/request-otp', { method: 'POST', body: { email: 'admin@tounar.local' } });
  assert.equal(requested.status, 200, requested.text);
  const verified = await request('/api/v1/auth/verify-otp', {
    method: 'POST', body: { email: 'admin@tounar.local', code: requested.json.selftest_code }
  });
  assert.equal(verified.status, 200, verified.text);
  const cookie = verified.cookie;
  assert.ok(cookie);

  const device = await pairDevice(cookie);
  const event = strongViewEvent({
    client_event_id: 'evt_cloud_http_restore',
    payload: {
      company_name: '云恢复测试公司', job_title: '隔离测试岗', site_job_id: 'cloud-http-job',
      job_url: 'https://jobs.example.com/job/cloud-http', jd_summary: '仅用于隔离恢复测试', location: '深圳'
    }
  });
  const accepted = await request('/api/v1/events/batch', {
    method: 'POST', token: device.device_token, body: { schema_version: 'C1', events: [event] }
  });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.json.results[0].accepted, true);
  const applicationId = accepted.json.results[0].application_id;
  assert.ok(applicationId);

  insertError = { code: 'TEMPORARY_FAILURE' };
  const notAcknowledged = await request('/api/v1/plugin-pairings', { method: 'POST', body: { device_name: 'Must not ACK' } });
  assert.equal(notAcknowledged.status, 503);
  assert.equal(notAcknowledged.json.error.code, 'PERSISTENCE_UNAVAILABLE');
  assert.equal(notAcknowledged.json.error.retryable, true);
  const degraded = await request('/api/v1/health');
  assert.equal(degraded.json.cloud_persistence.state, 'degraded');
  assert.equal(degraded.json.cloud_persistence.pending, true);
  assert.equal(degraded.json.cloud_persistence.last_error_code, 'TEMPORARY_FAILURE');

  insertError = null;
  const retried = await request('/api/v1/me', { cookie });
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.json.data.user.is_admin, true);

  const beforeBackground = persistence.cloudPersistenceStatus().revision;
  db.run("UPDATE users SET last_login_at = '2026-11-02T03:00:00.000Z' WHERE email_normalized = 'admin@tounar.local'");
  await persistence.flushCloudPersistence();
  assert.ok(persistence.cloudPersistenceStatus().revision > beforeBackground, '非 HTTP 写入也必须进入云快照队列');

  const beforeRestore = await request('/api/v1/ledger?view=viewed&status=all&limit=50', { cookie });
  const matchingBefore = beforeRestore.json.data.items.filter((item) => item.id === applicationId);
  assert.equal(matchingBefore.length, 1);

  await persistence.flushCloudPersistence();
  await closeServer();
  db.closeDb();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(dir, `tounar.sqlite${suffix}`), { force: true });
  const restored = await persistence.initCloudPersistence({ injectedClient: client });
  assert.equal(restored.restored, true);
  await listen();

  const me = await request('/api/v1/me', { cookie });
  assert.equal(me.status, 200, '原管理员会话必须在本地副本删除后仍有效');
  const self = await request('/api/v1/plugin-devices/self', { token: device.device_token });
  assert.equal(self.status, 200, '原插件设备凭证必须仍有效');
  assert.equal(self.json.data.device.id, device.device_id);
  const afterRestore = await request('/api/v1/ledger?view=viewed&status=all&limit=50', { cookie });
  assert.equal(afterRestore.json.data.items.filter((item) => item.id === applicationId).length, 1);

  const duplicate = await request('/api/v1/events/batch', {
    method: 'POST', token: device.device_token, body: { schema_version: 'C1', events: [event] }
  });
  assert.equal(duplicate.status, 200, duplicate.text);
  assert.equal(duplicate.json.results[0].duplicate, true, '恢复后不得丢失事件幂等记录');
  const afterDuplicate = await request('/api/v1/ledger?view=viewed&status=all&limit=50', { cookie });
  assert.equal(afterDuplicate.json.data.items.filter((item) => item.id === applicationId).length, 1);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes('.restore-')), false, '恢复不得留下明文临时库或 WAL/SHM');
});
