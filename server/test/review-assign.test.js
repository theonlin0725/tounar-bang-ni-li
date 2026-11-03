import { before, after, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, strongViewEvent } from './helpers.js';
import { DatabaseSync } from 'node:sqlite';

let server, cookie, token;
before(async () => {
  server = await startTestServer({ name: 'review-assign' });
  cookie = (await server.login('demo@tounar.local')).cookie;
  token = (await server.pairDevice(cookie)).device_token;
});
after(async () => server?.stop());

async function ingest(event) {
  return (await server.eventBatch(token, [event])).json.results[0];
}
function key(prefix) { return prefix + '-' + crypto.randomUUID(); }
async function assign(reviewId, body, idem = key('review-assign')) {
  return server.request(`/api/v1/review-items/${reviewId}/assign`, {
    method: 'POST', cookie, headers: { 'Idempotency-Key': idem }, body
  });
}
async function reviewDetail(id) { return (await server.request(`/api/v1/review-items/${id}`, { cookie })).json.data; }
async function appDetail(id) { return (await server.request(`/api/v1/applications/${id}`, { cookie })).json.data; }
async function ledger(view) { return (await server.request(`/api/v1/ledger?view=${view}&limit=100`, { cookie })).json.data; }

it('插件线索不选已有记录，直接按“看过没投”创建并展示可读内容', async () => {
  const result = await ingest(strongViewEvent({ event_type: 'job_viewed', evidence_level: 'weak', payload: {
    company_name: '直接入账公司', job_title: '浏览岗位', site_job_id: null, job_url: null,
    jd_summary: '负责用户研究和产品方案，这是页面上的真实摘要。', visible_dwell_ms: 4200
  } }));
  assert.ok(result.review_item_id, JSON.stringify(result));
  const detail = await reviewDetail(result.review_item_id);
  assert.equal(detail.display.source, 'plugin');
  assert.equal(detail.display.source_label, '插件');
  assert.equal(detail.display.title, '浏览岗位');
  assert.ok(detail.display.preview.includes('用户研究'));
  assert.ok(detail.display.full_text.includes('用户研究'));
  assert.equal(detail.display.suggested_status, 'pending');
  assert.ok(!JSON.stringify(detail.display).includes('系统判断'));
  const response = await assign(result.review_item_id, { status: 'pending', expected_version: detail.version });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.data.created, true);
  assert.equal(response.json.data.application.status, 'pending');
  assert.equal(response.json.data.application.has_applied, 0);
  assert.equal((await reviewDetail(result.review_item_id)).status, 'resolved');
  const viewed = await ledger('viewed');
  assert.ok(viewed.items.some((x) => x.id === response.json.data.application.id));
});

it('“已投递”缺少实际投递时间时拒绝；补上后创建，且不把确认时间当投递时间', async () => {
  const result = await ingest(strongViewEvent({ event_type: 'job_viewed', evidence_level: 'weak', payload: {
    company_name: '投递公司', job_title: '投递岗位', site_job_id: null, job_url: null,
    jd_summary: '负责交付与沟通。', visible_dwell_ms: 4200
  } }));
  assert.ok(result.review_item_id, JSON.stringify(result));
  const blocked = await assign(result.review_item_id, { status: 'applied', expected_version: 1 });
  assert.equal(blocked.status, 422, blocked.text);
  assert.equal(blocked.json.error.code, 'APPLIED_AT_REQUIRED');
  const appliedAt = '2026-10-15T04:00:00.000Z';
  const response = await assign(result.review_item_id, { status: 'applied', applied_at: appliedAt, expected_version: 1 });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.data.created, true);
  assert.equal(response.json.data.application.status, 'applied');
  assert.equal(response.json.data.application.applied_at, appliedAt);
  assert.equal(response.json.data.application.has_applied, 1);
});

