/* v1.1.5 first-run guide regression:
 * - v1.1.4 `done: true` residue must not suppress the new guide;
 * - "稍后再说 / 稍后同步" only hide the current mount and reappear on return;
 * - plugin -> first captured job -> mailbox -> completion are real server states;
 * - only the acknowledged completion writes the permanent v115 flag. */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { startTestServer, strongViewEvent } from '../../server/test/helpers.js';
import { resolveChromiumExecutable } from './browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, '.tmp', 'onboarding-v115');
fs.mkdirSync(OUT, { recursive: true });
const EMAIL = 'demo@tounar.local';
const checks = [];
let server;
let browser;
let context;

function check(name, ok, detail = '') {
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
  checks.push({ name, ok: true });
  console.log(`✔ ${name}`);
}
async function page() { return context.pages()[0]; }
async function waitGuide(page, progress, text) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const node = page.locator('[data-test=onboarding-guide]');
    if (await node.count()) {
      const body = await node.innerText().catch(() => '');
      if (body.includes(progress) && (!text || body.includes(text))) return body;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`等待引导 ${progress}${text ? ` / ${text}` : ''} 超时`);
}
async function expectHidden(page) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await page.locator('[data-test=onboarding-guide]').count()) === 0) return;
    await page.waitForTimeout(100);
  }
  throw new Error('引导未隐藏');
}
async function leaveAndReturn(page) {
  await page.goto(`${server.base}/?panel=career&section=match`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-test=career-profile-card]', { timeout: 15000 });
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-test=stat-total]', { timeout: 15000 });
}

try {
  server = await startTestServer({ name: 'onboarding-v115', env: { JD_AI_ENABLED: 'false' } });
  const login = await server.login(EMAIL);
  browser = await chromium.launch({ headless: true, executablePath: (await resolveChromiumExecutable()).path });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{
    name: 'tounar_session', value: login.cookie.split('=').slice(1).join('='),
    domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax'
  }]);
  const p = await context.newPage();
  const errors = [];
  p.on('pageerror', (error) => errors.push(error.message));
  // Simulate an account that clicked "稍后再说" in v1.1.4. The new key must
  // ignore that permanent marker and evaluate real completion again.
  await p.addInitScript((email) => {
    localStorage.setItem(`tounar.onboarding.v114.${email}`, JSON.stringify({ done: true, step: null }));
  }, EMAIL);

  await p.goto(server.base, { waitUntil: 'domcontentloaded' });
  const step2 = await waitGuide(p, '1/4', '装好插件');
  check('旧 v114 done 不抑制引导，空账号停在 Step 2（1/4）', step2.includes('下载插件包'));
  check('引导存在时不叠出旧插件安装弹窗', (await p.locator('[data-test=plugin-install-modal]').count()) === 0);

  await p.locator('[data-test=onboarding-skip]').click();
  await expectHidden(p);
  check('Step 2 点稍后再说仅隐藏当前停留', true);

  await leaveAndReturn(p);
  await waitGuide(p, '1/4', '装好插件');
  check('切回投递台账后引导重新出现并停在同一未完成步骤', true);
  await p.locator('[data-test=onboarding-skip]').click();
  await expectHidden(p);

  const pairing = (await server.request('/api/v1/plugin-pairings', {
    method: 'POST', cookie: login.cookie, body: { device_name: 'onboarding-v115-device' }
  })).json.data;
  await server.request('/api/v1/plugin-pairings/approve', {
    method: 'POST', cookie: login.cookie, body: { code: pairing.code }
  });
  const device = (await server.request('/api/v1/plugin-pairings/exchange', {
    method: 'POST', body: { request_id: pairing.request_id, request_secret: pairing.request_secret }
  })).json.data;
  check('测试设备已真实绑定', Boolean(device?.device_token));

  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('[data-test=stat-total]');
  await waitGuide(p, '2/4', '直接浏览，3秒入库');
  check('检测到插件后自动进入 Step 3（2/4）', true);

  await p.locator('[data-test=onboarding-skip]').click();
  await expectHidden(p);
  await leaveAndReturn(p);
  await waitGuide(p, '2/4', '直接浏览，3秒入库');
  check('Step 3 稍后再说后切页回来仍会再次出现', true);
  await p.locator('[data-test=onboarding-skip]').click();
  await expectHidden(p);

  const viewed = await server.request('/api/v1/events/batch', {
    method: 'POST', token: device.device_token,
    body: {
      schema_version: 'C1',
      events: [strongViewEvent({
        client_event_id: 'evt_onboarding_v115_view',
        payload: {
          company_name: '引导验收科技', job_title: '引导验收岗位', site_job_id: 'onboarding-v115-1',
          job_url: 'https://jobs.example.com/onboarding/v115', jd_summary: '负责引导验收。',
          location: '上海'
        }
      })]
    }
  });
  check('首条岗位抓取真实入库', viewed.status === 200 && viewed.json.results?.[0]?.accepted === true, viewed.text);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('[data-test=stat-total]');
  await waitGuide(p, '3/4', '自动同步更新你的投递状态');
  check('抓到首条岗位后自动进入 Step 4（3/4）', true);

  await p.getByRole('button', { name: '稍后同步', exact: true }).click();
  await expectHidden(p);
  await leaveAndReturn(p);
  await waitGuide(p, '3/4', '自动同步更新你的投递状态');
  check('Step 4 稍后同步后切页回来仍会再次出现', true);

  const mail = (await server.request('/api/v1/mail-connections', {
    method: 'POST', cookie: login.cookie,
    body: {
      email: 'onboarding-v115@qq.com', auth_code: 'abcdefgh12345678',
      consent_version: 'QQ_MAIL_READ_CONSENT_V1', scan_since: '2026-10-01T00:00:00.000Z'
    }
  })).json.data;
  const db = new DatabaseSync(path.join(server.dir, 'tounar.sqlite'));
  try {
    db.prepare("UPDATE mail_connections SET status='degraded', last_error_code='IMAP_NETWORK_ERROR' WHERE id=?").run(mail.id);
  } finally { db.close(); }

  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('[data-test=stat-total]');
  const done = await waitGuide(p, '4/4', '已准备就绪');
  check('邮箱授权（degraded）后进入完成态 Step 5（4/4）', done.includes('开始使用'));
  const beforeDone = await p.evaluate((email) => localStorage.getItem(`tounar.onboarding.v115.${email}`), EMAIL);
  check('完成态出现时尚未写入永久完成标记', beforeDone == null);

  await p.locator('[data-test=onboarding-done]').click();
  await expectHidden(p);
  const stored = await p.evaluate((email) => JSON.parse(localStorage.getItem(`tounar.onboarding.v115.${email}`) || 'null'), EMAIL);
  check('点击开始使用后才写入 completed=true', stored?.completed === true && stored.version === '1.1.5');

  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('[data-test=stat-total]');
  await p.waitForTimeout(2200);
  check('完成全部 4 步并刷新后不再弹出引导', (await p.locator('[data-test=onboarding-guide]').count()) === 0);
  check('页面无未捕获脚本异常', errors.length === 0, errors.join('; '));

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ checks, passed: checks.length, failed: 0 }, null, 2));
  await p.screenshot({ path: path.join(OUT, 'onboarding-completed.png'), fullPage: true });
  console.log(JSON.stringify({ passed: checks.length, failed: 0, report: path.join(OUT, 'report.json') }));
} catch (error) {
  console.error(error?.stack || error);
  fs.writeFileSync(path.join(OUT, 'failure.json'), JSON.stringify({ checks, error: String(error?.stack || error) }, null, 2));
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
}
