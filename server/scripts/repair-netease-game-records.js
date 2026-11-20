#!/usr/bin/env node
/*
 * 网易互娱 campus.game.163.com 四条已采记录的隔离修复工具。
 *
 * 只在明确的岗位主机 + /app/detail/index + 数字 id 上工作；不按整个 163 域名或
 * JD 文本猜公司。按 owner/site_job_id/规范链接唯一匹配，保留记录 ID、状态、历史、
 * 邮件关联和报告快照。字段有 manual 来源时跳过；有冲突时只报告，不覆盖。
 *
 * 预演：
 *   DATA_DIR=/path/to/isolated node server/scripts/repair-netease-game-records.js
 * 执行：
 *   DATA_DIR=/path/to/isolated node server/scripts/repair-netease-game-records.js --apply
 */
import { all, one, run, markApplicationChanged } from '../src/db.js';
import { clipText, normalizeCompanyKey } from '../src/util.js';

const APPLY = process.argv.includes('--apply');
const HOST = 'campus.game.163.com';
const PATH = '/app/detail/index';
const COMPANY = '网易游戏（互娱）';
const EXPECTED = {
  '4721': { title: '游戏设计师（战斗策划）', location: '杭州、上海、广州' },
  '4739': { title: '图形开发工程师', location: '杭州、上海、广州' },
  '4731': { title: '游戏研发工程师（客户端/服务端）', location: '杭州、上海、广州' },
  '4765': { title: '游戏技术美术工程师（PCG向）', location: '广州' }
};
const SOURCE_DETAILS = {
  company_name: 'netease_game_directory_verified',
  job_title: 'netease_game_detail_template_v1',
  location: 'netease_game_detail_template_v1',
  jd_summary: 'netease_game_jd_summary_v1'
};

function parsedIdentity(app) {
  try {
    const url = new URL(app.job_url || '');
    if (url.hostname !== HOST || url.pathname !== PATH) return null;
    const id = url.searchParams.get('id') || app.site_job_id || '';
    return EXPECTED[id] ? id : null;
  } catch {
    return null;
  }
}

function summaryFromJd(jd) {
  const text = String(jd || '').replace(/\r\n/g, '\n');
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const start = lines.findIndex((line) => /^(岗位描述|职位描述|工作职责|岗位职责)$/.test(line));
  const end = lines.findIndex((line, index) => index > start && /^(岗位要求|任职要求|职位要求|任职资格)$/.test(line));
  const section = lines.slice(start >= 0 ? start + 1 : 0, end > start ? end : undefined);
  const bullets = section.filter((line) => /^[-•]/.test(line)).slice(0, 3);
  const picked = bullets.length ? bullets : section.slice(0, 3);
  if (!picked.length) return appFallbackSummary(text);
  return clipText(`岗位职责 ${picked.join(' ')}`, 80);
}
function appFallbackSummary(text) {
  return clipText(String(text || '').split(/\n+/).find((line) => line.trim()) || '', 80);
}
function sourceFor(appId, field) {
  return one('SELECT * FROM application_field_sources WHERE application_id = ? AND field = ?', [appId, field]);
}
function projectedSource(row) {
  return row ? `${row.source_method}/${row.confidence}${row.source_detail ? `/${row.source_detail}` : ''}` : 'unavailable';
}

const rows = all("SELECT * FROM applications WHERE job_url LIKE 'https://campus.game.163.com/app/detail/index?%' ORDER BY created_at ASC");
const results = [];
for (const app of rows) {
  const id = parsedIdentity(app);
  if (!id) {
    results.push({ application_id: app.id, site_job_id: app.site_job_id, status: 'skip', reason: '非目标详情/未知岗位 ID' });
    continue;
  }
  const expected = EXPECTED[id];
  const changes = {};
  const before = {};
  const sourceBefore = {};
  const skipped = [];
  const target = {
    company_name: COMPANY,
    job_title: expected.title,
    location: expected.location,
    jd_summary: summaryFromJd(app.jd_text || app.jd_summary)
  };
  for (const field of ['company_name', 'job_title', 'location', 'jd_summary']) {
    const source = sourceFor(app.id, field);
    before[field] = app[field] ?? null;
    sourceBefore[field] = projectedSource(source);
    if (source?.source_method === 'manual') {
      skipped.push({ field, reason: 'manual_source' });
      continue;
    }
    const current = app[field] == null ? '' : String(app[field]).trim();
    const wanted = String(target[field] || '').trim();
    if (!wanted) {
      skipped.push({ field, reason: 'no_reliable_target' });
      continue;
    }
    if (field === 'company_name' && current && current !== wanted) {
      skipped.push({ field, reason: 'conflicting_nonempty_company', current, wanted });
      continue;
    }
    if (field === 'location' && current && current !== wanted) {
      skipped.push({ field, reason: 'conflicting_nonempty_location', current, wanted });
      continue;
    }
    if (field === 'job_title' && current && current === wanted) {
      // Value is already right; refresh provenance below.
      continue;
    }
    if (field === 'job_title' && current && current !== wanted) {
      changes[field] = wanted;
      continue;
    }
    if (!current || (field === 'jd_summary' && current !== wanted)) changes[field] = wanted;
  }
  if (changes.company_name) changes.company_key = normalizeCompanyKey(changes.company_name);
  const changedFields = Object.keys(changes);
  const preview = {
    application_id: app.id,
    owner_id: app.owner_id,
    site_job_id: id,
    job_url: app.job_url,
    status: app.status,
    before,
    source_before: sourceBefore,
    after: { ...before, ...changes },
    changes,
    skipped,
    source_after: Object.fromEntries(Object.keys(target).map((field) => [field, `plugin/high/${SOURCE_DETAILS[field]}`]))
  };
  if (APPLY) {
    if (changedFields.length) {
      markApplicationChanged(app.owner_id, app.id, null, 'plugin', changes, {
        reason: '网易互娱 campus.game.163.com 实页模板修复',
        fieldConfidence: Object.fromEntries(changedFields.map((field) => [field, 'high'])),
        sourceDetails: Object.fromEntries(changedFields.map((field) => [field, SOURCE_DETAILS[field]]))
      });
    }
    // 值未变的字段也补上“已验证模板”来源，避免继续显示 unavailable/规则猜测。
    for (const field of Object.keys(target)) {
      if (skipped.some((x) => x.field === field)) continue;
      run(`INSERT INTO application_field_sources
        (application_id, owner_id, field, source_method, event_id, updated_at, confidence, source_detail)
        VALUES (?, ?, ?, 'plugin', NULL, datetime('now'), 'high', ?)
        ON CONFLICT(application_id, field) DO UPDATE SET source_method='plugin',
          event_id=NULL, updated_at=datetime('now'), confidence='high', source_detail=excluded.source_detail`,
      [app.id, app.owner_id, field, SOURCE_DETAILS[field]]);
    }
    preview.applied = true;
    preview.after_saved = one('SELECT company_name, job_title, location, jd_summary, status, version FROM applications WHERE id = ? AND owner_id = ?', [app.id, app.owner_id]);
  }
  results.push(preview);
}

const output = {
  mode: APPLY ? 'apply' : 'dry-run',
  target_host: HOST,
  target_path: PATH,
  matched: results.filter((row) => row.site_job_id).length,
  changed: results.filter((row) => row.changes && Object.keys(row.changes).length).length,
  results
};
console.log(JSON.stringify(output, null, 2));
