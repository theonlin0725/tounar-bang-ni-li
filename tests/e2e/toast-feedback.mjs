import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {startTestServer,freePort} from '../../server/test/helpers.js';
import {buildTestExtension} from '../../extension/scripts/make-test-build.mjs';
import {resolveChromiumExecutable} from './browser.mjs';
import {startCaptureFixtures} from './capture-fixtures.mjs';

const ROOT=path.resolve(import.meta.dirname,'../..');
const out=fs.mkdtempSync(path.join(ROOT,'.tmp','toast-feedback-'));
const checks=[];const receipts=[];const uploads=[];
let commit='unknown';try{commit=execFileSync('git',['rev-parse','--short','HEAD'],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{/* isolated release source has no .git */}
const report={commit,generated_at:new Date().toISOString(),scope:'A only. Actual product scripts, isolated Chrome, local fixtures/backend. Manifest host pregrant; native permission dialog and real websites not tested.',checks,out};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){const r=await fn();if(r)return r;await sleep(100);}throw Error('timeout: '+label);}
async function check(name,fn){try{const detail=await fn();checks.push({name,pass:true,detail});console.log('PASS '+name);}catch(e){checks.push({name,pass:false,error:e.message});console.log('FAIL '+name+' '+e.message);}}
let server,fixtures,proxy,spaServer,context,sw,popup,web,page,extensionId,cookie;
let mode='normal';let blocked=null;let release=null;
const toast=async()=>page.evaluate(()=>document.querySelector('[data-tounar-toast]')?.shadowRoot?.querySelector('.text')?.textContent||'');
async function closeToast(){const btn=page.locator('[data-tounar-toast]').getByRole('button',{name:'关闭提示'});if(await btn.count())await btn.click();}
async function shot(name){const file=path.join(out,name+'.png');await page.screenshot({path:file});return file;}
async function openPopup(){popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);await wait(()=>popup.locator('#paired').isVisible(),'popup paired');return popup;}
async function capture(){const before=(await sw.evaluate(()=>TounarCommon.getSettings())).lastCapture?.client_event_id;await page.bringToFront();await popup.click('#capture-now');await wait(async()=>{const s=await sw.evaluate(()=>TounarCommon.getSettings());return s.lastCapture?.client_event_id&&s.lastCapture.client_event_id!==before?s.lastCapture:null;},'manual result');}
async function flush(){await popup.click('#flush-now');await wait(async()=>await sw.evaluate(()=>TounarQueue.count())===0,'queue empty');}
async function clearQueue(){if(await sw.evaluate(()=>TounarQueue.count())){popup.once('dialog',d=>d.accept());await popup.click('#clear-queue');await wait(async()=>await sw.evaluate(()=>TounarQueue.count())===0,'clear queue');}}

