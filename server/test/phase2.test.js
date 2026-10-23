import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tounar-phase2-'));
process.env.DATA_DIR = dir;
process.env.ENABLE_SCHEDULER = 'false';
const db = await import('../src/db.js');
const apps = await import('../src/domain/applications.js');
const ledger = await import('../src/domain/ledger.js');
const { newId, nowIso } = await import('../src/util.js');
const owner = 'phase2-owner';
db.run('INSERT INTO users (id,email_normalized,email_display,created_at) VALUES (?,?,?,?)', [owner,'phase2@tounar.local','phase2@tounar.local',nowIso()]);
after(() => { db.closeDb(); fs.rmSync(dir,{recursive:true,force:true}); });
function mailEvent(payload = {}) {
  const id = newId('evt');
  const event = { id,owner_id:owner,source_method:'mail',occurred_at:'2026-10-20T03:00:00.000Z',received_at:nowIso(),payload };
  db.run(`INSERT INTO events (id,owner_id,client_event_id,source_method,event_type,occurred_at,observed_at,received_at,schema_version,evidence_level,payload_hash,payload_json) VALUES (?,?,?,'mail','mail_progress_detected',?,?,?,'C1','strong','test',?)`,[id,owner,id,event.occurred_at,event.occurred_at,event.received_at,JSON.stringify(payload)]);
  return event;
}
it('P0: 邮件复核保留原信 ID，列表和详情返回同一收信时间', () => {
  const connection = newId('conn'), mail = newId('mail');
  db.run(`INSERT INTO mail_connections (id,owner_id,email,mode,scan_since,consent_version,created_at,updated_at) VALUES (?,?,'phase2@qq.com','headers_only',?,'test',?,?)`,[connection,owner,nowIso(),nowIso(),nowIso()]);
  db.run(`INSERT INTO mail_messages (id,owner_id,connection_id,mailbox,uidvalidity,uid,received_at,created_at) VALUES (?,?,?,'INBOX','1','1',?,?)`,[mail,owner,connection,'2026-10-20T03:00:00.000Z',nowIso()]);
  const e=mailEvent({source_mail_id:mail,confidence:0.4,company_name:'测试公司',job_title:'产品经理',mapped_status:'interview'});
  const r=apps.processMailEvent(e).review;
  assert.equal(r.source_mail_id,mail);
  assert.equal(ledger.reviewDetail(owner,r.id).data.mail_received_at,e.occurred_at);
  assert.equal(ledger.reviewList(owner).data.find(x=>x.id===r.id).mail_received_at,e.occurred_at);
});
