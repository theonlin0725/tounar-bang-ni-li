#!/usr/bin/env node
/*
 * Mail end-to-end generalization benchmark.
 *
 * Local SMTP + local IMAP -> production mail sync -> real LLM/rules -> SQLite/API -> UI.
 * Synthetic corpus only; no real mailbox or personal mail is used.
 *
 * Usage:
 *   node --env-file-if-exists .env tools/run-mail-e2e-benchmark.mjs
 *   MAIL_BENCH_ENV_FILE="/path/to/.env" node tools/run-mail-e2e-benchmark.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import nodemailer from 'nodemailer';
import { chromium } from 'playwright';
import { startMailSandbox } from './lib/mail-sandbox.mjs';
import { freePort } from '../server/test/helpers.js';
import { resolveChromiumExecutable } from '../tests/e2e/browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CORPUS_PATH = path.join(ROOT, 'tests/fixtures/mail-generalization-corpus.json');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = path.join(ROOT, '.tmp/mail-e2e-benchmark', STAMP);
const REPORT_JSON = path.join(ROOT, '.tmp/mail-e2e-benchmark-report.json');
const REPORT_MD = path.join(ROOT, '.tmp/mail-e2e-benchmark-report.md');
const BENCH_EMAIL = 'bench@qq.com';
const BENCH_PASSWORD = 'bench-local-imap-password';
const BENCH_FROM = 'Tounar 帮你理 <no-reply@tounar.local>';
const STATUS_RANK = { pending: 0, applied: 1, assessment: 2, interview: 3, offer: 4, rejected: 4, closed: 4 };

if (process.env.MAIL_BENCH_ENV_FILE) {
  try { process.loadEnvFile(process.env.MAIL_BENCH_ENV_FILE); }
  catch (error) { console.error(`benchmark env file could not be loaded: ${error.message}`); process.exit(1); }
}
fs.mkdirSync(RUN_DIR, { recursive: true });
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (value) => String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const legalLess = (value) => norm(value).replace(/(?:股份有限公司|有限公司|集团|corporation|corp|company|co|inc|ltd)$/gu, '');
function entityMatches(actual, aliases = []) {
  if (!actual) return false;
  const a = legalLess(actual);
  return aliases.some((alias) => {
    const b = legalLess(alias);
    return b && (a === b || (b.length >= 3 && (a.includes(b) || b.includes(a))));
  });
}
function jobMatches(actual, aliases = []) {
  if (!actual) return false;
  const a = norm(actual);
  return aliases.some((alias) => {
    const b = norm(alias);
    return b && (a === b || (b.length >= 3 && (a.includes(b) || b.includes(a))));
  });
}
function findApp(apps, target, sample) {
  if (!sample || sample.expected.action === 'ignored' || sample.expected.action === 'pending') return null;
  const expected = sample.expected;
  const aliases = expected.company_aliases || [expected.company_name];
  const jobs = target?.jobs || (expected.job_title ? (expected.job_aliases || [expected.job_title]) : []);
  const candidates = apps.filter((app) => entityMatches(app.company_name, aliases)
    && (!jobs.length || jobMatches(app.job_title, jobs)));
  if (candidates.length) return candidates[0];
  if (!jobs.length) {
    // A company-only placeholder may be stored with a generated placeholder title.
    const companyOnly = apps.filter((app) => entityMatches(app.company_name, aliases));
    return companyOnly.length === 1 ? companyOnly[0] : null;
  }
  return null;
}
function reviewMatchesCompany(review, sample) {
  const s = review.suggested_changes || {};
  return entityMatches(s.company_name, sample.expected.company_aliases || [sample.expected.company_name]);
}
function samplePositive(sample) {
  return ['created', 'advanced', 'no_change', 'pending'].includes(sample.expected.action);
}
function sampleSuccess(sample, app, reviews) {
  const expected = sample.expected;
  if (expected.action === 'ignored') {
    return !reviews.some((review) => entityMatches((review.suggested_changes || {}).company_name, expected.company_aliases || [expected.company_name]))
      && !app;
  }
  if (expected.action === 'pending') return !app && reviews.some((review) => reviewMatchesCompany(review, sample));
  if (!app) return false;
  if (expected.measure_status && app.status !== expected.status) return false;
  return true;
}
function failureStage(sample, app, reviews, mailPresent) {
  if (!samplePositive(sample) && sample.expected.action !== 'ignored') return 'unknown';
  if (sample.expected.action === 'ignored') return 'specificity';
  if (!mailPresent) return 'imap_decode_or_header_filter';
  if (!app && !reviews.some((review) => reviewMatchesCompany(review, sample))) return 'header_filter';
  if (sample.expected.action === 'pending' && app) return 'matching';
  if (!app) return 'review_dedup_or_matching';
  if (!entityMatches(app.company_name, sample.expected.company_aliases || [sample.expected.company_name])) return 'entity_extract_company';
  if (sample.expected.job_title && !jobMatches(app.job_title, sample.expected.job_aliases || [sample.expected.job_title])) return 'entity_extract_job';
  if (sample.expected.measure_status && app.status !== sample.expected.status) return 'status_judge';
  return 'matching';
}
function rate(hit, total) { return total ? hit / total : 1; }

async function startApp({ imapPort, runDir }) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = path.join(runDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'server/src/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, 'tounar.sqlite'),
      HOST: '127.0.0.1',
      PORT: String(port),
      APP_BASE_URL: base,
      APP_ENV: 'test',
      MAIL_MODE: 'outbox',
      MAIL_FROM: BENCH_FROM,
      ENABLE_SCHEDULER: 'true',
      ENABLE_MAIL_SCHEDULER: 'false',
      ENABLE_REMINDER_SCHEDULER: 'false',
      REMINDER_TICK_SECONDS: '15',
      AUTO_INTAKE_RETRY_MINUTES: '1',
      CLOUD_LLM_ENABLED: 'false',
      CLOUD_PERSISTENCE_ENABLED: 'false',
      AUTO_INTAKE_ENABLED: 'true',
      AI_LLM_TIMEOUT_MS: '15000',
      JEV_TIMEOUT_MS: '15000',
      MAIL_INTAKE_JUDGE: process.env.MAIL_BENCH_JUDGE || 'flash',
      IMAP_HOST: '127.0.0.1',
      IMAP_PORT: String(imapPort),
      IMAP_CONNECT_TIMEOUT_MS: '5000',
      ALLOWED_EMAILS: BENCH_EMAIL,
      ADMIN_EMAILS: BENCH_EMAIL,
      OTP_RESEND_SECONDS: '0',
      OTP_MAX_PER_HOUR: '200',
      ENABLE_SELFTEST_LOGIN: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (stdout.includes('"event":"listening"')) break;
    if (child.exitCode != null) throw new Error(`app exited: ${stderr || stdout}`);
    await sleep(60);
  }
  if (!stdout.includes('"event":"listening"')) throw new Error(`app did not start: ${stderr || stdout}`);
  return {
    base, port, dir: dataDir, child,
    get log() { return `${stdout}\n${stderr}`; },
    async request(route, { method = 'GET', body, cookie } = {}) {
      const res = await fetch(base + route, {
        method,
        headers: {
          Origin: base,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual'
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-json */ }
      const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      const cookieHeader = setCookie[0]?.split(';')[0] || null;
      return { status: res.status, json, text, cookie: cookieHeader };
    },
    async readOtp() {
      const dir = path.join(dataDir, 'outbox');
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        if (fs.existsSync(dir)) {
          for (const file of fs.readdirSync(dir).sort().reverse()) {
            if (!file.endsWith('.json')) continue;
            try {
              const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
              if (record.kind === 'otp' && record.metadata?.dev_code) return record.metadata.dev_code;
            } catch { /* ignore partial writes */ }
          }
        }
        await sleep(80);
      }
      throw new Error('benchmark OTP not found in outbox');
    },
    async stop() {
      if (child.exitCode == null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
    }
  };
}

