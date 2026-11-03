import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as sqlite from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import { config } from '../config.js';
import { closeDb, getDb, setPersistenceHook } from '../db.js';
import { publicConfig } from './runtime-config.js';

const TABLE = 'app_sqlite_snapshot_vault';
const FORMAT = 'tounar-sqlite-snapshot-v1';
const MAX_RESTORE_BYTES = 256 * 1024 * 1024;
let enabled = false;
let client = null;
let stream = config.cloudSnapshotStream;
let state = 'disabled';
let revision = 0;
let dirty = false;
let chain = Promise.resolve();
let timer = null;
let lastErrorCode = null;
let lastSuccessAt = null;

function aad(forStream, forRevision) {
  return `${FORMAT}:${forStream}:${forRevision}`;
}

export function encryptSnapshot(raw, key, forStream, forRevision) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad(forStream, forRevision)));
  const compressed = gzipSync(raw, { level: 6 });
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return JSON.stringify({
    format: FORMAT,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  });
}

export function decryptSnapshot(payload, key, forStream, forRevision) {
  const packed = JSON.parse(payload);
  if (packed.format !== FORMAT || !packed.iv || !packed.tag || !packed.data) throw new Error('SNAPSHOT_FORMAT_INVALID');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(packed.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad(forStream, forRevision)));
  decipher.setAuthTag(Buffer.from(packed.tag, 'base64'));
  const compressed = Buffer.concat([decipher.update(Buffer.from(packed.data, 'base64')), decipher.final()]);
  return gunzipSync(compressed, { maxOutputLength: MAX_RESTORE_BYTES });
}

async function latestRows(limit = 20) {
  const { data, error } = await client.database.from(TABLE)
    .select('id,revision,payload,content_sha256')
    .eq('stream', stream)
    .order('revision', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

function errorCode(error) {
  return String(error?.code || error?.name || 'CLOUD_PERSISTENCE_ERROR').slice(0, 80);
}

function isRevisionConflict(error) {
  const code = String(error?.code || '').replace(/^DATABASE_/, '');
  return code === '23505' || code === 'SNAP1';
}

function logFailure(error, phase) {
  lastErrorCode = errorCode(error);
  console.error(JSON.stringify({ event: 'cloud_snapshot_failed', phase, code: lastErrorCode, stream }));
}

function schedule(delay = 150) {
  if (!enabled || !dirty || timer || state === 'conflict') return;
  timer = setTimeout(() => {
    timer = null;
    flushCloudPersistence().catch((error) => {
      logFailure(error, 'background');
      if (state !== 'conflict') schedule(5000);
    });
  }, delay);
  timer.unref();
}

export function markCloudSnapshotDirty() {
  if (!enabled) return;
  dirty = true;
  schedule();
}

export async function createConsistentSnapshot(source, destination, backupImplementation = sqlite.backup) {
  // Node 22.13 has DatabaseSync but no node:sqlite backup() export.
  // Checkpoint first, then copy synchronously without yielding to other JS writes.
  // The deployment contract allows one writer process and no worker-thread writers.
  fs.closeSync(fs.openSync(destination, 'wx', 0o600));
  try {
    if (typeof backupImplementation === 'function') {
      await backupImplementation(source, destination);
    } else {
      const main = source.prepare('PRAGMA database_list').all().find((row) => row.name === 'main');
      if (!main?.file) throw Object.assign(new Error('Snapshot source must be a file database'), { code: 'SNAPSHOT_SOURCE_INVALID' });
      const checkpoint = source.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (checkpoint.busy) throw Object.assign(new Error('SQLite WAL checkpoint is busy'), { code: 'SNAPSHOT_CHECKPOINT_BUSY' });
      // writeFileSync preserves the restrictive mode of the pre-created target.
      fs.writeFileSync(destination, fs.readFileSync(main.file));
    }
  } catch (error) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${destination}${suffix}`, { force: true });
    throw error;
  }
}

async function makeSnapshot() {
  const temp = path.join(config.dataDir, `.snapshot-${process.pid}-${crypto.randomUUID()}.sqlite`);
  try {
    await createConsistentSnapshot(getDb(), temp);
    fs.chmodSync(temp, 0o600);
    const raw = fs.readFileSync(temp);
    return { raw, sha256: crypto.createHash('sha256').update(raw).digest('hex') };
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${temp}${suffix}`, { force: true });
  }
}

