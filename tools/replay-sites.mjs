// Replay real sanitized DOM offline, optionally with the pinned pre-change code.
// No remote navigation: every request is fulfilled from the local snapshot.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../tests/e2e/browser.mjs';
const root=path.resolve(import.meta.dirname,'..');
const option=name=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:null;};
const ref=option('--ref');
if(ref&&!/^[0-9a-f]{7,40}$/i.test(ref))throw new Error('--ref must be a pinned commit hash');
const code=name=>ref?execFileSync('git',['show',`${ref}:extension/content/${name}.js`],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,`extension/content/${name}.js`),'utf8');
const scripts=[code('adapters'),code('tracker')];
const cases=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/sites/cases.json'),'utf8'));
if(!cases.length)throw new Error('No real snapshots: real-site replay was not run');
const resolved=await resolveChromiumExecutable();
if(!resolved)throw new Error('Install Playwright Chromium first');
const browser=await chromium.launch({executablePath:resolved.path,headless:true});
const rows=[];let index=0;
try{
  async function work(){while(index<cases.length){const fixture=cases[index++];const context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}});
    try{
      const html=fs.readFileSync(path.join(root,'tests/fixtures/sites',fixture.file),'utf8');
      await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html}));
      const page=await context.newPage();await page.addInitScript(()=>{window.__captured=[];window.chrome={runtime:{sendMessage(message,callback){window.__captured.push(message?.event);callback?.({ok:true});}}};});
      await page.goto(fixture.url);for(const script of scripts)await page.addScriptTag({content:script});
      await page.waitForFunction(()=>window.__captured.some(event=>event?.event_type==='job_viewed'),null,{timeout:7500}).catch(()=>{});
      const event=await page.evaluate(()=>window.__captured.find(event=>event?.event_type==='job_viewed'));
      const payload=event?.payload||{};const truth={...fixture.expected,...fixture.truth};
      const fields=Object.fromEntries(Object.keys(fixture.expected).map(key=>[key,{expected:truth[key],actual:payload[key]||'',verdict:!payload[key]?'empty':payload[key]===truth[key]?'correct':'wrong'}]));
      const regression=!!event&&Object.entries(fixture.expected).every(([key,value])=>(payload[key]||'')===value);
      rows.push({site:fixture.site,file:fixture.file,url:fixture.url,captured_at:fixture.captured_at,event_type:event?.event_type||null,fields,regression});
      console.log(fixture.file,regression?'expected':'diff',Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,value.verdict])));
    }finally{await context.close();}
  }}
  await Promise.all([work(),work()]);
}finally{await browser.close();}
rows.sort((a,b)=>a.file.localeCompare(b.file));
const report={code_ref:ref||'working-tree',mode:'offline replay of real sanitized DOM',rows};
const destination=option('--report');if(destination){fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');}
if(!ref&&rows.some(row=>!row.regression))process.exitCode=1;
