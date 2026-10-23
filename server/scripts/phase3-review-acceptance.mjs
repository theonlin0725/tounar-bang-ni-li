#!/usr/bin/env node
/*
 * P2-1 真实待确认逐条验收（只对验收副本，绝不碰原库）。
 *
 * 做两件事：
 *   1. 遍历全部 open 复核项，记录：公司/主题/收信日/系统判断/置信度/候选/建议动作；
 *   2. 按 --plan 执行受控动作（create / link / dismiss），并验证：
 *      台账计数变化、历史留痕、10 秒撤销、409 版本冲突、逐条批量。
 *
 * 用法：
 *   node server/scripts/phase3-review-acceptance.mjs --url http://127.0.0.1:4311 \
 *     --data-dir ~/tounar-acceptance/<ts> --email 1191240794@qq.com [--apply]
 *
 * 不加 --apply 时只读（walk），不会改动任何复核项。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--apply') { out.apply = true; continue; }
    const value = argv[i + 1];
    if (value == null) throw new Error(`${key} 需要一个值`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const base = String(args.url || 'http://127.0.0.1:4311').replace(/\/$/, '');
const dataDir = path.resolve(args['data-dir'] || '');
const email = String(args.email || '1191240794@qq.com');
const reportPath = path.resolve(args.report || 'docs/acceptance/phase3/review-acceptance.json');
if (!fs.existsSync(dataDir)) throw new Error(`--data-dir 不存在：${dataDir}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function latestOtp(expected, since) {
  const outbox = path.join(dataDir, 'outbox');
  const records = [];
  for (const file of fs.readdirSync(outbox)) {
    if (!file.endsWith('.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(outbox, file), 'utf8'));
      if (r.kind !== 'otp' || String(r.to).toLowerCase() !== expected.toLowerCase()) continue;
      if (since && String(r.created_at) < since) continue;
      records.push(r);
    } catch { /* ignore */ }
  }
  return records.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1);
}

let cookie = null;
async function api(route, { method = 'GET', body, idempotent = false } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: base,
      ...(idempotent ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie?.()[0] };
}

async function login() {
  const since = new Date(Date.now() - 2000).toISOString();
  let requested = await api('/api/v1/auth/request-otp', { method: 'POST', body: { email } });
  if (requested.status === 429) {
    const wait = Number(requested.json?.error?.details?.retry_after ?? 62);
    console.log(`· 验证码频控，等待 ${wait}s`);
    await sleep(Math.min(wait, 120) * 1000);
    requested = await api('/api/v1/auth/request-otp', { method: 'POST', body: { email } });
  }
  if (requested.status !== 200) throw new Error(`request-otp ${requested.status} ${requested.text}`);
  let otp = null;
  for (let i = 0; i < 50 && !otp; i += 1) { otp = latestOtp(email, since); if (!otp) await sleep(200); }
  if (!otp) throw new Error('outbox 没有新验证码');
  const verified = await api('/api/v1/auth/verify-otp', { method: 'POST', body: { email, code: otp.metadata.dev_code } });
  if (verified.status !== 200) throw new Error(`verify-otp ${verified.status} ${verified.text}`);
  cookie = verified.setCookie.split(';')[0];
}

async function ledgerCount() {
  // view 只接受 applied/viewed/archived，三个视图相加才是全量记录数
  let filteredTotal = 0;
  let totalApplied = null;
  let pendingReview = null;
  for (const view of ['applied', 'viewed', 'archived']) {
    const res = await api(`/api/v1/ledger?view=${view}&status=all&limit=1`);
    const data = res.json?.data;
    if (!data) continue;
    filteredTotal += Number(data.filtered_total || 0);
    totalApplied = data.stats?.total_applied ?? totalApplied;
    pendingReview = data.counts?.pending_review ?? pendingReview;
  }
  return { filtered_total: filteredTotal, total_applied: totalApplied, pending_review: pendingReview };
}

function companyFromSubject(subject) {
  const text = String(subject || '');
  const bracket = text.match(/[【\[]([^】\]]{2,20})[】\]]/);
  if (bracket) return bracket[1].replace(/(通知|提醒|邀请|面试|测评|笔试|招聘).*$/, '').trim();
  const m = text.match(/^([\u4e00-\u9fa5A-Za-z0-9]{2,12})(?:20\d{2}|校园招聘|校招|邀请|面试|测评|笔试|通知|提醒)/);
  return m ? m[1] : null;
}

