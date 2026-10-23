#!/usr/bin/env node
/*
 * 一条命令起本地验收环境（P1）。
 *
 * 做的事：
 *   1. 校验 Node ≥ 24；
 *   2. 用 SQLite backup API 把真实库（含已提交 WAL）复制到 ~/tounar-acceptance/<时间戳>/；
 *      同时复制同源 master.key / internal-tick.token（否则邮箱凭据解不开），目录 700；
 *   3. 检查端口占用（lsof），被占就报出是谁，绝不杀进程；
 *   4. 以显式 DATA_DIR / DB_PATH / HOST=127.0.0.1 / PORT / APP_BASE_URL 启动，
 *      不继承原目录 .env 的 APP_BASE_URL；
 *   5. 自己用不走代理的请求验证 /api/v1/health 和 / 都 200，才打印“已就绪”；
 *   6. 进程 detach，agent 会话结束后仍存活；用 npm run local:stop 停止。
 *
 * 默认 MAIL_MODE=outbox（不发真信）。只有显式 --mail-mode=smtp 才从原 .env 读取
 * SMTP_URL 走真实发信，且收件人仍受 ALLOWED_EMAILS 限制。
 *
 * 真实库从不以读写方式打开；备份前原库保持不变。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DEFAULT_SOURCE_DIR = path.join(os.homedir(), 'Desktop', 'opencode project', '帮你理');
const ACCEPTANCE_BASE = path.join(os.homedir(), 'tounar-acceptance');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`无法识别的参数：${key}`);
    const name = key.slice(2);
    if (name === 'no-start') { out.noStart = true; continue; }
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) throw new Error(`${key} 需要一个值`);
    if (name === 'env') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) throw new Error(`--env 需要 KEY=VALUE，收到：${value}`);
      (out.env ||= []).push(value);
      i += 1;
      continue;
    }
    out[name] = value;
    i += 1;
  }
  return out;
}

function fail(message, hint) {
  console.error(`\n❌ ${message}`);
  if (hint) console.error(`   ${hint}`);
  process.exit(1);
}

function major(version) {
  return Number.parseInt(String(version).split('.')[0], 10);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 只读取指定的键，绝不把整份 .env 载入进程环境。 */
function readEnvKeys(file, names) {
  const text = fs.readFileSync(file, 'utf8');
  const wanted = new Set(names);
  const result = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!wanted.has(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function listeningOn(port) {
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    return output.trim().split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
  } catch {
    return []; // lsof 无匹配时退出码 1
  }
}

function requestHealth(port, pathName, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathName, method: 'GET', agent: false, timeout: timeoutMs,
      headers: { Connection: 'close' }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 4096) body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (error) => resolve({ status: 0, error: error.code || error.message }));
    req.end();
  });
}

async function waitReady(port, timeoutMs = 30000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const health = await requestHealth(port, '/api/v1/health');
    if (health.status === 200) return { ok: true, waitedMs: Date.now() - started };
    last = health;
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, last };
}

function countRows(dbFile, tables) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    const counts = {};
    for (const table of tables) {
      counts[table] = present.has(table) ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : null;
    }
    return counts;
  } finally {
    db.close();
  }
}

const args = parseArgs(process.argv.slice(2));
const port = Number.parseInt(args.port || process.env.LOCAL_ACCEPTANCE_PORT || '4311', 10);
const sourceDir = path.resolve(args['source-dir'] || DEFAULT_SOURCE_DIR);
const sourceDb = path.resolve(args['source-db'] || path.join(sourceDir, 'data', 'tounar.sqlite'));
const mailModeFlag = (args['mail-mode'] || 'outbox').toLowerCase();
const keepDir = args['data-dir'] ? path.resolve(args['data-dir']) : null;

// 1. Node 版本
if (major(process.versions.node) < 24) {
  fail(`需要 Node ≥ 24，当前是 ${process.versions.node}`,
    '用 Homebrew 安装的 Node 可执行：/opt/homebrew/bin/node；或 nvm install 24 && nvm use 24，再重跑本命令。');
}

if (!['outbox', 'smtp'].includes(mailModeFlag)) {
  fail(`--mail-mode 只支持 outbox 或 smtp，收到：${mailModeFlag}`);
}

