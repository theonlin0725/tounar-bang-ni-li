import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer } from './helpers.js';

let server, cookie, owner;
before(async () => {
  server = await startTestServer({ name: 'review-display' });
  cookie = (await server.login('demo@tounar.local')).cookie;
});
after(async () => server?.stop());

function seedMailReview({ reviewId = 'rev_mail_display_1', includeJd = true, multipleCandidates = false } = {}) {
  const db = new DatabaseSync(server.dir + '/tounar.sqlite');
  try {
    owner = db.prepare("SELECT id FROM users WHERE email_normalized='demo@tounar.local'").get().id;
    const now = new Date().toISOString();
    const connectionId = 'mailconn_display_1';
    const mailId = 'mail_display_1';
    const eventId = 'evt_mail_display_1';
    db.prepare(`INSERT OR IGNORE INTO mail_connections
      (id,owner_id,email,mode,scan_since,status,consent_version,created_at,updated_at)
      VALUES (?,?,?,?,?,'connected','QQ_MAIL_READ_CONSENT_V1',?,?)`)
      .run(connectionId, owner, 'demo@qq.com', 'recruitment_body', now, now, now);
    db.prepare(`INSERT OR IGNORE INTO mail_messages
      (id,owner_id,connection_id,mailbox,uidvalidity,uid,subject_excerpt,from_domain,received_at,category,processing_state,created_at)
      VALUES (?,?,?,'INBOX','1','1',?,?,?,'interview','pending',?)`)
      .run(mailId, owner, connectionId, '面试邀请：数据产品实习生', 'jobs.example.com', '2026-10-20T03:00:00.000Z', now);
    const payload = {
      source_mail_id: mailId, subject_excerpt: '面试邀请：数据产品实习生', from_domain: 'jobs.example.com',
      body_excerpt: '您好，邀请您参加数据产品实习生岗位的一面，时间可协商。', read_mode: 'recruitment_body',
      category: 'interview', mapped_status: 'interview', confidence: 0.9,
      source_received_at: '2026-10-20T03:00:00.000Z', company_name: '星云科技', job_title: '数据产品实习生',
      job_url: 'https://jobs.example.com/nebula/dp-intern', location: '上海'
    };
    db.prepare(`INSERT OR IGNORE INTO events
      (id,owner_id,client_event_id,source_method,event_type,occurred_at,observed_at,received_at,schema_version,evidence_level,payload_hash,payload_json,processing_state,connection_id,mailbox,uidvalidity,uid)
      VALUES (?,?,?,'mail','mail_progress_detected',?,?,?,'C1','strong','hash',?,'pending',?, 'INBOX','1','1')`)
      .run(eventId, owner, eventId, '2026-10-20T03:00:00.000Z', '2026-10-20T03:00:05.000Z', now, JSON.stringify(payload), connectionId);
    const appId = 'app_mail_display_1';
    if (includeJd) {
      db.prepare(`INSERT OR IGNORE INTO applications
        (id,owner_id,company_name,company_key,job_title,status,has_applied,jd_text,jd_summary,jd_status,job_url,canonical_job_url,channel,source_methods_json,latest_event_id,version,created_at,updated_at)
        VALUES (?,?,?,?,?,'pending',0,?,?,'complete',?,?,'官网','["plugin"]',?,1,?,?)`)
        .run(appId, owner, '星云科技', '星云科技', '数据产品实习生', '负责数据产品需求分析、指标体系和用户研究。', '数据产品实习生', 'https://jobs.example.com/nebula/dp-intern', 'https://jobs.example.com/nebula/dp-intern', eventId, now, now);
    }
    const candidates = includeJd ? [{
      application_id: appId, application_version: 1, company_name: '星云科技', job_title: '数据产品实习生',
      status: 'pending', has_applied: false, match_reason: 'canonical_job_url', matching_confidence: null
    }] : [];
    if (multipleCandidates) candidates.push({ ...candidates[0], application_id: 'app_other_candidate', job_title: '另一个岗位' });
    db.prepare(`INSERT OR REPLACE INTO review_items
      (id,owner_id,kind,reason_code,summary,evidence_json,suggested_changes_json,candidates_json,source_event_id,source_mail_id,status,version,created_at)
      VALUES (?,?,'mail_progress','MAIL_MATCH_UNCONFIRMED','邮件进展待确认',?,?,?,?,?,'open',1,?)`)
      .run(reviewId, owner,
        JSON.stringify({ subject_excerpt: '面试邀请：数据产品实习生', body_excerpt: payload.body_excerpt, read_mode: 'recruitment_body', from_domain: 'jobs.example.com', category: 'interview', confidence: 0.9 }),
        JSON.stringify({ status: 'interview' }), JSON.stringify(candidates), eventId, mailId, now);
  } finally { db.close(); }
}

it('邮件待确认展示主题、正文摘要、收信时间和唯一关联岗位 JD，不混入其他候选', async () => {
  seedMailReview();
  const res = await server.request('/api/v1/review-items/rev_mail_display_1', { cookie });
  assert.equal(res.status, 200);
  const d = res.json.data.display;
  assert.equal(d.source, 'mail');
  assert.equal(d.source_label, '邮件');
  assert.equal(d.site_name, 'jobs.example.com');
  assert.ok(d.title.includes('面试邀请'));
  assert.ok(d.preview.includes('数据产品实习生'));
  assert.ok(d.full_text.includes('负责数据产品需求分析'), '唯一强关联岗位的 JD 应可查看');
  assert.equal(d.linked_application.id, 'app_mail_display_1');
  assert.ok(d.time);
  assert.ok(!JSON.stringify(d).includes('系统判断'));
  assert.ok(!JSON.stringify(d).includes('缺失字段'));
});

it('邮件候选不唯一时不展示任何候选 JD，避免串岗位', async () => {
  seedMailReview({ reviewId: 'rev_mail_display_ambiguous', multipleCandidates: true });
  const res = await server.request('/api/v1/review-items/rev_mail_display_ambiguous', { cookie });
  assert.equal(res.status, 200);
  const d = res.json.data.display;
  assert.equal(d.source, 'mail');
  assert.equal(d.linked_application, null);
  assert.ok(!String(d.full_text).includes('负责数据产品需求分析'));
  assert.ok(!String(d.full_text).includes('另一个岗位'));
});
