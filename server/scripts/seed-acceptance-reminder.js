#!/usr/bin/env node
/*
 * 本机验收用：造一条「面试后第 8 天」的【验收】记录，让 reminders 立刻到期待提醒。
 *
 * 只对验收副本生效：必须显式指定 DATA_DIR（指向 ~/tounar-acceptance/<时间戳>），
 * 脚本会拒绝在项目自带 data/ 目录上运行，避免误写真实库。
 *
 * 用法：
 *   node --env-file=~/tounar-acceptance/<时间戳>/acceptance.env \
 *        server/scripts/seed-acceptance-reminder.js
 */
import path from 'node:path';
import { config } from '../src/config.js';
import { getDb, one, run, closeDb } from '../src/db.js';
import { createApplication } from '../src/domain/applications.js';
import { nowIso } from '../src/util.js';

const defaultDataDir = path.resolve(config.root, 'data');
if (path.resolve(config.dataDir) === defaultDataDir) {
  console.error('❌ 这是项目自带 data/（可能是真实库）。请用 --env-file 指向 ~/tounar-acceptance/<时间戳>/acceptance.env');
  process.exit(2);
}

getDb();
const email = process.env.ACCEPTANCE_EMAIL || '';
// 优先真实用户（非 @tounar.local 的假域名），这样 smtp 模式发信不会被退信
const owner = (email && one('SELECT id, email_normalized FROM users WHERE email_normalized = ?', [email]))
  || one("SELECT id, email_normalized FROM users WHERE email_normalized NOT LIKE '%@tounar.local' ORDER BY created_at LIMIT 1")
  || one('SELECT id, email_normalized FROM users ORDER BY created_at LIMIT 1');
if (!owner) {
  console.error('❌ 副本里没有用户，先跑一次 local:acceptance 完成初始化');
  process.exit(2);
}

const day = 86400000;
const now = Date.now();
const interviewAt = new Date(now - 8 * day).toISOString();
const appliedAt = new Date(now - 12 * day).toISOString();

const app = createApplication({
  ownerId: owner.id,
  fields: {
    company_name: '【验收】示例公司',
    job_title: '后端开发实习生【验收】',
    job_url: 'https://example.com/jobs/acceptance-demo',
    location: '广州',
    applied_at: appliedAt,
    applied_at_precision: 'exact',
    interview_scheduled_at: interviewAt
  },
  sourceMethod: 'manual',
  status: 'interview',
  at: interviewAt
});

// 面试后第 8 天：锚点回拨到面试时间，并清掉节流，保证今天这一批会真的提醒
run('UPDATE applications SET stage_anchor_at = ?, stage_received_at = ?, interview_scheduled_at = ?, last_b_notified_at = NULL, stage_last_notified_anchor = NULL WHERE id = ?',
  [interviewAt, appliedAt, interviewAt, app.id]);

const prefs = one('SELECT * FROM notification_preferences WHERE owner_id = ?', [owner.id]);
if (prefs && prefs.stage_followup_days !== 7) {
  run('UPDATE notification_preferences SET stage_followup_days = 7 WHERE owner_id = ?', [owner.id]);
}

console.log(JSON.stringify({
  application_id: app.id,
  owner: owner.email_normalized,
  interview_at: interviewAt,
  stage_followup_days: 7,
  data_dir: config.dataDir,
  next: 'node --env-file=<同一个 acceptance.env> server/scripts/run-reminders.js',
  seeded_at: nowIso()
}, null, 1));
closeDb();
