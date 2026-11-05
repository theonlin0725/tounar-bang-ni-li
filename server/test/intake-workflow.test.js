import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA = path.join(ROOT, '.tmp', 'tests', 'intake-workflow');
let fake, fakePort;
let db, workflow, applications, util;
let ownerId = 'usr_intake_test';
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
      const user = JSON.parse(body.messages?.[1]?.content || '{}');
      const text = `${user.subject || ''}\n${user.body_text || ''}`;
      let answer;
      if (/HEADERONLY/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '网易游戏', job_title: null, status: 'interview', progress_description: '邮件头显示面试时间收集', evidence: [{ field: 'status', quote: '面试时间收集' }], uncertainties: [] };
      } else if (/流程包含|流程包括/.test(text)) {
        answer = { is_recruitment: true, content_role: 'process_description', company_name: '流程公司', job_title: '流程岗位', status: 'interview', progress_description: '招聘流程含面试', evidence: [{ field: 'status', quote: '流程包含面试' }], uncertainties: [] };
      } else if (/二面|面试邀请/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: user.rule_extracted?.company_name || (/多岗位/.test(text) ? '多岗位科技' : '星河科技'), job_title: /多岗位/.test(text) ? null : (user.rule_extracted?.job_title || '数据产品实习生'), status: 'interview', event_time: '2026-10-30T02:00:00.000Z', progress_description: '收到二面邀请', evidence: [{ field: 'status', quote: '收到二面邀请' }], uncertainties: [] };
      } else if (/录用/.test(text)) {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '录用科技', job_title: '产品经理', status: 'offer', progress_description: '已录用', evidence: [{ field: 'status', quote: '已录用' }], uncertainties: [] };
      } else {
        answer = { is_recruitment: true, content_role: 'actual_progress', company_name: '新公司', job_title: '新岗位', status: 'interview', progress_description: '新进展', evidence: [{ field: 'status', quote: '进入面试' }], uncertainties: [] };
      }
      return fakeJson(res, { model: 'fake-llm', choices: [{ message: { content: JSON.stringify(answer) } }] });
    }
    if (req.url === '/v1/systemone') {
      const state = body.state || {};
      const text = String(state.body_text || '');
      const candidates = Array.isArray(state.candidates) ? state.candidates : [];
      const ambiguous = /多岗位/.test(text);
      const process = state.extracted?.content_role === 'process_description';
      const headerOnly = /HEADERONLY/.test(text);
      const chosen = ambiguous ? 'uncertain' : (candidates.length ? 'c0' : 'no_match');
      return fakeJson(res, {
        model: 'jev-1.14.0', request_id: 'jev_test',
        answers: {
          actual_progress: { type: 'noul', noul: process ? 0.12 : (headerOnly ? 0.22 : 0.96) },
          status: { type: 'choice', choice: process ? 'no_status' : (state.extracted?.status || 'interview'), confidence: process ? 0.9 : 0.97, probabilities: {} },
          evidence_support: { type: 'noul', noul: process ? 0.2 : (headerOnly ? 0.2 : 0.95) },
          newness: { type: 'choice', choice: 'new', confidence: 0.95, probabilities: {} },
          candidate: { type: 'choice', choice: chosen, confidence: ambiguous ? 0.3 : 0.95, probabilities: {} }
        }
      });
    }
    fakeJson(res, { error: { message: 'not found' } }, 404);
  });
  fakePort = await listen(fake);
  process.env.DATA_DIR = DATA;
  process.env.AUTO_INTAKE_ENABLED = 'true';
  process.env.AI_API_URL = `http://127.0.0.1:${fakePort}/v1`;
  process.env.AI_API_KEY = 'test-ai';
  process.env.AI_MODEL = 'fake-llm';
  process.env.JEV_API_URL = `http://127.0.0.1:${fakePort}/v1/systemone`;
  process.env.JEV_API_KEY = 'test-jev';
  process.env.JEV_MODEL = 'jev-latest';
  process.env.AI_LLM_TIMEOUT_MS = '5000';
  db = await import('../src/db.js');
  util = await import('../src/util.js');
  applications = await import('../src/domain/applications.js');
  workflow = await import('../src/modules/recruitment-intake/workflow.js');
  db.getDb();
  db.run(`INSERT INTO users (id,email_normalized,email_display,allowlisted,created_at) VALUES (?,?,?,?,?)`,
    [ownerId, 'intake@test.local', 'intake@test.local', 1, util.nowIso()]);
});
after(async () => {
  db?.closeDb();
  await new Promise((resolve) => fake?.close(resolve));
});

