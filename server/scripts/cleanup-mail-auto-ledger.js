#!/usr/bin/env node
/*
 * 清理邮件规则误建的脏台账 / 已被自动台账覆盖的待确认项。
 * 默认 dry-run；显式 --apply 才写库。
 * 严格跳过 source_methods 中带 manual / plugin 的记录。
 */
import { all, one } from '../src/db.js';
import { archiveApplication } from '../src/domain/reviews.js';
import { resolveSupersededReviews } from '../src/domain/applications.js';
import { safeJsonParse } from '../src/util.js';
import { splitCompositeEntity } from '../src/modules/data-capture/mail/parser.js';

const APPLY = process.argv.includes('--apply');
const DIRTY = /(?:^|[\s·])(?:tounar|帮你理|recruitment|careers?|campus|hr|noreply|no-reply|95555|面试通知|招聘通知|测评通知|宣讲会|未知|待补充)(?:$|[\s·])/i;
function suspicious(app) {
  const company = String(app.company_name || '').trim();
  const title = String(app.job_title || '').trim();
  const split = splitCompositeEntity(company, title, app.recruitment_batch);
  return !company
    || DIRTY.test(company)
    || /^\d+$/.test(company)
    || /^20\d{2}/.test(company)
    || /(?:招聘|校招|测评|面试通知|宣讲会)/i.test(company)
    || (company && company === title)
    || (split.company_name && split.company_name !== company);
}
const apps = all(`SELECT * FROM applications WHERE archived_at IS NULL AND source_methods_json LIKE '%"mail"%'`);

const candidates = [];
for (const app of apps) {
  const methods = safeJsonParse(app.source_methods_json, []) || [];
  if (methods.includes('manual') || methods.includes('plugin')) continue;
  const company = String(app.company_name || '').trim();
  const title = String(app.job_title || '').trim();
  if (suspicious(app)) {
    candidates.push({ application_id: app.id, company_name: company, job_title: title, status: app.status, source_methods: methods, version: app.version });
  }
}

const output = {
  mode: APPLY ? 'apply' : 'dry-run',
  dirty_candidates: candidates,
  archived: 0,
  reviews_resolved: 0,
  errors: []
};

if (APPLY) {
  for (const item of candidates) {
    try {
      archiveApplication({
        ownerId: one('SELECT owner_id FROM applications WHERE id=?', [item.application_id]).owner_id,
        applicationId: item.application_id,
        expectedVersion: item.version,
        archive: true,
        reason: '历史邮件规则误建记录清理',
        actor: 'system:mail-cleanup'
      });
      output.archived += 1;
    } catch (err) {
      output.errors.push({ application_id: item.application_id, error: err.code || err.message });
    }
  }
  // 已自动入账的岗位不应继续留在待确认：对现存非归档记录做一次同岗覆盖清理。
  const appsNow = all('SELECT * FROM applications WHERE archived_at IS NULL');
  for (const app of appsNow) {
    try {
      output.reviews_resolved += resolveSupersededReviews(app.owner_id, app, null);
    } catch (err) {
      output.errors.push({ application_id: app.id, review_error: err.code || err.message });
    }
  }
} else {
  const reviews = all("SELECT COUNT(*) n FROM review_items WHERE status='open'")[0]?.n || 0;
  output.open_reviews = Number(reviews);
  output.note = 'dry-run 不修改；--apply 将归档候选并关闭已被台账覆盖的 open review。';
}
console.log(JSON.stringify(output, null, 2));
