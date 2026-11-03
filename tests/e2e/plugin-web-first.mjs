// Production manifest, no host pregrants, no popup clicks, no preconfigured backend.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startTestServer} from '../../server/test/helpers.js';
const root=path.resolve(import.meta.dirname,'../..');
const dir=path.join(root,'.tmp','plugin-web-first-'+Date.now());fs.mkdirSync(dir,{recursive:true});
let context,server,missingContext;
const checks=[];function check(name,ok){assert.ok(ok,name);checks.push(name);console.log('PASS '+name);}
async function login(context, email) {
 const cookie=(await server.login(email)).cookie;const [name,...value]=cookie.split(';')[0].split('=');
 await context.addCookies([{name,value:value.join('='),url:server.base}]);
}
try {
 server=await startTestServer({name:'plugin-web-first-'+Date.now()});
 const ext=path.join(root,'extension');
 const executablePath=process.env.E2E_CHROME;
 context=await chromium.launchPersistentContext(path.join(dir,'profile'),{headless:true,...(executablePath?{executablePath}:{}),args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
 const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.base);await page.locator('[data-test=login-email]').waitFor();
 check('logged out page does not prompt binding',await page.locator('[data-test=plugin-connect-modal]').count()===0);
 await page.evaluate(()=>sessionStorage.setItem('tounar.plugin.onboarding.demo@tounar.local','missing'));
 await login(context,'demo@tounar.local');await page.reload();
 await page.locator('[data-test=plugin-connect-confirm]').waitFor();
 check('closing prior missing-plugin guidance does not block installed-plugin connection',true);
 await page.evaluate(()=>sessionStorage.setItem('tounar.plugin.onboarding.demo@tounar.local','1'));
 await page.reload();await page.locator('[data-test=plugin-connect-confirm]').waitFor();
 check('legacy dismissed flag recovers once plugin is detected',true);
 check('opening logged-in website automatically prompts connection',true);
 const before=await sw.evaluate(()=>TounarCommon.getSettings());
 check('no pairing or backend switch before consent',!before.pendingPairing && !before.deviceToken && before.serverUrl==='http://127.0.0.1:4310');
 check('connection dialog has no placeholder artifacts',!(await page.locator('[data-test=plugin-connect-modal]').innerText()).includes('null'));
 check('no manual pairing input',await page.locator('[data-test=pair-code]').count()===0);
 await page.screenshot({path:path.join(dir,'01-auto-connect.png'),fullPage:true});
 await page.getByRole('button',{name:'暂不连接',exact:true}).click();
 await page.reload();await page.waitForTimeout(4500);
 check('dismissed prompt does not recur on refresh this visit',await page.locator('[data-test=plugin-connect-modal]').count()===0);
 await page.evaluate(async()=>{const m=await import('/assets/js/views/plugin-access.js');await m.promptPluginConnection();});
 await page.locator('[data-test=plugin-connect-confirm]').click();
 await page.locator('[data-test=site-access-modal]').waitFor();
 await page.getByRole('checkbox',{name:'字节跳动招聘',exact:true}).waitFor();
 check('confirm binds directly without visiting popup',await sw.evaluate(async()=>!!(await TounarCommon.getSettings()).deviceToken));
 check('website selects its own backend only after consent',await sw.evaluate(async base=>new URL((await TounarCommon.getSettings()).serverUrl).origin===base,server.base));
 check('authorization opens automatically after binding',true);
 check('ByteDance preselected',await page.getByRole('checkbox',{name:'字节跳动招聘',exact:true}).isChecked());
 check('other companies initially collapsed',await page.getByRole('checkbox',{name:'腾讯招聘',exact:true}).count()===0);
 const permissions=await sw.evaluate(()=>chrome.permissions.getAll());
 check('app detection alone registers no recruitment capture script',await sw.evaluate(async()=>!(await chrome.scripting.getRegisteredContentScripts()).some(s=>s.id==='tounar-tracker')));
 check('preselection grants no recruiting host permission',!(permissions.origins||[]).some(x=>x.includes('bytedance')));
 await page.screenshot({path:path.join(dir,'02-auto-sites.png'),fullPage:true});
 await page.reload();await page.waitForTimeout(1200);
 check('already connected account has no repeat prompt',await page.locator('[data-test=plugin-connect-modal]').count()===0);
 await login(context,'peer@tounar.local');await page.reload();await page.locator('[data-test=plugin-connect-confirm]').waitFor();
 check('other account prompts explicit reconnection',await page.getByText('插件已有其他连接。确认后将连接到当前账号和网页，已有台账保留。').isVisible());
 await page.getByRole('button',{name:'暂不连接',exact:true}).click();
 const after=await sw.evaluate(()=>TounarCommon.getSettings());check('declining account switch retains original owner',after.pairedOwnerHint==='demo@tounar.local');
 const blocked=await sw.evaluate(async()=>{try{await webAccess({action:'begin'},{tab:{id:1},frameId:0,url:'https://untrusted.example/'});return false;}catch{return true;}});
 check('untrusted site cannot initiate binding',blocked);
 missingContext=await chromium.launchPersistentContext(path.join(dir,'no-extension'),{headless:true,...(executablePath?{executablePath}:{})});
 await login(missingContext,'demo@tounar.local');const noPlugin=await missingContext.newPage();await noPlugin.goto(server.base);
 await noPlugin.locator('[data-test=plugin-install-modal]').waitFor();check('missing plugin shows installation guidance',true);
 await noPlugin.getByRole('button',{name:'暂不连接',exact:true}).click();await noPlugin.reload();await noPlugin.waitForTimeout(4500);
 check('missing-plugin guidance respects dismiss',await noPlugin.locator('[data-test=plugin-install-modal]').count()===0);
 check('no page errors',errors.length===0);
 fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify({checks,permissions,errors},null,2));console.log('Artifacts: '+dir);
} catch (error) { if(context) for(const p of context.pages()) {console.log((await p.locator('body').innerText().catch(()=>'' )).slice(-4000));} throw error; } finally {await missingContext?.close();await context?.close();await server?.stop();}
