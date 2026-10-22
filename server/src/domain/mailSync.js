import { ImapFlow, AuthenticationFailure } from 'imapflow';
import { config } from '../config.js';
import { all, one, run, transaction } from '../db.js';
import {
  AppError, decryptSecret, newId, normalizeWhitespace, nowIso, parseIso, safeJsonParse, sha256
} from '../util.js';
import {
  candidateApplicationsForText, classifyRecruitmentMail, extractMailFields, isRecruitmentHeader, publicEvidence, stripHtml
} from './mailParser.js';
import { processMailEvent } from './applications.js';

const IMAP_HOST = process.env.IMAP_HOST || 'imap.qq.com';
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
  if (!part?.part) return '';
  try {
    const download = await client.download(uid, part.part, { uid: true, maxBytes: BODY_MAX_BYTES, binary: true });
    if (!download?.content) return '';
    return readStreamLimited(download.content);
  } catch {
    return '';
  }
}

function classifyError(err) {
  if (err instanceof AuthenticationFailure) return { status: 'reauth_required', code: 'IMAP_AUTH_FAILED', message: 'QQ 邮箱授权失效，请重新授权' };
  const text = String(err?.message || '');
  if (/AUTHENTICATIONFAILED|AUTHENTICATE|LOGIN failed|Invalid credentials|authorization/i.test(text)) {
    return { status: 'reauth_required', code: 'IMAP_AUTH_FAILED', message: 'QQ 邮箱授权失效，请重新授权' };
  }
  if (/CERT|TLS|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|network|socket/i.test(text)) {
    return { status: 'degraded', code: 'IMAP_NETWORK_ERROR', message: '暂时无法连接 QQ 邮箱，已保留上次同步结果' };
  }
  return { status: 'degraded', code: 'IMAP_SYNC_FAILED', message: '邮箱同步失败，已保留上次成功结果' };
}

function markConnectionError(connection, info) {
  run(`UPDATE mail_connections SET status = ?, last_sync_attempt_at = ?, last_error_code = ?, last_error_message = ?,
       updated_at = ?, sync_lease_until = NULL, sync_lease_owner = NULL WHERE id = ?`,
  [info.status, nowIso(), info.code, info.message, nowIso(), connection.id]);
}

