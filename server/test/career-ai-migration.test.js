import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.js';

const paths = [];
after(() => { for (const p of paths) { for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true }); } });

it('旧 ai_reports 的 kind CHECK 自动迁移并保留旧报告', () => {
  const dbPath = path.join(os.tmpdir(), `tounar-ai-reports-migrate-${process.pid}-${Date.now()}.sqlite`);
  paths.push(dbPath);
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE ai_reports (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, resume_id TEXT,
    application_ids_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'running',
    result_json TEXT, error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, completed_at TEXT,
    CHECK (kind IN ('resume','compare','recommend')), CHECK (status IN ('running','ready','failed'))
  );`);
  old.prepare("INSERT INTO ai_reports (id,owner_id,kind,status,created_at) VALUES ('old-report','u','compare','ready','2026-01-01T00:00:00.000Z')").run();
  old.close();

  const db = openDatabase(dbPath);
  try {
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_reports'").get();
    assert.match(table.sql, /'match'/);
    const columns = db.prepare('PRAGMA table_info(ai_reports)').all().map((c) => c.name);
    assert.ok(columns.includes('context_json'));
    assert.ok(columns.includes('parent_report_id'));
    assert.ok(columns.includes('report_version'));
    const preserved = db.prepare("SELECT id, kind FROM ai_reports WHERE id='old-report'").get();
    assert.deepEqual({ id: preserved.id, kind: preserved.kind }, { id: 'old-report', kind: 'compare' });
    const correctionTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_match_corrections'").get();
    assert.equal(correctionTable.name, 'ai_match_corrections');
    db.prepare('INSERT INTO users (id,email_normalized,email_display,created_at) VALUES (?,?,?,?)')
      .run('u', 'migration@example.com', 'migration@example.com', '2026-01-01T00:00:00.000Z');
    db.prepare("INSERT INTO ai_reports (id,owner_id,kind,status,report_version,created_at) VALUES ('new-match','u','match','ready','match-v1','2026-01-02T00:00:00.000Z')").run();
    db.prepare("INSERT INTO ai_reports (id,owner_id,kind,status,parent_report_id,report_version,created_at) VALUES ('child-match','u','match','ready','new-match','match-v1','2026-01-03T00:00:00.000Z')").run();
    const matchRow = db.prepare("SELECT kind,report_version,parent_report_id FROM ai_reports WHERE id='child-match'").get();
    assert.deepEqual({ kind: matchRow.kind, report_version: matchRow.report_version, parent: matchRow.parent_report_id },
      { kind: 'match', report_version: 'match-v1', parent: 'new-match' });
  } finally {
    db.close();
  }
});
