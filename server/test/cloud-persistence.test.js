import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tounar-cloud-persistence-'));
process.env.DATA_DIR = dir;
process.env.MASTER_KEY = 'ab'.repeat(32);
process.env.CLOUD_SNAPSHOT_STREAM = 'unit-test-stream';
process.env.CLOUD_PERSISTENCE_ENABLED = 'false';
const db = await import('../src/db.js');
const persistence = await import('../src/cloud/persistence.js');
const rows = [];
let insertError = null;
const client = {
  database: {
    from(table) {
      assert.equal(table, 'app_sqlite_snapshot_vault');
      return {
        select() { return this; },
        eq(_field, value) { this.stream = value; return this; },
        order() { return this; },
        limit(value) { this.take = value; return this; },
        then(resolve) {
          const data = rows.filter((row) => row.stream === this.stream)
            .sort((a, b) => b.revision - a.revision).slice(0, this.take)
            .map((row) => ({ ...row }));
          return Promise.resolve(resolve({ data, error: null }));
        }
      };
    },
    async rpc(name, args) {
      assert.equal(name, 'append_app_sqlite_snapshot');
      assert.ok(args.p_writer_token);
      if (insertError) return { data: null, error: insertError };
      const current = Math.max(0, ...rows.filter((row) => row.stream === args.p_stream).map((row) => row.revision));
      if (current !== args.p_expected_revision) return { data: null, error: { code: 'SNAP1' } };
      rows.push({
        id: args.p_id, stream: args.p_stream, revision: args.p_revision,
        payload: args.p_payload, content_sha256: args.p_content_sha256
      });
      return { data: args.p_revision, error: null };
    }
  }
};

after(() => {
  db.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Node 22 无 backup() 时，checkpoint 同步复制仍包含 WAL 且不留下明文附属文件', async () => {
  const sourcePath = path.join(dir, 'node22-source.sqlite');
  const target = path.join(dir, 'node22-copy.sqlite');
  let source = null;
  let copy = null;
  try {
    source = new DatabaseSync(sourcePath);
    source.exec('PRAGMA journal_mode = WAL');
    source.exec('CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT)');
    source.prepare('INSERT INTO items (id, value) VALUES (?, ?)').run('wal-row', 'included');
    assert.equal(fs.existsSync(`${sourcePath}-wal`), true, '测试必须真实覆盖 WAL 路径');
    await persistence.createConsistentSnapshot(source, target, null);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    copy = new DatabaseSync(target, { readOnly: true });
    assert.equal(copy.prepare('SELECT value FROM items WHERE id = ?').get('wal-row').value, 'included');
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    if (copy) copy.close();
    if (source) source.close();
    for (const file of [sourcePath, target]) {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
    }
  }
});

test('加密云快照：WAL 写入、故障重试、删除本地后恢复、损坏与冲突拒绝', async () => {
  let initialized = await persistence.initCloudPersistence({ injectedClient: client });
  assert.equal(initialized.restored, false);
  db.getDb();
  db.run(`INSERT INTO users (id,email_normalized,email_display,allowlisted,created_at)
    VALUES ('usr_cloud_test','cloud@example.test','cloud@example.test',1,'2026-11-02T00:00:00.000Z')`);
  await persistence.flushCloudPersistence();
  assert.equal(rows.length, 1);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes('.snapshot-')), false, '快照上传后不得遗留明文临时库');
  assert.equal(persistence.cloudPersistenceStatus().revision, 1);
  assert.notEqual(rows[0].payload.includes('cloud@example.test'), true, '云端不得保存明文邮箱');

  db.closeDb();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(dir, `tounar.sqlite${suffix}`), { force: true });
  initialized = await persistence.initCloudPersistence({ injectedClient: client });
  assert.equal(initialized.restored, true);
  assert.equal(db.getUserByEmail('cloud@example.test').id, 'usr_cloud_test');

  insertError = { code: 'TEMPORARY_FAILURE' };
  db.run("UPDATE users SET last_login_at = '2026-11-02T01:00:00.000Z' WHERE id = 'usr_cloud_test'");
  await assert.rejects(persistence.flushCloudPersistence(), (error) => error?.code === 'TEMPORARY_FAILURE');
  assert.equal(persistence.cloudPersistenceStatus().state, 'degraded');
  assert.equal(persistence.cloudPersistenceStatus().pending, true);
  assert.equal(persistence.cloudPersistenceStatus().last_error_code, 'TEMPORARY_FAILURE');
  insertError = null;
  await persistence.flushCloudPersistence();
  assert.equal(persistence.cloudPersistenceStatus().revision, 2);
  assert.equal(persistence.cloudPersistenceStatus().last_error_code, null);

  insertError = { code: 'DATABASE_SNAP1' };
  db.run("UPDATE users SET last_login_at = '2026-11-02T01:30:00.000Z' WHERE id = 'usr_cloud_test'");
  await assert.rejects(persistence.flushCloudPersistence(), (error) => error?.code === 'DATABASE_SNAP1');
  assert.equal(persistence.cloudPersistenceStatus().state, 'conflict', '平台前缀不得把 revision 冲突降级成普通重试');
  insertError = null;
  db.closeDb();
  initialized = await persistence.initCloudPersistence({ injectedClient: client });
  assert.equal(initialized.revision, 2);

  db.closeDb();
  rows.push({ id: 'tampered', stream: 'unit-test-stream', revision: 3, payload: '{}', content_sha256: '0'.repeat(64) });
  initialized = await persistence.initCloudPersistence({ injectedClient: client });
  assert.equal(initialized.restored, true);
  assert.equal(initialized.revision, 2, '损坏的新快照不得遮蔽最后一个有效快照');
  assert.equal(db.getUserByEmail('cloud@example.test').last_login_at, '2026-11-02T01:00:00.000Z');

  db.run("UPDATE users SET last_login_at = '2026-11-02T02:00:00.000Z' WHERE id = 'usr_cloud_test'");
  await assert.rejects(persistence.flushCloudPersistence(), /another writer/);
  assert.equal(persistence.cloudPersistenceStatus().state, 'conflict');
  assert.equal(rows.filter((row) => row.revision === 4).length, 0, '冲突时不得覆盖云端');
  assert.throws(() => persistence.decryptSnapshot(rows[0].payload, Buffer.alloc(32), 'unit-test-stream', 1));

  db.closeDb();
  rows.splice(0, rows.length, { id: 'only-bad', stream: 'unit-test-stream', revision: 5, payload: '{}', content_sha256: '0'.repeat(64) });
  await assert.rejects(
    persistence.initCloudPersistence({ injectedClient: client }),
    (error) => error?.code === 'CLOUD_SNAPSHOT_RESTORE_FAILED'
  );
  assert.equal(persistence.cloudPersistenceStatus().state, 'degraded');
  assert.equal(persistence.cloudPersistenceStatus().last_error_code, 'CLOUD_SNAPSHOT_RESTORE_FAILED');
  assert.equal(fs.readdirSync(dir).some((name) => name.includes('.restore-')), false, `拒绝快照后不得遗留明文临时库: ${fs.readdirSync(dir).join(',')}`);
});
