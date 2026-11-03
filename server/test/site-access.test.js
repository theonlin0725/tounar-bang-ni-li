import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const context=vm.createContext({URL});
vm.runInContext(fs.readFileSync(new URL('../../extension/content/adapters.js',import.meta.url),'utf8'),context);
vm.runInContext(fs.readFileSync(new URL('../../extension/lib/site-access.js',import.meta.url),'utf8'),context);
const {groups}=context.TounarSiteAccess;
const base='http://127.0.0.1:4313';
test('backend-only grant counts zero recruitment sites',()=>{
  assert.equal(groups(['http://127.0.0.1/*'],base).filter(g=>g.granted.length).length,0);
});
test('two ByteDance domains count as one company with per-domain state',()=>{
  const list=groups(['https://jobs.bytedance.com/*','https://job.bytedance.com/*'],base);
  assert.equal(list.filter(g=>g.granted.length).length,1);
  assert.equal(list[0].id,'bytedance');
  assert.ok(list[0].domains.every(d=>d.granted));
});
test('partial domain grants remain partial',()=>{
  const group=groups(['https://jobs.bytedance.com/*'],base)[0];
  assert.equal(group.domains.filter(d=>d.granted).length,1);
  assert.equal(group.domains.find(d=>d.granted).origins[0],'https://jobs.bytedance.com/*');
});
test('wildcard authorization keeps actual permission pattern for revocation',()=>{
  const group=groups(['https://*.bytedance.com/*'],base)[0];
  assert.ok(group.domains.every(d=>d.granted));
  assert.equal(group.domains[0].origins[0],'https://*.bytedance.com/*');
});
test('custom authorized site remains visible for removal',()=>{
  const list=groups(['https://recruit.example.com/*'],base);
  assert.equal(list.find(g=>g.id==='https://recruit.example.com/*').granted.length,1);
});

test('webpage detection permissions are never counted or registered for recruitment capture',()=>{
  const origins=['http://127.0.0.1/*','http://localhost/*','https://bangnili.app.workbuddy.host/*'];
  assert.equal(groups(origins,base).filter(g=>g.granted.length).length,0);
  assert.equal(context.TounarSiteAccess.captureOrigins(origins,base).length,0);
});