// 2. 源库与密钥
if (!fs.existsSync(sourceDb)) {
  fail(`找不到真实数据库：${sourceDb}`,
    '如果库在别处，用 --source-db "<path>" 指定；只做本地空库试跑可先 npm start。');
}
const sourceDataDir = path.dirname(sourceDb);
const keyFile = path.join(sourceDataDir, 'master.key');
const tickFile = path.join(sourceDataDir, 'internal-tick.token');
const envFile = path.resolve(args['env-file'] || path.join(sourceDir, '.env'));
if (!fs.existsSync(keyFile)) {
  fail(`缺少同源密钥：${keyFile}`,
    '没有 master.key 就无法解密库里已保存的邮箱凭据，真实 IMAP/SMTP 会不可用；请确认备份目录结构。');
}

// 3. 端口
const occupied = listeningOn(port);
if (occupied.length) {
  fail(`端口 ${port} 已被占用：\n   ${occupied.join('\n   ')}`,
    `如果是上次的验收服务，先执行 npm run local:stop；否则换端口：npm run local:acceptance -- --port 4312。不会替你杀掉这个进程。`);
}

// 4. 验收目录与备份
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const targetDir = keepDir || path.join(ACCEPTANCE_BASE, stamp);
if (fs.existsSync(targetDir)) {
  fail(`目标目录已存在：${targetDir}`, '为避免覆盖已有副本，请换一个名字或不传 --data-dir。');
}
fs.mkdirSync(path.dirname(targetDir), { recursive: true, mode: 0o700 });
fs.mkdirSync(targetDir, { recursive: false, mode: 0o700 });
fs.chmodSync(targetDir, 0o700);

const dbFile = path.join(targetDir, 'tounar.sqlite');
let original = null;
try {
  original = new DatabaseSync(sourceDb, { readOnly: true });
  await backup(original, dbFile);
} catch (error) {
  fail(`复制数据库失败：${error.message}`, '源库可能正被写入或权限不足；请确认服务已停止后重试。');
} finally {
  try { original?.close(); } catch { /* ignore */ }
}
fs.chmodSync(dbFile, 0o600);
for (const file of [keyFile, tickFile]) {
  if (!fs.existsSync(file)) continue;
  const target = path.join(targetDir, path.basename(file));
  fs.copyFileSync(file, target);
  fs.chmodSync(target, 0o600);
}

const businessCounts = countRows(dbFile, ['users', 'applications', 'mail_messages', 'review_items']);
const manifest = {
  created_at: new Date().toISOString(),
  source_db: sourceDb,
  source_dir: sourceDir,
  copy_db: dbFile,
  data_dir: targetDir,
  port,
  mail_mode: mailModeFlag,
  node: process.versions.node,
  counts: businessCounts,
  sha256: { 'tounar.sqlite': sha256File(dbFile) },
  env_overrides: (args.env || []).map((pair) => pair.slice(0, pair.indexOf('='))),
  note: '真实业务数据副本（含个人信息），不是匿名库；只用于本机验收。'
};
fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

// 5. 组装启动环境：不读原 .env 的 PORT / APP_BASE_URL
const envFromFile = fs.existsSync(envFile)
  ? readEnvKeys(envFile, ['ALLOWED_EMAILS', 'SMTP_URL', 'MAIL_FROM', 'REMINDER_HOUR', 'REMINDER_MINUTE'])
  : {};

const childEnv = {
  ...process.env,
  DATA_DIR: targetDir,
  DB_PATH: dbFile,
  HOST: '127.0.0.1',
  PORT: String(port),
  APP_BASE_URL: `http://127.0.0.1:${port}`,
  APP_ENV: 'development',
  ENABLE_SCHEDULER: 'false',
  MAIL_MODE: mailModeFlag,
  SMTP_URL: mailModeFlag === 'smtp' ? (envFromFile.SMTP_URL || '') : '',
  MAIL_FROM: envFromFile.MAIL_FROM || '',
  ALLOWED_EMAILS: envFromFile.ALLOWED_EMAILS || 'demo@tounar.local,peer@tounar.local',
  REMINDER_HOUR: envFromFile.REMINDER_HOUR || '8',
  REMINDER_MINUTE: envFromFile.REMINDER_MINUTE || '0',
  // 云大模型默认关闭，避免验收时把邮件内容发到外部服务；需要时单独开。
  CLOUD_LLM_ENABLED: 'false'
};
if (mailModeFlag === 'smtp' && !childEnv.SMTP_URL) {
  fail('要求 --mail-mode=smtp，但源 .env 里没有 SMTP_URL。', '改用默认 outbox，或在原 .env 配置 SMTP_URL 后重试。');
}
// 额外覆盖（比如验收期放宽验证码频控：--env OTP_RESEND_SECONDS=0）。
// 只影响这个一次性副本，不写入原 .env。
for (const pair of args.env || []) {
  const eq = pair.indexOf('=');
  childEnv[pair.slice(0, eq)] = pair.slice(eq + 1);
}

