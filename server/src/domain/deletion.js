import { config } from '../config.js';
import { all, one, run, transaction } from '../db.js';
import { AppError, newId, nowIso } from '../util.js';

function projection(row) {
  const scope = row.scope_json ? JSON.parse(row.scope_json) : {};
  const progress = row.progress_json ? JSON.parse(row.progress_json) : {};
  return {
    id: row.id,
    status: row.status,
    scope,
    progress,
    requested_at: row.requested_at,
    completed_at: row.completed_at,
    error_code: row.error_code
  };
}

function kick(jobId) {
  setImmediate(() => {
    try {
      processDeletionJob(jobId);
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', event: 'deletion_failed', job_id: jobId, message: err.message }));
    }
  });
}

export function requestDeletion(ownerId, body = {}) {
  if (body.confirmation !== '删除全部数据') {
    throw new AppError(400, 'VALIDATION_ERROR', '需要明确输入「删除全部数据」才能继续');
  }
  if (body.acknowledge_irreversible !== true) {
    throw new AppError(400, 'VALIDATION_ERROR', '请明确确认删除不可恢复');
  }
  return transaction(() => {
    const active = one(`SELECT * FROM deletion_jobs WHERE owner_id = ?
      AND status IN ('requested','blocking_writes','deleting','awaiting_device_ack') ORDER BY requested_at DESC LIMIT 1`, [ownerId]);
    if (active) return { __status: 202, ...projection(active), reused: true };
    const jobId = newId('del');
    const user = one('SELECT * FROM users WHERE id = ?', [ownerId]);
    const generation = (user?.deletion_generation || 0) + 1;
    const scope = {
      managed_database: 'delete_all_business_records',
      mail_credentials: 'delete_and_stop_sync',
      plugin_bindings: 'revoke_and_request_device_cleanup',
      reminder_links: 'delete',
      backups: 'no_managed_backup_configured',
      external_workbuddy_cloud: 'not_available_local_substitute'
    };
    const progress = {
      writes_blocked: true,
      business_records: 'pending',
      mail_credentials: 'pending',
      devices: 'pending_ack',
      backups: 'not_configured',
      note: '云数据库、备份与设备清理分列；未核实的范围不会标记为已删除'
    };
    run(`INSERT INTO deletion_jobs (id, owner_id, status, scope_json, progress_json, requested_at)
         VALUES (?, ?, 'blocking_writes', ?, ?, ?)`,
    [jobId, ownerId, JSON.stringify(scope), JSON.stringify(progress), nowIso()]);
    run('UPDATE users SET deletion_blocked = 1, deletion_generation = ? WHERE id = ?', [generation, ownerId]);
    run(`INSERT INTO deletion_guards (owner_id, generation, blocked_at) VALUES (?, ?, ?)
         ON CONFLICT(owner_id) DO UPDATE SET generation = excluded.generation, blocked_at = excluded.blocked_at`,
    [ownerId, generation, nowIso()]);
    // Stop all credentials and push a revocation generation immediately. Devices still need an authenticated cleanup receipt.
    run(`UPDATE mail_connections SET status = 'disconnected', credential_ciphertext = NULL, credential_iv = NULL,
         credential_tag = NULL, binding_version = binding_version + 1, sync_lease_until = NULL, sync_lease_owner = NULL,
         updated_at = ? WHERE owner_id = ? AND status <> 'disconnected'`, [nowIso(), ownerId]);
    const devices = all('SELECT * FROM plugin_devices WHERE owner_id = ?', [ownerId]);
    for (const device of devices) {
      run(`UPDATE plugin_devices SET server_revoked_at = COALESCE(server_revoked_at, ?),
           device_cleanup_state = 'unknown', binding_version = binding_version + 1, token_hash = token_hash
           WHERE id = ? AND owner_id = ?`, [nowIso(), device.id, ownerId]);
    }
    run(`UPDATE sessions SET revoked_at = ? WHERE owner_id = ? AND id <> ?`, [nowIso(), ownerId, body.current_session_id || '']);
    run('UPDATE users SET deletion_blocked = 1 WHERE id = ?', [ownerId]);
    kick(jobId);
    return { __status: 202, ...projection(one('SELECT * FROM deletion_jobs WHERE id = ?', [jobId])) };
  });
}

