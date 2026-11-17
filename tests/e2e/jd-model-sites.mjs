// Offline fixture audit: count which known job detail pages reach the model.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '../..');
const cases = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/sites/cases.json')));
const browser = await chromium.launch({headless:true,...(process.env.E2E_CHROME ? {executablePath:process.env.E2E_CHROME} : {})});
const results = [];
try {
  for (let offset=0; offset<cases.length; offset+=5) {
    const batch = await Promise.all(cases.slice(offset,offset+5).map(async item => {
      const context = await browser.newContext();
      try {
        const html=fs.readFileSync(path.join(root,'tests/fixtures/sites',item.file),'utf8');
        await context.route('**/*', route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html}));
        const page=await context.newPage();
        await page.addInitScript(()=>{window.modelCalls=0;window.chrome={runtime:{sendMessage(message,reply){
          if(message.type==='jd_model_config') return reply?.({ok:true,data:{enabled:true}});
          if(message.type==='jd_model_extract') {window.modelCalls++;return reply?.({ok:true,data:{job:null}});}
          reply?.({ok:true});
        },onMessage:{addListener(){}}}};});
        await page.goto(item.url);
        await page.addScriptTag({path:path.join(root,'extension/content/adapters.js')});
        await page.addScriptTag({path:path.join(root,'extension/content/tracker.js')});
        await page.waitForTimeout(2200);
        const state=await page.evaluate(()=>{
          const root=document.querySelector('[data-tounar-job-id], [class*="job-detail"], [class*="jobDetail"], [class*="position-detail"], main, [role="main"], article');
          const text=root?.innerText||'';
          return {calls:window.modelCalls,root:root?.tagName+' '+String(root?.className||'').slice(0,35),headings:[...(root?.querySelectorAll('h1,[class*="job-title"],[class*="jobTitle"],[class*="position-title"]')||[])].slice(0,3).map(x=>x.textContent.trim().slice(0,35)),length:text.length,duty:/岗位职责|工作职责|职位描述|岗位描述|工作内容|Responsibilities|Job Description/i.test(text),requirements:/任职要求|任职资格|职位要求|岗位要求|Qualifications|Requirements/i.test(text)};
        });
        return {site:item.site,file:item.file,...state};
      } finally {await context.close();}
    }));
    results.push(...batch);
  }
} finally {await browser.close();}
console.log(JSON.stringify({total:results.length,reached:results.filter(x=>x.calls>0).length,results},null,2));
