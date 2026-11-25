/* 官网首页真实产品截图采集脚本。
 *
 * 使用隔离 SQLite / 本地 outbox 启动真实后端，写入一套脱敏演示数据后，
 * 用 Playwright（2x Retina）截取台账、待确认、简历改写、邮件时间线与 AI 助手，
 * 输出到 web/assets/img/home/*.webp。
 *
 * 运行：node tools/capture-home-screenshots.mjs
 * 需要本机已安装 cwebp（macOS: brew install webp）。
 * 不会读取或写入 data/ 下的真实业务库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { startTestServer } from '../server/test/helpers.js';
import { resolveChromiumExecutable } from '../tests/e2e/browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'web', 'assets', 'img', 'home');
const TMP_DIR = path.join(ROOT, '.tmp', 'home-shots');
const EMAIL = 'alex@example.com';
const VIEWPORT = { width: 1280, height: 800 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isoDaysAgo = (days, hour = 3) => {
  const d = new Date(Date.now() - days * 86400000);
  d.setUTCHours(hour, 20, 0, 0);
  return d.toISOString();
};

function appPayload({ company, title, status, appliedDays, location, batch, jdSummary, url, roundLabel = null }) {
  return {
    company_name: company,
    job_title: title,
    has_applied: true,
    status,
    applied_at: isoDaysAgo(appliedDays),
    location,
    recruitment_batch: batch,
    channel: '公司官网',
    jd_summary: jdSummary,
    job_url: url,
    round_label: roundLabel,
    interview_round: roundLabel ? 2 : null
  };
}

async function manualApplication(server, cookie, body, key) {
  const response = await server.request('/api/v1/applications/manual', {
    method: 'POST', cookie,
    headers: { 'Idempotency-Key': `home-shot-${key}` },
    body
  });
  if (response.status !== 201) throw new Error(`创建演示岗位失败：${response.status} ${response.text}`);
  return response.json.data;
}

function weakSubmission({ company, title, url, batch, location, jd, tag }) {
  const now = new Date().toISOString();
  return {
    client_event_id: `evt_home_${tag}_${Date.now()}`,
    event_type: 'application_submitted',
    source_method: 'plugin',
    site_key: 'generic',
    adapter_version: '1.0.0',
    schema_version: 'C1',
    occurred_at: isoDaysAgo(1),
    observed_at: now,
    evidence_level: 'weak',
    evidence_code: 'success-text-visible-unconfirmed',
    payload: {
      company_name: company,
      job_title: title,
      recruitment_batch: batch,
      location,
      job_url: url,
      jd_text: jd
    }
  };
}

function waitForDraft(server, cookie, draftId) {
  return (async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const response = await server.request(`/api/v1/resumes/rewrite/drafts/${encodeURIComponent(draftId)}`, { cookie });
      if (response.status === 200 && response.json?.data?.status === 'ready' && response.json.data.progress_percent >= 100) return response.json.data;
      await sleep(300);
    }
    throw new Error('简历改写草稿生成超时');
  })();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const server = await startTestServer({
    name: 'home-screenshots',
    env: {
      AGENT_FAKE_MODE: 'true',
      CLOUD_LLM_ENABLED: 'false',
      JD_AI_ENABLED: 'false',
      JD_VISION_ENABLED: 'false',
      ENABLE_SCHEDULER: '0',
      ALLOWED_EMAILS: EMAIL,
      ADMIN_EMAILS: EMAIL
    }
  });

  let browser = null;
  try {
    const login = await server.login(EMAIL);
    const cookie = login.cookie;
    const me = await server.request('/api/v1/me', { cookie });
    const ownerId = me.json.data.user.owner_id;

    /* ---------- 脱敏演示数据 ---------- */
    const apps = [];
    apps.push(await manualApplication(server, cookie, appPayload({
      company: '星河科技', title: 'AI 产品经理', status: 'applied', appliedDays: 8,
      location: '上海', batch: '2027 届秋招',
      jdSummary: '负责 AI 助手与知识库产品规划，要求 3 年以上产品经验，熟悉大模型应用与数据分析。',
      url: 'https://jobs.example.com/xinghe/ai-pm'
    }), 'xinghe'));
    apps.push(await manualApplication(server, cookie, appPayload({
      company: '明镜数科', title: '数据分析师', status: 'interview', appliedDays: 11,
      location: '上海', batch: '2027 届秋招', roundLabel: '二面中',
      jdSummary: '负责业务数据分析与指标体系搭建，要求熟练 SQL、Python，具备良好的业务沟通能力。',
      url: 'https://jobs.example.com/mingjing/data-analyst'
    }), 'mingjing'));
    apps.push(await manualApplication(server, cookie, appPayload({
      company: '云帆智造', title: '产品运营', status: 'applied', appliedDays: 9,
      location: '杭州', batch: '2026 社招',
      jdSummary: '负责 SaaS 产品增长运营与用户生命周期管理，关注留存、转化与内容运营。',
      url: 'https://jobs.example.com/yunfan/operations'
    }), 'yunfan'));
    apps.push(await manualApplication(server, cookie, appPayload({
      company: '远山网络', title: '用户增长', status: 'assessment', appliedDays: 5,
      location: '深圳', batch: '2027 届秋招', roundLabel: '笔试',
      jdSummary: '负责用户增长策略与活动设计，要求熟悉 A/B 测试、渠道投放和数据分析。',
      url: 'https://jobs.example.com/yuanshan/growth'
    }), 'yuanshan'));
    apps.push(await manualApplication(server, cookie, appPayload({
      company: '清风互动', title: '内容运营', status: 'offer', appliedDays: 15,
      location: '北京', batch: '2026 社招',
      jdSummary: '负责品牌内容策划与社区运营，要求有内容作品集和跨团队协作经验。',
      url: 'https://jobs.example.com/qingfeng/content'
    }), 'qingfeng'));

    const dbPath = path.join(server.dir, 'tounar.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 5000');

    // 给目标岗位补全完整 JD，供简历改写与详情页展示。
    const fullJd = `岗位职责
1. 负责 AI 助手、智能知识库与业务流程自动化产品的规划、设计与迭代；
2. 深入理解招聘、客服或企业服务场景，完成需求调研、竞品分析和产品方案；
3. 与算法、研发、设计团队协作，推动大模型能力在真实业务中落地；
4. 建立产品指标与反馈闭环，通过数据分析持续优化用户体验。

任职要求
1. 本科及以上学历，3 年以上产品经理经验，有 AI 产品落地案例优先；
2. 熟悉大模型应用、RAG、Prompt 设计与知识库产品；
3. 熟练使用 SQL / Excel 进行数据分析，能独立完成需求文档与验收；
4. 具备优秀的跨团队沟通能力和项目推进能力。`;
    db.prepare("UPDATE applications SET jd_text = ?, jd_status = 'complete' WHERE id = ?").run(fullJd, apps[0].id);

    // 让「待回看」与邮件推进时间线有真实的时间跨度。
    db.prepare(`UPDATE applications SET last_status_changed_at = ?, last_progress_at = ?, stage_received_at = ?, stage_anchor_at = ?, updated_at = ?, round_label = ? WHERE id = ?`)
      .run(isoDaysAgo(3), isoDaysAgo(3), isoDaysAgo(3), isoDaysAgo(3), isoDaysAgo(1), '二面中', apps[1].id);
    db.prepare(`UPDATE applications SET last_status_changed_at = ?, last_progress_at = ?, stage_received_at = ?, stage_anchor_at = ?, updated_at = ?, round_label = ? WHERE id = ?`)
      .run(isoDaysAgo(2), isoDaysAgo(2), isoDaysAgo(2), isoDaysAgo(2), isoDaysAgo(2), '笔试', apps[3].id);
    db.prepare('UPDATE applications SET updated_at = ? WHERE id = ?').run(isoDaysAgo(9), apps[2].id);

    const now = new Date().toISOString();
    const historyStmt = db.prepare(`INSERT INTO application_history
      (id, owner_id, application_id, event_id, from_status, to_status, changed_fields_json, changed_at, source_method, reason)
      VALUES (?, ?, ?, NULL, ?, ?, '{}', ?, 'mail', ?)`);
    historyStmt.run(`hist_home_${Date.now()}_1`, ownerId, apps[1].id, 'applied', 'assessment', isoDaysAgo(7), '招聘邮件自动更新：笔试通知');
    historyStmt.run(`hist_home_${Date.now()}_2`, ownerId, apps[1].id, 'assessment', 'interview', isoDaysAgo(3), '招聘邮件自动更新：二面邀约');
    // 演示截图只保留邮件推进轨迹，去掉手动补录的“创建”记录，避免时间线出现空状态。
    db.prepare('DELETE FROM application_history WHERE application_id = ? AND from_status IS NULL').run(apps[1].id);
    db.prepare("UPDATE applications SET status = 'interview', stage_received_at = ?, stage_anchor_at = ?, last_progress_at = ?, last_status_changed_at = ?, round_label = ?, version = version + 1 WHERE id = ?")
      .run(isoDaysAgo(3), isoDaysAgo(3), isoDaysAgo(3), isoDaysAgo(3), '二面中', apps[1].id);

    await server.request('/api/v1/notification-preferences', {
      method: 'PUT', cookie,
      body: { review_threshold_days: 7, stage_followup_days: 7 }
    });

    /* ---------- 简历 + 改写草稿 ---------- */
    const resumeText = `张晨
产品经理 · 3 年 B 端与数据产品经验
alex@example.com · 上海 · 求职意向：AI 产品经理

教育背景
华东理工大学　信息管理与信息系统　本科　2019.09–2023.06
主修课程：数据库、统计学、人机交互、Python 数据分析

实习经历
星河科技｜AI 产品实习生　2025.06–2025.09
· 负责智能客服知识库的需求梳理与验收，累计整理 120 条高频问题，协助上线 3 个自动化应答场景。
· 使用 SQL 与 Excel 分析客服会话数据，定位 2 类高频转人工原因，推动知识库命中率提升 18%。
· 参与产品需求评审与版本验收，输出 8 份需求说明和测试清单，跟进上线问题闭环。

项目经历
校园求职助手｜产品负责人　2024.03–2024.09
· 调研 46 位同学的投递流程，梳理岗位收藏、进度提醒、简历版本三个核心场景。
· 设计并上线轻量原型，累计 230 次访问，回收 32 份有效反馈，迭代 2 个版本。
· 使用 Python 抓取公开岗位信息并清洗字段，形成 1,200 条岗位样本用于需求分析。

技能
SQL、Python、Tableau、Axure、用户访谈、需求文档、数据分析`;

    const resumeResponse = await server.request('/api/v1/resumes/text', {
      method: 'POST', cookie,
      body: { text: resumeText, filename: '张晨-产品经理-2026.txt' }
    });
    if (resumeResponse.status !== 201) throw new Error(`创建演示简历失败：${resumeResponse.status} ${resumeResponse.text}`);
    const resumeId = resumeResponse.json.data.id;

    const profileResponse = await server.request('/api/v1/profile', {
      method: 'PUT', cookie,
      headers: { 'Idempotency-Key': 'home-shot-profile' },
      body: {
        career_direction: 'AI 产品经理', preferred_locations: ['上海', '杭州'],
        industry_preferences: ['人工智能', '互联网'], company_preferences: ['重视产品方法论', '业务落地'],
        salary_expectation: '25k–35k', work_mode: '混合办公',
        summary_text: 'AI 产品经理 · 上海/杭州 · 人工智能/互联网'
      }
    });
    if (profileResponse.status !== 200) throw new Error(`保存演示画像失败：${profileResponse.status} ${profileResponse.text}`);

    const draftResponse = await server.request('/api/v1/resumes/rewrite/drafts', {
      method: 'POST', cookie,
      body: { resume_id: resumeId, application_id: apps[0].id, requirements: '重点突出 AI 产品落地、数据分析与跨团队推进；保持真实指标，不补写经历。' }
    });
    if (draftResponse.status !== 201) throw new Error(`创建改写草稿失败：${draftResponse.status} ${draftResponse.text}`);
    const draftId = draftResponse.json.data.id;
    await waitForDraft(server, cookie, draftId);

    // 伪造模型输出仅用于官网展示截图：保留真实段落结构，由前端按原文/改写差异渲染。
    const draftRow = db.prepare('SELECT blocks_json, report_json FROM resume_rewrite_drafts WHERE id = ?').get(draftId);
    const blocks = JSON.parse(draftRow.blocks_json || '[]');
    const editable = blocks.filter((block) => block.editable);
    const updates = [
      ['supported_optimize', '负责智能客服知识库 120 条高频问题的需求梳理与验收，推动 3 个自动化应答场景上线，覆盖常见咨询与转人工提示。', '对齐 JD 的大模型应用与知识库产品经验'],
      ['supported_optimize', '使用 SQL 与 Excel 拆解客服会话数据，定位 2 类高频转人工原因并形成产品改进清单，推动知识库命中率提升 18%。', '对齐 JD 的数据分析与指标闭环要求'],
      ['improvable', '参与需求评审、版本验收与上线问题闭环，累计输出 8 份需求说明和测试清单，协同算法、研发与设计推进落地。', '突出跨团队协作与项目推进能力']
    ];
    updates.forEach(([type, body, reason], index) => {
      const target = editable[index];
      if (!target) return;
      target.alignment_type = type;
      target.rewritten_text = (target.description_prefix || '') + body;
      target.reason = reason;
      target.jd_evidence = fullJd.slice(0, 120);
      target.needs_user_fact = false;
    });
    const report = JSON.parse(draftRow.report_json || '{}');
    report.optimized_count = updates.filter(([type]) => type === 'supported_optimize').length;
    report.improvable_count = updates.filter(([type]) => type === 'improvable').length;
    report.needs_user_fact = [];
    report.needs_user_fact_count = 0;
    report.blocked_count = 0;
    report.gaps = ['缺少大规模用户增长项目的量化结果'];
    report.risks = ['所有改写均保留原简历事实，未补写指标'];
    db.prepare("UPDATE resume_rewrite_drafts SET blocks_json = ?, report_json = ?, progress_percent = 100, progress_label = '生成完成！', status = 'ready' WHERE id = ?")
      .run(JSON.stringify(blocks), JSON.stringify(report), draftId);

    /* ---------- 插件待确认线索 ---------- */
    const device = await server.pairDevice(cookie, 'Capture Chrome');
    const batch = await server.eventBatch(device.device_token, [
      weakSubmission({
        company: '云帆智造', title: '产品运营（2027 校招）', url: 'https://jobs.example.com/yunfan/campus-ops',
        batch: '2027 届秋招', location: '杭州',
        jd: '负责 SaaS 产品增长运营、内容策划与用户生命周期管理，要求有数据分析意识与跨团队协作经验。',
        tag: 'yunfan'
      }),
      weakSubmission({
        company: '深蓝云图', title: '商业化产品经理', url: 'https://jobs.example.com/shenlan/commercial-pm',
        batch: '2026 社招', location: '北京',
        jd: '负责商业化产品方案设计与收入增长，要求熟悉 B 端客户需求、定价策略和项目推进。',
        tag: 'shenlan'
      })
    ]);
    if (batch.status !== 200) throw new Error(`插件线索写入失败：${batch.status} ${batch.text}`);

    /* ---------- AI 助手演示会话 ---------- */
    const appRow = db.prepare('SELECT id, version FROM applications WHERE id = ?').get(apps[0].id);
    const sessionId = 'agsess_home_demo';
    const actionId = 'agact_home_demo';
    const actionSummary = {
      items: [{
        application_id: apps[0].id,
        company_name: '星河科技',
        job_title: 'AI 产品经理',
        from_status: 'applied',
        status: 'interview'
      }],
      count: 1
    };
    db.prepare(`INSERT OR REPLACE INTO agent_sessions
      (id, owner_id, title, context_resume_id, context_application_id, summary_text, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(sessionId, ownerId, '星河科技岗位进度与对比', resumeId, apps[0].id,
        '查询星河科技进展，并与明镜数科对比准备优先级。', isoDaysAgo(0, 1), now);
    const assistantMeta = {
      read_only: false,
      has_pending_write: true,
      references: [{ type: 'application', id: apps[0].id, label: '星河科技 · AI 产品经理' }],
      actions: [{ id: actionId, action_type: 'update_status', summary: actionSummary }]
    };
    const userMsgId = 'agmsg_home_user';
    const assistantMsgId = 'agmsg_home_assistant';
    const userMessageAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const assistantMessageAt = new Date().toISOString();
    db.prepare(`INSERT OR REPLACE INTO agent_messages (id, session_id, owner_id, role, content, meta_json, created_at)
      VALUES (?, ?, ?, 'user', ?, '{"read_only":true}', ?)`)
      .run(userMsgId, sessionId, ownerId,
        '帮我看看星河科技这个岗位现在到哪一步了，顺便比较一下它和明镜数科哪个更值得优先准备。', userMessageAt);
    db.prepare(`INSERT OR REPLACE INTO agent_messages (id, session_id, owner_id, role, content, meta_json, created_at)
      VALUES (?, ?, ?, 'assistant', ?, ?, ?)`)
      .run(assistantMsgId, sessionId, ownerId,
        `星河科技目前「已投递」8 天，岗位 JD 已完整记录；明镜数科已进入二面。

建议先准备明镜数科二面，再把星河科技作为 AI 产品方向的备选。需要我把星河科技的状态更新为「面试中」吗？`,
        JSON.stringify(assistantMeta), assistantMessageAt);
    db.prepare(`INSERT OR REPLACE INTO agent_pending_actions
      (id, session_id, message_id, owner_id, action_type, payload_json, summary_json, status, result_json, expires_at, created_at, resolved_at)
      VALUES (?, ?, ?, ?, 'update_status', ?, ?, 'pending', NULL, ?, ?, NULL)`)
      .run(actionId, sessionId, assistantMsgId, ownerId,
        JSON.stringify({ items: [{ application_id: apps[0].id, expected_version: appRow.version, status: 'interview' }] }),
        JSON.stringify(actionSummary),
        new Date(Date.now() + 24 * 3600 * 1000).toISOString(), now);
    // 顶部对话时间保持在当前，避免官网截图显示“很久以前”。
    const currentNow = new Date().toISOString();
    db.prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?').run(currentNow, sessionId);
    db.close();

    /* ---------- 浏览器截图 ---------- */
    const resolved = await resolveChromiumExecutable();
    if (!resolved) throw new Error('未找到可用 Chromium/Chrome for Testing');
    browser = await chromium.launch({ headless: true, executablePath: resolved.path });
    const context = await browser.newContext({
      viewport: VIEWPORT, deviceScaleFactor: 2, baseURL: server.base,
      locale: 'zh-CN', timezoneId: 'Asia/Shanghai'
    });
    const cookies = cookie.split('; ').map((pair) => {
      const [name, ...rest] = pair.split('=');
      return { name, value: rest.join('='), domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' };
    });
    await context.addCookies(cookies);
    await context.addInitScript((email) => {
      localStorage.setItem(`tounar.onboarding.v115.${email}`, JSON.stringify({ completed: true, version: '1.1.5' }));
      sessionStorage.setItem(`tounar.plugin.onboarding.${email}`, 'connection');
    }, EMAIL);

    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', (error) => console.error('· pageerror:', error.message));
    const hideSidebar = () => page.evaluate(() => {
      const sidebar = document.getElementById('tn-sidebar');
      if (sidebar) sidebar.style.display = 'none';
    });
    const tmp = (name) => path.join(TMP_DIR, `${name}.png`);

    // 图 0：投递台账首屏
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-test=ledger-row]');
    await page.waitForSelector('[data-test=stat-total]');
    await page.evaluate(() => {
      const total = document.querySelector('[data-test=stat-total]');
      if (total) total.textContent = '5';
      document.querySelector('[data-test=ledger-row]')?.classList.add('tn-row-updated');
    });
    await hideSidebar();
    await page.waitForTimeout(450);
    await page.screenshot({ path: tmp('hero-ledger'), clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });

    // 图 1：待确认中的插件线索
    await page.goto('/?panel=reviews', { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-test=review-card]');
    await hideSidebar();
    await page.waitForTimeout(400);
    await page.screenshot({ path: tmp('feature-capture'), clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });

    // 图 2：简历改写审阅
    await page.goto(`/?panel=career&section=rewrite&draft=${encodeURIComponent(draftId)}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-test=resume-rewrite-view]');
    await page.waitForSelector('[data-test=rewrite-description]');
    await hideSidebar();
    await page.evaluate(() => {
      const notice = document.querySelector('.tn-ai-notice');
      if (notice) notice.style.display = 'none';
      window.scrollTo(0, 64);
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: tmp('feature-resume'), clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });

    // 图 3：岗位详情时间线（邮件自动推进）
    await page.goto(`/?app=${encodeURIComponent(apps[1].id)}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-test=detail-drawer]');
    await page.waitForSelector('[data-test=detail-history]');
    await hideSidebar();
    await page.evaluate(() => {
      // 官网展示只保留链接与状态时间线，隐藏字段明细以免截图中信息过密。
      for (const section of document.querySelectorAll('.tn-drawer-section')) {
        if (['核心字段', '信息来源'].includes(section.querySelector('h3')?.textContent?.trim())) section.style.display = 'none';
      }
      const jd = document.querySelector('.tn-jd-sections');
      if (jd) jd.style.display = 'none';
      const body = document.querySelector('.tn-drawer-body');
      const timeline = document.querySelector('[data-test=detail-history]');
      if (body && timeline) body.scrollTop = timeline.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 12;
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: tmp('feature-mail'), clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });

    // 图 4：AI 助手抽屉（含待确认操作卡）
    await page.goto('/?panel=assistant', { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-test=assistant-drawer]:not([hidden])');
    await page.waitForSelector('[data-test=assistant-action-card]');
    await page.locator('[data-test=assistant-drawer-wide]').click();
    await hideSidebar();
    await page.evaluate(() => {
      // 截图聚焦对话与确认卡：隐藏次要操作行、快捷卡和输入区，保留上下文胶囊与画像条。
      document.querySelector('.tn-assistant-top')?.style.setProperty('display', 'none');
      document.querySelector('.tn-assistant-composer')?.style.setProperty('display', 'none');
      document.querySelector('.tn-agent-cards')?.style.setProperty('display', 'none');
      document.querySelector('.tn-agent-risk')?.style.setProperty('display', 'none');
      const thread = document.querySelector('[data-test=assistant-thread]');
      if (thread) thread.scrollTop = 0;
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: tmp('feature-assistant'), clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });

    await browser.close();
    browser = null;

    /* ---------- 转 WebP ---------- */
    const names = ['hero-ledger', 'feature-capture', 'feature-resume', 'feature-mail', 'feature-assistant'];
    const results = [];
    for (const name of names) {
      const input = tmp(name);
      const output = path.join(OUT_DIR, `${name}.webp`);
      execFileSync('cwebp', ['-quiet', '-q', '82', '-resize', '1920', '0', input, '-o', output], { stdio: 'inherit' });
      const size = fs.statSync(output).size;
      results.push({ name, size });
    }
    for (const item of results) console.log(`✔ ${item.name}.webp  ${(item.size / 1024).toFixed(0)} KB`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.stop();
  }
}

main().catch((error) => {
  console.error('✖ 首页截图采集失败：', error);
  process.exitCode = 1;
});
