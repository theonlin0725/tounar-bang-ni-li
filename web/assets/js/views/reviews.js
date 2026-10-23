/* 人工复核：建议、证据、搜索关联、批量与可撤销提交。 */
import { api } from '../api.js';
import { isStale } from '../app.js';
import { h, clear, toast, confirmDialog, fmtDateTime, idemKey, STATUS_LABELS, STATUS_ORDER } from '../util.js';
const NEEDS_TIME = new Set(['applied','assessment','interview','offer','rejected']);
const LABELS = { mail_progress:'邮件进展待确认', terminal_candidate:'录用 / 拒信待确认', terminal_conflict:'终态冲突', status_conflict:'进度待确认', application_confirmation:'申请待确认', field_missing:'字段待补充', suspect_view:'浏览线索', ambiguous_match:'匹配待确认', suspect_submission:'疑似已提交' };
function humanError(err) {
  if(err.status===409) return '这条刚被更新过，已刷新，请再确认一次';
  if(['D12_NOT_FROZEN','D12_MISSING_APPLIED_AT'].includes(err.code)) return '请补充投递时间后提交；邮件推断时间未启用时需要你填写。';
  if(err.code==='D05_DISABLED') return '当前关闭了终态纠错，请联系管理员。';
  if(err.code==='APPLIED_FACT_REMOVAL') return '不能通过此操作撤销已经投递的事实，请在详情中纠错。';
  if(err.code==='UNDO_EXPIRED') return '撤销时间已过，请在台账详情中纠错。';
  return String(err.message || '提交失败，请稍后重试').replace(/D\d{2}[^，。；]*/g,'请补充必要信息');
}
function localInput(iso) {
  if(!iso || !Number.isFinite(Date.parse(iso))) return '';
  const p=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso));
  return p.replace(' ','T');
}
export async function renderReviews(container,{gen,onChanged}={}) {
  const root=h('div',{class:'tn-reviews','data-test':'reviews-view'}); container.append(root);
  const notices=h('div',{}), list=h('div',{}), total=h('span',{'data-test':'review-total'});
  const batch=h('button',{class:'tn-btn tn-btn-sm','data-test':'reviews-batch',text:'把握度 ≥ 80% 的全部按系统判断确认',onclick:confirmBatch});
  root.append(h('div',{class:'tn-toolbar'},h('strong',{text:'待确认'}),total,batch,h('button',{class:'tn-btn tn-btn-sm','data-test':'reviews-refresh',text:'刷新',onclick:load})),notices,list);
  let items=[],seq=0,busy=false;
  const failures=new Map();
  const active=()=>!isStale(gen)&&root.isConnected;
  async function load() {
    const request=++seq;
    try {
      const collected=[]; let cursor=null;
      do {
        const r=await api.get('/api/v1/review-items?status=open&limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
        if(!active()||request!==seq)return;
        collected.push(...r.data);cursor=r.page?.next_cursor;
      }while(cursor);
      items=collected; total.textContent=`${items.length} 条`;
      render();
    }catch(err){if(active())toast('无法加载待确认：'+humanError(err),'err');}
  }
  function render(){clear(list);if(!items.length)list.append(h('p',{class:'tn-muted',text:'没有待确认项'}));for(const r of items)list.append(card(r));}
  function notify(){if(active()&&onChanged)onChanged();}
  function undoNotice(r,result){
    if(!active())return;
    const n=h('div',{class:'tn-banner info'});
    const until=Date.parse(result.review.resolution_json ? JSON.parse(result.review.resolution_json).undo_until : '') || Date.now()+10000;
    const button=h('button',{class:'tn-btn tn-btn-sm','data-test':'review-undo',text:'撤销（10 秒内）',onclick:async()=>{
      button.disabled=true;
      try{await api.post(`/api/v1/review-items/${r.id}/undo`,{expected_version:result.review.version},{idempotencyKey:idemKey('review-undo')});if(!active())return;n.remove();toast('已撤销，待确认项已恢复','ok');notify();await load();}
      catch(e){if(active()){toast(humanError(e),'err');button.disabled=false;}}
    }});
    n.append(h('span',{text:'本次操作已提交。'}),button);notices.prepend(n);
    setTimeout(()=>n.remove(),Math.max(0,until-Date.now()));
  }
  async function submit(r,{action='confirm',target,changes={},expectedVersion=r.version}={}){
    const body={action,expected_version:expectedVersion,changes};
    if(target){const a=(await api.get(`/api/v1/applications/${encodeURIComponent(target)}`)).data;body.application_id=a.id;body.expected_application_version=a.version;}
    if(!active())return;
    const result=(await api.post(`/api/v1/review-items/${r.id}/resolve`,body,{idempotencyKey:idemKey('review-'+action)})).data;
    if(!active())return;
    const app=result.application;
    toast(app?`已更新：${app.company_name}·${app.job_title} → ${STATUS_LABELS[app.status]}（已确认并应用建议）`:'已忽略该线索','ok');
    undoNotice(r,result);notify();return result;
  }
  async function confirmBatch(){
    if(busy)return;
    const eligible=items.filter(r=>Number(r.total_confidence)>=0.8&&(r.suggested_application_id||r.candidates?.length===1)&&r.suggested_changes?.status);
    if(!eligible.length){toast('没有可按系统判断批量确认的记录');return;}
    if(!await confirmDialog({title:'批量确认？',message:`将逐条处理 ${eligible.length} 条；失败的保留在列表中。`,confirmLabel:'确认'}))return;
    busy=true;batch.disabled=true;
    try{for(const r of eligible){if(!active())break;try{await submit(r,{target:r.suggested_application_id||r.candidates[0].application_id});failures.delete(r.id);}catch(e){failures.set(r.id,humanError(e));}}await load();}
    finally{busy=false;batch.disabled=false;}
  }
  function card(r){
    const pre=r.suggested_changes||{},e=r.evidence||{},cs=r.candidates||[];
    let selected=r.suggested_application_id||(cs.length===1?cs[0].application_id:''),working=false,searchSeq=0;
    const el=h('div',{class:'tn-review-card','data-test':'review-card','data-review-id':r.id});
    const pct=r.total_confidence==null?null:Math.round(r.total_confidence*100);
    const threshold=['offer','rejected','closed'].includes(pre.status)?90:80;
    el.append(h('h3',{class:'tn-review-title',text:pre.company_name||pre.job_title?`系统判断：${r.mail_received_at?fmtDateTime(r.mail_received_at)+' 收到的邮件，是 ':''}${pre.company_name||cs[0]?.company_name||'待补充公司'} · ${pre.job_title||cs[0]?.job_title||'待补充岗位'}的${STATUS_LABELS[pre.status]||'招聘进展'}`:r.summary}),h('p',{class:'tn-small tn-muted',text:`${LABELS[r.kind]||'线索待确认'} · ${r.mail_received_at?'邮件收到于 '+fmtDateTime(r.mail_received_at):fmtDateTime(r.created_at)}`}),h('p',{text:pct===null?'系统证据不足，请你确认。':`系统把握度 ${pct}%（自动更新要求至少 ${threshold}%，且记录唯一、状态不回退；请你确认归属和状态）`}));
    const evidence=h('details',{},h('summary',{text:'查看邮件 / 页面证据'}));
    for(const [k,label] of [['subject_excerpt','邮件主题'],['from_domain','发件域名'],['body_excerpt','正文片段'],['status_text','页面状态']])if(e[k])evidence.append(h('p',{text:`${label}：${String(e[k]).slice(0,300)}`}));
    if(r.mail_received_at)evidence.append(h('p',{text:'收到日期：'+fmtDateTime(r.mail_received_at)}));el.append(evidence);
    const edit=h('div',{class:'tn-inline-form',hidden:true,'data-test':'review-edit'}),err=h('div',{'data-test':'review-error'});
    const search=h('input',{class:'tn-input',type:'search',placeholder:'按公司 / 岗位搜索本人台账','data-test':'review-search'});
    const select=h('select',{class:'tn-select','data-test':'review-target'});
    function options(rows){clear(select);select.append(h('option',{value:'',text:'请选择本人台账记录'}));for(const a of rows)select.append(h('option',{value:a.application_id||a.id,text:`${a.company_name} · ${a.job_title}`}));select.append(h('option',{value:'__new__',text:'按邮件新建一条'}));select.value=selected;if(select.value!==selected)selected='';}
    options(cs);
    const status=h('select',{class:'tn-select','data-test':'review-status-select'});for(const s of STATUS_ORDER)status.append(h('option',{value:s,text:STATUS_LABELS[s]}));status.value=pre.status||'applied';
    const time=h('input',{class:'tn-input',type:'datetime-local','data-test':'review-switch-at',value:localInput(pre.applied_at||(r.mail_inferred_applied_at_enabled?r.mail_received_at:null))});
    const timeWrap=h('label',{},r.mail_inferred_applied_at_enabled?'投递时间（北京时间；默认据原信推断，可修改）':'实际投递时间（北京时间）',time);
    const company=h('input',{class:'tn-input',value:pre.company_name||cs[0]?.company_name||'',placeholder:'公司名（可手改）','data-test':'review-create-company'}), title=h('input',{class:'tn-input',value:pre.job_title||cs[0]?.job_title||'',placeholder:'岗位名（可手改）','data-test':'review-create-title'});
    // 人工修改：公司和岗位始终可编辑；选中已有记录时改动会写回该记录，未选记录时按这两项新建。
    const newFields=h('div',{},h('label',{},'公司',company),h('label',{},'岗位',title));
    async function targetChanged(){selected=select.value;const request=++searchSeq;
      try{let a=selected&&selected!=='__new__'?(await api.get(`/api/v1/applications/${encodeURIComponent(selected)}`)).data:null;if(active()&&request===searchSeq)timeWrap.hidden=!!a?.applied_at||!NEEDS_TIME.has(status.value);}
      catch(e){if(active())err.textContent=humanError(e);}
    }
    select.onchange=targetChanged;status.onchange=targetChanged;
    let searchTimer;search.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(async()=>{const request=++searchSeq;try{const r=await api.get('/api/v1/application-search?q='+encodeURIComponent(search.value));if(active()&&request===searchSeq)options(r.data);}catch(e){if(active())err.textContent=humanError(e);}},250);};
    const save=h('button',{class:'tn-btn tn-btn-primary tn-btn-sm','data-test':'review-switch-status',text:'提交更新',onclick:()=>act(true)});
    edit.append(search,select,newFields,h('label',{},'状态',status),timeWrap,save);
    const confirm=h('button',{class:'tn-btn tn-btn-primary tn-btn-sm','data-test':'review-confirm',text:selected?'对，更新台账':'选一条记录并更新',onclick:()=>selected&&selected!=='__new__'?act(false):(edit.hidden=false,search.focus())});
    const change=h('button',{class:'tn-btn tn-btn-sm','data-test':'review-change',text:'不对，我来改',onclick:()=>{edit.hidden=!edit.hidden;targetChanged();}});
    const create=h('button',{class:'tn-btn tn-btn-sm','data-test':'review-create',text:'按邮件新建一条',onclick:()=>{edit.hidden=false;selected='__new__';select.value=selected;targetChanged();}});
    const dismiss=h('button',{class:'tn-btn tn-btn-sm','data-test':'review-dismiss',text:'这不是招聘进展，忽略',onclick:async()=>{if(await confirmDialog({title:'忽略这条线索？',message:'不会修改台账记录。',confirmLabel:'忽略'}))await act(false,'dismiss');}});
    el.append(h('div',{class:'tn-action-row'},confirm,change,dismiss,create),edit,err);
    if(failures.has(r.id)){el.classList.add('tn-review-failed');err.append(h('p',{class:'tn-inline-msg err',text:failures.get(r.id)}));}
    async function act(custom,action='confirm'){
      if(working)return;working=true;[confirm,change,dismiss,save,create].forEach(b=>b.disabled=true);clear(err);
      try{
        const fresh=(await api.get(`/api/v1/review-items/${r.id}`)).data;
        if(fresh.status!=='open'){toast('该复核项已处理，已刷新列表');await load();notify();return;}
        if(fresh.version!==r.version)throw {status:409};
        const changes={};if(custom){changes.status=status.value;
          if(!timeWrap.hidden&&time.value){changes.applied_at=new Date(time.value+':00+08:00').toISOString();changes.applied_at_precision=r.mail_inferred_applied_at_enabled&&r.mail_received_at&&time.value===localInput(r.mail_received_at)?'inferred_before':'exact';}
          const c=company.value.trim(),t=title.value.trim();
          if(c&&c!==(pre.company_name||''))changes.company_name=c;
          if(t&&t!==(pre.job_title||''))changes.job_title=t;
          if(selected==='__new__'||(!selected&&c&&t)){changes.company_name=c;changes.job_title=t;action='create';}
        }
        if(action==='create'&&(!changes.company_name||!changes.job_title))throw new Error('新建需要公司名和岗位名');
        if(action!=='dismiss'&&action!=='create'&&!selected){edit.hidden=false;throw new Error('请先搜索选择一条本人记录；或填写公司/岗位后按邮件新建');}
        await submit(r,{action,target:action==='dismiss'||action==='create'?null:selected,changes});failures.delete(r.id);await load();
      }catch(e){if(active()){const text=humanError(e);err.append(h('p',{class:'tn-inline-msg err',text}));if(e.status===409){toast(text,'err');await load();}}}
      finally{working=false;[confirm,change,dismiss,save,create].forEach(b=>b.disabled=false);}
    }
    targetChanged();return el;
  }
  await load();
}
