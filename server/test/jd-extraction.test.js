import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractJd,validateExtraction,estimateUsd} from '../src/modules/jd-extraction/service.js';
const lines=['测试公司','平台工程师','北京','团队专注数据平台。','1、设计平台。','2、维护服务。','1、本科以上学历。'];
const raw={is_job:true,job_title:'平台工程师',company_name:'测试公司',location:'北京',recruitment_batch:null,sections:{团队介绍:[{line:3}],岗位职责:[{line:4},{line:5}],任职要求:[{line:6}],其他信息:[]}};
test('model references preserve original wording and separate sections',()=>{
 const job=validateExtraction(raw,lines,'https://example.com/job/1');
 assert.match(job.jd_text,/岗位职责\n1、设计平台。\n\n2、维护服务。/);
 assert.equal(job.field_confidence.job_title,'high');assert.equal(job.recruitment_batch,'');
});
test('reject invented field, invalid paragraph, changed quotation and duplicate classification',()=>{
 assert.throws(()=>validateExtraction({...raw,job_title:'不存在的岗位'},lines,''));
 for(const bad of [[{line:99}],[{line:4,quote:'编造内容'}],[{line:4},{line:4}]]){
  assert.throws(()=>validateExtraction({...raw,sections:{...raw.sections,岗位职责:bad}},lines,''));
 }
 assert.equal(validateExtraction({is_job:false},lines,''),null);
});
test('cost estimate accounts for cached input',()=>{
 const cost=estimateUsd({prompt_tokens:3000,prompt_cache_hit_tokens:1000,completion_tokens:300});
 assert.equal(cost.peak,0.000966);assert.equal(cost.off_peak,0.000483);
});
test('concurrent requests deduplicate, cache is owner scoped, failures do not cache',async()=>{
 process.env.JD_AI_ENABLED='true';process.env.JD_AI_API_KEY='fixture-only';
 let calls=0;
 const fetchImpl=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return new Response(JSON.stringify({model:'fixture',usage:{prompt_tokens:10,completion_tokens:10},choices:[{finish_reason:'stop',message:{content:JSON.stringify(raw)}}]}));};
 const input={url:'https://example.com/job/1',text:lines.join('\n')};
 const [a,b]=await Promise.all([extractJd('one',input,{fetchImpl}),extractJd('one',input,{fetchImpl})]);
 assert.equal(calls,1);assert.equal(a.cached,false);assert.equal(b.cached,true);
 assert.equal((await extractJd('one',input,{fetchImpl})).cached,true);
 await extractJd('two',input,{fetchImpl});assert.equal(calls,2);
 await assert.rejects(extractJd('failure',input,{fetchImpl:async()=>new Response('{}',{status:401})}));
 await extractJd('failure',input,{fetchImpl});assert.equal(calls,3);
 await assert.rejects(extractJd('bad',{...input,text:'x'.repeat(30001)},{fetchImpl}));
});
