#!/usr/bin/env node
/*
 * 历史误分类修复：把「可追溯岗位身份」的普通浏览复核项迁回「看过没投」。
 *
 * 默认 dry-run，只打印计划；--apply 才写库（会先做一致性备份）。
 * 只处理：
 *   - review 仍 open，reason in (VIEW_FIELDS_INCOMPLETE, COMPANY_TITLE_ONLY)
 *   - 来源事件 payload 有 job_url / site_job_id / site_application_id
 *   - 且不是本机/测试地址（localhost、127.0.0.1）
 * 绝不产生 has_applied=1，也不覆盖人工确认过的记录；重复运行不新增记录。
 *
 * 用法：
 *   node server/scripts/repair-browse-reviews.js --db <sqlite> [--apply] [--out plan.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const dbPath = path.resolve(opt('--db', 'data/tounar.sqlite'));
const applying = args.includes('--apply');
const outPath = opt('--out', null);

if (!fs.existsSync(dbPath)) { console.error(`找不到数据库：${dbPath}`); process.exit(2); }

const JUNK_TITLE = /^(岗位详情|职位详情|首页|加载中|招聘首页|加分项或注意事项|职位列表|岗位列表)$/;
const db = new DatabaseSync(dbPath, { readOnly: !applying });

function plan() {
  const rows = db.prepare(`SELECT r.id AS review_id, r.owner_id, r.version, r.reason_code,
      e.id AS event_id, e.event_type, e.payload_json, e.occurred_at, e.observed_at, e.site_key
    FROM review_items r JOIN events e ON e.id = r.source_event_id
    WHERE r.status='open' AND r.reason_code IN ('VIEW_FIELDS_INCOMPLETE','COMPANY_TITLE_ONLY')`).all();
  const items = [];
  for (const row of rows) {
    const p = JSON.parse(row.payload_json || '{}');
    const url = p.job_url || '';
    let host = '';
    try { host = url ? new URL(url).hostname : ''; } catch { host = ''; }
    const localOrTest = !url || /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(host);
    const identity = p.site_application_id || p.site_job_id || url;
    const title = String(p.job_title || '').trim();
    const cleanTitle = title && !JUNK_TITLE.test(title) ? title : null;
    const company = String(p.company_name || '').trim() || null;
    const reasons = [];
    if (!['job_viewed', 'job_captured'].includes(row.event_type)) reasons.push(`不是浏览事件（${row.event_type}），不迁移`);
    if (localOrTest) reasons.push('来源是本机/测试地址或缺少岗位链接，无法核对');
    if (!identity) reasons.push('没有稳定岗位身份');
    if (!cleanTitle && !company) reasons.push('公司和岗位都没有可用值');
    items.push({
      review_id: row.review_id,
      owner_id: row.owner_id,
      event_type: row.event_type,
      site_job_id: p.site_job_id || null,
      event_id: row.event_id,
      reason_code: row.reason_code,
      site_key: row.site_key,
      job_url: url || null,
      company_name: company,
      job_title: cleanTitle,
      location: p.location || null,
      recruitment_batch: p.recruitment_batch || null,
      jd_summary: (p.jd_summary || '').slice(0, 80) || null,
      jd_text_chars: (p.jd_text || '').length || 0,
      occurred_at: row.occurred_at,
      eligible: reasons.length === 0,
      skip_reasons: reasons
    });
  }
  return items;
}

try {
  const items = plan();
  const eligible = items.filter((x) => x.eligible);
  const skipped = items.filter((x) => !x.eligible);
  const report = {
    generated_at: new Date().toISOString(),
    database: dbPath,
    mode: applying ? 'apply' : 'dry-run',
    open_items: items.length,
    eligible: eligible.length,
    skipped: skipped.length,
    items: applying ? undefined : items
  };

  if (!applying) {
    if (outPath) fs.writeFileSync(outPath, JSON.stringify({ ...report, items }, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ ...report, sample: eligible.slice(0, 5), skipped_sample: skipped.slice(0, 5) }, null, 2));
    console.log(`\ndry-run：可迁回 ${eligible.length} 条，跳过 ${skipped.length} 条。加 --apply 执行（会先备份）。`);
  } else {
    const backupPath = `${dbPath}.pre-browse-repair-${Date.now()}.sqlite`;
    await backup(db, backupPath);
    db.exec('BEGIN IMMEDIATE');
    let created = 0; let merged = 0; let resolved = 0;
    try {
      const now = new Date().toISOString();
      for (const item of eligible) {
        const existing = db.prepare(`SELECT id FROM applications WHERE owner_id=? AND archived_at IS NULL AND
          ((? IS NOT NULL AND site_job_id = ?) OR (? IS NOT NULL AND job_url = ?)) LIMIT 1`)
          .get(item.owner_id, item.site_job_id, item.site_job_id, item.job_url, item.job_url);
        const already = existing || db.prepare('SELECT id FROM applications WHERE owner_id=? AND latest_event_id=?').get(item.owner_id, item.event_id);
        if (already) {
          merged += 1;
          db.prepare('UPDATE events SET application_id=? WHERE id=?').run(already.id, item.event_id);
        }
        else {
          const id = 'app_mig_' + item.event_id.replace(/[^A-Za-z0-9]/g, '').slice(-20);
          db.prepare(`INSERT OR IGNORE INTO applications
            (id, owner_id, company_name, company_key, job_title, site_key, job_url, status, has_applied,
             applied_at_precision, first_viewed_at, last_viewed_at, last_status_changed_at, last_progress_at,
             jd_summary, source_methods_json, latest_event_id, version, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?, 'pending', 0, 'unknown', ?, ?, ?, ?, ?, '["plugin"]', ?, 1, ?, ?)`)
            .run(id, item.owner_id, item.company_name || '', item.company_name || '', item.job_title || '',
              item.site_key || null, item.job_url || null, item.occurred_at || now, item.occurred_at || now,
              now, now, item.jd_summary || null, item.event_id, now, now);
          created += 1;
        }
        const updated = db.prepare(`UPDATE review_items SET status='resolved', resolution_json=?, resolved_at=?, version=version+1
          WHERE id=? AND status='open'`).run(JSON.stringify({ resolution: 'migrated_browse', note: '可追溯的普通浏览迁回看过没投', at: now }), now, item.review_id);
        if (updated.changes) resolved += 1;
        db.prepare(`UPDATE events SET processing_state='applied', processed_at=? WHERE id=?`).run(now, item.event_id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    console.log(JSON.stringify({ ...report, created, merged, resolved, backup: backupPath }, null, 2));
  }
} finally {
  db.close();
}
