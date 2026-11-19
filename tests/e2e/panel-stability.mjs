// Deterministic regression for panel-based model stability and same-URL races.
// No network, no paid model calls: the page provides a fake chrome.runtime.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from './browser.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const checks=[];let failed=0;
const check=(name,ok,detail='')=>{const pass=Boolean(ok);if(!pass)failed++;checks.push({name,ok:pass,detail});console.log(`${pass?'✔':'✖'} ${name}${detail?' — '+detail:''}`);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,{timeout=15000,interval=150,label='条件'}={}){const end=Date.now()+timeout;let last;while(Date.now()<end){last=await fn();if(last)return last;await sleep(interval);}throw new Error('等待超时：'+label+' '+(last?JSON.stringify(last):''));}
const resolved=await resolveChromiumExecutable();
const browser=await chromium.launch({executablePath:resolved.path,headless:true});
async function pageFor(url,html,{delayA=0}={}){
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 await context.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:html}));
 const page=await context.newPage();
 await page.addInitScript(({delayA})=>{
  window.__captured=[];window.__modelInputs=[];window.__titleCandidates=[];
  const mk=(title)=>({job_title:title,job_title_status:'confirmed',company_name:'测试公司',location:'北京',recruitment_batch:'2027 校招',jd_text:'岗位职责\n负责'+title+'的研发。\n\n任职要求\n本科以上。',jd_summary:'负责'+title+'的研发。',jd_status:'complete',field_sources:{job_title:'model_source_quote',jd_text:'model_source_quote'},field_confidence:{job_title:'high',company_name:'high',jd_text:'high'}});
  window.chrome={storage:{local:{get:async()=>({}),set:async()=>{},remove:async()=>{}}},runtime:{lastError:null,sendMessage(m,cb){
   if(m.type==='jd_model_config')return cb?.({ok:true,data:{enabled:true}});
   if(m.type==='jd_model_extract'){
    window.__modelInputs.push({href:location.href,text:m.text});window.__titleCandidates.push(m.title_candidates||[]);
    const title=/岗位B|职位B|角色B/.test(m.text)?'岗位B':/岗位A|职位A|角色A/.test(m.text)?'岗位A':'平台工程师';
    const reply=()=>cb?.({ok:true,data:{job:mk(title)}});
    if(delayA&&title==='岗位A')setTimeout(reply,delayA);else reply();
    return;
   }
   if(m.type==='enqueue_event'){window.__captured.push(m.event);cb?.({ok:true});return;}
   cb?.({ok:true});
  },onMessage:{addListener(){}}}};
 },{delayA});
 await page.goto(url);
 await page.addScriptTag({path:root+'/extension/content/adapters.js'});
 await page.addScriptTag({path:root+'/extension/content/tracker.js'});
 return {page,context};
}
try{
 // A ticking clock outside the job panel must not suppress automatic capture.
 {
  const html=`<header><span id="clock"></span></header><main><h1>平台工程师</h1><p>测试公司</p><h2>岗位职责</h2><p>负责平台设计。</p><h2>任职要求</h2><p>本科以上学历。</p><button>立即申请</button></main><script>setInterval(()=>document.getElementById('clock').textContent=Date.now(),100)</script>`;
  const {page,context}=await pageFor('https://example.com/job/clock',html);
  await waitFor(()=>page.evaluate(()=>window.__captured.some(e=>e.event_type==='job_viewed')),{timeout:12000,label:'时钟页面自动入账'});
  const state=await page.evaluate(()=>({models:window.__modelInputs.length,events:window.__captured.map(e=>({t:e.event_type,title:e.payload?.job_title}))}));
  const candidates=await page.evaluate(()=>window.__titleCandidates[0]||[]);
  check('全页时钟持续更新仍按岗位面板自动入账',state.models===1&&state.events.filter(e=>e.t==='job_viewed').length===1&&state.events.find(e=>e.t==='job_viewed')?.title==='平台工程师',JSON.stringify(state));
  check('模型输入带独立标题候选且不含工作地点标签',candidates.some(c=>c.text==='平台工程师')&&!candidates.some(c=>/工作地点/.test(c.text)),JSON.stringify(candidates));
  await context.close();
 }
 // A list rail and a recommendation rail beside the detail must not enter model input.
 {
  const html=`<header>招聘首页</header><div class="job-list"><a href="/job/2">推荐岗位B</a><a href="/job/3">另一个岗位C</a></div><main><section class="job-detail"><h1>岗位A</h1><p>测试公司</p><h2>岗位职责</h2><p>负责岗位A的研发。</p><h2>任职要求</h2><p>本科以上学历。</p><button>立即申请</button><aside class="recommend"><h2>推荐职位</h2><p>推荐岗位B</p></aside></section></main>`;
  const {page,context}=await pageFor('https://example.com/job/side-by-side',html);
  await waitFor(()=>page.evaluate(()=>window.__captured.some(e=>e.event_type==='job_viewed')),{timeout:12000,label:'并排详情自动入账'});
  const input=await page.evaluate(()=>window.__modelInputs[0]?.text||'');
  check('并排列表/详情只取当前岗位面板',input.includes('岗位A')&&!input.includes('推荐岗位B')&&!input.includes('另一个岗位C')&&input.includes('负责岗位A的研发。'),input.slice(0,300));
  await context.close();
 }
 // Same URL drawer switch: B must produce its own event, not reuse A.
 {
  const html=`<main><section class="job-detail"><h1 id="title">岗位A</h1><p>测试公司</p><h2>岗位职责</h2><p id="body">负责岗位A的研发。</p><h2>任职要求</h2><p>本科以上学历。</p><button>立即申请</button></section><button id="switch">切换岗位</button></main><script>document.getElementById('switch').onclick=()=>{document.getElementById('title').textContent='岗位B';document.getElementById('body').textContent='负责岗位B的研发。';}</script>`;
  const {page,context}=await pageFor('https://example.com/job/drawer',html);
  await waitFor(()=>page.evaluate(()=>window.__captured.some(e=>e.event_type==='job_viewed'&&e.payload?.job_title==='岗位A')),{timeout:12000,label:'抽屉岗位A'});
  await page.click('#switch');
  await waitFor(()=>page.evaluate(()=>window.__captured.some(e=>e.event_type==='job_viewed'&&e.payload?.job_title==='岗位B')),{timeout:14000,label:'抽屉岗位B'});
  const titles=await page.evaluate(()=>window.__captured.filter(e=>e.event_type==='job_viewed').map(e=>e.payload?.job_title));
  check('同URL抽屉切岗产生B且不串A',titles.includes('岗位A')&&titles.includes('岗位B'),JSON.stringify(titles));
  await context.close();
 }
 // A model response arrives after switching to B: A must be dropped, B must be captured.
 {
  const html=`<main><section class="job-detail"><h1 id="title">岗位A</h1><p>测试公司</p><h2>岗位职责</h2><p id="body">负责岗位A的研发。</p><h2>任职要求</h2><p>本科以上学历。</p><button>立即申请</button></section><button id="switch">切换岗位</button></main><script>document.getElementById('switch').onclick=()=>{document.getElementById('title').textContent='岗位B';document.getElementById('body').textContent='负责岗位B的研发。';}</script>`;
  const {page,context}=await pageFor('https://example.com/job/race',html,{delayA:2200});
  await page.waitForTimeout(400);
  await page.click('#switch');
  await waitFor(()=>page.evaluate(()=>window.__captured.some(e=>e.event_type==='job_viewed'&&e.payload?.job_title==='岗位B')),{timeout:16000,label:'切岗后B入账'});
  await page.waitForTimeout(1200);
  const titles=await page.evaluate(()=>window.__captured.filter(e=>e.event_type==='job_viewed').map(e=>e.payload?.job_title));
  check('A模型未返回即切B：A不写B且B不漏记',!titles.includes('岗位A')&&titles.includes('岗位B'),JSON.stringify(titles));
  await context.close();
 }

 // A list URL with a drawer: closed => zero model/zero events; open => only
 // the current drawer; close => stop.
 {
  const html=`<main><section id="list"><a href="/job/2">列表岗位B</a><a href="/job/3">列表岗位C</a></section><div class="job-detail" id="drawer" style="display:none"><h1>岗位A</h1><p>测试公司</p><h2>岗位职责</h2><p>负责岗位A的研发。</p><h2>任职要求</h2><p>本科以上学历。</p><button>立即申请</button><aside class="recommend"><p>推荐岗位B</p></aside></div><button id="open">打开详情</button><script>document.getElementById('open').onclick=()=>{document.getElementById('drawer').style.display='block';}</script></main>`;
  const {page,context}=await pageFor('https://example.com/jobs',html);
  await page.waitForTimeout(3500);
  const closed=await page.evaluate(()=>({models:window.__modelInputs.length,events:window.__captured.length}));
  await page.click('#open');
  await waitFor(()=>page.evaluate(()=>window.__captured.some(e=>e.event_type==='job_viewed'&&e.payload?.job_title==='岗位A')),{timeout:14000,label:'列表URL打开抽屉'});
  const opened=await page.evaluate(()=>({models:window.__modelInputs.length,events:window.__captured.length,text:window.__modelInputs[0]?.text||''}));
  check('列表URL关闭时零请求，打开抽屉后只采当前岗位',closed.models===0&&closed.events===0&&opened.models===1&&opened.events===1&&opened.text.includes('岗位A')&&!opened.text.includes('推荐岗位B'),JSON.stringify({closed,models:opened.models,events:opened.events}));
  await page.evaluate(()=>{document.getElementById('drawer').style.display='none'});
  await page.waitForTimeout(1500);
  check('关闭抽屉后停止新增浏览入账',(await page.evaluate(()=>window.__captured.filter(e=>e.event_type==='job_viewed').length))===1);
  await context.close();
 }

 // A list page is not a job and must never reach the model.
 {
  const html=`<main><a href="/job/1">岗位一</a><a href="/job/2">岗位二</a></main>`;
  const {page,context}=await pageFor('https://example.com/jobs',html);
  await page.waitForTimeout(5000);
  const state=await page.evaluate(()=>({models:window.__modelInputs.length,events:window.__captured.length}));
  check('列表页零模型请求零入账',state.models===0&&state.events===0,JSON.stringify(state));
  await context.close();
 }
}finally{await browser.close();}
console.log(JSON.stringify({passed:checks.filter(c=>c.ok).length,total:checks.length,failed}));
if(failed)process.exitCode=1;
