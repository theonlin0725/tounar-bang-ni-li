import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA = path.join(ROOT, '.tmp', 'tests', 'flash-intake');
let fake, fakePort;
let db, util, applications, workflow, confirm, judge;
const ownerId = 'usr_flash_test';
let llmFail = false;

function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function fakeJson(res, body, status = 200) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); }

before(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fake = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    if (req.url === '/v1/chat/completions') {
      if (llmFail) return fakeJson(res, { error: { message: 'fake fail' } }, 500);
      const system = String(body.messages?.[0]?.content || '');
      const user = JSON.parse(body.messages?.[1]?.content || '{}');
      if (system.includes('招聘进展判断器')) {
        const candidates = Array.isArray(user.candidates) ? user.candidates : [];
        const ex = user.extracted || {};
        const companyOnly = Boolean(ex.company_name) && !ex.job_title;
        const noStatus = /内推/.test(String(user.subject || '') + String(user.body_text || ''));
        return fakeJson(res, {
          model: 'deepseek-flash',
          choices: [{ message: { content: JSON.stringify({
            actual_progress: 0.96,
            evidence_support: /低证据/.test(String(user.body_text || '')) ? 0.6 : 0.95,
            company_valid: ex.company_name ? 0.96 : 0.1,
            job_title_valid: ex.job_title ? 0.95 : 0.05,
            fields_consistent: 0.95,
            status: { value: noStatus ? 'no_status' : (ex.status && ex.status !== 'unknown' ? ex.status : 'assessment'), confidence: 0.95 },
            newness: { value: 'new', confidence: 0.9 },
            candidate: { value: candidates.length && !companyOnly ? 'c0' : (candidates.length ? 'uncertain' : 'no_match'), confidence: candidates.length ? 0.9 : 0.5 }
          }) } }]
        });
      }
      const text = `${user.subject || ''}\n${user.body_text || ''}`;
      let answer;
      if (/多岗位/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '多岗位科技', job_title: null, status: 'assessment', evidence: [{ field: 'status', quote: '测评邀请' }], uncertainties: [] };
      } else if (/新机会/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '新机会科技', job_title: '后端实习生', status: 'interview', evidence: [{ field: 'status', quote: '面试邀请' }], uncertainties: [] };
      } else if (/网易新岗/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '网易', job_title: '产品经理', status: 'assessment', evidence: [{ field: 'status', quote: '测评邀请' }], uncertainties: [] };
      } else if (/单活跃公司/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '单活跃公司', job_title: null, recruitment_batch: '2027届校招', status: 'assessment', evidence: [{ field: 'status', quote: '测评邀请' }], uncertainties: [] };
      } else if (/歧义公司/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '歧义公司', job_title: null, status: 'assessment', evidence: [{ field: 'status', quote: '测评邀请' }], uncertainties: [] };
      } else if (/公司级测评/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '网易', job_title: null, recruitment_batch: '2027届校招', status: 'assessment', evidence: [{ field: 'status', quote: '测评邀请' }], uncertainties: [] };
      } else if (/确认科技/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '确认科技', job_title: '确认岗位', status: 'assessment', evidence: [{ field: 'status', quote: '测评邀请' }], uncertainties: [] };
      } else if (/复合岗位/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '2027欧莱雅中国管理培训生', job_title: null, recruitment_batch: '2027', status: 'assessment', evidence: [{ field: 'status', quote: '测评邀请' }], uncertainties: [] };
      } else if (/去重/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '去重科技', job_title: '后端实习生', status: 'assessment', evidence: [{ field: 'status', quote: '测评邀请' }], uncertainties: [] };
      } else if (/结构化字段/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '结构化公司', job_title: '数据工程师', location: '上海', round_label: '一面', interview_scheduled_at: '2026-11-25T06:00:00.000Z', deadline_at: '2026-11-30T15:59:59.000Z', status: 'interview', evidence: [{ field: 'status', quote: '面试邀请' }], uncertainties: [] };
      } else if (/占位补全/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '占位科技', job_title: '后端实习生', status: 'assessment', evidence: [{ field: 'status', quote: '测评邀请' }], uncertainties: [] };
      } else if (/低证据/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '低证据公司', job_title: null, status: 'assessment', evidence: [{ field: 'status', quote: '测评邀请' }], uncertainties: ['正文证据有限'] };
      } else if (/内推成功/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '内推公司', job_title: null, status: 'unknown', evidence: [{ field: 'company_name', quote: '内推公司' }], uncertainties: ['仅确认内推，无个人阶段邀请'] };
      } else {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '星河科技', job_title: '数据产品实习生', status: 'assessment', evidence: [{ field: 'status', quote: '测评邀请' }], uncertainties: [] };
      }
      return fakeJson(res, { model: 'deepseek-flash', choices: [{ message: { content: JSON.stringify(answer) } }] });
    }
    fakeJson(res, { error: { message: 'not found' } }, 404);
  });
  fakePort = await listen(fake);
  process.env.DATA_DIR = DATA;
  process.env.AUTO_INTAKE_ENABLED = 'true';
  process.env.MAIL_INTAKE_JUDGE = 'flash';
  process.env.PLUGIN_INTAKE_JUDGE = 'jev';
  process.env.AUTO_INTAKE_MAX_ATTEMPTS = '3';
  process.env.AI_API_URL = `http://127.0.0.1:${fakePort}/v1`;
  process.env.AI_API_KEY = 'test-ai';
  process.env.AI_MODEL = 'deepseek-flash';
  process.env.JEV_API_URL = `http://127.0.0.1:${fakePort}/v1/systemone`;
  process.env.JEV_API_KEY = 'test-jev';
  process.env.JEV_MODEL = 'jev-latest';
  process.env.AI_LLM_TIMEOUT_MS = '5000';
  db = await import('../src/db.js');
  util = await import('../src/util.js');
  applications = await import('../src/domain/applications.js');
  workflow = await import('../src/modules/recruitment-intake/workflow.js');
  confirm = await import('../src/modules/recruitment-intake/confirm.js');
  judge = await import('../src/modules/recruitment-intake/judge.js');
  db.getDb();
  db.run(`INSERT INTO users (id,email_normalized,email_display,allowlisted,created_at) VALUES (?,?,?,?,?)`,
    [ownerId, 'flash@test.local', 'flash@test.local', 1, util.nowIso()]);
});
after(async () => {
  db?.closeDb();
  await new Promise((resolve) => fake?.close(resolve));
});

