/*
 * 真实站点探测：跑生产版插件脚本，输出结构化字段/把握度/检测来源，
 * 可选保存脱敏 DOM 快照，作为 tests/fixtures/sites 的离线回归样本。
 *
 * 用法：
 *   node tools/probe-site.mjs <URL> [<URL> ...]
 *   node tools/probe-site.mjs --fixtures --report .tmp/site-probe.json <URL>...
 *
 * 注意：
 * - 只在真实页面停留、采集；不点击投递，不读表单内容，不读 Cookie。
 * - 快照会删除 script/iframe/远程资源与内联事件，只保留结构与文本。
 * - 结果不做「演示数据」美化：字段为空就写 null，把握度低就原样输出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runPlugin, fieldSummary, FIELDS, safeName, launchBrowser, ROOT } from './lib/plugin-runner.mjs';

const args = process.argv.slice(2);
const saveFixtures = args.includes('--fixtures');
const reportIndex = args.indexOf('--report');
const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : null;
const urls = args.filter((arg, index) => !arg.startsWith('--')
  && !(reportIndex >= 0 && index === reportIndex + 1));

if (!urls.length) {
  console.error('用法: node tools/probe-site.mjs [--fixtures] [--report <json>] <职位详情 URL>...');
  process.exit(1);
}

const browser = await launchBrowser();
const cases = [];
try {
  for (const url of urls) {
    process.stderr.write(`探测 ${url}\n`);
    const result = await runPlugin(url, {
      browser,
      screenshotPath: path.join(ROOT, '.tmp', 'site-shots', `${safeName(new URL(url).hostname)}-${safeName(resultId(url))}.png`)
    });
    const site = result.adapter || 'unknown';
    const id = result.payload?.site_job_id || result.site_job_id_detected || resultId(url);
    const fields = fieldSummary(result.payload);
    const item = {
      site,
      adapter_version: result.adapter_version,
      url,
      final_url: result.final_url,
      page_title: result.page_title,
      job_id: id,
      view_sent: result.view_sent,
      detection_score: result.detection_score,
      detection: result.detection,
      fields,
      page_errors: result.page_errors,
      fixture: null
    };
    if (saveFixtures && result.html) {
      const dir = path.join(ROOT, 'tests/fixtures/sites', safeName(site));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${safeName(id)}.html`);
      fs.writeFileSync(file, result.html);
      item.fixture = path.relative(ROOT, file).split(path.sep).join('/');
    }
    cases.push(item);
    const f = (key) => fields[key]?.value == null ? '—' : String(fields[key].value).replace(/\s+/g, ' ').slice(0, 38);
    console.log([
      site.padEnd(10),
      f('company_name').padEnd(16),
      f('job_title').padEnd(30),
      f('location').padEnd(12),
      fields.jd_summary?.value ? 'JD✓' : 'JD—',
      id,
      `${Math.round((result.detection_score || 0) * 100)}%`
    ].join(' | '));
  }
} finally {
  await browser.close().catch(() => {});
}

const output = {
  generated_at: new Date().toISOString(),
  browser: 'Chrome for Testing (Playwright)',
  cases
};
if (reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(output, null, 2));
  console.log(`\n结构化结果: ${reportPath}`);
}
if (saveFixtures) console.log(`DOM 快照: tests/fixtures/sites/`);

function resultId(url) {
  try {
    const parsed = new URL(url);
    const hashQuery = parsed.hash.includes('?') ? new URLSearchParams(parsed.hash.slice(parsed.hash.indexOf('?') + 1)) : null;
    return hashQuery?.get('id')
      || parsed.searchParams.get('id')
      || parsed.searchParams.get('postid')
      || parsed.searchParams.get('jobUnionId')
      || parsed.pathname.split('/').filter(Boolean).at(-1)
      || 'case';
  } catch {
    return 'case';
  }
}
