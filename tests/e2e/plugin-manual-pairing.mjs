// Manual pairing fallback must work when the page bridge is unavailable.
// The fixture removes content/app-bridge.js and the static content script, so
// only the popup code + logged-in web session can bind the device.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startTestServer} from '../../server/test/helpers.js';

const root=path.resolve(import.meta.dirname,'../..');
const dir=path.join(root,'.tmp','plugin-manual-pairing-'+Date.now());fs.mkdirSync(dir,{recursive:true});
const checks=[];let server,context;
function check(name,value){assert.ok(value,name);checks.push(name);console.log('PASS '+name);}
try {
  server=await startTestServer({name:'plugin-manual-pairing-'+Date.now()});
  const ext=path.join(dir,'extension');fs.cpSync(path.join(root,'extension'),ext,{recursive:true});
  fs.rmSync(path.join(ext,'content/app-bridge.js'),{force:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(ext,'manifest.json')));
  delete manifest.content_scripts;
  manifest.host_permissions=['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify(manifest));
  const executablePath=process.env.E2E_CHROME;
  context=await chromium.launchPersistentContext(path.join(dir,'profile'),{headless:true,...(executablePath?{executablePath}:{}),args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
  const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const errors=[];context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  await sw.evaluate(async base=>{await TounarCommon.setSettings({serverUrl:base});},server.base);
  const cookie=(await server.login('demo@tounar.local')).cookie;
  const [name,...value]=cookie.split(';')[0].split('=');await context.addCookies([{name,value:value.join('='),url:server.base}]);
  const page=await context.newPage();await page.goto(server.base);
  await page.locator('[data-test=plugin-install-modal]').waitFor({timeout:20000});
  // Simulate the web auto-connect flow already having created a pending pairing.
  const first=await sw.evaluate(async base=>startPairing({serverUrl:base,deviceName:'Web auto pairing'}),server.base);
  const popup=await context.newPage();
  await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup/popup.html`);
  await popup.locator('#start-pairing').waitFor();
  await popup.click('#start-pairing');
  await popup.waitForFunction(()=>/^[A-Z2-9]{8}$/.test(document.getElementById('pairing-code').textContent.trim()),null,{timeout:10000});
  const code=(await popup.textContent('#pairing-code')).trim();
  check('popup reuses the pending web pairing instead of replacing it',code===first.code);
  check('popup shows an 8-character pairing code',/^[A-Z2-9]{8}$/.test(code));
  await page.getByText('自动检测不到？用手动配对码连接',{exact:true}).click();
  const modal=page.locator('[data-test=plugin-install-modal]');
  await modal.locator('[data-test=pair-code]').fill(code.toLowerCase());
  await modal.locator('[data-test=pair-approve]').click();
  await modal.getByText(/已绑定设备/).waitFor();
  check('manual code binds device without page bridge',true);
  await popup.click('#poll-pairing');
  await popup.locator('#paired').waitFor({state:'visible',timeout:10000});
  check('popup polling completes exchange',true);
  check('device token stored',!!(await sw.evaluate(async()=>(await TounarCommon.getSettings()).deviceToken)));
  check('no page errors',errors.length===0);
  fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify({checks,errors},null,2));
  console.log(JSON.stringify({passed:checks.length,provider:'no bridge; manual fallback only'}));
} finally {await context?.close();await server?.stop();}