it('唯一强身份命中已有“看过没投”时原地转为已投递，保留原记录/历史并移出看过没投', async () => {
  const jobUrl = 'https://jobs.example.com/jobs/review-update-1';
  const pending = await ingest(strongViewEvent({ event_type: 'job_captured', payload: {
    company_name: '更新公司', job_title: '更新岗位', site_job_id: 'review-update-1', job_url: jobUrl,
    jd_summary: '原记录已有 JD 摘要。', location: '上海', visible_dwell_ms: 4200
  } }));
  assert.ok(pending.application_id);
  assert.equal(pending.review_item_id, null);
  const review = await ingest(strongViewEvent({ event_type: 'application_submitted', evidence_level: 'weak', payload: {
    company_name: '更新公司', job_title: '更新岗位', site_job_id: 'review-update-1', job_url: jobUrl,
    jd_summary: '新线索摘要', visible_dwell_ms: 4200
  } }));
  assert.ok(review.review_item_id, JSON.stringify(review));
  const appliedAt = '2026-10-16T04:30:00.000Z';
  const response = await assign(review.review_item_id, { status: 'applied', applied_at: appliedAt, expected_version: 1 });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.data.created, false);
  assert.equal(response.json.data.application.id, pending.application_id);
  assert.equal(response.json.data.application.company_name, '更新公司');
  assert.equal(response.json.data.application.applied_at, appliedAt);
  const viewed = await ledger('viewed');
  const applied = await ledger('applied');
  assert.ok(!viewed.items.some((x) => x.id === pending.application_id), '应从看过没投移出');
  assert.ok(applied.items.some((x) => x.id === pending.application_id), '应进入投递明细');
  const detail = await appDetail(pending.application_id);
  assert.ok(detail.history.length >= 2, '应保留历史');
});

it('重复提交同一幂等键复用结果；已处理后用新键返回 already_resolved，不重复创建/更新', async () => {
  const result = await ingest(strongViewEvent({ event_type: 'job_viewed', evidence_level: 'weak', payload: {
    company_name: '幂等公司', job_title: '幂等岗位', site_job_id: null, job_url: null, visible_dwell_ms: 4200
  } }));
  const detail = await reviewDetail(result.review_item_id);
  const idem = key('duplicate-assign');
  const first = await assign(result.review_item_id, { status: 'pending', expected_version: detail.version }, idem);
  assert.equal(first.status, 200, first.text);
  const appId = first.json.data.application.id;
  const again = await assign(result.review_item_id, { status: 'pending', expected_version: detail.version }, idem);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.data.application.id, appId);
  const after = await assign(result.review_item_id, { status: 'pending', expected_version: detail.version }, key('duplicate-assign-new'));
  assert.equal(after.status, 200, after.text);
  assert.equal(after.json.data.already_resolved, true);
  assert.equal(after.json.data.application.id, appId);
  const viewed = await ledger('viewed');
  assert.equal(viewed.items.filter((x) => x.id === appId).length, 1);
});

it('请求失败/版本冲突时待确认项保持 open，输入参数不被吞掉', async () => {
  const result = await ingest(strongViewEvent({ event_type: 'job_viewed', evidence_level: 'weak', payload: {
    company_name: '冲突公司', job_title: '冲突岗位', site_job_id: null, job_url: null, visible_dwell_ms: 4200
  } }));
  const blocked = await assign(result.review_item_id, { status: 'pending', expected_version: 999 });
  assert.equal(blocked.status, 409, blocked.text);
  assert.equal((await reviewDetail(result.review_item_id)).status, 'open');
});

