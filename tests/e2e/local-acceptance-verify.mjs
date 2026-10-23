/*
 * P1 真实链路验证：对一个已经跑起来的本地验收实例（npm run local:acceptance）
 * 用真实 Chromium + 未打包扩展验证：
 *   1. /api/v1/health 与 / 都是 200；
 *   2. 用该实例 outbox 里的真实验证码登录（不发真信）；
 *   3. 插件 popup 点「检测本机服务」能发现 4311 并保存；
 *   4. popup 显示「后台可达」；
 *   5. 发起配对 → 网页会话批准 → 插件显示已绑定。
 *
 * 只读业务数据；会在副本里新建一个登录会话和一个插件设备（属于验收副本，不是原库）。
 *
 * 用法：
 *   node tests/e2e/local-acceptance-verify.mjs \
 *     --url http://127.0.0.1:4311 \
 *     --data-dir ~/tounar-acceptance/<时间戳> \
 *     --email 1191240794@qq.com
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { buildTestExtension } from '../../extension/scripts/make-test-build.mjs';
import { resolveChromiumExecutable } from './browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHOT_DIR = path.join(ROOT, 'docs', 'acceptance', 'phase3');
const REPORT = path.join(SHOT_DIR, 'verify-report.json');
const PROFILE = path.join(ROOT, '.tmp', 'local-acceptance-profile');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`无法识别的参数：${key}`);
    const value = argv[i + 1];
    if (value == null) throw new Error(`${key} 需要一个值`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const base = String(args.url || 'http://127.0.0.1:4311').replace(/\/$/, '');
const dataDir = path.resolve(args['data-dir'] || '');
const email = String(args.email || '1191240794@qq.com');
if (!fs.existsSync(dataDir)) throw new Error(`--data-dir 不存在：${dataDir}`);

const checks = [];
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

function firstCookie(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!list.length) {
    const single = res.headers.get('set-cookie');
    return single ? single.split(';')[0] : null;
  }
  return list[0].split(';')[0];
}

async function request(route, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, cookie: firstCookie(res) };
}

function latestOtp(expectedEmail) {
  const outbox = path.join(dataDir, 'outbox');
  if (!fs.existsSync(outbox)) return null;
  const records = [];
  for (const file of fs.readdirSync(outbox)) {
    if (!file.endsWith('.json')) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(outbox, file), 'utf8'));
      if (record.kind !== 'otp') continue;
      if (String(record.to || '').toLowerCase() !== expectedEmail.toLowerCase()) continue;
      records.push(record);
    } catch { /* ignore */ }
  }
  return records.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1) || null;
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });

  // 1. 服务健康
  const health = await request('/api/v1/health');
  check('1. /api/v1/health 返回 200 且 ok=true', health.status === 200 && health.json?.ok === true,
    `status=${health.status} body=${health.text.slice(0, 120)}`);
  const page = await request('/');
  check('2. 首页 / 返回 200', page.status === 200, `status=${page.status} bytes=${page.text.length}`);

  // 2. 登录（outbox 验证码）。默认配置有 60 秒重发间隔 / 每小时 5 次限流，
  //    短时间重复跑本脚本时如实等待，不绕过频控。
  let otpRequest = await request('/api/v1/auth/request-otp', { method: 'POST', body: { email } });
  if (otpRequest.status === 429) {
    const waitSeconds = Number(otpRequest.json?.error?.details?.retry_after ?? 62);
    console.log(`   (验证码频控 429，等待 ${waitSeconds} 秒后重试)`);
    await sleep(Math.min(Math.max(waitSeconds, 5), 120) * 1000);
    otpRequest = await request('/api/v1/auth/request-otp', { method: 'POST', body: { email } });
  }
  check('3. 请求登录验证码（写入本地 outbox，不发真信）', otpRequest.status === 200, `status=${otpRequest.status}`);
  const otp = await waitFor(() => latestOtp(email), { label: 'outbox 中的验证码', timeout: 10000 });
  const login = await request('/api/v1/auth/verify-otp', { method: 'POST', body: { email, code: otp.metadata.dev_code } });
  check('4. 用 outbox 验证码登录成功', login.status === 200 && Boolean(login.cookie), `status=${login.status}`);
  const cookie = login.cookie;

  // 3. 真实浏览器 + 未打包扩展
  const extDir = buildTestExtension({ outDir: path.join(ROOT, '.tmp', 'extension-local-acceptance') });
  const resolvedBrowser = await resolveChromiumExecutable();
  const executablePath = resolvedBrowser?.path || null;
  if (!executablePath) throw new Error('未找到可用的 Chromium/Chrome for Testing');
  console.log(`   浏览器：${resolvedBrowser.source}`);
  let browser = null;
  for (const headless of [true, false]) {
    try {
      browser = await chromium.launchPersistentContext(PROFILE, {
        headless,
        ...(executablePath ? { executablePath } : {}),
        viewport: { width: 420, height: 900 },
        args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run', '--no-default-browser-check']
      });
      break;
    } catch (error) {
      console.log(`   (headless=${headless} 启动失败：${error.message.split('\n')[0]})`);
      browser = null;
    }
  }
  if (!browser) throw new Error('无法启动带扩展的 Chromium');
  let sw = browser.serviceWorkers()[0];
  if (!sw) sw = await browser.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  if (!sw) throw new Error('扩展 service worker 没有起来');
  const extId = new URL(sw.url()).host;
  check('5. 未打包扩展已加载（service worker 正常）', Boolean(extId), `extId=${extId}`);

  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForSelector('#queue-count');
  await popup.screenshot({ path: path.join(SHOT_DIR, '01-popup-initial.png') });

  // 4. 检测本机服务
  await popup.fill('#server-url', base);
  await popup.click('#save-server');
  await sleep(500);
  await popup.click('#probe-local');
  const probeText = await waitFor(async () => {
    const text = (await popup.textContent('#probe-result')) || '';
    return text.includes('已填入并保存') ? text : null;
  }, { label: '检测本机服务结果' });
  check('6. 「检测本机服务」发现 4311 并自动填入保存', probeText.includes('✅') && probeText.includes('已填入并保存'), probeText);
  await popup.screenshot({ path: path.join(SHOT_DIR, '02-probe-local.png') });

  const healthText = await waitFor(async () => {
    const text = (await popup.textContent('#health')) || '';
    return text.includes('后台可达') ? text : null;
  }, { label: 'popup 显示后台可达' });
  check('7. popup 显示「后台可达」并带地址', healthText.includes('后台可达') && healthText.includes(base), healthText);

  // 5. 配对：插件出示配对码 → 网页会话批准 → 插件确认绑定
  await popup.click('#start-pairing');
  // 配对码是 8 位，字符集 A-Z/2-9 且排除易混淆的 I/O/0/1；占位符是 8 个短横线。
  const code = await waitFor(async () => {
    const text = ((await popup.textContent('#pairing-code')) || '').trim();
    return /^[A-HJ-NP-Z2-9]{8}$/.test(text) ? text : null;
  }, { label: '配对码', timeout: 15000 });
  await popup.screenshot({ path: path.join(SHOT_DIR, '03-pairing-code.png') });
  const approved = await request('/api/v1/plugin-pairings/approve', { method: 'POST', cookie, body: { code } });
  check('8. 网页会话批准配对码', approved.status === 200, `code=${code} status=${approved.status}`);
  await popup.click('#poll-pairing');
  const paired = await waitFor(async () => popup.evaluate(() => {
    const el = document.getElementById('paired');
    return el && !el.classList.contains('hidden');
  }), { label: '插件显示已绑定' });
  check('9. 插件显示已绑定', Boolean(paired));
  const bindingText = ((await popup.textContent('#binding-status')) || '').trim();
  await popup.evaluate(() => {
    // 截图前脱敏：只改内存里的显示，不动存储。
    const owner = document.getElementById('owner-hint');
    if (owner) owner.textContent = '1191****@qq.com';
    const device = document.getElementById('device-id');
    if (device) device.textContent = 'dev_****（已脱敏）';
  });
  await popup.screenshot({ path: path.join(SHOT_DIR, '04-paired.png') });
  check('10. 绑定状态文案存在', Boolean(bindingText), bindingText);

  // 6. 服务端确实记录了这台设备
  const devices = await request('/api/v1/plugin-devices', { cookie });
  const deviceCount = devices.json?.data?.items?.length ?? devices.json?.data?.length ?? null;
  check('11. 服务端设备列表包含刚绑定的设备', devices.status === 200 && deviceCount >= 1, `status=${devices.status} devices=${deviceCount}`);

  await browser.close();
  fs.writeFileSync(REPORT, JSON.stringify({
    verified_at: new Date().toISOString(), base, data_dir: dataDir, email,
    node: process.versions.node, checks, passed: checks.filter((c) => c.ok).length, failed
  }, null, 2) + '\n');
  console.log(`\n${failed ? '✖' : '✔'} 共 ${checks.length} 项：通过 ${checks.length - failed}，失败 ${failed}`);
  console.log(`截图与报告：${SHOT_DIR}`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`\n✖ 验证中断：${error.message}`);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify({
    verified_at: new Date().toISOString(), base, data_dir: dataDir, email, checks, failed: failed + 1,
    error: error.message
  }, null, 2) + '\n');
  process.exit(1);
});