async function waitConnected(app, cookie, connectionId, { after = 0, timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await app.request(`/api/v1/mail-connections/${connectionId}`, { cookie });
    last = res.json?.data || null;
    const stats = last?.sync_stats || {};
    if (last?.status === 'connected' && stats.phase === 'done'
      && (!after || (stats.started_at && Date.parse(stats.started_at) >= after - 1000))) return { connection: last, stats, error: null };
    if (['degraded', 'reauth_required', 'error', 'failed'].includes(last?.status)) {
      return { connection: last, stats, error: last.last_error_code || last.status };
    }
    await sleep(250);
  }
  return { connection: last, stats: last?.sync_stats || {}, error: 'timeout' };
}

function pendingIntakeRetries(runDir) {
  try {
    const db = new DatabaseSync(path.join(runDir, 'data', 'tounar.sqlite'), { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) AS n FROM ai_ingest_runs WHERE status='retry'").get();
    db.close();
    return Number(row?.n || 0);
  } catch {
    return null;
  }
}
async function waitIntakeRetries(runDir, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = pendingIntakeRetries(runDir);
    if (last === 0) return { ok: true, pending: 0 };
    await sleep(5000);
  }
  return { ok: last === 0, pending: last };
}

function buildMarkdown(report) {
  const m = report.metrics;
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const rows = [
    ['有效进展召回率', m.recall, '≥ 92%', m.recall >= 0.92, '未见集 ≥ 90%'],
    ['负样本拦截率', m.specificity, '100%', m.specificity === 1, '零误入账'],
    ['公司名识别准确率', m.company, '≥ 92%', m.company >= 0.92, '未见集 ≥ 88%'],
    ['岗位名识别准确率', m.job, '≥ 85%', m.job >= 0.85, '未见集 ≥ 80%'],
    ['状态推进准确率', m.status, '≥ 92%', m.status >= 0.92, '最终快照'],
    ['未见集召回率', m.unseenRecall, '≥ 90%', m.unseenRecall >= 0.90, 'unseen'],
    ['未见集公司准确率', m.unseenCompany, '≥ 88%', m.unseenCompany >= 0.88, 'unseen'],
    ['未见集岗位准确率', m.unseenJob, '≥ 80%', m.unseenJob >= 0.80, 'unseen']
  ];
  const risk = [
    ['状态回退', m.rollback, 0, m.rollback === 0],
    ['面试改期误判拒信', m.rescheduleRejected, 0, m.rescheduleRejected === 0],
    ['自动入账仍在 open 待确认', m.duplicateOpenReview, 0, m.duplicateOpenReview === 0],
    ['MAIL_STAGE_CONFLICT 中断', m.stageConflict, 0, m.stageConflict === 0]
  ];
  return `# 招聘邮件全链路泛化验收报告

生成时间：${report.generated_at}  
运行目录：\`${report.run_dir}\`  
模型可用：${report.model_available ? '是' : '否'}  \n判断器：${report.judge || 'flash'}  
样本：${report.samples.total} 封（已知 ${report.samples.known} / 未见 ${report.samples.unseen}）  
同步轮次：${report.rounds.length}

## 指标

| 指标 | 结果 | 门槛 | 是否通过 | 备注 |
|---|---:|---:|---|---|
${rows.map(([name, value, threshold, ok, note]) => `| ${name} | ${pct(value)} | ${threshold} | ${ok ? '✅' : '❌'} | ${note} |`).join('\n')}

## 高危零容忍

| 检查 | 实际 | 要求 | 是否通过 |
|---|---:|---:|---|
${risk.map(([name, value, limit, ok]) => `| ${name} | ${value} | ${limit} | ${ok ? '✅' : '❌'} |`).join('\n')}

## 失败样本

${report.failures.length ? report.failures.map((f) => `- \`${f.id}\`（${f.group}/${f.split}）：${f.stage_failed}；期望 ${JSON.stringify(f.expected)}；实际 ${JSON.stringify(f.actual)}${f.reason_code ? `；reason=${f.reason_code}` : ''}`).join('\n') : '- 无'}