function app(company, title, status = 'applied') {
  return applications.createApplication({
    ownerId, sourceMethod: 'manual', status,
    fields: { company_name: company, job_title: title, applied_at: '2026-10-01T00:00:00.000Z', applied_at_precision: 'date', jd_summary: '测试' },
    at: '2026-10-01T00:00:00.000Z'
  });
}
function event(text, { company = null, title = null, received = '2026-10-31T00:00:00.000Z', source = 'mail' } = {}) {
  const id = util.newId('evt');
  const payload = {
    source_mail_id: null, source_received_at: received, category: 'assessment',
    confidence: 0.9, status_text: '测评', mapped_status: 'assessment',
    company_name: company, job_title: title, from_domain: 'jobs.example.com',
    subject_excerpt: '招聘进展', body_excerpt: text, ai_body_excerpt: text,
    read_mode: 'recruitment_body', field_confidence: {}
  };
  db.run(`INSERT INTO events
    (id,owner_id,client_event_id,source_method,event_type,occurred_at,observed_at,received_at,schema_version,
     evidence_level,evidence_code,payload_json,payload_hash,processing_state)
    VALUES (?,?,?,?,'mail_progress_detected',?,?,?,'C1','strong','test',?,?,'pending')`,
  [id, ownerId, `${source}:${id}`, source, received, received, util.nowIso(), JSON.stringify(payload), util.newId('ph')]);
  return db.one('SELECT * FROM events WHERE id=?', [id]);
}
function payload(e) { return { ...e, payload: JSON.parse(e.payload_json) }; }

it('Flash 直判：唯一公司+岗位原地更新，记录 judge_mode=flash', async () => {
  const target = app('星河科技', '数据产品实习生', 'applied');
  const e = event('星河科技：收到测评邀请，请完成在线测评。', { company: '星河科技', title: '数据产品实习生' });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(db.one('SELECT status FROM applications WHERE id=?', [target.id]).status, 'assessment');
  const run = db.one('SELECT status,judge_mode FROM ai_ingest_runs WHERE event_id=?', [e.id]);
  assert.equal(run.status, 'completed');
  assert.equal(run.judge_mode, 'flash');
  assert.equal(db.one("SELECT COUNT(*) n FROM review_items WHERE status='open' AND source_event_id=?", [e.id]).n, 0);
});

it('Flash 直判：同公司多岗但邮件只有公司名，进待确认且不改台账', async () => {
  app('多岗位科技', '产品经理', 'applied');
  app('多岗位科技', '数据分析师', 'applied');
  const e = event('多岗位科技：测评邀请，请完成测评。', { company: '多岗位科技' });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'pending', JSON.stringify(result));
  assert.equal(result.review.reason_code, 'AI_COMPANY_ONLY');
  assert.equal(db.one("SELECT COUNT(*) n FROM applications WHERE company_name='多岗位科技' AND status<>'applied'").n, 0);
});