async function uploadSnapshot() {
  const snapshot = await makeSnapshot();
  const remote = (await latestRows(1))[0] || null;
  const remoteRevision = Number(remote?.revision || 0);
  if (remoteRevision > revision) {
    // If the previous insert succeeded but its response was lost, accepting the
    // identical remote snapshot is safe. A different newer snapshot is not.
    if (remote.content_sha256 === snapshot.sha256) {
      const restored = decryptSnapshot(remote.payload, config.masterKey, stream, remoteRevision);
      if (crypto.createHash('sha256').update(restored).digest('hex') === snapshot.sha256) {
        revision = remoteRevision;
        lastSuccessAt = new Date().toISOString();
        lastErrorCode = null;
        state = 'ready';
        return;
      }
    }
    state = 'conflict';
    dirty = true;
    throw Object.assign(new Error('A newer cloud snapshot belongs to another writer'), { code: 'CLOUD_SNAPSHOT_CONFLICT' });
  }
  if (remoteRevision < revision) {
    state = 'conflict';
    dirty = true;
    throw Object.assign(new Error('Cloud snapshot history is older than this instance'), { code: 'CLOUD_SNAPSHOT_CONFLICT' });
  }
  const nextRevision = revision + 1;
  const payload = encryptSnapshot(snapshot.raw, config.masterKey, stream, nextRevision);
  const { error } = await client.database.rpc('append_app_sqlite_snapshot', {
    p_id: crypto.randomUUID(), p_stream: stream, p_revision: nextRevision,
    p_payload: payload, p_content_sha256: snapshot.sha256,
    p_writer_token: config.internalTickToken, p_expected_revision: revision
  });
  if (error) {
    dirty = true;
    state = isRevisionConflict(error) ? 'conflict' : 'degraded';
    throw error;
  }
  revision = nextRevision;
  lastSuccessAt = new Date().toISOString();
  lastErrorCode = null;
  state = 'ready';
}

async function drain() {
  if (!enabled) return;
  if (state === 'conflict') throw Object.assign(new Error('Cloud snapshot conflict requires a restart'), { code: 'CLOUD_SNAPSHOT_CONFLICT' });
  while (dirty) {
    dirty = false;
    try {
      await uploadSnapshot();
    } catch (error) {
      dirty = true;
      lastErrorCode = errorCode(error);
      if (state !== 'conflict') state = 'degraded';
      throw error;
    }
  }
}

export function flushCloudPersistence() {
  const operation = chain.then(drain);
  chain = operation.catch(() => {});
  return operation;
}

export async function initCloudPersistence({ injectedClient = null } = {}) {
  enabled = config.cloudPersistenceEnabled || Boolean(injectedClient);
  if (!enabled) {
    state = 'disabled';
    setPersistenceHook(null);
    return { enabled: false, restored: false };
  }
  client = injectedClient || createWorkBuddyCloud(publicConfig);
  stream = config.cloudSnapshotStream;
  state = 'restoring';
  const rows = await latestRows(20);
  let restored = false;
  for (const row of rows) {
    try {
      const raw = decryptSnapshot(row.payload, config.masterKey, stream, Number(row.revision));
      const digest = crypto.createHash('sha256').update(raw).digest('hex');
      if (digest !== row.content_sha256) throw new Error('SNAPSHOT_HASH_MISMATCH');
      const temp = `${config.dbPath}.restore-${process.pid}-${crypto.randomUUID()}`;
      let check = null;
      try {
        fs.writeFileSync(temp, raw, { mode: 0o600 });
        check = new DatabaseSync(temp, { readOnly: true });
        const integrity = check.prepare('PRAGMA integrity_check').get().integrity_check;
        check.close();
        check = null;
        if (integrity !== 'ok') throw new Error('SNAPSHOT_INTEGRITY_FAILED');
        closeDb();
        fs.renameSync(temp, config.dbPath);
        fs.rmSync(`${config.dbPath}-wal`, { force: true });
        fs.rmSync(`${config.dbPath}-shm`, { force: true });
        revision = Number(row.revision);
        restored = true;
        break;
      } finally {
        if (check) {
          try { check.close(); } catch { /* best-effort cleanup after rejection */ }
        }
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${temp}${suffix}`, { force: true });
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'cloud_snapshot_rejected', code: errorCode(error), stream }));
    }
  }
  if (rows.length && !restored) {
    state = 'degraded';
    lastErrorCode = 'CLOUD_SNAPSHOT_RESTORE_FAILED';
    throw Object.assign(new Error('No valid cloud snapshot could be restored'), { code: 'CLOUD_SNAPSHOT_RESTORE_FAILED' });
  }
  dirty = false;
  lastErrorCode = null;
  state = 'ready';
  setPersistenceHook(markCloudSnapshotDirty);
  return { enabled: true, restored, revision };
}

export function cloudPersistenceStatus() {
  return {
    enabled,
    state,
    stream: enabled ? stream : null,
    revision,
    pending: dirty,
    last_success_at: lastSuccessAt,
    last_error_code: lastErrorCode
  };
}
