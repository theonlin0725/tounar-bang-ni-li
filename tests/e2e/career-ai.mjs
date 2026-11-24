/* 简历/AI 前端验收：真实上传 -> 真实后端 -> 本地假模型（明确不是外部模型联调）。 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { startTestServer, strongViewEvent } from '../../server/test/helpers.js';
import { resolveChromiumExecutable } from './browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const out = path.join(ROOT, '.tmp', 'career-ai');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const resumeText = `张明\n数据产品实习生\n熟悉 SQL、Python 与用户研究。\n2026 年在星河科技担任数据产品实习生，负责指标体系和用户研究，推动留存提升。\n优势：跨团队沟通与需求分析。`;
const resumeFile = path.join(out, 'resume.txt');
fs.writeFileSync(resumeFile, resumeText);
const checks = [];
let failed = 0;
function check(name, ok, detail = '') {
  const pass = Boolean(ok);
  if (!pass) failed++;
  checks.push({ name, ok: pass, detail: String(detail || '') });
  console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

let fake, fakePort, server, browser, context, page;
let failAnalyze = true;
const fakeCalls = [];
try {
  fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || '{}');
    const system = payload.messages?.[0]?.content || '';
    const user = payload.messages?.[1]?.content || '';
    fakeCalls.push({ system, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (failAnalyze && system.includes('简历结构化助手')) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: 'fake analyze failure' } }));
      return;
    }
    let answer;
    if (system.includes('简历结构化助手')) {
      answer = {
        summary: '数据产品方向实习生，具备 SQL、用户研究和跨团队沟通经验。',
        skills: [{ name: 'SQL', evidence: '熟悉 SQL' }, { name: '用户研究', evidence: '用户研究' }],
        experiences: [{ organization: '星河科技', role: '数据产品实习生', period: '2026', highlights: ['指标体系', '用户研究'], evidence: '2026 年在星河科技担任数据产品实习生' }],
        industries: [{ name: '数据产品', evidence: '数据产品实习生' }],
        strengths: [{ point: '跨团队沟通', evidence: '跨团队沟通与需求分析' }],
        constraints: []
      };
    } else if (system.includes('岗位比较助手')) {
      const input = JSON.parse(user);
      answer = {
        overview: '两个岗位都与数据产品相关，第一个更贴近简历。',
        jobs: input.jobs.map((j) => ({
          application_id: j.application_id, match_level: 'medium',
          strengths: ['SQL 与用户研究可迁移'], gaps: ['行业深度待补'],
          evidence: [{ resume_evidence: '熟悉 SQL', jd_evidence: '数据分析' }],
          next_step: '补充行业案例'
        })),
        differences: ['岗位职责侧重点不同'],
        ranking: input.jobs.map((j, i) => ({ application_id: j.application_id, rank: i + 1, reason: '相对匹配' })),
        limitations: ['仅基于现有 JD']
      };
    } else if (system.includes('单岗位求职匹配分析助手')) {
      answer = {
        ability: { conclusion: '部分匹配', summary: '用户研究有证据，Tableau 尚未体现在简历里。', basis: '简历有用户研究，JD 要求数据分析。' },
        priority: { conclusion: '适合投', summary: '能力可迁移，但城市偏好未确认。', basis: '岗位地点上海，简历未写偏好。' },
        overall_advice: '先补充 Tableau 项目证据，再确认地点偏好。',
        hard_gates: [
          { requirement: '本科及以上学历', jd_evidence: '本科及以上学历', user_info: '简历未写学历', resume_evidence: '', result: '信息不足', basis: '简历没有学历信息。', blocking: false }
        ],
        dimensions: [
          { key: 'hard_gate', requirement: '学历', user_evidence: '未写', conclusion: '无法判断', strengths: [], gaps: ['学历信息不足'], evidence: [], next_step: '补充学历信息' },
          { key: 'skills', requirement: '数据分析与用户研究', user_evidence: '熟悉 SQL 与用户研究', conclusion: '部分匹配', strengths: ['用户研究有原文证据'], gaps: ['未发现 Tableau 的实际使用案例'], evidence: [{ source: 'resume', quote: '熟悉 SQL' }, { source: 'jd', quote: '数据分析' }], next_step: '补充 Tableau 项目' },
          { key: 'experience', requirement: '数据产品项目', user_evidence: '数据产品实习', conclusion: '部分匹配', strengths: ['有实习经历'], gaps: [], evidence: [{ source: 'resume', quote: '数据产品实习生' }], next_step: '补充项目范围' },
          { key: 'industry', requirement: '用户研究', user_evidence: '用户研究', conclusion: '匹配', strengths: ['用户研究可迁移'], gaps: [], evidence: [{ source: 'resume', quote: '用户研究' }], next_step: '补充行业背景' },
          { key: 'preference', requirement: '上海', user_evidence: '未写城市偏好', conclusion: '无法判断', strengths: [], gaps: ['地点偏好待确认'], evidence: [], next_step: '确认地点' },
          { key: 'achievements', requirement: '核心指标', user_evidence: '推动留存提升', conclusion: '部分匹配', strengths: ['有留存结果'], gaps: [], evidence: [{ source: 'resume', quote: '推动留存提升' }, { source: 'jd', quote: '核心指标' }], next_step: '补充指标口径' }
        ],
        limitations: ['简历没有学历信息']
      };
    } else if (system.includes('面试准备助手')) {
      answer = { questions: [{ question: '你如何用用户研究推动留存？', basis: '简历：推动留存提升', dimension: 'skills' }] };
    } else {
      const input = JSON.parse(user);
      answer = {
        summary: '优先投递数据产品方向的未投递岗位。',
        recommendations: input.jobs.slice(0, 1).map((j) => ({
          application_id: j.application_id, rank: 1, match_level: 'high',
          reasons: ['技能交叉', '地点匹配', '成长空间'], strengths: ['SQL 与用户研究', '数据分析', '项目复盘'], gaps: ['行业经验待补', '正式年限', '作品集'], next_step: '先补行业研究'
        })),
        limitations: ['未访问外部招聘网站']
      };
    }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  fakePort = fake.address().port;
  server = await startTestServer({
    name: 'career-ai-web',
    env: {
      AI_API_URL: `http://127.0.0.1:${fakePort}/v1`,
      AI_API_KEY: 'test-key', AI_MODEL: 'fake-model', AI_PROVIDER: 'openai_compatible',
      AI_LLM_TIMEOUT_MS: '5000', CLOUD_LLM_ENABLED: 'false'
    }
  });
  const login = await server.login('demo@tounar.local');
  const cookieValue = login.cookie.split('=').slice(1).join('=');
  const device = await server.pairDevice(login.cookie, 'AI Web 设备');
  const applied = await server.request('/api/v1/applications/manual', {
    method: 'POST', cookie: login.cookie, headers: { 'Idempotency-Key': 'career-web-applied' },
    body: {
      company_name: '星河科技', job_title: '数据产品实习生', has_applied: true, status: 'applied',
      applied_date: '2026-10-01', jd_summary: '数据分析、用户研究、SQL',
      job_url: 'https://jobs.example.com/career-web/applied'
    }
  });
  const pendingBatch = await server.eventBatch(device.device_token, [strongViewEvent({
    event_type: 'job_viewed',
    payload: {
      company_name: '青禾网络', job_title: '用户研究实习生', site_job_id: 'career-web-pending',
      job_url: 'https://jobs.example.com/career-web/pending', location: '上海',
      jd_text: '岗位职责\n负责用户访谈、问卷设计、数据分析与研究报告撰写，持续跟踪核心指标并输出洞察，与产品、设计和研发协作。\n任职要求\n本科及以上学历；上海线下办公。熟悉 SQL 与用户研究方法，具备跨团队沟通能力。',
      jd_summary: '用户访谈、问卷设计、数据分析'
    }
  })]);
  const pending = pendingBatch.json.results[0];
  const noJdBatch = await server.eventBatch(device.device_token, [strongViewEvent({
    event_type: 'job_discovered',
    payload: {
      company_name: '列表公司', job_title: '列表采到的岗位', site_job_id: 'career-web-no-jd',
      job_url: 'https://jobs.example.com/career-web/no-jd', jd_status: 'missing'
    }
  })]);
  const noJd = noJdBatch.json.results[0];
  check('准备真实已投递/未投递/无 JD 岗位', applied.status === 201 && !!pending.application_id && !!noJd.application_id,
    `applied=${applied.status} pending=${!!pending.application_id} noJd=${!!noJd.application_id}`);

  const resolved = await resolveChromiumExecutable();
  browser = await chromium.launch({ executablePath: resolved?.path, headless: true });
  context = await browser.newContext({ baseURL: server.base, viewport: { width: 1280, height: 1000 } });
  await context.addCookies([{ name: 'tounar_session', value: cookieValue, url: server.base }]);
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?panel=career&section=resume', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-test=resume-section]');
  check('简历库首屏无旧页首说明与返回台账，主操作在上', !(await page.locator('[data-test=resume-section]').innerText()).includes('返回台账')
    && !(await page.locator('[data-test=resume-section]').innerText()).includes('1. 简历'));
  await page.setInputFiles('[data-test=resume-file]', resumeFile);
  try {
    await page.waitForFunction(() => document.querySelector('[data-test=resume-section]')?.innerText.includes('AI 服务暂时不可用'), null, { timeout: 15000 });
  } catch (e) {
    console.log('DEBUG resume section', (await page.locator('[data-test=resume-section]').innerText()).slice(0, 1200));
    console.log('DEBUG toasts', await page.locator('.tn-toast').allTextContents());
    throw e;
  }
  check('简历分析失败时显示失败状态，原台账仍可用', (await page.locator('[data-test=resume-section]').innerText()).includes('AI 服务暂时不可用'));
  failAnalyze = false;
  await page.click('[data-test=resume-analyze]');
  await page.waitForSelector('[data-test=resume-profile]', { timeout: 20000 });
  const resumeTextUi = await page.locator('[data-test=resume-section]').innerText();
  check('重试后简历画像展示技能与经历摘要', resumeTextUi.includes('SQL') && resumeTextUi.includes('星河科技'));
  check('简历状态切换为画像已就绪', resumeTextUi.includes('画像已就绪'), resumeTextUi.slice(0, 220));
  check('分析调用只发送服务端配置，前端没有模型密钥', fakeCalls.every((c) => c.authorization === 'Bearer test-key'));
  check('首屏画像只展示摘要，组内明细和原文默认收起',
    (await page.locator('[data-test=resume-profile-skills]').getAttribute('open')) === null
      && (await page.locator('[data-test=resume-profile-skills]').innerText()).includes('SQL'));
  const resumeCallsBeforeExpand = fakeCalls.filter((c) => c.system.includes('简历结构化助手')).length;
  await page.screenshot({ path: path.join(out, 'resume-collapsed.png'), fullPage: true });
  await page.locator('[data-test=resume-profile-skills] summary').click();
  check('展开画像组后才显示原文证据，不触发模型',
    (await page.locator('[data-test=resume-profile-skills]').innerText()).includes('原文：')
      && fakeCalls.filter((c) => c.system.includes('简历结构化助手')).length === resumeCallsBeforeExpand,
    'skill evidence');
  await page.screenshot({ path: path.join(out, 'resume-expanded.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(200);
  const resumeMobile = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  check('简历库手机单列无横向溢出', resumeMobile.scrollWidth <= resumeMobile.innerWidth + 1, JSON.stringify(resumeMobile));
  await page.screenshot({ path: path.join(out, 'resume-mobile-390.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  const firstResumeId = await page.locator('[data-test=resume-current]').getAttribute('data-resume-id');
  await page.setInputFiles('[data-test=resume-file]', resumeFile);
  await page.waitForFunction(() => document.querySelector('[data-test=resume-current]')?.innerText.includes('画像已就绪')
    && document.querySelectorAll('[data-test=resume-version-row]').length >= 1, null, { timeout: 20000 });
  const secondResumeId = await page.locator('[data-test=resume-current]').getAttribute('data-resume-id');
  check('同名文件连续上传形成独立版本，当前版本为最近创建项',
    !!firstResumeId && !!secondResumeId && firstResumeId !== secondResumeId,
    `${firstResumeId} -> ${secondResumeId}`);
  await page.locator(`[data-test=resume-version-row][data-resume-id="${firstResumeId}"] [data-test=resume-version-view]`).click();
  await page.waitForSelector('[data-test=resume-preview]');
  await page.waitForFunction(() => document.querySelector('[data-test=resume-preview]')?.innerText.includes('星河科技'), null, { timeout: 10000 });
  const previewText = await page.locator('[data-test=resume-preview]').innerText();
  const previewCurrentId = await page.locator('[data-test=resume-current]').getAttribute('data-resume-id');
  check('预览旧版本不改变当前版本，预览显示完整文本',
    previewText.includes('预览版本')
      && previewText.includes('星河科技')
      && previewCurrentId === secondResumeId,
    `preview=${previewText.slice(0, 120)} current=${previewCurrentId} expected=${secondResumeId}`);
  await page.locator('[data-test=resume-preview] [data-test=resume-preview-current]').click();
  await page.waitForFunction((id) => document.querySelector('[data-test=resume-current]')?.getAttribute('data-resume-id') === id, firstResumeId);
  check('历史版本设为当前后唯一当前切换，预览不写入内容',
    (await page.locator('[data-test=resume-current]').getAttribute('data-resume-id')) === firstResumeId);
  await page.locator(`[data-test=resume-version-row][data-resume-id="${secondResumeId}"] [data-test=resume-version-current]`).click();
  await page.waitForFunction((id) => document.querySelector('[data-test=resume-current]')?.getAttribute('data-resume-id') === id, secondResumeId);
  check('切换回最近版本后匹配仍使用当前版本', (await page.locator('[data-test=resume-current]').getAttribute('data-resume-id')) === secondResumeId);

  await page.goto(`/?panel=career&section=match&app=${encodeURIComponent(pending.application_id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-test=recommend-run]', { timeout: 20000 });
  check('推荐卡片更名并支持选择简历', (await page.locator('[data-test=recommend-section]').innerText()).includes('「看过没投」岗位推荐')
    && (await page.locator('[data-test=recommend-resume-change]').count()) === 1);
  await page.click('[data-test=recommend-resume-change]');
  await page.waitForSelector('[data-test=recommend-resume-picker]');
  await page.locator('[data-test=recommend-resume-confirm]').click();
  await page.click('[data-test=recommend-run]');
  await page.waitForSelector('[data-test=recommend-report]', { timeout: 20000 });
  const recommendText = await page.locator('[data-test=recommend-report]').innerText();
  check('推荐只出现未投递岗位，并单独标记无 JD 候选', recommendText.includes('青禾网络')
    && recommendText.includes('列表公司') && recommendText.includes('未纳入确定推荐'));
  const recommendCards = page.locator('[data-test=recommend-job]').first().locator('.tn-recommend-card');
  check('推荐卡分推荐理由、匹配优势、主要缺口三块', (await recommendCards.count()) === 3
    && (await recommendCards.nth(0).innerText()).includes('推荐理由')
    && (await recommendCards.nth(1).innerText()).includes('匹配优势')
    && (await recommendCards.nth(2).innerText()).includes('主要缺口'));
  const firstRecommendJob = page.locator('[data-test=recommend-job]').first();
  check('推荐卡先列两条，更多内容可展开', (await firstRecommendJob.locator('[data-test=recommend-more]').count()) === 3);
  await firstRecommendJob.locator('[data-test=recommend-more]').first().click();
  check('推荐卡展开其余条目后不丢失排名和岗位链接', (await firstRecommendJob.innerText()).includes('成长空间')
    && (await firstRecommendJob.locator('a').count()) >= 1);

  /* 侧栏与单岗位匹配：真实按钮 -> 真实 API -> 本地假模型 */
  await page.goto(`/?panel=career&app=${encodeURIComponent(pending.application_id)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-test=match-section]');
  check('侧栏一级入口、唯一设置入口和账号邮箱可见，匹配分析为当前页', (await page.locator('[data-test=nav-ledger]').count()) === 1
    && (await page.locator('[data-test=nav-reviews]').count()) === 1
    && (await page.locator('[data-test=nav-settings]').count()) === 1
    && (await page.locator('[data-test=open-settings-reminder]').count()) === 0
    && (await page.locator('[data-test=download-plugin]').count()) === 0
    && (await page.locator('[data-test=nav-match].active').count()) === 1
    && (await page.textContent('[data-test=header-email]')).trim() === 'demo@tounar.local');
  await page.waitForSelector('[data-test=match-current-job]');
  const currentJobText = await page.locator('[data-test=match-current-job]').innerText();
  check('岗位详情带入的单岗位默认选中', currentJobText.includes('青禾网络') && currentJobText.includes('用户研究实习生'), currentJobText);
  check('打开匹配页不自动触发模型请求', fakeCalls.filter((c) => c.system.includes('单岗位求职匹配分析助手')).length === 0);

  await page.click('[data-test=match-run]');
  await page.waitForSelector('[data-test=match-report]', { timeout: 20000 });
  const matchText = await page.locator('[data-test=match-report]').innerText();
  check('单岗位报告显示能力匹配度、投递优先级和总体建议',
    matchText.includes('能力匹配度') && matchText.includes('投递优先级') && matchText.includes('总体建议'));
  check('单岗位报告首屏只有两张结论卡，六维默认收起',
    (await page.locator('[data-test^=match-dimension-][data-dimension]').count()) === 6
      && (await page.locator('[data-test^=match-dimension-detail-]').evaluateAll((nodes) => nodes.every((n) => n.hidden))) === true
      && (await page.locator('.tn-match-core-summary').count()) === 0);
  check('优势与差距按技能/工具/经历/项目分组，首屏组头收起',
    (await page.locator('[data-test^=match-summary-]').count()) >= 4
      && (await page.locator('[data-test=match-summary-skill]').getAttribute('open')) === null
      && (await page.locator('[data-test=match-summary-tool]').getAttribute('open')) === null);
  await page.click('[data-test=match-summary-tool] summary');
  check('展开一组才显示状态分组与逐条依据', (await page.locator('[data-test=match-summary-tool]').innerText()).includes('优势')
    && (await page.locator('[data-test=match-summary-tool]').innerText()).includes('待补证'));
  await page.click('[data-test=match-dim-toggle-hard_gate]');
  check('门槛表只在硬性门槛卡片展开后出现', (await page.locator('[data-test=match-gates]').count()) === 1
    && (await page.locator('[data-test=match-dimension-detail-hard_gate]').isVisible()));
  await page.click('[data-test=match-dim-toggle-skills]');
  check('一次只展开一项，技能详情显示原文来源和下一步行动',
    (await page.locator('[data-test=match-dimension-detail-skills]').isVisible())
      && (await page.locator('[data-test=match-dimension-detail-hard_gate]').isHidden())
      && (await page.locator('[data-test=match-dimension-detail-skills]').innerText()).includes('查看原文与来源')
      && matchText.includes('优化当前岗位简历') && matchText.includes('生成面试问题'));
  await page.screenshot({ path: path.join(out, 'match-expanded-1280.png'), fullPage: true });
  const firstReportId = await page.locator('[data-test=match-report]').getAttribute('data-report-id');
  await page.click('[data-test=match-resume-opt]');
  await page.waitForSelector('[data-test=match-resume-suggestion-card]');
  const suggestionText = await page.locator('[data-test=match-resume-suggestions-wrap]').innerText();
  check('简历优化逐条显示原简历段落、JD 要求和可编辑建议',
    suggestionText.includes('原简历段落') && suggestionText.includes('对应 JD 要求')
      && (await page.locator('[data-test=match-resume-suggestion]').count()) >= 1
      && (await page.locator('[data-test=match-resume-suggestion]').first().isEditable()));
  await page.click('[data-test=match-detail]');
  await page.waitForSelector('[data-test=detail-drawer]');
  check('查看岗位详情打开的是报告对应岗位，关闭后报告仍在',
    (await page.locator('[data-test=detail-company]').innerText()).includes('青禾网络'));
  await page.click('[data-test=detail-drawer] .tn-drawer-close');
  await page.waitForSelector('[data-test=detail-drawer]', { state: 'detached' });
  check('关闭详情后仍停留在原匹配报告', (await page.locator('[data-test=match-report]').count()) === 1);
  await page.click('[data-test=match-supplement]');
  await page.waitForSelector('[data-test=match-correction-modal]');
  await page.click('[data-test=match-correction-cancel]');
  await page.waitForSelector('[data-test=match-correction-modal]', { state: 'detached' });
  const cancelCheck = await server.request(`/api/v1/ai/reports/${encodeURIComponent(firstReportId)}/corrections`, { cookie: login.cookie });
  check('补充/纠错取消不落库', cancelCheck.status === 200 && cancelCheck.json.data.length === 0);
  const modelCallsBeforeReload = fakeCalls.filter((c) => c.system.includes('单岗位求职匹配分析助手')).length;
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-test=match-report]');
  check('刷新匹配页读取历史报告，不重复触发模型',
    fakeCalls.filter((c) => c.system.includes('单岗位求职匹配分析助手')).length === modelCallsBeforeReload
      && (await page.locator('[data-test=match-report]').getAttribute('data-report-id')) === firstReportId);
  await page.screenshot({ path: path.join(out, 'match-desktop-1280.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(250);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(out, 'match-desktop-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.waitForTimeout(250);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(out, 'match-tablet-1024.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.waitForTimeout(250);

  await page.click('[data-test=match-dim-toggle-skills]');
  await page.locator('[data-dimension=skills] [data-test=match-correct]').click();
  await page.waitForSelector('[data-test=match-correction-modal]');
  const correctionText = await page.locator('[data-test=match-correction-modal]').innerText();
  check('纠错弹窗先展示原判断、补充、写入字段和适用范围',
    correctionText.includes('原判断') && correctionText.includes('用户确认补充') && correctionText.includes('适用范围'));
  await page.fill('[data-test=match-correction-text]', '我使用 Tableau 完成过一个商业分析 Dashboard');
  await page.click('[data-test=match-correction-save]');
  await page.waitForSelector('[data-test=match-correction-modal]', { state: 'detached' });
  await page.waitForSelector('[data-test=match-corrections]');
  check('确认后保存为用户确认补充并显示适用范围', (await page.locator('[data-test=match-corrections]').innerText()).includes('Tableau'));
  const correctionsApi = await server.request(`/api/v1/ai/reports/${encodeURIComponent(firstReportId)}/corrections`, { cookie: login.cookie });
  check('纠错真实落库且只保存一次', correctionsApi.status === 200 && correctionsApi.json.data.length === 1);

  await page.click('[data-test=match-rerun-action]');
  await page.waitForFunction((oldId) => document.querySelector('[data-test=match-report]')?.getAttribute('data-report-id') !== oldId, firstReportId, { timeout: 20000 });
  const secondReportId = await page.locator('[data-test=match-report]').getAttribute('data-report-id');
  await page.click('[data-test=match-history-toggle]');
  const historyCount = await page.locator('[data-test=match-history-item]').count();
  check('重跑生成新报告，历史入口在岗位行且列表可展开', secondReportId && secondReportId !== firstReportId && historyCount >= 2,
    `history=${historyCount}`);

  await page.route(`**/api/v1/ai/reports/${encodeURIComponent(firstReportId)}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 650));
    await route.continue();
  });
  await page.locator(`[data-test=match-history-item][data-report-id="${firstReportId}"]`).click();
  await page.locator(`[data-test=match-history-item][data-report-id="${secondReportId}"]`).click();
  await page.waitForTimeout(900);
  check('同岗位历史报告先点 A 后点 B，较早请求不能覆盖 B',
    (await page.locator('[data-test=match-report]').getAttribute('data-report-id')) === secondReportId);
  await page.unroute(`**/api/v1/ai/reports/${encodeURIComponent(firstReportId)}`);

  await page.click('[data-test=match-interview]');
  await page.waitForSelector('[data-test=match-interview-questions]', { timeout: 20000 });
  check('面试问题在当前报告内生成并显示依据', (await page.locator('[data-test=match-interview-questions]').innerText()).includes('依据：'));

  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(150);
  check('移动端关闭态侧栏不可键盘访问', await page.locator('#tn-sidebar').evaluate((el) => el.inert) === true);
  await page.click('[data-test=sidebar-open]');
  await page.waitForTimeout(300);
  check('移动端菜单按钮打开可关闭侧栏', await page.locator('.tn-shell.nav-open').count() === 1);
  check('移动端打开态隔离背景并把焦点移入侧栏', await page.locator('.tn-workspace').evaluate((el) => el.inert) === true
    && await page.evaluate(() => document.querySelector('#tn-sidebar')?.contains(document.activeElement)) === true);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  check('移动端 Tab/Shift+Tab 不逃出抽屉', await page.evaluate(() => document.querySelector('#tn-sidebar')?.contains(document.activeElement)) === true);
  await page.screenshot({ path: path.join(out, 'match-mobile-390-nav.png'), fullPage: false });
  await page.keyboard.press('Escape');
  check('Esc 关闭侧栏、恢复背景并把焦点还给菜单按钮', await page.locator('.tn-shell.nav-open').count() === 0
    && await page.locator('#tn-sidebar').evaluate((el) => el.inert) === true
    && await page.locator('.tn-workspace').evaluate((el) => el.inert) === false
    && await page.evaluate(() => document.activeElement?.getAttribute('data-test')) === 'sidebar-open');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'match-mobile-390-report.png'), fullPage: true });
  await page.click('[data-test=match-dim-toggle-hard_gate]');
  await page.screenshot({ path: path.join(out, 'match-mobile-expanded-390.png'), fullPage: true });
  const mobileOverflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
    coreColumns: getComputedStyle(document.querySelector('.tn-match-core')).gridTemplateColumns.split(' ').length
  }));
  check('移动端无页面级横向溢出，能力/优先级与六维卡片单列',
    mobileOverflow.scrollWidth <= mobileOverflow.innerWidth + 1 && mobileOverflow.coreColumns === 1, JSON.stringify(mobileOverflow));
  await page.setViewportSize({ width: 1280, height: 1000 });
  const compareCallCount = () => fakeCalls.filter((c) => c.system.includes('岗位比较助手')).length;
  const compareBefore = compareCallCount();
  const compareIds = [applied.json.data.id, pending.application_id].map(encodeURIComponent).join(',');
  await page.goto(`/?panel=career&apps=${compareIds}&autorun=compare`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-test=match-section]');
  check('旧对比深链安全落到单岗选岗页，零模型调用、零对比区',
    compareCallCount() === compareBefore
      && (await page.locator('[data-test=compare-section]').count()) === 0
      && !page.url().includes('apps=') && !page.url().includes('autorun='));
  await page.goto('/?panel=career&section=resume', { waitUntil: 'networkidle' });
  check('简历库侧栏入口复用原简历上传与画像视图', (await page.locator('[data-test=nav-resume].active').count()) === 1
    && (await page.locator('[data-test=page-title]').innerText()).includes('简历库')
    && (await page.locator('[data-test=resume-section]').count()) === 1);

  for (let i = 0; i < 101; i += 1) {
    const bulk = await server.request('/api/v1/applications/manual', {
      method: 'POST', cookie: login.cookie,
      headers: { 'Idempotency-Key': `career-bulk-${i}` },
      body: {
        company_name: `批量公司${String(i).padStart(3, '0')}`,
        job_title: '数据产品经理',
        has_applied: true, status: 'applied', applied_date: '2026-10-01',
        jd_summary: '负责数据分析和用户研究。',
        job_url: `https://jobs.example.com/career-bulk/${i}`
      }
    });
    if (bulk.status !== 201) throw new Error(`bulk seed ${i}: ${bulk.status} ${bulk.text.slice(0, 120)}`);
  }
  await page.goto('/?panel=career&section=match', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-test=match-choose-job]');
  await page.click('[data-test=match-choose-job]');
  await page.waitForSelector('[data-test=job-picker-modal]');
  await page.click('[data-test=job-picker-applied]');
  await page.fill('[data-test=job-picker-search]', '批量公司100');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-test=job-picker-option]')].some((o) => o.textContent.includes('批量公司100')), null, { timeout: 20000 });
  const bulkOption = page.locator('[data-test=job-picker-option]', { hasText: '批量公司100' }).first();
  const bulkText = await bulkOption.innerText();
  check('两级岗位弹窗搜索到第一页之外的台账岗位', bulkText.includes('批量公司100'));
  await bulkOption.click();
  await page.waitForTimeout(300);
  const bulkCurrent = await page.locator('[data-test=match-current-job]').innerText();
  check('弹窗选中岗位回填单岗位匹配分析', bulkCurrent.includes('批量公司100'), bulkCurrent);
  const modelCallsBeforeBulk = fakeCalls.filter((c) => c.system.includes('单岗位求职匹配分析助手')).length;
  await page.waitForTimeout(300);
  check('选择搜索结果不自动触发模型', fakeCalls.filter((c) => c.system.includes('单岗位求职匹配分析助手')).length === modelCallsBeforeBulk);

  for (let i = 0; i < 22; i += 1) {
    const res = await server.request('/api/v1/resumes/text', {
      method: 'POST', cookie: login.cookie,
      body: { text: `批量版本 ${i}\n熟悉 SQL 与用户研究。` + ' 数据分析经历。'.repeat(60), filename: `批量同名简历.txt` }
    });
    if (res.status !== 201) throw new Error(`resume seed ${i}: ${res.status}`);
  }
  await page.goto('/?panel=career&section=resume', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-test=resume-history]');
  const firstVersionPage = await page.locator('[data-test=resume-version-row]').count();
  await page.waitForSelector('[data-test=resume-history-more]');
  await page.click('[data-test=resume-history-more]');
  await page.waitForFunction((before) => document.querySelectorAll('[data-test=resume-version-row]').length > before, firstVersionPage, { timeout: 10000 });
  const secondVersionPage = await page.locator('[data-test=resume-version-row]').count();
  check('简历历史超过 20 份仍可分页找回同名版本', firstVersionPage === 19 && secondVersionPage >= 23,
    `first=${firstVersionPage} second=${secondVersionPage}`);
  check('AI 分析没有改变岗位状态', (await server.request(`/api/v1/applications/${pending.application_id}`, { cookie: login.cookie })).json.data.status === 'pending');
  check('页面无未捕获异常', errors.length === 0, errors.join('; '));
  await page.screenshot({ path: path.join(out, 'career-ai.png'), fullPage: true });
} catch (err) {
  failed++;
  checks.push({ name: '执行', ok: false, detail: err.stack || String(err) });
  console.error(err);
} finally {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ checks, failed, fake_calls: fakeCalls.length }, null, 2));
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  await new Promise((resolve) => fake?.close(resolve));
}
console.log(failed ? `CAREER-AI：${checks.length - failed}/${checks.length} 通过，${failed} 失败` : `CAREER-AI：${checks.length}/${checks.length} 通过`);
process.exitCode = failed ? 1 : 0;