function app(company, title, status = 'assessment') {
  return applications.createApplication({
    ownerId, sourceMethod: 'manual', status,
    fields: { company_name: company, job_title: title, applied_at: '2026-10-01T00:00:00.000Z', applied_at_precision: 'date', jd_summary: '测试' },
    at: '2026-10-01T00:00:00.000Z'
  });
}
function event(text, { company = null, title = null, received = '2026-10-31T00:00:00.000Z' } = {}) {
  const id = util.newId('evt');
  const payload = {
    source_mail_id: null, source_received_at: received, category: 'interview',
    confidence: 0.9, status_text: '面试', mapped_status: 'interview',
    company_name: company, job_title: title, from_domain: 'jobs.example.com',
    subject_excerpt: '招聘进展', body_excerpt: text, ai_body_excerpt: text,
    read_mode: 'recruitment_body', field_confidence: {}
  };
  db.run(`INSERT INTO events
    (id,owner_id,client_event_id,source_method,event_type,occurred_at,observed_at,received_at,schema_version,
     evidence_level,evidence_code,payload_json,payload_hash,processing_state)
    VALUES (?,?,?, 'mail','mail_progress_detected',?,?,?,'C1','strong','test',?,?,'pending')`,
  [id, ownerId, `mail:${id}`, received, received, util.nowIso(), JSON.stringify(payload), util.newId('ph')]);
  return db.one('SELECT * FROM events WHERE id=?', [id]);
}
function payload(e) { return { ...e, payload: JSON.parse(e.payload_json) }; }

it('已有笔试记录收到明确面试邀请：自动更新原记录，不创建待确认', async () => {
  const target = app('星河科技', '数据产品实习生', 'assessment');
  const e = event('恭喜你，收到二面邀请。', { company: '星河科技', title: '数据产品实习生' });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'applied');
  assert.equal(db.one('SELECT status,has_applied,manual_status_at FROM applications WHERE id=?', [target.id]).status, 'interview');
  assert.equal(db.one("SELECT COUNT(*) n FROM review_items WHERE status='open'").n, 0);
  assert.equal(db.one('SELECT status,decision FROM ai_ingest_runs WHERE event_id=?', [e.id]).status, 'completed');
});

it('没有台账但岗位身份明确：自动创建对应状态记录', async () => {
  const e = event('你已进入面试环节。', { company: '新公司', title: '新岗位', received: '2026-10-31T05:00:00.000Z' });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'applied');
  assert.equal(result.change, 'created');
  assert.equal(result.application.company_name, '新公司');
  assert.equal(result.application.status, 'interview');
  assert.equal(result.application.has_applied, 1);
});

it('JD/流程说明不误判为用户实际进展', async () => {
  const e = event('我们的招聘流程包含面试、笔试，通过后会通知你。', { received: '2026-10-31T06:00:00.000Z' });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'ignored');
  assert.equal(db.one("SELECT COUNT(*) n FROM review_items WHERE status='open'").n, 0);
});

it('同公司多个候选无法区分：不更新，进入待确认', async () => {
  app('多岗位科技', '产品经理', 'assessment');
  app('多岗位科技', '数据分析师', 'assessment');
  const e = event('多岗位科技：收到面试邀请，请参加后续面试。', { company: '多岗位科技', received: '2026-10-31T07:00:00.000Z' });
  const result = await workflow.processIntakeEvent(payload(e));
  assert.equal(result.state, 'pending');
  assert.ok(result.review);
  assert.equal(db.one("SELECT COUNT(*) n FROM applications WHERE company_name='多岗位科技' AND status='interview'").n, 0);
});

