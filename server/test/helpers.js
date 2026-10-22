import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RUNS_ROOT = path.join(ROOT, '.tmp', 'tests');

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export async function startTestServer({ name, env = {}, scheduler = false, wipe = true, port: fixedPort = null } = {}) {
  if (!name) throw new Error('test server needs a name');
  const dir = path.join(RUNS_ROOT, name);
  if (wipe) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const port = fixedPort || await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dir,
      PORT: String(port),
      APP_BASE_URL: base,
      APP_ENV: 'test',
      ENABLE_SCHEDULER: scheduler ? '1' : '0',
      MAIL_MODE: 'outbox',
      IMAP_HOST: '127.0.0.1',
      IMAP_PORT: '1',
      IMAP_CONNECT_TIMEOUT_MS: '1500',
      OTP_RESEND_SECONDS: '0',
      OTP_MAX_PER_HOUR: '200',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const timer = setInterval(() => {
      if (stdout.includes('"event":"listening"')) { clearInterval(timer); resolve(); return; }
      if (child.exitCode != null) { clearInterval(timer); reject(new Error(`server exited early: ${stderr || stdout}`)); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error(`server did not start: ${stderr || stdout}`)); }
    }, 50);
  });

  const agent = {
    base, dir, port, child,
    get log() { return stdout + stderr; },
    outboxDir: path.join(dir, 'outbox'),
    async request(route, { method = 'GET', body, cookie, token, headers = {}, origin } = {}) {
      const res = await fetch(base + route, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          Origin: origin === undefined ? base : origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual'
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, json, text, headers: res.headers, cookie: firstCookie(res) };
    },
    latestOutbox(kind = null, email = null) {
      if (!fs.existsSync(agent.outboxDir)) return null;
      const records = [];
      for (const file of fs.readdirSync(agent.outboxDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const record = JSON.parse(fs.readFileSync(path.join(agent.outboxDir, file), 'utf8'));
          record.__file = file;
          records.push(record);
        } catch { /* ignore */ }
      }
      return records
        .filter((r) => !kind || r.kind === kind)
        .filter((r) => !email || String(r.to || '').toLowerCase() === email.toLowerCase())
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.__file).localeCompare(String(b.__file)))
        .at(-1) || null;
    },
    async readOtpCode(email) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const record = agent.latestOutbox('otp', email);
        if (record?.metadata?.dev_code) return record.metadata.dev_code;
        await new Promise((r) => setTimeout(r, 60));
      }
      throw new Error(`no OTP in outbox for ${email}`);
    },
    async requestOtp(email) {
      return agent.request('/api/v1/auth/request-otp', { method: 'POST', body: { email } });
    },
    async login(email) {
      const requested = await agent.requestOtp(email);
      if (requested.status !== 200) throw new Error(`request-otp failed: ${requested.status} ${requested.text}`);
      const code = await agent.readOtpCode(email);
      const res = await agent.request('/api/v1/auth/verify-otp', { method: 'POST', body: { email, code } });
      if (res.status !== 200) throw new Error(`verify-otp failed: ${res.status} ${res.text}`);
      return { cookie: res.cookie, session: res.json, code };
    },
    async reauth(cookie, email) {
      const requested = await agent.requestOtp(email);
      if (requested.status !== 200) throw new Error(`request-otp failed: ${requested.status} ${requested.text}`);
      const code = await agent.readOtpCode(email);
      return agent.request('/api/v1/auth/reauthenticate', { method: 'POST', cookie, body: { email, code } });
    },
    async pairDevice(cookie, deviceName = 'Test Chrome') {
      const created = await agent.request('/api/v1/plugin-pairings', { method: 'POST', body: { device_name: deviceName } });
      const pair = created.json.data;
      const approved = await agent.request('/api/v1/plugin-pairings/approve', { method: 'POST', cookie, body: { code: pair.code } });
      if (approved.status !== 200) throw new Error(`approve failed: ${approved.text}`);
      const exchanged = await agent.request('/api/v1/plugin-pairings/exchange', {
        method: 'POST', body: { request_id: pair.request_id, request_secret: pair.request_secret }
      });
      if (exchanged.status !== 200) throw new Error(`exchange failed: ${exchanged.text}`);
      return { ...exchanged.json.data, pairing: pair };
    },
    internalToken() {
      return fs.readFileSync(path.join(dir, 'internal-tick.token'), 'utf8').trim();
    },
    async tick(body = {}) {
      return agent.request('/api/v1/internal/tick', {
        method: 'POST', headers: { 'X-Internal-Token': agent.internalToken() }, body
      });
    },
    eventBatch(token, events) {
      return agent.request('/api/v1/events/batch', { method: 'POST', token, body: { schema_version: 'C1', events } });
    },
    async stop({ keepData = true } = {}) {
      if (!keepData && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      if (child.exitCode == null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
          child.on('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
    }
  };
  return agent;
}

function firstCookie(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!list.length) {
    const single = res.headers.get('set-cookie');
    return single ? single.split(';')[0] : null;
  }
  return list[0].split(';')[0];
}

export function strongViewEvent(overrides = {}) {
  return {
    client_event_id: `evt_view_${Math.random().toString(36).slice(2, 12)}`,
    event_type: 'job_viewed',
    source_method: 'plugin',
    site_key: 'generic',
    adapter_version: '1.0.0',
    schema_version: 'C1',
    occurred_at: '2026-10-20T02:00:00.000Z',
    observed_at: '2026-10-20T02:00:03.400Z',
    evidence_level: 'strong',
    evidence_code: 'visible-dwell-3000ms',
    payload: {
      company_name: '示例科技',
      job_title: '产品运营',
      site_job_id: 'job-1001',
      job_url: 'https://jobs.example.com/job/1001?utm_source=x',
      jd_summary: '负责产品运营与数据分析',
      location: '上海'
    },
    ...overrides
  };
}
