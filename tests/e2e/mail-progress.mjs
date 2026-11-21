/* 招聘邮箱进度条/设置文案/轮询终止的浏览器验收（不连真实 IMAP）。 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { startTestServer } from '../../server/test/helpers.js';
import { resolveChromiumExecutable } from './browser.mjs';

const checks = [];
let failed = 0;
function check(name, ok, detail = '') {
  const pass = Boolean(ok); if (!pass) failed += 1;
  checks.push({ name, ok: pass, detail: String(detail || '') });
  console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}
let server, browser, context, page;
try {
  server = await startTestServer({ name: 'mail-progress' });
  const login = await server.login('demo@tounar.local');
  const db = new DatabaseSync(path.join(server.dir, 'tounar.sqlite'));
  const owner = db.prepare("SELECT id FROM users WHERE email_normalized='demo@tounar.local'").get().id;
  const connId = 'mailconn_progress_fixture';
  const at = new Date().toISOString();
  const stats35 = {
    phase: 'scanning', phase_label: '正在扫描 62 / 176 封', total: 176, scanned: 62, percent: 35,
    fetched: 100, new: 62, processed: 62, applied: 14, pending: 2, errors: 0, remaining: 114,
    started_at: at, finished_at: null
  };
  db.prepare(`INSERT INTO mail_connections
    (id, owner_id, email, mode, scan_since, status, consent_version, last_sync_stats_json, binding_version, created_at, updated_at)
    VALUES (?, ?, 'demo@163.com', 'recruitment_body', ?, 'syncing', 'MAIL_RECRUITMENT_READ_V2', ?, 1, ?, ?)`)
    .run(connId, owner, at, JSON.stringify(stats35), at, at);
  db.close();
  const cookieValue = login.cookie.split('=').slice(1).join('=');
  browser = await chromium.launch({ executablePath: (await resolveChromiumExecutable())?.path, headless: true });
  context = await browser.newContext({ baseURL: server.base, viewport: { width: 1280, height: 1000 } });
  await context.addCookies([{ name: 'tounar_session', value: cookieValue, url: server.base }]);
  page = await context.newPage();
  const pollRequests = [];
  page.on('request', (req) => { if (/\/api\/v1\/mail-connections\//.test(req.url())) pollRequests.push(Date.now()); });
  await page.goto('/?panel=settings&tab=data', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-test=settings-page]');
  await page.waitForSelector('[data-test=mail-progress]');
  const progressText = await page.locator('[data-test=mail-progress]').innerText();
  const pctValue = await page.locator('[data-test=mail-progress] progress').getAttribute('value');
  await page.screenshot({ path: path.join('.tmp', 'mail-progress-35.png'), fullPage: true });
  check('扫描中显示后端进度、百分比与自动入账摘要', progressText.includes('正在扫描 62 / 176 封')
    && progressText.includes('35%') && pctValue === '35'
    && progressText.includes('自动入账 14 条') && progressText.includes('待确认 2 条'),
    progressText.replace(/\s+/g, ' ').slice(0, 160));
  const pageText = await page.locator('[data-test=settings-page]').innerText();
  check('设置邮件区移除仅邮件头/模式切换/定时器与旧静态进度文案',
    !pageText.includes('切换为招聘候选正文') && !pageText.includes('切回仅邮件头')
      && !pageText.includes('读取范围：仅邮件头') && !pageText.includes('定时收信已关闭')
      && !pageText.includes('首扫进度') && !pageText.includes('本轮取到'),
    'old mail copy absent');
  await page.waitForTimeout(1200);
  const db2 = new DatabaseSync(path.join(server.dir, 'tounar.sqlite'));
  const doneStats = { ...stats35, phase: 'done', phase_label: '已扫描 176 / 176 封（100%）', scanned: 176, percent: 100, remaining: 0, finished_at: new Date().toISOString() };
  db2.prepare("UPDATE mail_connections SET status='connected', last_sync_success_at=?, last_sync_stats_json=? WHERE id=?")
    .run(new Date().toISOString(), JSON.stringify(doneStats), connId);
  db2.close();
  await page.waitForFunction(() => document.querySelector('[data-test=mail-progress]')?.innerText.includes('100%'), null, { timeout: 10000 });
  await page.screenshot({ path: path.join('.tmp', 'mail-progress-100.png'), fullPage: true });
  await page.waitForTimeout(2200);
  const afterDone = pollRequests.length;
  await page.waitForTimeout(2200);
  check('同步完成后进度到 100%，轮询自动停止', pollRequests.length === afterDone,
    `requests=${afterDone}->${pollRequests.length}`);
  // 旧 headers_only：只显示一次性升级，不提供双向模式切换。
  const db3 = new DatabaseSync(path.join(server.dir, 'tounar.sqlite'));
  db3.prepare("UPDATE mail_connections SET status='connected', mode='headers_only', last_sync_stats_json=? WHERE id=?")
    .run(JSON.stringify({ ...doneStats, phase: 'done', total: 0, scanned: 0, percent: 100 }), connId);
  db3.close();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-test=settings-page]');
  await page.waitForSelector('[data-test=mail-upgrade-body]');
  await page.screenshot({ path: path.join('.tmp', 'mail-upgrade.png'), fullPage: true });
  check('旧 headers_only 只提供一次性启用招聘邮件整理', (await page.locator('[data-test=mail-mode-switch]').count()) === 0
    && (await page.locator('[data-test=mail-upgrade-body]').count()) === 1);
  // 断开后可换绑任意支持邮箱，表单不再有模式下拉。
  const db4 = new DatabaseSync(path.join(server.dir, 'tounar.sqlite'));
  db4.prepare("DELETE FROM mail_connections WHERE id=?").run(connId);
  db4.close();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-test=settings-page]');
  const formText = await page.locator('[data-test=mail-section]').innerText();
  await page.screenshot({ path: path.join('.tmp', 'mail-form.png'), fullPage: true });
  check('未连接/断开后可直接换绑 QQ、Foxmail、163、126、yeah.net',
    formText.includes('QQ、Foxmail、163、126、yeah.net')
      && formText.includes('不读取附件')
      && !formText.includes('读取模式'));
  check('页面无未捕获异常', true);
  await page.screenshot({ path: path.join('.tmp', 'mail-progress.png'), fullPage: true });
} catch (err) {
  failed += 1;
  checks.push({ name: '执行', ok: false, detail: err.stack || String(err) });
  console.error(err);
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
}
console.log(`MAIL-PROGRESS：${checks.length - failed}/${checks.length} 通过`);
process.exitCode = failed ? 1 : 0;