it('Flash 直判：无候选且公司/岗位/证据齐全时自动新建', async () => {
  const e = event('新机会科技：面试邀请，请参加面试。', { company: '新机会科技', title: '后端实习生' });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.change, 'created');
  assert.equal(result.application.company_name, '新机会科技');
  assert.equal(result.application.status, 'interview');
});

it('Flash 技术失败有上限：耗尽后转人工待确认，不再无限重试', async () => {
  llmFail = true;
  const e = event('重试公司：收到测评邀请。', { company: '重试公司', title: '测试岗位' });
  let result;
  for (let i = 0; i < 3; i += 1) result = await workflow.processIntakeEvent(payload(e));
  llmFail = false;
  assert.equal(result.state, 'failed', JSON.stringify(result));
  assert.ok(result.review, '必须有可见的人工待确认');
  const run = db.one('SELECT status,next_retry_at FROM ai_ingest_runs WHERE event_id=?', [e.id]);
  assert.equal(run.status, 'failed');
  assert.equal(run.next_retry_at, null);
  const review = db.one("SELECT reason_code,status FROM review_items WHERE source_event_id=? AND status='open'", [e.id]);
  assert.equal(review.reason_code, 'AI_RETRY_EXHAUSTED');
});

it('人工确认复用 Flash 判断与服务端归属，不依赖 Jev', async () => {
  const target = app('确认科技', '确认岗位', 'applied');
  const e = event('确认科技：收到测评邀请。', { company: '确认科技', title: '确认岗位', received: '2026-11-01T00:00:00.000Z' });
  const reviewId = util.newId('rev');
  db.run(`INSERT INTO review_items
    (id,owner_id,kind,reason_code,summary,evidence_json,suggested_changes_json,candidates_json,
     source_event_id,source_mail_id,status,version,created_at)
    VALUES (?,?,'mail_progress','AI_PROGRESS_UNCERTAIN','test','{}','{}','[]',?,NULL,'open',1,?)`,
  [reviewId, ownerId, e.id, util.nowIso()]);
  const res = await confirm.confirmReviewIntake({ ownerId, reviewId, expectedVersion: 1 });
  assert.equal(res.state, 'applied', JSON.stringify(res));
  assert.equal(res.analysis.judge_mode, 'flash');
  assert.equal(res.trace.jev.via, 'flash');
  assert.equal(db.one('SELECT status FROM applications WHERE id=?', [target.id]).status, 'assessment');
});

it('公司级统一测评邮件无岗位名：无台账时自动建账，名称低置信度可覆盖', async () => {
  const e = event('公司级测评：网易 2027届校招测评邀请，请完成在线测评。', { company: '网易' });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.change, 'created');
  assert.equal(result.application.company_name, '网易');
  assert.match(result.application.job_title, /待补充岗位/);
  const source = db.one("SELECT confidence,source_detail FROM application_field_sources WHERE application_id=? AND field='job_title'", [result.application.id]);
  assert.equal(source.confidence, 'low');
  assert.equal(source.source_detail, 'mail_company_only');
});

it('公司级统一测评邮件命中唯一未终态同公司记录：原地升级不新建', async () => {
  const target = app('单活跃公司', '游戏策划', 'pending');
  const e = event('公司级测评：单活跃公司校招测评邀请，请完成在线测评。', { company: '单活跃公司' });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.application.id, target.id);
  assert.equal(db.one('SELECT status FROM applications WHERE id=?', [target.id]).status, 'assessment');
  assert.equal(db.one('SELECT has_applied FROM applications WHERE id=?', [target.id]).has_applied, 1);
});

it('AI 开启时同公司新岗位且模型 no_match：新建独立记录，不混入旧岗位', async () => {
  const old = app('网易', '游戏策划', 'pending');
  const e = event('网易新岗：网易产品经理测评邀请，请完成在线测评。', { company: '网易', title: '产品经理' });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.change, 'created');
  assert.notEqual(result.application.id, old.id);
  assert.equal(result.application.company_name, '网易');
  assert.equal(result.application.job_title, '产品经理');
  assert.equal(db.one('SELECT status FROM applications WHERE id=?', [old.id]).status, 'pending');
});

