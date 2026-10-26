import {classifyField,validField} from './acceptance-fields.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadLiveTruth } from './live-truth.mjs';

export async function currentSiteAcceptance({site,context,web,popup,events,receipts,ledger,detail,wait,check,rows,out,report}) {
  const truth=loadLiveTruth(site);
  const list=await context.newPage();await list.goto(truth.list_url,{waitUntil:'domcontentloaded'});await list.locator(truth.click_selector).first().waitFor();
  const dismiss=async()=>{if(truth.dismiss_selector&&await list.locator(truth.dismiss_selector).isVisible())await list.locator(truth.dismiss_selector).click();};
  await dismiss();
  const visibleCards=await list.locator(truth.click_selector).allTextContents();
  for(const expected of truth.details) assert.ok(visibleCards.some(t=>t.includes(expected.job_title)),`${site}: 当前列表已变化，需要复核冻结真值 ${expected.job_title}`);
  report.truth_sampled_at=truth.sampled_at;report.metrics.detail_denominator=truth.details.length;report.metrics.list_denominator=truth.list.length;
  const capturedIds=new Map();
  async function verify(expected,pageType,started) {
    const type=pageType==='list'?'job_discovered':'job_viewed';
    const row={site,url:expected.job_url,page_type:pageType,expected,actual:null,field_result:{},extraction_source:null,template_version:null,client_event_id:null,processing_state:null,application_id:null,frontend_visible:false,duplicate_count:null,timings:{},error:null,evidence_path:null};rows.push(row);
    try{
      const event=await wait(()=>events.findLast(e=>e.event_type===type&&e.payload.site_job_id===expected.site_job_id),expected.job_title+' 上传',20000);
      const result=await wait(()=>receipts.get(event.client_event_id),'服务端回执');
      Object.assign(row,{actual:event.payload,extraction_source:event.payload.field_sources,template_version:event.payload.template_version||null,client_event_id:event.client_event_id,processing_state:result.processing_state,application_id:result.application_id,timings:{to_receipt_ms:Date.now()-started}});
      assert.ok(result.application_id,JSON.stringify(result));const app=await detail(result.application_id);
      for(const field of ['company_name','job_title','location','recruitment_batch','job_url',...(pageType==='detail'?['jd_text']:[])]){row.field_result[field]=classifyField(expected[field],app[field]||'');assert.equal(app[field]||'',expected[field],field);}
      assert.equal(app.status,'pending');assert.equal(app.has_applied,0);assert.equal(app.capture_source,'list');
      if(pageType==='list'){assert.equal(app.first_viewed_at,null);assert.equal(app.jd_status,'missing');capturedIds.set(expected.site_job_id,app.id);}
      else assert.equal(app.id,capturedIds.get(expected.site_job_id),'详情必须补全原列表记录');
      await web.bringToFront();const rowEl=web.locator(`[data-app-id="${app.id}"]`);await rowEl.waitFor({timeout:7000});row.frontend_visible=true;row.timings.to_frontend_ms=Date.now()-started;
      if(pageType==='detail'){await rowEl.click();await web.locator('[data-test=detail-jd-text]').waitFor();assert.equal(await web.locator('[data-test=detail-jd-text]').textContent(),expected.jd_text);}
      row.duplicate_count=(await ledger()).items.filter(a=>a.job_url===expected.job_url).length;assert.equal(row.duplicate_count,1);
      row.evidence_path=path.join(out,`${expected.site_job_id}-${pageType}.png`);await web.screenshot({path:row.evidence_path});
      if(pageType==='detail')await web.getByRole('button',{name:'关闭',exact:true}).click();
    } catch(e){row.error=e.message;throw e;}
  }
  await list.bringToFront();const started=Date.now();await popup.click('#grant-current');
  await check(`${site}：当前已加载 ${truth.list.length} 条列表自动入账`,async()=>{for(const expected of truth.list)await verify(expected,'list',started);});
  await popup.close();
  for(let i=0;i<truth.details.length;i++)await check(`${site} 真实点击详情 ${i+1}：补全同一条记录及完整 JD`,async()=>{
    // Reuse the still-open list when the site opens details in new tabs. This
    // also avoids reloading unrelated advertisement requests between clicks.
    if(list.url()!==truth.list_url) await list.goto(truth.list_url,{waitUntil:'domcontentloaded'});
    await list.locator(truth.click_selector).first().waitFor();await list.bringToFront();
    await dismiss();
    const t=Date.now(),before=new Set(context.pages());
    await list.locator(truth.click_selector).filter({hasText:truth.details[i].job_title}).first().click();
    await wait(()=>context.pages().some(p=>!before.has(p))||list.url()!==truth.list_url,'详情真实点击');
    const page=context.pages().find(p=>!before.has(p))||list;
    await page.waitForLoadState('domcontentloaded');await page.bringToFront();await verify(truth.details[i],'detail',t);if(page!==list)await page.close();
  });
  await check(`${site} 重复打开列表，不重复入账、不计已投递`,async()=>{await list.bringToFront();await list.goto(truth.list_url);await new Promise(r=>setTimeout(r,4500));const data=await ledger();assert.equal(data.items.length,truth.list.length);assert.equal(data.stats.total_applied,0);});
  await list.close();
}
