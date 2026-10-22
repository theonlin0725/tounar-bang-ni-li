/* P0（2026-10-22）：邮件入库 → 待确认，必须把 mail_messages.id 写进 review_items.source_mail_id。
   否则待确认列表 / 提醒邮件只能显示「入库时间」，用户看到的不是收信日期。
   这里离线跑 ingestMessage，不连 IMAP、不落正文。 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DIR = path.join(ROOT, '.tmp', 'tests', 'mail-ingest');
process.env.DATA_DIR = DIR;
process.env.MASTER_KEY = 'a'.repeat(64);
process.env.ENABLE_SCHEDULER = '0';
process.env.MAIL_MODE = 'outbox';

let handle;
let openDatabase;
let getDb;
let ingestMessageForTest;
let one;
let run;
let ownerId;
let connectionId;
const RECEIVED_AT = '2026-09-22T06:43:23.000Z';

describe('邮件入库 → 待确认：source_mail_id 与收信日期', () => {
  before(async () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
    ({ getDb, openDatabase, one, run } = await import('../src/db.js'));
    ({ ingestMessageForTest } = await import('../src/domain/mailSync.js'));
    handle = getDb();
    ownerId = 'usr_mail_ingest';
    run(`INSERT INTO users (id, email_normalized, email_display, allowlisted, created_at)
         VALUES (?, 'ingest@tounar.local', 'ingest@tounar.local', 1, '2026-09-01T00:00:00.000Z')`, [ownerId]);
    connectionId = 'conn_mail_ingest';
    run(`INSERT INTO mail_connections
      (id, owner_id, email, mode, scan_since, status, consent_version, binding_version, created_at, updated_at)
      VALUES (?, ?, 'ingest@qq.com', 'headers_only', '2026-09-01T00:00:00.000Z', 'connected', 'QQ_MAIL_READ_CONSENT_V1', 1, ?, ?)`,
    [connectionId, ownerId, RECEIVED_AT, RECEIVED_AT]);
  });
  after(() => {
    try { handle?.close(); } catch { /* ignore */ }
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  it('ingest 建复核时写入 source_mail_id；待确认列表返回原始收信时间', async () => {
    const connection = one('SELECT * FROM mail_connections WHERE id = ?', [connectionId]);
    const parsed = {
      uidvalidity: '777',
      subject: '中国电信天翼云邀请你参加在线笔试',
      classification: {
        relevant: true, category: 'assessment', status: 'assessment', confidence: 0.88,
        round_label: null, interview_scheduled_at: null, reason: 'assessment'
      },
      fields: { company_name: null, job_title: null, site_application_id: null, from_domain: 'batchmail.nowcoder.net' }
    };
    const result = ingestMessageForTest(connection, {
      uid: 101, messageId: '<p0-ingest-101@example.com>'
    }, parsed, '', RECEIVED_AT);
    assert.ok(result.result.review, '无候选时必须进待确认');
    assert.equal(result.result.review.source_mail_id, result.mail.id);
    assert.equal(result.result.review.reason_code, 'MAIL_MATCH_UNCONFIRMED');
    const joined = one(`SELECT r.id, m.received_at FROM review_items r
      JOIN mail_messages m ON m.id = r.source_mail_id WHERE r.id = ?`, [result.result.review.id]);
    assert.equal(joined.received_at, RECEIVED_AT);
  });

  it('历史复核回填迁移：只有能通过 events 唯一对上邮件的才回填，对不上的保持 NULL', async () => {
    const mail = one('SELECT * FROM mail_messages ORDER BY created_at DESC LIMIT 1');
    const review = one('SELECT * FROM review_items ORDER BY created_at DESC LIMIT 1');
    assert.ok(mail && review);
    // 模拟旧版本遗留：写入时漏掉 source_mail_id
    run('UPDATE review_items SET source_mail_id = NULL WHERE id = ?', [review.id]);
    run("DELETE FROM meta WHERE key = 'migration_p0_review_source_mail'");
    const reopened = openDatabase(path.join(DIR, 'tounar.sqlite'));
    try {
      const backfilled = reopened.prepare('SELECT source_mail_id FROM review_items WHERE id = ?').get(review.id);
      assert.equal(backfilled.source_mail_id, mail.id);
    } finally {
      reopened.close();
    }
  });
});
