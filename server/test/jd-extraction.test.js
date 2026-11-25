import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {extractJd,validateExtraction,estimateUsd} from '../src/modules/jd-extraction/service.js';
import {recognizeJdCompany} from '../src/modules/jd-extraction/vision.js';
const lines=['测试公司','平台工程师','北京','团队专注数据平台。','1、设计平台。','2、维护服务。','1、本科以上学历。'];
const raw={is_job:true,job_title:'平台工程师',company_name:'测试公司',location:'北京',recruitment_batch:null,sections:{团队介绍:[{line:3}],岗位职责:[{line:4},{line:5}],任职要求:[{line:6}],其他信息:[]}};
test('model references preserve original wording and separate sections',()=>{
 const job=validateExtraction(raw,lines,'https://example.com/job/1');
 assert.match(job.jd_text,/岗位职责\n1、设计平台。\n\n2、维护服务。/);
 assert.equal(job.field_confidence.job_title,'high');assert.equal(job.recruitment_batch,'');
});
test('影石 aliases normalize only after the original company name is verified', () => {
 for (const company of ['影石科技股份有限公司','影石创新科技股份有限公司','影石Insta360','Insta360']) {
  assert.equal(validateExtraction({...raw,company_name:company},[company,...lines.slice(1)],'').company_name,'影石');
 }
 assert.throws(()=>validateExtraction({...raw,company_name:'影石科技股份有限公司'},['影石',...lines.slice(1)],''));
 assert.equal(validateExtraction(raw,lines,'').company_name,'测试公司');
});
test('reject invented field, invalid paragraph, changed quotation and duplicate classification',()=>{
 assert.equal(validateExtraction({...raw,job_title:'不存在的岗位'},lines,'').job_title,'');
 assert.throws(()=>validateExtraction({...raw,company_name:'不存在的公司'},lines,''));
 for(const bad of [[{line:99}],[{line:4,quote:'编造内容'}],[{line:4},{line:4}]]){
  assert.throws(()=>validateExtraction({...raw,sections:{...raw.sections,岗位职责:bad}},lines,''));
 }
 assert.equal(validateExtraction({is_job:false},lines,''),null);
});

test('title can come from anywhere in the original text, never a label or location',()=>{
 const titleLines=[...lines,'工作地点','平台工程师（数据方向）'];
 const ok=validateExtraction({...raw,job_title_line:8},titleLines,'https://example.com/job/1');
 assert.equal(ok.job_title,'平台工程师（数据方向）');assert.equal(ok.field_sources.job_title,'model_source_quote');
 for (const job_title_line of [2,7,99,null]) {
  const invalid=validateExtraction({...raw,job_title_line},titleLines,'https://example.com/job/1');
  assert.equal(invalid.job_title,'');assert.equal(invalid.job_title_status,'pending');assert.match(invalid.jd_text,/岗位职责/);
 }
 const flat=validateExtraction({...raw,job_title:'工作地点'},lines,'https://example.com/job/1');
 assert.equal(flat.job_title,'');
});
test('cost estimate accounts for cached input',()=>{
 const cost=estimateUsd({prompt_tokens:3000,prompt_cache_hit_tokens:1000,completion_tokens:300});
 assert.equal(cost.peak,0.000966);assert.equal(cost.off_peak,0.000483);
});

