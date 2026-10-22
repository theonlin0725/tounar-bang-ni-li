import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { maxIso, newId, nowIso } from './util.js';

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
  try {
    instance.exec('ALTER TABLE notification_preferences ADD COLUMN last_review_digest_at TEXT');
  } catch { /* 列已存在（schema.sql 新版本已建） */ }
  const done = instance.prepare("SELECT value FROM meta WHERE key = 'migration_d06_daily'").get();
  if (!done) {
    instance.exec("UPDATE notification_preferences SET review_frequency = 'daily' WHERE review_frequency = 'weekly_monday'");
    instance.prepare("INSERT INTO meta (key, value) VALUES ('migration_d06_daily', '1')").run();
  }
  /* P0（2026-10-22）：修 source_mail_id 不写入的历史遗留。
     只回填能通过 events(connection_id/mailbox/uidvalidity/uid) 唯一对上邮件的复核项；
     对不上（插件来源 / 邮件已清理）的保持 NULL，前端按创建时间显示，不编造收信日期。 */
  const mailBackfill = instance.prepare("SELECT value FROM meta WHERE key = 'migration_p0_review_source_mail'").get();
  if (!mailBackfill) {
    instance.exec(`UPDATE review_items SET source_mail_id = (
      SELECT m.id FROM events e JOIN mail_messages m
        ON m.connection_id = e.connection_id AND m.mailbox = e.mailbox
       AND m.uidvalidity = e.uidvalidity AND m.uid = e.uid
      WHERE e.id = review_items.source_event_id
      LIMIT 1)
      WHERE source_mail_id IS NULL AND source_event_id IS NOT NULL`);
    instance.prepare("INSERT INTO meta (key, value) VALUES ('migration_p0_review_source_mail', '1')").run();
  }
  /* P3（2026-10-22）：阶段回看锚点、推送邮件原始收信日期、C 类批次计数。
     只做增量列与一次性回填，不删表、不改旧值。 */
  for (const sql of [
    'ALTER TABLE applications ADD COLUMN stage_followup_anchor TEXT',
    'ALTER TABLE notification_preferences ADD COLUMN stage_followup_days INTEGER NOT NULL DEFAULT 7 CHECK (stage_followup_days IN (0,7,14))',
    'ALTER TABLE notification_outbox ADD COLUMN source_received_at TEXT',
    'ALTER TABLE notification_batches ADD COLUMN item_count_c INTEGER NOT NULL DEFAULT 0'
  ]) {
    try { instance.exec(sql); } catch { /* 列已存在（schema.sql 新版本已建） */ }
  }
  const stageAnchorBackfill = instance.prepare("SELECT value FROM meta WHERE key = 'migration_p3_stage_followup_anchor'").get();
  if (!stageAnchorBackfill) {
    instance.exec(`UPDATE applications SET stage_followup_anchor = CASE
      WHEN status = 'interview' AND interview_scheduled_at IS NOT NULL
        AND (last_status_changed_at IS NULL OR interview_scheduled_at > last_status_changed_at)
        THEN interview_scheduled_at
      WHEN status IN ('assessment','interview')
        THEN COALESCE(last_status_changed_at, updated_at, created_at)
      ELSE NULL END
      WHERE stage_followup_anchor IS NULL`);
    instance.prepare("INSERT INTO meta (key, value) VALUES ('migration_p3_stage_followup_anchor', '1')").run();
  }
  const outboxBackfill = instance.prepare("SELECT value FROM meta WHERE key = 'migration_p3_outbox_source_received_at'").get();
  if (!outboxBackfill) {
    instance.exec(`UPDATE notification_outbox SET source_received_at = COALESCE(
      (SELECT e.occurred_at FROM events e WHERE e.id = notification_outbox.event_id),
      occurred_at, created_at)
      WHERE source_received_at IS NULL`);
    instance.prepare("INSERT INTO meta (key, value) VALUES ('migration_p3_outbox_source_received_at', '1')").run();
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
  /* P3：状态进入笔试/面试时自动维护阶段回看锚点；进入其它状态则作废旧锚点。
     邮件/插件来源已在 fields.last_status_changed_at 带入原始事件时间，因此锚点不会漂移。 */
  const data = { ...fields };
  if (data.status !== undefined) {
    if (data.status === 'assessment' || data.status === 'interview') {
      if (data.stage_followup_anchor == null) {
        data.stage_followup_anchor = maxIso(data.interview_scheduled_at, data.last_status_changed_at) || nowIso();
      }
    } else if (data.stage_followup_anchor === undefined && app.stage_followup_anchor) {
      data.stage_followup_anchor = null;
    }
  }
  const changed = Object.keys(data);
  if (!changed.length) return app;
  const sets = changed.map((f) => `${f} = ?`).join(', ');
  const values = changed.map((f) => data[f]);
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
      data.status || app.status,
      JSON.stringify(Object.fromEntries(changed.map((k) => [k, { from: app[k], to: data[k] }]))),
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
