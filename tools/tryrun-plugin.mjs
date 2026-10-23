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
import { runPlugin, fieldSummary, FIELDS, safeName, ROOT } from './lib/plugin-runner.mjs';

const url = process.argv[2];
if (!url) {
  console.error('用法: node tools/tryrun-plugin.mjs <职位详情 URL>');
  process.exit(1);
}

const result = await runPlugin(url, {
  screenshotPath: path.join(ROOT, '.tmp', `tryrun-${safeName(new URL(url).hostname)}.png`)
});
const job = result.payload || {};
const fields = fieldSummary(job);
const filled = FIELDS.filter((key) => job[key]);

console.log(JSON.stringify({
  adapter: result.adapter,
  adapterVersion: result.adapter_version,
  jobDetected: result.site_job_id_detected,
  jobTitle: result.detected_title,
  detectionScore: result.detection_score,
  visibleMs: result.visible_ms,
  viewSent: result.view_sent ? '1' : '0',
  visibility: result.visibility,
  pageErrors: result.page_errors,
  fields,
  detection: result.detection,
  events: result.event ? [result.event] : []
}, null, 1));

console.log(`\n自动采集命中 ${filled.length}/${FIELDS.length} 项字段：${filled.join('、') || '（无）'}`);
for (const key of FIELDS) {
  const item = fields[key];
  if (item.value) console.log(`- ${key}: ${String(item.value).slice(0, 100)}${item.confidence != null ? `（把握度 ${Math.round(item.confidence * 100)}%）` : ''}`);
}
if (result.page_errors.length) console.log('页面错误:', result.page_errors.slice(0, 4));
console.log('截图:', path.join('.tmp', `tryrun-${safeName(new URL(url).hostname)}.png`));

if (!result.view_sent) process.exitCode = 2;