test('vision ticket requires a confirmed JD with no company and calls Qwen at most once', async () => {
 const env = {JD_AI_ENABLED:'true',JD_AI_API_KEY:'text-test',JD_VISION_ENABLED:'true',JD_VISION_API_KEY:'vision-test',
  JD_VISION_API_URL:'https://maas.qianwenaiapi.com/compatible-mode/v1'};
 const old = Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
 Object.assign(process.env,env);
 try {
  const input={url:'https://example.com/jobs/vision-test',text:lines.join('\n')};
  const textResponse = (data) => async () => new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(data)}}]}));
  assert.equal((await extractJd('with-name',input,{visionDevice:'dev1',fetchImpl:textResponse(raw)})).vision_ticket,undefined);
  assert.equal((await extractJd('not-a-job',input,{visionDevice:'dev1',fetchImpl:textResponse({is_job:false})})).vision_ticket,undefined);
  const options = {visionDevice:'dev1',fetchImpl:textResponse({...raw,company_name:null})};
  const text = await extractJd('vision-owner',input,options);
  assert.equal(text.job.company_name,'');
  assert.match(text.vision_ticket,/^[a-f0-9]{64}$/);
  const body={url:input.url,ticket:text.vision_ticket,image:'data:image/jpeg;base64,/9j/AAAA'};
  await assert.rejects(recognizeJdCompany('vision-owner','other-device',body),{code:'JD_VISION_TICKET'});
  await assert.rejects(recognizeJdCompany('vision-owner','dev1',{...body,image:'https://example.com/private.jpg'}),{code:'JD_VISION_IMAGE'});
  let calls=0;
  const fetchImpl = async (url, req) => {
   calls++;
   assert.equal(url,env.JD_VISION_API_URL+'/chat/completions');
   const request=JSON.parse(req.body);
   assert.equal(request.model,'qwen3.6-flash');
   assert.equal(request.messages[0].content[1].image_url.url,body.image);
   assert.equal(req.redirect,'error');
   return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"company_name":"影石科技股份有限公司","company_evidence":"招聘主体：影石科技股份有限公司"}'}}]}));
  };
  const both=await Promise.all(Array.from({length:2},()=>recognizeJdCompany('vision-owner','dev1',body,fetchImpl)));
  assert.equal(calls,1);
  assert.deepEqual(both[0].suggestion,{company_name:'影石',company_evidence:'招聘主体：影石科技股份有限公司',source:'vision',needs_review:true});
  assert.equal((await extractJd('vision-owner',input,options)).vision_ticket,undefined);
 } finally {
  Object.entries(old).forEach(([k,v])=>{if(v===undefined) delete process.env[k]; else process.env[k]=v;});
 }
});

test('screenshot covers the scrollable document and is discarded after a navigation', async () => {
 const url='https://example.com/jobs/1';
 let current=url, detached=0, clip;
 const chrome={tabs:{get:async()=>({active:true,status:'complete',url:current})},debugger:{
  attach:async()=>{},detach:async()=>{detached++;},
  sendCommand:async(_target, method, params)=>{
   if(method==='Page.getLayoutMetrics') return {cssContentSize:{width:1200,height:3800}};
   clip=params.clip;
   assert.equal(params.captureBeyondViewport,true);
   current='https://example.com/jobs/2';
   return {data:'/9j/AAAA'};
  }
 }};
 const context=vm.createContext({chrome});
 vm.runInContext(fs.readFileSync(new URL('../../extension/background/jd-screenshot.js',import.meta.url),'utf8'),context);
 assert.equal(await context.captureJdFullPage({tab:{id:1},documentId:'doc-1'},url),null);
 assert.equal(clip.height,3800);
 assert.equal(clip.width,1200);
 assert.equal(detached,1);
 assert.equal(context.jdScreenshotClip({width:1200,height:20000}),null);
});

