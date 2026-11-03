#!/usr/bin/env node
/* 处理现有待确认：无效自身页面/空信息自动忽略；有效邮件线索走 LLM+Jev；不发送提醒。
 * 默认 dry-run；--apply 才改库。运行前必须自行备份。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.DATA_DIR) process.env.DATA_DIR = path.join(ROOT, 'data', 'mail-selftest');
const apply = process.argv.includes('--apply');
const db = await import('../server/src/db.js');
const util = await import('../server/src/util.js');
const reviews = await import('../server/src/domain/reviews.js');
const applications = await import('../server/src/domain/applications.js');
const { processIntakeEvent } = await import('../server/src/modules/recruitment-intake/workflow.js');

function loadEvent(row) {
  if (!row.source_event_id) return null;
  const e = db.one('SELECT * FROM events WHERE id=? AND owner_id=?', [row.source_event_id, row.owner_id]);
  if (!e) return null;
  e.payload = util.safeJsonParse(e.payload_json, {}) || {};
  return e;
}
function parse(s) { return util.safeJsonParse(s, {}) || {}; }
function validText(v, min = 2) {
  const text = String(v || '').replace(/\s+/g, ' ').trim();
  if (text.length < min) return false;
  if (/系统判断|待补充|还没有投递记录|招聘邮件更新候选|加分项或注意事项|基本信息|点击申请|立即申请|登录|首页|加载中|暂无|编辑/i.test(text)) return false;
  if (/^2027\s*届\s*[·|｜]\s*(全国|广东|上海|多省|多省区)/i.test(text)) return false;
  return true;
}
function localSelf(value) {
  try {
    const u = new URL(String(value || ''));
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
      && (u.pathname === '/' || u.pathname === '/mail-selftest.html' || u.pathname.startsWith('/api/') || u.pathname.startsWith('/assets/') || u.searchParams.has('panel'));
  } catch { return false; }
}
function classification(row, event) {
  const p = event?.payload || {};
  const ev = parse(row.evidence_json);
  const isMail = Boolean(row.source_mail_id) || event?.source_method === 'mail' || String(event?.event_type || '').startsWith('mail_');
  const self = localSelf(p.job_url) || localSelf(p.status_url) || localSelf(p.page_url)
    || /127\.0\.0\.1|localhost|帮你理|系统判断|还没有投递记录/.test(`${p.job_title || ''} ${p.company_name || ''} ${ev.page?.job_title || ''}`);
  const title = p.job_title || ev.page?.job_title || '';
  const company = p.company_name || ev.page?.company_name || '';
  const jd = p.jd_text || p.jd_summary || ev.page?.jd_excerpt || '';
  const status = p.mapped_status || p.status_text || '';
  const meaningful = validText(title) || validText(company) || validText(jd, 4) || validText(status);
  const form = event?.event_type === 'form_started' || row.reason_code === 'FORM_START_UNMATCHED';
  const noInfo = !meaningful && !isMail;
  const invalid = self || noInfo || (form && !isMail);
  return { isMail, self, noInfo, form, invalid, title, company, jd, status, p, event };
}
function openReviewCount() { return db.one("SELECT COUNT(*) n FROM review_items WHERE status='open'")?.n || 0; }

const before = openReviewCount();
const rows = db.all("SELECT * FROM review_items WHERE status='open' ORDER BY created_at");
const result = { mode: apply ? 'apply' : 'dry-run', before_open: before, total_scanned: rows.length, ignored_invalid: 0, auto_created: 0, auto_updated: 0, no_change: 0, auto_ignored: 0, still_open: 0, failures: 0, archived_apps: 0, items: [] };
console.log(JSON.stringify({ phase: 'start', ...result }, null, 2));

for (const row of rows) {
  const event = loadEvent(row);
  const c = classification(row, event);
  const item = { id: row.id, reason: row.reason_code, source: c.isMail ? 'mail' : 'plugin', self: c.self, invalid: c.invalid, decision: null, detail: null };
  try {
    if (c.invalid) {
      if (apply) {
        reviews.resolveReview({ ownerId: row.owner_id, reviewId: row.id, expectedVersion: row.version, action: 'dismiss', reason: c.self ? '自动过滤：来自帮你理自身页面' : '自动过滤：无有效岗位信息或招聘进展证据' });
      }
      result.ignored_invalid += 1;
      item.decision = 'ignored_invalid';
      item.detail = c.self ? 'self_page' : (c.form ? 'form_not_progress' : 'no_valid_job_info');
    } else if (!c.isMail) {
      result.still_open += 1;
      item.decision = 'kept';
      item.detail = 'non_mail_requires_manual_review';
    } else {
      if (!event) throw new Error('source event missing');
      if (!apply) {
        item.decision = 'would_process';
        result.still_open += 1;
      } else {
        const r = await processIntakeEvent(event, {
          subject: event.payload.subject_excerpt || '', bodyText: event.payload.ai_body_excerpt || event.payload.body_excerpt || '',
          fromDomain: event.payload.from_domain || '', statusText: event.payload.status_text || '', receivedAt: event.payload.source_received_at || event.occurred_at
        });
        if (r.state === 'retry') {
          result.failures += 1; item.decision = 'retry'; item.detail = r.error_code || 'retry';
        } else if (r.state === 'pending') {
          result.still_open += 1; item.decision = 'kept_ambiguous'; item.detail = r.review?.reason_code || 'review';
        } else {
          const decision = r.state === 'ignored' ? 'ignored' : (r.change === 'created' ? 'created' : r.change === 'updated' ? 'updated' : 'no_change');
          const resolution = {
            resolution: 'auto_intake', decision, application_id: r.application?.id || null,
            reason: r.state === 'ignored' ? (r.reason || 'auto_ignored') : 'LLM+Jev 自动整理',
            before_status: null, after_status: r.application?.status || null, at: util.nowIso()
          };
          const status = r.state === 'ignored' ? 'dismissed' : 'resolved';
          db.run("UPDATE review_items SET status=?, resolution_json=?, resolved_at=?, version=version+1 WHERE id=? AND owner_id=? AND status='open'",
            [status, JSON.stringify(resolution), util.nowIso(), row.id, row.owner_id]);
          db.run(`INSERT INTO audit_log (id,owner_id,actor,action,target_type,target_id,meta_json,created_at) VALUES (?,?,'system','review.auto_remediate','review',?,?,?)`,
            [util.newId('aud'), row.owner_id, row.id, JSON.stringify(resolution), util.nowIso()]);
          if (decision === 'created') result.auto_created += 1;
          else if (decision === 'updated') result.auto_updated += 1;
          else if (decision === 'ignored') result.auto_ignored += 1;
          else result.no_change += 1;
          item.decision = decision;
          item.detail = r.application?.id || r.reason || null;
        }
      }
    }
  } catch (err) {
    result.failures += 1;
    item.decision = 'failed';
    item.detail = String(err?.code || err?.message || err).slice(0, 300);
  }
  result.items.push(item);
  console.log(JSON.stringify(item));
}

// 历史机器采集的空链接/占位标题记录：只归档，不删除；manual 主动补录保持不动。
if (apply) {
  const apps = db.all('SELECT * FROM applications WHERE archived_at IS NULL');
  for (const app of apps) {
    const methods = util.safeJsonParse(app.source_methods_json, []) || [];
    if (methods.includes('manual')) continue;
    const selfUrl = localSelf(app.job_url);
    const placeholder = /系统判断|加分项或注意事项|批次待补充|城市待补充|还没有投递记录/i.test(`${app.company_name || ''} ${app.job_title || ''}`);
    const emptyPlugin = !app.company_name && !app.job_title && !app.job_url && !app.jd_summary && !app.jd_text;
    if (!selfUrl && !placeholder && !emptyPlugin) continue;
    try {
      reviews.archiveApplication({ ownerId: app.owner_id, applicationId: app.id, expectedVersion: app.version, archive: true, reason: selfUrl ? '历史自身页面误采集' : '历史无效/占位岗位信息', actor: 'system' });
      if (selfUrl) {
        db.run('UPDATE applications SET job_url=NULL, canonical_job_url=NULL, updated_at=?, version=version+1 WHERE id=?', [util.nowIso(), app.id]);
        db.run(`INSERT INTO audit_log (id,owner_id,actor,action,target_type,target_id,meta_json,created_at) VALUES (?,?,'system','application.clear_self_url','application',?,?,?)`,
          [util.newId('aud'), app.owner_id, app.id, JSON.stringify({ reason: '自身页面历史错误链接，无法恢复为真实岗位链接' }), util.nowIso()]);
      }
      result.archived_apps += 1;
    } catch (err) {
      result.failures += 1;
      console.log(JSON.stringify({ id: app.id, decision: 'archive_failed', detail: err.message }));
    }
  }
}
result.still_open = openReviewCount();
fs.mkdirSync(path.join(ROOT, '.tmp', 'remediate'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.tmp', 'remediate', 'report.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ phase: 'done', ...result, items: undefined }, null, 2));
db.closeDb();
