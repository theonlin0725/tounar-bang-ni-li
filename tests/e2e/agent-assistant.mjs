/* v1.1.0 Agent assistant browser acceptance: deterministic fake model, real API/SQLite/UI. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer } from '../../server/test/helpers.js';
import { resolveChromiumExecutable } from './browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, '.tmp', 'agent-e2e');
fs.mkdirSync(OUT, { recursive: true });
let server, browser, context, page;
const checks = [];
function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
  checks.push({ name, ok: true });
  console.log(`✔ ${name}`);
}
async function waitText(selector, text, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await page.locator(selector).innerText().catch(() => '')).includes(text)) return true;
    await page.waitForTimeout(150);
  }
  throw new Error(`timeout waiting ${selector} for ${text}`);
}
try {
  server = await startTestServer({
    name: 'agent-e2e',
    env: { AGENT_FAKE_MODE: 'true', AGENT_API_URL: '', AGENT_API_KEY: '', AI_API_URL: '', AI_API_KEY: '' }
  });
  const login = await server.login('demo@tounar.local');
  const cookie = login.cookie;
  const resumeBody = await server.request('/api/v1/resumes/text', {
    method: 'POST', cookie, body: { text: '张三\n教育背景：本科计算机科学\n项目经历：使用 Python 做数据分析，完成用户增长项目，指标提升 20%。\n技能：Python SQL 数据分析', filename: '产品简历' }
  });
  check('测试简历创建成功', resumeBody.status === 201, resumeBody.text);
  const app1 = (await server.request('/api/v1/applications/manual', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-e2e-app-1' },
    body: { company_name: '字节跳动', job_title: '数据分析师', has_applied: true, status: 'applied', applied_at: '2026-11-01T04:00:00Z', applied_at_precision: 'date', jd_summary: '负责数据分析和用户增长，要求 Python SQL', job_url: 'https://jobs.example.com/agent/e2e-1' }
  })).json.data;
  const app2 = (await server.request('/api/v1/applications/manual', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-e2e-app-2' },
    body: { company_name: '网易', job_title: '游戏策划', has_applied: true, status: 'assessment', applied_at: '2026-11-02T04:00:00Z', applied_at_precision: 'date', jd_summary: '负责游戏玩法策划与关卡设计', job_url: 'https://jobs.example.com/agent/e2e-2' }
  })).json.data;
  check('测试岗位创建成功', app1?.id && app2?.id);

  browser = await chromium.launch({ headless: true, executablePath: (await resolveChromiumExecutable()).path });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'tounar_session', value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  page = await context.newPage();
  await page.goto(`${server.base}/?panel=assistant`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-test=assistant-view]', { timeout: 15000 });
  await page.waitForSelector('[data-test=assistant-input]', { timeout: 15000 });
  check('左侧导航 AI 助手入口与标题', (await page.locator('[data-test=nav-assistant].active').count()) === 1
    && (await page.textContent('[data-test=page-title]')).trim() === 'AI 求职助手');
  check('欢迎卡 4 张、无画像胶囊、无工具原始结果', (await page.locator('.tn-agent-quick-card').count()) === 4
    && !(await page.locator('[data-test=assistant-view]').innerText()).includes('画像已确认')
    && !(await page.locator('[data-test=assistant-view]').innerText()).includes('tool_call'));
  await page.screenshot({ path: path.join(OUT, 'assistant-desktop.png'), fullPage: true });

  await page.click('[data-test="assistant-quick-查看本周投递情况"]');
  await waitText('[data-test=assistant-message]', '岗位记录', 15000);
  check('快捷卡完成只读筛选，状态文案收起', (await page.locator('[data-test=assistant-status]').count()) === 0
    && (await page.locator('[data-test=assistant-message]').count()) >= 1);
  await page.screenshot({ path: path.join(OUT, 'assistant-filter.png'), fullPage: true });

  await page.selectOption('[data-test=assistant-context-application]', app1.id);
  await page.waitForTimeout(400);
  await page.fill('[data-test=assistant-input]', '把状态改为面试');
  await page.click('[data-test=assistant-send]');
  await page.waitForSelector('[data-test=assistant-action-card]', { timeout: 15000 });
  const actionCardText = await page.locator('[data-test=assistant-action-card]').first().innerText();
  check('写操作先在确认卡展示，未直接写库', actionCardText.includes('修改') || actionCardText.includes('确认'));
  const before = (await server.request(`/api/v1/applications/${app1.id}`, { cookie })).json.data;
  check('确认前状态未变', before.status === 'applied');
  await page.locator('[data-test=assistant-action-card]').first().locator('button.tn-btn-primary').click();
  await page.waitForTimeout(500);
  const after = (await server.request(`/api/v1/applications/${app1.id}`, { cookie })).json.data;
  check('确认后状态写入台账', after.status === 'interview', after.status);

  await page.fill('[data-test=assistant-input]', '帮我按这个岗位的 JD 优化简历');
  await page.click('[data-test=assistant-send]');
  await page.waitForSelector('[data-test=assistant-action-card]', { timeout: 15000 });
  const card = page.locator('[data-test=assistant-action-card]').last();
  await card.locator('button.tn-btn-primary').click();
  await page.waitForTimeout(700);
  const versions = (await server.request('/api/v1/resumes?limit=10', { cookie })).json.data;
  check('改写确认后生成新简历版本，原版本保留', versions.length >= 2 && versions.some((item) => item.parent_resume_id));

  await page.selectOption('[data-test=assistant-context-application]', app2.id);
  await page.waitForTimeout(500);
  check('切换岗位后上下文边界可见', (await page.locator('[data-test=assistant-boundary]').last().innerText()).includes('网易'));

  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(250);
  const mobile = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, cards: document.querySelectorAll('.tn-agent-quick-card').length }));
  check('390px 助手无页面级横向溢出', mobile.scrollWidth <= mobile.innerWidth + 1, JSON.stringify(mobile));
  await page.screenshot({ path: path.join(OUT, 'assistant-mobile.png'), fullPage: true });
  await page.goto(`${server.base}/?panel=career&section=resume`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-test=resume-ai-rewrite-source]', { timeout: 15000 });
  check('简历库展示 AI 定向改写来源，不覆盖原版本', (await page.locator('[data-test=resume-ai-rewrite-source]').first().innerText()).includes('AI 定向改写版本'));
  await page.screenshot({ path: path.join(OUT, 'resume-rewrite-source.png'), fullPage: true });

  console.log(JSON.stringify({ passed: checks.length, failed: 0, report: path.join(OUT, 'agent-e2e-report.json') }));
  fs.writeFileSync(path.join(OUT, 'agent-e2e-report.json'), JSON.stringify({ checks, app1: app1.id, app2: app2.id, resume: resumeBody.json.data.id, generated_at: new Date().toISOString() }, null, 2));
} catch (error) {
  console.error(error?.stack || error);
  fs.writeFileSync(path.join(OUT, 'agent-e2e-failure.json'), JSON.stringify({ checks, error: String(error?.stack || error) }, null, 2));
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
}
