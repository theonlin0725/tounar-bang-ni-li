import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { startTestServer, strongViewEvent } from '../../server/test/helpers.js';
import { resolveChromiumExecutable } from './browser.mjs';
import { chromium } from 'playwright';
export async function phase2Web(check) {
  const server=await startTestServer({name:'phase2-web'});
  let browser;
  try{
    const login=await server.login('demo@tounar.local'), cookie=login.cookie;
    const app=(await server.request('/api/v1/applications/manual',{method:'POST',cookie,headers:{'Idempotency-Key':'phase2-app'},body:{company_name:'二期测试公司',job_title:'产品经理',has_applied:true,status:'applied',applied_at:'2026-10-01T02:00:00Z',jd_summary:'产品设计',job_url:'https://example.com/jobs/p2'}})).json.data;
    const app2=(await server.request('/api/v1/applications/manual',{method:'POST',cookie,headers:{'Idempotency-Key':'phase2-app2'},body:{company_name:'二期手工公司',job_title:'手工前的岗位',has_applied:true,status:'applied',applied_at:'2026-10-02T02:00:00Z',jd_summary:'手工修改测试',job_url:'https://example.com/jobs/p2b'}})).json.data;
    const db=new DatabaseSync(server.dir+'/tounar.sqlite');const owner=db.prepare('SELECT owner_id FROM applications WHERE id=?').get(app.id).owner_id;
    const resolved=await resolveChromiumExecutable();browser=await chromium.launch({executablePath:resolved.path,headless:true});
    const context=await browser.newContext({baseURL:server.base});const page=await context.newPage();
    await page.goto('/?panel=reviews');await page.fill('[data-test=login-email]','demo@tounar.local');await page.click('[data-test=login-send]');await page.waitForSelector('[data-test=login-code]',{state:'visible'});await page.fill('[data-test=login-code]',await server.readOtpCode('demo@tounar.local'));await page.click('[data-test=login-submit]');await page.waitForSelector('[data-test=reviews-view]');
    check('P1-登录后保留待确认深链',true);
    const reviewDevice=await server.pairDevice(cookie,'phase2-review');
    const reviewEvent=strongViewEvent({event_type:'job_viewed',evidence_level:'weak',payload:{
      company_name:'二期测试公司',job_title:'产品经理',site_job_id:null,job_url:null,
      jd_summary:'负责二期产品设计与用户研究。',location:'上海',visible_dwell_ms:4200
    }});
    const createdReview=(await server.eventBatch(reviewDevice.device_token,[reviewEvent])).json.results[0];
    await page.click('[data-test=reviews-refresh]');
    const card=page.locator(`[data-review-id="${createdReview.review_item_id}"]`);await card.waitFor();
    check('P1-待确认卡片直接显示来源/标题/正文，无需先选台账',
      (await card.locator('[data-test=review-source]').textContent()).includes('插件')
      && (await card.locator('[data-test=review-title]').textContent()).includes('产品经理')
      && (await card.locator('[data-test=review-preview]').textContent()).includes('用户研究'));
    await card.locator('[data-test=review-confirm]').click();
    await page.waitForSelector(`[data-review-id="${createdReview.review_item_id}"] [data-test=review-manual]`);
    await card.locator('[data-test=review-manual]').click();
    await page.waitForSelector('[data-test=intake-modal]');
    await page.selectOption('[data-test=intake-status]', 'applied');
    await page.fill('[data-test=intake-applied-at]', '2026-10-01');
    await page.click('[data-test=intake-save]');
    await card.waitFor({state:'detached'});
    const createdApp=db.prepare("SELECT * FROM applications WHERE owner_id=? AND job_title='产品经理' ORDER BY created_at DESC LIMIT 1").get(owner);
    check('P1-无候选时选择状态直接创建并写入实际投递时间',
      createdApp?.status==='applied' && createdApp.has_applied===1 && String(createdApp.applied_at).startsWith('2026-10-01'),
      `status=${createdApp?.status} applied_at=${createdApp?.applied_at}`);
    await page.locator('[data-test=review-undo]').first().click();
    await card.waitFor();
    check('P1-10秒内撤销恢复台账并重开待确认',
      db.prepare('SELECT archived_at FROM applications WHERE id=?').get(createdApp.id).archived_at !== null
      && db.prepare('SELECT status FROM review_items WHERE id=?').get(createdReview.review_item_id).status === 'open');
    await card.locator('[data-test=review-dismiss]').click();await card.waitFor({state:'detached'});

    // 缺公司/岗位时：失败不丢待确认，内联补充后直接入账
    const missingEvent=strongViewEvent({event_type:'job_viewed',evidence_level:'weak',payload:{
      company_name:null,job_title:null,site_job_id:null,job_url:null,
      jd_summary:'这条页面只有正文，公司和岗位缺失。',visible_dwell_ms:4200
    }});
    const missingReview=(await server.eventBatch(reviewDevice.device_token,[missingEvent])).json.results[0];
    await page.click('[data-test=reviews-refresh]');
    const manual=page.locator(`[data-review-id="${missingReview.review_item_id}"]`);await manual.waitFor();
    await manual.locator('[data-test=review-confirm]').click();
    await page.waitForSelector(`[data-review-id="${missingReview.review_item_id}"] [data-test=review-manual]`);
    await manual.locator('[data-test=review-manual]').click();
    await page.waitForSelector('[data-test=intake-modal]');
    await page.click('[data-test=intake-cancel]');
    await page.waitForSelector('[data-test=intake-modal]',{state:'detached'});
    const cancelReviewState = db.prepare('SELECT status FROM review_items WHERE id=?').get(missingReview.review_item_id);
    const cancelApp = db.prepare("SELECT id FROM applications WHERE owner_id=? AND job_title='手工补出的岗位'").get(owner);
    check('P1-取消补录保持待确认，不创建空白台账',
      cancelReviewState?.status==='open' && !cancelApp,
      JSON.stringify({review:cancelReviewState?.status, app:cancelApp?.id || null, review_id:missingReview.review_item_id}));
    await manual.locator('[data-test=review-confirm]').click();
    await page.waitForSelector(`[data-review-id="${missingReview.review_item_id}"] [data-test=review-manual]`);
    await manual.locator('[data-test=review-manual]').click();
    await page.waitForSelector('[data-test=intake-modal]');
    await page.fill('[data-test=intake-company]','二期手工公司');
    await page.fill('[data-test=intake-title]','手工补出的岗位');
    await page.selectOption('[data-test=intake-status]','pending');
    await page.click('[data-test=intake-save]');
    await manual.waitFor({state:'detached'});
    const manualApp=db.prepare("SELECT * FROM applications WHERE owner_id=? AND job_title='手工补出的岗位' ORDER BY created_at DESC LIMIT 1").get(owner);
    check('P1-补录公司和岗位后入账，原线索保留',
      manualApp?.status==='pending' && manualApp?.company_name==='二期手工公司' && manualApp?.latest_event_id,
      `app=${manualApp?.id} status=${manualApp?.status}`);
    // 归档掉辅助记录，后面的台账计数/行数断言仍按单条记录算
    db.prepare('UPDATE applications SET archived_at=? WHERE id=?').run(new Date().toISOString(),app2.id);
    await page.goto('/?app='+app.id);await page.waitForSelector('[data-test=detail-company]');
    check('P0-台账详情深链',await page.locator('[data-test=detail-company]').textContent()==='二期测试公司');
    await page.goto('/'); await page.waitForSelector('[data-test=ledger-row]');
    execFileSync(process.execPath,['--input-type=module','-e',`
      const {run,closeDb}=await import('./server/src/db.js');
      const {processMailEvent}=await import('./server/src/domain/applications.js');
      const id='p2-auto-mail',owner=${JSON.stringify(owner)},at=new Date().toISOString();
      const payload={company_name:'二期测试公司',job_title:'产品经理',mapped_status:'rejected',confidence:1,subject_excerpt:'招聘结果通知',source_received_at:at};
      run("INSERT INTO events (id,owner_id,client_event_id,source_method,event_type,occurred_at,observed_at,received_at,schema_version,evidence_level,payload_hash,payload_json) VALUES (?,?,?,'mail','mail_progress_detected',?,?,?,'C1','strong','test',?)",[id,owner,id,at,at,at,JSON.stringify(payload)]);
      const result=processMailEvent({id,owner_id:owner,source_method:'mail',occurred_at:at,payload});
      if(result.state!=='applied') throw Error('auto update did not apply');closeDb();
    `],{cwd:process.cwd(),env:{...process.env,DATA_DIR:server.dir}});
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForSelector('[data-test=mail-update-banner]');
    check('P2-重新获焦检查修订，邮件更新提示并高亮行',await page.locator('.tn-row-updated').count()===1&&await page.locator('[data-test=mail-update-banner]').textContent()==='刚刚根据邮件更新了 1 条记录');
    await page.locator('[data-test=ledger-row]').click();await page.locator('[data-test=undo-mail]').first().click();await page.click('[data-test=confirm-ok]');
    await page.waitForFunction(()=>[...document.querySelectorAll('.tn-toast')].some(x=>x.textContent.includes('已撤回邮件自动更新')));
    check('P2-详情撤回邮件自动判断并留历史',db.prepare('SELECT status FROM applications WHERE id=?').get(app.id).status==='applied');
    await page.click('[data-test=detail-drawer] .tn-drawer-close');
    await page.click('[data-test=open-settings-reminder]');
    await page.waitForSelector('[data-test=pref-stage-followup]');
    check('P3-阶段回看默认7天，与旧阈值分开展示',await page.locator('[data-test=pref-stage-followup]').inputValue()==='7');
    await page.selectOption('[data-test=pref-stage-followup]','14');await page.click('[data-test=pref-save]');
    await page.waitForFunction(()=>document.querySelector('[data-test=pref-stage-followup]')?.value==='14'&&[...document.querySelectorAll('.tn-toast')].some(x=>x.textContent.includes('提醒设置已保存')));
    check('P3-14天设置实际保存',db.prepare('SELECT stage_followup_days FROM notification_preferences WHERE owner_id=?').get(owner).stage_followup_days===14);
    db.close();
  }finally{await browser?.close();await server.stop();}
}
