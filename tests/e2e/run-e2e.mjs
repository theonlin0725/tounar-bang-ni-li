/*
 * PLUGIN-E2E 门禁：用真实 Chromium（MV3 扩展 + 真实本地后台 + 本地 fixture 站点）
 * 验证「采集 → 本地队列 → 上传 → 服务端入库」的完整链路。
 *
 * 说明（诚实边界）：
 * - 前端网页此时尚未开发，配对批准这一步用「带会话 cookie 的 API」代表已登录用户在网页上确认；
 *   前端完成后会补一条真实 UI 配对复验（见最终报告）。
 * - fixture 站点是本地 http://127.0.0.1，只覆盖通用 JSON-LD 与 data-tounar-* 契约；
 *   真实招聘站点适配（G04）仍未验证。
 *
 * 运行：npm run test:e2e
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startTestServer, freePort } from '../../server/test/helpers.js';
import { buildTestExtension } from '../../extension/scripts/make-test-build.mjs';
import { startFixtureServer } from './fixtures.mjs';
import { resolveChromiumExecutable } from './browser.mjs';
import { captureRegression } from './capture-regression.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PROFILE_DIR = path.join(ROOT, '.tmp', 'e2e-profile');
const REPORT_PATH = path.join(ROOT, '.tmp', 'e2e-report.json');
const SERVER_NAME = 'extension-e2e';

const checks = [];
let failed = 0;
function check(name, ok, detail = '') {
  const pass = Boolean(ok);
  if (!pass) failed += 1;
  checks.push({ name, ok: pass, detail: String(detail || '') });
  console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 15000, interval = 200, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}`);
}

async function ledger(server, cookie, view) {
  const res = await server.request(`/api/v1/ledger?view=${view}`, { cookie });
  if (res.status !== 200) throw new Error(`ledger ${view} 失败：${res.status} ${res.text.slice(0, 200)}`);
  return res.json.data;
}

async function applicationDetail(server, cookie, id) {
  const res = await server.request(`/api/v1/applications/${id}`, { cookie });
  if (res.status !== 200) return null;
  return res.json.data;
}

async function launchBrowser({ extDir, headless, executablePath }) {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    ...(executablePath ? { executablePath } : {}),
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  }
  if (!sw) {
    await context.close();
    return null;
  }
  return { context, sw, extId: new URL(sw.url()).host };
}

async function openPopup(context, extId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForSelector('#queue-count');
  return popup;
}

async function popupQueueCount(popup) {
  const text = await popup.textContent('#queue-count');
  return Number(String(text || '').trim());
}

async function popupPaired(popup) {
  return popup.evaluate(() => {
    const paired = document.getElementById('paired');
    return paired ? !paired.classList.contains('hidden') : false;
  });
}

let server = null;
let fixture = null;
let browser = null;

try {
  // ---------- 1. 后台 + fixture ----------
  server = await startTestServer({ name: SERVER_NAME });
  const backendPort = server.port;
  const fixturePort = await freePort();
  fixture = await startFixtureServer({ port: fixturePort });
  const { cookie } = await server.login('demo@tounar.local');
  const extDir = buildTestExtension();
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });

  // ---------- 2. 启动浏览器（带测试版扩展） ----------
  const resolved = await resolveChromiumExecutable();
  if (!resolved) throw new Error('未找到可用的 Chromium/Chrome for Testing，请先安装浏览器');
  const executablePath = resolved.path;
  check('E2E-00 浏览器可加载 MV3 扩展（Chrome for Testing）', fs.existsSync(executablePath), `${resolved.source} → ${path.relative(ROOT, executablePath)}`);

  browser = await launchBrowser({ extDir, headless: true, executablePath });
  if (!browser) {
    console.log('· headless 模式未加载扩展，回退到有界面模式');
    browser = await launchBrowser({ extDir, headless: false, executablePath });
  }
  if (!browser) throw new Error('无法启动带扩展的 Chromium');
  const { context, extId } = browser;
  console.log(`· 扩展已加载：${extId}`);

  // ---------- 3. 配对（popup 真实操作 + 网页会话 API 批准） ----------
  let popup = await openPopup(context, extId);
  await popup.fill('#server-url', server.base);
  await popup.evaluate(() => refresh());
  check('E2E-01 地址编辑期间后台刷新不覆盖输入', await popup.inputValue('#server-url') === server.base);
  await popup.click('#save-server');
  await popup.click('#start-pairing');
  const pairingCode = await waitFor(async () => {
    const text = (await popup.textContent('#pairing-code')) || '';
    return /^[A-Z2-9]{8}$/.test(text.trim()) ? text.trim() : null;
  }, { label: '弹出配对码' });
  const approved = await server.request('/api/v1/plugin-pairings/approve', {
    method: 'POST', cookie, body: { code: pairingCode }
  });
  check('E2E-01a 网页会话批准配对码', approved.status === 200, `code=${pairingCode} status=${approved.status}`);
  await popup.click('#poll-pairing');
  const paired = await waitFor(async () => ((await popupPaired(popup)) ? true : null), { label: 'popup 完成绑定' });
  const ownerHint = await popup.textContent('#owner-hint');
  check('E2E-01b popup 自动完成绑定', paired && String(ownerHint).includes('demo@tounar.local'), `owner=${ownerHint}`);
  const g04Warn = await popup.textContent('.warn');
  check('E2E-01c popup 如实标注适配验证状态', /覆盖情况以逐站验收报告为准|G04/.test(String(g04Warn)), String(g04Warn).slice(0, 40));

  // ---------- 4. 岗位详情：2 秒不入库，≥3 秒入库为「看过没投」 ----------
  const pageJob = await context.newPage();
  await pageJob.bringToFront();
  await pageJob.goto(`${fixture.base}/job-a`);
  await pageJob.waitForFunction(() => document.documentElement.getAttribute('data-tounar-job-detected') === 'e2e-job-a', null, { timeout: 15000 });
  const adapterProbe = await pageJob.evaluate(() => ({
    adapter: document.documentElement.getAttribute('data-tounar-adapter'),
    version: document.documentElement.getAttribute('data-tounar-adapter-version'),
    detectedAt: Number(document.documentElement.getAttribute('data-tounar-detected-at'))
  }));
  check('E2E-02a 识别到岗位详情（通用适配器 + 探针）', adapterProbe.adapter === 'generic' && adapterProbe.detectedAt > 0, JSON.stringify(adapterProbe));

  const elapsedToCheck = adapterProbe.detectedAt + 1800 - Date.now();
  if (elapsedToCheck > 0) await sleep(elapsedToCheck);
  const early = await ledger(server, cookie, 'viewed');
  check('E2E-02b 停留不足 3 秒不产生线索', early.filtered_total === 0, `viewed=${early.filtered_total}`);

  await pageJob.waitForFunction(() => document.documentElement.getAttribute('data-tounar-view-sent') === '1', null, { timeout: 20000 });
  const viewed = await waitFor(async () => {
    const data = await ledger(server, cookie, 'viewed');
    return data.filtered_total >= 1 ? data : null;
  }, { label: '≥3 秒浏览入库' });
  const viewedRow = viewed.items.find((a) => a.company_name === '星河科技');
  check(
    'E2E-03 可见累计 ≥3 秒后入库为「看过没投」',
    !!viewedRow && viewedRow.job_title === '前端开发实习生' && Number(viewedRow.has_applied) === 0 && viewedRow.status === 'pending',
    JSON.stringify({ id: viewedRow?.id, has_applied: viewedRow?.has_applied, status: viewedRow?.status })
  );
  const jobAppId = viewedRow.id;

  // ---------- 5. 列表页负样本 ----------
  const beforeList = await ledger(server, cookie, 'viewed');
  const pageList = await context.newPage();
  await pageList.bringToFront();
  await pageList.goto(`${fixture.base}/job-list`);
  await sleep(4500);
  const afterList = await ledger(server, cookie, 'viewed');
  const listProbe = await pageList.evaluate(() => document.documentElement.getAttribute('data-tounar-job-detected'));
  check(
    'E2E-04 列表页（多岗位 JSON-LD）不识别、不产生事件',
    afterList.filtered_total === beforeList.filtered_total && listProbe === null,
    `viewed=${beforeList.filtered_total}→${afterList.filtered_total} probe=${listProbe}`
  );
  await pageList.close();

  // ---------- 6. 表单开始填写 ----------
  await pageJob.bringToFront();
  await pageJob.click('#candidate-name');
  await pageJob.keyboard.type('测试同学');
  await pageJob.waitForFunction(() => document.documentElement.getAttribute('data-tounar-form-sent') === '1', null, { timeout: 15000 });
  await waitFor(async () => {
    const detail = await applicationDetail(server, cookie, jobAppId);
    return detail?.form_started_at ? detail : null;
  }, { label: 'form_started 落库' });
  check('E2E-05 表单开始填写 → form_started（不读内容）', true);

  // ---------- 7. 提交成功（强证据） ----------
  await pageJob.click('#submit-apply');
  await pageJob.waitForFunction(() => document.documentElement.getAttribute('data-tounar-submit-sent') === '1', null, { timeout: 15000 });
  const applied = await waitFor(async () => {
    const data = await ledger(server, cookie, 'applied');
    const row = data.items.find((a) => a.company_name === '星河科技');
    return row && row.status === 'applied' ? row : null;
  }, { label: '投递成功入库' });
  const appliedDetail = await applicationDetail(server, cookie, applied.id);
  check(
    'E2E-06 明确成功标记 → application_submitted（强证据）→ applied',
    applied.id === jobAppId && !!appliedDetail.applied_at && appliedDetail.history.some((h) => h.to_status === 'applied'),
    `applied_at=${appliedDetail?.applied_at}`
  );

  // ---------- 8. 状态页观察 ----------
  const pageStatus = await context.newPage();
  await pageStatus.bringToFront();
  await pageStatus.goto(`${fixture.base}/status`);
  const interview = await waitFor(async () => {
    const detail = await applicationDetail(server, cookie, jobAppId);
    return detail?.status === 'interview' ? detail : null;
  }, { label: '状态块 → interview' });
  check(
    'E2E-07 结构化状态块 → site_status_observed → interview（写入历史）',
    interview.history.some((h) => h.to_status === 'interview') && interview.status_url_scope === '127.0.0.1',
    `status=${interview.status} scope=${interview.status_url_scope}`
  );

  // ---------- 9. 断网入队 ----------
  await server.stop();
  server = null;
  const pageOffline = await context.newPage();
  await pageOffline.bringToFront();
  await pageOffline.goto(`${fixture.base}/job-b`);
  await pageOffline.waitForFunction(() => document.documentElement.getAttribute('data-tounar-view-sent') === '1', null, { timeout: 20000 });
  popup = await openPopup(context, extId);
  const queuedOffline = await waitFor(async () => {
    const count = await popupQueueCount(popup);
    return count >= 1 ? count : null;
  }, { label: '断网事件进入本地队列' });
  check('E2E-08 后台不可达时事件留在本地队列', queuedOffline >= 1, `queued=${queuedOffline}`);

  // ---------- 10. 浏览器重启后队列仍在 ----------
  await context.close();
  browser = await launchBrowser({ extDir, headless: true, executablePath });
  if (!browser) browser = await launchBrowser({ extDir, headless: false, executablePath });
  if (!browser) throw new Error('重启浏览器失败');
  const restartContext = browser.context;
  popup = await openPopup(restartContext, browser.extId);
  const queuedAfterRestart = await waitFor(async () => {
    const count = await popupQueueCount(popup);
    return count >= 1 ? count : null;
  }, { label: '重启后队列仍在' });
  check('E2E-09 浏览器重启后 IndexedDB 队列持久（未上传事件不丢）', queuedAfterRestart >= 1, `queued=${queuedAfterRestart}`);

  // ---------- 11. 恢复后 flush 入库 ----------
  server = await startTestServer({ name: SERVER_NAME, wipe: false, port: backendPort });
  const loggedIn = await server.login('demo@tounar.local');
  const cookie2 = loggedIn.cookie;
  popup = await openPopup(restartContext, browser.extId);
  await popup.click('#flush-now');
  const drained = await waitFor(async () => {
    const count = await popupQueueCount(popup);
    return count === 0 ? true : null;
  }, { label: '队列清空' });
  const flushed = await waitFor(async () => {
    const data = await ledger(server, cookie2, 'viewed');
    return data.items.some((a) => a.company_name === '云图数据') ? data : null;
  }, { label: '离线事件恢复后入库' });
  // 此时 job-a 已升级为「已投（面试中）」离开 look-first 分区，viewed 只应有 job-b 一条。
  const viewedCountAfterFlush = flushed.filtered_total;
  check(
    'E2E-10 后台恢复后补传成功：队列清空 + 记录入库',
    drained === true && viewedCountAfterFlush === 1 && flushed.items.every((a) => Number(a.has_applied) === 0),
    `viewed=${viewedCountAfterFlush}（job-a 已计入已投，不在看过没投）`
  );

  // ---------- 12. 撤销 → 拒收新事件 + 清理回执 ----------
  const devices = await server.request('/api/v1/plugin-devices', { cookie: cookie2 });
  const device = devices.json.data[0];
  const revoked = await server.request(`/api/v1/plugin-devices/${device.id}/revoke`, { method: 'POST', cookie: cookie2, body: {} });
  check('E2E-11a 网页侧撤销设备', revoked.status === 200 && !!revoked.json.data.server_revoked_at, `state=${revoked.json.data?.device_cleanup_state}`);

  await server.stop();
  server = null;
  const pageRevoked = await restartContext.newPage();
  await pageRevoked.bringToFront();
  await pageRevoked.goto(`${fixture.base}/job-a`);
  await pageRevoked.waitForFunction(() => document.documentElement.getAttribute('data-tounar-view-sent') === '1', null, { timeout: 20000 });
  const queuedBeforeAck = await waitFor(async () => {
    const count = await popupQueueCount(popup);
    return count >= 1 ? count : null;
  }, { label: '撤销后离线事件入队（客户端尚不知情）' });

  server = await startTestServer({ name: SERVER_NAME, wipe: false, port: backendPort });
  popup = await openPopup(restartContext, browser.extId);
  await popup.click('#heartbeat');
  const clearedAfterAck = await waitFor(async () => {
    const count = await popupQueueCount(popup);
    return count === 0 ? true : null;
  }, { label: '清理回执后本地队列清空' });
  const unpaired = await waitFor(async () => ((await popupPaired(popup)) ? null : true), { label: 'popup 回到未绑定状态' });
  const devicesAfter = await server.request('/api/v1/plugin-devices', { cookie: cookie2 });
  const deviceAfter = devicesAfter.json.data.find((d) => d.id === device.id);
  const ledgerAfter = await ledger(server, cookie2, 'viewed');
  check(
    'E2E-11b 撤销后：新事件被拒收、本地队列按清理协议删除、绑定解除',
    clearedAfterAck && unpaired && deviceAfter.device_cleanup_state === 'acknowledged' && ledgerAfter.filtered_total === viewedCountAfterFlush,
    `cleanup=${deviceAfter.device_cleanup_state} queued=${queuedBeforeAck} viewed=${ledgerAfter.filtered_total}（撤销前 ${viewedCountAfterFlush}）`
  );

  check('E2E-12 撤销后 popup 不再显示绑定信息', deviceAfter.server_revoked_at != null && !(await popupPaired(popup)));
  await captureRegression(check);
} catch (err) {
  check('E2E 运行异常', false, String(err?.stack || err).slice(0, 1200));
} finally {
  try { if (browser?.context) await browser.context.close(); } catch { /* ignore */ }
  try { if (fixture) await fixture.close(); } catch { /* ignore */ }
  try { if (server) await server.stop(); } catch { /* ignore */ }
  const summary = {
    generated_at: new Date().toISOString(),
    total: checks.length,
    passed: checks.filter((c) => c.ok).length,
    failed,
    checks
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2));
  console.log(`\nPLUGIN-E2E：${summary.passed}/${summary.total} 通过（报告：${path.relative(ROOT, REPORT_PATH)}）`);
  if (failed > 0) process.exitCode = 1;
}
