# Extension E2E test notes (Playwright 1.64.1, macOS 26)

Scope: Chrome MV3 unpacked extension. Environment checked: Playwright 1.64.1, Google Chrome 155 at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, macOS 26.6. The Playwright browser cache is currently empty, so `npx playwright install chromium` is required for the bundled route. No extension code exists yet; selectors/keys below are illustrative.

> **更新（2026-10-22，开发完成后）**：第 1–6 节是开发前的 Playwright/MV3 调研笔记，其中「无扩展实现」「浏览器缺失」等描述是当时状态，不再是当前事实。实际实现、可复现命令与最新结果见第 7 节；两者冲突时以第 7 节为准。

## 1. Launch, get extension id, open popup

Use `launchPersistentContext()`; `browser.newContext()` cannot load extensions. Pass absolute paths. `--disable-extensions-except` plus `--load-extension` are the required flags. For headless, `channel: 'chromium'` is required; without it Playwright 1.64 selects `chromium-headless-shell`, which is not the supported extension path.

```js
import path from 'node:path';
import { chromium } from 'playwright';
const ext = path.resolve('.tmp/extension-test');
const context = await chromium.launchPersistentContext('', { // or testInfo.outputPath('profile')
  channel: 'chromium',                 // full Chrome for Testing build
  headless: !process.env.HEADED,       // HEADED=1 for a visible window
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
  ],
});
let sw = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
sw ??= await context.waitForEvent('serviceworker', {
  predicate: w => w.url().startsWith('chrome-extension://'),
  timeout: 15_000,
});
const extensionId = new URL(sw.url()).host; // chrome-extension://<id>/background/...
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
```

- If no service worker appears, the extension usually did not load: wrong browser/flags or a manifest error. Keep the `sw` handle; MV3 idle suspension keeps the same `Worker` object alive in 1.64.
- Unpacked IDs are derived from the absolute path unless the manifest has a public `"key"`. If the backend allowlists an extension ID, pin a `"key"`; otherwise always read the ID at runtime as above.
- Popup-as-tab is a normal page, not the anchored toolbar popup. Popup DOM/API logic can be tested this way; logic depending on `chrome.tabs.query({active:true,currentWindow:true})` may see the popup tab itself. Assumption/limitation.

**Branded Chrome limitation (documented):** Google Chrome and Edge removed the command-line flags needed to side-load extensions, so Playwright says to use bundled Chromium. Chrome 137+ no longer honors `--load-extension` in branded builds; `channel: 'chrome'` or `executablePath` to installed Google Chrome is not a supported extension automation path. It remains usable for non-extension web tests. Bundled Chromium in 1.64 is Chrome for Testing 156.0.8078.4. CfT is the supported proxy, not a guarantee of identical branded-Chrome policy/store behavior; do a manual branded-Chrome smoke test before release.

## 2. Test-only manifest variant

Keep `extension/manifest.json` as the production source of truth with only `optional_host_permissions`. Put a small overlay under `tests/` and build a copied test tree; never edit the production manifest in place.

Production `extension/manifest.json`:
```json
{ "manifest_version": 3, "optional_host_permissions": ["https://*.example.com/*"] }
```
Test overlay `tests/fixtures/manifest.test.patch.json`:
```json
{ "host_permissions": ["http://127.0.0.1/*"], "content_scripts": [{ "matches": ["http://127.0.0.1/*"], "js": ["content/test-fixture.js"], "run_at": "document_idle" }] }
```

Recommended layout: `extension/` (prod) + `tests/fixtures/manifest.test.patch.json` + `tests/fixtures/extension/content/test-fixture.js` + `tests/e2e/build-extension.mjs` -> generated `.tmp/extension-test/` (launch this). Append content-script entries, do not replace production ones.

