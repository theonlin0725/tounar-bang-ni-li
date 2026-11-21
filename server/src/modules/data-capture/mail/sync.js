import { ImapFlow, AuthenticationFailure } from 'imapflow';
import { config } from '../../../config.js';
import { all, one, run, transaction } from '../../../db.js';
import {
  AppError, decryptSecret, newId, normalizeWhitespace, nowIso, parseIso, safeJsonParse, sha256
} from '../../../util.js';
import {
  confirmedMailProgress, classifyRecruitmentMail, extractMailFields, isRecruitmentHeader, publicEvidence, stripHtml
} from './parser.js';
import { recordConfirmedMail, processMailEvent } from '../../../domain/applications.js';
import { processIntakeEvent } from '../../recruitment-intake/workflow.js';
import { cloudLlmAvailable, llmClassifyMail } from '../cloud/llm.js';

import { imapHostFor } from './providers.js';
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const BODY_MAX_BYTES = 192 * 1024;

function decodeMimeWords(value) {
  return String(value || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, encoding, data) => {
    try {
      const buf = encoding.toLowerCase() === 'b'
        ? Buffer.from(data.replace(/\s/g, ''), 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
      return new TextDecoder(charset || 'utf-8').decode(buf);
    } catch {
      return data;
    }
  });
}

function addressFromEnvelope(envelope) {
  const from = Array.isArray(envelope?.from) ? envelope.from[0] : null;
  return {
    name: normalizeWhitespace(from?.name || '', 120),
    address: String(from?.address || '').toLowerCase()
  };
}

function findTextPart(node) {
  if (!node) return null;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) {
      const found = findTextPart(child);
      if (found) return found;
    }
    return null;
  }
  const type = String(node.type || '').toLowerCase();
  const disposition = String(node.disposition || '').toLowerCase();
  if (disposition === 'attachment') return null;
  if (type === 'text/plain') return node;
  return null;
}

function findHtmlPart(node) {
  if (!node) return null;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) {
      const found = findHtmlPart(child);
      if (found) return found;
    }
    return null;
  }
  const type = String(node.type || '').toLowerCase();
  const disposition = String(node.disposition || '').toLowerCase();
  if (disposition === 'attachment') return null;
  if (type === 'text/html') return node;
  return null;
}

