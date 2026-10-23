import crypto from 'node:crypto';
import { config, featureFlags } from '../config.js';
import { all, dataRevision, one, run } from '../db.js';
import { route, jsonStatus, stripInternal } from '../http.js';
import {
  AppError, assert, newId, nowIso, safeEqualHex, sha256, STATUS_LABELS
} from '../util.js';
import {
  authMe, clearSessionCookie, reauthenticate, requestOtp, requireAuth, requireRecentAuth, revokeSession,
  sessionCookie, verifyOtp
} from '../auth.js';
import { withIdempotency } from '../idempotency.js';
import {
  applicationDetail, ledgerResponse, reviewDetail, reviewList
} from '../domain/ledger.js';
import {
  archiveApplication, correctApplication, markApplicationReviewed, resolveReview, undoReview, undoAutomaticMail
} from '../domain/reviews.js';
import { manualCreate, getPreferences } from '../domain/applications.js';
import {
  authenticateDevice, cleanupAck, createPairing, approvePairing, deviceSelf, exchangePairing, heartbeat,
  ingestBatch, revokeDevice
} from '../plugin.js';
import {
  createMailConnection, disconnectMailConnection, getMailConnection, listMailConnections,
  reauthorizeMailConnection, triggerMailSync
} from '../domain/mail.js';
import { batchPreview, prepareReminderConfirmation, reminderLinkRead, runReminders } from '../domain/reminders.js';
import {
  getDeletionJob, latestDeletionJob, requestDeletion
} from '../domain/deletion.js';
import { runTick, schedulerStatus } from '../jobs/scheduler.js';

function optionalAuth(req) {
  try {
    return requireAuth(req);
  } catch {
    return null;
  }
}

function publicUser(user) {
  return { email: user.email_display, owner_id: user.id, allowlisted: !!user.allowlisted };
}

function deviceProjection(device) {
  return {
    id: device.id,
    name: device.device_name,
    binding_version: device.binding_version,
    created_at: device.created_at,
    expires_at: device.expires_at || null,
    last_heartbeat_at: device.last_heartbeat_at,
    last_event_at: device.last_event_at,
    server_revoked_at: device.server_revoked_at,
    device_cleanup_state: device.device_cleanup_state,
    device_cleanup_ack_at: device.device_cleanup_ack_at
  };
}

function issueSessionResponse(result) {
  return jsonStatus(200, {
    user: result.user,
    expires_at: result.session.expiresAt,
    message: '登录成功'
  }, {
    'Set-Cookie': sessionCookie(result.session.token, config.sessionDays * 86400)
  });
}

