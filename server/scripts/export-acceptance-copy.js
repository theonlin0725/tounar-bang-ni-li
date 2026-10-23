/* Standalone Node >=24 tool. Read-only source; no app/config import, keys, SMTP
 * or schema migration. The export still contains private business records. */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw Error(`${name} requires a value`);
  return args[index + 1];
}
const source = path.resolve(option('--db', 'data/tounar.sqlite'));
const destination = option('--out', null);
if (!destination) throw Error('Usage: node export-acceptance-copy.js --db <source.sqlite> --out <new-directory>');
if (!fs.statSync(source).isFile()) throw Error('Source must be an existing SQLite file');
const output = path.resolve(destination);
// Never reuse a directory that may contain the user's existing data.
process.umask(0o077);
fs.mkdirSync(output, { mode: 0o700 });
const file = path.join(output, 'tounar.sqlite');
let original, copy;
try {
  original = new DatabaseSync(source, { readOnly: true });
  await backup(original, file);
  original.close(); original = null;
  fs.chmodSync(file, 0o600);
  copy = new DatabaseSync(file);
  copy.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
  const tables = new Set(copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const columns = new Set(copy.prepare('PRAGMA table_info(mail_connections)').all().map(row => row.name));
  const changes = ['credential_ciphertext', 'credential_iv', 'credential_tag', 'sync_lease_owner', 'sync_lease_until']
    .filter(column => columns.has(column)).map(column => `${column}=NULL`);
  if (columns.has('status')) changes.push("status='disconnected'");
  if (changes.length) copy.exec(`UPDATE mail_connections SET ${changes.join(',')}`);
  // Session/device hashes cannot create a new login. Remove them and all
  // encrypted confirmation tokens so no original key needs to travel.
  const cleared = ['reminder_confirmations', 'reminder_links', 'sessions', 'otp_challenges',
    'plugin_devices', 'plugin_pairings', 'idempotency_keys', 'rate_limits'];
  for (const table of cleared) if (tables.has(table)) copy.exec(`DELETE FROM ${table}`);
  copy.exec('COMMIT; VACUUM');
  const integrity = copy.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || copy.prepare('PRAGMA foreign_key_check').all().length) {
    throw Error('Export failed database integrity checks');
  }
  const counts = Object.fromEntries(['users', 'applications', 'mail_messages', 'review_items'].map(table =>
    [table, tables.has(table) ? copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : 0]));
  const report = { exported_at: new Date().toISOString(), counts, credentials_removed: true,
    keys_copied: false, mailbox_sync_disabled: true, cleared_tables: cleared.filter(table => tables.has(table)),
    privacy: 'Contains real business records and email excerpts; not an anonymized database.',
    required_test_environment: { MAIL_MODE: 'outbox', SMTP_URL: '', ENABLE_SCHEDULER: 'false', CLOUD_LLM_ENABLED: 'false' } };
  copy.close(); copy = null;
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ output, ...report }, null, 2));
} catch (error) {
  copy?.close(); original?.close();
  // Only this invocation's newly-created directory can be removed here.
  fs.rmSync(output, { recursive: true, force: true });
  throw error;
}
