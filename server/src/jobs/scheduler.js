import { config } from '../config.js';
import { all, bumpRevision, one, run, transaction } from '../db.js';
import { newId, nowIso, shanghaiClock } from '../util.js';
import { runReminders } from '../domain/reminders.js';
import { syncAllConnections } from '../domain/mailSync.js';
import { processDeletionJob } from '../domain/deletion.js';

let timer = null;
let running = false;
let lastTick = null;

function meta(key) {
  return one('SELECT value FROM meta WHERE key = ?', [key])?.value || null;
}

function setMeta(key, value) {
  run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]);
}

function due(lastIso, minutes) {
  if (!lastIso) return true;
  return Date.now() - Date.parse(lastIso) >= minutes * 60000;
}

export function archiveStaleBrowsed(now = new Date()) {
  if (!config.browseArchiveDays) {
    return { enabled: false, archived: 0, note: 'D03 浏览归档默认关闭，待用户决策' };
  }
  const threshold = new Date(now.getTime() - config.browseArchiveDays * 86400000).toISOString();
  const rows = all(`SELECT id FROM applications WHERE has_applied = 0 AND archived_at IS NULL
    AND (last_viewed_at IS NULL OR last_viewed_at < ?) AND created_at < ?`, [threshold, threshold]);
  if (!rows.length) return { enabled: true, archived: 0 };
  transaction(() => {
    for (const row of rows) {
      run(`UPDATE applications SET archived_at = ?, archive_reason = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND has_applied = 0 AND archived_at IS NULL`,
      [nowIso(), `browse_stale_${config.browseArchiveDays}d_D03`, nowIso(), row.id]);
      if (config.browseArchiveSetClosed) {
        run("UPDATE applications SET status = 'closed' WHERE id = ? AND has_applied = 0", [row.id]);
      }
      run(`INSERT INTO audit_log (id, owner_id, actor, action, target_type, target_id, meta_json, created_at)
           SELECT ?, owner_id, 'system', 'application.auto_archive', 'application', id, ?, ? FROM applications WHERE id = ?`,
      [newId('aud'), JSON.stringify({ days: config.browseArchiveDays, decision: 'D03' }), nowIso(), row.id]);
    }
    bumpRevision();
  });
  return { enabled: true, archived: rows.length, days: config.browseArchiveDays, d03_frozen: '2026-10-22' };
}

export async function recoverDeletionJobs() {
  const jobs = all("SELECT id FROM deletion_jobs WHERE status IN ('requested','blocking_writes','deleting','awaiting_device_ack')");
  const results = [];
  for (const job of jobs) {
    try {
      results.push({ id: job.id, ...(await processDeletionJob(job.id)) });
    } catch {
      results.push({ id: job.id, status: 'failed' });
    }
  }
  return results;
}

export async function runTick({ force = false, mail = false, reminders = false, now = new Date() } = {}) {
  if (running) return { skipped: 'tick_in_progress' };
  running = true;
  const started = Date.now();
  const summary = { started_at: nowIso(), mail: null, reminders: null, browse_archive: null, deletions: null };
  try {
    summary.browse_archive = archiveStaleBrowsed(now);
    summary.deletions = await recoverDeletionJobs();

    const lastMail = meta('last_mail_sync_at');
    const connections = one("SELECT COUNT(*) AS n FROM mail_connections WHERE status <> 'disconnected'");
    if ((mail || force) || (connections?.n && due(lastMail, config.mailSyncMinutes))) {
      summary.mail = await syncAllConnections();
      setMeta('last_mail_sync_at', nowIso());
    }

    const clock = shanghaiClock(now);
    const atReminderWindow = clock.hour === config.reminderHour && clock.minute >= config.reminderMinute && clock.minute < config.reminderMinute + 30;
    if (reminders || force || atReminderWindow) {
      summary.reminders = await runReminders(now, { force: force || reminders });
    }
    lastTick = { at: nowIso(), duration_ms: Date.now() - started, summary };
    return summary;
  } finally {
    running = false;
  }
}

export function startScheduler() {
  if (!config.enableScheduler || timer) return { started: false };
  setTimeout(() => {
    recoverDeletionJobs().catch((err) => console.error(JSON.stringify({ level: 'error', event: 'deletion_recovery_failed', message: err.message })));
  }, 1000);
  timer = setInterval(() => {
    runTick().catch((err) => {
      console.error(JSON.stringify({ level: 'error', event: 'scheduler_tick_failed', message: err.message }));
    });
  }, Math.max(15, config.reminderTickSeconds) * 1000);
  timer.unref?.();
  return { started: true, interval_seconds: config.reminderTickSeconds };
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function schedulerStatus() {
  return {
    enabled: config.enableScheduler,
    running,
    last_tick: lastTick,
    last_mail_sync_at: meta('last_mail_sync_at'),
    reminder_window: `${String(config.reminderHour).padStart(2, '0')}:${String(config.reminderMinute).padStart(2, '0')} Asia/Shanghai`
  };
}
