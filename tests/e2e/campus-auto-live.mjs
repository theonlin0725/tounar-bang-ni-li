#!/usr/bin/env node
/*
 * 校招岗位自动整理验收（隔离后台 + 真实 DeepSeek + 真实扩展）。
 * 用户路径：打开 CSV 校招入口 -> 点击可见岗位 -> 正常阅读 -> 自动 job_viewed。
 * 测试不发送 capture_current_tab，不直接调模型接口，不伪造事件。
 *
 * 用法：
 *   node tests/e2e/campus-auto-live.mjs --limit 3
 *   node tests/e2e/campus-auto-live.mjs --company 字节跳动
 *   node tests/e2e/campus-auto-live.mjs --all
 * 说明：--all 使用测试扩展预授权本次清单域名，只用于本地覆盖验收；
 * 跨域“补授权”流程在 --manual-auth 模式另行演练并单列，不混算。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { startTestServer } from '../../server/test/helpers.js';
import { resolveChromiumExecutable } from './browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CSV = path.join(ROOT, 'docs', 'recruitment-company-urls-20261118.csv');
const OUT = path.join(ROOT, '.tmp', 'campus-live', `run-${Date.now()}`);
fs.mkdirSync(OUT, { recursive: true });

function arg(name, fallback = '') {
  const eq = process.argv.find(x => x.startsWith('--' + name + '='));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const LIMIT = Number(arg('limit', 0)) || 0;
const ALL = Boolean(arg('all', false));
const ONLY = String(arg('company', '') || '').trim();
const ONLY_IDS = String(arg('companies', '') || '').split(',').map(x => x.trim()).filter(Boolean);
const DRY = Boolean(arg('dry', false));

function readCsv() {
  const text = fs.readFileSync(CSV, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const parse = line => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === ',' && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur); return out;
  };
  const headers = parse(lines.shift());
  return lines.map(line => {
    const cells = parse(line);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] || '']));
  }).filter(r => r['序号'] && r['公司名称']);
}
const rows = readCsv();
let selected = rows.filter(r => r['校招入口'] || r['社招入口']);
if (ONLY) selected = selected.filter(r => r['公司名称'].includes(ONLY));
if (ONLY_IDS.length) selected = selected.filter(r => ONLY_IDS.includes(String(r['序号'])));
if (LIMIT) selected = selected.slice(0, LIMIT);
if (!selected.length) throw new Error('没有选中的公司');

const origins = new Set();
for (const row of selected) {
  for (const value of [row['校招入口'], row['社招入口'], row['岗位详情样本']]) {
    try { origins.add(new URL(value).origin + '/*'); } catch {}
  }
}
const surveyFile = path.join(ROOT, '.tmp', 'campus-audit', 'survey.jsonl');
const survey = new Map();
if (fs.existsSync(surveyFile)) {
  for (const line of fs.readFileSync(surveyFile, 'utf8').trim().split('\n')) {
    try {
      const r = JSON.parse(line); survey.set(String(r.id), r);
      for (const c of r.candidates || []) { try { origins.add(new URL(c.url).origin + '/*'); } catch {} }
    } catch {}
  }
}

const credentials = parseEnv(fs.readFileSync('/Users/mingenlin/Desktop/opencode project/帮你理/.env', 'utf8').replace(/^\uFEFF/, ''));
const env = {
  ALLOWED_EMAILS: 'demo@tounar.local',
  JD_AI_ENABLED: 'true',
  JD_AI_API_KEY: credentials.JD_AI_API_KEY || credentials.AI_API_KEY,
  JD_AI_API_URL: credentials.JD_AI_API_URL || 'https://api.deepseek.com/chat/completions',
  JD_AI_MODEL: credentials.JD_AI_MODEL || 'deepseek-flash'
};
if (!env.JD_AI_API_KEY) throw new Error('缺少 DeepSeek 密钥；本地验收未启动');

const server = await startTestServer({ name: 'campus-live-' + Date.now(), env });
const { cookie } = await server.login('demo@tounar.local');
const device = await server.pairDevice(cookie);
const extDir = path.join(OUT, 'extension');
fs.cpSync(path.join(ROOT, 'extension'), extDir, { recursive: true });
const manifestPath = path.join(extDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = [...origins];
fs.writeFileSync(manifestPath, JSON.stringify(manifest));

const executable = await resolveChromiumExecutable();
const context = await chromium.launchPersistentContext(path.join(OUT, 'profile'), {
  executablePath: executable.path,
  headless: true,
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
});
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
await worker.evaluate(async ({ base, device }) => {
  await TounarCommon.setSettings({ serverUrl: base, deviceToken: device.device_token, deviceId: device.device_id, bindingVersion: device.binding_version });
  await syncContentScripts();
}, { base: server.base, device });
const cookieParts = cookie.split(';')[0].split('=');
await context.addCookies([{ name: cookieParts[0], value: cookieParts.slice(1).join('='), url: server.base }]);
await context.addInitScript(() => {
  if (/^https?:/.test(location.protocol)) sessionStorage.setItem('tounar.plugin.onboarding.demo@tounar.local', 'connection');
});

const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const db = () => new DatabaseSync(path.join(server.dir, 'tounar.sqlite'), { readOnly: true });

function scanScript() {
  const nav = /^(首页|社会招聘|校园招聘|校招|社招|登录|注册|关于|更多|招聘动态|公司介绍|职位筛选|工作地点|职位性质|所属部门|职能类型|投递|申请|一键投递|查看全部|返回|上一页|下一页|校园招聘首页|招聘首页)$/;
  const vis = n => n.getClientRects().length > 0;
  const text = n => String(n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
  const detailLike = u => /\/(?:job|jobs|position|positions|post|detail|jobdetail|job-info|recruitment\/post)[/#?]|\/(?:campus|grad|intern)\/detail|jobUnionId|positionId|postid|postId|requementId|requisitionId/i.test(u);
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    if (!vis(a)) continue;
    const t = text(a).slice(0, 160);
    if (!t || t.length < 2 || nav.test(t)) continue;
    let href = ''; try { href = new URL(a.href, location.href).href; } catch { continue; }
    if (!/^https?:/i.test(href)) continue;
    if (!detailLike(href) && !/[0-9]{4,}/.test(href) && t.length < 4) continue;
    out.push({ text: t, label: t.split(/\n/)[0].slice(0, 100), href, kind: 'link', score: /[0-9]{4,}|\/detail|post_detail|jobUnionId|positionId/i.test(href) ? 3 : 1 });
  }
  for (const b of document.querySelectorAll('button,[role="button"]')) {
    if (!vis(b)) continue;
    const t = text(b).slice(0, 80);
    if (t && !nav.test(t) && /岗位|职位|查看|投递|申请/i.test(t)) out.push({ text: t, label: t, href: '', kind: 'button', score: 0 });
  }
  for (const card of document.querySelectorAll('[class*="positionItem"],[class*="job-card"],[class*="jobItem"],[class*="position-item"],[class*="job-item"],[class*="jobCard"]')) {
    if (!vis(card) || card.closest('nav,header,footer,aside')) continue;
    const titleNode = card.querySelector('[class*="title"],[class*="Title"],h2,h3,h4');
    const t = text(titleNode || card).slice(0, 160);
    if (!t || t.length < 2 || nav.test(t)) continue;
    out.push({ text: t, label: t.split(/\n/)[0].slice(0, 100), href: '', kind: 'card', score: 2 });
  }
  const seen = new Set();
  return out.sort((a, b) => b.score - a.score).filter(x => { const k = x.kind + '|' + x.text; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
}
async function clickCandidate(page, candidate) {
  if (candidate.kind === 'link') {
    // The href attribute is often relative; resolve the DOM index by the
    // runtime absolute URL instead of using an [href="absolute"] selector.
    const index = await page.evaluate(href => [...document.querySelectorAll('a[href]')].findIndex(a => {
      try { return a.href === href; } catch { return false; }
    }), candidate.href);
    if (index < 0) return null;
    const loc = page.locator('a[href]').nth(index);
    const before = context.pages().length;
    await loc.click({ timeout: 6000 }).catch(() => loc.click({ timeout: 3000, force: true }).catch(() => {}));
    await page.waitForTimeout(2200);
    const pages = context.pages();
    const target = pages.length > before ? pages[pages.length - 1] : page;
    return { url: target.url(), title: candidate.text, kind: 'link', page: target };
  }
  const loc = page.getByText(candidate.label || candidate.text, { exact: false }).first();
  if (!await loc.isVisible().catch(() => false)) return null;
  const before = context.pages().length;
  await loc.click({ timeout: 5000 }).catch(() => loc.click({ timeout: 3000, force: true }).catch(() => {}));
  await page.waitForTimeout(2200);
  const pages = context.pages();
  const target = pages.length > before ? pages[pages.length - 1] : page;
  return { url: target.url(), title: candidate.text, kind: candidate.kind, page: target };
}

async function selectEmptyProjectFilter(page) {
  const zero = await page.evaluate(() => /开启新的工作（0）|开启新的工作\(0\)|0 个职位/.test(document.body?.innerText || '')).catch(() => false);
  if (!zero) return false;
  for (const label of ['2027届校园招聘', '2026届校园招聘', '正式', '全部']) {
    const l = page.getByText(label, { exact: true }).first();
    if (await l.isVisible().catch(() => false)) {
      await l.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(2500);
      return true;
    }
  }
  return false;
}
async function clickJob(page) {
  // Dismiss common cookie/chat/guide overlays before clicking a job card.
  for (const label of ['稍后再说','关闭','知道了','跳过','以后再说','暂不']) {
    const l = page.getByText(label, { exact: true }).first();
    if (await l.isVisible().catch(() => false)) { await l.click({ timeout: 1500 }).catch(() => {}); await page.waitForTimeout(300); }
  }
  await page.addStyleTag({content:'[class*="hire-ai-assistant-guide"]{pointer-events:none!important}'}).catch(() => {});
  for (let round = 0; round < 4; round += 1) {
    await selectEmptyProjectFilter(page);
    let candidates = await page.evaluate(scanScript);
    if (!candidates.length) {
      for (const label of ['校招职位', '校园招聘', '在招职位', '热招职位', '职位', '全部职位', '岗位列表', '查看职位']) {
        const loc = page.getByText(label, { exact: true }).first();
        if (await loc.isVisible().catch(() => false)) {
          await loc.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(1800);
          candidates = await page.evaluate(scanScript);
          if (candidates.length) break;
        }
      }
    }
    if (!candidates.length) {
      // ByteDance-style list pages show 0 until a recruitment project filter is
      // selected. This is a visible user navigation, not a hidden API call.
      const zero = await page.evaluate(() => /开启新的工作（0）|开启新的工作\(0\)|0 个职位/.test(document.body?.innerText || '')).catch(() => false);
      if (zero) {
        for (const label of ['2027届校园招聘', '2026届校园招聘', '正式', '全部']) {
          const l = page.getByText(label, { exact: true }).first();
          if (await l.isVisible().catch(() => false)) {
            await l.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(2500);
            candidates = await page.evaluate(scanScript);
            if (candidates.length) break;
          }
        }
      }
    }
    if (!candidates.length) return null;
    // Prefer an explicit detail/numbered link; a "职位"/nav click is only a
    // navigation step and must be followed by another scan.
    const detail = candidates.find(c => c.kind === 'link' && /\/detail(?:\/|$)|post_detail|jobUnionId=|positionId=|requementId=|#\/job\//i.test(c.href));
    const chosen = detail || candidates.find(c => c.kind === 'link') || candidates[0];
    const clicked = await clickCandidate(page, chosen);
    if (clicked) await clicked.page.waitForTimeout(1500);
    if (!clicked) return null;
    const url = clicked.url;
    const hasPanel = clicked.kind === 'card' && await clicked.page.evaluate(() => /岗位职责|职位描述|任职要求|Responsibilities|Requirements/i.test(document.body?.innerText || '')).catch(() => false);
    if (/\/detail(?:\/|$)|post_detail|jobUnionId=|positionId=|requementId=|jobId=|[#/]job\/[^/]+/i.test(url) || hasPanel) return clicked;
    page = clicked.page;
    await page.waitForTimeout(3500);
  }
  return null;
}
function directCandidates(row) {
  const out = [];
  if (row['岗位详情样本']) out.push({ url: row['岗位详情样本'], source: 'csv-sample' });
  const s = survey.get(String(row['序号']));
  for (const c of s?.candidates || []) if (c.reason !== '表内详情') out.push({ url: c.url, source: 'survey-candidate' });
  return out;
}
function findApp(row, detailUrl, clickedTitle) {
  const dbx = db();
  try {
    const apps = dbx.prepare("SELECT a.id,a.job_title,a.company_name,a.job_url,a.jd_text,a.created_at,a.status FROM applications a ORDER BY a.created_at DESC").all();
    const host = (() => { try { return new URL(detailUrl).hostname; } catch { return ''; } })();
    return apps.find(a => (a.job_url && host && a.job_url.includes(host)) || (clickedTitle && a.job_title && (clickedTitle.includes(a.job_title) || a.job_title.includes(clickedTitle)))) || null;
  } finally { dbx.close(); }
}
function evidence(appId) {
  const dbx = db();
  try {
    return {
      sources: dbx.prepare("SELECT field,source_method,source_detail FROM application_field_sources WHERE application_id=?").all(appId),
      events: dbx.prepare("SELECT event_type,payload_json FROM events WHERE application_id=? ORDER BY occurred_at").all(appId)
    };
  } finally { dbx.close(); }
}
async function frontEnd(appId) {
  const p = await context.newPage();
  try {
    await p.goto(server.base + '/?app=' + appId, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await p.locator('[data-test=detail-drawer]').waitFor({ timeout: 10000 });
    const jd = (await p.locator('[data-test=detail-jd-text]').innerText().catch(() => '')).trim();
    return { ok: jd.length > 12 && !/推荐职位|相关职位|相似职位/.test(jd), jd };
  } finally { await p.close(); }
}

for (const row of selected) {
  const result = { 序号: row['序号'], 公司: row['公司名称'], 入口: row['校招入口'], 结果: '', 导航: '', 点击标题: '', 详情URL: '', 入账ID: '', 模型来源: '', job_viewed: 0, 前端: '', 错误: '', 时间: new Date().toISOString() };
  let page;
  try {
    if (DRY) { result.结果 = '跳过（dry）'; results.push(result); continue; }
    page = await context.newPage();
    const entry = row['校招入口'] || row['社招入口'];
    const resp = await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 20000 });
    result.http = resp?.status() || 0;
    await page.waitForTimeout(3000);
    let clicked = await clickJob(page);
    if (!clicked) {
      const fallback = directCandidates(row)[0];
      if (fallback) {
        await page.goto(fallback.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2500);
        clicked = { url: page.url(), title: '(直链定位)', kind: 'direct', page };
        result.导航 = '直链定位（入口未点到岗位）';
      }
    } else result.导航 = clicked.kind;
    if (!clicked) { result.结果 = '入口无可见岗位/导航失败'; continue; }
    result.点击标题 = clicked.title;
    result.详情URL = clicked.url;
    await clicked.page.bringToFront();
    await clicked.page.waitForTimeout(8000);
    let app = findApp(row, clicked.url, clicked.title);
    for (let i = 0; i < 8 && !app; i++) { await clicked.page.waitForTimeout(1200); app = findApp(row, clicked.url, clicked.title); }
    if (!app) { result.结果 = '插件未自动入账'; continue; }
    result.入账ID = app.id;
    const ev = evidence(app.id);
    const jdSource = ev.sources.find(s => ['jd_text', 'jd_summary'].includes(s.field));
    result.模型来源 = jdSource?.source_detail || jdSource?.source_method || 'unknown';
    result.job_viewed = ev.events.filter(e => e.event_type === 'job_viewed').length;
    const fe = await frontEnd(app.id);
    result.前端 = fe.ok ? '通过' : '未通过';
    result.结果 = result.job_viewed > 0 && result.前端 === '通过' ? '自动整理成功' : '已入账但证据不完整';
    result.前端JD = fe.jd.slice(0, 160);
  } catch (error) {
    result.结果 = '异常';
    result.错误 = String(error.message || error).split('\n')[0].slice(0, 300);
  } finally {
    await page?.close().catch(() => {});
    results.push(result);
    console.log(JSON.stringify(result));
    fs.writeFileSync(path.join(OUT, 'results.jsonl'), results.map(x => JSON.stringify(x)).join('\n') + '\n');
  }
}
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ selected: selected.length, results }, null, 2));
console.log(`\n结果目录：${OUT}`);
console.log(`完成 ${results.filter(r => r.结果 === '自动整理成功').length}/${results.length}`);
await context.close();
await server.stop();
