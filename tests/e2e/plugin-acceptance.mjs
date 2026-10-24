/*
 * 插件验收（稳定回归）：真实扩展 + 真实后端 + 真实前端 + 本地 fixture 站点。
 * 覆盖：授权后点击「采集当前页」→ 自动入账 → 前端可见 → 重复采集不重复 →
 *       已学习模板命中不报错（回归 `add` TDZ 崩溃）。
 *
 * 运行：npm run test:plugin-acceptance
 * 产物：.tmp/plugin-acceptance-report.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startTestServer, freePort } from '../../server/test/helpers.js';
import { buildTestExtension } from '../../extension/scripts/make-test-build.mjs';
import { startFixtureServer } from './fixtures.mjs';
import { resolveChromiumExecutable } from './browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PROFILE = path.join(ROOT, '.tmp', 'plugin-acceptance-profile');
const REPORT = path.join(ROOT, '.tmp', 'plugin-acceptance-report.json');
const checks = [];
const rows = [];
let failed = 0;

function check(name, ok, detail = '') {
  const pass = Boolean(ok);
  if (!pass) failed += 1;
  checks.push({ name, ok: pass, detail: String(detail || '') });
  console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 20000, interval = 200, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}`);
}

async function launch({ extDir, executablePath }) {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    executablePath,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run', '--no-default-browser-check']
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  if (!sw) throw new Error('扩展 service worker 未启动');
  return { context, extId: new URL(sw.url()).host };
}

let server = null;
let fixture = null;
let browser = null;
let extId = null;
let extDir = null;
let executablePath = null;

try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  server = await startTestServer({ name: 'plugin-acceptance' });
  const { cookie } = await server.login('demo@tounar.local');
  const fixturePort = await freePort();
  fixture = await startFixtureServer({ port: fixturePort });
  extDir = buildTestExtension({ outDir: path.join(ROOT, '.tmp', 'extension-acceptance') });
  const resolved = await resolveChromiumExecutable();
  executablePath = resolved?.path;
  ({ context: browser, extId } = await launch({ extDir, executablePath }));
  rows.push({ step: 'launch', browser: resolved?.source, extId });

  const popup = await browser.newPage();
  const pageErrors = [];
  popup.on('pageerror', (e) => pageErrors.push(e.message));
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForSelector('#queue-count');
  await popup.fill('#server-url', server.base);
  await popup.click('#save-server');
  await sleep(400);
  await popup.click('#start-pairing');
  const code = await waitFor(async () => {
    const text = ((await popup.textContent('#pairing-code')) || '').trim();
    return /^[A-HJ-NP-Z2-9]{8}$/.test(text) ? text : null;
  }, { label: '配对码' });
  const approved = await server.request('/api/v1/plugin-pairings/approve', { method: 'POST', cookie, body: { code } });
  check('配对码获批', approved.status === 200, `status=${approved.status}`);
  await popup.click('#poll-pairing');
  await waitFor(async () => popup.evaluate(() => {
    const el = document.getElementById('paired');
    return el && !el.classList.contains('hidden');
  }), { label: '扩展已绑定' });
  check('扩展已绑定', true);

  // 1) 打开真实岗位页（fixture），在 popup 里点「采集当前页」
  const jobPage = await browser.newPage();
  await jobPage.goto(`${fixture.base}/job-a`);
  await sleep(500);
  await popup.bringToFront();
  await popup.click('#capture-now');
  const statusText = await waitFor(async () => {
    const text = (await popup.textContent('#capture-status')) || '';
    return /已自动入账|已提交|服务端已接受|等待上传|服务端拒绝/.test(text) ? text : null;
  }, { label: '采集状态' });
  check('点击采集后 popup 给出明确状态', true, statusText);
  check('采集状态不是失败', !/失败|拒绝/.test(statusText), statusText);

  // 2) 服务端是否真的入账（application_id）
  const entry = await waitFor(async () => {
    const res = await server.request('/api/v1/ledger?view=viewed&status=all&limit=50', { cookie });
    const row = (res.json?.data?.items || []).find((x) => x.job_title === '前端开发实习生');
    return row || null;
  }, { label: '台账出现记录' });
  check('服务端生成业务记录（非仅 review）', Boolean(entry?.id), `application_id=${entry?.id}`);
  const detail = await server.request(`/api/v1/applications/${entry.id}`, { cookie });
  check('记录状态是未投递（pending, has_applied=0）', entry.status === 'pending' && Number(entry.has_applied) === 0, format(entry));
  const jdLen = (detail.json?.data?.jd_text || '').length;
  const jdText = detail.json?.data?.jd_text || '';
  check('完整 JD 已落库（含职责与任职要求、保留段落）',
    jdLen > 100 && jdText.includes('任职要求') && jdText.includes('\n'),
    `jd_text=${jdLen} chars paragraphs=${jdText.split('\n').length}`);

  // 3) 前端可见（复用会话 cookie）
  // 直接复用 API 会话 cookie（避免依赖 OTP 频控）
  const [cookieName, cookieValue] = String(cookie).split('=');
  await browser.addCookies([{ name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' }]);
  const web = await browser.newPage();
  await web.goto(server.base + '/');
  const viewedTab = web.locator('[data-test=tab-viewed]');
  if (await viewedTab.count()) { await viewedTab.click(); }
  await web.waitForSelector('[data-test=ledger-row]');
  const visibleText = await web.locator('[data-test=ledger-row]').first().textContent();
  check('前端可以看到该岗位（无需刷新页面）', String(visibleText || '').includes('前端开发实习生'), String(visibleText || '').slice(0, 60));

  // 4) 重复采集不重复入账
  await jobPage.bringToFront();
  await jobPage.reload();
  await sleep(500);
  await popup.bringToFront();
  await popup.click('#capture-now');
  await sleep(2500);
  const rowsAfter = await server.request('/api/v1/ledger?view=viewed&status=all&limit=100', { cookie });
  const same = (rowsAfter.json?.data?.items || []).filter((x) => x.job_title === '前端开发实习生');
  check('重复采集只有一条记录', same.length === 1, `count=${same.length}`);

  // 5) 已学习模板命中不崩（回归 add TDZ）
  await popup.evaluate(async (fixtureOrigin) => {
    const key = 'tounar.learned.v1';
    const map = {
      [`${fixtureOrigin}/job-a`]: {
        id: 'seed', origin: fixtureOrigin, pathPattern: '/job-a',
        selectors: { title: 'h1.job-title', company: '.company-name' },
        status: 'trial', successes: 1, failures: 0, lastJobId: 'e2e-job-a', lastOkAt: new Date().toISOString()
      }
    };
    await chrome.storage.local.set({ [key]: map });
  }, fixture.base);
  await jobPage.bringToFront();
  const errorsBefore = pageErrors.length;
  await jobPage.reload();
  await sleep(4000);
  const attr = await jobPage.evaluate(() => document.documentElement.getAttribute('data-tounar-job-detected'));
  check('命中已学习模板时页面不报错且仍识别到岗位', pageErrors.length === errorsBefore && Boolean(attr), `attr=${attr} errors=${pageErrors.length - errorsBefore}`);

  rows.push({ step: 'capture', application_id: entry.id, status_text: statusText, jd_chars: jdLen });
} catch (error) {
  failed += 1;
  checks.push({ name: '运行异常', ok: false, detail: error.message });
  console.error(`✖ 运行异常：${error.message}`);
} finally {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify({
    generated_at: new Date().toISOString(),
    commit: process.env.GIT_COMMIT || null,
    base: server?.base,
    checks, rows, failed
  }, null, 2) + '\n');
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  await fixture?.close?.().catch?.(() => {});
  console.log(`\n${failed ? '✖' : '✔'} 共 ${checks.length} 项，失败 ${failed}；报告：${REPORT}`);
  process.exit(failed ? 1 : 0);
}

function format(row) {
  return JSON.stringify({ status: row.status, has_applied: row.has_applied });
}
