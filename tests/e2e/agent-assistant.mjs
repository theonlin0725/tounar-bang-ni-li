/* v1.1.0 Agent assistant browser acceptance: deterministic fake model, real API/SQLite/UI. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer } from '../../server/test/helpers.js';
import { DatabaseSync } from 'node:sqlite';
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
    body: { company_name: '字节跳动', job_title: '数据分析师', has_applied: true, status: 'applied', applied_at: '2026-11-01T04:00:00Z', applied_at_precision: 'date', jd_summary: '负责数据分析和用户增长，要求 Python SQL 与业务分析能力', job_url: 'https://jobs.example.com/agent/e2e-1' }
  })).json.data;
  const viewed = (await server.request('/api/v1/applications/manual', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-e2e-viewed-1' },
    body: { company_name: '看过公司', job_title: '产品经理', has_applied: false, status: 'pending', jd_summary: '负责产品规划与需求分析', job_url: 'https://jobs.example.com/agent/e2e-viewed' }
  })).json.data;
  const noJd = (await server.request('/api/v1/applications/manual', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-e2e-no-jd' },
    body: { company_name: '缺JD公司', job_title: '待补岗位', has_applied: false, status: 'pending', jd_summary: '待补', job_url: 'https://jobs.example.com/agent/e2e-no-jd' }
  })).json.data;
  const app2 = (await server.request('/api/v1/applications/manual', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-e2e-app-2' },
    body: { company_name: '网易', job_title: '游戏策划', has_applied: true, status: 'assessment', applied_at: '2026-11-02T04:00:00Z', applied_at_precision: 'date', jd_summary: '负责游戏玩法策划与关卡设计', job_url: 'https://jobs.example.com/agent/e2e-2' }
  })).json.data;
  check('测试岗位创建成功', app1?.id && app2?.id && noJd?.id);

  browser = await chromium.launch({ headless: true, executablePath: (await resolveChromiumExecutable()).path });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'tounar_session', value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  page = await context.newPage();
  await page.goto(`${server.base}/?panel=assistant`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-test=assistant-view]', { timeout: 15000 });
  await page.waitForSelector('[data-test=assistant-input]', { timeout: 15000 });
  check('左侧导航 AI 助手入口与标题', (await page.locator('[data-test=nav-assistant].active').count()) === 1
    && (await page.textContent('[data-test=page-title]')).trim() === 'AI 求职助手');
  check('欢迎卡 4 张、画像状态真实、无工具原始结果', (await page.locator('.tn-agent-quick-card').count()) === 4
    && (await page.locator('[data-test=assistant-profile-pill]').innerText()).includes('画像：')
    && !(await page.locator('[data-test=assistant-view]').innerText()).includes('tool_call'));
  const markdown = await page.evaluate(async () => {
    const mod = await import('/assets/js/markdown.js');
    const root = document.createElement('div');
    root.append(mod.renderMarkdownNodes('## 结论\n**重点**\n- 第一条\n<script>window.__xss=1</script>'));
    return { strong: root.querySelectorAll('strong').length, list: root.querySelectorAll('ul li').length, script: root.querySelectorAll('script').length, text: root.textContent };
  });
  check('安全 Markdown 渲染标题/加粗/列表并转义 script', markdown.strong === 1 && markdown.list === 1 && markdown.script === 0 && markdown.text.includes('<script>'), JSON.stringify(markdown));
  await page.screenshot({ path: path.join(OUT, 'assistant-desktop.png'), fullPage: true });

  await page.click('[data-test="assistant-quick-查看本周投递情况"]');
  await waitText('[data-test=assistant-message]', '岗位记录', 15000);
  check('快捷卡完成只读筛选，状态文案收起', (await page.locator('[data-test=assistant-status]').count()) === 0
    && (await page.locator('[data-test=assistant-message]').count()) >= 1);
  check('首轮对话后顶部欢迎与快捷卡仍常驻', (await page.locator('.tn-agent-quick-card').count()) === 4
    && (await page.locator('[data-test=assistant-profile-onboarding]').count()) === 1);
  check('欢迎区位于对话滚动容器内部，不固定吸顶', await page.evaluate(() => {
    const thread = document.querySelector('[data-test=assistant-thread]');
    const welcome = document.querySelector('.tn-assistant-welcome');
    return Boolean(thread && welcome && thread.contains(welcome));
  }));
  await page.screenshot({ path: path.join(OUT, 'assistant-filter.png'), fullPage: true });

  await page.route('**/api/v1/agent/sessions/*/chat', (route) => route.abort());
  await page.fill('[data-test=assistant-input]', '网络异常可见错误');
  await page.click('[data-test=assistant-send]');
  await page.waitForSelector('[data-test=assistant-retry]', { timeout: 10000 });
  check('网络中断时消息流保留错误气泡与重试按钮', (await page.locator('[data-test=assistant-retry]').count()) === 1);
  await page.unroute('**/api/v1/agent/sessions/*/chat');
  await page.click('[data-test=assistant-retry]');
  await page.waitForTimeout(700);
  check('重试按钮可重新发起本轮', (await page.locator('[data-test=assistant-retry]').count()) === 0);

  await page.click('[data-test=assistant-context-profile]');
  await page.waitForSelector('[data-test=assistant-action-card]', { timeout: 15000 });
  const profileCardText = await page.locator('[data-test=assistant-action-card]').last().innerText();
  check('画像确认卡展示六维内容', profileCardText.includes('保存求职画像') && profileCardText.includes('产品经理'), profileCardText);
  await page.locator('[data-test=assistant-action-card]').last().locator('button.tn-btn-primary').click();
  await page.waitForTimeout(700);
  const savedProfile = (await server.request('/api/v1/profile', { cookie })).json.data.profile;
  check('确认后画像落盘为 confirmed', savedProfile?.status === 'confirmed' && savedProfile.preferred_locations.includes('上海'));
  await page.waitForTimeout(400);
  check('画像确认后顶部胶囊与横条实时切换', (await page.locator('[data-test=assistant-profile-pill]').innerText()).includes('画像：已建立')
    && (await page.locator('[data-test=assistant-profile-bar]').count()) === 1
    && (await page.locator('[data-test=assistant-profile-edit]').count()) === 1);

  await page.click('[data-test=assistant-context-application]');
  await page.click('[data-test=job-picker-viewed]');
  await page.waitForSelector(`[data-test=job-picker-option][data-job-id="${viewed.id}"]`, { timeout: 10000 });
  check('二级岗位选择器可展开看过没投', (await page.locator(`[data-test=job-picker-option][data-job-id="${viewed.id}"]`).count()) === 1);
  await page.keyboard.press('Escape');
  await page.click('[data-test=assistant-context-application]');
  await page.click('[data-test=job-picker-applied]');
  await page.click(`[data-test=job-picker-option][data-job-id="${app1.id}"]`);
  await page.waitForTimeout(500);
  await page.fill('[data-test=assistant-input]', '把状态改为面试');
  await page.click('[data-test=assistant-send]');
  await page.waitForSelector('[data-test=assistant-action-card]', { timeout: 15000 });
  const actionCardText = await page.locator('[data-test=assistant-action-card]').first().innerText();
  check('写操作先在确认卡展示，未直接写库', actionCardText.includes('修改') || actionCardText.includes('确认'));
  const before = (await server.request(`/api/v1/applications/${app1.id}`, { cookie })).json.data;
  check('确认前状态未变', before.status === 'applied');
  await page.locator('[data-test=assistant-action-card]').last().locator('button.tn-btn-primary').click();
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

  await page.click('[data-test=assistant-context-application]');
  await page.click('[data-test=job-picker-viewed]');
  await page.click(`[data-test=job-picker-option][data-job-id="${noJd.id}"]`);
  await page.waitForTimeout(500);
  await page.fill('[data-test=assistant-input]', '分析这个岗位的匹配度');
  await page.click('[data-test=assistant-send]');
  await page.waitForSelector('[data-test=assistant-missing-jd-card]', { timeout: 15000 });
  check('缺 JD 岗位在对话内展示补录卡', (await page.locator('[data-test=assistant-missing-jd-card]').innerText()).includes('待补岗位'));
  const jdText = '岗位职责：负责跨境业务的数据分析与用户增长策略，搭建指标体系并推动产品迭代。任职要求：本科及以上，熟悉 SQL、Python 与 A/B 测试，有跨团队沟通能力。';
  await page.fill('[data-test=missing-jd-input]', jdText);
  await page.click('[data-test=missing-jd-save]');
  await page.waitForFunction(() => document.querySelector('[data-test=assistant-missing-jd-card]')?.innerText.includes('JD 已保存'), null, { timeout: 15000 });
  const savedNoJd = (await server.request(`/api/v1/applications/${noJd.id}`, { cookie })).json.data;
  check('补录 JD 真实写入台账并自动续接', savedNoJd.jd_text.includes('跨境业务的数据分析'));
  await page.click('[data-test=assistant-context-application]');
  await page.click('[data-test=job-picker-applied]');
  await page.click(`[data-test=job-picker-option][data-job-id="${app2.id}"]`);
  await page.waitForTimeout(700);
  check('切换岗位后上下文边界可见', (await page.locator('[data-test=assistant-boundary]').last().innerText()).includes('网易'));

  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(250);
  const mobile = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, cards: document.querySelectorAll('.tn-agent-quick-card').length }));
  check('390px 助手无页面级横向溢出', mobile.scrollWidth <= mobile.innerWidth + 1, JSON.stringify(mobile));
  const scrollState = await page.evaluate(() => {
    const thread = document.querySelector('[data-test=assistant-thread]');
    return { scrollTop: thread?.scrollTop || 0, scrollHeight: thread?.scrollHeight || 0, clientHeight: thread?.clientHeight || 0, pageY: window.scrollY };
  });
  check('长对话使用独立滚动区且不跳回页面顶部', scrollState.scrollHeight <= scrollState.clientHeight + 1 || scrollState.scrollTop > 0, JSON.stringify(scrollState));
  await page.screenshot({ path: path.join(OUT, 'assistant-mobile.png'), fullPage: true });
  await page.goto(`${server.base}/?panel=career&section=resume`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-test=resume-ai-rewrite-source]', { timeout: 15000 });
  check('简历库展示 AI 定向改写来源，不覆盖原版本', (await page.locator('[data-test=resume-ai-rewrite-source]').first().innerText()).includes('AI 定向改写版本'));
  await page.screenshot({ path: path.join(OUT, 'resume-rewrite-source.png'), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${server.base}/?panel=career&section=rewrite&app=${app1.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-test=resume-rewrite-view]', { timeout: 15000 });
  await page.waitForSelector('[data-test=rewrite-start]', { timeout: 15000 });
  check('简历改写工作台展示岗位/简历/画像/JD 四卡', (await page.locator('[data-test=rewrite-job-card]').count()) === 1
    && (await page.locator('[data-test=rewrite-resume-card]').count()) === 1
    && (await page.locator('[data-test=rewrite-profile-card]').count()) === 1
    && (await page.locator('[data-test=rewrite-jd-card]').count()) === 1);
  await page.click('[data-test=rewrite-start]');
  await page.waitForSelector('[data-test=rewrite-progress]', { timeout: 5000 });
  check('改写生成期间展示真实进度条', (await page.locator('[data-test=rewrite-progress-percent]').count()) === 1);
  await page.waitForSelector('[data-test=rewrite-block]', { timeout: 20000 });
  const rewriteCounts = {
    blocks: await page.locator('[data-test=rewrite-block]').count(),
    aligns: await page.locator('[data-test=rewrite-inline-badge]').count(),
    jd: await page.locator('[data-test=rewrite-jd-overview]').count()
  };
  check('改写生成左右对照块与 JD 四类概览', rewriteCounts.blocks >= 2 && rewriteCounts.aligns >= 2 && rewriteCounts.jd === 1, JSON.stringify(rewriteCounts));
  const paired = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.tn-rewrite-row:not(.tn-rewrite-row-head)')];
    return {
      rows: rows.length,
      aligned: rows.every((row) => {
        const cells = row.querySelectorAll(':scope > .tn-rewrite-cell');
        return cells.length === 2 && Math.abs(cells[0].getBoundingClientRect().top - cells[1].getBoundingClientRect().top) <= 1;
      }),
      inline: [...document.querySelectorAll('[data-test=rewrite-inline-badge]')].every((badge) => {
        const parent = badge.parentElement;
        return parent?.classList.contains('tn-rewrite-text-line') && parent.firstElementChild?.classList.contains('tn-rewrite-block');
      })
    };
  });
  check('左右对照逐块同一行对齐，状态标签紧跟句尾而非独占行', paired.rows >= 2 && paired.aligned && paired.inline, JSON.stringify(paired));
  const rewriteOverflow = await page.evaluate(() => {
    const rows = document.querySelector('.tn-rewrite-rows');
    return { scrollWidth: rows?.scrollWidth || 0, clientWidth: rows?.clientWidth || 0 };
  });
  check('左右对照无横向裁切', rewriteOverflow.scrollWidth <= rewriteOverflow.clientWidth + 1, JSON.stringify(rewriteOverflow));
  await page.locator('[data-test=rewrite-block]').first().fill('E2E 改写首段');
  await page.fill('[data-test=rewrite-name]', 'E2E定向简历');
  await page.click('[data-test=rewrite-confirm]');
  await page.waitForSelector('[data-test=rewrite-success]', { timeout: 20000 });
  const success = page.locator('[data-test=rewrite-success]');
  const href = await success.locator('a[data-test=rewrite-download]').getAttribute('href');
  check('确认后生成 Word 下载链接并保存新版本', Boolean(href?.includes('/export.docx')));
  const word = await fetch(`${server.base}${href}`, { headers: { Cookie: cookie } });
  const wordBytes = Buffer.from(await word.arrayBuffer());
  check('下载 Word 是合法 OOXML ZIP', word.status === 200 && wordBytes.subarray(0, 2).toString('latin1') === 'PK' && wordBytes.includes(Buffer.from('word/document.xml')));
  await page.screenshot({ path: path.join(OUT, 'resume-rewrite-workbench.png'), fullPage: true });

  await page.goto(`${server.base}/?panel=career&section=match`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-test=career-profile-card]', { timeout: 15000 });
  check('匹配分析页展示已确认画像卡与编辑入口', (await page.locator('[data-test=career-profile-card]').innerText()).includes('已确认画像')
    && (await page.locator('[data-test=profile-edit]').count()) === 1);
  await page.screenshot({ path: path.join(OUT, 'career-profile-card.png'), fullPage: true });

  await page.click('[data-test=nav-assistant]');
  await page.waitForSelector('[data-test=assistant-drawer]', { timeout: 15000 });
  await page.waitForSelector('[data-test=assistant-drawer] [data-test=assistant-input]', { timeout: 15000 });
  check('AI 助手可从任意页面以右侧 Drawer 打开且不切走主页面',
    (await page.textContent('[data-test=page-title]')).trim() === '匹配分析'
      && (await page.locator('[data-test=assistant-drawer] [data-test=assistant-view]').count()) === 1);
  await page.click('[data-test=assistant-drawer-wide]');
  check('AI 助手 Drawer 支持宽屏切换', (await page.locator('[data-test=assistant-drawer].wide').count()) === 1);
  await page.click('[data-test=assistant-drawer-close]');
  check('AI 助手 Drawer 可关闭', (await page.locator('[data-test=assistant-drawer]').isHidden()));

  const draftStart = await server.request('/api/v1/resumes/rewrite/drafts', {
    method: 'POST', cookie, body: { resume_id: resumeBody.json.data.id, application_id: app1.id, requirements: '全局任务条测试' }
  });
  check('全局任务测试草稿创建成功', draftStart.status === 201, draftStart.text);
  let taskDraft = draftStart.json.data;
  const taskDeadline = Date.now() + 15000;
  while (Date.now() < taskDeadline) {
    const poll = await server.request(`/api/v1/resumes/rewrite/drafts/${encodeURIComponent(taskDraft.id)}`, { cookie });
    taskDraft = poll.json?.data || taskDraft;
    if (Number(taskDraft.progress_percent) >= 100) break;
    await page.waitForTimeout(150);
  }
  const db = new DatabaseSync(path.join(server.dir, 'tounar.sqlite'));
  try {
    db.prepare("UPDATE resume_rewrite_drafts SET progress_percent=40, progress_label='测试恢复中', updated_at=? WHERE id=?").run(new Date().toISOString(), taskDraft.id);
  } finally { db.close(); }
  await page.waitForSelector('[data-test=task-tray]', { timeout: 10000 });
  check('切换页面后全局任务胶囊恢复运行中的改写', (await page.locator('[data-test=task-tray]').innerText()).includes('正在改写简历'));
  await page.click('[data-test=task-tray-minimize]');
  check('任务胶囊可最小化并展开', (await page.locator('[data-test=task-tray-expand]').count()) === 1);
  await page.click('[data-test=task-tray-expand]');
  const db2 = new DatabaseSync(path.join(server.dir, 'tounar.sqlite'));
  try {
    db2.prepare("UPDATE resume_rewrite_drafts SET progress_percent=100, progress_label='生成完成！', updated_at=? WHERE id=?").run(new Date().toISOString(), taskDraft.id);
  } finally { db2.close(); }
  await page.waitForSelector('[data-test=task-toast]', { timeout: 12000 });
  check('后台任务完成后弹出可点击的全局通知', (await page.locator('[data-test=task-toast]').innerText()).includes('简历改写已完成'));

  console.log(JSON.stringify({ passed: checks.length, failed: 0, report: path.join(OUT, 'agent-e2e-report.json') }));
  fs.writeFileSync(path.join(OUT, 'agent-e2e-report.json'), JSON.stringify({ checks, app1: app1.id, app2: app2.id, viewed: viewed.id, resume: resumeBody.json.data.id, generated_at: new Date().toISOString() }, null, 2));
} catch (error) {
  console.error(error?.stack || error);
  fs.writeFileSync(path.join(OUT, 'agent-e2e-failure.json'), JSON.stringify({ checks, error: String(error?.stack || error) }, null, 2));
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
}
