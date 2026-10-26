#!/usr/bin/env node
/*
 * 历史浏览复核修复（v2）
 *
 * 用法：
 *   node server/scripts/repair-browse-reviews.js --db <sqlite>                # dry-run 计划
 *   node server/scripts/repair-browse-reviews.js --db <sqlite> --apply        # 执行（自动备份）
 *   node server/scripts/repair-browse-reviews.js --db <sqlite> --fix-migrated # 补全上一版迁移产生的记录
 *   node server/scripts/repair-browse-reviews.js --db <sqlite> --audit        # 审查已迁移/合并结果
 *
 * 规则：
 *   - 只处理 job_viewed / job_captured 的 VIEW_FIELDS_INCOMPLETE / COMPANY_TITLE_ONLY；
 *   - 必须有稳定身份（site_job_id / site_application_id / job_url），且不是本机/测试地址；
 *   - 合并必须身份一致：站点 + 岗位 ID 同站点；或 canonical URL 相同；多候选一律不合并；
 *   - 新建保留 site_job_id / site_application_id / canonical URL / JD 全文 / 来源字段，
 *     并把 events.application_id 指回记录；写 history 与数据修订号；
 *   - 幂等：已处理过的事件不再处理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const dbPath = path.resolve(opt('--db', 'data/tounar.sqlite'));
const applying = args.includes('--apply');
const fixMigrated = args.includes('--fix-migrated');
const audit = args.includes('--audit');
const outPath = opt('--out', null);
if (!fs.existsSync(dbPath)) { console.error(`找不到数据库：${dbPath}`); process.exit(2); }

const JUNK_TITLE = /^(岗位详情|职位详情|首页|加载中|招聘首页|加分项或注意事项|职位列表|岗位列表)$/;
const db = new DatabaseSync(dbPath, { readOnly: !(applying || fixMigrated) });

function canonical(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (/^(sid|session|sessionid|token|auth|code|state)$/i.test(key)) u.searchParams.delete(key);
    return u.toString();
  } catch { return null; }
}
function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }
function bump() { db.prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'data_revision'").run(); }

function matchExisting(owner, p) {
  const siteJobId = p.site_job_id || null;
  const siteKey = p.site_key || null;
  const canon = p.job_url ? canonical(p.job_url) : null;
  const found = new Map();
  if (siteJobId) {
    for (const row of db.prepare(`SELECT * FROM applications WHERE owner_id=? AND archived_at IS NULL AND site_job_id=?`).all(owner, siteJobId)) {
      // 站点 ID 必须同站点；两边都有 site_key 时必须一致
      if (siteKey && row.site_key && row.site_key !== siteKey) continue;
      found.set(row.id, row);
    }
  }
  if (canon) for (const row of db.prepare(`SELECT * FROM applications WHERE owner_id=? AND archived_at IS NULL AND (canonical_job_url=? OR job_url=?)`).all(owner, canon, p.job_url)) found.set(row.id, row);
  return [...found.values()];
}

function plan() {
  const rows = db.prepare(`SELECT r.id AS review_id, r.owner_id, r.reason_code,
      e.id AS event_id, e.event_type, e.payload_json, e.occurred_at, e.observed_at, e.site_key
    FROM review_items r JOIN events e ON e.id = r.source_event_id
    WHERE r.status='open' AND r.reason_code IN ('VIEW_FIELDS_INCOMPLETE','COMPANY_TITLE_ONLY')`).all();
  const items = [];
  for (const row of rows) {
    const p = JSON.parse(row.payload_json || '{}');
    const url = p.job_url || '';
    const host = hostOf(url);
    const localOrTest = !url || /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(host);
    const identity = p.site_application_id || p.site_job_id || url;
    const title = String(p.job_title || '').trim();
    const cleanTitle = title && !JUNK_TITLE.test(title) ? title : null;
    const company = String(p.company_name || '').trim() || null;
    const reasons = [];
    if (!['job_viewed', 'job_captured'].includes(row.event_type)) reasons.push(`不是浏览事件（${row.event_type}）`);
    if (localOrTest) reasons.push('本机/测试地址或缺少岗位链接，无法核对');
    if (!identity) reasons.push('没有稳定岗位身份');
    if (!cleanTitle && !company) reasons.push('公司和岗位都没有可用值');
    const matches = reasons.length ? [] : matchExisting(row.owner_id, { ...p, site_key: row.site_key });
    if (matches.length > 1) reasons.push(`命中 ${matches.length} 条已有记录，身份不唯一，保留人工判断`);
    const target = matches.length === 1 ? matches[0] : null;
    items.push({
      review_id: row.review_id, owner_id: row.owner_id, event_id: row.event_id, event_type: row.event_type,
      reason_code: row.reason_code, site_key: row.site_key,
      job_url: url || null, canonical_job_url: url ? canonical(url) : null,
      site_job_id: p.site_job_id || null, site_application_id: p.site_application_id || null,
      company_name: company, job_title: cleanTitle, location: p.location || null,
      recruitment_batch: p.recruitment_batch || null, channel: p.channel || null,
      jd_summary: (p.jd_summary || '').slice(0, 80) || null, jd_text: p.jd_text || null,
      jd_status: p.jd_status || null, occurred_at: row.occurred_at,
      action: reasons.length ? 'skip' : target ? 'merge' : 'create',
      target_application_id: target?.id || null,
      skip_reasons: reasons
    });
  }
  return items;
}

function applyItems(items) {
  const now = new Date().toISOString();
  let created = 0; let merged = 0; let resolved = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of items.filter((x) => x.action !== 'skip')) {
      let appId = item.target_application_id;
      if (appId) {
        merged += 1;
        const app = db.prepare('SELECT * FROM applications WHERE id=?').get(appId);
        const sets = []; const vals = [];
        const fill = (col, val) => { if (val && !app[col]) { sets.push(`${col}=?`); vals.push(val); } };
        fill('site_job_id', item.site_job_id);
        fill('site_application_id', item.site_application_id);
        fill('job_url', item.job_url);
        fill('canonical_job_url', item.canonical_job_url);
        fill('jd_text', item.jd_text);
        fill('jd_summary', item.jd_summary);
        if (sets.length) db.prepare(`UPDATE applications SET ${sets.join(',')}, version=version+1, updated_at=? WHERE id=?`).run(...vals, now, appId);
      } else {
        appId = 'app_mig_' + item.event_id.replace(/[^A-Za-z0-9]/g, '').slice(-20);
        db.prepare(`INSERT OR IGNORE INTO applications
          (id, owner_id, company_name, company_key, job_title, site_key, site_job_id, site_application_id,
           job_url, canonical_job_url, recruitment_batch, location, jd_summary, jd_text, jd_status, channel,
           status, has_applied, applied_at_precision, first_viewed_at, last_viewed_at,
           last_status_changed_at, last_progress_at, source_methods_json, latest_event_id, version, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', 0, 'unknown', ?, ?, ?, ?, '[\"plugin\"]', ?, 1, ?, ?)`)
          .run(appId, item.owner_id, item.company_name || '', item.company_name || '', item.job_title || '',
            item.site_key || null, item.site_job_id, item.site_application_id, item.job_url, item.canonical_job_url,
            item.recruitment_batch, item.location, item.jd_summary, item.jd_text, item.jd_status || 'missing', item.channel || '未知',
            item.occurred_at || now, item.occurred_at || now, now, now, item.event_id, now, now);
        db.prepare(`INSERT INTO application_history
          (id, owner_id, application_id, event_id, from_status, to_status, changed_fields_json, changed_at, source_method, reason)
          VALUES (?,?,?,?,NULL,'pending',?,?, 'plugin', ?)`)
          .run('hist_mig_' + item.event_id.replace(/[^A-Za-z0-9]/g, '').slice(-18), item.owner_id, appId, item.event_id,
            JSON.stringify({ migrated_from_review: item.review_id }), now, '历史浏览复核迁移');
        created += 1;
      }
      db.prepare("UPDATE events SET application_id=?, processing_state='applied', processed_at=? WHERE id=?").run(appId, now, item.event_id);
      const updated = db.prepare(`UPDATE review_items SET status='resolved', resolution_json=?, resolved_at=?, version=version+1
        WHERE id=? AND status='open'`).run(JSON.stringify({ resolution: 'migrated_browse', application_id: appId, note: '可追溯的普通浏览迁回看过没投', at: now }), now, item.review_id);
      if (updated.changes) resolved += 1;
    }
    db.exec('COMMIT');
    bump();
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { created, merged, resolved };
}

/* 补上一版迁移产生的 app_mig_*：按 latest_event 的 payload 回填身份与 JD */
function fixPreviousMigrated() {
  const rows = db.prepare(`SELECT id, owner_id, latest_event_id FROM applications WHERE id LIKE 'app_mig_%'`).all();
  let fixed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const app of rows) {
      const event = db.prepare('SELECT id, payload_json, occurred_at, site_key FROM events WHERE id=?').get(app.latest_event_id);
      if (!event) continue;
      const p = JSON.parse(event.payload_json || '{}');
      const sets = []; const vals = [];
      const fill = (col, val) => { if (val) { sets.push(`${col}=?`); vals.push(val); } };
      fill('site_job_id', p.site_job_id); fill('site_application_id', p.site_application_id);
      fill('canonical_job_url', p.job_url ? canonical(p.job_url) : null);
      fill('jd_text', p.jd_text); fill('jd_summary', p.jd_summary); fill('jd_status', p.jd_status || 'missing'); fill('channel', p.channel);
      fill('site_key', event.site_key); fill('recruitment_batch', p.recruitment_batch); fill('location', p.location);
      if (sets.length) db.prepare(`UPDATE applications SET ${sets.join(',')}, version=version+1, updated_at=? WHERE id=?`).run(...vals, new Date().toISOString(), app.id);
      db.prepare("UPDATE events SET application_id=? WHERE id=? AND (application_id IS NULL OR application_id='')").run(app.id, event.id);
      db.prepare(`UPDATE review_items SET resolution_json=json_set(resolution_json,'$.application_id',?)
        WHERE source_event_id=? AND status='resolved' AND json_extract(resolution_json,'$.resolution')='migrated_browse'`).run(app.id, event.id);
      fixed += 1;
    }
    // 已合并的迁移项也把 application_id 回填进 resolution，便于后续审计
    db.prepare(`UPDATE review_items
      SET resolution_json = json_set(resolution_json,'$.application_id',(SELECT application_id FROM events WHERE id=source_event_id))
      WHERE json_extract(resolution_json,'$.resolution')='migrated_browse'
        AND json_extract(resolution_json,'$.application_id') IS NULL
        AND (SELECT application_id FROM events WHERE id=source_event_id) IS NOT NULL`).run();
    db.exec('COMMIT');
    bump();
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { fixed };
}

