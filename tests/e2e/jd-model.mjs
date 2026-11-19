import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {chromium} from 'playwright';
import {startTestServer,strongViewEvent} from '../../server/test/helpers.js';
const checks=[];const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
let calls=0;
const fake=http.createServer(async(req,res)=>{
 let body='';for await(const c of req)body+=c;
 const user=JSON.parse(JSON.parse(body).messages[1].content);const paragraphs=user.paragraphs;const candidates=user.title_candidates||[];
 const find=text=>paragraphs.find(p=>p.text===text)?.line;
 const evidence=text=>candidates.find(c=>c.text===text)?.id||null;
 if (find('校园AI产品经理') !== undefined || find('校园数据产品经理') !== undefined) {
  calls++;
  if (find('校园数据产品经理') !== undefined) { res.writeHead(503);res.end();return; }
  const raw={is_job:true,job_title:'校园AI产品经理',job_title_evidence:evidence('校园AI产品经理'),company_name:'腾讯',sections:{团队介绍:[],岗位职责:[{line:find('负责定义和验证产品需求。')}],任职要求:[{line:find('能够阅读技术文档并清晰沟通。')}],其他信息:[]}};
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({model:'fixture',choices:[{finish_reason:'stop',message:{content:JSON.stringify(raw)}}]}));
  return;
 }
 if (find('1、设计平台。')===undefined) console.log('Fixture paragraphs:',JSON.stringify(paragraphs));
 const raw={is_job:true,job_title:'平台工程师',job_title_evidence:evidence('平台工程师'),company_name:'测试公司',location:'北京',recruitment_batch:null,sections:{团队介绍:[],岗位职责:[{line:find('1、设计平台。')},{line:find('2、维护服务。')}],任职要求:[{line:find('1、本科以上学历。')}],其他信息:[]}};
 calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'fixture',usage:{prompt_tokens:100,completion_tokens:50},choices:[{finish_reason:'stop',message:{content:JSON.stringify(raw)}}]}));
});
await new Promise(r=>fake.listen(0,'127.0.0.1',r));
let server,browser,extensionContext;
try{
 server=await startTestServer({name:'jd-model-'+Date.now(),env:{JD_AI_ENABLED:'true',JD_AI_API_KEY:'fixture-only',JD_AI_API_URL:`http://127.0.0.1:${fake.address().port}`,JD_AI_MODEL:'fixture'}});
 const cookie=(await server.login('demo@tounar.local')).cookie;
 const device=await server.pairDevice(cookie);
 const text='测试公司\n平台工程师\n北京\n1、设计平台。\n2、维护服务。\n1、本科以上学历。';
 const input={url:'https://example.com/job/1',text};
 check('unauthenticated extraction denied',(await server.request('/api/v1/plugin-jd/extract',{method:'POST',body:input})).status===401);
 const extraction=await server.request('/api/v1/plugin-jd/extract',{method:'POST',token:device.device_token,body:input});
 check('authenticated model extraction succeeds',extraction.status===200);
 const job=extraction.json.data.job;
 const batch=await server.eventBatch(device.device_token,[strongViewEvent({payload:{...job,visible_dwell_ms:4000}})]);
 const id=batch.json.results[0].application_id;check('model job enters existing ledger',!!id);
 const detail=await server.request(`/api/v1/applications/${id}`,{cookie});
 const oldVersion=detail.json.data.version;
 const result=await server.request(`/api/v1/applications/${id}/organize-jd`,{cookie,method:'POST',body:{expected_version:oldVersion}});
 check('saved record can be organized',result.status===200);
 const after=(await server.request(`/api/v1/applications/${id}`,{cookie})).json.data;
 check('status and application facts unchanged',after.status===detail.json.data.status&&after.has_applied===detail.json.data.has_applied);
 const count=calls;
 check('stale version rejected before model',(await server.request(`/api/v1/applications/${id}/organize-jd`,{cookie,method:'POST',body:{expected_version:oldVersion}})).status===409&&calls===count);
 const peer=(await server.login('peer@tounar.local')).cookie;
 check('other owner cannot organize record',(await server.request(`/api/v1/applications/${id}/organize-jd`,{cookie:peer,method:'POST',body:{expected_version:after.version}})).status===404);
 browser=await chromium.launch({executablePath:process.env.E2E_CHROME,headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1100}});
 const [name,...val]=cookie.split(';')[0].split('=');await context.addCookies([{name,value:val.join('='),url:server.base}]);
 await context.addInitScript(()=>sessionStorage.setItem('tounar.plugin.onboarding.demo@tounar.local','connection'));
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.base+'/?app='+id);await page.locator('[data-test=detail-drawer]').waitFor();
 check('numbered duties and requirements render as individual list items',await page.locator('.tn-jd-items li').count()===3);
 check('internal fields and duplicate JD labels hidden',!await page.getByText('字段来源明细',{exact:false}).count()&&!await page.getByRole('heading',{name:'JD 摘要',exact:true}).count()&&!(await page.locator('[data-test=detail-history]').innerText()).includes('owner_id'));
 await page.screenshot({path:'.tmp/jd-detail-preview.png',fullPage:true});
 check('detail page has no script errors',errors.length===0);
 const capture=await browser.newPage();
 await capture.route('https://example.com/**',r=>{
  const url=new URL(r.request().url());
  const path=url.pathname;
  const detail='<title>平台工程师 - 测试公司</title><main><h1>平台工程师</h1><p>测试公司</p><p>北京</p><h2>岗位职责</h2><p>1、设计平台。</p><p>2、维护服务。</p><h2>任职要求</h2><p>1、本科以上学历。</p><form><input value="private-secret"></form></main>';
  const page=path==='/profile'?'<title>个人资料</title><main><h1>平台工程师</h1><p>岗位职责</p><p>我的私人履历</p><p>任职要求</p></main>'
   :path==='/job/expired'?'<title>职位已过期 - 测试公司</title><main><h1>平台工程师</h1><h2>岗位职责</h2><p>设计平台。</p><h2>任职要求</h2><p>本科。</p><button>立即申请</button><p>职位已过期</p></main>'
   :path==='/article/hello'?'<title>团队介绍 - 测试公司</title><main><h1>平台工程师</h1><p>这是团队介绍文章，不是岗位详情。</p></main>'
   :detail;
  r.fulfill({contentType:'text/html; charset=utf-8',body:page});
 });
 await capture.addInitScript(job=>{
  window.events=[];window.modelInputs=[];
  window.chrome={runtime:{sendMessage(m,cb){
   if(m.type==='jd_model_config')return cb({ok:true,data:{enabled:true}});
   if(m.type==='jd_model_extract'){window.modelInputs.push(m.text);return cb({ok:true,data:{job}});}
   if(m.type==='enqueue_event')window.events.push(m.event);
   cb?.({ok:true});
  },onMessage:{addListener(){}}}};
 },job);
 await capture.goto('https://example.com/job/1');
 await capture.addScriptTag({path:'extension/content/adapters.js'});await capture.addScriptTag({path:'extension/content/tracker.js'});
 await capture.waitForFunction(()=>window.events.some(e=>e.event_type==='job_viewed'),null,{timeout:12000});
 check('model captures page with no company-specific selectors',await capture.evaluate(()=>window.events[0].payload.job_title==='平台工程师'));
 check('form input never sent to model',await capture.evaluate(()=>window.modelInputs.every(t=>!t.includes('private-secret'))));
 assert.equal(await capture.evaluate(()=>window.modelInputs.length),1,'stable page invokes model once');
 check('stable page invokes model once',true);
 await capture.evaluate(()=>{history.pushState({},'','/job/2');});await capture.waitForTimeout(2000);
 check('SPA URL change with stale content does not capture wrong job',await capture.evaluate(()=>window.events.length===1&&window.modelInputs.length===1));
 for (const path of ['/profile','/resume','/account','/login','/messages','/search?q=x','/applications','/settings','/jobs','/positions']) {
  await capture.goto('https://example.com'+path);
  await capture.addScriptTag({path:'extension/content/adapters.js'});await capture.addScriptTag({path:'extension/content/tracker.js'});
  await capture.waitForTimeout(2200);
  check(path+' never sends page text to the model',await capture.evaluate(()=>window.modelInputs.length===0));
 }
 for (const path of ['/job/expired','/article/hello']) {
  await capture.goto('https://example.com'+path);
  await capture.addScriptTag({path:'extension/content/adapters.js'});await capture.addScriptTag({path:'extension/content/tracker.js'});
  await capture.waitForTimeout(2200);
  check(path+' has no job evidence and never calls the model',await capture.evaluate(()=>window.modelInputs.length===0));
 }
 await capture.goto('https://example.com/job/1?from=search');
 await capture.addScriptTag({path:'extension/content/adapters.js'});await capture.addScriptTag({path:'extension/content/tracker.js'});
 await capture.waitForTimeout(2200);
 check('query string search hint does not block a real detail page',await capture.evaluate(()=>window.modelInputs.length===1));
 const extDir=server.dir+'/extension';fs.cpSync('extension',extDir,{recursive:true});
 const manifest=JSON.parse(fs.readFileSync(extDir+'/manifest.json','utf8'));
 manifest.host_permissions=['http://127.0.0.1/*','https://jobs.example.test/*','https://join.qq.com/*'];
 fs.writeFileSync(extDir+'/manifest.json',JSON.stringify(manifest));
 extensionContext=await chromium.launchPersistentContext(server.dir+'/browser',{executablePath:process.env.E2E_CHROME,headless:true,args:[`--disable-extensions-except=${extDir}`,`--load-extension=${extDir}`]});
 const sw=extensionContext.serviceWorkers()[0]||await extensionContext.waitForEvent('serviceworker');
 await sw.evaluate(async({base,device})=>{await TounarCommon.setSettings({serverUrl:base,deviceToken:device.device_token,deviceId:device.device_id,bindingVersion:device.binding_version});await syncContentScripts();},{base:server.base,device});
 await extensionContext.route('https://jobs.example.test/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<title>平台工程师 - 测试公司</title><main><h1>平台工程师</h1><p>测试公司</p><p>北京</p><h2>岗位职责</h2><p>1、设计平台。</p><p>2、维护服务。</p><h2>任职要求</h2><p>1、本科以上学历。</p></main>'}));
 const realPage=await extensionContext.newPage();await realPage.goto('https://jobs.example.test/job/1');
 const popup=await extensionContext.newPage();await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
 await realPage.bringToFront();
 const tab=await sw.evaluate(async()=> (await chrome.tabs.query({})).find(t=>t.url?.startsWith('https://jobs.example.test/')));
 const captured=await popup.evaluate(async tab=>chrome.runtime.sendMessage({type:'capture_current_tab',tabId:tab.id,origin:'https://jobs.example.test',reason:'test'}),tab);
 if (!captured.result?.application_id) console.log('Capture diagnostic:',JSON.stringify(captured));
 check('real extension invokes model and existing queue uploads job',captured.result?.application_id && captured.result?.job?.job_title==='平台工程师');
 const capturedDetail=(await server.request(`/api/v1/applications/${captured.result.application_id}`,{cookie})).json.data;
 check('real extension saves separated JD with unchanged pending state',capturedDetail.jd_text.includes('任职要求')&&capturedDetail.status==='pending');
 await extensionContext.route('https://join.qq.com/post_detail.html?*', route=>{
  const title=route.request().url().endsWith('101')?'校园AI产品经理':'校园数据产品经理';
  return route.fulfill({contentType:'text/html; charset=utf-8',body:`<title>岗位详情 | 腾讯校招</title><div class="bannerTipLeft"><div class="bannerItemText">${title}</div></div><ul class="post_detail"><li class="detail_box"><div class="subtitle">岗位描述</div><div class="text_box"><p class="detail_text">负责定义和验证产品需求。</p></div></li><li class="detail_box"><div class="subtitle">岗位要求</div><div class="text_box"><p class="detail_text">能够阅读技术文档并清晰沟通。</p></div></li></ul>`});
 });
 for (const id of ['1283126456553382101','1283126456553382102']) {
  const url='https://join.qq.com/post_detail.html?postid='+id;
  const campus=await extensionContext.newPage();
  await campus.goto(url);await campus.bringToFront();
  if (id.endsWith('102')) await campus.evaluate(()=>{
    const notice=document.createElement('div');
    document.body.append(notice);
    setInterval(()=>{notice.textContent='更新公告 '+Date.now();},250);
  });
  const campusTab=await sw.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url),url);
  const campusResult=await popup.evaluate(async tab=>chrome.runtime.sendMessage({type:'capture_current_tab',tabId:tab.id,origin:'https://join.qq.com',reason:'test'}),campusTab);
  const fromLocal=id.endsWith('102');
  check('Tencent campus ledger ID present '+id,Boolean(campusResult.result?.application_id));
  const saved=(await server.request('/api/v1/applications/'+campusResult.result.application_id,{cookie})).json.data;
  check('Tencent campus keeps canonical URL and both JD blocks '+id,saved.job_url===url && saved.jd_text.includes('负责定义和验证产品需求。') && saved.jd_text.includes('能够阅读技术文档并清晰沟通。'));
  check(fromLocal?'provider failure preserves original Tencent JD':'model organizes Tencent campus JD',Boolean(campusResult.result.model_notice)===fromLocal);
  await campus.close();
 }
 console.log(JSON.stringify({passed:checks.length,provider:'local fake; no paid requests'}));
}finally{await extensionContext?.close();await browser?.close();await server?.stop();await new Promise(r=>fake.close(r));}