it('模型技术失败只进入重试，不创建用户待确认', async () => {
  llmFail = true;
  const e = event('收到面试邀请。', { received: '2026-10-31T08:00:00.000Z' });
  const before = db.one("SELECT COUNT(*) n FROM review_items WHERE status='open'").n;
  const result = await workflow.processIntakeEvent(payload(e));
  llmFail = false;
  assert.equal(result.state, 'retry');
  assert.equal(db.one("SELECT COUNT(*) n FROM review_items WHERE status='open'").n, before);
  assert.equal(db.one('SELECT processing_state,review_reason FROM events WHERE id=?', [e.id]).processing_state, 'pending');
  assert.equal(db.one('SELECT status,error_code FROM ai_ingest_runs WHERE event_id=?', [e.id]).status, 'retry');
});

it('用户手动修改晚于旧证据时不被覆盖；更晚的新证据仍可自动更新', async () => {
  const target = app('人工保护科技', '人工保护岗位', 'assessment');
  db.run("UPDATE applications SET manual_status_at=?, last_status_changed_at=? WHERE id=?",
    ['2026-10-31T00:00:00.000Z', '2026-10-31T00:00:00.000Z', target.id]);
  const old = event('人工保护科技：收到面试邀请。', { company: '人工保护科技', title: '人工保护岗位', received: '2026-10-30T00:00:00.000Z' });
  const r1 = await workflow.processIntakeEvent(payload(old));
  assert.equal(r1.state, 'ignored');
  assert.equal(db.one('SELECT status FROM applications WHERE id=?', [target.id]).status, 'assessment');
  const newer = event('人工保护科技：收到面试邀请。', { company: '人工保护科技', title: '人工保护岗位', received: '2026-11-01T00:00:00.000Z' });
  const r2 = await workflow.processIntakeEvent(payload(newer));
  assert.equal(r2.state, 'applied');
  const after = db.one('SELECT status,manual_status_at FROM applications WHERE id=?', [target.id]);
  assert.equal(after.status, 'interview');
  assert.equal(after.manual_status_at, null);
});

it('重试队列可重新处理模型故障，成功后自动入账', async () => {
  llmFail = true;
  const e = event('重试公司：收到二面邀请。', { received: '2026-10-31T09:00:00.000Z' });
  const failed = await workflow.processIntakeEvent(payload(e));
  assert.equal(failed.state, 'retry');
  db.run("UPDATE ai_ingest_runs SET next_retry_at='2000-01-01T00:00:00.000Z' WHERE event_id=?", [e.id]);
  llmFail = false;
  const results = await workflow.retryPendingIntakes(5);
  assert.ok(results.length >= 1);
  const run = db.one('SELECT status,decision FROM ai_ingest_runs WHERE event_id=?', [e.id]);
  assert.equal(run.status, 'completed');
  assert.ok(['created', 'updated', 'no_change'].includes(run.decision));
});

it('只有邮件头但明确面试/笔试进展：保留为待确认，不因正文为空自动忽略', async () => {
  const e = event('HEADERONLY 网易游戏面试时间收集', { company: '网易游戏', received: '2026-10-31T11:00:00.000Z' });
  const result = await workflow.processIntakeEvent(payload(e), { subject: '网易游戏面试时间收集' });
  assert.equal(result.state, 'pending');
  assert.equal(result.review?.reason_code, 'AI_HEADER_PROGRESS_UNCERTAIN');
  assert.equal(db.one('SELECT status FROM ai_ingest_runs WHERE event_id=?', [e.id]).status, 'review');
});

it('同一事件重复处理不重复建账、不重复产生待确认', async () => {
  const beforeApps = db.one('SELECT COUNT(*) n FROM applications').n;
  const e = event('重复公司：收到面试邀请。', { company: '重复公司', title: '重复岗位', received: '2026-10-31T10:00:00.000Z' });
  const first = await workflow.processIntakeEvent(payload(e));
  const second = await workflow.processIntakeEvent(payload(e));
  assert.equal(first.state, 'applied');
  assert.equal(second.state, 'applied');
  assert.equal(db.one('SELECT COUNT(*) n FROM applications WHERE company_name=?', ['重复公司']).n, 1);
  assert.equal(db.one("SELECT COUNT(*) n FROM review_items WHERE status='open' AND source_event_id=?", [e.id]).n, 0);
  assert.ok(beforeApps >= 0);
});
