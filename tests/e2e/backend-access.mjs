// Targeted network regression: untouched production manifest, no host pregrant,
// no mocked browser APIs. Isolated test credentials exercise real CORS requests.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startTestServer,freePort} from '../../server/test/helpers.js';
import {resolveChromiumExecutable} from './browser.mjs';

const root=path.resolve(import.meta.dirname,'../..');
const out=path.join(root,'.tmp/backend-access');fs.mkdirSync(out,{recursive:true});
const checks=[];let context,server;
try {
  server=await startTestServer({name:'backend-access-'+Date.now()});
  const cookie=(await server.login('demo@tounar.local')).cookie;
  const token=(await server.pairDevice(cookie)).device_token;
  const ext=path.join(root,'extension');
  context=await chromium.launchPersistentContext(fs.mkdtempSync(path.join(out,'profile-')),{headless:true,executablePath:(await resolveChromiumExecutable()).path,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
  const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const result=await sw.evaluate(async({base,token,unavailable})=>{
    const attempt=async fn=>{try{await fn();return {ok:true};}catch(e){return {ok:false,code:e.code,status:e.status,message:e.message};}};
    return {
      origins:(await chrome.permissions.getAll()).origins||[],
      health:await attempt(()=>TounarApi.health(base)),
      heartbeat:await attempt(()=>TounarApi.heartbeat(base,token)),
      device:await attempt(()=>TounarApi.deviceSelf(base,token)),
      invalid:await attempt(()=>TounarApi.heartbeat(base,'invalid-test-token')),
      unavailable:await attempt(()=>TounarApi.health(unavailable))
    };
  },{base:server.base,token,unavailable:`http://127.0.0.1:${await freePort()}`});
  function check(name,fn){try{fn();checks.push({name,ok:true});console.log('✔ '+name);}catch(e){checks.push({name,ok:false,error:e.message});throw e;}}
  check('原版扩展未预授权任何后台主机',()=>assert.deepEqual(result.origins,[]));
  check('健康检查与带设备凭证的跨域请求均可到达后端',()=>{assert.equal(result.health.ok,true);assert.equal(result.heartbeat.ok,true,JSON.stringify(result.heartbeat));assert.equal(result.device.ok,true);});
  check('无效设备返回真实 401，不再误报网络无法连接',()=>assert.equal(result.invalid.status,401,JSON.stringify(result.invalid)));
  check('未授权且请求失败时给出授权入口，不臆断没有服务监听',()=>{assert.equal(result.unavailable.code,'BACKEND_PERMISSION_REQUIRED');assert.ok(!result.unavailable.message.includes('没有服务在监听'));});
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({generated_at:new Date().toISOString(),extension_version:JSON.parse(fs.readFileSync(path.join(ext,'manifest.json'))).version,permission_mode:'untouched production manifest; no grants',checks,result,not_covered:'Native permission allow/deny UI is not exercised by this targeted CORS test.'},null,2));
} catch(error) {console.error(error);process.exitCode=1;fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,error:error.message},null,2));}
finally {await context?.close();await server?.stop();}