```js
import fs from 'node:fs';
const out = '.tmp/extension-test';
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync('extension', out, { recursive: true });
const prod = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
const patch = JSON.parse(fs.readFileSync('tests/fixtures/manifest.test.patch.json', 'utf8'));
const testManifest = {
  ...prod, ...patch,
  name: `${prod.name} (Test)`,
  host_permissions: [...new Set([...(prod.host_permissions ?? []), ...patch.host_permissions])],
  content_scripts: [...(prod.content_scripts ?? []), ...(patch.content_scripts ?? [])],
};
fs.mkdirSync(`${out}/content`, { recursive: true });
fs.copyFileSync('tests/fixtures/extension/content/test-fixture.js', `${out}/content/test-fixture.js`);
fs.writeFileSync(`${out}/manifest.json`, JSON.stringify(testManifest, null, 2));
if ((prod.host_permissions ?? []).some(p => p.includes('127.0.0.1'))) throw new Error('prod must not grant localhost');
```

`host_permissions` is an install-time grant, so no runtime `chrome.permissions.request()` prompt is on the path; keep `optional_host_permissions` unchanged so the production grant flow remains testable. For unpacked test loads Chrome normally grants it; assert it rather than assuming: `await sw.evaluate(() => chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] }))` must be `true` (fail fast if policy withholds it). Use `127.0.0.1` consistently, not `localhost` (different origin); all ports match `http://127.0.0.1/*`. If injection is programmatic via `chrome.scripting`, the host permission still needs the test adapter's match/registration; a manifest permission alone does not teach the adapter the fixture.

## 3. Pairing/approval through popup + web UI

Open the app page and popup as separate pages in the same persistent context; `context.serviceWorkers()` exposes the extension worker. The flow direction must match the frozen D10 protocol; the snippet assumes popup displays a one-time code and the logged-in app approves it. Replace locators with stable `data-testid`s.

```js
const app = await context.newPage();
await app.goto(`${BASE}/login`);
await loginWithTestAccount(app);            // fixed test OTP/session; do not read a real mailbox
await app.goto(`${BASE}/settings/extension`);
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
await popup.getByRole('button', { name: /配对|连接/ }).click();
const code = await popup.getByTestId('pairing-code').innerText();
await app.getByLabel('配对码').fill(code);
await app.getByRole('button', { name: '确认绑定' }).click();
await expect.poll(() => popup.getByTestId('binding-status').innerText()).toMatch(/已绑定/);
await expect.poll(() => sw.evaluate(async () => (await chrome.storage.local.get('binding')).binding?.status)).toBe('active');
```

- Real UI clicks count as user gestures for permission prompts; don't bypass approval by stealing the web session. A one-time code/credential exchange is the D10 model.
- If the popup opens the app in a new tab, register `context.waitForEvent('page')` before that click and await it; otherwise approval stays in `app`.
- If approval closes the popup, reopen the same URL and assert; the extension ID is stable while the profile lives.
- Assert the backend binding belongs to the logged-in `owner_id`, not just the popup label. Use a test-only read API/DB query. Later content pages (`await context.newPage()` -> fixture job URL) are separate pages in the same context; the SW sees all of them.

## 4. Headless support in 1.64

| Launch | Browser selected | Extensions |
|---|---|---|
| `headless: true`, no channel | `chromium-headless-shell` | Not the supported extension path; do not use |
| `headless: true`, `channel: 'chromium'` | full Chrome for Testing 156 | Playwright 1.64 docs say this allows extensions; verify locally |
| `headless: false`, `channel: 'chromium'` | full CfT | Expected yes; safest fallback on macOS |
| `channel: 'chrome'` / Google Chrome path | branded Chrome 155 | Side-load flags removed; expected failure |

The 1.64 docs explicitly note the `chromium` channel allows extensions in headless mode. That is documented, not a claim that every macOS/build combination was exercised here. Do not pass `--headless=new` manually; Playwright passes `--headless`, which is new headless in Chrome 156. If headless smoke fails, use `headless: false` locally (no xvfb on macOS). On Linux CI, wrap with `xvfb-run`; that advice does not apply to macOS.

Quick verification (after building `.tmp/extension-test`):

```bash
npx playwright install chromium
node --input-type=module -e '
import { chromium } from "playwright";
const ext = process.cwd() + "/.tmp/extension-test";
const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const sw = ctx.serviceWorkers().find(w => w.url().startsWith("chrome-extension://"))
  ?? await ctx.waitForEvent("serviceworker", { predicate: w => w.url().startsWith("chrome-extension://"), timeout: 15000 });
console.log("OK", sw.url());
await ctx.close();
'
```

