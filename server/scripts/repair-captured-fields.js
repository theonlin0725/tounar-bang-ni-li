/* Review the JSON plan first. This never repairs production data automatically. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const file=path.resolve(option('--db','data/tounar.sqlite'));
const applying=args.includes('--apply');
if(applying&&(!args.includes('--confirm')||!option('--plan',null)))throw Error('先审阅 dry-run 清单；执行需 --apply --confirm --plan <已审阅文件>');
const db=new DatabaseSync(file,{readOnly:!applying});
const sources=db.prepare('SELECT * FROM application_field_sources WHERE application_id=? AND owner_id=?');
function plan(){
  const rows=[];
  for(const app of db.prepare('SELECT * FROM applications').all()){
    const source=Object.fromEntries(sources.all(app.id,app.owner_id).map(x=>[x.field,x]));
    const fields={};let host='';try{host=new URL(app.job_url).hostname.replace(/^www\./,'').split('.')[0];}catch{}
    const suspicious={company_name:host&&app.company_name.toLowerCase()===host.toLowerCase(),job_title:/招聘|官网|首页|加载中/.test(app.job_title),jd_summary:/首页.*(登录|注册)|导航|隐私政策|版权所有/.test(app.jd_summary||'')};
    for(const [key,flag]of Object.entries(suspicious))if(flag&&source[key]?.source_method!=='manual'&&source[key]?.confidence!=='high')fields[key]={from:app[key],to:key==='jd_summary'?null:'',reason:'疑似旧兜底误采，需人工审阅'};
    if(Object.keys(fields).length)rows.push({application_id:app.id,owner_id:app.owner_id,version:app.version,fields});
  }
  return rows;
}
try{
  const rows=plan();
  if(!applying){const out={database:file,generated_at:new Date().toISOString(),items:rows};const destination=option('--out',null);if(destination)fs.writeFileSync(destination,JSON.stringify(out,null,2),{mode:0o600});console.log(JSON.stringify(out,null,2));}
  else{
    const approved=JSON.parse(fs.readFileSync(option('--plan'), 'utf8'));
    if(approved.database!==file||JSON.stringify(approved.items)!==JSON.stringify(rows))throw Error('数据库或清单已变化，请重新 dry-run 并审阅');
    const backupPath=file+'.pre-field-repair-'+Date.now()+'.backup';await backup(db,backupPath);
    db.exec('BEGIN IMMEDIATE');
    try{
      // Recheck under the write lock so a stale plan cannot overwrite new user edits.
      if(JSON.stringify(plan())!==JSON.stringify(approved.items))throw Error('记录已变化，请重新审阅');
      for(const row of rows){const at=new Date().toISOString(),id='hist_'+crypto.randomUUID(),changes={};
        for(const [key,change]of Object.entries(row.fields)){
          db.prepare(`UPDATE applications SET ${key}=? WHERE id=? AND owner_id=?`).run(change.to,row.application_id,row.owner_id);
          if(key==='company_name')db.prepare('UPDATE applications SET company_key=? WHERE id=?').run('',row.application_id);
          db.prepare("UPDATE application_field_sources SET confidence='low', source_detail='legacy_repair', updated_at=? WHERE application_id=? AND field=? AND owner_id=?").run(at,row.application_id,key,row.owner_id);
          changes[key]={from:change.from,to:change.to};
        }
        db.prepare('UPDATE applications SET version=version+1,updated_at=? WHERE id=?').run(at,row.application_id);
        db.prepare("INSERT INTO application_history(id,owner_id,application_id,from_status,to_status,changed_fields_json,changed_at,source_method,reason) SELECT ?,owner_id,id,status,status,?,?,'manual','用户审阅后执行旧采集字段修复' FROM applications WHERE id=?").run(id,JSON.stringify(changes),at,row.application_id);
        db.prepare("INSERT INTO audit_log(id,owner_id,actor,action,target_type,target_id,meta_json,created_at) VALUES (?,?,'user','application.legacy_capture_repair','application',?,?,?)").run('aud_'+crypto.randomUUID(),row.owner_id,row.application_id,JSON.stringify({fields:Object.keys(row.fields)}),at);
      }
      db.prepare("UPDATE meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='data_revision'").run();db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    console.log(JSON.stringify({updated:rows.length,backup:backupPath}));
  }
}finally{db.close();}
