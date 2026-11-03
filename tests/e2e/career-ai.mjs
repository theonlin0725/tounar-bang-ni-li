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
    } else {
      const input = JSON.parse(user);
      answer = {
        summary: '优先投递数据产品方向的未投递岗位。',
        recommendations: input.jobs.slice(0, 1).map((j) => ({
          application_id: j.application_id, rank: 1, match_level: 'high',
          reasons: ['技能交叉'], strengths: ['SQL 与用户研究'], gaps: ['行业经验待补'], next_step: '先补行业研究'
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
      jd_text: '岗位职责\n负责用户访谈、问卷设计、数据分析与研究报告撰写，持续跟踪核心指标并输出洞察，与产品、设计和研发协作。\n任职要求\n熟悉 SQL 与用户研究方法，具备跨团队沟通能力。',
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
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-test=ledger-row]');
  await page.locator(`[data-test=select-app][data-select-app-id="${applied.json.data.id}"]`).check();
  await page.click('[data-test=tab-viewed]');
  await page.waitForSelector(`[data-test=ledger-row][data-app-id="${pending.application_id}"]`);
  await page.locator(`[data-test=select-app][data-select-app-id="${pending.application_id}"]`).check();
  const compareBarText = await page.locator('[data-test=compare-bar]').innerText();
  check('跨投递明细/看过没投勾选，对比栏保留两个岗位名称',
    compareBarText.includes('星河科技') && compareBarText.includes('青禾网络'), compareBarText.replace(/\s+/g, ' '));
  await page.click('[data-test=compare-open]');
  await page.waitForSelector('[data-test=career-view]');
  check('对比入口跳转到现有 AI 页面并带入两个岗位', (await page.locator('[data-test=compare-section]').innerText()).includes('星河科技')
    && (await page.locator('[data-test=compare-section]').innerText()).includes('青禾网络'));

  await page.setInputFiles('[data-test=resume-file]', resumeFile);
  await page.click('[data-test=resume-upload]');
  try {
    await page.waitForFunction(() => document.querySelector('[data-test=resume-section]')?.innerText.includes('分析失败'), null, { timeout: 15000 });
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
  check('重试后简历画像展示技能、经历和原文证据', resumeTextUi.includes('SQL') && resumeTextUi.includes('星河科技') && resumeTextUi.includes('原文：'));
  check('简历状态切换为画像已就绪', resumeTextUi.includes('画像已就绪'), resumeTextUi.slice(0, 220));
  check('分析调用只发送服务端配置，前端没有模型密钥', fakeCalls.every((c) => c.authorization === 'Bearer test-key'));

  await page.click('[data-test=compare-run]');
  await page.waitForSelector('[data-test=compare-report]', { timeout: 20000 });
  const compareText = await page.locator('[data-test=compare-report]').innerText();
  check('岗位对比报告包含两个岗位、已投递标识与差异', compareText.includes('星河科技')
    && compareText.includes('青禾网络') && compareText.includes('已投递') && compareText.includes('主要差异'));

  await page.click('[data-test=recommend-run]');
  await page.waitForSelector('[data-test=recommend-report]', { timeout: 20000 });
  const recommendText = await page.locator('[data-test=recommend-report]').innerText();
  check('推荐只出现未投递岗位，并单独标记无 JD 候选', recommendText.includes('青禾网络')
    && recommendText.includes('列表公司') && recommendText.includes('未纳入确定推荐'));
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