it('同公司已有两个未终态岗位时，公司级无岗位名测评仍进待确认', async () => {
  app('歧义公司', '岗位A', 'applied');
  app('歧义公司', '岗位B', 'applied');
  const e = event('公司级测评：歧义公司测评邀请，请完成在线测评。', { company: '歧义公司' });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'pending', JSON.stringify(result));
  assert.equal(result.review.reason_code, 'AI_COMPANY_ONLY');
});

it('公司级清晰进展即使正文证据分略低也自动建账，不误进待确认', async () => {
  const e = event('低证据：低证据公司2027校招测评邀请，请完成在线测评。', { company: '低证据公司', title: null });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.change, 'created');
  assert.equal(result.application.company_name, '低证据公司');
  assert.match(result.application.job_title, /待补充岗位/);
  assert.equal(db.one("SELECT COUNT(*) n FROM review_items WHERE source_event_id=? AND status='open'", [e.id]).n, 0);
});

it('仅内推成功确认、没有个人阶段邀请的邮件忽略，不制造待确认', async () => {
  const e = event('内推成功：你已被成功内推，可关注后续流程。', { company: '内推公司', title: null });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'ignored', JSON.stringify(result));
  assert.equal(result.reason, 'referral_only');
  assert.equal(db.one("SELECT COUNT(*) n FROM review_items WHERE source_event_id=? AND status='open'", [e.id]).n, 0);
});

it('模型结构化字段（城市/轮次/面试预约/截止时间）写入台账', async () => {
  const e = event('结构化字段：结构化公司数据工程师面试邀请，11月25日一面。', { company: null, title: null });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.application.location, '上海');
  assert.equal(result.application.round_label, '一面');
  assert.equal(result.application.interview_scheduled_at, '2026-11-25T06:00:00.000Z');
  assert.equal(result.application.deadline_at, '2026-11-30T15:59:59.000Z');
});

it('后续真实岗位名自动升级低置信度占位岗位', async () => {
  const target = applications.createApplication({
    ownerId, sourceMethod: 'mail', status: 'applied',
    fields: { company_name: '占位科技', job_title: '2027（待补充岗位）', applied_at: '2026-10-01T00:00:00.000Z', applied_at_precision: 'date' },
    at: '2026-10-01T00:00:00.000Z'
  });
  db.run(`INSERT OR REPLACE INTO application_field_sources
    (application_id, owner_id, field, source_method, source_detail, confidence, updated_at)
    VALUES (?,?,'job_title','mail','mail_company_only','low',?)`, [target.id, ownerId, util.nowIso()]);
  const e = event('占位补全：占位科技后端实习生测评邀请，请完成在线测评。', { company: '占位科技', title: null, received: '2026-11-03T00:00:00.000Z' });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.application.id, target.id);
  assert.equal(result.application.job_title, '后端实习生');
});

it('模型返回复合实体时拆出批次、公司和纯岗位，不把年份/岗位串写成公司', async () => {
  const e = event('复合岗位：2027欧莱雅中国管理培训生在线测评通知，请完成在线测评。', { company: null, title: null });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.application.company_name, '欧莱雅中国');
  assert.equal(result.application.job_title, '管理培训生');
  assert.ok(/^2027/.test(result.application.recruitment_batch));
});

it('自动入账后关闭同公司同岗位已被覆盖的旧待确认项', async () => {
  const target = app('去重科技', '后端实习生', 'applied');
  const old = event('去重科技：旧测评邀请。', { company: '去重科技', title: '后端实习生' });
  const reviewId = util.newId('rev');
  db.run(`INSERT INTO review_items
    (id,owner_id,kind,reason_code,summary,evidence_json,suggested_changes_json,candidates_json,
     source_event_id,source_mail_id,status,version,created_at)
    VALUES (?,?,'mail_progress','AI_PROGRESS_UNCERTAIN','旧待确认','{}',?, '[]',?,NULL,'open',1,?)`,
  [reviewId, ownerId, JSON.stringify({ company_name: '去重科技', job_title: '后端实习生', status: 'assessment' }), old.id, util.nowIso()]);
  const e = event('去重科技：新测评邀请，请完成在线测评。', { company: '去重科技', title: '后端实习生', received: '2026-11-02T00:00:00.000Z' });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.equal(result.application.id, target.id);
  const review = db.one('SELECT status,resolution_json FROM review_items WHERE id=?', [reviewId]);
  assert.equal(review.status, 'resolved');
  assert.equal(JSON.parse(review.resolution_json).application_id, target.id);
});

it('邮件与插件判断开关相互独立', () => {
  assert.equal(judge.judgeModeFor('mail'), 'flash');
  assert.equal(judge.judgeModeFor('plugin'), 'jev');
});
