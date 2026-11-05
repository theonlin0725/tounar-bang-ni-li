import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { newId, nowIso } from './util.js';

let db = null;
let txDepth = 0;
let persistenceHook = null;

export function setPersistenceHook(hook) {
  persistenceHook = hook || null;
}

function notifyCommittedWrite() {
  if (txDepth === 0 && persistenceHook) persistenceHook();
}

export function getDb() {
  if (!db) db = openDatabase(config.dbPath);
  return db;
}

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const instance = new DatabaseSync(dbPath);
  instance.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  instance.exec(schema);
  migrate(instance);
  return instance;
}

/* 轻量迁移：D06 冻结（2026-10-22）后新装库默认 daily；
   老库一次性把 weekly_monday 迁到 daily，并补 D08 的待确认摘要时间列。 */
function migrate(instance) {
  const addColumn = (table, column, definition) => {
    if (!instance.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) instance.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  addColumn('notification_preferences', 'stage_followup_days', 'INTEGER NOT NULL DEFAULT 7 CHECK (stage_followup_days IN (0,7,14))');
  addColumn('notification_outbox', 'source_received_at', 'TEXT');
  addColumn('applications', 'jd_text', 'TEXT');
  addColumn('applications', 'jd_status', "TEXT NOT NULL DEFAULT 'missing'");
  addColumn('applications', 'capture_source', 'TEXT');
  addColumn('applications', 'stage_received_at', 'TEXT');
  addColumn('applications', 'stage_anchor_at', 'TEXT');
  addColumn('applications', 'stage_last_notified_anchor', 'TEXT');
  addColumn('applications', 'manual_status_at', 'TEXT');
  addColumn('ai_ingest_runs', 'rule_version', "TEXT NOT NULL DEFAULT 'auto-intake-v1'");
  addColumn('application_field_sources', 'confidence', "TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high'))");
  addColumn('application_field_sources', 'source_detail', 'TEXT');
  if (!instance.prepare("SELECT value FROM meta WHERE key = 'migration_phase2_confidence'").get()) {
    instance.exec("UPDATE application_field_sources SET confidence = 'high' WHERE source_method = 'manual'");
    instance.prepare("INSERT INTO meta(key,value) VALUES ('migration_phase2_confidence','1')").run();
  }
  if (!instance.prepare("SELECT value FROM meta WHERE key = 'migration_phase2_followup'").get()) {
    instance.exec(`UPDATE notification_outbox SET source_received_at = COALESCE(
      (SELECT m.received_at FROM events e JOIN mail_messages m ON e.owner_id=m.owner_id AND e.connection_id=m.connection_id
        AND e.mailbox=m.mailbox AND e.uidvalidity=m.uidvalidity AND e.uid=m.uid WHERE e.id=notification_outbox.event_id), occurred_at)
      WHERE source_received_at IS NULL;
      UPDATE applications SET stage_received_at = COALESCE(last_status_changed_at, applied_at),
        stage_anchor_at = MAX(COALESCE(last_status_changed_at, applied_at, ''), COALESCE(interview_scheduled_at, ''))
        WHERE status IN ('assessment','interview') AND stage_anchor_at IS NULL;`);
    instance.prepare("INSERT INTO meta (key, value) VALUES ('migration_phase2_followup', '1')").run();
  }
  if (!instance.prepare("SELECT value FROM meta WHERE key = 'migration_phase2_mail_link'").get()) {
    instance.exec(`UPDATE review_items SET source_mail_id = (
      SELECT m.id FROM events e JOIN mail_messages m ON m.owner_id = e.owner_id
        AND m.connection_id = e.connection_id AND m.mailbox = e.mailbox
        AND m.uidvalidity = e.uidvalidity AND m.uid = e.uid
      WHERE e.id = review_items.source_event_id AND e.owner_id = review_items.owner_id
      LIMIT 1) WHERE status = 'open' AND source_mail_id IS NULL`);
    instance.prepare("INSERT INTO meta (key, value) VALUES ('migration_phase2_mail_link', '1')").run();
  }
  addColumn('notification_preferences', 'last_review_digest_at', 'TEXT');
  addColumn('mail_test_runs', 'request_hash', "TEXT NOT NULL DEFAULT ''");
  const done = instance.prepare("SELECT value FROM meta WHERE key = 'migration_d06_daily'").get();
  if (!done) {
    instance.exec("UPDATE notification_preferences SET review_frequency = 'daily' WHERE review_frequency = 'weekly_monday'");
    instance.prepare("INSERT INTO meta (key, value) VALUES ('migration_d06_daily', '1')").run();
  }
}

export function closeDb() {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
}

export function transaction(fn) {
  const database = getDb();
  if (txDepth > 0) return fn(database);
  database.exec('BEGIN IMMEDIATE');
  txDepth++;
  let committed = false;
  try {
    const result = fn(database);
    database.exec('COMMIT');
    committed = true;
    return result;
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    txDepth--;
    if (committed) notifyCommittedWrite();
  }
}

export function one(sql, params = []) {
  return getDb().prepare(sql).get(...params) || null;
}

export function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

export function run(sql, params = []) {
  const result = getDb().prepare(sql).run(...params);
  notifyCommittedWrite();
  return result;
}

export function bumpRevision() {
  getDb().prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'data_revision'").run();
  notifyCommittedWrite();
}

export function dataRevision() {
  return one("SELECT value FROM meta WHERE key = 'data_revision'")?.value || '1';
}

export function ensurePreferences(ownerId) {
  getDb().prepare(`INSERT OR IGNORE INTO notification_preferences
    (owner_id, mode, review_frequency, review_threshold_days, version, updated_at)
    VALUES (?, 'all', 'daily', 14, 1, ?)`).run(ownerId, nowIso());
  notifyCommittedWrite();
}

export function getUserByEmail(email) {
  return one('SELECT * FROM users WHERE email_normalized = ?', [email]);
}

export function getApplication(ownerId, applicationId) {
  return one('SELECT * FROM applications WHERE id = ? AND owner_id = ?', [applicationId, ownerId]);
}

export function markApplicationChanged(ownerId, applicationId, eventId, sourceMethod, fields, options = {}) {
  const app = one('SELECT * FROM applications WHERE id = ? AND owner_id = ?', [applicationId, ownerId]);
  if (!app) return null;
  fields = { ...fields };
  const targetStatus = fields.status || app.status;
  if (!('stage_anchor_at' in fields) && ['assessment', 'interview'].includes(targetStatus) && (targetStatus !== app.status || ('interview_scheduled_at' in fields && fields.interview_scheduled_at !== app.interview_scheduled_at))) {
    const event = eventId ? one('SELECT source_method, occurred_at, payload_json FROM events WHERE id = ? AND owner_id = ?', [eventId, ownerId]) : null;
    const payload = event ? JSON.parse(event.payload_json || '{}') : {};
    const received = targetStatus === app.status ? (app.stage_received_at || app.last_status_changed_at || nowIso())
      : (event?.source_method === 'mail' ? (payload.source_received_at || event.occurred_at) : fields.last_status_changed_at || event?.occurred_at || nowIso());
    fields.stage_received_at = received;
    const scheduled = targetStatus === 'interview' ? (fields.interview_scheduled_at ?? app.interview_scheduled_at) : null;
    fields.stage_anchor_at = scheduled && Date.parse(scheduled) > Date.parse(received) ? scheduled : received;
    if (targetStatus !== app.status) { fields.last_reviewed_at = null; fields.stage_last_notified_anchor = null; }
  }
  const changed = Object.keys(fields);
  if (!changed.length) return app;
  const sets = changed.map((f) => `${f} = ?`).join(', ');
  const values = changed.map((f) => fields[f]);
  getDb().prepare(`UPDATE applications SET ${sets}, updated_at = ?, version = version + 1 WHERE id = ? AND owner_id = ?`)
    .run(...values, nowIso(), applicationId, ownerId);
  notifyCommittedWrite();
  getDb().prepare(`INSERT INTO application_history
    (id, owner_id, application_id, event_id, from_status, to_status, changed_fields_json, changed_at, source_method, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      newId('hist'),
      ownerId,
      applicationId,
      eventId || null,
      app.status,
      fields.status || app.status,
      JSON.stringify(Object.fromEntries(changed.map((k) => [k, { from: app[k], to: fields[k] }]))),
      nowIso(),
      sourceMethod,
      options.reason || null
    );
  notifyCommittedWrite();
  for (const field of changed) {
    const sourceEvent = eventId ? one('SELECT payload_json FROM events WHERE id = ? AND owner_id = ?', [eventId, ownerId]) : null;
    const payload = sourceEvent ? JSON.parse(sourceEvent.payload_json || '{}') : {};
    const confidence = sourceMethod === 'manual' ? 'high' : (options.fieldConfidence?.[field] || payload.field_confidence?.[field] || 'medium');
    getDb().prepare(`INSERT INTO application_field_sources
      (application_id, owner_id, field, source_method, event_id, updated_at, confidence, source_detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(application_id, field) DO UPDATE SET source_method=excluded.source_method,
        event_id=excluded.event_id, updated_at=excluded.updated_at, confidence=excluded.confidence, source_detail=excluded.source_detail`)
      .run(applicationId, ownerId, field, sourceMethod, eventId || null, nowIso(), confidence, payload.field_sources?.[field] || null);
    notifyCommittedWrite();
  }
  bumpRevision();
  notifyCommittedWrite();
  return one('SELECT * FROM applications WHERE id = ? AND owner_id = ?', [applicationId, ownerId]);
}