function auditMigrations() {
  const rows = db.prepare(`SELECT r.id AS review_id, r.resolution_json, r.source_event_id,
      a.id AS app_id, a.site_key AS app_site, a.site_job_id AS app_job_id, a.job_url AS app_url,
      e.site_key AS ev_site, e.payload_json
    FROM review_items r
    LEFT JOIN events e ON e.id = r.source_event_id
    LEFT JOIN applications a ON a.id = COALESCE(json_extract(r.resolution_json, '$.application_id'), e.application_id)
    WHERE r.status='resolved' AND json_extract(r.resolution_json, '$.resolution')='migrated_browse'`).all();
  const out = [];
  for (const row of rows) {
    const p = JSON.parse(row.payload_json || '{}');
    const evJob = p.site_job_id || null; const evUrl = p.job_url || null;
    const appId = row.app_id || null;
    const siteMismatch = Boolean(row.ev_site && row.app_site && row.ev_site !== row.app_site);
    const idMismatch = Boolean(evJob && row.app_job_id && evJob !== row.app_job_id);
    const urlMismatch = Boolean(evUrl && row.app_url && hostOf(evUrl) !== hostOf(row.app_url));
    out.push({ review_id: row.review_id, app_id: appId, event_site: row.ev_site, app_site: row.app_site,
      event_job_id: evJob, app_job_id: row.app_job_id, event_url: evUrl, app_url: row.app_url,
      site_mismatch: siteMismatch, id_mismatch: idMismatch, url_host_mismatch: urlMismatch,
      suspicious: siteMismatch || idMismatch || urlMismatch });
  }
  return out;
}