try{
 server=await startTestServer({name:'toast-feedback-'+Date.now(),env:{CLOUD_LLM_ENABLED:'false'}});
 fixtures=await startCaptureFixtures(await freePort());
 proxy=http.createServer(async(req,res)=>{
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
   const isBatch=req.url.split('?')[0]==='/api/v1/events/batch';
   let batch=null;if(isBatch){batch=JSON.parse(body);uploads.push(...batch.events);}
   if(isBatch&&mode==='offline'){res.destroy();return;}
   const upstream=await fetch(server.base+req.url,{method:req.method,headers:Object.fromEntries(Object.entries(req.headers).filter(([k])=>!['host','connection','content-length','accept-encoding'].includes(k))),body:['GET','HEAD'].includes(req.method)?undefined:body});
   const bytes=Buffer.from(await upstream.arrayBuffer());
   if(isBatch){const parsed=JSON.parse(bytes);receipts.push(...(parsed.results||[]));
    if(mode==='hold'){blocked={batch,result:parsed};mode='normal';await new Promise(r=>release=r);release=null;}
   }
   res.writeHead(upstream.status,Object.fromEntries([...upstream.headers].filter(([k])=>!['content-encoding','content-length','transfer-encoding'].includes(k))));res.end(bytes);
  }catch(e){if(!res.destroyed){res.writeHead(502);res.end('{}');}}
 });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const proxyBase=`http://127.0.0.1:${proxy.address().port}`;
 let spaBase;
 const jobMarkup=id=>`<main data-job-id="${id}"><h1>提示验收岗位${id}</h1><p>公司名称: 提示验收科技</p><p>工作地点: 上海</p><p>岗位编号: ${id}</p><div class="job-description">岗位职责\n负责提示和状态展示。\n\n任职要求\n熟悉浏览器测试。</div><button>申请职位</button></main>`;
 spaServer=http.createServer((req,res)=>{const u=new URL(req.url,spaBase);const id=u.searchParams.get('postId')||'5001';const markup=jobMarkup(id);const data={'@type':'JobPosting',title:'提示验收岗位'+id,hiringOrganization:{name:'提示验收科技'},identifier:{value:id},url:spaBase+'/jobdesc.html?postId='+id,description:'岗位职责\n负责提示和状态展示。\n\n任职要求\n熟悉浏览器测试。'};
  res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(`<!doctype html><html><meta charset="utf-8"><style>body{font:18px system-ui;margin:32px}.job-description{white-space:pre-wrap}button{padding:12px}</style>${markup}<script type="application/ld+json">${JSON.stringify(data)}</script><button id="next">切换到岗位5002</button><script>document.querySelector('#next').onclick=()=>{history.pushState({},'', '/jobdesc.html?postId=5002');document.querySelector('main').outerHTML=${JSON.stringify(jobMarkup('5002'))};const d=JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent);d.title='提示验收岗位5002';d.identifier.value='5002';d.url=location.href;document.querySelector('script[type="application/ld+json"]').textContent=JSON.stringify(d)};</script></html>`);
 });await new Promise(r=>spaServer.listen(0,'127.0.0.1',r));spaBase=`http://127.0.0.1:${spaServer.address().port}`;
 const ext=buildTestExtension({outDir:path.join(out,'extension')});const manifest=JSON.parse(fs.readFileSync(path.join(ext,'manifest.json')));delete manifest.content_scripts;fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify(manifest));
 const profile=path.join(out,'profile');
 context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:(await resolveChromiumExecutable()).path,viewport:{width:1280,height:900},args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--no-first-run','--no-default-browser-check']});
 await context.tracing.start({screenshots:true,snapshots:true});
 sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');extensionId=new URL(sw.url()).host;
 const cdp=await context.newCDPSession(context.pages()[0]);report.browser=(await cdp.send('Browser.getVersion')).product;await cdp.detach();
 web=await context.newPage();await web.goto(server.base);await web.locator('[data-test=login-email]').fill('demo@tounar.local');await web.locator('[data-test=login-send]').click();await web.locator('[data-test=login-code]').fill(await server.readOtpCode('demo@tounar.local'));await web.locator('[data-test=login-submit]').click();await web.locator('[data-test=tab-viewed]').waitFor();cookie=(await context.cookies(server.base)).map(c=>c.name+'='+c.value).join('; ');
 popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);await popup.locator('#server-url').fill(proxyBase);await popup.click('#save-server');await popup.click('#start-pairing');
 // This suite tests a proxy transport; use the session API for pairing setup.
 // The dedicated plugin-access suite covers the real confirmation UI.
 const code=await wait(async()=>popup.evaluate(async()=>(await send({type:'get_status'})).settings?.pendingPairing?.code),'pair request');
 await server.request('/api/v1/plugin-pairings/approve',{method:'POST',cookie,body:{code}});
 await popup.evaluate(()=>send({type:'poll_pairing_now'}));await popup.evaluate(()=>refresh());await popup.locator('#paired').waitFor({state:'visible'});
 await web.goto(server.base+'/?panel=settings');await web.locator('[data-test=settings-tab-data]').click();
 await web.getByRole('button',{name:'关闭',exact:true}).click();await web.locator('[data-test=tab-viewed]').click();
 await popup.locator('#server-url').fill(proxyBase+'/?sharecode=test-gateway');await popup.click('#save-server');
 page=await context.newPage();await page.goto(fixtures.base+'/jobs/1001');await page.bringToFront();await popup.click('#grant-current');
 await check('成功提示对应真实业务记录，提供正确深链且不抢焦点',async()=>{
  const text=await wait(async()=>{const t=await toast();return t.includes('看过没投')?t:null;},'created toast');
  const receipt=receipts.find(r=>r.application_id);assert.ok(receipt);assert.equal(receipt.processing_state,'applied');
  const actual=(await server.request('/api/v1/applications/'+receipt.application_id,{cookie})).json.data;assert.equal(actual.has_applied,0);
  const aria=await page.locator('[data-tounar-toast] [role=status]').getAttribute('aria-live');assert.equal(aria,'polite');assert.equal(await page.evaluate(()=>document.activeElement?.hasAttribute('data-tounar-toast')),false);
  const screenshot=await shot('success');
  const promise=context.waitForEvent('page');await page.locator('[data-tounar-toast]').getByRole('button',{name:'查看台账'}).click();const opened=await promise;await opened.waitForLoadState('domcontentloaded');assert.equal(new URL(opened.url()).searchParams.get('app'),receipt.application_id);assert.equal(new URL(opened.url()).searchParams.get('sharecode'),'test-gateway');assert.equal(new URL(opened.url()).origin,proxyBase);await opened.close();
  await closeToast();assert.equal(await toast(),'');return {text,aria,application_id:receipt.application_id,screenshot};
 });
 await popup.close();
 await check('popup 关闭后自然浏览仍显示保存成功，约 4 秒消失',async()=>{
  await page.goto(fixtures.base+'/jobs/1002');await page.bringToFront();const text=await wait(async()=>{const t=await toast();return /看过没投/.test(t)?t:null;},'natural success');
  const screenshot=await shot('natural-success');await sleep(4300);assert.equal(await toast(),'');return {text,screenshot};
 });
 await check('仅再次浏览无字段变化，应静默',async()=>{
  const before=receipts.length;await page.reload();await page.bringToFront();await wait(()=>receipts.length>before,'repeat receipt');await sleep(250);const text=await toast();const screenshot=await shot('repeat');assert.equal(text,'',JSON.stringify({text,screenshot,outcome:receipts.at(-1)?.outcome}));
 });
 await check('列表汇总应按实际岗位数显示',async()=>{
  await page.goto(fixtures.base+'/jobs');await page.bringToFront();await wait(()=>uploads.some(e=>e.event_type==='job_discovered'),'list uploads');await sleep(1600);const text=await toast();const screenshot=await shot('list');report.list_observation={text,screenshot};assert.match(text,/本页/);
 });
 await openPopup();
 await check('关闭开关在重新打开 popup 后应保持关闭',async()=>{
  await popup.locator('#page-feedback').uncheck();await wait(async()=>await sw.evaluate(async()=>(await TounarCommon.getSettings()).pageFeedback)===false,'setting false');await popup.close();await openPopup();await sleep(400);
  assert.equal(await popup.locator('#page-feedback').isChecked(),false,'存储为 false，但重新打开 popup 的复选框为已勾选');
 });
 await check('关闭提示时，主动离线采集也不得显示 Toast',async()=>{
  // Reopened popup may incorrectly appear checked; uncheck explicitly while keeping real setting false.
  await popup.locator('#page-feedback').uncheck();mode='offline';await page.goto(fixtures.base+'/jobs/1001');await page.bringToFront();await capture();const text=await toast();const screenshot=await shot('disabled-offline');const status=await popup.locator('#capture-status').textContent();assert.equal(text,'',JSON.stringify({text,status,screenshot}));
 });
 await clearQueue();await popup.locator('#page-feedback').check();await popup.close();
 await check('自然浏览断网应给出待同步提示',async()=>{
  mode='offline';const before=uploads.length;await page.goto(fixtures.base+'/jobs/1005');await page.bringToFront();await wait(()=>uploads.length>before,'automatic offline upload');await sleep(1200);const count=await sw.evaluate(()=>TounarQueue.count());assert.ok(count>0);const text=await toast();const screenshot=await shot('automatic-offline');assert.match(text,/待同步/,JSON.stringify({text,count,screenshot}));
 });
 await openPopup();await clearQueue();mode='normal';
 await check('A 岗回执延迟到 query 切换后，不得在 B 岗报当前岗位成功',async()=>{
  await popup.close();mode='hold';blocked=null;await page.goto(spaBase+'/jobdesc.html?postId=5001');await page.bringToFront();await wait(()=>blocked,'held A receipt');
  const aReceipt=blocked.result.results.find(r=>r.application_id);assert.ok(aReceipt);await page.click('#next');await sleep(350);release();await sleep(350);const text=await toast();const screenshot=await shot('stale-query');
  const title=await page.locator('h1').textContent();const a=(await server.request('/api/v1/applications/'+aReceipt.application_id,{cookie})).json.data;
  report.stale_query={text,current_title:title,receipt_job:a.job_title,current_url:page.url(),screenshot};assert.ok(!/当前岗位.*已/.test(text),JSON.stringify(report.stale_query));
 });
 if(release)release();mode='normal';await sleep(4500);await openPopup();await clearQueue();
 await check('同一岗位两次待同步，恢复后汇总不能算作两个岗位',async()=>{
  mode='offline';await page.goto(fixtures.base+'/jobs/1001');await page.bringToFront();await capture();await capture();const pending=await sw.evaluate(()=>TounarQueue.list(50));assert.ok(pending.length>=2);await closeToast();const before=receipts.length;mode='normal';await flush();await sleep(250);
  const rs=receipts.slice(before);const distinct=[...new Set(rs.map(r=>r.application_id).filter(Boolean))];assert.equal(distinct.length,1);
  const text=await toast();const screenshot=await shot('batch-same-job');assert.ok(!/本页 [2-9]\d* 个岗位已保存/.test(text),JSON.stringify({text,events:rs.length,distinct:distinct.length,screenshot}));
 });
 await check('页面 Toast 在窄窗口内且可关闭',async()=>{
  await page.setViewportSize({width:375,height:740});await sleep(5100);await capture();await wait(()=>toast(),'small toast');const r=await page.locator('[data-tounar-toast]').boundingBox();assert.ok(r&&r.x>=0&&r.x+r.width<=375);const screenshot=await shot('narrow');await closeToast();assert.equal(await toast(),'');await page.setViewportSize({width:1280,height:900});return {screenshot,rect:r};
 });

 // SW 真实停止/重启：排队事件的反馈映射必须能恢复，并在恢复上传后回到原页面
 await openPopup();
 await popup.locator('#page-feedback').check().catch(()=>{});
 await check('SW 重启后排队事件的反馈仍能回到原页面',async()=>{
  mode='offline';
  await page.goto(fixtures.base+'/jobs/1004');await page.bringToFront();
  await capture();
  const key='tounar.pendingTabs.v1';
  const rows=async()=>sw.evaluate(async k=>Object.values((await chrome.storage.session.get(k))[k]||{}),key);
  const before=await wait(async()=>{const list=await rows();const hit=list.find(r=>r.identity==='generic:id:1004');return hit?list.length:null;},'1004 的 pendingTabs 持久化');
  assert.ok(before>0,'pendingTabs 应写入 session storage');
  const bcdp=await context.browser().newBrowserCDPSession();
  const targets=await bcdp.send('Target.getTargets');
  const target=targets.targetInfos.find(t=>t.type==='service_worker'&&t.url.includes(extensionId));
  assert.ok(target,'找到扩展 service worker');
  await bcdp.send('Target.closeTarget',{targetId:target.targetId});
  await sleep(500);
  await popup.reload();await sleep(1200);
  const workers=context.serviceWorkers().filter(w=>w.url().includes(extensionId));
  assert.ok(workers.length>0,'SW 应被唤醒');
  sw=workers[workers.length-1];
  const after=await wait(async()=>{const list=await rows();const hit=list.find(r=>r.identity==='generic:id:1004');return hit?list.length:null;},'重启后 1004 映射恢复');
  assert.ok(after>0,'重启后应恢复映射');
  await closeToast();
  mode='normal';
  await page.bringToFront();
  await flush();
  const restored=await wait(async()=>{const t=await toast();return t?t:null;},'重启后 Toast');
  report.sw_resume={verified_by:'real SW stop/restart via CDP',pending_before:before,pending_after:after,toast:restored,screenshot:await shot('sw-restart')};
  assert.match(restored,/看过没投|已更新|台账/);
 });
 await popup.close();
 // Contract diagnostics use exact functions from the checked-in product source; no product runtime is patched.
 const source=fs.readFileSync(path.join(ROOT,'extension/background/service-worker.js'),'utf8');
 const start=source.indexOf('function feedbackStatus(');const end=source.indexOf('async function deliverFeedback(',start);
 const sandbox={URL};vm.createContext(sandbox);vm.runInContext(source.slice(start,end),sandbox);
 await check('回执无 application_id 且 ignored 时不能判保存成功（契约检查）',async()=>{
  const state=sandbox.feedbackStatus({accepted:true,processing_state:'ignored',outcome:'applied',application_id:null});assert.notEqual(state,'saved');
 });
 await check('页面身份比较必须区分 hash 岗位（契约检查）',async()=>{assert.equal(sandbox.samePage('https://jobs.example/#/job/1','https://jobs.example/#/job/2'),false);});
 
}catch(e){checks.push({name:'验收环境/执行',pass:false,error:e.stack});console.error(e.stack);}
finally{
 mode='normal';if(release)release();
 report.passed=checks.filter(x=>x.pass).length;report.failed=checks.filter(x=>!x.pass).length;report.upload_count=uploads.length;report.receipt_count=receipts.length;
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
 fs.writeFileSync(path.join(ROOT,'.tmp/toast-feedback-latest.json'),JSON.stringify({report:path.join(out,'report.json'),out,passed:report.passed,failed:report.failed},null,2));
 await context?.tracing.stop({path:path.join(out,'trace.zip')}).catch(()=>{});await context?.close().catch(()=>{});await server?.stop().catch(()=>{});await fixtures?.close().catch(()=>{});if(proxy)await new Promise(r=>proxy.close(r));if(spaServer)await new Promise(r=>spaServer.close(r));
 console.log(JSON.stringify({report:path.join(out,'report.json'),passed:report.passed,failed:report.failed}));process.exitCode=report.failed?1:0;
}
