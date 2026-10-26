import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer } from './helpers.js';

const SCRIPT = fileURLToPath(new URL('../scripts/repair-browse-reviews.js', import.meta.url));
const OWNER = 'audit-owner';
let server;
let dbFile;

function insertEvent(db, id, payload, siteKey = 'generic') {
  db.prepare(`INSERT INTO events (id, owner_id, client_event_id, source_method, event_type, site_key,
    occurred_at, observed_at, received_at, schema_version, evidence_level, evidence_code, payload_json, payload_hash,
    processing_state) VALUES (?,?,?,'plugin','job_viewed',?,?,?,?,?,'strong','test',?,?,'pending')`)
    .run(id, OWNER, id, siteKey, '2026-10-20T02:00:00Z', '2026-10-20T02:00:05Z', '2026-10-20T02:00:05Z', 'C1', JSON.stringify(payload), id);
}
function insertReview(db, id, eventId) {
  db.prepare(`INSERT INTO review_items (id, owner_id, kind, reason_code, summary, evidence_json, suggested_changes_json,
    candidates_json, source_event_id, status, version, created_at) VALUES (?,?,'field_missing','VIEW_FIELDS_INCOMPLETE','x','{}','{}','[]',?,'open',1,?)`)
    .run(id, OWNER, eventId, '2026-10-20T02:00:06Z');
}

before(async () => {
  server = await startTestServer({ name: 'repair-browse' });
  await server.stop({ keepData: true });
  dbFile = path.join(server.dir, 'tounar.sqlite');
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO users (id,email_normalized,email_display,created_at) VALUES (?,?,?,?)')
    .run(OWNER, 'audit@tounar.local', 'audit@tounar.local', '2026-10-20T00:00:00Z');
  insertEvent(db, 'evt-a', { company_name: '甲科技', job_title: '后端工程师', site_job_id: 'job-1',
    job_url: 'https://jobs.example.com/job/1?utm_source=x', jd_text: '岗位职责\n负责服务端开发\n任职要求\n熟悉 Node' });
  insertReview(db, 'rev-a', 'evt-a');
  insertEvent(db, 'evt-b', { company_name: '乙公司', job_title: '测试岗', site_job_id: 'job-1',
    job_url: 'https://other.example.com/job/9', jd_text: '另一个岗位' }, 'othersite');
  insertReview(db, 'rev-b', 'evt-b');
  db.close();
});
after(async () => { await server.stop({ keepData: false }); });

describe('历史浏览复核迁移', () => {
  it('迁移保留身份字段与 JD，并关联事件；跨站点同 ID 不合并；重复执行幂等', () => {
    execFileSync(process.execPath, [SCRIPT, '--db', dbFile, '--apply'], { encoding: 'utf8' });
    let db = new DatabaseSync(dbFile);
    const app = db.prepare(`SELECT * FROM applications WHERE owner_id=? AND company_name='甲科技'`).get(OWNER);
    assert.ok(app, '应建立记录');
    assert.equal(app.site_job_id, 'job-1');
    assert.ok(app.canonical_job_url.includes('/job/1'));
    assert.ok(String(app.jd_text).includes('任职要求'));
    assert.equal(app.status, 'pending'); assert.equal(app.has_applied, 0);
    assert.equal(db.prepare('SELECT application_id FROM events WHERE id=?').get('evt-a').application_id, app.id);
    assert.equal(db.prepare('SELECT status FROM review_items WHERE id=?').get('rev-a').status, 'resolved');

    const appB = db.prepare(`SELECT * FROM applications WHERE owner_id=? AND company_name='乙公司'`).get(OWNER);
    assert.ok(appB, '不同站点同 ID 应各自建档');
    assert.notEqual(appB.id, app.id);
    assert.equal(appB.site_key, 'othersite');
    db.close();

    const before = new DatabaseSync(dbFile);
    const countBefore = before.prepare('SELECT COUNT(*) n FROM applications WHERE owner_id=?').get(OWNER).n;
    before.close();
    execFileSync(process.execPath, [SCRIPT, '--db', dbFile, '--apply'], { encoding: 'utf8' });
    const after = new DatabaseSync(dbFile);
    assert.equal(after.prepare('SELECT COUNT(*) n FROM applications WHERE owner_id=?').get(OWNER).n, countBefore, '重复执行不应新增');
    after.close();
  });
});
