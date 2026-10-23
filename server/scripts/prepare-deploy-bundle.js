#!/usr/bin/env node
/*
 * 准备一份「可部署的数据目录」：真实库的一致快照 + 同源密钥 + 清单。
 *
 * 为什么需要：config.js 的 loadOrCreateSecret() 会在文件不存在时随机生成密钥。
 * 线上容器重建后如果密钥变了，已加密的邮箱凭据就永久解不开（不是丢数据，是变乱码）。
 * 所以部署必须把 data/master.key 与 data/internal-tick.token 一起带走，
 * 并用环境变量 MASTER_KEY / INTERNAL_TICK_TOKEN 注入。
 *
 * 注意：本脚本只做「本机准备」，不发布、不联网、不写原库。
 * 输出目录包含真实业务数据与密钥，权限 700，禁止进 Git。
 *
 * 用法：
 *   node server/scripts/prepare-deploy-bundle.js \
 *     --source-db "/Users/…/帮你理/data/tounar.sqlite" \
 *     --out ~/tounar-deploy/<时间戳>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const sourceDb = path.resolve(opt('--source-db', path.join(os.homedir(), 'Desktop', 'opencode project', '帮你理', 'data', 'tounar.sqlite')));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const outDir = path.resolve(opt('--out', path.join(os.homedir(), 'tounar-deploy', stamp)));

if (!fs.existsSync(sourceDb)) {
  console.error(`❌ 找不到源库：${sourceDb}`);
  process.exit(1);
}
if (fs.existsSync(outDir)) {
  console.error(`❌ 输出目录已存在，换一个：${outDir}`);
  process.exit(1);
}

const sourceDataDir = path.dirname(sourceDb);
const keyFile = path.join(sourceDataDir, 'master.key');
const tokenFile = path.join(sourceDataDir, 'internal-tick.token');
for (const file of [keyFile, tokenFile]) {
  if (!fs.existsSync(file)) {
    console.error(`❌ 缺少密钥文件：${file}（没有它，线上解不开已加密的邮箱凭据）`);
    process.exit(1);
  }
}

process.umask(0o077);
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const dbFile = path.join(outDir, 'tounar.sqlite');

const source = new DatabaseSync(sourceDb, { readOnly: true });
await backup(source, dbFile);
source.close();
fs.chmodSync(dbFile, 0o600);

for (const file of [keyFile, tokenFile]) {
  const target = path.join(outDir, path.basename(file));
  fs.copyFileSync(file, target);
  fs.chmodSync(target, 0o600);
}

const db = new DatabaseSync(dbFile, { readOnly: true });
const count = (table) => {
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } catch { return null; }
};
const counts = { users: count('users'), applications: count('applications'), mail_messages: count('mail_messages'), review_items: count('review_items') };
const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
db.close();

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = {
  prepared_at: new Date().toISOString(),
  source_db: sourceDb,
  out_dir: outDir,
  counts,
  integrity,
  sha256: Object.fromEntries(['tounar.sqlite', 'master.key', 'internal-tick.token'].map((f) => [f, sha(path.join(outDir, f))])),
  required_env: ['APP_BASE_URL', 'MASTER_KEY', 'INTERNAL_TICK_TOKEN', 'ALLOWED_EMAILS', 'DATA_DIR', 'ENABLE_SCHEDULER=false'],
  warning: 'Contains the real business database and the master key. Never commit, never upload to a public bucket.'
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

console.log(`✅ 部署数据目录已准备好：${outDir}`);
console.log(`   业务数量：用户 ${counts.users} / 台账 ${counts.applications} / 邮件 ${counts.mail_messages} / 待确认 ${counts.review_items}`);
console.log(`   完整性：${integrity}`);
console.log(`   密钥：master.key / internal-tick.token 已同源复制（这是能解密旧数据的唯一一把）`);
console.log('\n下一步（在部署侧注入，明文只进环境变量）：');
console.log('   MASTER_KEY          = 内容见 ' + path.join(outDir, 'master.key'));
console.log('   INTERNAL_TICK_TOKEN = 内容见 ' + path.join(outDir, 'internal-tick.token'));
console.log('   DATA_DIR            = 把这个目录挂成持久卷后的容器内路径');
console.log('   APP_BASE_URL        = 最终公网域名（发布后回填，否则邮件链接仍指向本机）');
console.log('   ENABLE_SCHEDULER    = false（平台可能冷启动/多副本，改由外部 cron 打 /api/v1/internal/tick）');