export function registerRoutes() {
  // ---------- auth ----------
  route('POST', '/api/v1/auth/request-otp', async (req) => requestOtp(req.body.email, req), { public: true, csrf: false });
  route('POST', '/api/v1/auth/verify-otp', async (req) => {
    const result = await verifyOtp(req.body.email, req.body.code, req);
    return issueSessionResponse(result);
  }, { public: true, csrf: false });
  route('POST', '/api/v1/auth/logout', (req) => {
    revokeSession(req);
    return jsonStatus(200, { logged_out: true }, { 'Set-Cookie': clearSessionCookie() });
  });
  route('POST', '/api/v1/auth/reauthenticate', async (req) => {
    const auth = requireAuth(req);
    const result = await reauthenticate(req, req.body.email, req.body.code);
    return { ...result, email: auth.user.email_display };
  });

  route('GET', '/api/v1/me', (req) => {
    const auth = requireAuth(req);
    const mail = one('SELECT * FROM mail_connections WHERE owner_id = ? ORDER BY created_at DESC LIMIT 1', [auth.ownerId]);
    const devices = all('SELECT * FROM plugin_devices WHERE owner_id = ? ORDER BY created_at DESC', [auth.ownerId]);
    const deletion = latestDeletionJob(auth.ownerId);
    return {
      data: {
        ...authMe(auth),
        user: { ...authMe(auth).user, ...publicUser(auth.user) },
        mail_connection: mail ? {
          id: mail.id, email: mail.email, mode: mail.mode, status: mail.status,
          last_sync_success_at: mail.last_sync_success_at, last_error_code: mail.last_error_code,
          last_error_message: mail.last_error_message
        } : null,
        plugin_devices: devices.map(deviceProjection),
        notification_preferences: getPreferences(auth.ownerId),
        deletion_job: deletion,
        data_revision: dataRevision(),
        server_time: nowIso(),
        feature_decisions: featureFlags
      }
    };
  });

  // ---------- plugin pairing (extension) ----------
  route('POST', '/api/v1/plugin-pairings', (req) => {
    const result = createPairing(req.body || {});
    return jsonStatus(201, { data: result });
  }, { public: true, csrf: false });
  route('POST', '/api/v1/plugin-pairings/exchange', (req) => {
    const result = exchangePairing(req.body || {});
    return { data: result };
  }, { public: true, csrf: false });
  route('POST', '/api/v1/plugin-pairings/approve', (req) => {
    const auth = requireAuth(req);
    const code = String(req.body.code || '');
    if (!/^[A-Z2-9]{8}$/i.test(code)) throw new AppError(400, 'PAIRING_CODE_INVALID', '请输入 8 位配对码');
    return { data: approvePairing(auth.ownerId, req.body.pairing_id || null, code) };
  });
  route('POST', '/api/v1/plugin-pairings/:id/approve', (req) => {
    const auth = requireAuth(req);
    return { data: approvePairing(auth.ownerId, req.params.id, req.body.code) };
  });

  // ---------- device API ----------
  route('POST', '/api/v1/events/batch', (req) => {
    const device = authenticateDevice(req);
    const result = ingestBatch(device, req.body || {});
    return { ...result, request_id: req.requestId };
  }, { public: true, csrf: false });
  route('GET', '/api/v1/plugin-devices/self', (req) => {
    return { data: deviceSelf(req) };
  }, { public: true });
  route('POST', '/api/v1/plugin-devices/heartbeat', (req) => {
    return { data: heartbeat(req) };
  }, { public: true, csrf: false });
  route('POST', '/api/v1/plugin-devices/cleanup-ack', (req) => {
    return { data: cleanupAck(req, req.body || {}) };
  }, { public: true, csrf: false });
  route('GET', '/api/v1/plugin-devices', (req) => {
    const auth = requireAuth(req);
    const devices = all('SELECT * FROM plugin_devices WHERE owner_id = ? ORDER BY created_at DESC', [auth.ownerId]);
    return { data: devices.map(deviceProjection) };
  });
  route('POST', '/api/v1/plugin-devices/:id/revoke', (req) => {
    const auth = requireAuth(req);
    return { data: revokeDevice(auth.ownerId, req.params.id) };
  });

  // ---------- ledger ----------
  route('GET', '/api/v1/ledger-updates', (req) => {
    const auth = requireAuth(req);
    const since = req.query.get('since');
    if (since && !Number.isFinite(Date.parse(since))) throw new AppError(400, 'VALIDATION_ERROR', '更新时间格式不正确');
    return { data: { data_revision: dataRevision(), mail_updates: all(`SELECT DISTINCT application_id FROM application_history
      WHERE owner_id = ? AND source_method = 'mail' AND changed_at > ? AND from_status <> to_status`, [auth.ownerId, since || nowIso()]).map(x => x.application_id) } };
  });
  route('POST', '/api/v1/applications/:id/undo-mail', (req) => {
    const auth = requireAuth(req);
    return withIdempotency({ ownerId: auth.ownerId, scope: `mail.undo:${req.params.id}`, req,
      handler: () => ({ data: undoAutomaticMail({ ownerId: auth.ownerId, applicationId: req.params.id, historyId: req.body.history_id, expectedVersion: req.body.expected_version }) }) });
  });
  route('GET', '/api/v1/ledger', (req) => {
    const auth = requireAuth(req);
    return ledgerResponse(auth.ownerId, Object.fromEntries(req.query.entries()));
  });
  route('GET', '/api/v1/applications/:id', (req) => {
    const auth = requireAuth(req);
    return applicationDetail(auth.ownerId, req.params.id);
  });
  route('POST', '/api/v1/applications/manual', (req) => {
    const auth = requireAuth(req);
    return withIdempotency({
      ownerId: auth.ownerId, scope: 'application.manual', req,
      handler: () => {
        const app = manualCreate({ ownerId: auth.ownerId, body: req.body || {}, idempotencyKey: req.headers['idempotency-key'] });
        return jsonStatus(201, { data: applicationDetail(auth.ownerId, app.id).data });
      }
    });
  });
  route('POST', '/api/v1/applications/:id/corrections', (req) => {
    const auth = requireAuth(req);
    return withIdempotency({
      ownerId: auth.ownerId, scope: `application.correction:${req.params.id}`, req,
      handler: () => {
        const result = correctApplication({
          ownerId: auth.ownerId,
          applicationId: req.params.id,
          expectedVersion: req.body.expected_version,
          changes: req.body.changes || {},
          reason: req.body.reason
        });
        return { data: { ...applicationDetail(auth.ownerId, req.params.id).data, changed: result.changed } };
      }
    });
  });
  route('POST', '/api/v1/applications/:id/reviewed', (req) => {
    const auth = requireAuth(req);
    return withIdempotency({
      ownerId: auth.ownerId, scope: `application.reviewed:${req.params.id}`, req,
      handler: () => {
        const result = markApplicationReviewed({
          ownerId: auth.ownerId,
          applicationId: req.params.id,
          expectedVersion: req.body.expected_version,
          context: req.body.context || 'ledger',
          confirmationToken: req.body.confirmation_token || null
        });
        return {
          data: {
            application: applicationDetail(auth.ownerId, req.params.id).data,
            reviewed_at: result.reviewed_at,
            changed: result.changed,
            completed: result.completed
          }
        };
      }
    });
  });
  route('POST', '/api/v1/applications/:id/archive', (req) => {
    const auth = requireAuth(req);
    return withIdempotency({
      ownerId: auth.ownerId, scope: `application.archive:${req.params.id}`, req,
      handler: () => {
        const result = archiveApplication({
          ownerId: auth.ownerId,
          applicationId: req.params.id,
          expectedVersion: req.body.expected_version,
          archive: req.body.archive !== false,
          reason: req.body.reason
        });
        return { data: { ...applicationDetail(auth.ownerId, req.params.id).data, changed: result.changed } };
      }
    });
  });

  // ---------- reviews ----------
  route('GET', '/api/v1/application-search', (req) => {
    const auth = requireAuth(req);
    const term = String(req.query.get('q') || '').trim().slice(0, 100).toLowerCase();
    const rows = all('SELECT id, company_name, job_title, status, applied_at, version FROM applications WHERE owner_id = ? AND archived_at IS NULL ORDER BY updated_at DESC', [auth.ownerId]);
    return { data: rows.filter(a => `${a.company_name} ${a.job_title}`.toLowerCase().includes(term)).slice(0, 50) };
  });
  route('GET', '/api/v1/review-items', (req) => {
    const auth = requireAuth(req);
    return reviewList(auth.ownerId, Object.fromEntries(req.query.entries()));
  });
  route('POST', '/api/v1/review-items/:id/undo', (req) => {
    const auth = requireAuth(req);
    return withIdempotency({ ownerId: auth.ownerId, scope: `review.undo:${req.params.id}`, req,
      handler: () => ({ data: undoReview({ ownerId: auth.ownerId, reviewId: req.params.id, expectedVersion: req.body.expected_version }) }) });
  });
  route('GET', '/api/v1/review-items/:id', (req) => {
    const auth = requireAuth(req);
    return reviewDetail(auth.ownerId, req.params.id);
  });
  route('POST', '/api/v1/review-items/:id/resolve', (req) => {
    const auth = requireAuth(req);
    return withIdempotency({
      ownerId: auth.ownerId, scope: `review.resolve:${req.params.id}`, req,
      handler: () => {
        const result = resolveReview({
          ownerId: auth.ownerId,
          reviewId: req.params.id,
          expectedVersion: req.body.expected_version,
          action: req.body.action,
          applicationId: req.body.application_id,
          expectedApplicationVersion: req.body.expected_application_version,
          changes: req.body.changes || {},
          reason: req.body.reason,
          idempotencyKey: req.headers['idempotency-key']
        });
        return {
          data: {
            review: result.review,
            already_resolved: !!result.already_resolved,
            application: result.application ? applicationDetail(auth.ownerId, result.application.id).data : null
          }
        };
      }
    });
  });

  // ---------- mail ----------
  route('POST', '/api/v1/mail-connections', (req) => {
    const auth = requireAuth(req);
    return jsonStatus(202, { data: createMailConnection(auth.ownerId, req.body || {}) });
  });
  route('GET', '/api/v1/mail-connections', (req) => {
    const auth = requireAuth(req);
    return { data: listMailConnections(auth.ownerId) };
  });
  route('GET', '/api/v1/mail-connections/:id', (req) => {
    const auth = requireAuth(req);
    return { data: getMailConnection(auth.ownerId, req.params.id) };
  });
  route('POST', '/api/v1/mail-connections/:id/disconnect', (req) => {
    const auth = requireAuth(req);
    return { data: disconnectMailConnection(auth.ownerId, req.params.id) };
  });
  route('POST', '/api/v1/mail-connections/:id/reauthorize', (req) => {
    const auth = requireAuth(req);
    return jsonStatus(202, { data: reauthorizeMailConnection(auth.ownerId, req.params.id, req.body || {}) });
  });
  route('POST', '/api/v1/mail-connections/:id/sync', (req) => {
    const auth = requireAuth(req);
    return jsonStatus(202, { data: triggerMailSync(auth.ownerId, req.params.id) });
  });

  // ---------- notifications ----------
  route('GET', '/api/v1/notification-preferences', (req) => {
    const auth = requireAuth(req);
    return { data: getPreferences(auth.ownerId), decision: 'D06 frozen 2026-10-22: daily digest, B-class 7-day per-record throttle' };
  });
  route('PUT', '/api/v1/notification-preferences', (req) => {
    const auth = requireAuth(req);
    const current = getPreferences(auth.ownerId);
    if (req.body.expected_version != null && Number(req.body.expected_version) !== current.version) {
      throw new AppError(409, 'VERSION_CONFLICT', '提醒设置已更新，请刷新后重试', { details: { current_version: current.version } });
    }
    const mode = req.body.mode ?? current.mode;
    const frequency = req.body.review_frequency ?? current.review_frequency;
    const threshold = req.body.review_threshold_days ?? current.review_threshold_days;
    if (!['all', 'changes_only', 'review_only', 'off'].includes(mode)) throw new AppError(400, 'VALIDATION_ERROR', 'mode 无效');
    if (!['weekly_monday', 'daily'].includes(frequency)) throw new AppError(400, 'VALIDATION_ERROR', 'review_frequency 无效');
    if (!Number.isInteger(Number(threshold)) || Number(threshold) < 7 || Number(threshold) > 30) {
      throw new AppError(400, 'VALIDATION_ERROR', 'review_threshold_days 只能是 7–30');
    }
    run(`UPDATE notification_preferences SET mode = ?, review_frequency = ?, review_threshold_days = ?,
         version = version + 1, updated_at = ? WHERE owner_id = ?`,
    [mode, frequency, Number(threshold), nowIso(), auth.ownerId]);
    return { data: getPreferences(auth.ownerId), decision: 'D06 frozen 2026-10-22: daily digest, B-class 7-day per-record throttle' };
  });
  route('GET', '/api/v1/notification-preferences/preview', (req) => {
    const auth = requireAuth(req);
    return { data: batchPreview(auth.ownerId), decision: 'D06/D08 frozen 2026-10-22; preview does not send or mark anything' };
  });

  // ---------- reminder links ----------
  route('GET', '/api/v1/reminder-links/:token', (req) => {
    const auth = optionalAuth(req);
    if (!auth) {
      return { data: { login_required: true, message: '请先用邮箱验证码登录；打开本页不会标记任何状态' } };
    }
    return { data: reminderLinkRead(auth.ownerId, req.params.token) };
  }, { public: true });
  route('POST', '/api/v1/reminder-links/:token/confirmations', (req) => {
    const auth = requireAuth(req);
    if (String(req.headers['x-tounar-action'] || '') !== 'explicit-confirm') {
      throw new AppError(400, 'VALIDATION_ERROR', '只有用户明确点击确认后才能准备动作凭据');
    }
    return withIdempotency({
      ownerId: auth.ownerId, scope: `reminder.confirmation:${req.params.token}`, req,
      handler: () => {
        const result = prepareReminderConfirmation({
          ownerId: auth.ownerId,
          token: req.params.token,
          expectedVersion: req.body.expected_version,
          idempotencyKey: req.headers['idempotency-key']
        });
        return { data: result };
      }
    });
  });

  // ---------- deletion ----------
  route('POST', '/api/v1/data-deletions', (req) => {
    const auth = requireRecentAuth(req);
    return withIdempotency({
      ownerId: auth.ownerId, scope: 'data.deletion', req,
      handler: () => {
        const result = requestDeletion(auth.ownerId, { ...(req.body || {}), current_session_id: auth.session.id });
        return jsonStatus(result.__status || 202, { data: stripInternal(result) });
      }
    });
  });
  route('GET', '/api/v1/data-deletions', (req) => {
    const auth = requireAuth(req, { allowDeletionBlocked: true });
    return { data: latestDeletionJob(auth.ownerId) };
  });
  route('GET', '/api/v1/data-deletions/:id', (req) => {
    const auth = requireAuth(req, { allowDeletionBlocked: true });
    return { data: getDeletionJob(auth.ownerId, req.params.id) };
  });

  // ---------- internal scheduler ----------
  route('POST', '/api/v1/internal/tick', async (req) => {
    requireInternalToken(req);
    const result = await runTick({
      force: !!req.body.force,
      mail: !!req.body.mail,
      reminders: !!req.body.reminders
    });
    return { data: { scheduler: schedulerStatus(), result } };
  }, { public: true, csrf: false });
  route('GET', '/api/v1/internal/status', (req) => {
    requireInternalToken(req);
    return { data: schedulerStatus() };
  }, { public: true });

  // ---------- decisions / gates ----------
  route('GET', '/api/v1/meta/decisions', (req) => {
    requireAuth(req);
    return {
      data: {
        decisions: featureFlags,
        gates: {
          G01: { status: 'blocked_external', note: '未接入 WorkBuddy OTP/会话/DB/RLS；当前为本地 OTP + SQLite 替代实现' },
          G02: { status: 'blocked_external', note: '无真实 QQ IMAP 授权码与真实 SMTP 凭据；协议代码已实现但供应商验收未完成' },
          G03: { status: 'partially_verified_local', note: '本地配对/撤销/清理回执协议已实现并测试；未在真实 WorkBuddy 环境验证' },
          G04: { status: 'blocked_external', note: '无 ≥8 家校招站点真实登录态、TOS 与脱敏样例；适配器框架与通用页面解析已实现，逐站验收待补' },
          cron: { status: 'blocked_external', note: '生产外部 cron/任务身份未配置；本地 scheduler 可运行' },
          smtp: { status: config.mailMode === 'smtp' ? 'configured' : 'development_outbox', note: '开发 outbox 不代表真实送达' }
        }
      }
    };
  });
}

function requireInternalToken(req) {
  const header = String(req.headers['x-internal-token'] || '');
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const supplied = header || bearer;
  const expected = config.internalTickToken;
  if (!supplied || !safeEqualHex(sha256(supplied), sha256(expected))) {
    throw new AppError(401, 'UNAUTHENTICATED', '内部调度令牌无效');
  }
}