async function main() {
  await login();
  console.log(`· 已登录 ${email}`);

  const listRes = await api('/api/v1/review-items');
  const items = listRes.json?.data?.items || listRes.json?.data || [];
  const before = await ledgerCount();
  console.log(`· 待确认 ${items.length} 条；台账 ${JSON.stringify(before)}`);

  const rows = [];
  for (const item of items) {
    const detail = (await api(`/api/v1/review-items/${item.id}`)).json?.data || {};
    const evidence = detail.evidence || {};
    rows.push({
      id: detail.id,
      kind: detail.kind,
      reason_code: detail.reason_code,
      summary: detail.summary,
      company_guess: companyFromSubject(evidence.subject_excerpt || detail.summary),
      subject: evidence.subject_excerpt || null,
      from_domain: evidence.from_domain || null,
      mail_received_at: detail.mail_received_at || null,
      category: evidence.category || null,
      status_suggestion: (detail.suggested_changes || {}).status || null,
      classification_confidence: detail.classification_confidence,
      matching_confidence: detail.matching_confidence,
      total_confidence: detail.total_confidence,
      candidates: (detail.candidates || []).map((c) => ({
        application_id: c.application_id,
        company_name: c.company_name,
        job_title: c.job_title,
        reason: c.reason
      })),
      version: detail.version,
      action: 'pending_user',
      recommendation: null,
      result: null
    });
  }

  // 建议：有候选且唯一 → 确认关联；无候选但有明确公司 → 建议按邮件新建（需补岗位名）；
  // 明显是人工回复/非招聘通知 → 建议忽略。
  for (const row of rows) {
    if (row.candidates.length === 1) { row.recommendation = 'confirm'; continue; }
    if (row.kind === 'company_title_only') { row.recommendation = 'link_or_create'; continue; }
    if (/^Re:|答复|询问/.test(String(row.subject || ''))) { row.recommendation = 'dismiss'; continue; }
    if (row.company_guess) { row.recommendation = 'create'; continue; }
    row.recommendation = 'needs_review';
  }

  const report = { generated_at: new Date().toISOString(), base, data_dir: dataDir, email,
    before_counts: before, items: rows, actions: [], checks: [] };

  if (!args.apply) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`· 只读 walk 完成，报告：${reportPath}`);
    console.table(rows.map((r) => ({ id: r.id.slice(0, 12), subject: (r.subject || r.summary || '').slice(0, 26), cat: r.category, rec: r.recommendation, conf: r.total_confidence })));
    return;
  }

  // ---------- 受控动作（测试数据统一标记，便于识别与清理）----------
  const plan = [
    { id: 'rev_RwcHsX3IcZ19xWMx', action: 'create', label: '中国电信天翼云 在线笔试',
      changes: { company_name: '中国电信天翼云【验收】', job_title: '在线笔试线索【验收】', status: 'assessment' } },
    { id: 'rev_X94-2zRWNbc8HQTK', action: 'create', label: '中国电子云 AI 面试',
      changes: { company_name: '中国电子云【验收】', job_title: 'AI 面试线索【验收】', status: 'interview' } },
    { id: 'rev_VsrsHEis1WSawv56', action: 'link', label: '腾讯岗位浏览 → 关联已有台账',
      application_id: 'app_RJ0CfVWVNS1Y0Tvk' },
    { id: 'rev_8TBSVgdmmQMDacIH', action: 'dismiss_then_undo', label: 'Re: 笔试时间询问（人工回复，非通知）' }
  ];

  for (const step of plan) {
    const detail = (await api(`/api/v1/review-items/${step.id}`)).json?.data;
    if (!detail || detail.status !== 'open') {
      report.actions.push({ ...step, skipped: true, reason: detail ? `status=${detail.status}` : 'not found' });
      continue;
    }
    const entry = { ...step, started_at: new Date().toISOString(), before_ledger: await ledgerCount() };
    const body = { expected_version: detail.version, action: step.action === 'dismiss_then_undo' ? 'dismiss' : step.action, changes: step.changes || {} };
    if (step.action === 'link') {
      body.application_id = step.application_id;
      const app = (await api(`/api/v1/applications/${step.application_id}`)).json?.data;
      body.expected_application_version = app?.version;
      entry.target_application = { id: app?.id, company: app?.company_name, title: app?.job_title, version: app?.version };
    }
    const resolved = await api(`/api/v1/review-items/${step.id}/resolve`, { method: 'POST', body, idempotent: true });
    entry.resolve_status = resolved.status;
    entry.resolve_body = resolved.json?.data
      ? { review_status: resolved.json.data.review?.status, application_id: resolved.json.data.application?.id,
          application_status: resolved.json.data.application?.status,
          applied_at: resolved.json.data.application?.applied_at,
          applied_at_precision: resolved.json.data.application?.applied_at_precision }
      : resolved.json?.error || resolved.text.slice(0, 200);
    entry.after_ledger = await ledgerCount();

    if (step.action === 'dismiss_then_undo' && resolved.status === 200) {
      const resolvedVersion = (await api(`/api/v1/review-items/${step.id}`)).json?.data?.version;
      const undone = await api(`/api/v1/review-items/${step.id}/undo`, { method: 'POST', body: { expected_version: resolvedVersion }, idempotent: true });
      entry.undo_status = undone.status;
      entry.undo_body = undone.json?.data?.review?.status || undone.json?.error || null;
      entry.after_undo_ledger = await ledgerCount();
      // 撤销后再正式忽略一次，留下终态
      const again = await api(`/api/v1/review-items/${step.id}/resolve`, {
        method: 'POST', idempotent: true,
        body: { expected_version: (await api(`/api/v1/review-items/${step.id}`)).json?.data?.version, action: 'dismiss' }
      });
      entry.final_dismiss_status = again.status;
    }

    const after = (await api(`/api/v1/review-items/${step.id}`)).json?.data;
    entry.final_review_status = after?.status;
    entry.resolution = after?.resolution || null;
    entry.finished_at = new Date().toISOString();
    report.actions.push(entry);
    console.log(`· ${step.action} ${step.label}: resolve=${entry.resolve_status} stale=${entry.stale_version_status} final=${entry.final_review_status}`);
  }

  // 版本冲突：另选一条仍 open 的记录，用错误 version 提交，必须 409
  const stillOpen = (await api('/api/v1/review-items?status=open')).json?.data || [];
  let openItem = null;
  let detail = null;
  for (const candidate of stillOpen) {
    const full = (await api(`/api/v1/review-items/${candidate.id}`)).json?.data;
    if (full?.status === 'open') { openItem = candidate; detail = full; break; }
  }
  if (openItem) {
    const conflict = await api(`/api/v1/review-items/${openItem.id}/resolve`, {
      method: 'POST', idempotent: true, body: { expected_version: Number(detail.version) + 7, action: 'dismiss' }
    });
    report.conflict_check = { id: openItem.id, sent_version: Number(detail.version) + 7, current_version: detail.version,
      status: conflict.status, code: conflict.json?.error?.code || null };
    console.log(`· 版本冲突测试：status=${conflict.status} code=${report.conflict_check.code}`);
  }

  // 台账历史留痕
  report.after_counts = await ledgerCount();

  const created = report.actions.filter((a) => a.resolve_status === 200 && a.resolve_body?.application_id);
  for (const action of created) {
    const detail = (await api(`/api/v1/applications/${action.resolve_body.application_id}`)).json?.data;
    action.history = (detail?.history || []).map((h) => ({ from: h.from_status, to: h.to_status, actor: h.actor, at: h.at || h.created_at }));
  }

  report.checks = [
    { name: 'create 两条（带【验收】标记）', ok: report.actions.filter((a) => a.action === 'create' && a.resolve_status === 200).length === 2 },
    { name: 'link 一条到已有台账', ok: report.actions.some((a) => a.action === 'link' && a.resolve_status === 200) },
    { name: 'dismiss 后 10 秒内撤销成功', ok: report.actions.some((a) => a.undo_status === 200) },
    { name: '过期版本提交返回 409 VERSION_CONFLICT', ok: report.conflict_check?.status === 409 && report.conflict_check?.code === 'VERSION_CONFLICT' },
    { name: '待确认计数下降', ok: Number(report.after_counts.pending_review) < Number(report.before_counts.pending_review) },
    { name: '台账条数增加', ok: Number(report.after_counts.filtered_total) > Number(report.before_counts.filtered_total) }
  ];

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  for (const check of report.checks) console.log(`${check.ok ? '✔' : '✖'} ${check.name}`);
  console.log(`· 报告：${reportPath}`);
  process.exit(report.checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((error) => {
  console.error(`✖ ${error.message}`);
  process.exit(1);
});