it('强身份命中多条已有记录时返回归属冲突，选择目标后可解决', async () => {
  const db = new DatabaseSync(server.dir + '/tounar.sqlite');
  const now = new Date().toISOString();
  let owner;
  try {
    owner = db.prepare("SELECT id FROM users WHERE email_normalized='demo@tounar.local'").get().id;
    const url = 'https://jobs.example.com/jobs/ambiguous-1';
    for (const id of ['app_amb_1', 'app_amb_2']) {
      db.prepare(`INSERT INTO applications
        (id,owner_id,company_name,company_key,job_title,status,has_applied,job_url,canonical_job_url,channel,source_methods_json,version,created_at,updated_at)
        VALUES (?,?,?,?,?,'pending',0,?,?, '手动','["plugin"]',1,?,?)`)
        .run(id, owner, '歧义公司', '歧义公司', '歧义岗位', url, url, now, now);
    }
    const payload = { company_name: '歧义公司', job_title: '歧义岗位', job_url: url, jd_summary: '歧义测试 JD' };
    db.prepare(`INSERT INTO events
      (id,owner_id,client_event_id,source_method,event_type,occurred_at,observed_at,received_at,schema_version,evidence_level,payload_hash,payload_json,processing_state)
      VALUES ('evt_amb_1',?,'evt_amb_1','plugin','job_viewed',?,?,?,'C1','strong','hash',?,'pending')`)
      .run(owner, now, now, now, JSON.stringify(payload));
    db.prepare(`INSERT INTO review_items
      (id,owner_id,kind,reason_code,summary,evidence_json,suggested_changes_json,candidates_json,source_event_id,status,version,created_at)
      VALUES ('rev_amb_1',?,'ambiguous_match','MULTIPLE_APPLICATION_CANDIDATES','请选择归属',?, '{}', '[]','evt_amb_1','open',1,?)`)
      .run(owner, JSON.stringify({ page: { type: 'page', ...payload } }), now);
  } finally { db.close(); }
  const conflict = await assign('rev_amb_1', { status: 'pending', expected_version: 1 });
  assert.equal(conflict.status, 409, conflict.text);
  assert.equal(conflict.json.error.code, 'REVIEW_ASSIGN_AMBIGUOUS');
  assert.equal(conflict.json.error.details.candidates.length, 2);
  assert.equal((await reviewDetail('rev_amb_1')).status, 'open');
  const target = conflict.json.error.details.candidates[0];
  const resolved = await assign('rev_amb_1', {
    status: 'pending', expected_version: 1,
    application_id: target.application_id, expected_application_version: target.application_version
  });
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(resolved.json.data.application.id, target.application_id);
  assert.equal((await reviewDetail('rev_amb_1')).status, 'resolved');
});

it('公司和岗位都为空时拒绝入账；待确认保持 open，不创建空白台账', async () => {
  const r1 = (await ingest(strongViewEvent({ event_type: 'application_submitted', evidence_level: 'weak', payload: {
    company_name: null, job_title: null, site_job_id: null, job_url: null,
    jd_summary: null, status_text: '收到一条无法识别岗位的招聘线索', visible_dwell_ms: 4200
  } }))).review_item_id;
  const d1 = await reviewDetail(r1);
  assert.ok(d1, '应进入待确认');
  const res1 = await assign(r1, { status: 'pending', expected_version: d1.version });
  assert.equal(res1.status, 422, res1.text);
  assert.equal(res1.json.error.code, 'REVIEW_FIELDS_REQUIRED');
  assert.equal((await reviewDetail(r1)).status, 'open');
  const db = new DatabaseSync(server.dir + '/tounar.sqlite');
  try {
    assert.equal(db.prepare("SELECT COUNT(*) n FROM applications WHERE company_name='' AND job_title=''").get().n, 0);
  } finally { db.close(); }
});

it('台账状态直接编辑：保存、历史、统计联动，旧版本拒绝，已投回顾不可撤销已投事实', async () => {
  const captured = await ingest(strongViewEvent({ event_type: 'job_captured', payload: {
    company_name: '直改状态公司', job_title: '直改状态岗位', site_job_id: 'status-edit-1',
    job_url: 'https://jobs.example.com/status-edit-1', jd_summary: '状态直改测试', visible_dwell_ms: 4200
  } }));
  assert.ok(captured.application_id);
  const appId = captured.application_id;
  const before = await appDetail(appId);
  const appliedAt = '2026-10-20T04:00:00.000Z';
  const saved = await server.request(`/api/v1/applications/${appId}/status`, {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key('status-edit') },
    body: { status: 'interview', applied_at: appliedAt, expected_version: before.version }
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.data.status, 'interview');
  assert.equal(saved.json.data.has_applied, 1);
  assert.equal(saved.json.data.applied_at, appliedAt);
  assert.ok(saved.json.data.manual_status_at);
  const history = saved.json.data.history || [];
  assert.ok(history.some((h) => h.from_status === 'pending' && h.to_status === 'interview' && h.source_method === 'manual'));
  const appliedLedger = await ledger('applied');
  assert.ok(appliedLedger.items.some((x) => x.id === appId));
  const stale = await server.request(`/api/v1/applications/${appId}/status`, {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key('status-edit-stale') },
    body: { status: 'offer', expected_version: before.version }
  });
  assert.equal(stale.status, 409, stale.text);
  const removal = await server.request(`/api/v1/applications/${appId}/status`, {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key('status-edit-removal') },
    body: { status: 'pending', expected_version: saved.json.data.version }
  });
  assert.equal(removal.status, 403, removal.text);
});