Expected: `OK chrome-extension://.../background/...`. Timeout means no SW; try `headless: false`, then check the manifest/browser install. The same command with `executablePath` pointing at branded Google Chrome is expected to time out because of the side-load limitation.

## 5. Inspect `chrome.storage.local` and IndexedDB from the SW

Run these in the extension worker, not in the fixture page; content pages cannot see extension-origin storage. Redact tokens/PII from logs.

```js
const all = await sw.evaluate(() => chrome.storage.local.get(null));
const outbox = await sw.evaluate(async () => (await chrome.storage.local.get('outbox')).outbox ?? []);
const rows = await sw.evaluate(async ({ dbName, storeName }) => {
  if (!(await indexedDB.databases()).some(d => d.name === dbName))
    throw new Error(`IndexedDB ${dbName} not created`);
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}, { dbName: 'bangnili', storeName: 'outbox' });
await expect.poll(() => sw.evaluate(async () => (await chrome.storage.local.get('outbox')).outbox?.length ?? 0)).toBe(1);
```

MV3 SWs suspend after ~30s idle; in 1.64 the same worker handle resumes, though an evaluate in flight at the exact suspension instant can throw `Service worker restarted`. Prefer keeping the handle and polling persisted storage over relying on SW globals. The `indexedDB.databases()` guard avoids accidentally creating an empty DB; opening `indexedDB.open(name)` on an existing DB does not trigger an upgrade.

## 6. Recommended product test sequence

Use a unique fixture job/application per run, a fresh profile, and serial execution (persistent profile + one binding). `events(id)` is a test-only read API/DB query and `outboxFor(sw,id)` reads the local queue; put test endpoints behind a test guard, not in production.

| # | Action | Assertion |
|---|---|---|
| 1 | Open `http://127.0.0.1:PORT/jobs/<id>`; `bringToFront()`; assert `document.visibilityState === 'visible'`; wait 2s | No `job_viewed` in backend/outbox; application not created |
| 2 | Keep tab visible; poll up to ~10s | Exactly one `job_viewed`; pending row, `has_applied=false` |
| 3 | Submit fixture form; wait for explicit success marker/application id | One `application_submitted`; `has_applied=true`, `status=applied`, one row |
| 4 | Open fixture status page with an explicit status (e.g. interview) | `site_status_observed`; status updated; repeat visit does not change `last_status_changed_at` |
| 5 | Offline: load job, set offline before 3s, dwell 3.5s | Event queued locally; backend count unchanged; same `client_event_id` after reconnect; one row |

```js
const before = (await events(jobId)).length;
await page.goto(jobUrl);
await expect(page.getByTestId('job-title')).toBeVisible();
await page.bringToFront();
await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
await page.waitForTimeout(2000);
expect((await events(jobId)).length).toBe(before);       // negative check at 2s
expect(await outboxFor(sw, jobId)).toHaveLength(0);      // no local queued event either
await expect.poll(async () => (await events(jobId)).length, { timeout: 10_000 }).toBe(before + 1);
```

Start the 2s/3s clock after the fixture title is visible (or after an adapter-ready marker, if one is added). Without a readiness signal this approximates adapter detection and can pass the 2s negative check trivially if detection is delayed; add a test-only readiness hook for strict timing. Do not assert the exact 3000ms boundary; poll. If `occurred_at` is trustworthy, additionally assert it is at least 3s after readiness. Background tabs must not accumulate visible time.

```js
await page.goto(job2Url);
await expect(page.getByTestId('job-title')).toBeVisible();
await page.bringToFront();
await context.setOffline(true);                          // assumption: also blocks extension SW fetches
await page.waitForTimeout(3500);
await expect.poll(async () => (await outboxFor(sw, job2Id)).length).toBe(1);
expect((await events(job2Id)).length).toBe(0);
await context.setOffline(false);
await expect.poll(async () => (await events(job2Id)).length, { timeout: 15_000 }).toBe(1);
await expect.poll(async () => (await outboxFor(sw, job2Id)).length).toBe(0);
```

