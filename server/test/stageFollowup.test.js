/* P3（2026-10-22）：阶段回看提醒。
   覆盖：7/14/关闭、阶段推进作废旧提醒、确认后重新计时、终态排除、
   原始收信日期进入邮件落款/主题，以及「该回看了」的三个链接。 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DIR = path.join(ROOT, '.tmp', 'tests', 'stage-followup');
process.env.DATA_DIR = DIR;
process.env.MASTER_KEY = 'd'.repeat(64);
process.env.ENABLE_SCHEDULER = '0';
process.env.MAIL_MODE = 'outbox';
process.env.APP_BASE_URL = 'http://127.0.0.1:4310';

let run;
let one;
let ensurePreferences;
let createApplication;
let applyStatusTransition;
let markApplicationReviewed;
let buildReminderCandidates;
let runReminderForOwner;
let config;

const DAY = 86400000;
const now = () => new Date();
const daysFromNow = (n) => new Date(Date.now() + n * DAY);

function newOwner(suffix) {
  const ownerId = `usr_stage_${suffix}`;
  const email = `${suffix}@stage.local`;
  run(`INSERT INTO users (id, email_normalized, email_display, created_at)
       VALUES (?, ?, ?, ?)`, [ownerId, email, email, now().toISOString()]);
  ensurePreferences(ownerId);
  run(`UPDATE notification_preferences
       SET mode = 'all', review_frequency = 'daily', review_threshold_days = 14,
           stage_followup_days = 7, updated_at = ? WHERE owner_id = ?`,
  [now().toISOString(), ownerId]);
  return ownerId;
}

function setStageDays(ownerId, days) {
  run('UPDATE notification_preferences SET stage_followup_days = ?, updated_at = ? WHERE owner_id = ?',
    [days, now().toISOString(), ownerId]);
}

function seedApp(ownerId, {
  company = '阶段公司', title = '数据分析师', status = 'interview', at = daysFromNow(-20).toISOString(),
  jobUrl = 'https://jobs.example.com/stage/followup'
} = {}) {
  return createApplication({
    ownerId,
    fields: {
      company_name: company,
      job_title: title,
      channel: '官网',
      jd_summary: '阶段回看测试',
      job_url: jobUrl,
      applied_at: at
    },
    eventId: null,
    sourceMethod: 'manual',
    status,
    at
  });
}

function eventFor(ownerId, application, occurredAt, payload = {}) {
  return {
    id: `evt_stage_${Math.random().toString(36).slice(2, 10)}`,
    owner_id: ownerId,
    occurred_at: occurredAt,
    observed_at: occurredAt,
    evidence_level: 'strong',
    evidence_code: 'user-explicit',
    payload
  };
}

function candidateFor(ownerId, applicationId, at) {
  return buildReminderCandidates(ownerId, at).c.find((x) => x.app.id === applicationId) || null;
}

function latestReminder() {
  const files = fs.existsSync(config.outboxDir)
    ? fs.readdirSync(config.outboxDir).filter((f) => f.endsWith('.json')) : [];
  const records = files.map((f) => JSON.parse(fs.readFileSync(path.join(config.outboxDir, f), 'utf8')))
    .filter((r) => r.kind === 'reminder')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return records[records.length - 1] || null;
}

function shanghaiLabel(iso, full = false) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return full ? `${get('year')}年${get('month')}月${get('day')}日` : `${get('month')}月${get('day')}日`;
}

describe('P3 阶段回看：锚点、7/14/关闭、作废与确认重计时', () => {
  before(async () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
    const db = await import('../src/db.js');
    run = db.run;
    one = db.one;
    ensurePreferences = db.ensurePreferences;
    const applications = await import('../src/domain/applications.js');
    createApplication = applications.createApplication;
    applyStatusTransition = applications.applyStatusTransition;
    const reviews = await import('../src/domain/reviews.js');
    markApplicationReviewed = reviews.markApplicationReviewed;
    const reminders = await import('../src/domain/reminders.js');
    buildReminderCandidates = reminders.buildReminderCandidates;
    runReminderForOwner = reminders.runReminderForOwner;
    config = (await import('../src/config.js')).config;
  });
  after(async () => {
    const db = await import('../src/db.js');
    db.closeDb?.();
  });

  it('7 天 / 14 天 / 关闭三档只在锚点到期后出现', () => {
    const ownerId = newOwner('thresholds');
    const base = daysFromNow(-20);
    const app = seedApp(ownerId, { company: '阈值公司', title: '阶段岗位', at: base.toISOString() });

    setStageDays(ownerId, 7);
    assert.equal(candidateFor(ownerId, app.id, new Date(base.getTime() + 6 * DAY)), null);
    assert.equal(candidateFor(ownerId, app.id, new Date(base.getTime() + 7 * DAY))?.days, 7);

    setStageDays(ownerId, 14);
    assert.equal(candidateFor(ownerId, app.id, new Date(base.getTime() + 7 * DAY)), null);
    assert.equal(candidateFor(ownerId, app.id, new Date(base.getTime() + 14 * DAY))?.days, 14);

    setStageDays(ownerId, 0);
    assert.equal(candidateFor(ownerId, app.id, new Date(base.getTime() + 20 * DAY)), null);
  });

  it('阶段推进后旧提醒作废，按新阶段锚点重新计', () => {
    const ownerId = newOwner('progress');
    const base = daysFromNow(-20);
    const app = seedApp(ownerId, { company: '推进公司', title: '推进岗位', status: 'applied', at: base.toISOString() });

    const interview = applyStatusTransition(app, 'interview', eventFor(ownerId, app, base.toISOString()), {
      sourceMethod: 'manual', reviewTerminal: false
    });
    assert.equal(interview.ok, true);
    assert.equal(interview.app.stage_followup_anchor, base.toISOString());

    const offer = applyStatusTransition(interview.app, 'offer', eventFor(ownerId, interview.app, new Date(base.getTime() + 3 * DAY).toISOString()), {
      sourceMethod: 'manual', reviewTerminal: false
    });
    assert.equal(offer.ok, true);
    assert.equal(offer.app.stage_followup_anchor, null);
    assert.equal(candidateFor(ownerId, app.id, new Date(base.getTime() + 10 * DAY)), null);
  });

  it('笔试→面试：旧阶段提醒作废，面试锚点重新计时', () => {
    const ownerId = newOwner('restage');
    const base = daysFromNow(-20);
    const app = seedApp(ownerId, { company: '重排公司', title: '重排岗位', status: 'applied', at: base.toISOString() });
    const assessment = applyStatusTransition(app, 'assessment', eventFor(ownerId, app, base.toISOString()), {
      sourceMethod: 'manual', reviewTerminal: false
    });
    assert.equal(assessment.app.stage_followup_anchor, base.toISOString());
    const interviewAt = new Date(base.getTime() + 2 * DAY).toISOString();
    const interview = applyStatusTransition(assessment.app, 'interview', eventFor(ownerId, assessment.app, interviewAt), {
      sourceMethod: 'manual', reviewTerminal: false
    });
    assert.equal(interview.ok, true);
    assert.equal(interview.app.stage_followup_anchor, interviewAt);
    assert.equal(candidateFor(ownerId, app.id, new Date(base.getTime() + 7 * DAY)), null);
    assert.equal(candidateFor(ownerId, app.id, new Date(base.getTime() + 9 * DAY))?.days, 7);
  });

  it('用户确认“状态无变化”后从确认时间重新计时', () => {
    const ownerId = newOwner('confirm');
    const base = daysFromNow(-20);
    const app = seedApp(ownerId, { company: '确认公司', title: '确认岗位', at: base.toISOString() });
    const before = candidateFor(ownerId, app.id, now());
    assert.ok(before, '确认前应已到期');

    const reviewed = markApplicationReviewed({
      ownerId, applicationId: app.id, expectedVersion: app.version, context: 'ledger'
    });
    assert.ok(Date.parse(reviewed.application.stage_followup_anchor) >= Date.now() - 5000);
    assert.equal(candidateFor(ownerId, app.id, new Date(Date.now() + 6 * DAY)), null);
    assert.ok(candidateFor(ownerId, app.id, new Date(Date.now() + 7 * DAY)));
  });

  it('终态不进入阶段回看', () => {
    const ownerId = newOwner('terminal');
    const app = seedApp(ownerId, { company: '终态公司', title: '终态岗位', status: 'rejected', at: daysFromNow(-20).toISOString() });
    assert.equal(app.stage_followup_anchor, null);
    assert.equal(candidateFor(ownerId, app.id, now()), null);
  });

  it('邮件落款用原始收信日期；「该回看了」含状态页/确认/详情三个链接', async () => {
    const ownerId = newOwner('mail');
    const receivedAt = daysFromNow(-10);
    const occurredAt = new Date(receivedAt.getTime() + DAY).toISOString();
    const app = seedApp(ownerId, {
      company: '落款公司', title: '落款岗位', at: receivedAt.toISOString(),
      jobUrl: 'https://jobs.example.com/stage/letter'
    });
    run(`INSERT INTO notification_outbox
      (id, owner_id, application_id, event_id, kind, summary, occurred_at, source_received_at, created_at)
      VALUES (?, ?, ?, NULL, 'status_change', ?, ?, ?, ?)`,
    ['out_stage_letter', ownerId, app.id, '落款公司 · 落款岗位：已投递 → 面试中',
      occurredAt, receivedAt.toISOString(), now().toISOString()]);

    const sent = await runReminderForOwner(ownerId, new Date(receivedAt.getTime() + 7 * DAY), { force: true });
    assert.equal(sent.status, 'sent');
    assert.equal(sent.items_c, 1);
    const mail = latestReminder();
    assert.ok(mail, '应写出 reminder outbox');
    assert.ok(mail.subject.includes(`（${shanghaiLabel(receivedAt)}收到）`), mail.subject);
    assert.ok(!mail.subject.includes(shanghaiLabel(occurredAt)), '主题日期不能用入库/事件时间');
    assert.ok(mail.text.includes(`—— ${shanghaiLabel(receivedAt, true)} 收到`), mail.text);
    assert.ok(mail.text.includes('该回看了'));
    assert.ok(mail.text.includes('https://jobs.example.com/stage/letter'));
    assert.ok(/\/r\/rl_[A-Za-z0-9_-]+/.test(mail.text));
    assert.ok(mail.text.includes(`/?app=${app.id}`));
    assert.equal((mail.html.match(/该回看了/g) || []).length >= 1, true);
    assert.ok(mail.html.includes('https://jobs.example.com/stage/letter'));
    assert.ok(mail.html.includes(`/?app=${app.id}`));

    const batch = one('SELECT * FROM notification_batches WHERE owner_id = ?', [ownerId]);
    assert.equal(batch.item_count_c, 1);
    const followup = one("SELECT * FROM notification_batch_items WHERE batch_id = ? AND kind = 'followup'", [batch.id]);
    assert.ok(followup);
    assert.equal(JSON.parse(followup.snapshot_json).stage_followup_days, 7);
  });
});
