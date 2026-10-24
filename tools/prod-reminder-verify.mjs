#!/usr/bin/env node
/*
 * 线上提醒邮件端到端验收（本机执行，读写你真实的 QQ 邮箱做取码/收信）。
 *
 * 做五件事：
 *   1. 用验证码登录线上实例（验证码从真实邮箱里取）；
 *   2. 把一条真实面试邮件复核项按【验收】标记建成 interview 记录
 *      （锚点 = 原信收到日期，所以立刻到期待提醒）；
 *   3. 用内部 tick 触发提醒批次（body 传 tick_token，走网关能穿透的通道）；
 *   4. 从邮箱取回这封提醒，打印主题、落款日期、所有链接；
 *   5. 用「无 cookie 的新访客」逐个请求链接，确认带 sharecode 的返回 200。
 *
 * 用法：
 *   PROD_BASE=https://bangnili.app.workbuddy.host \
 *   PROD_SHARE=<sharecode> \
 *   DATA_DIR="<放有真实 tounar.sqlite + master.key 的目录>" \
 *   node tools/prod-reminder-verify.mjs
 *
 * 只读原库（mail_connections 凭据），不改本机数据库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const BASE = (process.env.PROD_BASE || '').replace(/\/$/, '');
const SHARE = process.env.PROD_SHARE || '';
const DATA_DIR = process.env.DATA_DIR || '';
const EMAIL = process.env.PROD_EMAIL || '1191240794@qq.com';
const REVIEW_ID = process.env.PROD_REVIEW_ID || 'rev_go9Hvk0zY0F-lmZ7';

if (!BASE || !SHARE || !DATA_DIR) {
  console.error('需要 PROD_BASE / PROD_SHARE / DATA_DIR 三个环境变量');
  process.exit(2);
}

const dbFile = path.join(DATA_DIR, 'tounar.sqlite');
if (!fs.existsSync(dbFile)) {
  console.error(`找不到本地真实库：${dbFile}`);
  process.exit(2);
}
const masterKey = fs.readFileSync(path.join(DATA_DIR, 'master.key'), 'utf8').trim();
const tickToken = fs.readFileSync(path.join(DATA_DIR, 'internal-tick.token'), 'utf8').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (route) => `${BASE}${route}${route.includes('?') ? '&' : '?'}sharecode=${encodeURIComponent(SHARE)}`;

function decrypt(ciphertext, iv, tag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(masterKey, 'hex'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

async function imap(handler) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const conn = db.prepare("SELECT * FROM mail_connections WHERE credential_ciphertext IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get();
  db.close();
  const password = decrypt(conn.credential_ciphertext, conn.credential_iv, conn.credential_tag);
  const client = new ImapFlow({ host: 'imap.qq.com', port: 993, secure: true, auth: { user: conn.email, pass: password }, logger: false });
  await client.connect();
  await client.getMailboxLock('INBOX', { readOnly: true });
  try { return await handler(client); } finally { await client.logout().catch(() => {}); }
}

function decodeMime(text) {
  const unfolded = text.replace(/=\r?\n/g, '');
  return unfolded.replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

const jar = [];
function cookieHeader() { return jar.map((c) => `${c.name}=${c.value}`).join('; '); }
function remember(res) {
  const list = res.headers.getSetCookie?.() || [];
  for (const raw of list) {
    const [pair] = raw.split(';');
    const [name, value] = pair.split('=');
    if (!name) continue;
    const i = jar.findIndex((c) => c.name === name);
    if (i >= 0) jar[i].value = value; else jar.push({ name, value });
  }
}

async function api(route, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(q(route), {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Origin: BASE,
      Cookie: cookieHeader(),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  remember(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
}

async function login() {
  const since = new Date(Date.now() - 2000).toISOString();
  const requested = await api('/api/v1/auth/request-otp', { method: 'POST', body: { email: EMAIL } });
  if (requested.status !== 200) throw new Error(`request-otp ${requested.status} ${requested.text}`);
  const code = await imap(async (client) => {
    for (let i = 0; i < 40; i += 1) {
      const uids = await client.search({ since: new Date(Date.now() - 3600000) }, { uid: true });
      const msgs = await client.fetchAll(uids.join(','), { uid: true, envelope: true, source: true }, { uid: true });
      const hit = msgs.filter((m) => String(m.envelope?.subject || '').includes('登录验证码')).at(-1);
      if (hit) {
        const decoded = decodeMime(hit.source.toString('utf8'));
        const m = decoded.match(/\b(\d{6})\b/);
        if (m && (!since || String(hit.envelope.date) >= since)) return m[1];
      }
      await sleep(1000);
    }
    throw new Error('邮箱里没有等到验证码');
  });
  const verified = await api('/api/v1/auth/verify-otp', { method: 'POST', body: { email: EMAIL, code } });
  if (verified.status !== 200) throw new Error(`verify-otp ${verified.status} ${verified.text}`);
  console.log(`✔ 登录成功 ${EMAIL}`);
}

async function createDueRecord() {
  const detail = await api(`/api/v1/review-items/${REVIEW_ID}`);
  if (detail.status !== 200) throw new Error(`review detail ${detail.status}`);
  const item = detail.json.data;
  console.log(`· 用这条真实邮件建待回看记录：${item.evidence?.subject_excerpt || item.summary}（收到 ${item.mail_received_at}）`);
  const resolved = await api(`/api/v1/review-items/${REVIEW_ID}/resolve`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `acc-${Date.now()}` },
    body: {
      expected_version: item.version,
      action: 'create',
      changes: { company_name: '【验收】网易游戏', job_title: '雷火事业群面试【验收】', status: 'interview' }
    }
  });
  if (resolved.status !== 200) throw new Error(`resolve ${resolved.status} ${resolved.text}`);
  const app = resolved.json.data.application;
  console.log(`✔ 已建记录 ${app.id}（状态 ${app.status}，锚点按原信日期 → 立即到期）`);
  return app;
}

async function tick() {
  const res = await api('/api/v1/internal/tick', { method: 'POST', body: { tick_token: tickToken, reminders: true, force: true } });
  if (res.status !== 200) throw new Error(`tick ${res.status} ${res.text}`);
  const rows = res.json.data.scheduler.last_tick.summary.reminders || [];
  console.log('· tick 结果：', JSON.stringify(rows));
  return rows;
}

async function fetchReminder(afterMs) {
  return imap(async (client) => {
    for (let i = 0; i < 45; i += 1) {
      const uids = await client.search({ since: new Date(Date.now() - 3600000) }, { uid: true });
      const msgs = await client.fetchAll(uids.join(','), { uid: true, envelope: true, source: true }, { uid: true });
      const hit = msgs.filter((m) => {
        const subject = String(m.envelope?.subject || '');
        const time = new Date(m.envelope?.date || 0).getTime();
        return subject.includes('帮你理') && !subject.includes('验证码') && time >= afterMs;
      }).at(-1);
      if (hit) return hit;
      await sleep(1000);
    }
    return null;
  });
}

const startedAt = Date.now();
await login();
const app = await createDueRecord();
await tick();
console.log('· 等待提醒邮件…');
const mail = await fetchReminder(startedAt - 5000);
if (!mail) { console.error('✖ 没等到提醒邮件'); process.exit(1); }
const text = decodeMime(mail.source.toString('utf8'));
console.log(`\n✔ 收到提醒：${mail.envelope?.subject}`);
const links = [...new Set([...text.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]))].filter((u) => !u.includes('example.com'));
console.log('链接：');
for (const link of links) console.log('  -', link);
const withShare = links.filter((l) => l.includes('sharecode=')).length;
console.log(`带 sharecode 的链接：${withShare}/${links.length}`);

console.log('\n新访客（无 cookie）逐个访问：');
let bad = 0;
for (const link of links.slice(0, 4)) {
  const res = await fetch(link, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' }, redirect: 'manual' });
  console.log(`  ${res.status}  ${link.slice(0, 110)}`);
  if (res.status >= 400) bad += 1;
}
console.log(`\n${bad ? '✖' : '✔'} 记录 ${app.id}；带码链接 ${withShare}/${links.length}；新访客失败 ${bad} 个`);
process.exit(bad || withShare !== links.length ? 1 : 0);