function markConnectionSuccess(connection, cursor, firstScanTotal, firstScanProcessed) {
  run(`UPDATE mail_connections SET status = 'connected', last_sync_attempt_at = ?, last_sync_success_at = ?,
       last_error_code = NULL, last_error_message = NULL, first_scan_total = COALESCE(?, first_scan_total),
       first_scan_processed = ?, updated_at = ?, sync_lease_until = NULL, sync_lease_owner = NULL WHERE id = ?`,
  [nowIso(), nowIso(), firstScanTotal, firstScanProcessed, nowIso(), connection.id]);
  if (cursor) {
    run(`INSERT INTO mail_cursors (connection_id, owner_id, mailbox, uidvalidity, last_uid, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(connection_id, mailbox) DO UPDATE SET uidvalidity = excluded.uidvalidity,
           last_uid = excluded.last_uid, updated_at = excluded.updated_at`,
    [connection.id, connection.owner_id, cursor.mailbox, cursor.uidvalidity, String(cursor.lastUid), nowIso()]);
  }
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

function decodeCredential(connection) {
  if (!connection.credential_ciphertext) throw new AppError(409, 'REAUTH_REQUIRED', '邮箱授权已失效，请重新授权');
  return decryptSecret(connection.credential_ciphertext, connection.credential_iv, connection.credential_tag);
}

function messageUidKey(connectionId, mailbox, uidvalidity, uid) {
  return `${connectionId}:${mailbox}:${uidvalidity}:${uid}`;
}

function ingestMessage(connection, message, parsed, bodyText, receivedAt) {
  const sourceKey = messageUidKey(connection.id, 'INBOX', parsed.uidvalidity, message.uid);
  const existingEvent = one(`SELECT * FROM events WHERE connection_id = ? AND mailbox = 'INBOX' AND uidvalidity = ? AND uid = ?`,
    [connection.id, parsed.uidvalidity, String(message.uid)]);
  if (existingEvent) return { duplicate: true, event: existingEvent };
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
  const eventId = newId('evt');
  const payload = {
    category: classification.category,
    confidence: classification.confidence,
    status_text: classification.category,
    mapped_status: classification.status,
    company_name: fields.company_name,
    job_title: fields.job_title,
    site_application_id: fields.site_application_id,
    from_domain: fields.from_domain,
    subject_excerpt: publicEvidence({ subject: parsed.subject, bodyText, mode: connection.mode }).subject_excerpt,
    body_excerpt: publicEvidence({ subject: parsed.subject, bodyText, mode: connection.mode }).body_excerpt,
    read_mode: connection.mode,
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
  transaction(() => {
    run(`INSERT INTO mail_messages
      (id, owner_id, connection_id, mailbox, uidvalidity, uid, message_id, subject_excerpt, from_domain, received_at,
       category, processing_state, created_at)
      VALUES (?, ?, ?, 'INBOX', ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [mailId, connection.owner_id, connection.id, parsed.uidvalidity, String(message.uid),
      message.messageId || null, payload.subject_excerpt, fields.from_domain, receivedAt, classification.category, nowIso()]);
    if (classification.relevant && classification.status) {
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
        ['applied', classification.category, mailId]);
    } else {
      run('UPDATE mail_messages SET processing_state = ? WHERE id = ?', ['ignored', mailId]);
    }
  });
  if (classification.relevant && classification.status) {
    const event = one('SELECT * FROM events WHERE id = ?', [eventId]);
    event.payload = JSON.parse(event.payload_json);
    const result = processMailEvent(event);
    if (result.review) {
      run('UPDATE mail_messages SET review_item_id = ?, processing_state = ? WHERE id = ?',
        [result.review.id, 'pending', mailId]);
    }
    return { event: one('SELECT * FROM events WHERE id = ?', [eventId]), mail: one('SELECT * FROM mail_messages WHERE id = ?', [mailId]), result };
  }
  return { mail: one('SELECT * FROM mail_messages WHERE id = ?', [mailId]) };
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
    markConnectionError(fresh, { status: 'reauth_required', code: 'REAUTH_REQUIRED', message: '邮箱授权无法读取，请重新授权' });
    return { status: 'reauth_required', error: err.message };
  }
  if (!password) {
    markConnectionError(fresh, { status: 'reauth_required', code: 'REAUTH_REQUIRED', message: '邮箱授权已失效，请重新授权' });
    return { status: 'reauth_required' };
  }
  let client;
  let lock;
  const startedAt = nowIso();
  try {
    client = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: IMAP_PORT === 993,
      auth: { user: fresh.email, pass: password },
      clientInfo: { name: 'Tounar', version: '0.1.0', vendor: 'Tounar' },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: config.imapConnectTimeoutMs,
      greetingTimeout: config.imapConnectTimeoutMs,
      socketTimeout: 30000
    });
    await client.connect();
    lock = await client.getMailboxLock('INBOX', { readOnly: true });
    const uidValidity = String(client.mailbox?.uidValidity || '0');
    let cursor = one('SELECT * FROM mail_cursors WHERE connection_id = ? AND mailbox = ?', [fresh.id, 'INBOX']);
    const scanSince = parseIso(fresh.scan_since) || new Date(Date.now() - 30 * 86400000).toISOString();
    let uids = [];
    let firstScanTotal = fresh.first_scan_total;
    if (!cursor || cursor.uidvalidity !== uidValidity || !cursor.last_uid) {
      const search = await client.search({ since: new Date(scanSince) }, { uid: true });
      uids = Array.isArray(search) ? search.filter(Number.isFinite).sort((a, b) => a - b) : [];
      if (firstScanTotal == null) firstScanTotal = uids.length;
    } else {
      const last = Number(cursor.last_uid || 0);
      const search = await client.search({ uid: `${last + 1}:*` }, { uid: true });
      uids = (Array.isArray(search) ? search : []).filter((uid) => uid > last).sort((a, b) => a - b);
    }
    const batch = uids.slice(0, 50);
    let lastProcessedUid = cursor?.uidvalidity === uidValidity ? Number(cursor.last_uid || 0) : 0;
    let processedCount = fresh.first_scan_processed || 0;
    if (batch.length) {
      const messages = await client.fetchAll(batch.join(','), {
        uid: true, envelope: true, internalDate: true, bodyStructure: true, size: true
      }, { uid: true });
      for (const message of messages) {
        const current = one('SELECT binding_version, status FROM mail_connections WHERE id = ?', [fresh.id]);
        if (!current || current.status === 'disconnected') break;
        const from = addressFromEnvelope(message.envelope);
        const subject = decodeMimeWords(message.envelope?.subject || '');
        const receivedAt = message.internalDate instanceof Date
          ? message.internalDate.toISOString()
          : (parseIso(message.internalDate) || nowIso());
        let bodyText = '';
        const tentativeHeader = isRecruitmentHeader(subject, from.address, '');
        if (fresh.mode === 'recruitment_body' && tentativeHeader) {
          const html = findHtmlPart(message.bodyStructure);
          const plain = findTextPart(message.bodyStructure) || html;
          if (plain) {
            const raw = await downloadPart(client, message.uid, plain);
            bodyText = plain.type === 'text/html' ? stripHtml(raw) : normalizeWhitespace(raw, 12000);
          }
        }
        const classification = classifyRecruitmentMail({
          subject, fromDomain: from.address.split('@')[1] || '', bodyText, mode: fresh.mode
        });
        const fields = extractMailFields({ subject, bodyText, fromAddress: from.address });
        const parsed = { uidvalidity: uidValidity, subject, classification, fields };
        ingestMessage(fresh, {
          uid: message.uid,
          messageId: message.envelope?.messageId || null
        }, parsed, bodyText, receivedAt);
        lastProcessedUid = Math.max(lastProcessedUid, message.uid);
        processedCount++;
        run('UPDATE mail_connections SET first_scan_processed = ? WHERE id = ?', [processedCount, fresh.id]);
      }
    }
    markConnectionSuccess(fresh, {
      mailbox: 'INBOX', uidvalidity: uidValidity, lastUid: lastProcessedUid
    }, firstScanTotal, processedCount);
    return {
      status: 'connected',
      uidvalidity: uidValidity,
      fetched: batch.length,
      remaining: Math.max(0, uids.length - batch.length),
      last_uid: lastProcessedUid
    };
  } catch (err) {
    const info = classifyError(err);
    markConnectionError(fresh, info);
    return { status: info.status, code: info.code, error: info.message };
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
  return { messageUidKey, findTextPart, findHtmlPart, decodeMimeWords };
}
