/* P2（2026-10-22）：邮件联动台账。
   覆盖：别名/岗位相似度匹配、单候选自动更新、总把握度不足进待确认、
   多候选必须明确选择、邮件确认补 inferred_before 投递时间、自动更新可撤回且防陈旧覆盖。 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DIR = path.join(ROOT, '.tmp', 'tests', 'mail-auto-update');
process.env.DATA_DIR = DIR;
process.env.MASTER_KEY = 'b'.repeat(64);
process.env.ENABLE_SCHEDULER = '0';
process.env.MAIL_MODE = 'outbox';

let handle;
let getDb;
let one;
let run;
let ownerId;
let connectionId;
let createApplication;
let findMailCandidates;
let ingestMessageForTest;
let reviewDetail;
let resolveReview;
let undoAutoMailUpdate;

const RECEIVED_AT = '2026-10-20T06:43:23.000Z';
const OWNER = 'usr_mail_auto';
let uidSeed = 500;

function connection() {
  return one('SELECT * FROM mail_connections WHERE id = ?', [connectionId]);
}

function seedApp({ company, title, status = 'applied', hasApplied = true, appliedAt = '2026-09-01T00:00:00.000Z' }) {
  return createApplication({
    ownerId,
    fields: {
      company_name: company,
      job_title: title,
      channel: '官网',
      jd_summary: '回归测试',
      job_url: `https://jobs.example.com/p2/${encodeURIComponent(company)}/${encodeURIComponent(title)}`,
      applied_at: appliedAt
    },
    eventId: null,
    sourceMethod: 'manual',
    status,
    at: appliedAt || RECEIVED_AT
  });
}

function ingest({ subject, company, title, category = 'interview', status = 'interview', confidence = 0.92, fromDomain = 'jobs.example.com', receivedAt = RECEIVED_AT }) {
  const uid = uidSeed++;
  return ingestMessageForTest(connection(), {
    uid,
    messageId: `<p2-${uid}@example.com>`
  }, {
    uidvalidity: '888',
    subject,
    classification: {
      relevant: true,
      category,
      status,
      confidence,
      round_label: null,
      interview_scheduled_at: null,
      reason: category
    },
    fields: { company_name: company, job_title: title, site_application_id: null, from_domain: fromDomain }
  }, '', receivedAt);
}

function latestHistory(appId, prefix = '邮件自动判定') {
  return one(`SELECT * FROM application_history WHERE owner_id = ? AND application_id = ?
    AND reason LIKE ? ORDER BY changed_at DESC, rowid DESC LIMIT 1`, [ownerId, appId, `${prefix}%`]);
}

describe('P2 邮件联动：匹配、自动更新、待确认补齐与撤回', () => {
  before(async () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
    ({ getDb, one, run } = await import('../src/db.js'));
    ({ ingestMessageForTest } = await import('../src/domain/mailSync.js'));
    ({
      createApplication, findMailCandidates, undoAutoMailUpdate
    } = await import('../src/domain/applications.js'));
    ({ reviewDetail } = await import('../src/domain/ledger.js'));
    ({ resolveReview } = await import('../src/domain/reviews.js'));
    handle = getDb();
    ownerId = OWNER;
    run(`INSERT INTO users (id, email_normalized, email_display, allowlisted, created_at)
         VALUES (?, 'auto@tounar.local', 'auto@tounar.local', 1, '2026-09-01T00:00:00.000Z')`, [ownerId]);
    connectionId = 'conn_mail_auto';
    run(`INSERT INTO mail_connections
      (id, owner_id, email, mode, scan_since, status, consent_version, binding_version, created_at, updated_at)
      VALUES (?, ?, 'auto@qq.com', 'headers_only', '2026-09-01T00:00:00.000Z', 'connected', 'QQ_MAIL_READ_CONSENT_V1', 1, ?, ?)`,
    [connectionId, ownerId, RECEIVED_AT, RECEIVED_AT]);
  });

  after(() => {
    try { handle?.close(); } catch { /* ignore */ }
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  it('公司别名 + 岗位相似度：单候选高把握度直接改台账，不建待确认', async () => {
    const app = seedApp({ company: '字节跳动', title: '前端开发实习生' });
    const result = ingest({
      subject: '【字节跳动】前端开发实习生 面试邀请',
      company: 'ByteDance',
      title: '前端开发',
      category: 'interview',
      status: 'interview',
      confidence: 0.92,
      fromDomain: 'bytedance.com'
    });
    assert.equal(result.result.state, 'applied', JSON.stringify(result.result));
    assert.equal(result.result.auto_updated, true);
    const updated = one('SELECT * FROM applications WHERE id = ?', [app.id]);
    assert.equal(updated.status, 'interview');
    assert.equal(updated.has_applied, 1);
    assert.equal(updated.applied_at, '2026-09-01T00:00:00.000Z', '已有投递时间不能被邮件收信时间覆盖');
    const hist = latestHistory(app.id);
    assert.ok(hist);
    assert.match(hist.reason, /^邮件自动判定：10月20日 《/);
    assert.equal(one('SELECT COUNT(*) AS n FROM review_items WHERE owner_id = ?', [ownerId]).n, 0);
  });

  it('已浏览未投递 + 面邀：自动补 has_applied 与 inferred_before 投递时间', async () => {
    const app = seedApp({ company: '招商银行', title: '数据分析师', status: 'pending', hasApplied: false, appliedAt: null });
    const result = ingest({
      subject: '【面试通知】您已成功预约招商银行面试',
      company: '招商银行',
      title: '数据分析师',
      category: 'interview',
      status: 'interview',
      confidence: 0.92,
      fromDomain: 'message.cmbchina.com'
    });
    assert.equal(result.result.state, 'applied', JSON.stringify(result.result));
    const updated = one('SELECT * FROM applications WHERE id = ?', [app.id]);
    assert.equal(updated.status, 'interview');
    assert.equal(updated.has_applied, 1);
    assert.equal(updated.applied_at, RECEIVED_AT);
    assert.equal(updated.applied_at_precision, 'inferred_before');
  });

  it('同公司多个进行中：不自动改，待确认里列出全部候选且不预选', async () => {
    const pm = seedApp({ company: '腾讯', title: '产品经理' });
    const ops = seedApp({ company: '腾讯', title: '产品运营' });
    const result = ingest({
      subject: '腾讯 产品经理 面试通知',
      company: 'Tencent',
      title: '产品经理',
      category: 'interview',
      status: 'interview',
      confidence: 0.92,
      fromDomain: 'tencent.com'
    });
    assert.equal(result.result.state, 'pending');
    const reviewId = result.result.review.id;
    const detail = reviewDetail(ownerId, reviewId).data;
    assert.equal(detail.reason_code, 'MULTIPLE_APPLICATION_CANDIDATES');
    assert.equal(detail.candidate_count, 2);
    assert.equal(detail.suggested_application_id, null, '多个候选不能预选');
    assert.equal(detail.total_confidence, 0.828);
    const ids = detail.candidates.map((c) => c.application_id).sort();
    assert.deepEqual(ids, [pm.id, ops.id].sort());

    const fresh = one('SELECT * FROM applications WHERE id = ?', [pm.id]);
    const resolved = resolveReview({
      ownerId,
      reviewId,
      expectedVersion: detail.version,
      action: 'confirm',
      applicationId: pm.id,
      expectedApplicationVersion: fresh.version,
      changes: { status: 'interview' },
      reason: '用户选择产品经理'
    });
    assert.equal(resolved.application.status, 'interview');
    assert.equal(one('SELECT status FROM applications WHERE id = ?', [ops.id]).status, 'applied', '未选中的记录不能动');
  });

  it('总把握度不足进待确认；确认时按收信时间补 inferred_before', async () => {
    const app = seedApp({ company: '中国电子云', title: '数据分析师', status: 'pending', hasApplied: false, appliedAt: null });
    const result = ingest({
      subject: '中国电子云校园招聘测评通知',
      company: '中国电子云',
      title: '数据分析师',
      category: 'assessment',
      status: 'assessment',
      confidence: 0.4
    });
    assert.equal(result.result.state, 'pending');
    const reviewId = result.result.review.id;
    const detail = reviewDetail(ownerId, reviewId).data;
    assert.equal(detail.reason_code, 'MAIL_SUGGESTED_NEEDS_CONFIRM');
    assert.equal(detail.candidate_count, 1);
    assert.equal(detail.suggested_application_id, app.id);
    assert.equal(detail.total_confidence, 0.36);

    const fresh = one('SELECT * FROM applications WHERE id = ?', [app.id]);
    const resolved = resolveReview({
      ownerId,
      reviewId,
      expectedVersion: detail.version,
      action: 'confirm',
      applicationId: app.id,
      expectedApplicationVersion: fresh.version,
      changes: { status: 'assessment' },
      reason: '确认邮件是测评'
    });
    assert.equal(resolved.application.status, 'assessment');
    assert.equal(resolved.application.has_applied, 1);
    assert.equal(resolved.application.applied_at, RECEIVED_AT);
    assert.equal(resolved.application.applied_at_precision, 'inferred_before');
  });

  it('自动更新可撤回；字段被后续改动后拒绝整条撤回', async () => {
    const app = seedApp({ company: '美团', title: '商业分析师' });
    const result = ingest({
      subject: '美团 商业分析师 面试邀请',
      company: '美团',
      title: '商业分析师',
      category: 'interview',
      status: 'interview',
      confidence: 0.92,
      fromDomain: 'meituan.com'
    });
    assert.equal(result.result.state, 'applied');
    const hist = latestHistory(app.id);
    assert.ok(hist);
    let current = one('SELECT * FROM applications WHERE id = ?', [app.id]);
    assert.equal(current.status, 'interview');

    // 模拟后续被别的链路改过（版本不 bump，专门校验逐字段陈旧保护）
    run("UPDATE applications SET status = 'offer' WHERE id = ?", [app.id]);
    assert.throws(() => undoAutoMailUpdate({
      ownerId, applicationId: app.id, historyId: hist.id, expectedVersion: current.version
    }), (err) => err.status === 409 && err.code === 'VERSION_CONFLICT');

    run("UPDATE applications SET status = 'interview' WHERE id = ?", [app.id]);
    current = one('SELECT * FROM applications WHERE id = ?', [app.id]);
    const undone = undoAutoMailUpdate({
      ownerId, applicationId: app.id, historyId: hist.id, expectedVersion: current.version
    });
    assert.equal(undone.changed, true);
    const restored = one('SELECT * FROM applications WHERE id = ?', [app.id]);
    assert.equal(restored.status, 'applied');
    assert.equal(restored.has_applied, 1);
    assert.match(one(`SELECT reason FROM application_history WHERE owner_id = ? AND application_id = ?
      ORDER BY changed_at DESC, rowid DESC LIMIT 1`, [ownerId, app.id]).reason, /用户撤回/);
  });

  it('匹配分档：申请编号 1.0、公司+岗位 0.9、公司唯一进行中 0.85、多候选 0.5', async () => {
    const exact = seedApp({ company: '网易', title: '游戏策划' });
    run("UPDATE applications SET site_key = 'generic', site_application_id = 'APP-P2-1' WHERE id = ?", [exact.id]);
    const exactMatch = findMailCandidates(ownerId, { site_key: 'generic', site_application_id: 'APP-P2-1' });
    assert.equal(exactMatch[0].match_confidence, 1);

    // 同公司另一条记录是噪声：申请编号唯一命中时不能把候选拖成 2 条。
    seedApp({ company: '网易', title: '游戏运营' });
    const exactWithNoise = findMailCandidates(ownerId, {
      site_key: 'generic', site_application_id: 'APP-P2-1',
      company_name: '网易', job_title: '游戏策划'
    });
    assert.equal(exactWithNoise.length, 1);
    assert.equal(exactWithNoise[0].application.id, exact.id);
    assert.equal(exactWithNoise[0].match_confidence, 1);

    const titleMatch = findMailCandidates(ownerId, { company_name: '美团', job_title: '商业分析' });
    assert.equal(titleMatch.length, 1);
    assert.equal(titleMatch[0].match_confidence, 0.9);

    seedApp({ company: '哔哩哔哩', title: '内容运营', status: 'pending', hasApplied: false, appliedAt: null });
    const single = findMailCandidates(ownerId, { company_name: 'bilibili' });
    assert.equal(single.length, 1);
    assert.equal(single[0].match_confidence, 0.85);

    seedApp({ company: '哔哩哔哩', title: '社区运营', status: 'pending', hasApplied: false, appliedAt: null });
    const multi = findMailCandidates(ownerId, { company_name: 'B站' });
    assert.equal(multi.length, 2);
    assert.ok(multi.every((c) => c.match_confidence === 0.5));
  });
});
