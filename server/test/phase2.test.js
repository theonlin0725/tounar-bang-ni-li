import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tounar-phase2-'));
process.env.DATA_DIR = dir;
process.env.ENABLE_SCHEDULER = 'false';
process.env.MAIL_MODE = 'outbox';
const db = await import('../src/db.js');
const apps = await import('../src/domain/applications.js');
const ledger = await import('../src/domain/ledger.js');
const { newId, nowIso } = await import('../src/util.js');
const reviews = await import('../src/domain/reviews.js');
const matching = await import('../src/domain/mailMatching.js');
const {config}=await import('../src/config.js');
const reminders = await import('../src/domain/reminders.js');
const {stageFollowupState}=await import('../src/util.js');
const owner = 'phase2-owner';
db.run('INSERT INTO users (id,email_normalized,email_display,created_at) VALUES (?,?,?,?)', [owner,'phase2@tounar.local','phase2@tounar.local',nowIso()]);
after(() => { db.closeDb(); fs.rmSync(dir,{recursive:true,force:true}); });
function mailEvent(payload = {}, mailOwner = owner) {
  const id = newId('evt');
  const event = { id,owner_id:mailOwner,source_method:'mail',occurred_at:'2026-10-20T03:00:00.000Z',received_at:nowIso(),payload };
  db.run(`INSERT INTO events (id,owner_id,client_event_id,source_method,event_type,occurred_at,observed_at,received_at,schema_version,evidence_level,payload_hash,payload_json) VALUES (?,?,?,'mail','mail_progress_detected',?,?,?,'C1','strong','test',?)`,[id,mailOwner,id,event.occurred_at,event.occurred_at,event.received_at,JSON.stringify(payload)]);
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
it('P1: 无候选可关联本人任意记录，沿用已有投递时间；10秒撤销恢复状态', () => {
  const app=apps.createApplication({ownerId:owner,fields:{company_name:'原有公司',job_title:'开发工程师',applied_at:'2026-10-01T00:00:00Z'},sourceMethod:'manual',status:'applied'});
  const event=mailEvent({company_name:'未知名称',job_title:'未匹配岗位',mapped_status:'interview',confidence:0.3});
  const review=apps.processMailEvent(event).review;
  assert.equal(JSON.parse(review.candidates_json).length,0);
  const result=reviews.resolveReview({ownerId:owner,reviewId:review.id,expectedVersion:review.version,action:'link',applicationId:app.id,expectedApplicationVersion:app.version});
  assert.equal(result.application.status,'interview');assert.equal(result.application.applied_at,app.applied_at);
  assert.equal(result.application.company_name,app.company_name);
  reviews.undoReview({ownerId:owner,reviewId:review.id,expectedVersion:result.review.version});
  assert.equal(db.getApplication(owner,app.id).status,'applied');
  assert.equal(ledger.reviewDetail(owner,review.id).data.status,'open');
});
it('P1: 撤销拒绝覆盖后来的人工修改，列表分页不漏项',()=>{
  const app=apps.createApplication({ownerId:owner,fields:{company_name:'撤销公司',job_title:'岗位',applied_at:'2026-10-01T00:00:00Z'},sourceMethod:'manual',status:'applied'});
  const review=apps.processMailEvent(mailEvent({mapped_status:'interview',confidence:0.1})).review;
  const result=reviews.resolveReview({ownerId:owner,reviewId:review.id,expectedVersion:review.version,action:'link',applicationId:app.id,expectedApplicationVersion:app.version});
  db.markApplicationChanged(owner,app.id,null,'manual',{location:'上海'});
  assert.throws(()=>reviews.undoReview({ownerId:owner,reviewId:review.id,expectedVersion:result.review.version}),e=>e.status===409);
  const page=ledger.reviewList(owner,{limit:1});assert.ok(page.page.has_more);assert.ok(ledger.reviewList(owner,{limit:1,cursor:page.page.next_cursor}).data[0].id!==page.data[0].id);
});
it('P2: 邮件别名/域名与岗位规范化，和插件去重分开',()=>{
  assert.equal(matching.companyIdentity('ByteDance'),'字节跳动');assert.equal(matching.companyIdentity(null,'hr.bytedance.com'),'字节跳动');
  assert.equal(matching.companyIdentity('腾讯音乐'),'腾讯音乐');assert.equal(matching.companyIdentity(null,'qq.com'),null);
  assert.equal(matching.companyIdentity('腾讯','bytedance.com'),null);
  assert.ok(matching.similarJob('2027届校招 产品经理-北京','产品经理'));
});
it('P2: 唯一高把握面邀自动更新；多候选不自动更新',()=>{
  const app=apps.createApplication({ownerId:owner,fields:{company_name:'字节跳动',job_title:'数据分析师',applied_at:'2026-10-01T00:00:00Z'},sourceMethod:'manual',status:'applied'});
  const e=mailEvent({company_name:'ByteDance',job_title:'2027届校招 数据分析师-北京',mapped_status:'interview',confidence:0.94,subject_excerpt:'面试邀请'});
  assert.equal(apps.processMailEvent(e).application.status,'interview');
  assert.equal(db.getApplication(owner,app.id).status,'interview');
  apps.createApplication({ownerId:owner,fields:{company_name:'字节跳动',job_title:'数据分析师',applied_at:'2026-10-02T00:00:00Z'},sourceMethod:'manual',status:'applied'});
  const r=apps.processMailEvent(mailEvent({company_name:'字节跳动',job_title:'数据分析师',mapped_status:'rejected',confidence:1}));
  assert.equal(r.state,'pending');assert.equal(JSON.parse(r.review.candidates_json).length,2);
});
it('P2: 低把握拒信待确认，总把握度是乘积；人工确认成功',()=>{
  const app=apps.createApplication({ownerId:owner,fields:{company_name:'唯一企业',job_title:'测试经理',applied_at:'2026-10-01T00:00:00Z'},sourceMethod:'manual',status:'applied'});
  const r=apps.processMailEvent(mailEvent({company_name:'唯一企业',job_title:'测试经理',mapped_status:'rejected',confidence:0.95})).review;
  assert.equal(JSON.parse(r.evidence_json).total_confidence,0.95*0.9);
  const result=reviews.resolveReview({ownerId:owner,reviewId:r.id,expectedVersion:r.version,action:'confirm',applicationId:app.id,expectedApplicationVersion:app.version});assert.equal(result.application.status,'rejected');
});
it('P2: 邮件推断投递日期有标记，撤回恢复浏览态；开关关闭则需确认',()=>{
  const app=apps.createApplication({ownerId:owner,fields:{company_name:'推断企业',job_title:'开发岗',site_key:'test',site_application_id:'phase2-infer'},sourceMethod:'plugin'});
  const e=mailEvent({site_key:'test',site_application_id:'phase2-infer',mapped_status:'interview',confidence:0.98,source_received_at:'2026-10-20T03:00:00.000Z'});
  const result=apps.processMailEvent(e);assert.equal(result.application.applied_at_precision,'inferred_before');assert.equal(result.application.applied_at,e.occurred_at);
  const history=db.one("SELECT id FROM application_history WHERE application_id=? AND from_status <> to_status ORDER BY rowid DESC LIMIT 1",[app.id]);
  reviews.undoAutomaticMail({ownerId:owner,applicationId:app.id,historyId:history.id,expectedVersion:result.application.version});
  assert.equal(db.getApplication(owner,app.id).has_applied,0);assert.equal(db.getApplication(owner,app.id).status,'pending');
  config.d12AllowMailInferredAppliedAt=false;
  try{assert.equal(apps.processMailEvent(mailEvent({site_key:'test',site_application_id:'phase2-infer',mapped_status:'interview',confidence:1})).state,'pending');}finally{config.d12AllowMailInferredAppliedAt=true;}
});
it('P2: 不回退状态、不覆盖终态、搜索相似度不混淆两条岗位',()=>{
  const app=apps.createApplication({ownerId:owner,fields:{company_name:'保护企业',job_title:'产品经理',site_key:'test',site_application_id:'phase2-protect',applied_at:'2026-10-01T00:00:00Z'},sourceMethod:'manual',status:'interview'});
  assert.equal(apps.processMailEvent(mailEvent({site_key:'test',site_application_id:'phase2-protect',mapped_status:'assessment',confidence:1})).review.reason_code,'STATUS_REGRESSION');
  db.markApplicationChanged(owner,app.id,null,'manual',{status:'offer'});
  assert.equal(apps.processMailEvent(mailEvent({site_key:'test',site_application_id:'phase2-protect',mapped_status:'rejected',confidence:1})).review.reason_code,'TERMINAL_LOCKED');
});

it('P3: 阶段锚点取原信或更晚面试时间；7/14/关闭与确认顺延',()=>{
  const app={status:'interview',has_applied:1,stage_received_at:'2026-10-12T01:00:00Z',stage_anchor_at:'2026-10-15T06:00:00Z'};
  assert.equal(stageFollowupState(app,7,new Date('2026-10-21T00:00:00Z')).due,false);
  assert.equal(stageFollowupState(app,7,new Date('2026-10-22T00:00:00Z')).due,true);
  assert.equal(stageFollowupState(app,14,new Date('2026-10-22T00:00:00Z')).due,false);
  assert.equal(stageFollowupState(app,0,new Date('2026-11-22T00:00:00Z')).due,false);
  assert.equal(stageFollowupState({...app,last_reviewed_at:'2026-10-22T00:00:00Z'},7,new Date('2026-10-28T00:00:00Z')).due,false);
  assert.equal(stageFollowupState({...app,last_reviewed_at:'2026-10-22T00:00:00Z'},7,new Date('2026-10-29T00:00:00Z')).due,true);
  assert.equal(stageFollowupState({...app,status:'offer'},7,new Date('2026-11-22T00:00:00Z')).due,false);
});
it('P3: D+7 08:00 实际生成阶段邮件，三链接、原信落款一致，每锚点只提醒一次',async()=>{
  const own='phase3-stage';db.run('INSERT INTO users (id,email_normalized,email_display,created_at) VALUES (?,?,?,?)',[own,'stage@tounar.local','stage@tounar.local',nowIso()]);
  const app=apps.createApplication({ownerId:own,fields:{company_name:'阶段企业',job_title:'测试岗',site_key:'test',site_application_id:'stage-id',applied_at:'2026-10-01T00:00:00Z',job_url:'https://example.com/jobs/stage',status_url:'https://example.com/application/stage'},sourceMethod:'manual',status:'applied'});
  const event=mailEvent({site_key:'test',site_application_id:'stage-id',mapped_status:'interview',confidence:1,subject_excerpt:'面试邀请',source_received_at:'2026-10-20T03:00:00.000Z'},own);
  const result=apps.processMailEvent(event);assert.equal(result.application.stage_anchor_at,event.occurred_at);
  apps.getPreferences(own);
  db.run("UPDATE notification_preferences SET review_threshold_days=30 WHERE owner_id=?",[own]);
  const now=new Date('2026-10-27T00:00:00Z');const before=reminders.buildReminderCandidates(own,now);assert.ok(before.b.find(x=>x.app.id===app.id)?.stage);
  const sent=await reminders.runReminderForOwner(own,now);assert.equal(sent.status,'sent');
  const record=fs.readdirSync(path.join(dir,'outbox')).map(f=>JSON.parse(fs.readFileSync(path.join(dir,'outbox',f)))).find(r=>r.kind==='reminder'&&r.metadata.owner_id===own);
  for(const text of [record.text,record.html]){assert.ok(text.includes('2026-10-20'));assert.ok(text.includes('/?app='+app.id));assert.ok(text.includes('/r/'));assert.ok(text.includes('https://example.com/application/stage'));}
  assert.ok(record.subject.includes('2026-10-20'));assert.ok(!record.subject.includes('2026-10-27'));
  assert.ok(!reminders.buildReminderCandidates(own,new Date('2026-11-03T00:00:00Z')).b.some(x=>x.app.id===app.id));
  assert.equal((await reminders.runReminderForOwner(own,now)).reused,true);
});
it('P3: 阶段推进使旧锚点作废，原信多条不按岗位吞掉',()=>{
  const own='phase3-stage';
  const app=db.one('SELECT * FROM applications WHERE owner_id=?',[own]);
  const e=mailEvent({site_key:'test',site_application_id:'stage-id',mapped_status:'rejected',confidence:1,source_received_at:'2026-10-22T03:00:00Z'},own);
  apps.processMailEvent(e);
  assert.ok(!reminders.buildReminderCandidates(own,new Date('2026-11-03T00:00:00Z')).b.some(x=>x.app.id===app.id));
  const cards=[{app,outbox:{summary:'面邀',source_received_at:'2026-10-20T18:00:00Z'},from_mail:true},{app,outbox:{summary:'拒信',source_received_at:'2026-10-22T03:00:00Z'},from_mail:true}];
  const text=reminders.reminderBatchText({a:cards,b:[],links:new Map(),asOf:new Date('2026-10-23T00:00:00Z'),digest:{due:false,items:[]}});
  assert.ok(text.includes('2026-10-21–2026-10-22'));assert.equal((text.match(/—— /g)||[]).length,2);
});
it('P0/P3: 旧库增量升级回填原信且保留业务数据，重开不重复迁移',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const file=path.join(dir,'legacy.sqlite');const legacy=new DatabaseSync(file);
  legacy.exec(fs.readFileSync(new URL('../../tests/fixtures/schema-v1.sql',import.meta.url),'utf8'));
  legacy.prepare("INSERT INTO users(id,email_normalized,email_display,created_at) VALUES ('legacy','legacy@local','legacy@local','2026-10-01')").run();
  legacy.prepare("INSERT INTO mail_connections(id,owner_id,email,mode,scan_since,consent_version,created_at,updated_at) VALUES ('legacy-conn','legacy','legacy@qq.com','headers_only','2026-10-01','test','2026-10-01','2026-10-01')").run();
  legacy.prepare("INSERT INTO mail_messages(id,owner_id,connection_id,mailbox,uidvalidity,uid,received_at,created_at) VALUES ('legacy-mail','legacy','legacy-conn','INBOX','42','7','2026-10-18T03:00:00Z','2026-10-20')").run();
  legacy.prepare("INSERT INTO events(id,owner_id,client_event_id,source_method,event_type,occurred_at,observed_at,received_at,schema_version,evidence_level,payload_hash,connection_id,mailbox,uidvalidity,uid) VALUES ('legacy-event','legacy','legacy-event','mail','mail_progress_detected','2026-10-18T03:00:00Z','2026-10-20','2026-10-20','C1','weak','hash','legacy-conn','INBOX','42','7')").run();
  legacy.prepare("INSERT INTO review_items(id,owner_id,kind,reason_code,summary,source_event_id,created_at) VALUES ('legacy-review','legacy','mail_progress','MAIL_MATCH_UNCONFIRMED','历史线索','legacy-event','2026-10-20')").run();legacy.close();
  for(let pass=0;pass<2;pass++){
    const upgraded=db.openDatabase(file);
    assert.equal(upgraded.prepare("SELECT source_mail_id FROM review_items WHERE id='legacy-review'").get().source_mail_id,'legacy-mail');
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM mail_messages').get().n,1);
    assert.ok(upgraded.prepare('PRAGMA table_info(notification_preferences)').all().some(x=>x.name==='stage_followup_days'));
    assert.equal(upgraded.prepare("SELECT COUNT(*) AS n FROM meta WHERE key='migration_phase2_followup'").get().n,1);upgraded.close();
  }
});
