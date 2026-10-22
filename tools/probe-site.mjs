/*
 * 抓取某个真实招聘页面的「渲染后 DOM 结构」，用来写/校准站点适配器。
 *
 * 用法：
 *   node tools/probe-site.mjs "https://jobs.bytedance.com/campus/position/7699119731313821957/detail"
 *
 * 输出：页面标题、可见正文开头、命中 job/position/title/detail 的候选元素
 *      （标签 + class + 文本），以及一张截图 .tmp/probe-<host>.png。
 *
 * 为什么需要它：多数招聘站是纯前端渲染的 SPA，服务端返回的 HTML 几乎是空的，
 * 必须从渲染后的 DOM 里才能看到真实选择器。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) {
  console.error('用法: node tools/probe-site.mjs <职位详情 URL>');
  process.exit(1);
}

const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({
  viewport: { width: 1440, height: 1000 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
});
await p.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => console.log('goto:', e.message));
await p.waitForTimeout(5000);

console.log('URL:', p.url());
console.log('TITLE:', await p.title());

const info = await p.evaluate(() => {
  const text = (el) => (el ? String(el.innerText || '').replace(/\s+/g, ' ').trim() : '');
  return {
    bodyHead: text(document.body).slice(0, 900),
    h1: Array.from(document.querySelectorAll('h1')).map(text),
    candidates: Array.from(document.querySelectorAll(
      '[class*="job"],[class*="Job"],[class*="position"],[class*="Position"],[class*="title"],[class*="Title"],[class*="detail"],[class*="Detail"],[class*="desc"],[class*="Desc"]'
    )).slice(0, 30).map((e) => ({
      tag: e.tagName,
      cls: String(e.className || '').slice(0, 70),
      text: text(e).slice(0, 90)
    }))
  };
});
console.log(JSON.stringify(info, null, 1));

const host = new URL(p.url()).hostname;
fs.mkdirSync('.tmp', { recursive: true });
await p.screenshot({ path: path.join('.tmp', `probe-${host}.png`), fullPage: false });
console.log('截图: .tmp/probe-' + host + '.png');
await b.close();
