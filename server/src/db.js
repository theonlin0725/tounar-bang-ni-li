import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { newId, nowIso } from './util.js';

let db = null;
let txDepth = 0;

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
  if (!instance.prepare("SELECT value FROM meta WHERE key = 'migration_phase2_mail_link'").get()) {
    instance.exec(`UPDATE review_items SET source_mail_id = (
      SELECT m.id FROM events e JOIN mail_messages m ON m.owner_id = e.owner_id
        AND m.connection_id = e.connection_id AND m.mailbox = e.mailbox
        AND m.uidvalidity = e.uidvalidity AND m.uid = e.uid
      WHERE e.id = review_items.source_event_id AND e.owner_id = review_items.owner_id
      LIMIT 1) WHERE status = 'open' AND source_mail_id IS NULL`);
    instance.prepare("INSERT INTO meta (key, value) VALUES ('migration_phase2_mail_link', '1')").run();
  }
  try {
    instance.exec('ALTER TABLE notification_preferences ADD COLUMN last_review_digest_at TEXT');
  } catch { /* 列已存在（schema.sql 新版本已建） */ }
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
  try {
    const result = fn(database);
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try { database.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    txDepth--;
  }
}

export function one(sql, params = []) {
  return getDb().prepare(sql).get(...params) || null;
}

export function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

export function bumpRevision() {
  getDb().prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'data_revision'").run();
}

export function dataRevision() {
  return one("SELECT value FROM meta WHERE key = 'data_revision'")?.value || '1';
}

export function ensurePreferences(ownerId) {
  getDb().prepare(`INSERT OR IGNORE INTO notification_preferences
    (owner_id, mode, review_frequency, review_threshold_days, version, updated_at)
    VALUES (?, 'all', 'daily', 14, 1, ?)`).run(ownerId, nowIso());
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
  const changed = Object.keys(fields);
  if (!changed.length) return app;
  const sets = changed.map((f) => `${f} = ?`).join(', ');
  const values = changed.map((f) => fields[f]);
  getDb().prepare(`UPDATE applications SET ${sets}, updated_at = ?, version = version + 1 WHERE id = ? AND owner_id = ?`)
    .run(...values, nowIso(), applicationId, ownerId);
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
  for (const field of changed) {
    getDb().prepare(`INSERT INTO application_field_sources
      (application_id, owner_id, field, source_method, event_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(application_id, field) DO UPDATE SET source_method=excluded.source_method,
        event_id=excluded.event_id, updated_at=excluded.updated_at`)
      .run(applicationId, ownerId, field, sourceMethod, eventId || null, nowIso());
  }
  bumpRevision();
  return one('SELECT * FROM applications WHERE id = ? AND owner_id = ?', [applicationId, ownerId]);
}
