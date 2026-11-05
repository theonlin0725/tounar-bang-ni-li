#!/usr/bin/env node
/* 带人工标签的中文招聘邮件样本评估（隔离临时库；真实调用 .env 中 LLM/Jev）。
 * 用法：node --env-file-if-exists .env tools/eval-intake.mjs
 * 不读取/写入 data/mail-selftest 或用户台账。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, '.tmp', 'intake-eval');
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;

const db = await import('../server/src/db.js');
const util = await import('../server/src/util.js');
const applications = await import('../server/src/domain/applications.js');
const { processIntakeEvent } = await import('../server/src/modules/recruitment-intake/workflow.js');

const samples = [
  {
    id: 'interview_update', expected: 'updated', expectedStatus: 'interview', expectedCompany: '星河科技',
    seed: [{ company: '星河科技', title: '数据产品实习生', status: 'assessment' }],
    subject: '星河科技二面邀请', received: '2026-10-30T02:00:00.000Z',
    body: '星河科技校园招聘\n您好，感谢您参加星河科技数据产品实习生的一面。现邀请您于2026年11月3日下午2点参加二面。请回复确认。'
  },
  {
    id: 'assessment_create', expected: 'created', expectedStatus: 'assessment', expectedCompany: '云杉数据',
    seed: [],
    subject: '云杉数据在线测评通知', received: '2026-10-30T03:00:00.000Z',
    body: '云杉数据\n恭喜您通过简历筛选，应聘岗位：数据分析实习生。请于2026年11月2日18点前完成在线测评。'
  },
  {
    id: 'offer_update', expected: 'updated', expectedStatus: 'offer', expectedCompany: '青禾网络',
    seed: [{ company: '青禾网络', title: '产品运营', status: 'applied' }],
    subject: '青禾网络录用通知', received: '2026-10-30T04:00:00.000Z',
    body: '青禾网络\n我们很高兴通知您，您已通过产品运营岗位面试，现正式向您发放录用意向书，请查收附件。'
  },
  {
    id: 'rejected_update', expected: 'updated', expectedStatus: 'rejected', expectedCompany: '北辰数据',
    seed: [{ company: '北辰数据', title: '数据工程师', status: 'interview' }],
    subject: '北辰数据招聘结果', received: '2026-10-30T05:00:00.000Z',
    body: '北辰数据\n感谢您参加数据工程师岗位面试。很遗憾，经过综合评估，本次未能通过，祝您后续求职顺利。'
  },
  {
    id: 'process_description', expected: 'ignored', expectedStatus: null, expectedCompany: null,
    seed: [],
    subject: '招聘流程说明', received: '2026-10-30T06:00:00.000Z',
    body: '我们的校园招聘流程包括简历筛选、笔试、面试和录用。通过面试后会通知您，请耐心等待。'
  },
  {
    id: 'ambiguous_company', expected: 'review', expectedStatus: null, expectedCompany: null,
    seed: [{ company: '多岗位科技', title: '产品经理', status: 'assessment' }, { company: '多岗位科技', title: '数据分析师', status: 'assessment' }],
    subject: '多岗位科技面试邀请', received: '2026-10-30T07:00:00.000Z',
    body: '多岗位科技\n恭喜您进入面试环节，请于下周参加面试。具体岗位以面试通知为准。'
  },
  {
    id: 'advertisement', expected: 'ignored', expectedStatus: null, expectedCompany: null,
    seed: [],
    subject: '双十一课程优惠', received: '2026-10-30T08:00:00.000Z',
    body: '双十一限时优惠，购买求职课程立减 300 元，点击领取优惠券。'
  },
  {
    id: 'old_event', expected: 'ignored', expectedStatus: null, expectedCompany: '旧邮件科技',
    seed: [{ company: '旧邮件科技', title: '后端开发', status: 'interview' }],
    subject: '旧面试通知', received: '2026-10-01T01:00:00.000Z',
    body: '旧邮件科技\n恭喜您进入后端开发岗位面试，请于2026年10月2日参加面试。'
  }
];

db.getDb();
const results = [];
for (const [index, sample] of samples.entries()) {
  const ownerId = `usr_eval_${index}`;
  db.run(`INSERT INTO users (id,email_normalized,email_display,allowlisted,created_at) VALUES (?,?,?,?,?)`,
    [ownerId, `eval${index}@test.local`, `eval${index}@test.local`, 1, util.nowIso()]);
  const seeded = sample.seed.map((s) => applications.createApplication({
    ownerId, sourceMethod: 'manual', status: s.status,
    fields: { company_name: s.company, job_title: s.title, applied_at: '2026-09-01T00:00:00.000Z', applied_at_precision: 'date', jd_summary: '用于评估的岗位背景' },
    at: '2026-09-01T00:00:00.000Z'
  }));
  if (sample.id === 'old_event' && seeded[0]) {
    db.run('UPDATE applications SET last_status_changed_at=?, stage_received_at=? WHERE id=?',
      ['2026-10-31T00:00:00.000Z', '2026-10-31T00:00:00.000Z', seeded[0].id]);
  }
  const eventId = util.newId('evt');
  const payload = {
    source_mail_id: null, source_received_at: sample.received, category: 'other', confidence: 0.4,
    status_text: '招聘邮件', mapped_status: null, company_name: null, job_title: null,
    from_domain: 'jobs.example.com', subject_excerpt: sample.subject,
    body_excerpt: sample.body, ai_body_excerpt: sample.body, read_mode: 'recruitment_body', field_confidence: {}
  };
  db.run(`INSERT INTO events
    (id,owner_id,client_event_id,source_method,event_type,occurred_at,observed_at,received_at,schema_version,
     evidence_level,evidence_code,payload_json,payload_hash,processing_state)
    VALUES (?,?,?, 'mail','mail_progress_detected',?,?,?,'C1','strong','eval',?,?,'pending')`,
  [eventId, ownerId, `mail:${eventId}`, sample.received, sample.received, util.nowIso(), JSON.stringify(payload), util.newId('ph')]);
  const event = { ...db.one('SELECT * FROM events WHERE id=?', [eventId]), payload };
  let result;
  try {
    result = await processIntakeEvent(event, { bodyText: sample.body, subject: sample.subject, fromDomain: 'jobs.example.com', statusText: '招聘邮件', receivedAt: sample.received });
  } catch (err) {
    result = { state: 'error', error: err.code || err.message };
  }
  const reviewCount = db.one("SELECT COUNT(*) n FROM review_items WHERE owner_id=? AND status='open'", [ownerId]).n;
  const run = db.one('SELECT * FROM ai_ingest_runs WHERE event_id=?', [eventId]);
  const current = result.application ? db.one('SELECT id,company_name,job_title,status,has_applied FROM applications WHERE id=?', [result.application.id]) : null;
  const auto = result.state === 'applied';
  const decision = auto ? (result.change === 'created' ? 'created' : result.change === 'updated' ? 'updated' : 'no_change') : (result.state === 'retry' ? 'retry' : result.state === 'ignored' ? 'ignored' : result.state === 'pending' ? 'review' : 'error');
  const correctDecision = decision === sample.expected;
  const statusCorrect = !sample.expectedStatus || current?.status === sample.expectedStatus;
  const targetCorrect = !sample.expectedCompany || (current?.company_name === sample.expectedCompany);
  results.push({
    id: sample.id, expected: sample.expected, decision,
    expected_status: sample.expectedStatus, actual_status: current?.status || null,
    expected_company: sample.expectedCompany, actual_company: current?.company_name || null,
    review_count: reviewCount, correct_decision: correctDecision,
    status_correct: statusCorrect, target_correct: targetCorrect,
    reason: run?.reason_code || result.reason || null, error: result.error || null
  });
}
const auto = results.filter((r) => ['created', 'updated'].includes(r.decision));
const wrongStatus = auto.filter((r) => !r.status_correct).length;
const wrongTarget = auto.filter((r) => !r.target_correct).length;
const correctAuto = auto.filter((r) => r.correct_decision && r.status_correct && r.target_correct).length;
const actionable = results.filter((r) => ['created', 'updated', 'review'].includes(r.expected));
const actionableAutoExpected = results.filter((r) => ['created', 'updated'].includes(r.expected));
const report = {
  sample_size: results.length,
  auto_processed: auto.length,
  auto_correct: correctAuto,
  auto_accuracy: auto.length ? Number((correctAuto / auto.length).toFixed(3)) : null,
  auto_coverage: Number((auto.length / results.length).toFixed(3)),
  actionable_sample: actionable.length,
  actionable_auto_expected: actionableAutoExpected.length,
  actionable_auto_coverage: actionableAutoExpected.length ? Number((correctAuto / actionableAutoExpected.length).toFixed(3)) : null,
  review_count: results.filter((r) => r.decision === 'review').length,
  review_ratio: Number((results.filter((r) => r.decision === 'review').length / results.length).toFixed(3)),
  ignored_count: results.filter((r) => r.decision === 'ignored').length,
  technical_failures: results.filter((r) => r.decision === 'retry' || r.decision === 'error').length,
  wrong_status_updates: wrongStatus,
  wrong_candidate_matches: wrongTarget,
  results,
  limitations: ['合成中文样本，非真实用户邮件；样本量小', '未覆盖 IMAP 真实邮箱/正文截断/多语言', '模型与 Jev 输出有随机性；未做重复稳定性测试']
};
console.log(JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(DATA, 'report.json'), JSON.stringify(report, null, 2));
db.closeDb();
