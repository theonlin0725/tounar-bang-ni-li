/*
 * 在真实招聘页面上「试跑」插件的 content 脚本，不做任何人工填写。
 *
 * 用法：
 *   node tools/tryrun-plugin.mjs "https://jobs.bytedance.com/campus/position/7699119731313821957/detail"
 *
 * 做法：把 extension/content/adapters.js 与 extension/content/tracker.js
 *       原样注入真实页面（生产代码，不复制、不改写），只把 chrome.runtime.sendMessage
 *       换成桩函数捕获它准备上报的事件，从而验证「这个站点能不能自动采到字段」。
 *
 * 判据：停留满 3 秒后应发出一条 job_viewed，且 payload 里
 *       公司名 / 岗位名 / 岗位链接 / JD 摘要 至少三项有值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) {
  console.error('用法: node tools/tryrun-plugin.mjs <职位详情 URL>');
  process.exit(1);
}

const ROOT = process.cwd();
const adapters = fs.readFileSync(path.join(ROOT, 'extension/content/adapters.js'), 'utf8');
const tracker = fs.readFileSync(path.join(ROOT, 'extension/content/tracker.js'), 'utf8');

const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({
  viewport: { width: 1440, height: 1000 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
});

await p.addInitScript(`
  window.__captured = [];
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    sendMessage: (msg, cb) => {
      try { window.__captured.push(msg); } catch (e) {}
      if (cb) cb({ ok: true, queued: 1 });
    },
    lastError: null
  };
`);
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto:', e.message));
await p.addScriptTag({ content: adapters });
await p.addScriptTag({ content: tracker });
await p.waitForTimeout(6000);

const out = await p.evaluate(() => ({
  adapter: document.documentElement.getAttribute('data-tounar-adapter'),
  adapterVersion: document.documentElement.getAttribute('data-tounar-adapter-version'),
  jobDetected: document.documentElement.getAttribute('data-tounar-job-detected'),
  visibleMs: document.documentElement.getAttribute('data-tounar-visible-ms'),
  viewSent: document.documentElement.getAttribute('data-tounar-view-sent'),
  events: window.__captured.map((m) => m?.event).filter(Boolean)
}));
console.log(JSON.stringify(out, null, 1));

const job = out.events?.[0]?.payload || {};
const filled = ['company_name', 'job_title', 'job_url', 'jd_summary'].filter((k) => job[k]);
console.log(`\n自动采集命中 ${filled.length}/4 项核心字段：${filled.join('、') || '（无）'}`);

const host = new URL(p.url()).hostname;
fs.mkdirSync('.tmp', { recursive: true });
await p.screenshot({ path: path.join('.tmp', `tryrun-${host}.png`), fullPage: false });
await b.close();
