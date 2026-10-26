import {classifyField,validField} from './acceptance-fields.mjs';
/* Real extension runtime + isolated backend/frontend. See report.permission_mode.
 * Default: manifest-only pregrant for deterministic headless CI; NO static scripts,
 * runtime/storage mocks, event injection or extractor calls. --production uses the
 * unchanged manifest and waits for Chrome's real optional-permission prompt.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, freePort } from '../../server/test/helpers.js';
import { buildTestExtension } from '../../extension/scripts/make-test-build.mjs';
import { resolveChromiumExecutable } from './browser.mjs';
import { currentSiteAcceptance } from './current-site-acceptance.mjs';
import {genericLiveAcceptance} from './generic-live-acceptance.mjs';
import { loadLiveTruth } from './live-truth.mjs';
import { tencentLiveAcceptance } from './tencent-live-acceptance.mjs';
import { startCaptureFixtures, JOBS } from './capture-fixtures.mjs';

const ROOT=path.resolve(import.meta.dirname,'../..');
if(process.argv.includes('--all-sites')) {
  const {runLiveSuite}=await import('./live-suite.mjs');
  process.exit(await runLiveSuite());
}
if(process.argv.includes('--summary-only')) {
  const {summarizeLiveSuite}=await import('./live-suite.mjs');
  const summary=summarizeLiveSuite();console.log(`必选站 ${summary.mandatory_passed}/10；.tmp/plugin-acceptance-suite/report.json`);
  process.exit(summary.complete?0:1);
}
const selectedSite=process.argv.find(arg=>arg.startsWith('--site='))?.split('=')[1];
const real=process.argv.includes('--real-sites')||!!selectedSite;
const production=process.argv.includes('--production');
const out=path.join(ROOT,'.tmp',selectedSite?`plugin-acceptance-${selectedSite}`:real?'plugin-acceptance-live':production?'plugin-acceptance-production':'plugin-acceptance');fs.mkdirSync(out,{recursive:true});
const checks=[],rows=[],events=[],receipts=new Map(),errors=[];
const report={generated_at:new Date().toISOString(),mode:real?`live-${selectedSite||'tencent'}`:production?'production-permission':'stable-fixture',permission_mode:production?'Chrome optional permission UI':'manifest pregrant; permission dialog NOT tested',commit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),metrics:{detail_denominator:real?3:8},extension_version:JSON.parse(fs.readFileSync(path.join(ROOT,'extension/manifest.json'))).version,checks,rows};
report.source_fingerprint=crypto.createHash('sha256').update(['extension/content/tracker.js','extension/content/adapters.js','extension/background/service-worker.js','extension/lib/learned.js','server/src/plugin.js','server/src/domain/applications.js'].map(p=>fs.readFileSync(path.join(ROOT,p),'utf8')).join('\n')).digest('hex');
report.working_tree_dirty=!!execFileSync('git',['status','--porcelain'],{cwd:ROOT,encoding:'utf8'}).trim();
let server,fixture,context,sw,popup,web,jobPage,cookie,extensionId,launchOptions,failed=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(150);}throw new Error('等待超时：'+label);}
async function check(name,fn){try{const detail=await fn();checks.push({name,ok:true,detail});console.log('✔ '+name);}catch(e){failed++;checks.push({name,ok:false,error:e.message});console.log('✖ '+name+' — '+e.message);}}
function observeRuntime(){
  context.on('page',p=>p.on('pageerror',e=>errors.push({page:p.url(),message:e.message,stack:e.stack||''})));
  context.on('request',req=>{if(req.url()===server.base+'/api/v1/events/batch'){const batch=req.postDataJSON();for(const e of batch?.events||[])events.push(e);}});
  context.on('response',async res=>{if(res.url()===server.base+'/api/v1/events/batch'){try{for(const r of (await res.json()).results||[])receipts.set(r.client_event_id,r);}catch{}}});
}
async function ledger(){return (await server.request('/api/v1/ledger?view=viewed&limit=100',{cookie})).json.data;}
async function detail(id){return (await server.request('/api/v1/applications/'+id,{cookie})).json.data;}
async function openPopup(){popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);return popup;}
async function verify(id,pageType='detail',started=Date.now()){
  const expected=JOBS[id];
  const event=await wait(()=>events.findLast(e=>e.payload.site_job_id===String(id)),`岗位 ${id} 上传`);
  const receipt=await wait(()=>receipts.get(event.client_event_id),`岗位 ${id} 回执`);
  const row={site:'local-fixture',url:jobPage.url(),page_type:pageType,expected,actual:event.payload,field_result:{},extraction_source:event.payload.field_sources,template_version:event.payload.template_version||null,client_event_id:event.client_event_id,processing_state:receipt.processing_state,application_id:receipt.application_id,frontend_visible:false,duplicate_count:null,timings:{to_receipt_ms:Date.now()-started},error:null,evidence_path:null};rows.push(row);
  assert.ok(receipt.application_id,JSON.stringify(receipt));
  const app=await detail(receipt.application_id);
  for(const field of ['company_name','job_title','location','recruitment_batch',...(pageType==='list'?[]:['jd_text'])]){
    row.field_result[field]=classifyField(expected[field],app[field]||'');
    assert.equal(app[field]||'',expected[field],`${id} ${field}`);
  }
  assert.equal(app.has_applied,0);assert.equal(app.status,'pending');
  const selector=`[data-app-id="${app.id}"]`;
  await web.bringToFront();await web.locator(selector).waitFor({timeout:7000});
  row.frontend_visible=true;row.timings.to_frontend_ms=Date.now()-started;
  row.duplicate_count=(await ledger()).items.filter(x=>x.id===app.id).length;assert.equal(row.duplicate_count,1);
  if(pageType!=='list') {await web.locator(selector).click();await web.locator('[data-test=detail-jd-text]').waitFor();assert.equal(await web.locator('[data-test=detail-jd-text]').textContent(),expected.jd_text);await web.getByRole('button',{name:'关闭',exact:true}).click();}
  row.evidence_path=path.join(out,`${id}-${pageType}.png`);await web.screenshot({path:row.evidence_path});
  return app;
}
try {
  server=await startTestServer({name:`plugin-acceptance-${selectedSite||''}-${real?'live':production?'production':'stable'}-${Date.now()}`});fixture=await startCaptureFixtures(await freePort());
  let ext=path.join(ROOT,'extension');
  if(!production){ext=buildTestExtension({outDir:path.join(out,'extension')});const m=JSON.parse(fs.readFileSync(path.join(ext,'manifest.json')));delete m.content_scripts;if(real){const truth=loadLiveTruth(selectedSite||'tencent');for(const url of [truth.list_url,...truth.details.map(d=>d.job_url)].filter(Boolean))m.host_permissions.push(new URL(url).origin+'/*');m.host_permissions=[...new Set(m.host_permissions)];}fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify(m,null,2));}
  const profile=fs.mkdtempSync(path.join(out,'profile-'));
  launchOptions={headless:!production,executablePath:(await resolveChromiumExecutable()).path,viewport:{width:1280,height:900},args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--no-first-run','--no-default-browser-check']};
  context=await chromium.launchPersistentContext(profile,launchOptions);
  const browserInfo=await context.newCDPSession(context.pages()[0]);report.browser_version=(await browserInfo.send('Browser.getVersion')).product;await browserInfo.detach();report.profile=profile;report.test_data_dir=server.dir;
  await context.tracing.start({screenshots:true,snapshots:true});
  observeRuntime();
  sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');extensionId=new URL(sw.url()).host;
  web=await context.newPage();await web.goto(server.base);
  await web.locator('[data-test=login-email]').fill('demo@tounar.local');await web.locator('[data-test=login-send]').click();
  await web.locator('[data-test=login-code]').fill(await server.readOtpCode('demo@tounar.local'));await web.locator('[data-test=login-submit]').click();
  await web.locator('[data-test=tab-viewed]').waitFor();
  cookie=(await context.cookies(server.base)).map(c=>c.name+'='+c.value).join('; ');
  await openPopup();await popup.locator('#server-url').fill(server.base);await popup.click('#save-server');await popup.click('#start-pairing');
  const code=await wait(async()=>{const t=await popup.locator('#pairing-code').textContent();return /^[A-HJ-NP-Z2-9]{8}$/.test(t)?t:null;},'配对码');
  await web.goto(server.base+'/?panel=settings');
  await web.locator('[data-test=settings-tab-data]').click();await web.locator('[data-test=pair-code]').fill(code);await web.locator('[data-test=pair-approve]').click();
  await popup.click('#poll-pairing');await popup.locator('#paired').waitFor({state:'visible'});
  await web.getByRole('button',{name:'关闭',exact:true}).click();await web.locator('[data-test=tab-viewed]').click();
  await check('配对走扩展与前端 UI；台账提前打开',async()=>assert.equal((await ledger()).items.length,0));
  if(real) { await (['greenhouse','smartrecruiters'].includes(selectedSite)?genericLiveAcceptance:selectedSite&&selectedSite!=='tencent'?currentSiteAcceptance:tencentLiveAcceptance)({site:selectedSite,context,web,popup,events,receipts,ledger,detail,wait,check,rows,out,report}); } else {
  jobPage=await context.newPage();await jobPage.goto(fixture.base+'/jobs/1001');await jobPage.bringToFront();
  report.permissions_before = await sw.evaluate(()=>chrome.permissions.getAll());
  const started=Date.now();await popup.click('#grant-current');
  await check(production?'原版扩展首次授权即时入账':'预授权环境：扩展 UI 启用当前站点即时入账',async()=>{
    if(production) console.log('等待 Chrome 权限弹窗确认（30 秒），无响应将标阻塞并失败退出。');
    await wait(async()=>/已自动入账/.test(await popup.locator('#capture-status').textContent()),'UI 授权采集',production?30000:10000);
    report.permissions_after = await sw.evaluate(()=>chrome.permissions.getAll());
    await verify(1001,'detail',started);
    const event=events.find(e=>e.payload.site_job_id==='1001');assert.equal(event.event_type,'job_captured');assert.ok((event.payload.visible_dwell_ms||0)<3000);
  });
  if(production && failed) throw new Error('原版扩展首次授权受阻，未计通过');
  await popup.close();
  await check('关闭 popup 后新开详情、同名不同 ID 自动入账',async()=>{const t=Date.now();await jobPage.goto(fixture.base+'/jobs/1002');await jobPage.bringToFront();await verify(1002,'detail',t);assert.equal(events.find(e=>e.payload.site_job_id==='1002').event_type,'job_viewed');});
  await check('多个 JD 区块与无申请按钮详情完整采集',async()=>{await jobPage.goto(fixture.base+'/jobs/1005');await jobPage.bringToFront();await verify(1005);});
  await check('长 JD 超 20000 字原页到前端逐字相同',async()=>{await jobPage.goto(fixture.base+'/jobs/1003');await jobPage.bringToFront();await verify(1003);});
  await check('SPA 同名 A→B 等新内容，不关联旧 DOM',async()=>{
    await jobPage.goto(fixture.base+'/jobs/2001');await jobPage.bringToFront();await verify(2001);
    await jobPage.bringToFront();await jobPage.click('#switch-job');await sleep(900);assert.equal(events.filter(e=>e.payload.site_job_id==='2002').length,0);
    await verify(2002);
  });
  await check('真实点击侧栏 A→B 在同 URL 创建两个正确岗位',async()=>{await jobPage.goto(fixture.base+'/drawer');await jobPage.bringToFront();await jobPage.click('#open-a');await verify(3001);await jobPage.bringToFront();await jobPage.click('#open-b');await verify(3002);});
  await check('列表发现来源独立，已完整详情不被列表覆盖',async()=>{
    await jobPage.goto(fixture.base+'/jobs');await jobPage.bringToFront();
    await wait(()=>events.some(e=>e.event_type==='job_discovered'),'列表发现');await sleep(1500);
    for(const id of [1001,1002,1005]) {const e=events.find(e=>e.event_type==='job_discovered'&&e.payload.site_job_id===String(id));assert.ok(e);assert.equal(e.payload.visible_dwell_ms,undefined);const receipt=await wait(()=>receipts.get(e.client_event_id),'列表回执');assert.equal((await detail(receipt.application_id)).jd_text,JOBS[id].jd_text);}
  });
  await check('缺公司但岗位身份可追溯：直接进看过没投，不堆待确认',async()=>{
    await openPopup();await jobPage.goto(fixture.base+'/jobs/1004');await jobPage.bringToFront();await popup.click('#capture-now');
    await wait(async()=>/已自动入账/.test(await popup.locator('#capture-status').textContent()),'自动入账状态');
    const e=events.find(e=>e.payload.site_job_id==='1004');
    const receipt=receipts.get(e.client_event_id);
    assert.ok(receipt.application_id,'应生成业务记录');
    assert.equal(receipt.review_reason,null);
    const row=(await ledger()).items.find(x=>x.site_job_id==='1004'||x.job_title==='公司缺失的岗位');
    assert.ok(row,'应在看过没投可见');assert.equal(row.has_applied,0);assert.equal(row.company_name,'');
    await popup.close();
  });
  await check('首页、登录、过期岗位不污染台账',async()=>{const before=(await ledger()).items.length;for(const route of ['/','/login','/expired']){await jobPage.goto(fixture.base+route);await jobPage.bringToFront();await sleep(4200);}assert.equal((await ledger()).items.length,before);});
  await check('刷新重复浏览仍只有一条，已投统计保持零',async()=>{const before=(await ledger()).items.length;await jobPage.goto(fixture.base+'/jobs/1001');await jobPage.bringToFront();await sleep(4500);const after=await ledger();assert.equal(after.items.length,before);assert.equal(after.stats.total_applied,0);});
  await check('模板通过旧选择器核对后跨岗位升级（未伪造 storage）',async()=>{
    const templates=await sw.evaluate(async()=>Object.values((await chrome.storage.local.get('tounar.learned.v1'))['tounar.learned.v1']||{}));
    report.templates=templates;assert.ok(templates.some(t=>t.status==='stable'&&t.selectors.jd&&t.lastReplayFields?.includes('jd')));
  });
  await check('浏览器重启后模板与授权保留，自然浏览继续入账',async()=>{
    await context.tracing.stop({path:path.join(out,'trace-before-restart.zip')});await context.close();
    context=await chromium.launchPersistentContext(report.profile,launchOptions);observeRuntime();
    await context.tracing.start({screenshots:true,snapshots:true});
    sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    web=await context.newPage();await web.goto(server.base);await web.locator('[data-test=tab-viewed]').click();
    jobPage=await context.newPage();const before=events.length;
    await jobPage.goto(fixture.base+'/jobs/1001');await jobPage.bringToFront();
    const event=await wait(()=>events.slice(before).find(e=>e.payload.site_job_id==='1001'),'重启后自然采集');
    assert.ok(event.payload.template_fields?.includes('jd'));assert.ok(event.payload.template_version);
    const receipt=await wait(()=>receipts.get(event.client_event_id),'重启回执');assert.ok(receipt.application_id);
  });
  await check('模板只剩标题有效时降级，重学新版本后跨岗位核对',async()=>{
    const old=await sw.evaluate(async()=>Object.values((await chrome.storage.local.get('tounar.learned.v1'))['tounar.learned.v1']).find(t=>t.pathPattern==='/jobs/:num'));
    assert.ok(old);fixture.setLayout(true);
    let before=events.length;await jobPage.goto(fixture.base+'/jobs/1002');await jobPage.bringToFront();
    const e=await wait(()=>events.slice(before).find(e=>e.payload.site_job_id==='1002'),'结构变化采集');
    const r=await wait(()=>receipts.get(e.client_event_id),'结构变化回执');assert.equal((await detail(r.application_id)).jd_text,JOBS[1002].jd_text);
    const relearned=await wait(async()=>{const t=await sw.evaluate(async()=>Object.values((await chrome.storage.local.get('tounar.learned.v1'))['tounar.learned.v1']).find(t=>t.pathPattern==='/jobs/:num'));return t?.version>old.version?t:null;},'重学新版本');
    assert.equal(relearned.status,'trial');assert.ok(relearned.failures>old.failures);
    before=events.length;await jobPage.goto(fixture.base+'/jobs/1001');await jobPage.bringToFront();
    const b=await wait(()=>events.slice(before).find(e=>e.payload.site_job_id==='1001'),'新模板跨岗位');
    assert.equal(b.payload.template_version,relearned.version);assert.ok(b.payload.template_fields.includes('jd'));
    await wait(async()=>await sw.evaluate(async version=>Object.values((await chrome.storage.local.get('tounar.learned.v1'))['tounar.learned.v1']).some(t=>t.version===version&&t.status==='stable'),relearned.version),'新模板稳定');
  });
  await check('断网显示待上传，恢复后台后自动同步且不重复',async()=>{
    await openPopup();
    await popup.locator('#server-url').fill(`http://127.0.0.1:${await freePort()}`);await popup.click('#save-server');
    await jobPage.goto(fixture.base+'/jobs/1001');await jobPage.bringToFront();await popup.click('#capture-now');
    await wait(async()=>/等待上传/.test(await popup.locator('#capture-status').textContent()),'离线状态');
    assert.ok(await sw.evaluate(()=>TounarQueue.count())>0);
    await popup.locator('#server-url').fill(server.base);await popup.click('#save-server');
    await wait(async()=>await sw.evaluate(()=>TounarQueue.count())===0,'自动补传');
    await wait(async()=>/已自动入账/.test(await popup.locator('#capture-status').textContent()),'恢复后的真实回执');
    assert.equal((await ledger()).items.filter(a=>a.job_title===JOBS[1001].job_title).length,2);
  });
  await check('暂停停止新增事件，恢复后当前页继续自然采集',async()=>{
    await popup.click('#toggle-pause');await wait(async()=>await popup.locator('#toggle-pause').textContent()==='恢复采集','暂停生效');
    const before=events.length;await jobPage.goto(fixture.base+'/jobs/1002');await jobPage.bringToFront();await sleep(4500);
    assert.equal(events.length,before);
    await popup.click('#toggle-pause');await jobPage.bringToFront();
    await wait(()=>events.slice(before).some(e=>e.event_type==='job_viewed'&&e.payload.site_job_id==='1002'),'恢复自然采集');
  });
  await check('删除模板保留队列，清空队列显示已清空且保留权限',async()=>{
    await popup.locator('#server-url').fill(`http://127.0.0.1:${await freePort()}`);await popup.click('#save-server');
    await jobPage.bringToFront();await popup.click('#capture-now');
    await wait(async()=>/等待上传/.test(await popup.locator('#capture-status').textContent()),'离线队列');
    const count=await sw.evaluate(()=>TounarQueue.count());assert.ok(count>0);
    await popup.click('#clear-learned');
    assert.deepEqual(await sw.evaluate(async()=>(await chrome.storage.local.get('tounar.learned.v1'))['tounar.learned.v1']||{}),{});
    assert.equal(await sw.evaluate(()=>TounarQueue.count()),count);
    popup.once('dialog',d=>d.accept());await popup.click('#clear-queue');
    await wait(async()=>/未上传事件已清空/.test(await popup.locator('#capture-status').textContent()),'清空状态');
    assert.equal(await sw.evaluate(()=>TounarQueue.count()),0);
    assert.ok((await sw.evaluate(()=>chrome.permissions.getAll())).origins.length>0);
    await popup.locator('#server-url').fill(server.base);await popup.click('#save-server');
  });
  if (production) await check('撤销授权后现有页面和新开页面都不再上传',async()=>{
    await popup.click('#revoke-all');await wait(async()=>!(await sw.evaluate(()=>chrome.permissions.getAll())).origins?.length,'撤销权限');
    const before=events.length;
    await jobPage.bringToFront();await sleep(4200);await jobPage.goto(fixture.base+'/jobs/1003');await sleep(4500);
    assert.equal(events.length,before);await popup.close();
  });
  }
  if (!production) report.not_covered=['Chrome 原生首次授权/拒绝/撤销：CI 使用必需 host_permissions，无法撤销；需 production 模式验证'];
  report.page_errors=errors;
  await check('扩展及本地前端无运行错误',async()=>assert.deepEqual(errors.filter(e=>e.page.startsWith('chrome-extension:')||e.page.startsWith(server.base)||e.stack.includes('chrome-extension:')),[]));
} catch(e){failed++;checks.push({name:'运行受阻',ok:false,error:e.message});console.error(e.stack);}
finally {
  report.failed=failed;report.events_count=events.length;
  const accurate = row => row.application_id && row.frontend_visible && !row.error && Object.values(row.field_result).every(validField);
  report.metrics={
    not_provided_fields:rows.reduce((n,r)=>n+Object.values(r.field_result).filter(v=>v==='not_provided').length,0),
    correct_fields:rows.reduce((n,r)=>n+Object.values(r.field_result).filter(v=>v==='correct').length,0),
    checked_fields:rows.reduce((n,r)=>n+Object.keys(r.field_result).length,0),
    accurate_details:rows.filter(r=>r.page_type==='detail'&&accurate(r)).length,detail_denominator:report.metrics.detail_denominator,
    accurate_list_items:rows.filter(r=>r.page_type==='list'&&accurate(r)).length,list_denominator:report.metrics.list_denominator??(real?10:0),
    performance_percentiles:'not measured; per-row times are diagnostic only'
  };
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(out,'report.md'),`# 插件验收报告\n\n权限模式：${report.permission_mode}\n\n`+checks.map(c=>`- ${c.ok?'通过':'失败'}：${c.name}${c.error?' — '+c.error:''}`).join('\n')+'\n\n'+JSON.stringify(report.metrics)+'\n');
  await context?.tracing.stop({path:path.join(out,'trace.zip')}).catch(()=>{});
  await context?.close().catch(()=>{});await server?.stop().catch(()=>{});await fixture?.close().catch(()=>{});
  console.log(`报告：${out}/report.json；失败 ${failed}`);process.exitCode=failed?1:0;
}
