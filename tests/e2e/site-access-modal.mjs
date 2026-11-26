/*
 * 招聘网站授权弹窗专项回归（v1.2 修复）：
 *  - 全选当前列表（三态）、清空选择、已选计数
 *  - 搜索筛选后只全选当前结果
 *  - 滚动到列表底部勾选时不跳回顶部，已展开的「查看域名」不收起
 *  - 一键授权全部 / 授权选中网站传入完整 origins
 *  - 授权完成事件到达后立即刷新，并保留当前筛选与滚动位置
 *
 * 使用页面内假的插件消息桥（不启动扩展），只验证前端授权弹窗交互。
 */
import { chromium } from 'playwright';
import { startTestServer } from '../../server/test/helpers.js';
import { resolveChromiumExecutable } from './browser.mjs';

const checks = [];
let failed = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = '') {
  const pass = Boolean(ok);
  if (!pass) failed += 1;
  checks.push({ name, ok: pass, detail: String(detail || '') });
  console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(fn, { timeout = 8000, interval = 50, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}`);
}

let server = null;
let browser = null;

try {
  server = await startTestServer({ name: 'site-access-modal', env: { CLOUD_LLM_ENABLED: 'false' } });
  const resolved = await resolveChromiumExecutable();
  if (!resolved) throw new Error('未找到可用 Chromium');
  browser = await chromium.launch({ headless: true, executablePath: resolved.path });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: server.base, locale: 'zh-CN' });

  await context.addInitScript(() => {
    const granted = new Set(['https://granted.example.com/*']);
    let selection = new Set();
    let statusCalls = 0;
    let lastPermission = null;
    let autoComplete = false;

    function buildGroups() {
      const make = (id, label, host) => {
        const origin = `https://${host}/*`;
        const isGranted = granted.has(origin);
        return {
          id, label, hosts: [host],
          granted: isGranted ? [origin] : [],
          domains: [{ host, granted: isGranted, origins: isGranted ? [origin] : [] }]
        };
      };
      const groups = [make('bytedance', '字节跳动招聘', 'jobs.bytedance.com')];
      for (let i = 1; i <= 40; i += 1) {
        groups.push(make(`g${i}`, `测试公司${String(i).padStart(2, '0')}`, `test${i}.example.com`));
      }
      groups.push(make('granted-co', '已授权公司', 'granted.example.com'));
      return groups;
    }

    function reply(id, ok, data, error) {
      window.postMessage({
        channel: 'tounar-access-response', id, ok,
        ...(ok ? { data } : { error: String(error || '插件操作失败') })
      }, location.origin);
    }

    window.__fakeSiteAccess = {
      getSelection: () => [...selection],
      getStatusCalls: () => statusCalls,
      getLastPermission: () => lastPermission,
      setAutoComplete: (value) => { autoComplete = Boolean(value); },
      resetSelection: () => { selection = new Set(); }
    };

    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const message = event.data;
      if (message?.channel !== 'tounar-access-request') return;
      const { id, action, payload = {} } = message;
      if (action === 'discovery') {
        return reply(id, true, { inlinePermissions: true, paired: true, existingBinding: true });
      }
      if (action === 'status') {
        statusCalls += 1;
        return reply(id, true, { groups: buildGroups(), selection: [...selection], paired: true });
      }
      if (action === 'preferences') {
        selection = new Set(Array.isArray(payload.selection) ? payload.selection : []);
        return reply(id, true, {});
      }
      if (action === 'permissions') {
        const origins = [...new Set(payload.origins || [])];
        lastPermission = { operation: payload.operation, origins };
        const permissionId = `perm-${statusCalls}-${Date.now()}`;
        if (autoComplete) {
          setTimeout(() => {
            if (payload.operation === 'grant') for (const origin of origins) granted.add(origin);
            const frame = document.querySelector('[data-test=permission-frame]');
            if (!frame?.contentWindow) return;
            window.dispatchEvent(new MessageEvent('message', {
              source: frame.contentWindow,
              origin: 'chrome-extension://fake',
              data: { channel: 'tounar-permission-frame', id: permissionId, type: 'complete' }
            }));
          }, 300);
        }
        return reply(id, true, { id: permissionId, frameUrl: `chrome-extension://fake/popup/permissions.html#${permissionId}` });
      }
      if (action === 'cancel-permission') return reply(id, true, {});
      return reply(id, true, {});
    });
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.goto('/?view=login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-test=login-email]');
  await page.evaluate(async () => {
    const module = await import('/assets/js/views/plugin-access.js?v=20261125-1');
    module.openSiteManager({ onboarding: true });
  });
  await page.waitForSelector('[data-test=site-access-modal]');
  await page.waitForSelector('[data-test=site-access-list]');
  await waitFor(async () => (await page.locator('[data-test=site-access-select-count]').innerText()).includes('/ 41'), { label: '授权列表加载' });

  const selectBarCount = await page.locator('[data-test=site-access-select-count]').innerText();
  check('S-01 授权弹窗首屏显示固定全选条、三态复选框与已选统计',
    (await page.locator('[data-test=site-access-select-bar]').count()) === 1
      && (await page.locator('[data-test=site-access-select-all]').count()) === 1
      && selectBarCount.includes('0 / 41'),
    selectBarCount);
  check('S-02 首次引导默认展开列表，并显示一键授权全部',
    (await page.locator('[data-test=site-access-grant-all]').count()) === 1
      && (await page.locator('[data-test=site-access-group-g40]').count()) === 1);

  /* ---------- 全选当前列表 ---------- */
  await page.click('[data-test=site-access-select-all]');
  await waitFor(() => page.evaluate(() => window.__fakeSiteAccess.getSelection().length === 41), { label: '全选 41 个网站' });
  const fullCount = await page.locator('[data-test=site-access-select-count]').innerText();
  check('S-03 点击全选当前列表，未授权的 41 个网站全部选中且三态同步',
    fullCount.includes('41 / 41')
      && (await page.locator('[data-test=site-access-group-g1]').isChecked())
      && (await page.locator('[data-test=site-access-group-g40]').isChecked()), fullCount);
  await page.click('[data-test=site-access-select-all]');
  await waitFor(() => page.evaluate(() => window.__fakeSiteAccess.getSelection().length === 0), { label: '取消全选' });
  check('S-04 再次点击全选可取消当前列表选择',
    (await page.locator('[data-test=site-access-select-count]').innerText()).includes('0 / 41'));

  /* ---------- 搜索后全选只影响当前结果 ---------- */
  await page.fill('[data-test=site-access-card] input[aria-label="搜索公司或域名"]', '测试公司30');
  await waitFor(async () => (await page.locator('[data-test=site-access-group-g30]').count()) === 1
    && (await page.locator('[data-test=site-access-group-g31]').count()) === 0, { label: '搜索过滤' });
  await page.click('[data-test=site-access-select-all]');
  await waitFor(() => page.evaluate(() => window.__fakeSiteAccess.getSelection().length === 1), { label: '筛选后全选一条' });
  const filteredSelection = await page.evaluate(() => window.__fakeSiteAccess.getSelection());
  check('S-05 搜索筛选后全选只勾选当前结果',
    filteredSelection.length === 1 && filteredSelection[0] === 'https://test30.example.com/*',
    JSON.stringify(filteredSelection));
  await page.click('[data-test=site-access-clear-selection]');
  await page.fill('[data-test=site-access-card] input[aria-label="搜索公司或域名"]', '');
  await waitFor(async () => (await page.locator('[data-test=site-access-group-g40]').count()) === 1, { label: '清空搜索' });
  check('S-06 清空选择按钮立即清空已选', (await page.locator('[data-test=site-access-select-count]').innerText()).includes('0 / 41'));

  /* ---------- 滚动勾选不跳顶、展开项不收起 ---------- */
  const row25 = page.locator('.tn-site-row', { hasText: '测试公司25' });
  await row25.locator('details summary').click();
  check('S-07 可展开「查看域名」', await row25.locator('details').evaluate((el) => el.open));
  const group30 = page.locator('[data-test=site-access-group-g30]');
  await group30.scrollIntoViewIfNeeded();
  const list = page.locator('[data-test=site-access-list]');
  const beforeTop = await list.evaluate((el) => el.scrollTop);
  await group30.click();
  await page.waitForTimeout(120);
  const afterTop = await list.evaluate((el) => el.scrollTop);
  const row25Open = await row25.locator('details').evaluate((el) => el.open);
  check('S-08 滚动到下方勾选网站后列表不跳回顶部',
    beforeTop > 200 && Math.abs(afterTop - beforeTop) <= 1, `before=${beforeTop} after=${afterTop}`);
  check('S-09 勾选后已展开的「查看域名」保持展开', row25Open);
  check('S-10 勾选后已选统计与底部按钮实时更新',
    (await page.locator('[data-test=site-access-select-count]').innerText()).includes('1 / 41')
      && (await page.locator('[data-test=site-access-grant]').innerText()).includes('（1）'));

  /* ---------- 授权选中 / 一键授权全部 ---------- */
  await page.click('[data-test=site-access-grant]');
  await page.waitForSelector('[data-test=permission-confirm-modal]');
  const selectedPermission = await page.evaluate(() => window.__fakeSiteAccess.getLastPermission());
  check('S-11 「授权选中网站（1）」只传入当前选中的域名',
    selectedPermission.operation === 'grant'
      && selectedPermission.origins.length === 1
      && selectedPermission.origins[0] === 'https://test30.example.com/*',
    JSON.stringify(selectedPermission));
  await page.keyboard.press('Escape');
  await page.locator('[data-test=permission-confirm-modal]').waitFor({ state: 'detached' });

  await page.click('[data-test=site-access-grant-all]');
  await page.waitForSelector('[data-test=permission-confirm-modal]');
  const allPermission = await page.evaluate(() => window.__fakeSiteAccess.getLastPermission());
  check('S-12 「一键授权全部」汇总全部未授权网站的 origins',
    allPermission.operation === 'grant'
      && allPermission.origins.length === 41
      && allPermission.origins.includes('https://test1.example.com/*')
      && allPermission.origins.includes('https://test40.example.com/*')
      && allPermission.origins.includes('https://jobs.bytedance.com/*'),
    `origins=${allPermission.origins.length}`);
  await page.keyboard.press('Escape');
  await page.locator('[data-test=permission-confirm-modal]').waitFor({ state: 'detached' });

  /* ---------- 授权完成立即刷新 ---------- */
  await page.click('[data-test=site-access-clear-selection]');
  await page.fill('[data-test=site-access-card] input[aria-label="搜索公司或域名"]', '测试公司35');
  await waitFor(async () => (await page.locator('[data-test=site-access-group-g35]').count()) === 1, { label: '筛选测试公司35' });
  await page.click('[data-test=site-access-group-g35]');
  const callsBefore = await page.evaluate(() => window.__fakeSiteAccess.getStatusCalls());
  await page.evaluate(() => window.__fakeSiteAccess.setAutoComplete(true));
  await page.click('[data-test=site-access-grant]');
  await page.waitForSelector('[data-test=permission-confirm-modal]');
  await page.locator('[data-test=permission-confirm-modal]').waitFor({ state: 'detached', timeout: 5000 });
  await waitFor(async () => (await page.locator('[data-test=site-access-group-g35]').isDisabled()), { label: '授权行变为已授权禁用' });
  const callsAfter = await page.evaluate(() => window.__fakeSiteAccess.getStatusCalls());
  const summaryText = await page.locator('[data-test=site-access-summary]').innerText();
  check('S-13 授权完成事件后立即刷新，无需等待 2 秒轮询',
    callsAfter - callsBefore >= 2, `status calls ${callsBefore} -> ${callsAfter}`);
  check('S-14 刷新后顶部已授权数与行内状态即时更新',
    summaryText.includes('已授权 2 个网站')
      && (await page.locator('[data-test=site-access-group-g35]').isChecked())
      && (await page.locator('[data-test=site-access-group-g35]').isDisabled()),
    summaryText);
  check('S-15 刷新后保持当前搜索筛选',
    (await page.locator('[data-test=site-access-group-g35]').count()) === 1
      && (await page.locator('[data-test=site-access-group-g40]').count()) === 0);
  check('S-16 弹窗交互无脚本异常', errors.length === 0, errors.join(' | '));
} catch (error) {
  failed += 1;
  console.error('✖ 招聘网站授权弹窗回归异常：', error);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.stop();
}

console.log(`\n招聘网站授权弹窗回归：${checks.length - failed}/${checks.length} 通过`);
if (failed) process.exitCode = 1;