async function readStreamLimited(stream, maxBytes = BODY_MAX_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      chunks.push(chunk.subarray(0, Math.max(0, maxBytes - (size - chunk.length))));
      break;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function downloadPart(client, uid, part) {
  // 单段邮件（没有 childNodes）的 bodyStructure 可能没有 part 编号；
  // imapflow 对 part="1" 有单段 TEXT 特判，这里统一兜底为 "1"，并在失败时抛错，
  // 由调用方保留游标、下轮重试，而不是静默吞成空正文。
  const partId = String(part?.part || '1');
  const download = await client.download(uid, partId, { uid: true, maxBytes: BODY_MAX_BYTES, binary: true });
  if (!download?.content) {
    throw new AppError(503, 'MAIL_BODY_EMPTY', `邮件正文 part ${partId} 为空`, { retryable: true });
  }
  const text = await readStreamLimited(download.content);
  if (!text.trim()) {
    throw new AppError(503, 'MAIL_BODY_EMPTY', `邮件正文 part ${partId} 读取为空`, { retryable: true });
  }
  return text;
}

function classifyError(err) {
  if (err instanceof AuthenticationFailure || err?.authenticationFailed === true ||
      String(err?.serverResponseCode || '').toUpperCase() === 'AUTHENTICATIONFAILED') {
    return { status: 'reauth_required', code: 'IMAP_AUTH_FAILED', message: '邮箱授权失效，请重新授权' };
  }
  const text = [err?.message, err?.responseText, err?.serverResponseCode, err?.code, err?.cause?.code].filter(Boolean).join(' ');
  if (/AUTHENTICATIONFAILED|AUTHENTICATE|LOGIN failed|Invalid credentials|authorization/i.test(text)) {
    return { status: 'reauth_required', code: 'IMAP_AUTH_FAILED', message: '邮箱授权失效，请检查是否已开启 IMAP/SMTP 服务并填写正确的客户端授权码' };
  }
  if (/Unsafe Login|kefu@188\.com/i.test(text)) {
    return { status: 'reauth_required', code: 'IMAP_UNSAFE_LOGIN', message: '网易邮箱安全拦截，请确认已开启 IMAP 服务并使用客户端授权码' };
  }
  if (/CERT|TLS|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|network|socket/i.test(text)) {
    return { status: 'degraded', code: 'IMAP_NETWORK_ERROR', message: '暂时无法连接邮箱服务器，已保留上次同步结果' };
  }
  return { status: 'degraded', code: 'IMAP_SYNC_FAILED', message: '邮箱同步失败，已保留上次成功结果' };
}

function logSyncError(connectionId, stage, err) {
  // Keep credentials, email content and full server responses out of logs.
  console.error(JSON.stringify({
    event: 'mail_sync_failed', connection_id: connectionId, stage,
    error_name: String(err?.name || 'Error'), error_code: String(err?.code || ''),
    response_status: String(err?.responseStatus || ''),
    server_response_code: String(err?.serverResponseCode || ''),
    authentication_failed: err?.authenticationFailed === true,
    tls_failed: err?.tlsFailed === true,
    cause_code: String(err?.cause?.code || '')
  }));
}

function currentBinding(connectionId, bindingVersion, leaseId) {
  const row = one(`SELECT binding_version, status, sync_lease_owner, sync_lease_until
    FROM mail_connections WHERE id = ?`, [connectionId]);
  if (!row || row.status === 'disconnected') return false;
  if (Number(row.binding_version) !== Number(bindingVersion)) return false;
  if (leaseId && row.sync_lease_owner !== leaseId) return false;
  if (leaseId && row.sync_lease_until && Date.parse(row.sync_lease_until) <= Date.now()) return false;
  return true;
}

function commitCursor(connection, cursor) {
  if (!cursor) return;
  run(`INSERT INTO mail_cursors (connection_id, owner_id, mailbox, uidvalidity, last_uid, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, mailbox) DO UPDATE SET uidvalidity = excluded.uidvalidity,
         last_uid = excluded.last_uid, updated_at = excluded.updated_at`,
  [connection.id, connection.owner_id, cursor.mailbox, cursor.uidvalidity, String(cursor.lastUid), nowIso()]);
}

function markConnectionError(connection, info, { leaseId = null, cursor = null, stats = null } = {}) {
  const result = run(`UPDATE mail_connections SET status = ?, last_sync_attempt_at = ?, last_error_code = ?, last_error_message = ?,
       last_sync_stats_json = COALESCE(?, last_sync_stats_json), updated_at = ?, sync_lease_until = NULL, sync_lease_owner = NULL
       WHERE id = ? AND binding_version = ? ${leaseId ? 'AND sync_lease_owner = ?' : ''}`,
  [info.status, nowIso(), info.code, info.message, stats ? JSON.stringify(stats) : null, nowIso(),
    connection.id, connection.binding_version, ...(leaseId ? [leaseId] : [])]);
  // 断开/重新授权/租约易手后，旧任务不得提交游标或覆盖状态。
  if (result.changes && cursor) commitCursor(connection, cursor);
  return result.changes > 0;
}

function markConnectionSuccess(connection, cursor, firstScanTotal, firstScanProcessed, { leaseId = null, stats = null } = {}) {
  const result = run(`UPDATE mail_connections SET status = 'connected', last_sync_attempt_at = ?, last_sync_success_at = ?,
       last_error_code = NULL, last_error_message = NULL, first_scan_total = COALESCE(?, first_scan_total),
       first_scan_processed = ?, last_sync_stats_json = COALESCE(?, last_sync_stats_json),
       updated_at = ?, sync_lease_until = NULL, sync_lease_owner = NULL
       WHERE id = ? AND binding_version = ? ${leaseId ? 'AND sync_lease_owner = ?' : ''} AND status <> 'disconnected'`,
  [nowIso(), nowIso(), firstScanTotal, firstScanProcessed, stats ? JSON.stringify(stats) : null, nowIso(),
    connection.id, connection.binding_version, ...(leaseId ? [leaseId] : [])]);
  if (!result.changes) return false;
  if (cursor) commitCursor(connection, cursor);
  return true;
}

function getLease(connectionId) {
  const now = new Date();
  const until = new Date(now.getTime() + 10 * 60000).toISOString();
  const leaseId = newId('lease');
  const result = run(`UPDATE mail_connections SET sync_lease_until = ?, sync_lease_owner = ?, last_sync_attempt_at = ?
       WHERE id = ? AND status <> 'disconnected' AND (sync_lease_until IS NULL OR sync_lease_until < ?)`,
  [until, leaseId, now.toISOString(), connectionId, now.toISOString()]);
  if (!result.changes) return null;
  return leaseId;
}

function decryptCredential(connection) {
  if (!connection.credential_ciphertext) throw new AppError(409, 'REAUTH_REQUIRED', '邮箱授权已失效，请重新授权');
  return decryptSecret(connection.credential_ciphertext, connection.credential_iv, connection.credential_tag);
}

function messageUidKey(connectionId, mailbox, uidvalidity, uid) {
  return `${connectionId}:${mailbox}:${uidvalidity}:${uid}`;
}

function firstScanProcessedCount(connectionId, uidvalidity, firstScanTotal) {
  const row = one(`SELECT COUNT(*) AS n FROM mail_messages
    WHERE connection_id = ? AND mailbox = 'INBOX' AND uidvalidity = ?`, [connectionId, String(uidvalidity)]);
  const uniqueCount = Number(row?.n || 0);
  return firstScanTotal == null ? uniqueCount : Math.min(uniqueCount, Number(firstScanTotal) || 0);
}

async function runEventPipeline(connection, mailId, eventId, parsed, bodyText, { leaseId = null } = {}) {
  if (leaseId && !currentBinding(connection.id, connection.binding_version, leaseId)) {
    return { state: 'aborted', aborted: true, reason: 'binding_changed' };
  }
  const aiCandidate = Boolean(config.autoIntakeEnabled && parsed.tentativeHeader);
  const fields = parsed.fields;
  const event = one('SELECT * FROM events WHERE id = ?', [eventId]);
  event.payload = JSON.parse(event.payload_json);
  const facts = parsed.confirmed || confirmedMailProgress(parsed.subject, bodyText, {
    fromName: fields.from_name || '', fromDomain: fields.from_domain || ''
  });
  const result = facts ? recordConfirmedMail(event, facts) : aiCandidate
    ? await processIntakeEvent(event, {
      bodyText, subject: parsed.subject, fromDomain: fields.from_domain || '', fromName: fields.from_name || '',
      receivedAt: event.occurred_at, statusText: parsed.classification.category
    })
    : processMailEvent(event);
  if (leaseId && !currentBinding(connection.id, connection.binding_version, leaseId)) {
    return { state: 'aborted', aborted: true, reason: 'binding_changed', result };
  }
  if (result.review) {
    run('UPDATE mail_messages SET review_item_id = ?, processing_state = ? WHERE id = ?',
      [result.review.id, 'pending', mailId]);
  } else if (result.state === 'ignored') {
    run("UPDATE mail_messages SET processing_state = 'ignored' WHERE id = ?", [mailId]);
  } else if (result.state === 'applied') {
    run("UPDATE mail_messages SET processing_state = 'applied' WHERE id = ?", [mailId]);
  }
  return {
    event: one('SELECT * FROM events WHERE id = ?', [eventId]),
    mail: mailId ? one('SELECT * FROM mail_messages WHERE id = ?', [mailId]) : null,
    result
  };
}

async function ingestMessage(connection, message, parsed, bodyText, receivedAt, { leaseId = null } = {}) {
  if (leaseId && !currentBinding(connection.id, connection.binding_version, leaseId)) {
    return { state: 'aborted', aborted: true, reason: 'binding_changed' };
  }
  const sourceKey = messageUidKey(connection.id, 'INBOX', parsed.uidvalidity, message.uid);
  const existingEvent = one(`SELECT * FROM events WHERE connection_id = ? AND mailbox = 'INBOX' AND uidvalidity = ? AND uid = ?`,
    [connection.id, parsed.uidvalidity, String(message.uid)]);
  if (existingEvent) {
    const mail = one(`SELECT * FROM mail_messages WHERE connection_id = ? AND mailbox = 'INBOX' AND uidvalidity = ? AND uid = ?`,
      [connection.id, parsed.uidvalidity, String(message.uid)]);
    const review = one('SELECT id FROM review_items WHERE source_event_id = ? LIMIT 1', [existingEvent.id]);
    const aiRun = one('SELECT status, next_retry_at FROM ai_ingest_runs WHERE event_id = ?', [existingEvent.id]);
    const retryBlocked = aiRun?.status === 'failed' || (aiRun?.status === 'retry' &&
      aiRun.next_retry_at && Date.parse(aiRun.next_retry_at) > Date.now());
    // A crash after the insert must not strand an event forever. Resume only when
    // no user review exists; ordinary applied/ignored events remain idempotent.
    if (review && connection.mode === 'recruitment_body' && parsed.backfill) {
      const open = one("SELECT id FROM review_items WHERE id=? AND status='open'", [review.id]);
      if (!open) return { duplicate: true };
      existingEvent.payload = {
        ...JSON.parse(existingEvent.payload_json),
        read_mode: connection.mode,
        body_excerpt: publicEvidence({ subject: parsed.subject, bodyText, mode: connection.mode }).body_excerpt,
        ai_body_excerpt: normalizeWhitespace(bodyText, 4000) || null,
        body_review_version: 1
      };
      run('UPDATE events SET payload_json=? WHERE id=?', [JSON.stringify(existingEvent.payload), existingEvent.id]);
      let result = null;
      if (parsed.confirmed) {
        result = recordConfirmedMail(existingEvent, parsed.confirmed);
      } else if (config.autoIntakeEnabled && bodyText.trim()) {
        result = await processIntakeEvent(existingEvent, {
          bodyText, subject: parsed.subject, fromDomain: parsed.fields.from_domain || '',
          fromName: parsed.fields.from_name || '', receivedAt: existingEvent.occurred_at, statusText: parsed.classification.category
        });
      }
      if (result?.state === 'applied' && result.application?.id) {
        run("UPDATE review_items SET status='resolved',resolved_at=?,version=version+1,resolution_json=? WHERE id=? AND status='open'",
          [nowIso(), JSON.stringify({ source: 'mail', application_id: result.application.id }), open.id]);
        run("UPDATE mail_messages SET processing_state='applied' WHERE id=?", [mail.id]);
        return { duplicate: true, result };
      }
      return { duplicate: true, result };
    }
    if (existingEvent.processing_state === 'pending' && !review && !retryBlocked) {
      const recovered = await runEventPipeline(connection, mail?.id || null, existingEvent.id, parsed, bodyText, { leaseId });
      return { duplicate: true, recovered: true, ...recovered };
    }
    return { duplicate: true, event: existingEvent, mail };
  }
  const alreadyMail = one(`SELECT * FROM mail_messages WHERE connection_id = ? AND mailbox = 'INBOX' AND uidvalidity = ? AND uid = ?`,
    [connection.id, parsed.uidvalidity, String(message.uid)]);
  if (alreadyMail) return { duplicate: true, mail: alreadyMail };
  if (message.messageId) {
    const byMessageId = one(`SELECT * FROM mail_messages WHERE connection_id = ? AND message_id = ? LIMIT 1`,
      [connection.id, message.messageId]);
    if (byMessageId) return { duplicate: true, mail: byMessageId };
  }
  const mailId = newId('mail');
  const classification = parsed.classification;
  const fields = parsed.fields;
  const aiCandidate = Boolean(config.autoIntakeEnabled && parsed.tentativeHeader);
  const eventId = newId('evt');
  const payload = {
    source_mail_id: mailId,
    source_received_at: receivedAt,
    category: classification.category,
    confidence: classification.confidence,
    status_text: classification.category,
    mapped_status: classification.status,
    company_name: fields.company_name,
    job_title: fields.job_title,
    site_application_id: fields.site_application_id,
    from_domain: fields.from_domain,
    from_name: fields.from_name || null,
    subject_excerpt: publicEvidence({ subject: parsed.subject, bodyText, mode: connection.mode }).subject_excerpt,
    body_excerpt: publicEvidence({ subject: parsed.subject, bodyText, mode: connection.mode }).body_excerpt,
    read_mode: connection.mode,
    body_review_version: connection.mode === 'recruitment_body' ? 1 : 0,
    company_only_progress: parsed.confirmed?.company_only_progress === true,
    title_inferred: parsed.confirmed?.title_inferred === true,
    recruitment_batch: parsed.confirmed?.recruitment_batch || null,
    ai_body_excerpt: normalizeWhitespace(bodyText, 4000) || null,
    round_label: classification.round_label,
    interview_scheduled_at: classification.interview_scheduled_at
  };
  // A site application id is the only strong mail match key. Company/title is left for review (D04).
  if (fields.site_application_id) {
    const exact = all('SELECT * FROM applications WHERE owner_id = ? AND site_application_id = ?',
      [connection.owner_id, fields.site_application_id]);
    if (exact.length === 1) {
      payload.site_key = exact[0].site_key;
      payload.company_name = exact[0].company_name;
      payload.job_title = exact[0].job_title;
      payload.job_url = exact[0].job_url;
      payload.status_url = exact[0].status_url;
      payload.site_job_id = exact[0].site_job_id;
    }
  }
  if (leaseId && !currentBinding(connection.id, connection.binding_version, leaseId)) {
    return { state: 'aborted', aborted: true, reason: 'binding_changed' };
  }
  transaction(() => {
    run(`INSERT INTO mail_messages
      (id, owner_id, connection_id, mailbox, uidvalidity, uid, message_id, subject_excerpt, from_domain, received_at,
       category, processing_state, created_at)
      VALUES (?, ?, ?, 'INBOX', ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [mailId, connection.owner_id, connection.id, parsed.uidvalidity, String(message.uid),
      message.messageId || null, payload.subject_excerpt, fields.from_domain, receivedAt, classification.category, nowIso()]);
    if ((classification.relevant && classification.status) || aiCandidate) {
      run(`INSERT INTO events
        (id, owner_id, client_event_id, source_method, event_type, site_key, site_application_id, occurred_at, observed_at,
         received_at, schema_version, parser_version, evidence_level, evidence_code, payload_json, payload_hash,
         processing_state, connection_id, mailbox, uidvalidity, uid)
        VALUES (?, ?, ?, 'mail', 'mail_progress_detected', ?, ?, ?, ?, ?, 'C1', 'mail-rules-1', ?, ?, ?, ?, 'pending', ?, 'INBOX', ?, ?)`,
      [eventId, connection.owner_id, `mail:${sourceKey}`, payload.site_key || null, fields.site_application_id || null,
        receivedAt, nowIso(), nowIso(), classification.confidence >= 0.85 ? 'strong' : 'weak',
        `mail-${classification.category}`, JSON.stringify(payload), sha256(`${sourceKey}:${classification.category}`),
        connection.id, parsed.uidvalidity, String(message.uid)]);
      run('UPDATE mail_messages SET processing_state = ?, category = ? WHERE id = ?',
        [aiCandidate ? 'pending' : 'applied', classification.category, mailId]);
    } else {
      run('UPDATE mail_messages SET processing_state = ? WHERE id = ?', ['ignored', mailId]);
    }
  });
  if ((classification.relevant && classification.status) || aiCandidate) {
    return runEventPipeline(connection, mailId, eventId, parsed, bodyText, { leaseId });
  }
  return { created: true, mail: one('SELECT * FROM mail_messages WHERE id = ?', [mailId]) };
}

function renewLease(connectionId, bindingVersion, leaseId) {
  const until = new Date(Date.now() + 10 * 60000).toISOString();
  const result = run(`UPDATE mail_connections SET sync_lease_until = ?
    WHERE id = ? AND binding_version = ? AND sync_lease_owner = ? AND status <> 'disconnected'`,
  [until, connectionId, bindingVersion, leaseId]);
  return result.changes > 0;
}

export async function syncConnection(connectionId, { ownerId = null } = {}) {
  const connection = one(`SELECT * FROM mail_connections WHERE id = ? ${ownerId ? 'AND owner_id = ?' : ''}`,
    ownerId ? [connectionId, ownerId] : [connectionId]);
  if (!connection) throw new AppError(404, 'NOT_FOUND', '邮箱连接不存在');
  if (connection.status === 'disconnected') return { status: 'disconnected', skipped: true };
  if (connection.binding_version < 1) return { status: 'disconnected', skipped: true };
  const lease = getLease(connection.id);
  if (!lease) return { status: 'busy', skipped: true };
  const fresh = one('SELECT * FROM mail_connections WHERE id = ?', [connection.id]);
  let password;
  try {
    password = decryptCredential(fresh);
  } catch (err) {
    markConnectionError(fresh, { status: 'reauth_required', code: 'REAUTH_REQUIRED', message: '邮箱授权无法读取，请重新授权' }, { leaseId: lease });
    return { status: 'reauth_required', error: err.message };
  }
  if (!password) {
    markConnectionError(fresh, { status: 'reauth_required', code: 'REAUTH_REQUIRED', message: '邮箱授权已失效，请重新授权' }, { leaseId: lease });
    return { status: 'reauth_required' };
  }
  let client;
  let lock;
  let stage = 'connect';
  const stats = {
    phase: 'connecting', phase_label: '正在连接邮箱…', percent: null,
    started_at: nowIso(), finished_at: null,
    total: 0, scanned: 0, fetched: 0, new: 0, processed: 0, applied: 0, pending: 0,
    ignored: 0, duplicate: 0, errors: 0, remaining: 0, batch_limit: 50
  };
  const saveStats = () => {
    run('UPDATE mail_connections SET last_sync_stats_json=? WHERE id=? AND binding_version=? AND sync_lease_owner=?',
      [JSON.stringify(stats), fresh.id, fresh.binding_version, lease]);
  };
  saveStats();
  try {
    client = new ImapFlow({
      host: imapHostFor(fresh.email) === 'imap.qq.com'
        ? process.env.IMAP_HOST || 'imap.qq.com' : imapHostFor(fresh.email),
      port: IMAP_PORT,
      secure: IMAP_PORT === 993,
      auth: { user: fresh.email, pass: password },
      clientInfo: { name: 'Tounar', version: '0.1.0', vendor: 'Tounar', 'support-email': 'support@tounar.local' },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: config.imapConnectTimeoutMs,
      greetingTimeout: config.imapConnectTimeoutMs,
      socketTimeout: 30000
    });
    client.on('error', (err) => logSyncError(fresh.id, 'imap_socket', err));
    await client.connect();
    stage = 'mailbox_lock';
    lock = await client.getMailboxLock('INBOX', { readOnly: true });
    const uidValidity = String(client.mailbox?.uidValidity || '0');
    let cursor = one('SELECT * FROM mail_cursors WHERE connection_id = ? AND mailbox = ?', [fresh.id, 'INBOX']);
    const scanSince = parseIso(fresh.scan_since) || new Date(Date.now() - 30 * 86400000).toISOString();
    let uids = [];
    let firstScanTotal = fresh.first_scan_total;
    stats.phase = 'searching'; stats.phase_label = '正在获取邮件数量…'; stats.percent = null; saveStats();
    stage = 'search';
    if (!cursor || cursor.uidvalidity !== uidValidity || !cursor.last_uid) {
      const search = await client.search({ since: new Date(scanSince) }, { uid: true });
      uids = Array.isArray(search) ? search.filter(Number.isFinite).sort((a, b) => a - b) : [];
      // A missing/reset cursor starts a new baseline; never carry a stale total
      // across UID-validity changes.
      firstScanTotal = uids.length;
    } else {
      const last = Number(cursor.last_uid || 0);
      const search = await client.search({ uid: `${last + 1}:*` }, { uid: true });
      uids = (Array.isArray(search) ? search : []).filter((uid) => uid > last).sort((a, b) => a - b);
    }
    const backfill = fresh.mode === 'recruitment_body' ? all(
      `SELECT DISTINCT e.uid FROM events e JOIN review_items r ON r.source_event_id=e.id
       WHERE e.connection_id=? AND e.uidvalidity=? AND r.status='open'
       AND COALESCE(json_extract(e.payload_json,'$.body_review_version'),0)<1`,
      [fresh.id, uidValidity]).map((r) => Number(r.uid)).filter(Number.isSafeInteger) : [];
    const historical = new Set(backfill);
    const work = [...new Set([...uids, ...backfill])].sort((a,b) => a-b);
    stats.total = work.length;
    stats.scanned = 0;
    firstScanTotal = Math.max(Number(firstScanTotal || 0), work.length);
    stats.phase = 'scanning';
    stats.phase_label = work.length ? `正在扫描 0 / ${work.length} 封` : '没有新邮件';
    stats.percent = work.length ? 0 : 99;
    let publishCount = 0;
    const publish = (force = false) => {
      publishCount += 1;
      if (!force && stats.total > 30 && publishCount % 3 !== 0) return;
      stats.phase_label = stats.phase === 'scanning'
        ? `正在扫描 ${stats.scanned} / ${stats.total} 封`
        : stats.phase_label;
      run(`UPDATE mail_connections SET status='syncing',last_sync_stats_json=?
        WHERE id=? AND binding_version=? AND sync_lease_owner=?`,
      [JSON.stringify(stats), fresh.id, fresh.binding_version, lease]);
    };
    publish(true);
    let lastProcessedUid = cursor?.uidvalidity === uidValidity ? Number(cursor.last_uid || 0) : 0;
    let bodyError = null;
    let aborted = false;
    for (let offset = 0; offset < work.length; offset += 50) {
      const batch = work.slice(offset, offset + 50);
      stage = 'fetch';
      const messages = await client.fetchAll(batch.join(','), {
        uid: true, envelope: true, internalDate: true, bodyStructure: true, size: true
      }, { uid: true });
      stats.fetched += messages.length;
      let seen = 0;
      for (const message of messages.sort((a,b) => a.uid-b.uid)) {
        seen += 1;
        stage = 'ingest';
        if (seen % 10 === 1 && !renewLease(fresh.id, fresh.binding_version, lease)) {
          aborted = true;
          break;
        }
        if (!currentBinding(fresh.id, fresh.binding_version, lease)) {
          aborted = true;
          break;
        }
        const from = addressFromEnvelope(message.envelope);
        const subject = decodeMimeWords(message.envelope?.subject || '');
        const receivedAt = message.internalDate instanceof Date
          ? message.internalDate.toISOString()
          : (parseIso(message.internalDate) || nowIso());
        let bodyText = '';
        const tentativeHeader = historical.has(message.uid) || isRecruitmentHeader(subject, from.address, '');
        if (fresh.mode === 'recruitment_body' && tentativeHeader) {
          const html = findHtmlPart(message.bodyStructure);
          const plain = findTextPart(message.bodyStructure) || html;
          if (plain) {
            try {
              stage = 'body_download';
              const raw = await downloadPart(client, message.uid, plain);
              bodyText = plain.type === 'text/html' ? stripHtml(raw, true) : raw.replace(/\r\n?/g, '\n').slice(0, 12000);
            } catch (err) {
              logSyncError(fresh.id, 'body_download', err);
              bodyError = { uid: message.uid, code: err?.code || 'MAIL_BODY_DOWNLOAD_FAILED', message: err?.message || '正文下载失败' };
              stats.errors += 1;
              break; // 游标停在上一封成功邮件，下一轮重试这封
            }
          }
        }
        stage = 'ingest';
        const classification = classifyRecruitmentMail({
          subject, fromDomain: from.address.split('@')[1] || '', bodyText, mode: fresh.mode
        });
        const fields = extractMailFields({ subject, bodyText, fromAddress: from.address, fromName: from.name });
        /* D09 第一阶段（2026-10-22）：规则拿不准时（不像招聘邮件 / 类别不明 / 公司名缺失），
           调用 WorkBuddy 云端大模型兜底。LLM 置信度封顶 0.88，结果只进待确认队列，
           永远不会触发 D08 的自动终态；云端失败静默回退纯规则结果。 */
        if (!config.autoIntakeEnabled && cloudLlmAvailable() && tentativeHeader &&
            (!classification.relevant || classification.category === 'other' || !fields.company_name)) {
          const llm = await llmClassifyMail({ subject, bodyText });
          if (llm) {
            if (!classification.relevant && llm.relevant && llm.confidence >= 0.5) {
              const llmStatus = { assessment: 'assessment', interview: 'interview', offer: 'offer', rejection: 'rejected' }[llm.category] || null;
              classification.relevant = true;
              classification.category = llm.category === 'rejection' ? 'rejected' : (llm.category || 'other');
              classification.status = llmStatus;
              classification.confidence = llm.confidence;
              classification.reason = 'cloud_llm';
            }
            if (!fields.company_name && llm.company_name) fields.company_name = llm.company_name;
            if (!fields.job_title && llm.job_title) fields.job_title = llm.job_title;
          }
        }
        const parsed = { uidvalidity: uidValidity, subject, classification, fields, tentativeHeader,
          confirmed: confirmedMailProgress(subject, bodyText, { fromName: from.name, fromDomain: from.address.split('@')[1] || '' }), backfill: historical.has(message.uid) };
        const ingested = await ingestMessage(fresh, {
          uid: message.uid,
          messageId: message.envelope?.messageId || null
        }, parsed, bodyText, receivedAt, { leaseId: lease });
        if (ingested.aborted) {
          aborted = true;
          break;
        }
        if (ingested.duplicate) stats.duplicate += 1;
        else if (ingested.created || ingested.mail) stats.new += 1;
        const pipeline = ingested.result;
        if (pipeline) {
          stats.processed += 1;
          if (pipeline.state === 'pending' || pipeline.review) stats.pending += 1;
          else if (pipeline.state === 'ignored') stats.ignored += 1;
          else if (pipeline.state === 'applied') stats.applied += 1;
          else if (pipeline.state === 'retry' || pipeline.state === 'failed') stats.errors += 1;
        } else if (!ingested.duplicate) {
          stats.processed += 1;
        }
        lastProcessedUid = Math.max(lastProcessedUid, message.uid);
        stats.scanned += 1;
        stats.remaining = Math.max(0, stats.total - stats.scanned);
        stats.percent = Math.min(99, stats.total ? Math.floor((stats.scanned / stats.total) * 100) : 99);
        publish();
      }
      if (bodyError || aborted) break;
      // SEARCH and FETCH can race an expunge. Count vanished UIDs as checked.
      stats.scanned += batch.length - messages.length;
      stats.remaining = Math.max(0, stats.total - stats.scanned);
      stats.percent = Math.min(99, stats.total ? Math.floor((stats.scanned / stats.total) * 100) : 99);
      lastProcessedUid = Math.max(lastProcessedUid, batch[batch.length - 1]);
      if (!currentBinding(fresh.id, fresh.binding_version, lease)) { aborted = true; break; }
      run('UPDATE mail_connections SET first_scan_total=? WHERE id=? AND sync_lease_owner=?', [firstScanTotal, fresh.id, lease]);
      commitCursor(fresh, { mailbox: 'INBOX', uidvalidity: uidValidity, lastUid: lastProcessedUid });
      publish();
    }
    stage = 'finalize';
    stats.phase = 'finalizing'; stats.phase_label = '正在整理同步结果…'; saveStats();
    if (aborted || !renewLease(fresh.id, fresh.binding_version, lease) ||
        !currentBinding(fresh.id, fresh.binding_version, lease)) {
      stats.finished_at = nowIso();
      stats.remaining = stats.total - stats.scanned;
      return { status: 'superseded', skipped: true, ...stats, last_uid: lastProcessedUid };
    }
    const processedCount = firstScanProcessedCount(fresh.id, uidValidity, firstScanTotal);
    stats.remaining = stats.total - stats.scanned;
    stats.finished_at = nowIso();
    const nextCursor = { mailbox: 'INBOX', uidvalidity: uidValidity, lastUid: lastProcessedUid };
    stats.phase = 'done';
    stats.phase_label = stats.total === 0 ? '没有新邮件' : `已扫描 ${stats.total} / ${stats.total} 封（100%）`;
    stats.percent = 100;
    stats.remaining = 0;
    if (bodyError) {
      stats.phase = 'error'; stats.phase_label = '正文下载失败，已保留游标'; stats.percent = Math.min(99, stats.percent);
      const info = {
        status: 'degraded',
        code: bodyError.code || 'MAIL_BODY_DOWNLOAD_FAILED',
        message: `邮件正文下载失败（UID ${bodyError.uid}）：${bodyError.message}；已保留游标，下次继续重试`
      };
      markConnectionError(fresh, info, { leaseId: lease, cursor: nextCursor, stats });
      return { status: 'degraded', code: info.code, error: info.message, uidvalidity: uidValidity, ...stats, last_uid: lastProcessedUid };
    }
    publish(true);
    const committed = markConnectionSuccess(fresh, nextCursor, firstScanTotal, processedCount, { leaseId: lease, stats });
    if (!committed) {
      return { status: 'superseded', skipped: true, ...stats, last_uid: lastProcessedUid };
    }
    return {
      status: 'connected',
      uidvalidity: uidValidity,
      ...stats,
      last_uid: lastProcessedUid,
      first_scan_total: firstScanTotal ?? null,
      first_scan_processed: processedCount
    };
  } catch (err) {
    const info = classifyError(err);
    logSyncError(fresh.id, stage, err);
    if (info.code === 'IMAP_SYNC_FAILED') {
      const errorName = String(err?.name || 'Error').replace(/[^A-Za-z]/g, '').slice(0, 40) || 'Error';
      const programmingError = err instanceof ReferenceError || err instanceof TypeError || err instanceof RangeError;
      const detail = programmingError ? `: ${String(err.message || '').slice(0, 160)}` : '';
      info.message = `邮箱同步失败（${stage} / ${errorName}${detail}），已保留上次成功结果`;
    }
    stats.phase = 'error'; stats.phase_label = '同步失败'; stats.finished_at = nowIso();
    stats.errors += 1;
    markConnectionError(fresh, info, { leaseId: lease, stats });
    return { status: info.status, code: info.code, error: info.message, ...stats };
  } finally {
    try { lock?.release(); } catch { /* ignore */ }
    try { if (client?.usable) await client.logout(); } catch { /* ignore */ }
  }
}

export async function syncAllConnections() {
  const connections = all(`SELECT id FROM mail_connections WHERE status IN ('connected','degraded','connecting','reauth_required')
    ORDER BY COALESCE(last_sync_attempt_at, created_at) ASC LIMIT 20`);
  const results = [];
  for (const connection of connections) {
    results.push({ connection_id: connection.id, ...(await syncConnection(connection.id)) });
  }
  return results;
}

export function encoderForTest() {
  return {
    messageUidKey, findTextPart, findHtmlPart, decodeMimeWords, classifyError,
    firstScanProcessedCount, ingestMessage, downloadPart, currentBinding, renewLease
  };
}