Verify the offline simulation actually blocks the SW (e.g. an SW `fetch` probe rejects); if it does not, stop the backend listener instead of using `setOffline`. Optional stronger case: while offline, close the context, relaunch with the same profile, go online, and assert the queued event uploads once with the same `client_event_id` (MV3 restart/persistence). Repeat the flush and assert the backend still has one row (idempotent ACK/retry).

**Assumptions:** no extension implementation exists, so storage keys, event payload fields and UI locators are placeholders; headless support and branded-Chrome failure are documented but not executed on this machine (browser absent); `setOffline` affecting the extension SW needs verification. Pin these down when the manifest/adapters are frozen.

Refs: https://playwright.dev/docs/chrome-extensions, https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions

---

## 7. 实际实现与测试结果（2026-10-22）

本节记录**已经落地并通过复跑**的插件与网页测试，不再使用第 1–6 节的占位选择器。

### 7.1 测试入口与环境

| 命令 | 范围 | 浏览器 | 报告 |
|---|---|---|---|
| `npm test` | 后端单元/集成（含插件协议、事件、提醒、复核、删除） | Node `node:test` | 终端输出；58 tests / 13 suites |
| `npm run test:e2e` | MV3 扩展端到端（配对、采集、离线队列、撤销清理） | Chrome for Testing 156.0.8078.4 | `.tmp/e2e-report.json`、`.tmp/plugin-e2e-regression.log` |
| `npm run test:web` | 网页 SPA 端到端（登录→台账→复核→提醒→落地页→设备/邮箱→删除） | 同上 | `.tmp/web-e2e-report.json`、`.tmp/web-e2e-run7.log`、截图 `.tmp/web-e2e/*.png` |

浏览器解析集中在 `tests/e2e/browser.mjs` 的 `resolveChromiumExecutable()`：优先使用 `.tmp/cft/` 下的 Chrome for Testing（npmmirror 镜像），不可用时回退 Playwright 自带 Chromium。所有测试使用**临时数据目录 + 真实 HTTP 服务 + 真实 SQLite**，不是前端 mock。

### 7.2 插件 E2E：17/17

`tests/e2e/run-e2e.mjs` 使用 `launchPersistentContext()` 加载未打包 MV3 扩展，覆盖：

| 用例 | 断言要点 |
|---|---|
| E2E-00 | Chrome for Testing 可加载扩展并取得扩展 ID |
| E2E-01a–c | 网页会话批准配对码 → popup 自动绑定 → 明确展示「G04 未验证」提示 |
| E2E-02a/b | 通用适配器识别岗位详情；停留 <3 秒不产生线索 |
| E2E-03/04 | 可见累计 ≥3 秒入「看过没投」；列表页多岗位 JSON-LD 不误识别 |
| E2E-05 | 表单开始填写 → `form_started`，不读取输入内容 |
| E2E-06 | 显式成功标记 → `application_submitted`（强证据）→ `applied` |
| E2E-07 | 结构化状态块 → `site_status_observed` → 状态历史 |
| E2E-08/09 | 后台不可达时事件留在本地队列；浏览器重启后 IndexedDB 队列仍在 |
| E2E-10 | 后台恢复后补传成功、队列清空、幂等不多建记录 |
| E2E-11a/b | 网页撤销设备 → 新事件拒收、本地队列按清理协议删除、绑定解除 |
| E2E-12 | 撤销后 popup 不再显示绑定信息 |

诚实边界：E2E 使用本地 fixture 页面与通用适配器；**没有**用 ≥8 家真实招聘站点的登录态验证 G04，也没有真实 WorkBuddy 环境。

### 7.3 网页 SPA E2E：40/40

`tests/e2e/run-web-e2e.mjs` 通过 UI 完成主链路，关键点是不塞演示数据、不把失败显示成 0：

