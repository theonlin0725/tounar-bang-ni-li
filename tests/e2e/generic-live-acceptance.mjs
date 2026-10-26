import {classifyField,validField} from './acceptance-fields.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadLiveTruth} from './live-truth.mjs';

export async function genericLiveAcceptance({site,context,web,popup,events,receipts,ledger,detail,wait,check,rows,out,report}) {
  const truth=loadLiveTruth(site);
  report.truth_sampled_at=truth.sampled_at;
  report.metrics.detail_denominator=truth.details.length;
  report.metrics.list_denominator=0;
  const page=await context.newPage();
  for(const expected of truth.details) await check(`${site} 通用识别：原页到未投递详情逐字段核对`,async()=>{
    const started=Date.now();
    await page.goto(expected.job_url);await page.bringToFront();
    report.page_metadata=await page.evaluate(()=>({title:document.title,headings:[...document.querySelectorAll('h1,h2')].map(n=>n.innerText)}));
    await popup.click('#grant-current');
    const row={site,url:expected.job_url,page_type:'detail',expected,actual:null,field_result:{},extraction_source:null,template_version:null,client_event_id:null,processing_state:null,application_id:null,frontend_visible:false,duplicate_count:null,timings:{},error:null,evidence_path:null};rows.push(row);
    try {
      const event=await wait(()=>events.findLast(e=>e.payload.site_job_id===expected.site_job_id),'通用岗位上传',20000);
      const receipt=await wait(()=>receipts.get(event.client_event_id),'通用岗位回执');
      Object.assign(row,{actual:event.payload,extraction_source:event.payload.field_sources,template_version:event.payload.template_version||null,client_event_id:event.client_event_id,processing_state:receipt.processing_state,application_id:receipt.application_id});
      assert.ok(!['verified_site_selector','verified_refine','adapter_company'].some(source=>Object.values(row.extraction_source).includes(source)),'通用样本不得依赖专用适配器');
      assert.ok(receipt.application_id,JSON.stringify(receipt));
      const app=await detail(receipt.application_id);
      for(const field of ['company_name','job_title','location','recruitment_batch','job_url','jd_text']) {
        row.field_result[field]=classifyField(expected[field],app[field]||'');
        assert.equal(app[field]||'',expected[field],field);
      }
      assert.equal(app.status,'pending');assert.equal(app.has_applied,0);
      await web.bringToFront();const el=web.locator(`[data-app-id="${app.id}"]`);await el.waitFor({timeout:7000});row.frontend_visible=true;
      await el.click();await web.locator('[data-test=detail-jd-text]').waitFor();assert.equal(await web.locator('[data-test=detail-jd-text]').textContent(),expected.jd_text);
      row.evidence_path=path.join(out,`${expected.site_job_id}-detail.png`);await web.screenshot({path:row.evidence_path});await web.getByRole('button',{name:'关闭',exact:true}).click();
      await page.bringToFront();await page.reload({waitUntil:'domcontentloaded'});await new Promise(r=>setTimeout(r,5000));
      row.duplicate_count=(await ledger()).items.filter(a=>a.job_url===expected.job_url).length;assert.equal(row.duplicate_count,1);
      row.timings.to_verified_ms=Date.now()-started;
    } catch(error) {row.error=error.message;throw error;}
  });
  await page.close();await popup.close();
}
