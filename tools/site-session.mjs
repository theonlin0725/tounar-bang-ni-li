import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../tests/e2e/browser.mjs';
import { sanitizedSnapshot } from './site-snapshot.mjs';
import { sanitizeUrl } from '../server/src/util.js';
import { pageIssue, reportUrl } from './site-page-state.mjs';

export function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

export function writeJson(destination, value) {
  if (!destination) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(value, null, 2) + '\n');
}

export async function siteSession(url, inspect) {
  if (!/^https?:\/\//.test(url || '')) throw new Error('请提供公开职位详情的 HTTP(S) URL');
  const resolved = await resolveChromiumExecutable();
  if (!resolved) throw new Error('Install Playwright Chromium first');
  const browser = await chromium.launch({ executablePath: resolved.path, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const failures = new Map();
  page.on('requestfailed', request => {
    if (!['document', 'script', 'stylesheet', 'xhr', 'fetch'].includes(request.resourceType())) return;
    const safe = sanitizeUrl(request.url());
    if (!safe) return;
    const parsed = new URL(safe);
    const resource = parsed.origin + parsed.pathname;
    failures.set(resource, request.failure()?.errorText);
  });
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!response?.ok()) throw new Error('invalid_http_response');
    await page.waitForTimeout(5000);
    const body = (await page.locator('body').innerText()).trim();
    const issue = pageIssue({ url: page.url(), status: response.status(), title: await page.title(), body });
    if (issue) {
      const report = { requested_url: sanitizeUrl(url), url: reportUrl(page.url()), http_status: response.status(),
        checked_at: new Date().toISOString(), passed: false, snapshotEligible: false, reason: issue,
        failed_resources: [...failures].map(([url, error]) => ({ url, error })) };
      writeJson(option('--report'), report);
      console.log(JSON.stringify(report, null, 1));
      process.exitCode = 2;
      return;
    }
    const result = await inspect(page);
    const report = { url: sanitizeUrl(page.url()), http_status: response.status(), checked_at: new Date().toISOString(), ...result,
      failed_resources: [...failures].map(([url, error]) => ({ url, error })) };
    writeJson(option('--report'), report);
    console.log(JSON.stringify(report, null, 1));
    const snapshot = option('--snapshot');
    if (snapshot && result.snapshotEligible) {
      fs.mkdirSync(path.dirname(snapshot), { recursive: true });
      fs.writeFileSync(snapshot, await sanitizedSnapshot(page));
    }
    fs.mkdirSync('.tmp', { recursive: true });
    await page.screenshot({ path: path.join('.tmp', `${result.tool}-${new URL(page.url()).hostname}.png`) });
    if (result.passed === false) process.exitCode = 2;
  } finally {
    await browser.close();
  }
}
