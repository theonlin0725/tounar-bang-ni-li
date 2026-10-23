import { DatabaseSync } from 'node:sqlite';
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
    db.close();
  }finally{await browser?.close();await server.stop();}
}