// 给 CLI 脚本（run-reminders / run-mail-sync）用的环境文件：
// 不加这个，CLI 会用默认 PORT=4310 生成提醒链接，链接就指错端口。
const envLines = [
  `DATA_DIR=${targetDir}`,
  `DB_PATH=${dbFile}`,
  'HOST=127.0.0.1',
  `PORT=${port}`,
  `APP_BASE_URL=http://127.0.0.1:${port}`,
  `MAIL_MODE=${mailModeFlag}`,
  'ENABLE_SCHEDULER=false',
  'CLOUD_LLM_ENABLED=false',
  `ALLOWED_EMAILS=${childEnv.ALLOWED_EMAILS}`,
  `MAIL_FROM=${childEnv.MAIL_FROM}`
];
if (mailModeFlag === 'smtp') envLines.push(`SMTP_URL=${childEnv.SMTP_URL}`);
const acceptanceEnv = path.join(targetDir, 'acceptance.env');
fs.writeFileSync(acceptanceEnv, envLines.join('\n') + '\n', { mode: 0o600 });

const statePath = path.join(targetDir, 'state.json');
if (args.noStart) {
  fs.writeFileSync(statePath, JSON.stringify({ ...manifest, started: false }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ prepared: true, data_dir: targetDir, counts: businessCounts, started: false }, null, 2));
  process.exit(0);
}

const logFile = path.join(targetDir, 'server.log');
const out = fs.openSync(logFile, 'a', 0o600);
const child = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
  cwd: ROOT,
  env: childEnv,
  detached: true,
  stdio: ['ignore', out, out]
});
let exited = null;
child.on('exit', (code, signal) => { exited = { code, signal }; });
child.unref();
fs.closeSync(out);

const state = {
  ...manifest,
  started: true,
  pid: child.pid,
  url: `http://127.0.0.1:${port}`,
  log: logFile,
  started_at: new Date().toISOString()
};
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });

const ready = await waitReady(port);
if (!ready.ok) {
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-12).join('\n') : '(无日志)';
  fail(`服务没能在 30 秒内就绪（/api/v1/health 未返回 200）。最后响应：${JSON.stringify(ready.last)}\n--- server.log 末尾 ---\n${tail}`,
    `进程可能已退出（pid ${child.pid}）。副本保留在 ${targetDir}，可执行 node server/src/index.js 手动排查。`);
}

const page = await requestHealth(port, '/');
const pageOk = page.status === 200;

if (pageOk) {
  console.log(`\n✅ 已就绪：http://127.0.0.1:${port}`);
} else {
  console.log(`\n⚠️  服务已起来，但首页返回 ${page.status}（/api/v1/health 正常）。`);
  console.log(`   先打开 http://127.0.0.1:${port}/ 看看；日志：${logFile}`);
}

console.log(`   数据副本：${targetDir}`);
console.log(`   业务数量：用户 ${businessCounts.users} / 台账 ${businessCounts.applications} / 邮件 ${businessCounts.mail_messages} / 待确认 ${businessCounts.review_items}`);
console.log(`   发信模式：${mailModeFlag}${mailModeFlag === 'outbox' ? '（只写 outbox，不会真发）' : '（真实 SMTP，仅限 ALLOWED_EMAILS 白名单）'}`);
console.log(`   进程：pid ${child.pid}（脱离当前会话，关掉终端也不会停）`);
console.log(`   日志：${logFile}`);
console.log(`   停止：npm run local:stop`);
console.log(`   验证码：node --env-file="${acceptanceEnv}" server/scripts/latest-otp.js`);
console.log(`   CLI（提醒/同步）：node --env-file="${acceptanceEnv}" server/scripts/run-reminders.js`);
if (mailModeFlag === 'outbox') {
  console.log('\n   插件后台地址填：' + `http://127.0.0.1:${port}`);
}
process.exit(0);
