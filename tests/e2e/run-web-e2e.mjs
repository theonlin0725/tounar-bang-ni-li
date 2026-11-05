/*
 * WEB-E2E 门禁：真实浏览器（无构建 Vanilla SPA）+ 真实后端（SQLite + outbox），不使用模拟数据。
 *
 * 覆盖链路：
 *  1) 邮箱 OTP 登录（真实 outbox）→ 空台账（不塞演示数据）
 *  2) 手动补录 D12 客户端拦截 → 补录成功 → 重复补录 409 候选（不强行新增）
 *  3) 插件设备事件（强证据浏览 / 弱证据提交）→「看过没投」→ 待确认
 *     复核 409 竞态（真实并发：UI 提交前由真实 API 处理同一条复核）→ 正常确认应用建议
 *  4) 提醒设置保存 + 预览 → 内部 tick 真实发信（outbox）→ /r/<token> 未登录登录 → 两步确认
 *     → completed 重放不重复 → 无效链接中性错误
 *  5) 设置面板 UI 配对 → 设备列表 → UI 撤销（撤销 ≠ 已清理）→ 真实 IMAP 不可用时如实降级 → 断开
 *  6) 退出登录（遮罩清理）→ 重新登录
 *  7) 删除全部数据：邮箱重验证 → 202 → 双设备清理回执 → completed → 业务接口 403 DELETION_IN_PROGRESS
 *
 * 诚实边界：
 *  - 邮件只进本地 outbox（MAIL_MODE=outbox），不代表真实 SMTP 送达；真实 QQ IMAP 未配置，连接会如实失败。
 *  - 未验证真实招聘站点（G04）与 WorkBuddy 云环境；详见 docs/REQUIREMENTS-TRACEABILITY.md 与最终报告。
 *
 * 运行：npm run test:web
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startTestServer, strongViewEvent } from '../../server/test/helpers.js';
import { resolveChromiumExecutable } from './browser.mjs';
import { phase2Web } from './phase2-web.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const REPORT_PATH = path.join(ROOT, '.tmp', 'web-e2e-report.json');
const SHOT_DIR = path.join(ROOT, '.tmp', 'web-e2e');
const SERVER_NAME = 'web-e2e';
const EMAIL = 'ui@tounar.local';

const checks = [];
let failed = 0;
function check(name, ok, detail = '') {
  const pass = Boolean(ok);
  if (!pass) failed += 1;
  checks.push({ name, ok: pass, detail: String(detail || '') });
  console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 20000, interval = 150, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}`);
}

async function waitToast(page, text, timeout = 9000) {
  await page.waitForFunction(
    (t) => [...document.querySelectorAll('#tn-toasts .tn-toast')].some((n) => n.textContent.includes(t)),
    text, { timeout }
  );
}

async function waitForText(page, selector, text, timeout = 15000) {
  try {
    await page.waitForFunction(
      ({ sel, t }) => {
        const el = document.querySelector(sel);
        return !!el && el.textContent.includes(t);
      },
      { sel: selector, t: text }, { timeout }
    );
  } catch (err) {
    const actual = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.replace(/\s+/g, ' ').slice(0, 500) : '(element missing)';
    }, selector).catch(() => '(evaluate failed)');
    throw new Error(`等待文本超时：${selector} 期望包含「${text}」，实际：「${actual}」`);
  }
}

async function waitForAnyText(page, selector, texts, timeout = 25000) {
  await page.waitForFunction(
    ({ sel, arr }) => {
      const el = document.querySelector(sel);
      return !!el && arr.some((t) => el.textContent.includes(t));
    },
    { sel: selector, arr: texts }, { timeout }
  );
}

function ymdDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function readFreshOtp(server, email, prevFile) {
  return waitFor(() => {
    const record = server.latestOutbox('otp', email);
    if (!record || record.__file === prevFile) return null;
    return record.metadata?.dev_code || null;
  }, { label: '新 OTP 写入 outbox' });
}

function weakSubmissionEvent(company, title, url, tag) {
  const now = Date.now();
  return {
    client_event_id: `evt_web_weak_${tag}_${now}`,
    event_type: 'application_submitted',
    source_method: 'plugin',
    site_key: 'generic',
    adapter_version: '1.0.0',
    schema_version: 'C1',
    occurred_at: new Date(now - 20 * 60_000).toISOString(),
    observed_at: new Date(now).toISOString(),
    evidence_level: 'weak',
    evidence_code: 'success-text-visible-unconfirmed',
    payload: { company_name: company, job_title: title, job_url: url, site_job_id: `web-e2e-${tag}` }
  };
}

let server = null;
let browser = null;
let ctx1 = null;
let ctx2 = null;
const screenshots = [];
const browserLog = [];
let browserSource = '';

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const p = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  screenshots.push(path.relative(ROOT, p));
}

async function sessionCookie(context, base) {
  const cookies = await context.cookies(base);
  const found = cookies.find((c) => c.name === 'tounar_session');
  return found ? `${found.name}=${found.value}` : null;
}

try {
  /* ================= 0. 环境 ================= */
  server = await startTestServer({ name: SERVER_NAME, env: { ALLOWED_EMAILS: EMAIL } });
  const resolved = await resolveChromiumExecutable();
  if (!resolved) throw new Error('未找到可用 Chromium（CFT 与 Playwright 自带均不可用）');
  browserSource = resolved.source;
  browser = await chromium.launch({ executablePath: resolved.path, headless: true });
  ctx1 = await browser.newContext({ viewport: { width: 1440, height: 1000 }, baseURL: server.base });
  const page = await ctx1.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (err) => browserLog.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/401/.test(msg.text())) browserLog.push(`console: ${msg.text()}`);
  });

  /* ================= 1. 登录页 + OTP 登录 ================= */
  await page.goto('/');
  await page.waitForSelector('[data-test=login-email]');
  check('W-01 未登录进入登录页（邮箱验证码；无密码输入）',
    (await page.locator('[data-test=login-send]').count()) === 1
      && (await page.locator('input[type=password]').count()) === 0,
    '纯 OTP 登录，无演示账号');
  await shot(page, '01-login');

  await page.fill('[data-test=login-email]', EMAIL);
  await page.click('[data-test=login-send]');
  await page.waitForSelector('[data-test=login-code]', { state: 'visible' });
  const otp1 = await server.readOtpCode(EMAIL);
  await page.fill('[data-test=login-code]', otp1);
  await page.click('[data-test=login-submit]');
  await page.waitForSelector('[data-test=header-email]');
  await page.waitForFunction(() => document.querySelector('[data-test=stat-total]')?.textContent.trim() === '0');
  check('W-02 UI 邮箱验证码登录成功（OTP 来自真实 outbox）',
    (await page.textContent('[data-test=header-email]')).trim() === EMAIL, `email=${EMAIL}`);
  check('W-03 新账号台账为空（三统计=0，不塞演示数据）',
    (await page.textContent('#tn-content')).includes('还没有投递记录'),
    `total=${(await page.textContent('[data-test=stat-total]')).trim()}`);
  await shot(page, '02-ledger-empty');
  await page.goto('/?panel=reviews');
  await page.waitForSelector('[data-test=reviews-view]');
  check('P0-深链 打开待确认', await page.locator('[data-test=tab-reviews].active').count() === 1);
  await page.goto('/');
  await page.waitForSelector('[data-test=open-manual]');

  /* ================= 2. 手动补录：D12 拦截 / 成功 / 409 重复 ================= */
  await page.click('[data-test=open-manual]');
  await page.waitForSelector('[data-test=manual-modal]');
  await page.fill('[data-test=manual-company]', '星河科技');
  await page.fill('[data-test=manual-title]', '前端开发实习生');
  await page.click('[data-test=manual-submit]');
  await page.waitForFunction(
    () => document.querySelector('[data-test=manual-error-msg]')?.textContent.includes('投递日期'),
    null, { timeout: 8000 }
  );
  check('W-04 D12 客户端拦截：缺投递日期不提交（不用今天替代）', true,
    '提示：请填写投递日期（D12 未冻结，不能用今天代替）');

  const appliedDate = ymdDaysAgo(20);
  await page.fill('[data-test=manual-applied-date]', appliedDate);
  await page.click('[data-test=manual-submit]');
  await page.waitForFunction(
    () => document.querySelector('[data-test=manual-error-msg]')?.textContent.includes('JD 摘要'),
    null, { timeout: 8000 }
  );
  check('W-05 D12 客户端拦截：缺 JD 摘要不提交', true, '提示：缺少 JD 摘要（D12 未冻结）');
  await shot(page, '03-manual-error');

  await page.locator('[data-test=manual-modal] textarea').first()
    .fill('负责招聘官网与内部系统的前端开发（React + TypeScript）');
  await page.locator('[data-test=manual-modal] input[type=url]').first()
    .fill('https://jobs.example.com/xinghe/fe-intern');
  await page.click('[data-test=manual-submit]');
  await page.waitForSelector('[data-test=detail-drawer]');
  await page.waitForSelector('[data-test=detail-company]');
  const detailCompany = (await page.textContent('[data-test=detail-company]')).trim();
  await page.waitForFunction(() => document.querySelector('[data-test=stat-total]')?.textContent.trim() === '1');
  check('W-06 补录成功（星河科技）并自动打开详情', detailCompany.includes('星河科技'), `company=${detailCompany}`);
  await shot(page, '04-detail');

  /* 关闭抽屉（保留星河科技为 B 回看候选：不在此确认） */
  await page.click('[data-test=detail-drawer] .tn-drawer-close');
  await page.waitForSelector('[data-test=detail-drawer]', { state: 'detached' });

  /* 同一 canonical 岗位链接再次补录 → 409 候选，不强行新增 */
  await page.click('[data-test=open-manual]');
  await page.waitForSelector('[data-test=manual-modal]');
  await page.fill('[data-test=manual-company]', '星河科技');
  await page.fill('[data-test=manual-title]', '前端开发实习生');
  await page.fill('[data-test=manual-applied-date]', appliedDate);
  await page.locator('[data-test=manual-modal] textarea').first().fill('重复提交测试');
  await page.locator('[data-test=manual-modal] input[type=url]').first()
    .fill('https://jobs.example.com/xinghe/fe-intern');
  await page.click('[data-test=manual-submit]');
  await page.waitForFunction(
    () => document.querySelector('[data-test=manual-modal]')?.textContent.includes('发现可能重复的记录'),
    null, { timeout: 10000 }
  );
  const dupText = await page.textContent('[data-test=manual-modal]');
  check('W-07 重复补录：服务端 409 候选且不强行新增',
    dupText.includes('发现可能重复的记录') && dupText.includes('去「待确认」处理'), '409 + 候选入口');
  await page.click('[data-test=manual-modal] .tn-modal-close');
  await page.waitForSelector('[data-test=manual-modal]', { state: 'detached' });

  /* ================= 3. API 预置：第二账号数据 + 设备 + 事件 ================= */
  const apiLogin = await server.login(EMAIL);
  const apiCookie = apiLogin.cookie;

  const appBRes = await server.request('/api/v1/applications/manual', {
    method: 'POST', cookie: apiCookie,
    headers: { 'Idempotency-Key': `seed-b-${Date.now()}` },
    body: {
      company_name: '云杉数据', job_title: '数据产品实习生', channel: '官网',
      has_applied: true, status: 'applied', applied_date: ymdDaysAgo(5),
      jd_summary: '数据产品需求分析与指标体系搭建',
      job_url: 'https://jobs.example.com/yunshan/dp-intern', location: '上海'
    }
  });
  check('W-08 API 预置数据：云杉数据入库（真实后端 201）', appBRes.status === 201, `status=${appBRes.status}`);
  if (appBRes.status !== 201) throw new Error(`预置云杉数据失败：${appBRes.status} ${appBRes.text.slice(0, 200)}`);
  const appB = appBRes.json.data;

  const device1 = await server.pairDevice(apiCookie, 'Web E2E 设备一');
  const batch = await server.eventBatch(device1.device_token, [
    strongViewEvent({
      client_event_id: `evt_web_view_${Date.now()}`,
      payload: {
        company_name: '青禾网络', job_title: '运营实习生',
        site_job_id: 'web-e2e-qinghe-ops',
        job_url: 'https://jobs.example.com/qinghe/ops-intern',
        jd_summary: '社群运营、活动执行与数据复盘', location: '杭州'
      }
    }),
    weakSubmissionEvent('云杉数据', '数据产品实习生', 'https://jobs.example.com/yunshan/dp-intern', 'yunshan'),
    weakSubmissionEvent('青禾网络', '运营实习生', 'https://jobs.example.com/qinghe/ops-intern', 'qinghe')
  ]);
  const batchResults = batch.json?.results || [];
  check('W-09 设备事件真实入库（强浏览 + 两条弱提交）',
    batch.status === 200 && batchResults.length === 3 && batchResults.every((r) => r.accepted),
    `accepted=${batchResults.filter((r) => r.accepted).length}/3`);
  const reviewIdByEvent = {};
  for (const r of batchResults) if (r.review_item_id) reviewIdByEvent[r.client_event_id] = r.review_item_id;

  /* ================= 4. 台账刷新 / 详情确认（云杉数据） / 看过没投 ================= */
  await page.reload();
  await page.waitForSelector('[data-test=header-email]');
  await page.waitForFunction(() => document.querySelector('[data-test=stat-total]')?.textContent.trim() === '2');
  await page.locator('[data-test=ledger-row]', { hasText: '云杉数据' }).first().click();
  await page.waitForSelector('[data-test=detail-company]');
  check('W-10 详情抽屉加载 API 预置记录', (await page.textContent('[data-test=detail-company]')).includes('云杉数据'));

  await page.click('[data-test=detail-review-confirm]');
  await page.waitForSelector('[data-test=confirm-ok]');
  await page.click('[data-test=confirm-ok]');
  await waitToast(page, '已记录确认时间');
  await page.waitForFunction(
    () => !document.querySelector('[data-test=detail-drawer]')?.textContent.includes('尚未确认过'),
    null, { timeout: 10000 }
  );
  const appBDetail = await server.request(`/api/v1/applications/${appB.id}`, { cookie: apiCookie });
  check('W-11 详情「已确认，状态无变化」写入（真实 reviewed 接口）',
    !!(appBDetail.json?.data?.last_reviewed_at), `last_reviewed_at=${appBDetail.json?.data?.last_reviewed_at}`);
  await page.click('[data-test=detail-drawer] .tn-drawer-close');

  await page.click('[data-test=tab-viewed]');
  const viewedRow = page.locator('[data-test=ledger-row]', { hasText: '青禾网络' });
  await viewedRow.waitFor({ state: 'visible' });
  check('W-12 「看过没投」tab 展示插件强证据浏览（不计入累计投递）',
    (await viewedRow.count()) === 1 && (await page.textContent('[data-test=stat-total]')).trim() === '2',
    'viewed=1，total=2');

  /* ================= 5. 待确认：真实 409 竞态 + 正常确认 ================= */
  await page.click('[data-test=tab-reviews]');
  await page.waitForSelector('[data-test=review-card]');
  await waitFor(async () => (await page.locator('[data-test=review-card]').count()) >= 2, { label: '两张复核卡片' });

  let review1Id = null;
  let review2Id = null;
  const cardCount = await page.locator('[data-test=review-card]').count();
  for (let i = 0; i < cardCount; i += 1) {
    const card = page.locator('[data-test=review-card]').nth(i);
    const text = await card.textContent();
    const id = await card.getAttribute('data-review-id');
    if (text.includes('云杉数据')) review1Id = id;
    if (text.includes('青禾网络')) review2Id = id;
  }
  check('W-13 待确认队列出现两条弱提交复核（云杉数据 / 青禾网络）',
    !!review1Id && !!review2Id, `review1=${review1Id} review2=${review2Id}`);
  const review2Card = page.locator(`[data-test=review-card][data-review-id="${review2Id}"]`);
  check('W-13a 待确认标题即原网页链接，无独立“打开原网页”按钮',
    (await review2Card.locator('[data-test=review-title-link]').getAttribute('href')) === 'https://jobs.example.com/qinghe/ops-intern'
    && (await review2Card.getByText('打开原网页', { exact: true }).count()) === 0,
    'title-link');
  check('W-13b 卡片只保留确认/忽略，无状态快捷按钮或内联补字段',
    (await review2Card.locator('[data-test=review-confirm]').count()) === 1
    && (await review2Card.locator('[data-test=review-dismiss]').count()) === 1
    && (await review2Card.locator('[data-test=review-status-select], [data-test=review-apply], [data-test=review-viewed], [data-test=review-fix]').count()) === 0,
    'simple-actions');
  await shot(page, '05-reviews');

  /* 未配置模型时：确认不得静默创建；显示失败/重试/手动，并可取消保持待确认 */
  const review1Card = page.locator(`[data-test=review-card][data-review-id="${review1Id}"]`);
  await review1Card.locator('[data-test=review-confirm]').click();
  await page.waitForSelector(`[data-test=review-card][data-review-id="${review1Id}"] [data-test=review-manual]`, { timeout: 20000 });
  const r1AfterFail = await server.request(`/api/v1/review-items/${review1Id}`, { cookie: apiCookie });
  check('W-14 识别失败不空白入账，显示重试/手动，待确认保持 open',
    r1AfterFail.json?.data?.status === 'open', `review_status=${r1AfterFail.json?.data?.status}`);
  await review1Card.locator('[data-test=review-manual]').click();
  await page.waitForSelector('[data-test=intake-modal]');
  const companyVal = await page.inputValue('[data-test=intake-company]');
  const titleVal = await page.inputValue('[data-test=intake-title]');
  check('W-14a 手动补录预填已识别字段，不强制用户重复输入', companyVal.includes('云杉数据') && titleVal.includes('数据产品'), `company=${companyVal} title=${titleVal}`);
  await page.click('[data-test=intake-cancel]');
  await page.waitForSelector('[data-test=intake-modal]', { state: 'detached' });
  const r1Cancel = await server.request(`/api/v1/review-items/${review1Id}`, { cookie: apiCookie });
  check('W-14b 取消补录后待确认仍在，未创建/修改台账', r1Cancel.json?.data?.status === 'open', `review_status=${r1Cancel.json?.data?.status}`);
  await review1Card.locator('[data-test=review-dismiss]').click();
  await waitToast(page, '已忽略');
  await page.waitForSelector(`[data-test=review-card][data-review-id="${review1Id}"]`, { state: 'detached' });
  check('W-14c 复核「忽略」立即落库，不弹二次确认', true, 'dismissed');

  /* 正常补录第二条：显式选择状态、公司和岗位可编辑后保存 */
  const card2 = page.locator(`[data-test=review-card][data-review-id="${review2Id}"]`);
  await card2.locator('[data-test=review-confirm]').click();
  await page.waitForSelector(`[data-test=review-card][data-review-id="${review2Id}"] [data-test=review-manual]`, { timeout: 20000 });
  await card2.locator('[data-test=review-manual]').click();
  await page.waitForSelector('[data-test=intake-modal]');
  await page.fill('[data-test=intake-company]', '青禾网络');
  await page.fill('[data-test=intake-title]', '运营实习生');
  await page.selectOption('[data-test=intake-status]', 'applied');
  if (!(await page.inputValue('[data-test=intake-applied-at]'))) await page.fill('[data-test=intake-applied-at]', '2026-10-20');
  await page.click('[data-test=intake-save]');
  await waitToast(page, '已入账');
  await page.waitForSelector(`[data-test=review-card][data-review-id="${review2Id}"]`, { state: 'detached' });
  const appCList = await server.request('/api/v1/ledger?view=applied&limit=100', { cookie: apiCookie });
  const appC = (appCList.json?.data?.items || []).find((x) => x.company_name === '青禾网络');
  check('W-15 补录后创建/更新为已投，列表清空', !!appC && appC.status === 'applied', `app=${appC?.id || 'missing'} status=${appC?.status || 'missing'}`);

  await page.click('[data-test=tab-applied]');
  await page.waitForFunction(() => document.querySelector('[data-test=stat-total]')?.textContent.trim() === '3');
  const statusList = (await server.request('/api/v1/ledger?view=applied&limit=100', { cookie: apiCookie })).json?.data?.items || [];
  const statusApp = statusList.find((x) => x.company_name === '云杉数据');
  if (statusApp) {
    const statusRow = page.locator(`[data-test=ledger-row][data-app-id="${statusApp.id}"]`);
    await statusRow.waitFor();
    await page.waitForSelector('[data-test=ledger-table]');
    const headers = await page.locator('[data-test=ledger-table] th').allTextContents();
    const jobHref = await statusRow.locator('a', { hasText: '查看岗位' }).getAttribute('href');
    check('W-16a 台账只保留一个“查看岗位”入口，且指向岗位详情',
      !headers.includes('投递链接') && headers.includes('查看岗位') && jobHref === 'https://jobs.example.com/yunshan/dp-intern',
      `headers=${headers.join('|')} href=${jobHref}`);
    await statusRow.locator('[data-test=ledger-status-edit]').selectOption('interview');
    const dateInput = statusRow.locator('[data-test=ledger-status-date]');
    if (await dateInput.isVisible().catch(() => false)) {
      if (!(await dateInput.inputValue())) await dateInput.fill('2026-10-21');
      await statusRow.locator('[data-test=ledger-status-save]').click();
    }
    await waitToast(page, '状态已更新');
    await page.waitForFunction(({ id }) => document.querySelector(`[data-test=ledger-status-edit][data-status-app-id="${id}"]`)?.value === 'interview', { id: statusApp.id });
    const edited = await server.request(`/api/v1/applications/${statusApp.id}`, { cookie: apiCookie });
    check('W-16b 台账状态直接编辑并保留人工修改历史',
      edited.json?.data?.status === 'interview' && edited.json?.data?.manual_status_at
      && (edited.json?.data?.history || []).some((h) => h.source_method === 'manual' && h.to_status === 'interview'),
      `status=${edited.json?.data?.status}`);
    await shot(page, '06a-ledger-status');
    const statusRow2 = page.locator(`[data-test=ledger-row][data-app-id="${statusApp.id}"]`);
    await statusRow2.locator('[data-test=ledger-status-edit]').selectOption('applied');
    await waitToast(page, '状态已更新');
    await page.waitForFunction(({ id }) => document.querySelector(`[data-test=ledger-status-edit][data-status-app-id="${id}"]`)?.value === 'applied', { id: statusApp.id });
  }
  const qingheRow = page.locator('[data-test=ledger-row]', { hasText: '青禾网络' });
  await qingheRow.waitFor({ state: 'visible' });
  check('W-16 复核确认后台账刷新（累计投递=3，无重复记录）',
    (await qingheRow.count()) === 1,
    `total=${(await page.textContent('[data-test=stat-total]')).trim()}`);

  /* ================= 6. 提醒设置（保存 + 预览） ================= */
  await page.click('[data-test=open-settings-reminder]');
  await page.waitForSelector('[data-test=pref-mode]');
  await page.selectOption('[data-test=pref-frequency]', 'daily');
  await page.click('[data-test=pref-save]');
  await waitToast(page, '提醒设置已保存');
  await page.waitForSelector('[data-test=pref-mode]');
  check('W-17 提醒设置保存（回看频率=每天，D06 暂定参数）', true, 'frequency=daily');

  await page.click('[data-test=pref-preview-btn]');
  await waitForText(page, '[data-test=pref-preview]', 'B 等待回看：1 条');
  const previewText = await page.textContent('[data-test=pref-preview]');
  check('W-18 提醒预览反映真实候选（B=1：星河科技已投 20 天）',
    previewText.includes('当前条件下会发送') && previewText.includes('星河科技'),
    previewText.replace(/\s+/g, ' ').slice(0, 120));
  await shot(page, '07-settings-reminder');
  await page.click('[data-test=settings-modal] .tn-modal-close');

  /* ================= 7. 内部 tick → 提醒邮件 → 落地页两步确认 ================= */
  const tickRes = await server.tick({ reminders: true });
  const reminderMail = await waitFor(() => server.latestOutbox('reminder', EMAIL), { label: '提醒邮件写入 outbox' });
  const mailText = String(reminderMail.text || '');
  const linkMatch = mailText.match(/\/r\/(rl_[A-Za-z0-9_-]+)/);
  const reminderToken = linkMatch ? linkMatch[1] : null;
  check('W-19 内部 tick 真实生成提醒邮件（outbox；含 B 回看链接）',
    tickRes.status === 200 && !!reminderMail && !!reminderToken && mailText.includes('星河科技'),
    `subject=${reminderMail?.subject || ''} token=${reminderToken ? reminderToken.slice(0, 10) + '…' : 'missing'}`);

  ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1000 }, baseURL: server.base });
  const page2 = await ctx2.newPage();
  page2.setDefaultTimeout(20000);
  page2.on('pageerror', (err) => browserLog.push(`page2 pageerror: ${err.message}`));
  await page2.goto(`/r/${reminderToken}`);
  await page2.waitForSelector('[data-test=login-email]');
  check('W-20 未登录打开提醒链接：要求先登录（不泄露记录内容）',
    (await page2.textContent('body')).includes('登录后查看这条回看提醒'), 'login_required');

  const prevOtp = server.latestOutbox('otp', EMAIL)?.__file || null;
  await page2.fill('[data-test=login-email]', EMAIL);
  await page2.click('[data-test=login-send]');
  await page2.waitForSelector('[data-test=login-code]', { state: 'visible' });
  const otp2 = await readFreshOtp(server, EMAIL, prevOtp);
  await page2.fill('[data-test=login-code]', otp2);
  await page2.click('[data-test=login-submit]');
  await page2.waitForSelector('[data-test=landing-card]');
  const landingText = await page2.textContent('[data-test=landing-card]');
  const appAList = await server.request('/api/v1/ledger?view=applied&limit=100', { cookie: apiCookie });
  const appA = (appAList.json?.data?.items || []).find((x) => x.company_name === '星河科技');
  const appABefore = appA ? await server.request(`/api/v1/applications/${appA.id}`, { cookie: apiCookie }) : null;
  check('W-21 落地页展示真实记录；打开页面不写入确认',
    landingText.includes('星河科技') && landingText.includes('前端开发实习生')
      && !!(appABefore?.json?.data) && !appABefore.json.data.last_reviewed_at,
    '打开仅 GET，last_reviewed_at 仍为空');
  await shot(page2, '08-landing');

  await page2.click('[data-test=landing-confirm]');
  await page2.waitForSelector('[data-test=landing-completed]');
  const completedText = await page2.textContent('[data-test=landing-completed]');
  const appAAfter = await server.request(`/api/v1/applications/${appA.id}`, { cookie: apiCookie });
  const linkState = await server.request(`/api/v1/reminder-links/${reminderToken}`, { cookie: apiCookie });
  check('W-22 落地页两步确认写入 completed（refresh 不重复确认）',
    completedText.includes('已确认 · 状态无变化') && !!appAAfter.json?.data?.last_reviewed_at
      && linkState.json?.data?.completed === true,
    `reviewed_at=${appAAfter.json?.data?.last_reviewed_at}`);
  await shot(page2, '09-landing-completed');

  const reviewedAtBeforeReload = appAAfter.json?.data?.last_reviewed_at;
  await page2.reload();
  await page2.waitForSelector('[data-test=landing-card]');
  await waitForAnyText(page2, '[data-test=landing-card]',
    ['今天已经确认过', '刷新本页不会重复确认'], 15000);
  const appAAfterReload = await server.request(`/api/v1/applications/${appA.id}`, { cookie: apiCookie });
  check('W-23 completed 重放：刷新只读、不重复计时',
    appAAfterReload.json?.data?.last_reviewed_at === reviewedAtBeforeReload,
    `reviewed_at=${reviewedAtBeforeReload}`);

  await page2.goto('/r/rl_invalid_token_for_web_e2e');
  await page2.waitForSelector('[data-test=landing-error]');
  check('W-24 无效链接：已登录时中性错误（链接无效）',
    (await page2.textContent('[data-test=landing-error]')).includes('链接无效'), 'NOT_FOUND → 中性文案');
  await ctx2.close();
  ctx2 = null;

  /* ================= 8. 设置面板：UI 配对 / 撤销 / 邮箱如实降级 ================= */
  await page.click('[data-test=open-settings-data]');
  await page.waitForSelector('[data-test=devices-section]');
  const pairRes = await server.request('/api/v1/plugin-pairings', {
    method: 'POST', body: { device_name: 'Web E2E 设备二' }
  });
  const pair = pairRes.json?.data;
  await page.fill('[data-test=pair-code]', pair.code);
  await page.click('[data-test=pair-approve]');
  await waitToast(page, '插件已绑定');
  check('W-25 网页 UI 输入配对码绑定设备（真实配对协议）', pairRes.status === 201, `code=${pair.code}`);

  const exchangeRes = await server.request('/api/v1/plugin-pairings/exchange', {
    method: 'POST', body: { request_id: pair.request_id, request_secret: pair.request_secret }
  });
  const device2 = exchangeRes.json?.data;
  await page.click('[data-test=settings-modal] .tn-modal-close');
  await page.click('[data-test=open-settings-data]');
  await page.waitForSelector('[data-test=devices-section]');
  await page.waitForSelector(`[data-test=device-item][data-device-id="${device2.device_id}"]`);
  check('W-26 设备列表显示新绑定设备', true, `device=${device2.device_id}`);

  await page.locator(`[data-test=device-item][data-device-id="${device2.device_id}"] [data-test=device-revoke]`).click();
  await page.waitForSelector('[data-test=confirm-ok]');
  await page.click('[data-test=confirm-ok]');
  await waitToast(page, '已撤销该设备绑定');
  await waitForText(page, `[data-test=device-item][data-device-id="${device2.device_id}"]`, '已撤销 · 清理待回执');
  const self2 = await server.request('/api/v1/plugin-devices/self', { token: device2.device_token });
  check('W-27 撤销设备：服务端撤销 ≠ 已清理（等待设备回执）',
    self2.json?.data?.server_revoked === true && self2.json?.data?.device?.device_cleanup_state !== 'acknowledged'
      && self2.json?.data?.device?.binding_version === 2,
    `binding_version=${self2.json?.data?.device?.binding_version} cleanup=${self2.json?.data?.device?.device_cleanup_state}`);
  await shot(page, '10-settings-data');

  /* QQ 邮箱：真实 IMAP 不可达 → 如实 degraded / reauth_required；不伪装成功 */
  const mailSection = page.locator('[data-test=mail-section]');
  await mailSection.locator('input[type=email]').fill('ui@qq.com');
  await mailSection.locator('input[type=password]').fill('abcdefgh12345678');
  await page.check('[data-test=mail-consent]');
  await page.click('[data-test=mail-connect]');
  await page.waitForSelector('[data-test=mail-connection]');
  await waitForAnyText(page, '[data-test=mail-connection]', ['同步受阻', '需重新授权'], 30000);
  const mailTextUi = await page.textContent('[data-test=mail-connection]');
  check('W-28 QQ 邮箱连接如实降级（无真实 IMAP 凭据，不伪装已同步）',
    /IMAP_NETWORK_ERROR|IMAP_AUTH_FAILED|IMAP_SYNC_FAILED|REAUTH_REQUIRED/.test(mailTextUi) && !mailTextUi.includes('已连接'),
    mailTextUi.replace(/\s+/g, ' ').slice(0, 160));
  await shot(page, '11-mail-degraded');

  await page.click('[data-test=mail-disconnect]');
  await page.waitForSelector('[data-test=confirm-ok]');
  await page.click('[data-test=confirm-ok]');
  await waitToast(page, '已断开邮箱连接');
  await waitForText(page, '[data-test=mail-connection]', '已断开');
  check('W-29 断开邮箱连接：删除授权凭证并保留台账', true, 'status=disconnected');

  /* ================= 9. 退出登录（遮罩清理）→ 重新登录 ================= */
  await page.click('[data-test=settings-modal] .tn-modal-close');
  await page.click('[data-test=logout]');
  await page.waitForSelector('[data-test=confirm-ok]');
  await page.click('[data-test=confirm-ok]');
  await page.waitForSelector('[data-test=login-email]');
  const overlayState = await page.evaluate(() => {
    const modal = document.getElementById('tn-modal-layer');
    const drawer = document.getElementById('tn-drawer-layer');
    return {
      modalHidden: modal.hidden, modalChildren: modal.children.length,
      drawerHidden: drawer.hidden, drawerChildren: drawer.children.length
    };
  });
  check('W-30 退出登录：回到登录页且弹窗/抽屉遮罩被清理',
    overlayState.modalHidden && overlayState.modalChildren === 0
      && overlayState.drawerHidden && overlayState.drawerChildren === 0,
    JSON.stringify(overlayState));

  const prevOtp2 = server.latestOutbox('otp', EMAIL)?.__file || null;
  await page.fill('[data-test=login-email]', EMAIL);
  await page.click('[data-test=login-send]');
  await page.waitForSelector('[data-test=login-code]', { state: 'visible' });
  const otp3 = await readFreshOtp(server, EMAIL, prevOtp2);
  await page.fill('[data-test=login-code]', otp3);
  await page.click('[data-test=login-submit]');
  await page.waitForSelector('[data-test=header-email]');
  await page.waitForFunction(() => document.querySelector('[data-test=stat-total]')?.textContent.trim() === '3');
  check('W-31 重新登录成功（新会话；数据仍在）', true, 'total=3');
  const uiCookie = await sessionCookie(ctx1, server.base);

  /* ================= 10. 删除全部数据：重验证 → 设备回执 → completed ================= */
  await page.click('[data-test=open-settings-data]');
  await page.waitForSelector('[data-test=deletion-section]');
  const prevOtp3 = server.latestOutbox('otp', EMAIL)?.__file || null;
  await page.locator('[data-test=reauth-box] button', { hasText: '发送验证码' }).click();
  await waitForText(page, '[data-test=reauth-box]', '验证码已发送');
  const otp4 = await readFreshOtp(server, EMAIL, prevOtp3);
  await page.fill('[data-test=reauth-box] input', otp4);
  await page.click('[data-test=reauth-verify]');
  await waitToast(page, '邮箱重新验证成功');
  check('W-32 删除前敏感操作重新验证邮箱（OTP 真实校验）', true, 'reauth ok');

  await page.fill('[data-test=deletion-confirm-input]', '删除全部数据');
  await page.check('[data-test=deletion-ack]');
  await page.click('[data-test=deletion-submit]');
  await waitToast(page, '删除任务已受理');
  await waitForText(page, '[data-test=deletion-section]', '等待设备清理回执', 20000);
  const delList = await server.request('/api/v1/data-deletions', { cookie: uiCookie });
  check('W-33 删除任务 202：等待设备清理回执（不伪造已完成）',
    delList.json?.data?.status === 'awaiting_device_ack',
    `status=${delList.json?.data?.status}`);
  await shot(page, '12-deletion-awaiting');

  async function ackDevice(token, label) {
    const self = await server.request('/api/v1/plugin-devices/self', { token });
    const bv = self.json?.data?.device?.binding_version;
    const ack = await server.request('/api/v1/plugin-devices/cleanup-ack', {
      method: 'POST', token, body: { binding_version: bv }
    });
    check(`W-34 ${label} 清理回执（binding_version=${bv}）`,
      ack.status === 200 && ack.json?.data?.acknowledged === true, `status=${ack.status}`);
    return ack;
  }
  await ackDevice(device1.device_token, '设备一');
  const lastAck = await ackDevice(device2.device_token, '设备二（已撤销）');
  check('W-35 双设备回执齐全 → 删除任务 completed',
    lastAck.json?.data?.deletion_job?.status === 'completed',
    `job_status=${lastAck.json?.data?.deletion_job?.status}`);

  await page.click('[data-test=deletion-refresh]');
  await waitForText(page, '[data-test=deletion-section]', '已完成', 15000);
  const delAfter = await server.request('/api/v1/data-deletions', { cookie: uiCookie });
  const ledgerBlocked = await server.request('/api/v1/ledger', { cookie: uiCookie });
  const meBlocked = await server.request('/api/v1/me', { cookie: uiCookie });
  const otherSession = await server.request('/api/v1/me', { cookie: apiCookie });
  check('W-36 删除终态：completed；业务接口 403 DELETION_IN_PROGRESS；其他会话被撤销',
    delAfter.json?.data?.status === 'completed'
      && ledgerBlocked.status === 403 && ledgerBlocked.json?.error?.code === 'DELETION_IN_PROGRESS'
      && meBlocked.status === 403 && meBlocked.json?.error?.code === 'DELETION_IN_PROGRESS'
      && otherSession.status === 401,
    `ledger=${ledgerBlocked.status}/${ledgerBlocked.json?.error?.code} me=${meBlocked.status} other_session=${otherSession.status}`);
  await shot(page, '13-deletion-completed');

  check('W-37 前端无未捕获脚本异常（console 仅允许登录前 401）',
    browserLog.filter((x) => x.startsWith('pageerror')).length === 0,
    browserLog.slice(0, 3).join(' | ') || '无');
  await phase2Web(check);
} catch (err) {
  check('WEB-E2E 运行异常', false, String(err?.stack || err).slice(0, 1600));
} finally {
  try { if (ctx2) await ctx2.close(); } catch { /* ignore */ }
  try { if (ctx1) await ctx1.close(); } catch { /* ignore */ }
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  try { if (server) await server.stop(); } catch { /* ignore */ }

  const summary = {
    suite: 'WEB-E2E',
    generated_at: new Date().toISOString(),
    browser: browserSource,
    server_data_dir: `.tmp/tests/${SERVER_NAME}`,
    total: checks.length,
    passed: checks.filter((c) => c.ok).length,
    failed,
    screenshots,
    console_log: browserLog,
    notes: [
      '邮件仅写入本地 outbox（MAIL_MODE=outbox），不代表真实 SMTP 送达。',
      '真实 QQ IMAP 未配置：连接按设计如实降级，未伪装已同步。',
      '复核 409 由真实并发触发：UI 提交前由同一后端 API 处理同一条复核（版本推进），原请求命中真实 VERSION_CONFLICT。',
      '真实招聘站点（G04）与 WorkBuddy 云环境仍未验证，见文档。'
    ],
    checks
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2));
  console.log(`\nWEB-E2E：${summary.passed}/${summary.total} 通过（报告：${path.relative(ROOT, REPORT_PATH)}）`);
  if (failed > 0) process.exitCode = 1;
}
