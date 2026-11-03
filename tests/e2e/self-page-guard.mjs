/* 自身页面排除验收：项目页面打开、停留、路由切换、主动采集都不得产生事件。 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startTestServer } from '../../server/test/helpers.js';
import { buildTestExtension } from '../../extension/scripts/make-test-build.mjs';
import { resolveChromiumExecutable } from './browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const out = process.env.SELF_PAGE_OUT
  ? path.resolve(process.env.SELF_PAGE_OUT)
  : path.join(ROOT, '.tmp', 'self-page-guard');
if (!process.env.SELF_PAGE_OUT) fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const checks = [];
let failed = 0;
function check(name, ok, detail = '') {
  const pass = Boolean(ok);
  if (!pass) failed += 1;
  checks.push({ name, ok: pass, detail: String(detail || '') });
  console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

let server, context, page, sw;
try {
  server = await startTestServer({ name: 'self-page-guard-' + Date.now() });
  const cookie = (await server.login('demo@tounar.local')).cookie;
  const extDir = buildTestExtension({ outDir: path.join(out, 'extension') });
  const resolved = await resolveChromiumExecutable();
  context = await chromium.launchPersistentContext(path.join(out, 'profile'), {
    headless: true,
    executablePath: resolved?.path,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run', '--no-default-browser-check']
  });
  sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(server.base + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#tn-root', { timeout: 10000 });
  await page.waitForTimeout(4200);
  const before = await server.request('/api/v1/ledger?view=viewed&limit=100', { cookie });
  const beforeReviews = await server.request('/api/v1/review-items?status=all&limit=1', { cookie });
  const tab = await sw.evaluate(async (base) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => String(t.url || '').startsWith(base));
    return hit ? { id: hit.id, url: hit.url } : null;
  }, server.base);
  check('测试扩展已注入项目页面', !!tab, tab?.url || 'no tab');
  const capture = tab?.id
    ? await sw.evaluate(async (tabId) => chrome.tabs.sendMessage(tabId, { type: 'tounar_capture_now', reason: 'test' }), tab.id)
    : null;
  check('项目页面主动采集返回 self_page', capture?.status === 'self_page', JSON.stringify(capture));
  await page.goto(server.base + '/?panel=reviews', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.goto(server.base + '/?panel=settings', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.goto(server.base + '/?panel=career', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.goto(server.base + '/mail-selftest.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const after = await server.request('/api/v1/ledger?view=viewed&limit=100', { cookie });
  const afterReviews = await server.request('/api/v1/review-items?status=all&limit=1', { cookie });
  check('打开/刷新/切换项目页面不新增看过没投', after.json.data.items.length === before.json.data.items.length, `${before.json.data.items.length} -> ${after.json.data.items.length}`);
  check('打开/刷新/切换项目页面不新增待确认', afterReviews.json.total === beforeReviews.json.total, `${beforeReviews.json.total} -> ${afterReviews.json.total}`);
  const queuePurge = tab?.id ? await sw.evaluate(async (base) => {
    await TounarCommon.setSettings({ serverUrl: base });
    await TounarQueue.add({
      client_event_id: 'evt_self_queued_test',
      event_type: 'job_viewed', source_method: 'plugin', site_key: 'generic', schema_version: 'C1',
      occurred_at: new Date().toISOString(), observed_at: new Date().toISOString(),
      evidence_level: 'strong', evidence_code: 'test',
      payload: { job_title: '自身页面旧队列', job_url: base + '/' }
    });
    const before = await TounarQueue.count();
    const result = await flushQueue();
    const after = await TounarQueue.count();
    return { before, after, result };
  }, server.base) : null;
  check('旧队列中的自身页面事件被逐条清除，不残留排队', queuePurge?.before === 1 && queuePurge?.after === 0,
    JSON.stringify(queuePurge));
  check('页面脚本无未捕获异常', pageErrors.length === 0, pageErrors.join('; '));
} catch (err) {
  failed += 1;
  checks.push({ name: '执行', ok: false, detail: err.stack || String(err) });
  console.error(err);
} finally {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ checks, failed }, null, 2));
  await context?.close().catch(() => {});
  await server?.stop().catch(() => {});
}
console.log(failed ? `SELF-PAGE-GUARD：${checks.length - failed}/${checks.length} 通过，${failed} 失败` : `SELF-PAGE-GUARD：${checks.length}/${checks.length} 通过`);
process.exitCode = failed ? 1 : 0;
