import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { startTestServer } from '../../server/test/helpers.js';
import { resolveChromiumExecutable } from './browser.mjs';
import { chromium } from 'playwright';
export async function phase2Web(check) {
  const server=await startTestServer({name:'phase2-web'});
  let browser;
  try{
    const login=await server.login('demo@tounar.local'), cookie=login.cookie;
    const app=(await server.request('/api/v1/applications/manual',{method:'POST',cookie,headers:{'Idempotency-Key':'phase2-app'},body:{company_name:'二期测试公司',job_title:'产品经理',has_applied:true,status:'applied',applied_at:'2026-10-01T02:00:00Z',jd_summary:'产品设计',job_url:'https://example.com/jobs/p2'}})).json.data;
    const db=new DatabaseSync(server.dir+'/tounar.sqlite');const owner=db.prepare('SELECT owner_id FROM applications WHERE id=?').get(app.id).owner_id;
    const add=(id,candidates=[])=>db.prepare(`INSERT INTO review_items (id,owner_id,kind,reason_code,summary,evidence_json,suggested_changes_json,candidates_json,created_at) VALUES (?,?,'mail_progress','MAIL_MATCH_UNCONFIRMED','二期邮件进展',?,?,?,?)`).run(id,owner,JSON.stringify({confidence:0.85,subject_excerpt:'测试面邀',from_domain:'example.com'}),JSON.stringify({status:'interview'}),JSON.stringify(candidates),new Date().toISOString());
    add('p2-no-candidate');
    const resolved=await resolveChromiumExecutable();browser=await chromium.launch({executablePath:resolved.path,headless:true});
    const context=await browser.newContext({baseURL:server.base});const page=await context.newPage();
    await page.goto('/?panel=reviews');await page.fill('[data-test=login-email]','demo@tounar.local');await page.click('[data-test=login-send]');await page.waitForSelector('[data-test=login-code]',{state:'visible'});await page.fill('[data-test=login-code]',await server.readOtpCode('demo@tounar.local'));await page.click('[data-test=login-submit]');await page.waitForSelector('[data-test=reviews-view]');
    check('P1-登录后保留待确认深链',true);
    const card=page.locator('[data-review-id=p2-no-candidate]');await card.locator('[data-test=review-confirm]').click();
    check('P1-无候选时确认按钮可用并展开搜索',await card.locator('[data-test=review-search]').isVisible());
    await card.locator('[data-test=review-search]').fill('二期测试');await card.locator(`[data-test=review-target] option[value="${app.id}"]`).waitFor({state:'attached'});await card.locator('[data-test=review-target]').selectOption(app.id);
    await page.waitForFunction(()=>document.querySelector('[data-test=review-switch-at]')?.parentElement.hidden);
    await card.locator('[data-test=review-switch-status]').click();await card.waitFor({state:'detached'});
    check('P1-搜索关联本人台账，已有时间无需重复填写',db.prepare('SELECT status FROM applications WHERE id=?').get(app.id).status==='interview');
    await page.locator('[data-test=review-undo]').first().click();await card.waitFor();
    check('P1-10秒内撤销恢复台账并重开待确认',db.prepare('SELECT status FROM applications WHERE id=?').get(app.id).status==='applied');
    await card.locator('[data-test=review-dismiss]').click();await page.click('[data-test=confirm-ok]');await card.waitFor({state:'detached'});
    add('p2-batch',[{application_id:app.id,company_name:'二期测试公司',job_title:'产品经理'}]);await page.click('[data-test=reviews-refresh]');await page.locator('[data-review-id=p2-batch]').waitFor();await page.click('[data-test=reviews-batch]');await page.click('[data-test=confirm-ok]');await page.locator('[data-review-id=p2-batch]').waitFor({state:'detached'});
    check('P1-批量确认逐条提交并更新台账',db.prepare('SELECT status FROM applications WHERE id=?').get(app.id).status==='interview');
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
    check('P2-详情撤回邮件自动判断并留历史',db.prepare('SELECT status FROM applications WHERE id=?').get(app.id).status==='interview');
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
