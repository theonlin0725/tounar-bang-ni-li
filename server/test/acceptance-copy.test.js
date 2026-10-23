import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/export-acceptance-copy.js', import.meta.url));

test('acceptance copy keeps legacy business records and WAL writes, removes secrets without changing source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tounar-export-'));
  const source = path.join(dir, 'source.sqlite');
  const out = path.join(dir, 'export');
  const db = new DatabaseSync(source);
  try {
    db.exec(fs.readFileSync(new URL('../../tests/fixtures/schema-v1.sql', import.meta.url), 'utf8'));
    db.exec("INSERT INTO users(id,email_normalized,email_display,created_at) VALUES ('u','fixture@local','fixture@local','2026-10-20')");
    db.exec("INSERT INTO mail_connections(id,owner_id,email,mode,scan_since,status,consent_version,credential_ciphertext,credential_iv,credential_tag,created_at,updated_at) VALUES ('m','u','fixture@local','headers_only','2026-10-01','connected','v1','fixture-ciphertext-never-export','fixture-iv-never-export','fixture-tag-never-export','2026-10-20','2026-10-20')");
    db.exec("INSERT INTO mail_messages(id,owner_id,connection_id,mailbox,uidvalidity,uid,received_at,created_at) VALUES ('mail','u','m','INBOX','1','1','2026-10-18','2026-10-20')");
    db.exec("INSERT INTO review_items(id,owner_id,kind,reason_code,summary,source_mail_id,created_at) VALUES ('review','u','mail_progress','MAIL_MATCH_UNCONFIRMED','真实结构的待确认测试','mail','2026-10-20')");
    db.exec("INSERT INTO sessions(id,token_hash,owner_id,created_at,auth_at,expires_at) VALUES ('s','fixture-token-never-export','u','2026-10-20','2026-10-20','2026-11-20')");
    const command = file => spawnSync(process.execPath, [script, '--db', source, '--out', file], { encoding: 'utf8' });
    const result = command(out);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(db.prepare('SELECT status FROM mail_connections').get().status, 'connected');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
    const clone = new DatabaseSync(path.join(out, 'tounar.sqlite'), { readOnly: true });
    try {
      assert.equal(clone.prepare('SELECT source_mail_id FROM review_items').get().source_mail_id, 'mail');
      assert.equal(clone.prepare('SELECT COUNT(*) AS n FROM mail_messages').get().n, 1);
      assert.deepEqual({ ...clone.prepare('SELECT status,credential_ciphertext,credential_iv,credential_tag FROM mail_connections').get() }, { status: 'disconnected', credential_ciphertext: null, credential_iv: null, credential_tag: null });
      assert.equal(clone.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
      assert.deepEqual(clone.prepare('PRAGMA table_info(applications)').all(), db.prepare('PRAGMA table_info(applications)').all());
    } finally { clone.close(); }
    const bytes = fs.readFileSync(path.join(out, 'tounar.sqlite'));
    for (const value of ['fixture-ciphertext-never-export','fixture-iv-never-export','fixture-tag-never-export','fixture-token-never-export']) assert.equal(bytes.includes(Buffer.from(value)), false);
    assert.equal(fs.statSync(out).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(out, 'tounar.sqlite')).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(out).sort(), ['manifest.json', 'tounar.sqlite']);
    assert.notEqual(command(out).status, 0, 'existing export must not be overwritten');
    assert.deepEqual(fs.readFileSync(path.join(out, 'tounar.sqlite')), bytes);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed export removes its incomplete private copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tounar-export-error-'));
  try {
    const source = path.join(dir, 'invalid.sqlite'); const out = path.join(dir, 'export');
    fs.writeFileSync(source, 'not a database');
    const result = spawnSync(process.execPath, [script, '--db', source, '--out', out], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.equal(fs.existsSync(out), false);
    assert.equal(fs.readFileSync(source, 'utf8'), 'not a database');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
