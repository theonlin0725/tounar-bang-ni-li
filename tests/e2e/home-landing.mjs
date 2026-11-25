/*
 * 官网引导页（v1.2 landing）专项回归：
 *  - 未登录访问 / 展示官网首页，不闪现登录表单
 *  - 吸顶导航、ScrollSpy、锚点跳转、3 步说明、真实截图加载
 *  - 官网 → 登录页 → 返回官网的浏览器历史
 *  - 已登录访问 / 直接进入工作台；?view=home 可预览官网
 *  - 深链未登录仍先登录并保留 panel 参数；退出登录回到 ?view=login
 *
 * 运行：node tests/e2e/home-landing.mjs
 */
import { chromium } from 'playwright';
import { startTestServer } from '../../server/test/helpers.js';
import { resolveChromiumExecutable } from './browser.mjs';

const EMAIL = 'home-e2e@tounar.local';
const checks = [];
let failed = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = '') {
  const pass = Boolean(ok);
  if (!pass) failed += 1;
  checks.push({ name, ok: pass, detail: String(detail || '') });
  console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(fn, { timeout = 15000, interval = 150, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}`);
}

async function addSessionCookie(context, base, cookie) {
  await context.addCookies([{
    name: 'tounar_session', value: cookie.split('=').slice(1).join('='),
    domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax'
  }]);
}

let server = null;
let browser = null;

try {
  server = await startTestServer({ name: 'home-landing', env: { ALLOWED_EMAILS: EMAIL, CLOUD_LLM_ENABLED: 'false' } });
  const resolved = await resolveChromiumExecutable();
  if (!resolved) throw new Error('未找到可用 Chromium');
  browser = await chromium.launch({ headless: true, executablePath: resolved.path });

  const errors = [];
  const anon = await browser.newContext({ viewport: { width: 1440, height: 1000 }, baseURL: server.base, locale: 'zh-CN' });
  const page = await anon.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/401|404/.test(msg.text())) errors.push(`console: ${msg.text()}`);
  });

  /* ================= 1. 未登录首入官网 ================= */
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-test=home-page]');
  const title = await page.title();
  check('H-01 未登录访问 / 展示官网首页，不出现登录表单',
    title.includes('让投递更省心') && (await page.locator('[data-test=login-email]').count()) === 0,
    `title=${title}`);
  const heroText = await page.locator('[data-test=home-page]').innerText();
  check('H-02 首屏包含品牌、Slogan、主 CTA 与 3 步上手说明',
    heroText.includes('Tounar 帮你理') && heroText.includes('让投递更省心')
      && heroText.includes('立即登录，开始整理') && heroText.includes('3 步上手'),
    heroText.slice(0, 90).replace(/\n/g, ' / '));
  check('H-03 4 个功能 Tab 与下载插件/登录入口齐全',
    (await page.locator('[data-test=home-tab-capture]').count()) === 1
      && (await page.locator('[data-test=home-tab-resume]').count()) === 1
      && (await page.locator('[data-test=home-tab-mail]').count()) === 1
      && (await page.locator('[data-test=home-tab-assistant]').count()) === 1
      && (await page.locator('[data-test=home-download-plugin]').count()) === 1
      && (await page.locator('[data-test=home-nav-login]').count()) === 1);

  const heroImage = await page.evaluate(() => {
    const img = document.querySelector('[data-test=home-hero-shot] img');
    return img ? { complete: img.complete, width: img.naturalWidth, src: img.getAttribute('src') } : null;
  });
  check('H-04 Hero 真实产品截图成功加载（2x WebP）',
    Boolean(heroImage?.complete && heroImage?.width > 0 && heroImage.src?.endsWith('.webp')),
    JSON.stringify(heroImage));

  /* ================= 2. 吸顶 + ScrollSpy + 锚点 ================= */
  await page.click('[data-test=home-cta-how]');
  await page.waitForFunction(() => location.hash === '#details');
  check('H-05 「看看怎么用」平滑滚动到宣言带并同步 hash',
    (await page.evaluate(() => location.hash)) === '#details');
  await page.evaluate(() => document.getElementById('capture').scrollIntoView({ block: 'start' }));
  await waitFor(() => page.locator('[data-test=home-nav].is-scrolled').count(), { label: '吸顶阴影' });
  await waitFor(async () => (await page.locator('[data-test=home-tab-capture].is-active').count()) === 1, { label: 'ScrollSpy 高亮岗位抓取' });
  check('H-06 滚动后顶栏吸顶并自动高亮当前功能 Tab',
    (await page.locator('[data-test=home-nav].is-scrolled').count()) === 1
      && (await page.locator('[data-test=home-tab-capture].is-active').count()) === 1);

  const featureImage = await page.evaluate(() => {
    const img = document.querySelector('[data-test=home-shot-capture] img');
    return img ? { complete: img.complete, width: img.naturalWidth } : null;
  });
  check('H-07 功能截图懒加载后成功渲染', Boolean(featureImage?.complete && featureImage?.width > 0), JSON.stringify(featureImage));

  await page.click('[data-test=home-capture-toggle-applied]');
  check('H-07a 截图悬浮标注的「看过没投 / 已投递」可切换',
    (await page.getAttribute('[data-test=home-capture-toggle-applied]', 'aria-pressed')) === 'true'
      && (await page.getAttribute('[data-test=home-capture-toggle-viewed]', 'aria-pressed')) === 'false');

  await page.click('[data-test=home-tab-mail]');
  await waitFor(() => page.evaluate(() => location.hash === '#mail' && Math.abs(document.getElementById('mail').getBoundingClientRect().top - 92) < 120), { label: '跳转邮件区块' });
  check('H-08 点击 Tab 跳转对应区块且标题不被吸顶遮挡',
    (await page.evaluate(() => location.hash)) === '#mail'
      && (await page.locator('[data-test=home-tab-mail].is-active').count()) === 1);

  await page.evaluate(() => document.getElementById('start').scrollIntoView({ block: 'center' }));
  await page.click('[data-test=home-plugin-help]');
  await page.waitForSelector('[data-test=plugin-help-modal]');
  const helpText = await page.locator('[data-test=plugin-help-modal]').innerText();
  check('H-08a 官网可直接打开插件安装指引（复用现有弹窗与下载版本）',
    helpText.includes('安装浏览器插件') && helpText.includes('0.2.14'));
  await page.click('[data-test=plugin-help-close]');
  await page.locator('[data-test=plugin-help-modal]').waitFor({ state: 'detached' });

  /* ================= 3. 官网 → 登录页 → 返回 ================= */
  await page.click('[data-test=home-cta-login]');
  await page.waitForSelector('[data-test=login-email]');
  check('H-09 点击登录进入 ?view=login 的现有 OTP 登录页',
    new URL(page.url()).searchParams.get('view') === 'login'
      && (await page.locator('input[type=password]').count()) === 0);
  check('H-10 登录页提供「← 返回官网首页」',
    (await page.locator('[data-test=login-back-home]').count()) === 1);
  await page.click('[data-test=login-back-home]');
  await page.waitForSelector('[data-test=home-page]');
  check('H-11 返回官网后 URL 回到 /', new URL(page.url()).pathname === '/' && new URL(page.url()).search === '');

  await page.goBack();
  await page.waitForSelector('[data-test=login-email]');
  check('H-12 浏览器后退可从官网回到登录页', new URL(page.url()).searchParams.get('view') === 'login');
  await page.goForward();
  await page.waitForSelector('[data-test=home-page]');
  check('H-13 浏览器前进回到官网', (await page.locator('[data-test=home-page]').count()) === 1);

  /* ================= 3b. 平台分享码不因官网分流丢失 ================= */
  const sharePage = await anon.newPage();
  await sharePage.goto('/?sharecode=demo-share', { waitUntil: 'domcontentloaded' });
  await sharePage.waitForSelector('[data-test=home-page]');
  const shareDownload = await sharePage.getAttribute('[data-test=home-download-plugin]', 'href');
  check('H-13a 官网下载插件保留 ?sharecode', String(shareDownload).includes('sharecode=demo-share'), shareDownload);
  await sharePage.click('[data-test=home-cta-login]');
  await sharePage.waitForSelector('[data-test=login-email]');
  const shareLoginUrl = new URL(sharePage.url());
  check('H-13b 官网 → 登录页保留 view 与 sharecode',
    shareLoginUrl.searchParams.get('view') === 'login'
      && shareLoginUrl.searchParams.get('sharecode') === 'demo-share', shareLoginUrl.search);
  await sharePage.click('[data-test=login-back-home]');
  await sharePage.waitForSelector('[data-test=home-page]');
  check('H-13c 登录页返回官网仍保留 sharecode',
    new URL(sharePage.url()).searchParams.get('sharecode') === 'demo-share', sharePage.url());
  await sharePage.close();

  /* ================= 4. 未登录深链保持现有行为 ================= */
  await page.goto('/?panel=reviews', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-test=login-email]');
  check('H-14 未登录访问深链先登录且保留 panel 参数',
    new URL(page.url()).searchParams.get('panel') === 'reviews');
  await page.fill('[data-test=login-email]', EMAIL);
  await page.click('[data-test=login-send]');
  await page.waitForSelector('[data-test=login-code]', { state: 'visible' });
  const otp = await server.readOtpCode(EMAIL);
  await page.fill('[data-test=login-code]', otp);
  await page.click('[data-test=login-submit]');
  await page.waitForSelector('[data-test=reviews-view]');
  check('H-15 登录后恢复进入深链面板', new URL(page.url()).searchParams.get('panel') === 'reviews');
  await page.click('[data-test=logout]');
  await page.waitForSelector('[data-test=confirm-ok]');
  await page.click('[data-test=confirm-ok]');
  await page.waitForSelector('[data-test=login-email]');
  check('H-16 退出登录回到 ?view=login',
    new URL(page.url()).searchParams.get('view') === 'login');
  await anon.close();

  /* ================= 5. 已登录用户直接进工作台；?view=home 可预览 ================= */
  const login = await server.login(EMAIL);
  const authed = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: server.base, locale: 'zh-CN' });
  await addSessionCookie(authed, server.base, login.cookie);
  const p2 = await authed.newPage();
  p2.on('pageerror', (error) => errors.push(error.message));
  await p2.goto('/', { waitUntil: 'networkidle' });
  await p2.waitForSelector('[data-test=header-email]');
  check('H-17 已登录访问 / 直接进入工作台，不展示官网',
    (await p2.locator('[data-test=home-page]').count()) === 0
      && (await p2.locator('[data-test=ledger-row], [data-test=stat-total]').count()) > 0);

  await p2.goto('/?view=home', { waitUntil: 'networkidle' });
  await p2.waitForSelector('[data-test=home-page]');
  const navLabel = await p2.locator('[data-test=home-nav-login]').innerText();
  check('H-18 已登录 ?view=home 可预览官网，主按钮显示「进入工作台」',
    navLabel.includes('进入工作台'), navLabel.trim());
  await p2.click('[data-test=home-cta-login]');
  await p2.waitForSelector('[data-test=header-email]');
  check('H-19 从官网预览进入工作台后移除 view 参数',
    !new URL(p2.url()).searchParams.has('view'), p2.url());
  await authed.close();

  /* ================= 6. 移动端无横向溢出 ================= */
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: server.base, locale: 'zh-CN' });
  const pm = await mobile.newPage();
  await pm.goto('/', { waitUntil: 'networkidle' });
  await pm.waitForSelector('[data-test=home-page]');
  const overflow = await pm.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('H-20 390px 移动端无横向溢出，移动 Tab 可见',
    overflow <= 0 && (await pm.locator('[data-test=home-mobile-tab-mail]').count()) === 1,
    `overflow=${overflow}`);
  await mobile.close();

  check('H-21 页面无脚本错误', errors.length === 0, errors.join(' | '));
} catch (error) {
  failed += 1;
  console.error('✖ 官网引导页回归异常：', error);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.stop();
}

console.log(`\n官网引导页回归：${checks.length - failed}/${checks.length} 通过`);
if (failed) process.exitCode = 1;