export function processDeletionJob(jobId) {
  const job = one('SELECT * FROM deletion_jobs WHERE id = ?', [jobId]);
  if (!job) return { status: 'not_found' };
  if (['completed', 'failed'].includes(job.status)) return projection(job);
  const ownerId = job.owner_id;
  const devices = all('SELECT * FROM plugin_devices WHERE owner_id = ?', [ownerId]);
  const allAck = devices.every((d) => d.device_cleanup_state === 'acknowledged');
  const progress = {
    writes_blocked: true,
    business_records: 'deleting',
    mail_credentials: 'deleted',
    devices: allAck ? 'acknowledged' : (devices.length ? 'awaiting_device_ack' : 'none'),
    backups: 'not_configured',
    note: '本地托管数据库记录删除；未配置托管备份。设备离线时只等待回执，不伪造已清理。'
  };
  run(`UPDATE deletion_jobs SET status = 'deleting', progress_json = ? WHERE id = ?`, [JSON.stringify(progress), jobId]);
  try {
    transaction(() => {
      run('DELETE FROM reminder_confirmations WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM reminder_links WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM notification_batch_items WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM notification_batches WHERE owner_id = ?', [ownerId]);
      const mailOwner = one('SELECT email_display,email_normalized FROM users WHERE id=?', [ownerId]);
      run('DELETE FROM mail_test_runs WHERE owner_id=?', [ownerId]);
      run('DELETE FROM ai_ingest_runs WHERE owner_id=?', [ownerId]);
      run('DELETE FROM ai_reports WHERE owner_id=?', [ownerId]);
      run('DELETE FROM resumes WHERE owner_id=?', [ownerId]);
      run('DELETE FROM mail_deliveries WHERE owner_id=? OR lower(recipient)=?', [ownerId, mailOwner?.email_normalized || '']);
      if (mailOwner) run("UPDATE mail_template_versions SET actor='已删除管理员' WHERE actor=? OR actor LIKE ?", [mailOwner.email_normalized, mailOwner.email_normalized+'（%']);
      run('DELETE FROM notification_outbox WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM notification_preferences WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM review_resolutions WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM review_items WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM events WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM application_history WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM application_field_sources WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM applications WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM mail_messages WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM mail_cursors WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM mail_connections WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM plugin_pairings WHERE owner_id = ?', [ownerId]);
      run('UPDATE plugin_devices SET device_name = ?, token_hash = token_hash WHERE owner_id = ?', ['已撤销设备', ownerId]);
      run('DELETE FROM idempotency_keys WHERE owner_id = ?', [ownerId]);
      run('DELETE FROM audit_log WHERE owner_id = ?', [ownerId]);
      run('UPDATE deletion_jobs SET scope_json = ?, status = ?, progress_json = ?, completed_at = ? WHERE id = ?',
        [JSON.stringify({
          managed_database: 'deleted',
          mail_credentials: 'deleted',
          plugin_bindings: devices.length ? 'awaiting_device_cleanup_ack' : 'no_devices',
          reminder_links: 'deleted',
          backups: 'no_managed_backup_configured',
          external_workbuddy_cloud: 'not_available_local_substitute'
        }), allAck ? 'completed' : 'awaiting_device_ack', JSON.stringify({
          ...progress,
          business_records: 'deleted',
          devices: allAck ? (devices.length ? 'acknowledged' : 'none') : 'awaiting_device_ack'
        }), allAck ? nowIso() : null, jobId]);
      if (allAck) {
        run(`UPDATE users SET email_normalized = ?, email_display = '已删除账号', allowlisted = 0 WHERE id = ?`,
          ['deleted:' + ownerId, ownerId]);
      }
    });
  } catch (err) {
    run(`UPDATE deletion_jobs SET status = 'failed', error_code = ?, progress_json = ? WHERE id = ?`,
      ['DELETION_FAILED', JSON.stringify({ ...progress, message: '删除任务失败，已停止；请联系支持，不会声称已完成' }), jobId]);
    throw err;
  }
  return projection(one('SELECT * FROM deletion_jobs WHERE id = ?', [jobId]));
}

export function getDeletionJob(ownerId, jobId) {
  const row = one('SELECT * FROM deletion_jobs WHERE id = ? AND owner_id = ?', [jobId, ownerId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', '删除任务不存在或无权访问');
  return projection(row);
}

export function latestDeletionJob(ownerId) {
  const row = one('SELECT * FROM deletion_jobs WHERE owner_id = ? ORDER BY requested_at DESC LIMIT 1', [ownerId]);
  return row ? projection(row) : null;
}

export function finalizeDeletionForOwner(ownerId) {
  const job = one(`SELECT * FROM deletion_jobs WHERE owner_id = ? AND status = 'awaiting_device_ack'
    ORDER BY requested_at DESC LIMIT 1`, [ownerId]);
  if (!job) return null;
  const devices = all('SELECT * FROM plugin_devices WHERE owner_id = ?', [ownerId]);
  if (devices.some((d) => d.device_cleanup_state !== 'acknowledged')) return projection(job);
  const progress = JSON.parse(job.progress_json || '{}');
  run(`UPDATE deletion_jobs SET status = 'completed', completed_at = ?, progress_json = ? WHERE id = ?`,
    [nowIso(), JSON.stringify({ ...progress, devices: 'acknowledged' }), job.id]);
  run(`UPDATE users SET email_normalized = ?, email_display = '已删除账号', allowlisted = 0 WHERE id = ?`,
    ['deleted:' + ownerId, ownerId]);
  return projection(one('SELECT * FROM deletion_jobs WHERE id = ?', [job.id]));
}
