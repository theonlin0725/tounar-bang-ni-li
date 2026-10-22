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
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startTestServer, strongViewEvent } from '../../server/test/helpers.js';
import { resolveChromiumExecutable } from './browser.mjs';

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

/* P2 Web E2E 的邮件夹具：真实后端 + 真实 SQLite。这里只在测试库里模拟
   「邮件链路已经写入的历史/复核」，不绕过任何 HTTP 行为；生产代码不包含测试入口。 */
function dbExec(dir, sql) {
  execFileSync('sqlite3', [path.join(dir, 'tounar.sqlite'), sql], { encoding: 'utf8' });
}
function dbQuery(dir, sql) {
  const out = execFileSync('sqlite3', ['-json', path.join(dir, 'tounar.sqlite'), sql], { encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : [];
}
function sqlQuote(value) {
  return value == null ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`;
}

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
  const confText = (await page.locator(`[data-test=review-card][data-review-id="${review1Id}"] [data-test=review-confidence]`).textContent()).trim();
  const cardText = await page.locator(`[data-test=review-card][data-review-id="${review1Id}"]`).textContent();
  check('W-13a 卡片一句话结论 + 把握度（说明自动更新门槛）',
    /系统把握度 \d+%/.test(confText) && /需要 (80|90)%/.test(cardText)
      && cardText.includes('对，更新台账'),
    confText.slice(0, 90));
  await shot(page, '05-reviews');

  /* 真实 409：拦截 UI 的 resolve POST，先用真实 API 修正候选记录（版本 +1），再放行原请求 */
  const resolvePattern = `**/api/v1/review-items/${review1Id}/resolve`;
  let raced = false;
  const raceHandler = async (route) => {
    if (!raced) {
      raced = true;
      const freshApp = await server.request(`/api/v1/applications/${appB.id}`, { cookie: apiCookie });
      const version = freshApp.json?.data?.version;
      const corrected = await server.request(`/api/v1/applications/${appB.id}/corrections`, {
        method: 'POST', cookie: apiCookie,
        headers: { 'Idempotency-Key': `e2e-race-corr-${Date.now()}` },
        body: { expected_version: version, changes: { location: '上海·徐汇' }, reason: 'E2E 并发竞态：另一标签页修正' }
      });
      check('W-14a 竞态准备：另一会话真实修正候选记录（版本推进）', corrected.status === 200,
        `correct_status=${corrected.status} version=${version}`);
    }
    await route.continue();
  };
  await page.route(resolvePattern, raceHandler);
  const [raceResponse] = await Promise.all([
    page.waitForResponse((resp) => resp.url().includes(`/api/v1/review-items/${review1Id}/resolve`)
      && resp.request().method() === 'POST'),
    page.locator(`[data-test=review-card][data-review-id="${review1Id}"] [data-test=review-confirm]`).click()
  ]);
  const raceStatus = raceResponse.status();
  await waitToast(page, '复核项或候选记录已被更新');
  await page.unroute(resolvePattern, raceHandler);
  const review1After = await server.request(`/api/v1/review-items/${review1Id}`, { cookie: apiCookie });
  check('W-14 复核 409 竞态：服务端真实 VERSION_CONFLICT，UI 明确提示且不覆盖',
    raceStatus === 409 && review1After.json?.data?.status === 'open',
    `http=${raceStatus} review_status=${review1After.json?.data?.status}`);
  await shot(page, '06-review-conflict');

  /* 该复核项未被覆盖：用「忽略」二次确认清理（也验证 dismiss 路径） */
  await page.locator(`[data-test=review-card][data-review-id="${review1Id}"] [data-test=review-dismiss]`).click();
  await page.waitForSelector('[data-test=confirm-ok]');
  await page.click('[data-test=confirm-ok]');
  await waitToast(page, '已忽略该线索');
  await page.waitForSelector(`[data-test=review-card][data-review-id="${review1Id}"]`, { state: 'detached' });
  check('W-14b 复核「忽略」二次确认后落库（无并发覆盖）', true, 'dismissed');

  /* 正常确认第二条（青禾网络：pending → applied） */
  await page.locator(`[data-test=review-card][data-review-id="${review2Id}"] [data-test=review-confirm]`).click();
  await waitToast(page, '已更新：青禾网络');
  await page.waitForSelector(`[data-test=review-card][data-review-id="${review2Id}"]`, { state: 'detached' });
  const appCList = await server.request('/api/v1/ledger?view=applied&limit=100', { cookie: apiCookie });
  const appC = (appCList.json?.data?.items || []).find((x) => x.company_name === '青禾网络');
  check('W-15 复核正常确认：建议应用、状态变已投、列表清空',
    !!appC && appC.status === 'applied', `app=${appC?.id || 'missing'} status=${appC?.status || 'missing'}`);

  await page.click('[data-test=tab-applied]');
  await page.waitForFunction(() => document.querySelector('[data-test=stat-total]')?.textContent.trim() === '3');
  const qingheRow = page.locator('[data-test=ledger-row]', { hasText: '青禾网络' });
  await qingheRow.waitFor({ state: 'visible' });
  check('W-16 复核确认后台账刷新（累计投递=3，无重复记录）',
    (await qingheRow.count()) === 1,
    `total=${(await page.textContent('[data-test=stat-total]')).trim()}`);

  /* ================= 5b. 提醒邮件深链：待确认 / 指定记录详情 ================= */
  await page.goto('/?panel=reviews');
  await page.waitForSelector('[data-test=reviews-view]');
  const reviewsTabActive = await page.locator('[data-test=tab-reviews].active').count();
  check('W-16a 深链 /?panel=reviews 直接打开待确认 tab（不再落到台账首页）',
    reviewsTabActive === 1, `active=${reviewsTabActive}`);

  const appliedList = await server.request('/api/v1/ledger?view=applied&limit=100', { cookie: apiCookie });
  const xingheApp = (appliedList.json?.data?.items || []).find((x) => x.company_name === '星河科技');
  if (!xingheApp) throw new Error('深链测试需要星河科技记录');
  await page.goto(`/?app=${encodeURIComponent(xingheApp.id)}`);
  await page.waitForSelector('[data-test=detail-drawer]');
  await page.waitForSelector('[data-test=detail-company]');
  const deepDetail = (await page.textContent('[data-test=detail-company]')).trim();
  check('W-16b 深链 /?app=<id> 打开台账并弹出该条详情', deepDetail.includes('星河科技'), `company=${deepDetail}`);
  await page.click('[data-test=detail-drawer] .tn-drawer-close');
  await page.waitForSelector('[data-test=detail-drawer]', { state: 'detached' });
  await page.goto('/');
  await page.waitForSelector('[data-test=stat-total]');
  await page.waitForFunction(() => document.querySelector('[data-test=stat-total]')?.textContent.trim() === '3');

  /* ================= 5c. P1 待确认：无候选可点 / 搜索 / 任意关联 / 撤销 / 批量 ================= */
  const noCandBatch = await server.eventBatch(device1.device_token, [
    weakSubmissionEvent('未匹配测试公司', '神秘岗位', 'https://jobs.example.com/unknown/role', 'nocand')
  ]);
  const noCandReviewId = noCandBatch.json?.results?.[0]?.review_item_id;
  if (!noCandReviewId) throw new Error('P1 无候选复核创建失败');
  await page.goto('/?panel=reviews');
  await page.waitForSelector(`[data-test=review-card][data-review-id="${noCandReviewId}"]`);
  const noCandCard = page.locator(`[data-test=review-card][data-review-id="${noCandReviewId}"]`);
  check('W-16c 无候选记录：主按钮仍可点（不再 disabled）',
    await noCandCard.locator('[data-test=review-confirm]').isEnabled(), 'confirm enabled');
  await noCandCard.locator('[data-test=review-confirm]').click();
  await noCandCard.locator('[data-test=review-edit-form]').waitFor();
  await noCandCard.locator('[data-test=review-search]').fill('星河');
  await page.waitForFunction((id) => {
    const card = document.querySelector(`[data-test=review-card][data-review-id="${id}"]`);
    return (card?.querySelector('[data-test=review-search-results]')?.options?.length || 0) > 1;
  }, noCandReviewId, { timeout: 10000 });
  const searchOptions = await noCandCard.locator('[data-test=review-search-results]').textContent();
  check('W-16d 无候选时可搜索本人台账（按公司/岗位）',
    searchOptions.includes('星河科技'), searchOptions.replace(/\s+/g, ' ').slice(0, 80));

  const xingheBefore = await server.request(`/api/v1/applications/${xingheApp.id}`, { cookie: apiCookie });
  await noCandCard.locator('[data-test=review-search-results]').selectOption(xingheApp.id);
  await noCandCard.locator('[data-test=review-edit-submit]').click();
  await waitToast(page, '已更新：星河科技');
  await page.click('.tn-toast-action');
  await waitToast(page, '已撤回这次确认');
  await page.waitForSelector(`[data-test=review-card][data-review-id="${noCandReviewId}"]`);
  const xingheAfterUndo = await server.request(`/api/v1/applications/${xingheApp.id}`, { cookie: apiCookie });
  check('W-16e 任意记录关联 + 撤销：复核重新打开、记录字段恢复',
    xingheAfterUndo.json?.data?.status === xingheBefore.json?.data?.status
      && xingheAfterUndo.json?.data?.applied_at === xingheBefore.json?.data?.applied_at,
    `status=${xingheAfterUndo.json?.data?.status} applied_at=${xingheAfterUndo.json?.data?.applied_at}`);

  await noCandCard.locator('[data-test=review-dismiss]').click();
  await page.waitForSelector('[data-test=confirm-ok]');
  await page.click('[data-test=confirm-ok]');
  await waitToast(page, '已忽略该线索');
  await page.waitForSelector(`[data-test=review-card][data-review-id="${noCandReviewId}"]`, { state: 'detached' });

  const batchSeed = await server.eventBatch(device1.device_token, [
    weakSubmissionEvent('云杉数据', '数据产品实习生', 'https://jobs.example.com/yunshan/dp-intern', 'batch1'),
    weakSubmissionEvent('云杉数据', '数据产品实习生', 'https://jobs.example.com/yunshan/dp-intern', 'batch2')
  ]);
  const batchReviewIds = (batchSeed.json?.results || []).map((r) => r.review_item_id).filter(Boolean);
  await page.goto('/?panel=reviews');
  await page.waitForSelector('[data-test=review-batch-confirm]');
  await waitForText(page, '[data-test=review-batch-confirm]', '全部确认（2 条）');
  await page.click('[data-test=review-batch-confirm]');
  await page.waitForSelector('[data-test=confirm-ok]');
  await page.click('[data-test=confirm-ok]');
  await waitToast(page, '已按系统判断确认 2 条');
  await waitFor(async () => (await page.locator('[data-test=review-card]').count()) === 0,
    { label: '批量确认后队列清空' });
  const reviewsAfterBatch = await server.request('/api/v1/review-items?status=open', { cookie: apiCookie });
  check('W-16g 批量确认 ≥80%：两条逐条成功，队列清空',
    batchReviewIds.length === 2 && reviewsAfterBatch.json?.data?.length === 0,
    `batch=${batchReviewIds.length} open=${reviewsAfterBatch.json?.data?.length}`);

  /* ================= 5d. P2 邮件线索：按邮件新建 + 台账静默刷新 / 撤回 ================= */
  const ownerRows = dbQuery(server.dir, "SELECT id FROM users WHERE email_normalized='ui@tounar.local'");
  const uiOwnerId = ownerRows[0]?.id;
  if (!uiOwnerId) throw new Error('P2 邮件夹具需要 UI 用户 id');
  const stamp = Date.now();
  const fixtureConn = `conn_web_mail_${stamp}`;
  const fixtureMail = `mail_web_mail_${stamp}`;
  const fixtureReview = `rev_web_mail_${stamp}`;
  const fixtureCompany = '邮件新公司';
  const fixtureTitle = '邮件新建岗位';
  const fixtureReceived = new Date(Date.now() - 2 * 86400000).toISOString();
  const fixtureCreated = new Date().toISOString();
  dbExec(server.dir, `INSERT INTO mail_connections
    (id, owner_id, email, mode, scan_since, status, consent_version, created_at, updated_at)
    VALUES (${sqlQuote(fixtureConn)}, ${sqlQuote(uiOwnerId)}, 'fixture@qq.com', 'headers_only',
      ${sqlQuote(fixtureReceived)}, 'disconnected', 'QQ_MAIL_READ_CONSENT_V1', ${sqlQuote(fixtureCreated)}, ${sqlQuote(fixtureCreated)})`);
  dbExec(server.dir, `INSERT INTO mail_messages
    (id, owner_id, connection_id, mailbox, uidvalidity, uid, message_id, subject_excerpt, from_domain,
     received_at, category, processing_state, review_item_id, created_at)
    VALUES (${sqlQuote(fixtureMail)}, ${sqlQuote(uiOwnerId)}, ${sqlQuote(fixtureConn)}, 'INBOX', '1', ${sqlQuote(String(stamp))},
      ${sqlQuote(`<fixture-${stamp}@example.com>`)}, ${sqlQuote(`${fixtureCompany} 面试邀请`)}, 'mail.example.com',
      ${sqlQuote(fixtureReceived)}, 'interview', 'pending', ${sqlQuote(fixtureReview)}, ${sqlQuote(fixtureCreated)})`);
  const fixtureEvidence = JSON.stringify({
    subject_excerpt: `${fixtureCompany} 面试邀请`,
    from_domain: 'mail.example.com',
    category: 'interview',
    confidence: 0.92,
    company_name: fixtureCompany,
    job_title: fixtureTitle,
    mail_received_at: fixtureReceived
  });
  dbExec(server.dir, `INSERT INTO review_items
    (id, owner_id, kind, reason_code, summary, evidence_json, suggested_changes_json, candidates_json,
     source_mail_id, status, version, created_at)
    VALUES (${sqlQuote(fixtureReview)}, ${sqlQuote(uiOwnerId)}, 'mail_progress', 'MAIL_MATCH_UNCONFIRMED',
      ${sqlQuote(`邮件「${fixtureCompany} 面试邀请」看起来是「${fixtureCompany} · ${fixtureTitle}」的面试邀请，但没对上台账记录`)},
      ${sqlQuote(fixtureEvidence)}, '{"status":"interview"}', '[]', ${sqlQuote(fixtureMail)}, 'open', 1, ${sqlQuote(fixtureCreated)})`);

  await page.goto('/?panel=reviews');
  const fixtureCard = page.locator(`[data-test=review-card][data-review-id="${fixtureReview}"]`);
  await fixtureCard.waitFor({ state: 'visible' });
  const fixtureCardText = await fixtureCard.textContent();
  check('W-16h 邮件线索卡片：一句话结论 + 邮件里的公司/岗位 + 新建入口',
    fixtureCardText.includes(fixtureCompany) && fixtureCardText.includes(fixtureTitle)
      && fixtureCardText.includes('面试邀请')
      && await fixtureCard.locator('[data-test=review-create-from-mail]').isVisible(),
    fixtureCardText.replace(/\s+/g, ' ').slice(0, 120));

  await fixtureCard.locator('[data-test=review-create-from-mail]').click();
  await fixtureCard.locator('[data-test=review-edit-form]').waitFor();
  const createCompany = await fixtureCard.locator('[data-test=review-create-company]').inputValue();
  const createTitle = await fixtureCard.locator('[data-test=review-create-title]').inputValue();
  const createTarget = await fixtureCard.locator('[data-test=review-target-select]').inputValue();
  const createAppliedVisible = await fixtureCard.locator('[data-test=review-applied-at]').isVisible();
  const createApplied = await fixtureCard.locator('[data-test=review-applied-at]').inputValue();
  check('W-16i 按邮件新建：公司/岗位/收信时间预填，投递时间可见',
    createCompany === fixtureCompany && createTitle === fixtureTitle && createTarget === '__create__'
      && createAppliedVisible && createApplied.length >= 10,
    `target=${createTarget} company=${createCompany} title=${createTitle} applied=${createApplied}`);

  await fixtureCard.locator('[data-test=review-edit-submit]').click();
  await waitToast(page, '已按这封邮件新建记录');
  const createdList = await server.request('/api/v1/ledger?view=applied&limit=100', { cookie: apiCookie });
  const createdMailApp = (createdList.json?.data?.items || [])
    .find((x) => x.company_name === fixtureCompany && x.job_title === fixtureTitle);
  const createdMailDetail = createdMailApp
    ? await server.request(`/api/v1/applications/${createdMailApp.id}`, { cookie: apiCookie }) : null;
  check('W-16j 按邮件新建落库：状态=面试，投递时间标记为据邮件推断',
    !!createdMailDetail?.json?.data && createdMailDetail.json.data.status === 'interview'
      && createdMailDetail.json.data.has_applied === 1
      && createdMailDetail.json.data.applied_at_precision === 'inferred_before'
      && createdMailDetail.json.data.applied_at <= fixtureReceived,
    `status=${createdMailDetail?.json?.data?.status} precision=${createdMailDetail?.json?.data?.applied_at_precision}`);
  // 夹具连接用完后删掉，避免影响后面「只允许一个 QQ 邮箱连接」的设置页测试。
  dbExec(server.dir, `DELETE FROM mail_messages WHERE id = ${sqlQuote(fixtureMail)}`);
  dbExec(server.dir, `DELETE FROM mail_connections WHERE id = ${sqlQuote(fixtureConn)}`);

  /* 台账静默刷新：模拟邮件链路写入一条「自动更新」历史并推进 revision，焦点回来时应高亮 + 顶部提示。 */
  await page.goto('/');
  await page.waitForSelector('[data-test=stat-total]');
  const refreshLedger = await server.request('/api/v1/ledger?view=applied&limit=100', { cookie: apiCookie });
  const refreshTarget = (refreshLedger.json?.data?.items || []).find((x) => x.company_name === '云杉数据');
  if (!refreshTarget) throw new Error('P2 台账刷新测试需要云杉数据记录');
  const refreshBefore = await server.request(`/api/v1/applications/${refreshTarget.id}`, { cookie: apiCookie });
  const refreshApp = refreshBefore.json.data;
  const refreshAt = new Date().toISOString();
  const refreshChanged = JSON.stringify({
    status: { from: refreshApp.status, to: 'interview' },
    last_status_changed_at: { from: refreshApp.last_status_changed_at, to: refreshAt },
    last_progress_at: { from: refreshApp.last_progress_at, to: refreshAt }
  });
  dbExec(server.dir, `UPDATE applications SET status = 'interview', last_status_changed_at = ${sqlQuote(refreshAt)},
    last_progress_at = ${sqlQuote(refreshAt)}, updated_at = ${sqlQuote(refreshAt)} WHERE id = ${sqlQuote(refreshTarget.id)}`);
  dbExec(server.dir, `INSERT INTO application_history
    (id, owner_id, application_id, event_id, from_status, to_status, changed_fields_json, changed_at, source_method, reason)
    VALUES (${sqlQuote(`hist_web_mail_${stamp}`)}, ${sqlQuote(uiOwnerId)}, ${sqlQuote(refreshTarget.id)}, NULL,
      ${sqlQuote(refreshApp.status)}, 'interview', ${sqlQuote(refreshChanged)}, ${sqlQuote(refreshAt)}, 'mail',
      '邮件自动判定：E2E 模拟邮件更新')`);
  dbExec(server.dir, "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'data_revision'");

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForSelector('[data-test=mail-update-notice]', { timeout: 15000 });
  const noticeText = (await page.textContent('[data-test=mail-update-notice]')).trim();
  const highlighted = await page.locator(`[data-test=ledger-row][data-app-id="${refreshTarget.id}"].is-changed`).count();
  check('W-16k 台账焦点静默刷新：顶部提示 + 变化行高亮',
    noticeText.includes('刚刚根据邮件更新了 1 条记录') && highlighted === 1,
    `notice=${noticeText.slice(0, 60)} highlight=${highlighted}`);

  await page.click(`[data-test=ledger-row][data-app-id="${refreshTarget.id}"]`);
  await page.waitForSelector('[data-test=detail-undo-auto-mail]');
  await page.click('[data-test=detail-undo-auto-mail]');
  await page.waitForSelector('[data-test=confirm-ok]');
  await page.click('[data-test=confirm-ok]');
  await waitToast(page, '已撤回这次自动更新');
  const refreshAfterUndo = await server.request(`/api/v1/applications/${refreshTarget.id}`, { cookie: apiCookie });
  check('W-16l 详情时间线可撤回邮件自动更新：状态恢复且留痕',
    refreshAfterUndo.json?.data?.status === refreshApp.status,
    `status=${refreshAfterUndo.json?.data?.status} expected=${refreshApp.status}`);
  if (await page.locator('[data-test=detail-drawer]').count()) {
    await page.click('[data-test=detail-drawer] .tn-drawer-close');
  }

  /* ================= 6. 提醒设置（保存 + 预览） ================= */
  // P3 夹具：让云杉数据处于「面试中」且锚点在 8 天前，验证 C 类阶段回看。
  const stageAnchor = new Date(Date.now() - 8 * 86400000).toISOString();
  dbExec(server.dir, `UPDATE applications SET status = 'interview', stage_followup_anchor = ${sqlQuote(stageAnchor)},
    last_status_changed_at = ${sqlQuote(stageAnchor)}, last_progress_at = ${sqlQuote(stageAnchor)},
    last_b_notified_at = NULL, updated_at = ${sqlQuote(new Date().toISOString())}
    WHERE id = ${sqlQuote(refreshTarget.id)}`);
  await page.click('[data-test=open-settings-reminder]');
  await page.waitForSelector('[data-test=pref-mode]');
  await page.selectOption('[data-test=pref-frequency]', 'daily');
  await page.selectOption('[data-test=pref-stage-followup]', '7');
  await page.click('[data-test=pref-save]');
  await waitToast(page, '提醒设置已保存');
  await page.waitForSelector('[data-test=pref-mode]');
  const savedPrefs = await server.request('/api/v1/notification-preferences', { cookie: apiCookie });
  check('W-17 提醒设置保存（回看频率=每天，阶段回看=7 天）',
    savedPrefs.json?.data?.review_frequency === 'daily' && savedPrefs.json?.data?.stage_followup_days === 7,
    `frequency=${savedPrefs.json?.data?.review_frequency} stage=${savedPrefs.json?.data?.stage_followup_days}`);

  await page.click('[data-test=pref-preview-btn]');
  await waitForText(page, '[data-test=pref-preview]', 'B 等待回看：1 条');
  await waitForText(page, '[data-test=pref-preview]', 'C 该回看了：1 条');
  const previewText = await page.textContent('[data-test=pref-preview]');
  check('W-18 提醒预览反映真实候选（B=1：星河科技；C=1：云杉数据阶段回看）',
    previewText.includes('当前条件下会发送') && previewText.includes('星河科技')
      && previewText.includes('C 该回看了：1 条') && previewText.includes('云杉数据'),
    previewText.replace(/\s+/g, ' ').slice(0, 160));
  await shot(page, '07-settings-reminder');
  await page.click('[data-test=settings-modal] .tn-modal-close');

  /* ================= 7. 内部 tick → 提醒邮件 → 落地页两步确认 ================= */
  const tickRes = await server.tick({ reminders: true });
  const reminderMail = await waitFor(() => server.latestOutbox('reminder', EMAIL), { label: '提醒邮件写入 outbox' });
  const mailText = String(reminderMail.text || '');
  // 邮件正文先出现 C 类（云杉数据），再出现 B 类（星河科技）；落地页测试必须取星河科技自己的链接。
  const starLinkMatch = mailText.match(/等待回看[\s\S]*?星河科技[\s\S]*?\/r\/(rl_[A-Za-z0-9_-]+)/);
  const anyLinkMatch = mailText.match(/\/r\/(rl_[A-Za-z0-9_-]+)/);
  const reminderToken = starLinkMatch ? starLinkMatch[1] : (anyLinkMatch ? anyLinkMatch[1] : null);
  check('W-19 内部 tick 真实生成提醒邮件（outbox；含 B 回看链接）',
    tickRes.status === 200 && !!reminderMail && !!reminderToken && mailText.includes('星河科技'),
    `subject=${reminderMail?.subject || ''} token=${reminderToken ? reminderToken.slice(0, 10) + '…' : 'missing'}`);
  check('W-19a 邮件落款用收信日期；「该回看了」含状态页/确认/详情三个链接',
    reminderMail.subject.includes('收到') && mailText.includes('该回看了')
      && /—— \d{4}年\d{2}月\d{2}日 收到/.test(mailText)
      && mailText.includes('https://jobs.example.com/yunshan/dp-intern')
      && mailText.includes(`/?app=${refreshTarget.id}`)
      && /\/r\/rl_[A-Za-z0-9_-]+/.test(mailText),
    `subject=${reminderMail.subject} c_detail=/?app=${refreshTarget.id}`);

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

  // 登录态失效/未登录时打开深链，登录成功后必须回到原记录详情，而不是只回台账首页。
  await page.goto(`/?app=${appA.id}`);
  await page.waitForSelector('[data-test=login-email]');
  const prevOtp2 = server.latestOutbox('otp', EMAIL)?.__file || null;
  await page.fill('[data-test=login-email]', EMAIL);
  await page.click('[data-test=login-send]');
  await page.waitForSelector('[data-test=login-code]', { state: 'visible' });
  const otp3 = await readFreshOtp(server, EMAIL, prevOtp2);
  await page.fill('[data-test=login-code]', otp3);
  await page.click('[data-test=login-submit]');
  await page.waitForSelector('[data-test=header-email]');
  await page.waitForSelector('[data-test=detail-drawer]');
  const deepLinkText = await page.textContent('[data-test=detail-drawer]');
  await page.waitForFunction(() => document.querySelector('[data-test=stat-total]')?.textContent.trim() === '4');
  check('W-31 登录后回到原深链（/?app=...）：详情抽屉打开且数据仍在',
    deepLinkText.includes('星河科技') && deepLinkText.includes('前端开发实习生'),
    `deep_link=/?app=${appA.id} total=4`);
  await page.click('[data-test=detail-drawer] .tn-drawer-close');
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
