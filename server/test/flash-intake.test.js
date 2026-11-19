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
        return fakeJson(res, {
          model: 'deepseek-flash',
          choices: [{ message: { content: JSON.stringify({
            actual_progress: 0.96,
            evidence_support: 0.95,
            company_valid: ex.company_name ? 0.96 : 0.1,
            job_title_valid: ex.job_title ? 0.95 : 0.05,
            fields_consistent: 0.95,
            status: { value: ex.status && ex.status !== 'unknown' ? ex.status : 'assessment', confidence: 0.95 },
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
      } else if (/确认科技/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '确认科技', job_title: '确认岗位', status: 'assessment', evidence: [{ field: 'status', quote: '测评邀请' }], uncertainties: [] };
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

it('邮件与插件判断开关相互独立', () => {
  assert.equal(judge.judgeModeFor('mail'), 'flash');
  assert.equal(judge.judgeModeFor('plugin'), 'jev');
});
