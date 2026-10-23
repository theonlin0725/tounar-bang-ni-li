// Inject unchanged production content scripts on a public page. Capture events
// locally; never transmit to the application or submit a job application.
import path from 'node:path';
import { siteSession } from './site-session.mjs';

await siteSession(process.argv[2], async page => {
  await page.evaluate(() => {
    window.__captured = [];
    window.chrome = window.chrome || {};
    window.chrome.runtime = {
      sendMessage(message, callback) { window.__captured.push(message?.event); callback?.({ ok: true, queued: 1 }); },
      lastError: null
    };
  });
  await page.addScriptTag({ path: path.resolve('extension/content/adapters.js') });
  await page.addScriptTag({ path: path.resolve('extension/content/tracker.js') });
  await page.waitForFunction(() => window.__captured.some(event => event?.event_type === 'job_viewed'), null, { timeout: 18000 }).catch(() => {});
  const result = await page.evaluate(() => ({
    adapter: document.documentElement.getAttribute('data-tounar-adapter'),
    adapterVersion: document.documentElement.getAttribute('data-tounar-adapter-version'),
    events: window.__captured.filter(Boolean)
  }));
  const views = result.events.filter(event => event.event_type === 'job_viewed');
  const payload = views.at(-1)?.payload || {};
  const filled = ['company_name', 'job_title', 'job_url', 'jd_summary'].filter(key => payload[key]);
  // Having values is an extraction smoke check, not a correctness verdict.
  return { tool: 'tryrun', ...result, core_fields_present: filled,
    passed: views.length === 1 && filled.length >= 3, snapshotEligible: views.length === 1 };
});
