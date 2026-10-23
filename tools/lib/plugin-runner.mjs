/*
 * 在真实招聘页面上运行生产版 content 脚本，只替换 chrome.runtime.sendMessage 为桩函数。
 *
 * 这是 tools/tryrun-plugin.mjs、tools/probe-site.mjs 与站点离线 fixture 采集的共同底座：
 * - 注入的 adapters.js / tracker.js 直接读 extension/ 下的生产文件，不复制、不改写；
 * - 返回完整 job_viewed payload、字段把握度、检测来源与页面状态；
 * - 可保存脱敏 DOM 快照，供 tests/fixtures/sites 离线回归。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

export const ROOT = process.cwd();
export const FIELDS = ['company_name', 'job_title', 'location', 'recruitment_batch', 'jd_summary', 'site_job_id', 'job_url'];

const adapters = fs.readFileSync(path.join(ROOT, 'extension/content/adapters.js'), 'utf8');
const tracker = fs.readFileSync(path.join(ROOT, 'extension/content/tracker.js'), 'utf8');

export function launchBrowser() {
  return chromium.launch({
    channel: 'chrome',
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows'
    ]
  });
}

const STUB = `
  window.__captured = [];
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    sendMessage: (msg, cb) => {
      try { window.__captured.push(msg); } catch (e) {}
      if (cb) cb({ ok: true, queued: 1 });
    },
    lastError: null
  };
`;

/* 脱敏：去掉脚本、内联事件、追踪参数、远程资源，只保留结构与文本。
   这样 fixture 不含用户表单内容，也不会在离线测试时访问外网。 */
const SANITIZE = `(() => {
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('script, noscript, iframe, object, embed, link, meta[http-equiv="Content-Security-Policy"]').forEach((el) => el.remove());
  clone.querySelectorAll('svg, canvas, video, audio').forEach((el) => el.remove());
  clone.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'integrity' || name === 'nonce' || name === 'srcset') {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'src') {
        const value = String(attr.value || '');
        if (/^data:|^blob:/i.test(value)) el.removeAttribute('src');
        else el.setAttribute('src', 'about:blank');
        continue;
      }
      if (name === 'href') {
        const value = String(attr.value || '');
        if (/^javascript:/i.test(value) || value.length > 2000) el.removeAttribute('href');
      }
      if (name === 'style' && String(attr.value).length > 4000) el.removeAttribute('style');
    }
    if (el.tagName === 'IMG') el.removeAttribute('src');
  });
  return '<!doctype html>\\n' + clone.outerHTML;
})()`;

export async function runPlugin(url, {
  browser: providedBrowser = null,
  timeout = 25000,
  settleMs = 500,
  screenshotPath = null
} = {}) {
  const browser = providedBrowser || await launchBrowser();
  const ownBrowser = !providedBrowser;
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err?.message || err).slice(0, 300)));
  await page.addInitScript(STUB);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((err) => {
    pageErrors.push(`goto: ${String(err?.message || err).slice(0, 240)}`);
  });
  await page.bringToFront().catch(() => {});
  await page.addScriptTag({ content: adapters }).catch((err) => pageErrors.push(`adapters: ${err.message}`));
  await page.addScriptTag({ content: tracker }).catch((err) => pageErrors.push(`tracker: ${err.message}`));
  await page.waitForFunction(() => window.__captured?.some((m) => m?.event?.type === 'job_viewed')
    || document.documentElement.getAttribute('data-tounar-view-sent') === '1', null, { timeout }).catch(() => {});
  await page.waitForTimeout(settleMs);

  const state = await page.evaluate(() => ({
    adapter: document.documentElement.getAttribute('data-tounar-adapter'),
    adapterVersion: document.documentElement.getAttribute('data-tounar-adapter-version'),
    jobDetected: document.documentElement.getAttribute('data-tounar-job-detected'),
    jobTitle: document.documentElement.getAttribute('data-tounar-job-title'),
    detectionScore: document.documentElement.getAttribute('data-tounar-detection-score'),
    visibleMs: document.documentElement.getAttribute('data-tounar-visible-ms'),
    viewSent: document.documentElement.getAttribute('data-tounar-view-sent'),
    visibility: document.visibilityState,
    pageTitle: document.title,
    href: location.href,
    events: (window.__captured || []).map((m) => m?.event).filter(Boolean),
    capturedCount: (window.__captured || []).length
  })).catch((err) => ({ error: err.message, events: [] }));
  const event = state.events?.find((e) => e.type === 'job_viewed') || state.events?.[0] || null;
  const payload = event?.payload || null;

  let html = null;
  if (screenshotPath) {
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
  }
  if (state.viewSent === '1' || event) {
    html = await page.evaluate(SANITIZE).catch((err) => {
      pageErrors.push(`snapshot: ${err.message}`);
      return null;
    });
  }

  await page.close().catch(() => {});
  if (ownBrowser) await browser.close().catch(() => {});

  return {
    url,
    final_url: state.href || url,
    page_title: state.pageTitle || '',
    adapter: state.adapter,
    adapter_version: state.adapterVersion,
    site_job_id_detected: state.jobDetected,
    detected_title: state.jobTitle,
    detection_score: state.detectionScore == null ? null : Number(state.detectionScore),
    visible_ms: Number(state.visibleMs || 0),
    view_sent: state.viewSent === '1',
    visibility: state.visibility,
    event,
    payload,
    detection: payload?.detection || null,
    html,
    page_errors: pageErrors
  };
}

export function fieldSummary(payload) {
  const summary = {};
  for (const key of FIELDS) {
    summary[key] = {
      value: payload?.[key] ?? null,
      confidence: payload?.field_confidence?.[key] ?? null
    };
  }
  return summary;
}

export function safeName(value) {
  return String(value || '')
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown';
}
