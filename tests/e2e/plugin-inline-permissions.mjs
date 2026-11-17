// Real extension iframe + Chrome permission API, using an isolated profile.
// Headed mode permits explicit interaction with the native Chrome permission prompt.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startTestServer} from '../../server/test/helpers.js';
const root=path.resolve(import.meta.dirname,'../..');const dir=path.join(root,'.tmp','inline-permissions-'+Date.now());fs.mkdirSync(dir,{recursive:true});
let context,server,page;
const checks=[];function check(name,ok){assert.ok(ok,name);checks.push(name);console.log('PASS '+name);}
try {
 server=await startTestServer({name:'inline-permissions-'+Date.now()});
 const executablePath=process.env.E2E_CHROME;const ext=path.join(root,'extension');
 context=await chromium.launchPersistentContext(path.join(dir,'profile'),{headless:process.env.E2E_HEADED !== '1',...(executablePath?{executablePath}:{}),args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
 const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 await sw.evaluate(async base=>TounarCommon.setSettings({serverUrl:base}),server.base);
 await context.addInitScript(()=>{if (/^https?:$/.test(location.protocol)) sessionStorage.setItem('tounar.plugin.onboarding.demo@tounar.local','connection');});
 const cookie=(await server.login('demo@tounar.local')).cookie;const [name,...value]=cookie.split(';')[0].split('=');await context.addCookies([{name,value:value.join('='),url:server.base}]);
 page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error') console.log('Browser: '+m.text());});
 await page.goto(server.base);await page.locator('[data-test=open-settings-data]').click();
 const card=page.locator('[data-test=site-access-card]');await card.getByRole('checkbox',{name:'字节跳动招聘',exact:true}).waitFor();
 const beforeBackend=await sw.evaluate(()=>chrome.permissions.contains({origins:['http://127.0.0.1/*']}));
 const beforePages=context.pages().length;const beforeWindows=await sw.evaluate(async()=>(await chrome.windows.getAll()).length);
 await card.getByRole('button',{name:'授权选中网站',exact:true}).click();
 const modal=page.locator('[data-test=permission-confirm-modal]');await modal.waitFor();
 const frame=page.frameLocator('[data-test=permission-frame]');await frame.getByRole('button',{name:'确认授权',exact:true}).waitFor();
 await frame.getByText('字节跳动招聘 · 2 个域名',{exact:true}).waitFor();
 check('confirmation is embedded in the original page',page.url()===server.base+'/');
 check('no new browser tab or window',context.pages().length===beforePages && await sw.evaluate(async()=>(await chrome.windows.getAll()).length)===beforeWindows);
 check('original website selection preserved behind modal',await card.getByRole('checkbox',{name:'字节跳动招聘',exact:true}).isChecked());
 await page.screenshot({path:path.join(dir,'01-inline-confirm.png'),fullPage:true});
 await frame.getByRole('button',{name:'取消',exact:true}).click();await modal.waitFor({state:'detached'});
 check('cancel keeps parent card and selected website',await card.isVisible() && await card.getByRole('checkbox',{name:'字节跳动招聘',exact:true}).isChecked());
 check('cancel does not grant permission',!await sw.evaluate(()=>chrome.permissions.contains({origins:['https://jobs.bytedance.com/*']})));
 await card.getByRole('button',{name:'授权选中网站',exact:true}).click();await frame.getByRole('button',{name:'确认授权',exact:true}).waitFor();
 await frame.locator('summary').click();check('domains expandable inside inline confirmation',await frame.getByText('https://jobs.bytedance.com/*',{exact:true}).isVisible());
 await frame.getByRole('button',{name:'确认授权',exact:true}).click();
 console.log('Waiting for the native Chrome permission confirmation');
 await modal.waitFor({state:'detached',timeout:90000});
 check('real Chrome optional permissions granted from iframe click',await sw.evaluate(()=>chrome.permissions.contains({origins:['https://jobs.bytedance.com/*','https://job.bytedance.com/*']})));
 await card.getByText('已授权 1 个网站',{exact:true}).waitFor();check('parent authorization count updates in place',true);
 await card.getByRole('button',{name:'管理授权',exact:true}).click();
 const manager=page.locator('[data-test=site-access-modal]');await manager.getByRole('button',{name:'撤销此网站',exact:true}).click();
 await frame.getByRole('button',{name:'确认撤销',exact:true}).click();await modal.waitFor({state:'detached'});
 await manager.getByText('已授权 0 个网站',{exact:true}).waitFor();
 check('revoke also completes inline',!await sw.evaluate(()=>chrome.permissions.contains({origins:['https://jobs.bytedance.com/*']})));
 check('backend app permission state preserved',beforeBackend===await sw.evaluate(()=>chrome.permissions.contains({origins:['http://127.0.0.1/*']})));
 check('no new windows during grant and revoke',context.pages().length===beforePages && await sw.evaluate(async()=>(await chrome.windows.getAll()).length)===beforeWindows);
 check('no page errors',errors.length===0);
 fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify({checks,errors,nativePrompt:'Native Chrome prompt accepted in isolated headed browser; real permissions.request and remove APIs, no mocks'},null,2));console.log('Artifacts: '+dir);
} catch(error) {console.error('Original failure:',error);if(page){console.log(await page.locator('body').innerText());for(const f of page.frames())if(f.url().startsWith('chrome-extension:'))console.log('Frame:',await f.locator('body').innerText());await page.screenshot({path:path.join(dir,'failure.png'),fullPage:true,timeout:5000}).catch(()=>{});}throw error;}
finally {await context?.close();await server?.stop();}