| 区段 | 用例 | 已验证事实 |
|---|---|---|
| 登录/空态 | W-01–W-03 | 纯邮箱 OTP（无密码、无演示账号）；新账号三统计为 0；OTP 来自真实 outbox |
| 补录/D12 | W-04–W-07 | 缺投递日期、缺 JD 摘要时客户端拦截（不用今天代替）；成功补录并打开详情；重复补录返回 409 候选且不强行新增 |
| 设备事件/详情 | W-08–W-12 | 强浏览 + 两条弱提交真实入库；详情走真实 API；「已确认，状态无变化」写入 `last_reviewed_at`；「看过没投」不计入累计投递 |
| 复核队列 | W-13–W-16 | 两条弱提交进入待确认；真实 409 竞态（另一会话先修正，UI POST 命中 `VERSION_CONFLICT`，复核仍 open 且不覆盖）；忽略后落库；确认后建正式记录、状态已投、台账刷新无重复 |
| 提醒 | W-17–W-19 | 偏好保存；预览反映真实 A/B 候选；内部 tick 真实写 outbox 邮件并含 B 回看链接 |
| 邮件落地页 | W-20–W-24 | 未登录只提示登录不泄露内容；打开只读；两步确认写入 completed；刷新不重复计时；无效 token 中性错误 |
| 设备配对 | W-25–W-27 | UI 输入配对码完成真实配对协议；设备列表出现新设备；撤销后服务端撤销 ≠ 已清理（等待回执，`binding_version` 递增） |
| QQ 邮箱 | W-28–W-29 | 假授权码时如实降级为「需重新授权 / REAUTH_REQUIRED」，不显示「已连接」；断开后删除凭证、台账保留 |
| 会话 | W-30–W-31 | 退出登录清理弹窗/抽屉遮罩；重新登录后数据仍在（新会话，旧会话不复活） |
| 删除全链路 | W-32–W-37 | 删除前 OTP 重验证；202 后等待设备回执；两台设备 cleanup-ack（`binding_version` 2/3）；回执齐全后 completed；业务接口 403 `DELETION_IN_PROGRESS`、其他会话 401；页面无未捕获脚本异常 |

### 7.4 本轮 E2E 发现并修复的前端缺陷

| 缺陷 | 根因 | 修复 |
|---|---|---|
| 复核视图在确认/忽略一条后整块消失 | 台账 `doLoad` 在 items 为空时调用 `renderTable()`，先清空 `contentEl`；复核视图的 `onChanged` 又会清空 items，且 `refreshChrome` 对 reviews 提前返回、不会重建 | `web/assets/js/views/ledger.js`：reviews 视图下禁止该清空分支 |
| 确认框把下层的设置/补录弹窗一起销毁 | `confirmDialog` 复用 `#tn-modal-layer` 并清空子节点 | `web/assets/js/util.js`：`openModal({stacked:true})` 独立堆叠遮罩（z-index 80） |
| 删除任务卡片显示字面量 `undefined` | `renderDeletionJob()` 末尾漏了 `return section` | `web/assets/js/views/settings.js` 补 return |
| 删除任务提交后长时间停留在「正在阻断写入」 | 轮询只在 completed/failed 或第 20 次时重绘 | `web/assets/js/views/settings.js`：状态变化即重绘，继续轮询至终态 |
| 复核 409 只有错误码、缺少可读提示 | 前端未映射 `VERSION_CONFLICT` 文案 | `web/assets/js/views/reviews.js` 补 toast |

### 7.5 运行注意事项与诚实边界

- 截图：`.tmp/web-e2e/01-login.png` … `13-deletion-completed.png`（共 13 张关键节点）。
- 测试数据目录：`.tmp/tests/web-e2e/tounar.sqlite`；结束状态可用于复查复核项、删除任务、设备回执与 outbox。
- **未验证**：真实 QQ IMAP 首扫/增量（无真实授权码；只验证了如实降级）、真实 SMTP 送达（outbox 不等于送达）、G01/G03/G04、WorkBuddy Auth/Database、外部 cron、≥8 家真实站点与 ToS。
- **未专项验证**：移动端横向滚动、键盘/读屏可用性（FT13）；真实邮件客户端渲染兼容性。
- 删除任务的「备份/云数据库」范围按本地实现如实标注为 `not_configured` / `not_available_local_substitute`，不冒充已删除。
