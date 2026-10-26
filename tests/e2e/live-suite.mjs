import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'../..');
const mandatory=['tencent','netease','xiaomi','oppo','pinduoduo','mihoyo','meituan','kuaishou','shixiseng','boss'];
const extra=['greenhouse','smartrecruiters'];
const labels={tencent:'腾讯',netease:'网易',xiaomi:'小米',oppo:'OPPO',pinduoduo:'拼多多',mihoyo:'米哈游',meituan:'美团',kuaishou:'快手',shixiseng:'实习僧',boss:'BOSS',greenhouse:'Yext / Greenhouse（通用）',smartrecruiters:'Talan / SmartRecruiters（通用）'};

export function summarizeLiveSuite() {
  const sites=[...mandatory,...extra].map(site=>{
    const file=path.join(root,'.tmp',site==='tencent'?'plugin-acceptance-live':`plugin-acceptance-${site}`,'report.json');
    if(site==='boss') return {site,label:labels[site],mandatory:true,status:'blocked',detail_denominator:3,list_denominator:null,error:'指定 BrowserSkill 实例 142b306a 的新 BOSS 标签返回空白；现有登录标签借用确认超时，已停止并结束会话，未绕过确认。需要用户重新明确授权借用后继续。'};
    if(!fs.existsSync(file))return {site,label:labels[site],mandatory:mandatory.includes(site),status:'not_run',error:'No report'};
    const r=JSON.parse(fs.readFileSync(file));
    const fields={correct:0,incorrect:0,missing:0,not_provided:0};
    for(const row of r.rows)for(const [field,result] of Object.entries(row.field_result)) {
      const category=result==='correct'&&!row.expected[field]?'not_provided':result;
      fields[category]=(fields[category]||0)+1;
    }
    return {site,label:labels[site],mandatory:mandatory.includes(site),status:r.failed?'failed':'passed',generated_at:r.generated_at,truth_sampled_at:r.truth_sampled_at,source_fingerprint:r.source_fingerprint||null,checks_passed:r.checks.filter(c=>c.ok).length,checks_total:r.checks.length,...r.metrics,fields,report_path:file,trace_path:path.join(path.dirname(file),'trace.zip')};
  });
  const tested=sites.filter(s=>s.status!=='blocked'&&s.status!=='not_run');
  const total=key=>tested.reduce((n,s)=>n+(s[key]||0),0);
  const fields=tested.reduce((a,s)=>{for(const k of Object.keys(a))a[k]+=s.fields[k];return a;},{correct:0,incorrect:0,missing:0,not_provided:0});
  const summary={generated_at:new Date().toISOString(),permission_mode:'Manifest pregrant: real extension/backend/frontend; native permission UI excluded',mandatory_passed:sites.filter(s=>s.mandatory&&s.status==='passed').length,mandatory_total:10,details:{accurate:total('accurate_details'),tested:total('detail_denominator'),required_mandatory:30},lists:{accurate:total('accurate_list_items'),tested:total('list_denominator')},fields,sites,not_completed:['BOSS 正常登录列表及 3 个详情','Chrome 原生首次权限允许/拒绝/撤销','全链路 P50/P95 与分阶段性能采样','后端 4xx/5xx、验证码/聊天/空列表等尚未单独覆盖的异常矩阵'],complete:false};
  const dir=path.join(root,'.tmp/plugin-acceptance-suite');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(summary,null,2)+'\n');
  const table=sites.map(s=>`| ${s.label} | ${s.status} | ${s.accurate_list_items??'—'}/${s.list_denominator??'—'} | ${s.accurate_details??0}/${s.detail_denominator??'—'} | ${s.fields?`${s.fields.correct} / ${s.fields.correct+s.fields.incorrect+s.fields.missing}`:'—'} |`).join('\n');
  fs.writeFileSync(path.join(dir,'report.md'),`# 插件联网验收汇总\n\n生成时间：${summary.generated_at}\n\n必选站 ${summary.mandatory_passed}/10 通过。真实浏览器扩展采用 manifest 预授权；不代表原生首次授权已通过。\n\n| 站点 | 状态 | 准确列表记录 | 准确详情 | 有值字段正确/检查数 |\n|---|---|---:|---:|---:|\n${table}\n\n原页未提供的空字段 ${fields.not_provided} 个，不计入有值字段准确率。详情需字段正确、生成正确 application_id、前端自动可见且不重复才计成功。JD 按独立真值逐字比对，区块间统一一个空行。\n\n未完成：\n\n${summary.not_completed.map(s=>'- '+s).join('\n')}\n\n每条 expected/actual、字段来源、模板版本、事件 ID、回执、前端截图和 trace 位于对应站点 report.json 及其目录。采样名单在 tests/fixtures/live 固定；测试不会自动改 expected。网页内容变化必须重新独立采样并保留旧版本。\n`);
  return summary;
}

export async function runLiveSuite() {
  const queue=[...mandatory.filter(s=>s!=='boss'),...extra];
  await Promise.all(Array.from({length:3},async()=>{
    while(queue.length){const site=queue.shift();const log=fs.openSync(path.join(root,`.tmp/acceptance-${site}.log`),'w');
      const code=await new Promise(resolve=>{const child=spawn(process.execPath,[path.join(root,'tests/e2e/plugin-acceptance.mjs'),site==='tencent'?'--real-sites':`--site=${site}`],{cwd:root,stdio:['ignore',log,log]});child.once('error',()=>resolve(1));child.once('exit',c=>resolve(c??1));});fs.closeSync(log);console.log(`${site}: ${code===0?'passed':'failed'}`);
    }
  }));
  const summary=summarizeLiveSuite();console.log(`必选站 ${summary.mandatory_passed}/10；完整验收仍有阻塞，详情见 .tmp/plugin-acceptance-suite/report.json`);
  return 1; // The frozen BOSS + native permission/performance requirements remain open.
}