try {
  if (audit) {
    const rows = auditMigrations();
    console.log(JSON.stringify({ mode: 'audit', total: rows.length, suspicious: rows.filter((r) => r.suspicious).length, rows }, null, 2));
  } else if (fixMigrated) {
    const backupPath = `${dbPath}.pre-fix-migrated-${Date.now()}.sqlite`;
    await backup(db, backupPath);
    const result = fixPreviousMigrated();
    console.log(JSON.stringify({ mode: 'fix-migrated', ...result, backup: backupPath, audit: auditMigrations() }, null, 2));
  } else {
    const items = plan();
    const eligible = items.filter((x) => x.action !== 'skip');
    const report = { generated_at: new Date().toISOString(), database: dbPath, mode: applying ? 'apply' : 'dry-run',
      open_items: items.length, create: eligible.filter((x) => x.action === 'create').length,
      merge: eligible.filter((x) => x.action === 'merge').length,
      skipped: items.filter((x) => x.action === 'skip').length };
    if (!applying) {
      if (outPath) fs.writeFileSync(outPath, JSON.stringify({ ...report, items }, null, 2) + '\n', { mode: 0o600 });
      console.log(JSON.stringify({ ...report, items }, null, 2));
    } else {
      const backupPath = `${dbPath}.pre-browse-repair-${Date.now()}.sqlite`;
      await backup(db, backupPath);
      const result = applyItems(items);
      console.log(JSON.stringify({ ...report, ...result, backup: backupPath, audit: auditMigrations() }, null, 2));
    }
  }
} finally {
  db.close();
}