test('Dify is opt-in for plugin requests and preserves server-side extraction validation', async () => {
 const names = ['JD_AI_ENABLED','JD_AI_API_KEY','JD_DIFY_API_URL','JD_DIFY_API_KEY'];
 const old = names.map(name => process.env[name]);
 Object.assign(process.env,{JD_AI_ENABLED:'true',JD_AI_API_KEY:'fixture-direct',JD_DIFY_API_URL:'https://fixture.example/v1',JD_DIFY_API_KEY:'fixture-dify'});
 try {
  const input = {url:'https://example.com/jobs/dify?tracking=private',text:lines.join('\n')};
  let calls = 0;
  const fetchImpl = async (url, options) => {
   calls++;
   assert.equal(url,'https://fixture.example/v1/workflows/run');
   assert.equal(options.headers.Authorization,'Bearer fixture-dify');
   const payload = JSON.parse(options.body);
   assert.match(payload.user,/^jd-[0-9a-f]{32}$/);
   assert.equal(payload.inputs.page_text,input.text);
   assert.equal(JSON.parse(payload.inputs.extraction_input).url,'https://example.com/jobs/dify');
   assert.equal(payload.inputs.brand_crop,undefined);
   return new Response(JSON.stringify({data:{status:'succeeded',outputs:{extraction:raw}}}));
  };
  const result = await extractJd('fixture-dify',input,{fetchImpl,allowDify:true});
  assert.equal(result.job.company_name,'测试公司');
  assert.equal(result.estimated_cost,null);
  assert.equal((await extractJd('fixture-dify',input,{fetchImpl,allowDify:true})).cached,true);
  assert.equal(calls,1);
  await assert.rejects(extractJd('fixture-dify',input,{fetchImpl:async url=>{
   assert.equal(url,'https://api.deepseek.com/chat/completions');
   return new Response('{}',{status:401});
  }}),{code:'JD_PROVIDER_ERROR'});
  await assert.rejects(extractJd('fixture-dify-invalid',input,{allowDify:true,fetchImpl:async()=>new Response(JSON.stringify({
   data:{status:'succeeded',outputs:{extraction:{...raw,company_name:'原文没有的公司'}}}
  }))}),{code:'JD_INVALID_RESULT'});
 } finally {
  names.forEach((name,i)=>{ if(old[i]===undefined) delete process.env[name]; else process.env[name]=old[i]; });
 }
});

test('model receives every original line and ignores old client title candidates',async()=>{
 process.env.JD_AI_ENABLED='true';process.env.JD_AI_API_KEY='fixture-only';
 let body=null,calls=0;
 const fetchImpl=async(_url,opts)=>{calls++;body=JSON.parse(opts.body);return new Response(JSON.stringify({model:'fixture',usage:{},choices:[{finish_reason:'stop',message:{content:JSON.stringify({...raw,job_title_line:1,job_title:undefined})}}]}));};
 const candidates=[{id:'t1',text:'杭州',source:'page_title'}];
 const titleLines=[...lines,'杭州'];
 const result=await extractJd('title-owner',{url:'https://example.com/job/title',text:titleLines.join('\n'),title_candidates:candidates},{fetchImpl});
 assert.equal(result.job.job_title,'平台工程师');
 assert.equal(result.job.field_sources.job_title,'model_source_quote');
 const payload=JSON.parse(body.messages[1].content);
 assert.equal(payload.title_candidates,undefined);
 assert.deepEqual(payload.paragraphs.map(p=>p.text),titleLines);
 const before=calls;
 await extractJd('title-owner',{url:'https://example.com/job/title',text:titleLines.join('\n'),title_candidates:[{id:'t9',text:'平台工程师',source:'visible_title_node'}]},{fetchImpl});
 assert.equal(calls,before);
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

test('标题与标签同行：只允许摘录指定原文行中真实存在的标题', () => {
 const parent = '游戏设计师（战斗策划） 游戏热爱';
 const clean = '游戏设计师（战斗策划）';
 const titleLines = [parent, '岗位描述', '负责战斗技能设计。', '岗位要求', '热爱游戏。'];
 const rawTitle = { is_job: true, job_title_line: 0, company_name: null, location: null, recruitment_batch: null,
   sections: { 团队介绍: [], 岗位职责: [{ line: 2 }], 任职要求: [{ line: 4 }], 其他信息: [] } };
 const bad = validateExtraction({ ...rawTitle, job_title_quote: '高级' + clean }, titleLines, '');
 assert.equal(bad.job_title, '');
 assert.equal(bad.job_title_status, 'pending');
 assert.equal(validateExtraction({ ...rawTitle, job_title_line: 4, job_title_quote: clean }, titleLines, '').job_title, '');
 const good = validateExtraction({ ...rawTitle, job_title_quote: clean }, titleLines, '');
 assert.equal(good.job_title, clean);
 assert.equal(good.field_sources.job_title, 'model_source_quote');
});
