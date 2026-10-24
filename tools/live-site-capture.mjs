/* 真实站点识别体检（不是完整插件验收）：打开页面→注入 adapters/tracker→调用 __tounarCapture→输出字段与本地耗时。
 * 用法：node tools/live-site-capture.mjs <url> [url...]
 */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../tests/e2e/browser.mjs';
const root = process.cwd();
const files = ['extension/lib/learned.js','extension/content/adapters.js','extension/content/tracker.js'];
const scripts = files.map(f=>fs.readFileSync(`${root}/${f}`,'utf8'));
const urls = process.argv.slice(2);
const resolved = await resolveChromiumExecutable();
const browser = await chromium.launch({ executablePath: resolved.path, headless: true });
for (const url of urls) {
  const ctx = await browser.newContext({ viewport:{width:1440,height:1000}, locale:'zh-CN' });
  const page = await ctx.newPage();
  await page.addInitScript(()=>{ window.__captured=[]; window.chrome={ runtime:{ sendMessage(m,cb){ window.__captured.push(m?.event); cb?.({ok:true}); }, onMessage:{ addListener(){} } } }; });
  const t0 = Date.now();
  let status = 'navigate';
  try {
    const res = await page.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
    status = `http ${res?.status()}`;
    for (const s of scripts) await page.addScriptTag({content:s});
    await page.waitForTimeout(5000);
    const tReady = Date.now();
    const t1 = Date.now();
    const out = await page.evaluate(async ()=> {
      if (!globalThis.__tounarCapture) return { error:'no __tounarCapture' };
      return await globalThis.__tounarCapture('verify');
    });
    const localMs = Date.now()-t1;
    const ev = await page.evaluate(()=> window.__captured.find(e=>e?.event_type==='job_captured'));
    const p = ev?.payload || {};
    console.log(JSON.stringify({ url, status, pageReadyMs: tReady-t0, localMs, detected: !!out?.detected, title:p.job_title, company:p.company_name, location:p.location, batch:p.recruitment_batch, jdChars:(p.jd_text||'').length, summaryChars:(p.jd_summary||'').length, sources:p.field_sources }, null, 0));
  } catch (e) {
    console.log(JSON.stringify({ url, status, error:e.message.split('\n')[0] }));
  }
  await ctx.close();
}
await browser.close();
