#!/usr/bin/env node
/* 只读识别历史“本项目自身页面”误采集；--apply 只处理事件和待确认项，不删除台账。
 * 用法：
 *   node server/scripts/audit-self-captures.js --db data/mail-selftest/tounar.sqlite --origin http://127.0.0.1:4311
 *   node server/scripts/audit-self-captures.js --db ... --origin ... --apply --confirm
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const dbPath = path.resolve(opt('--db', 'data/tounar.sqlite'));
const originArg = opt('--origin', null);
if (!originArg) { console.error('必须提供 --origin（例如 http://127.0.0.1:4311）'); process.exit(2); }
const origins = new Set(String(originArg).split(',').map((x) => {
  try { return new URL(x.trim()).origin; } catch { return null; }
}).filter(Boolean));
if (!origins.size) { console.error('--origin 必须是 http(s) URL'); process.exit(2); }
const apply = args.includes('--apply');
const confirmed = args.includes('--confirm');
if (apply && !confirmed) { console.error('--apply 必须同时带 --confirm；先运行只读报告并审阅'); process.exit(2); }
if (!fs.existsSync(dbPath)) { console.error('找不到数据库：' + dbPath); process.exit(2); }

const db = new DatabaseSync(dbPath, { readOnly: !apply });
const parse = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const isSelf = (payload) => ['job_url', 'status_url'].some((key) => {
  try { return payload?.[key] && origins.has(new URL(payload[key]).origin); } catch { return false; }
});
const events = db.prepare('SELECT id,owner_id,event_type,occurred_at,received_at,processing_state,application_id,payload_json FROM events ORDER BY received_at DESC').all();
const selfEvents = events.filter((e) => isSelf(parse(e.payload_json)));
const selfIds = new Set(selfEvents.map((e) => e.id));
const reviews = db.prepare("SELECT id,owner_id,source_event_id,status,kind,summary,created_at FROM review_items WHERE source_event_id IS NOT NULL").all()
  .filter((r) => selfIds.has(r.source_event_id));
const appIds = [...new Set(selfEvents.map((e) => e.application_id).filter(Boolean))];
const apps = appIds.length ? db.prepare(`SELECT id,company_name,job_title,status,has_applied,job_url,created_at FROM applications WHERE id IN (${appIds.map(() => '?').join(',')})`).all(...appIds) : [];
const report = {
  db: dbPath, origins: [...origins], mode: apply ? 'apply' : 'dry-run',
  self_events: selfEvents.length, self_reviews: reviews.length, linked_applications: apps.length,
  open_reviews: reviews.filter((r) => r.status === 'open').length,
  samples: selfEvents.slice(0, 12).map((e) => {
    const p = parse(e.payload_json);
    return { event_id: e.id, event_type: e.event_type, title: p.job_title || null, url: p.job_url || p.status_url || null, received_at: e.received_at, processing_state: e.processing_state, application_id: e.application_id };
  }),
  applications: apps.slice(0, 30)
};
if (apply) {
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const e of selfEvents) {
      db.prepare("UPDATE events SET processing_state='ignored', review_reason='SELF_APP_PAGE', processed_at=? WHERE id=?").run(now, e.id);
    }
    for (const r of reviews.filter((x) => x.status === 'open')) {
      db.prepare("UPDATE review_items SET status='dismissed', resolution_json=?, resolved_at=?, version=version+1 WHERE id=? AND status='open'")
        .run(JSON.stringify({ resolution: 'self_capture', reason: '本项目自身页面误采集', origin: [...origins] }), now, r.id);
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  report.applied = { events_ignored: selfEvents.length, reviews_dismissed: reviews.filter((r) => r.status === 'open').length, applications_untouched: apps.length };
}
db.close();
console.log(JSON.stringify(report, null, 2));
