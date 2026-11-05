#!/usr/bin/env node
/* 内测库初始化 / 邀请码管理。只操作显式指定的 DATA_DIR；默认创建关闭状态的邀请码。
 * 用法：node server/scripts/init-beta.mjs --data-dir /path/to/beta-data [--show|--open|--close|--rotate]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'data-dir': { type: 'string' }, 'db-path': { type: 'string' },
  'max-uses': { type: 'string', default: '10' },
  show: { type: 'boolean', default: false },
  open: { type: 'boolean', default: false },
  close: { type: 'boolean', default: false },
  rotate: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false }
}, strict: true, allowPositionals: false });

const dataDir = path.resolve(values['data-dir'] || '');
if (!values['data-dir']) {
  console.error('必须显式提供 --data-dir（不要使用本机真实 data/）');
  process.exit(2);
}
if (dataDir === path.resolve('data') || dataDir.startsWith(path.resolve('data') + path.sep)) {
  console.error('拒绝默认操作本机真实 data/ 或 data/mail-selftest；请使用独立内测目录');
  process.exit(2);
}
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
process.env.DATA_DIR = dataDir;
if (values['db-path']) process.env.DB_PATH = path.resolve(values['db-path']);

const { openDatabase, one, run } = await import('../src/db.js');
const invite = await import('../src/modules/beta/invite.js');
const maxUses = Math.max(1, Number.parseInt(values['max-uses'], 10) || 10);
const db = openDatabase(process.env.DB_PATH || path.join(dataDir, 'tounar.sqlite'));

function status() {
  const s = invite.inviteStatus();
  const emails = s.invite_id ? db.prepare('SELECT email_normalized, redeemed_at FROM beta_invite_redemptions WHERE invite_id = ? ORDER BY redeemed_at').all(s.invite_id) : [];
  return { ...s, emails };
}
function print(obj) { if (values.json) console.log(JSON.stringify(obj, null, 2)); else console.log(JSON.stringify(obj, null, 2)); }
try {
  const existing = invite.activeInvite() || one('SELECT * FROM beta_invites ORDER BY created_at DESC LIMIT 1');
  if (values.show) {
    print({ data_dir: dataDir, ...status() });
    process.exit(0);
  }
  if (values.open || values.close) {
    if (!existing) throw new Error('尚未初始化邀请码，请先执行 init-beta（不带 --open/--close）');
    run('UPDATE beta_invites SET active = ? WHERE id = ?', [values.open ? 1 : 0, existing.id]);
    print({ data_dir: dataDir, ...status(), changed: values.open ? 'opened' : 'closed' });
    process.exit(0);
  }
  if (values.rotate) {
    if (!existing) throw new Error('尚未初始化邀请码');
    const wasActive = !!existing.active;
    const result = invite.rotateInvite({ maxUses: Math.max(maxUses, existing.used_count) });
    if (!wasActive) run('UPDATE beta_invites SET active = 0 WHERE id = ?', [result.id]);
    print({ data_dir: dataDir, ...status(), code: result.code, warning: '邀请码只在本次输出；请私密保存。' });
    process.exit(0);
  }
  if (existing) {
    print({ data_dir: dataDir, ...status(), reset: false, message: '已存在邀请码；未重置计数或资格' });
    process.exit(0);
  }
  const result = invite.createInvite({ maxUses });
  // 初始化和开放分离：新建后默认关闭，避免平台持久化验收前开放激活。
  run('UPDATE beta_invites SET active = 0 WHERE id = ?', [result.id]);
  print({ data_dir: dataDir, ...status(), code: result.code, warning: '邀请码默认关闭；完成平台验收后执行 --open。邀请码只在本次输出。' });
} finally { db.close(); }