## 轮次同步

${report.rounds.map((r) => `- 第 ${r.round} 轮：发送 ${r.sent} 封，扫描 ${r.stats?.scanned ?? '—'} / ${r.stats?.total ?? '—'}，applied=${r.stats?.applied ?? '—'}，pending=${r.stats?.pending ?? '—'}，errors=${r.stats?.errors ?? '—'}，AI重试=${r.intake_retries?.ok ? '已清零' : (r.intake_retries?.pending ?? '—')}`).join('\n')}

## 前端抽检

${report.frontend.ok ? '通过' : '未通过'}：${report.frontend.notes}

截图：${report.frontend.screenshots.map((x) => `\`${x}\``).join('、') || '无'}

## 诚实边界

- 本脚本使用本地 SMTP/IMAP 沙箱，走 production 同步、解析、模型、台账和前端接口；不代表真实公网邮箱服务可用性。
- 未使用真实个人邮件；语料为合成脱敏数据。
- 报告中的模型输出与指标为本次运行快照，不构成对真实用户邮箱的通用准确率承诺。
`;
}

async function main() {
  const startedAt = Date.now();
  const corpus = readJson(CORPUS_PATH);
  const samples = corpus.samples;
  const sandbox = await startMailSandbox();
  let app;
  const result = {
    generated_at: new Date().toISOString(),
    run_dir: RUN_DIR,
    corpus: CORPUS_PATH,
    model_available: Boolean(process.env.AI_API_URL && process.env.AI_API_KEY),
    judge: process.env.MAIL_BENCH_JUDGE || 'flash',
    samples: { total: samples.length, known: samples.filter((s) => s.split === 'known').length, unseen: samples.filter((s) => s.split === 'unseen').length },
    rounds: [], metrics: {}, failures: [], frontend: { ok: false, notes: '', screenshots: [] }
  };
  try {
    app = await startApp({ imapPort: sandbox.imapPort, runDir: RUN_DIR });
    const login = await app.request('/api/v1/auth/request-otp', { method: 'POST', body: { email: BENCH_EMAIL } });
    if (login.status !== 200) throw new Error(`request OTP failed: ${login.status} ${login.text}`);
    const code = await app.readOtp();
    const verified = await app.request('/api/v1/auth/verify-otp', { method: 'POST', body: { email: BENCH_EMAIL, code } });
    if (verified.status !== 200 || !verified.cookie) throw new Error(`verify OTP failed: ${verified.status} ${verified.text}`);
    const cookie = verified.cookie;
    const created = await app.request('/api/v1/mail-connections', {
      method: 'POST', cookie,
      body: {
        email: BENCH_EMAIL, auth_code: BENCH_PASSWORD, mode: 'recruitment_body',
        consent_version: 'QQ_MAIL_READ_CONSENT_V1', scan_since: '2026-10-01T00:00:00.000Z'
      }
    });
    if (created.status !== 202) throw new Error(`create mail connection failed: ${created.status} ${created.text}`);
    const connectionId = created.json?.data?.id;
    const initial = await waitConnected(app, cookie, connectionId, { timeoutMs: 30000 });
    if (initial.error) throw new Error(`initial mailbox sync failed: ${initial.error}`);

    const transporter = nodemailer.createTransport({
      host: '127.0.0.1', port: sandbox.smtpPort, secure: false,
      tls: { rejectUnauthorized: false }, name: 'localhost'
    });
    const rounds = [...new Set(samples.map((sample) => Number(sample.round)))].sort((a, b) => a - b);
    for (const round of rounds) {
      const list = samples.filter((sample) => Number(sample.round) === round).sort((a, b) => a.send_at.localeCompare(b.send_at));
      for (const sample of list) {
        const message = {
          from: `${sample.from_name} <${sample.from_address}>`,
          to: BENCH_EMAIL,
          subject: sample.subject,
          date: new Date(sample.send_at),
          messageId: `<bench-${sample.id}@local>`
        };
        if (sample.text_body) message.text = sample.text_body;
        if (sample.html_body) message.html = sample.html_body;
        await transporter.sendMail(message);
      }
      const before = Date.now();
      const triggered = await app.request(`/api/v1/mail-connections/${connectionId}/sync`, { method: 'POST', cookie, body: {} });
      if (triggered.status !== 202) throw new Error(`round ${round} sync trigger failed: ${triggered.status} ${triggered.text}`);
      const synced = await waitConnected(app, cookie, connectionId, { after: before, timeoutMs: 360000 });
      result.rounds.push({ round, sent: list.length, stats: synced.stats, error: synced.error });
      if (synced.error) throw new Error(`round ${round} sync failed: ${synced.error}`);
      const retries = await waitIntakeRetries(RUN_DIR);
      result.rounds.at(-1).intake_retries = retries;
      writeJson(path.join(RUN_DIR, `round-${round}.json`), { round, sent: list.map((s) => s.id), stats: synced.stats, intake_retries: retries, connection: synced.connection });
      if (!retries.ok) throw new Error(`round ${round} left ${retries.pending} AI retries`);
    }
    await sleep(400);
    const ledger = await app.request('/api/v1/ledger?view=applied&status=all&limit=100', { cookie });
    const reviews = await app.request('/api/v1/review-items?status=open&limit=50', { cookie });
    if (ledger.status !== 200 || reviews.status !== 200) throw new Error('final API snapshot failed');
    const apps = ledger.json.data.items || [];
    const openReviews = Array.isArray(reviews.json.data) ? reviews.json.data : [];
    writeJson(path.join(RUN_DIR, 'final-api.json'), { ledger: ledger.json.data, reviews: reviews.json });

    // Build target identities once, then reuse for every sample (multi-round emails must map to one row).
    const targets = new Map();
    for (const sample of samples) {
      if (!sample.target) continue;
      const target = targets.get(sample.target) || { id: sample.target, company: sample.expected.company_name, aliases: sample.expected.company_aliases || [sample.expected.company_name], jobs: [], auto: false };
      if (sample.expected.action !== 'pending') target.auto = true;
      if (sample.expected.job_title && !target.jobs.includes(sample.expected.job_title)) target.jobs.push(sample.expected.job_title);
      if (sample.expected.job_aliases) for (const job of sample.expected.job_aliases) if (!target.jobs.includes(job)) target.jobs.push(job);
      targets.set(sample.target, target);
    }
    const targetApps = new Map();
    for (const [key, target] of targets) {
      if (!target.auto) continue;
      const candidates = apps.filter((item) => entityMatches(item.company_name, target.aliases)
        && (!target.jobs.length || jobMatches(item.job_title, target.jobs)));
      const fallback = target.jobs.length ? [] : apps.filter((item) => entityMatches(item.company_name, target.aliases));
      const found = candidates[0] || (fallback.length === 1 ? fallback[0] : null);
      if (found) targetApps.set(key, found);
    }
    const messages = sandbox.messages;
    const sampleResults = [];
    for (const sample of samples) {
      const target = sample.target ? targets.get(sample.target) : null;
      const appRow = target ? targetApps.get(sample.target) : findApp(apps, null, sample);
      const sampleReviews = openReviews.filter((review) => reviewMatchesCompany(review, sample));
      const mailPresent = messages.some((message) => message.subject === sample.subject);
      const success = sampleSuccess(sample, appRow, sampleReviews);
      sampleResults.push({
        id: sample.id, group: sample.group, split: sample.split, round: sample.round,
        expected: sample.expected, success,
        actual: appRow ? {
          id: appRow.id, company_name: appRow.company_name, job_title: appRow.job_title,
          status: appRow.status, location: appRow.location, recruitment_batch: appRow.recruitment_batch
        } : (sampleReviews.length ? { open_review: sampleReviews[0].reason_code } : null),
        mail_present: mailPresent
      });
    }

    // Page-level check uses the real UI and the same session as the API.
    try {
      const browser = await chromium.launch({ headless: true, executablePath: (await resolveChromiumExecutable()).path });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const token = cookie.split('=').slice(1).join('=');
      await context.addCookies([{ name: 'tounar_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      await page.goto(app.base, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-test=nav-ledger]', { timeout: 15000 });
      await page.waitForSelector('[data-test=ledger-table]', { timeout: 15000 });
      const headers = await page.locator('[data-test=ledger-table] th').allTextContents();
      const noTabs = await page.locator('#tn-tabs').count() === 0;
      const rows = await page.locator('[data-test=ledger-row]').count();
      await page.screenshot({ path: path.join(RUN_DIR, 'ledger.png'), fullPage: true });
      await page.goto(`${app.base}/?panel=reviews`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-test=reviews-view]', { timeout: 15000 });
      const reviewCards = await page.locator('[data-test=review-card]').count();
      await page.screenshot({ path: path.join(RUN_DIR, 'reviews.png'), fullPage: true });
      result.frontend = {
        ok: headers.length === 5 && headers[0] === '公司' && headers[1] === '岗位' && headers[2] === '状态'
          && headers[3] === '已投天数' && headers[4] === '更新时间' && noTabs && reviewCards === openReviews.length,
        notes: `headers=${headers.join('|')} noTabs=${noTabs} rows=${rows} reviewCards=${reviewCards} apiReviews=${openReviews.length}`,
        screenshots: [path.join(RUN_DIR, 'ledger.png'), path.join(RUN_DIR, 'reviews.png')]
      };
      await browser.close();
    } catch (error) {
      result.frontend = { ok: false, notes: String(error?.message || error), screenshots: [] };
    }

    // Stop the app before reading the SQLite file, then collect the failure attribution data.
    const appLog = app.log;
    await app.stop();
    app = null;
    const db = new DatabaseSync(path.join(RUN_DIR, 'data', 'tounar.sqlite'), { readOnly: true });
    const dbApps = db.prepare('SELECT * FROM applications WHERE archived_at IS NULL ORDER BY updated_at DESC').all();
    const history = db.prepare("SELECT * FROM application_history WHERE source_method='mail'").all();
    const dbMessages = db.prepare('SELECT * FROM mail_messages').all();
    const events = db.prepare('SELECT * FROM events').all();
    const runs = db.prepare('SELECT * FROM ai_ingest_runs').all();
    const eventById = new Map(events.map((row) => [row.id, row]));
    const runByEvent = new Map(runs.map((row) => [row.event_id, row]));
    const reviewEventSubject = (reviewId) => {
      const review = openReviews.find((row) => row.id === reviewId);
      const event = review?.source_event_id ? eventById.get(review.source_event_id) : null;
      if (!event) return '';
      try { return JSON.parse(event.payload_json || '{}').subject_excerpt || ''; } catch { return ''; }
    };

    // Recompute actual app references from DB for samples that lacked API fields.
    for (const row of sampleResults) {
      const appRow = row.actual?.id ? dbApps.find((item) => item.id === row.actual.id) : null;
      if (!appRow) continue;
      row.actual = {
        id: appRow.id, company_name: appRow.company_name, job_title: appRow.job_title,
        status: appRow.status, location: appRow.location, recruitment_batch: appRow.recruitment_batch
      };
      const sample = samples.find((item) => item.id === row.id);
      if (sample?.expected.measure_status && appRow.status !== sample.expected.status) {
        row.success = false;
      }
    }
    // Re-evaluate failures with DB mail/event information and include model reason codes.
    for (const row of sampleResults) {
      if (row.success) continue;
      const sample = samples.find((item) => item.id === row.id);
      const event = events.find((item) => String(item.payload_json || '').includes(`"subject_excerpt":"${sample.subject}"`));
      const run = event ? runByEvent.get(event.id) : null;
      let extraction = null;
      try { extraction = run?.extraction_json ? JSON.parse(run.extraction_json) : null; } catch { extraction = null; }
      result.failures.push({
        id: row.id, group: row.group, split: row.split,
        stage_failed: failureStage(sample, row.actual?.id ? dbApps.find((a) => a.id === row.actual.id) : null, openReviews, dbMessages.some((m) => m.subject_excerpt === sample.subject)),
        expected: row.expected, actual: row.actual,
        reason_code: run?.reason_code || null,
        uncertainties: extraction?.uncertainties || []
      });
    }

    const positive = sampleResults.filter((row) => samplePositive(samples.find((s) => s.id === row.id)) && samples.find((s) => s.id === row.id).expected.score_recall !== false);
    const negative = sampleResults.filter((row) => samples.find((s) => s.id === row.id).expected.action === 'ignored');
    const appResult = (row) => row.actual?.id ? dbApps.find((a) => a.id === row.actual.id) : null;
    const companyEligible = sampleResults.filter((row) => appResult(row) && samples.find((s) => s.id === row.id).expected.company_name);
    const companyHits = companyEligible.filter((row) => {
      const sample = samples.find((s) => s.id === row.id);
      return entityMatches(appResult(row).company_name, sample.expected.company_aliases || [sample.expected.company_name]);
    });
    const jobEligible = sampleResults.filter((row) => appResult(row) && samples.find((s) => s.id === row.id).expected.job_title);
    const jobHits = jobEligible.filter((row) => {
      const sample = samples.find((s) => s.id === row.id);
      return jobMatches(appResult(row).job_title, sample.expected.job_aliases || [sample.expected.job_title]);
    });
    const statusEligible = sampleResults.filter((row) => appResult(row) && samples.find((s) => s.id === row.id).expected.measure_status);
    const statusHits = statusEligible.filter((row) => appResult(row).status === samples.find((s) => s.id === row.id).expected.status);
    const unseen = (rows) => rows.filter((row) => samples.find((s) => s.id === row.id).split === 'unseen');
    const rollback = history.filter((row) => STATUS_RANK[row.from_status] > STATUS_RANK[row.to_status]).length;
    const stageConflict = (appLog = '') => (appLog.match(/MAIL_STAGE_CONFLICT/g) || []).length;
    // The app is already stopped; child log is retained by the benchmark process.
    const duplicateOpenReview = openReviews.filter((review) => {
      const suggested = review.suggested_changes || {};
      const sourceSubject = reviewEventSubject(review.id);
      if (samples.some((s) => s.expected.action === 'pending' && sourceSubject === s.subject)) return false;
      return dbApps.some((appRow) => appRow.has_applied
        && entityMatches(appRow.company_name, [suggested.company_name])
        && (!suggested.job_title || jobMatches(appRow.job_title, [suggested.job_title])));
    }).length;
    const rescheduleRejected = sampleResults.filter((row) => {
      const sample = samples.find((s) => s.id === row.id);
      if (!/改期/.test(sample.subject)) return false;
      const event = events.find((item) => String(item.payload_json || '').includes(`"subject_excerpt":"${sample.subject}"`));
      if (!event) return false;
      try { return JSON.parse(event.payload_json || '{}').mapped_status === 'rejected'; } catch { return false; }
    }).length;

    result.metrics = {
      recall: rate(positive.filter((row) => row.success).length, positive.length),
      specificity: rate(negative.filter((row) => row.success).length, negative.length),
      company: rate(companyHits.length, companyEligible.length),
      job: rate(jobHits.length, jobEligible.length),
      status: rate(statusHits.length, statusEligible.length),
      unseenRecall: rate(unseen(positive).filter((row) => row.success).length, unseen(positive).length),
      unseenCompany: rate(unseen(companyEligible).filter((row) => companyHits.includes(row)).length, unseen(companyEligible).length),
      unseenJob: rate(unseen(jobEligible).filter((row) => jobHits.includes(row)).length, unseen(jobEligible).length),
      rollback,
      rescheduleRejected,
      duplicateOpenReview,
      stageConflict: stageConflict(appLog)
    };
    result.metrics.company = rate(companyHits.length, companyEligible.length);
    result.metrics.job = rate(jobHits.length, jobEligible.length);
    result.metrics.status = rate(statusHits.length, statusEligible.length);
    result.samples.results = sampleResults;
    result.samples.db = { apps: dbApps.map((a) => ({ id: a.id, company_name: a.company_name, job_title: a.job_title, status: a.status, has_applied: a.has_applied })), reviews: openReviews.length };
    db.close();
    const thresholdsPass = result.metrics.recall >= 0.92 && result.metrics.specificity === 1
      && result.metrics.company >= 0.92 && result.metrics.job >= 0.85 && result.metrics.status >= 0.92
      && result.metrics.unseenRecall >= 0.90 && result.metrics.unseenCompany >= 0.88
      && result.metrics.unseenJob >= 0.80
      && result.metrics.rollback === 0 && result.metrics.rescheduleRejected === 0
      && result.metrics.duplicateOpenReview === 0 && result.metrics.stageConflict === 0
      && result.frontend.ok;
    result.pass = thresholdsPass;
    writeJson(path.join(RUN_DIR, 'report.json'), result);
    writeJson(REPORT_JSON, result);
    fs.writeFileSync(REPORT_MD, buildMarkdown(result));
    console.log(JSON.stringify({
      pass: result.pass, report: REPORT_JSON, markdown: REPORT_MD,
      metrics: result.metrics, failures: result.failures.length,
      frontend: result.frontend.ok, elapsed_ms: Date.now() - startedAt
    }, null, 2));
    if (!result.pass) process.exitCode = 1;
  } catch (error) {
    if (app) {
      try { fs.writeFileSync(path.join(RUN_DIR, 'app.log'), app.log, { mode: 0o600 }); } catch { /* ignore */ }
      try { writeJson(path.join(RUN_DIR, 'failure.json'), { error: String(error?.stack || error) }); } catch { /* ignore */ }
    }
    throw error;
  } finally {
    if (app) await app.stop().catch(() => {});
    await sandbox.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
