import {classifyField,validField} from './acceptance-fields.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function tencentLiveAcceptance({context,web,popup,events,receipts,ledger,detail,wait,check,rows,out,report}) {
  const truth=JSON.parse(fs.readFileSync(new URL('../fixtures/live/tencent-20261025.json',import.meta.url)));
  const list=await context.newPage();await list.goto(truth.list_url,{waitUntil:'domcontentloaded'});await list.locator('.recruit-list').first().waitFor();
  const actualCards=await list.locator('.recruit-list').evaluateAll(nodes=>nodes.map(n=>({job_title:n.querySelector('.job-recruit-title').innerText.trim(),location:n.querySelector('.job-recruit-location').innerText.trim()})));
  assert.deepEqual(actualCards,truth.list.map(({job_title,location})=>({job_title,location})),'实时列表已变化，需要人工复核冻结真值；禁止自动改 expected');
  report.truth_sampled_at=truth.sampled_at;report.metrics.detail_denominator=3;
  const capturedIds=new Map();
  async function verify(expected,pageType,started) {
    const type=pageType==='list'?'job_discovered':'job_viewed';
    const event=await wait(()=>events.findLast(e=>e.event_type===type&&e.payload.site_job_id===expected.site_job_id),expected.job_title+' 上传',20000);
    const result=await wait(()=>receipts.get(event.client_event_id),'服务端回执');
    const row={site:'tencent',url:expected.job_url,page_type:pageType,expected,actual:event.payload,field_result:{},extraction_source:event.payload.field_sources,template_version:event.payload.template_version||null,client_event_id:event.client_event_id,processing_state:result.processing_state,application_id:result.application_id,frontend_visible:false,duplicate_count:null,timings:{to_receipt_ms:Date.now()-started},error:null,evidence_path:null};rows.push(row);
    try{
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
  await check('腾讯用户链接：当前已加载 10 条列表自动入账',async()=>{for(const expected of truth.list)await verify(expected,'list',started);});
  await popup.close();
  for(let i=0;i<truth.details.length;i++)await check(`腾讯真实点击详情 ${i+1}：补全同一条记录及完整 JD`,async()=>{
    await list.bringToFront();const t=Date.now();const pagePromise=context.waitForEvent('page');await list.locator('.recruit-list-link').nth(i).click();const page=await pagePromise;
    await page.waitForLoadState('domcontentloaded');await page.bringToFront();await verify(truth.details[i],'detail',t);await page.close();
  });
  await check('腾讯重复打开列表，不重复入账、不计已投递',async()=>{await list.bringToFront();await list.reload();await new Promise(r=>setTimeout(r,4500));const data=await ledger();assert.equal(data.items.length,10);assert.equal(data.stats.total_applied,0);});
  await list.close();
}
