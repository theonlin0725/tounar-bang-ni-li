import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, strongViewEvent } from '../../server/test/helpers.js';
import { buildTestExtension } from '../../extension/scripts/make-test-build.mjs';
import { resolveChromiumExecutable } from './browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const out = fs.mkdtempSync(path.join(ROOT, '.tmp', 'backend-switch-'));
let serverA;
let serverB;
let context;

async function pair(server, popup, send) {
  const started = await send('start_pairing', { serverUrl: server.base, deviceName: '后台切换隔离测试' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const approved = await server.request('/api/v1/plugin-pairings/approve', {
    method: 'POST', cookie: (await server.login('demo@tounar.local')).cookie,
    body: { code: started.pending.code }
  });
  assert.equal(approved.status, 200, approved.text);
  const exchanged = await send('poll_pairing_now');
  assert.equal(exchanged.result?.paired, true, JSON.stringify(exchanged));
}

try {
  serverA = await startTestServer({ name: `backend-switch-a-${Date.now()}`, env: { CLOUD_LLM_ENABLED: 'false' } });
  serverB = await startTestServer({ name: `backend-switch-b-${Date.now()}`, env: { CLOUD_LLM_ENABLED: 'false' } });
  const ext = buildTestExtension({ outDir: path.join(out, 'extension') });
  context = await chromium.launchPersistentContext(path.join(out, 'profile'), {
    headless: true,
    executablePath: (await resolveChromiumExecutable()).path,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run', '--no-default-browser-check']
  });
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(sw.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  const send = (type, extra = {}) => popup.evaluate((message) => new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  }), { type, ...extra });

  await pair(serverA, popup, send);
  const oldEvent = strongViewEvent({
    client_event_id: 'evt-old-backend-must-not-move',
    payload: { company_name: '旧后台隔离测试', job_title: '旧后台岗位', site_job_id: 'old-only', job_url: 'https://jobs.example.com/old-only' }
  });
  await sw.evaluate(async (event) => { await TounarQueue.add(event); }, oldEvent);
  assert.equal(await sw.evaluate(() => TounarQueue.count()), 1);

  const blocked = await send('set_server_url', { serverUrl: serverB.base });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'QUEUE_CLEAR_REQUIRED');
  let settings = await sw.evaluate(() => TounarCommon.getSettings());
  assert.equal(settings.serverUrl, serverA.base);
  assert.ok(settings.deviceToken, '拒绝切换时必须保留原后台绑定');
  assert.equal(await sw.evaluate(() => TounarQueue.count()), 1);

  const blockedUnpair = await send('unpair', { cleanup: false });
  assert.equal(blockedUnpair.ok, false);
  assert.equal(blockedUnpair.error.code, 'QUEUE_CLEAR_REQUIRED');
  assert.ok((await sw.evaluate(() => TounarCommon.getSettings())).deviceToken);

  await send('clear_queue');
  const switched = await send('set_server_url', { serverUrl: serverB.base });
  assert.equal(switched.ok, true, JSON.stringify(switched));
  assert.equal(switched.result.changed, true);
  settings = await sw.evaluate(() => TounarCommon.getSettings());
  assert.equal(settings.serverUrl, serverB.base);
  assert.equal(settings.deviceToken, null, '切换后台后不得携带旧设备令牌');
  assert.equal(settings.deviceId, null);
  assert.equal(await sw.evaluate(() => TounarQueue.count()), 0);

  await pair(serverB, popup, send);
  const newEvent = strongViewEvent({
    client_event_id: 'evt-new-backend-only',
    payload: { company_name: '正式后台隔离测试', job_title: '正式后台岗位', site_job_id: 'new-only', job_url: 'https://jobs.example.com/new-only' }
  });
  await sw.evaluate(async (event) => { await TounarQueue.add(event); }, newEvent);
  const flushed = await send('flush_now');
  assert.equal(flushed.flushed, 1, JSON.stringify(flushed));

  const cookieA = (await serverA.login('demo@tounar.local')).cookie;
  const cookieB = (await serverB.login('demo@tounar.local')).cookie;
  const ledgerA = await serverA.request('/api/v1/ledger?view=viewed', { cookie: cookieA });
  const ledgerB = await serverB.request('/api/v1/ledger?view=viewed', { cookie: cookieB });
  assert.equal(ledgerA.json.data.filtered_total, 0, '旧后台不得收到新后台事件');
  assert.equal(ledgerB.json.data.filtered_total, 1);
  assert.equal(ledgerB.json.data.items[0].company_name, '正式后台隔离测试');

  console.log(JSON.stringify({
    ok: true,
    nonempty_queue_switch_blocked: true,
    nonempty_queue_unpair_blocked: true,
    old_token_cleared_on_switch: true,
    old_backend_ledger_count: 0,
    new_backend_ledger_count: 1
  }, null, 2));
} finally {
  await context?.close();
  await serverA?.stop();
  await serverB?.stop();
}
