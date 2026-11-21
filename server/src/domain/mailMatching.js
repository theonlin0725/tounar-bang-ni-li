import { all } from '../db.js';
import { canonicalJobUrl, TERMINAL } from '../util.js';
const COMPANIES = [
  ['字节跳动',['字节跳动','bytedance','抖音','douyin','今日头条'],['bytedance.com','douyin.com']],
  ['腾讯',['腾讯','tencent'],['tencent.com','qq.com']],
  ['阿里巴巴',['阿里巴巴','阿里','alibaba','淘宝','天猫','阿里云'],['alibaba.com','alibaba-inc.com','aliyun.com']],
  ['美团',['美团','meituan'],['meituan.com']],['京东',['京东','jd','jingdong'],['jd.com']],
  ['小米',['小米','xiaomi'],['xiaomi.com']],['百度',['百度','baidu'],['baidu.com']],
  ['网易',['网易','netease'],['service.netease.com','corp.netease.com','netease.com','campus.163.com','hr.163.com']]
];
const tidy=s=>String(s||'').toLowerCase().replace(/[\s·•,.，。()（）]/g,'').replace(/(?:股份)?有限公司$|集团$|校园招聘$|招聘$/g,'');
export function companyIdentity(name, domain='') {
  const n=tidy(name), d=String(domain||'').toLowerCase();
  const named=COMPANIES.find(c=>c[1].some(a=>tidy(a)===n));
  // qq.com / 163.com are public mail providers, never company evidence.
  const host=COMPANIES.find(c=>c[2].some(h=>h!=='qq.com'&&(d===h||d.endsWith('.'+h))));
  if(named&&host&&named[0]!==host[0])return null;
  return named?.[0] || (n?n:host?.[0]) || null;
}
export function normalizedJobTitle(value) {
  return String(value||'').toLowerCase().replace(/20\d{2}\s*届?/g,'').replace(/校园招聘|社会招聘|校招|社招|秋招|春招|面试邀请|笔试邀请|测评邀请|面试通知|笔试通知|招聘进展/g,'').replace(/(?:岗位|职位)$/g,'')
    .replace(/[-—·|（(]\s*(北京|上海|深圳|广州|杭州|成都|武汉|西安|南京|苏州|远程)[)）]?/g,'').replace(/[\s\p{P}\p{S}]/gu,'');
}
export function similarJob(a,b) {
  const x=normalizedJobTitle(a),y=normalizedJobTitle(b);
  if(x.length<2||y.length<2)return false;
  return x===y || (Math.min(x.length,y.length)/Math.max(x.length,y.length)>=0.75 && (x.includes(y)||y.includes(x)));
}
// 阶段规则（2026-10-23 用户拍板）：笔试/测评与面试是两条独立进展，不能合并成一条记录。
// 匹配时优先找「同一阶段」的记录；只有另一阶段的记录时，交给人工新建，不要硬并。
export const STAGE_OF_STATUS = { assessment: 'assessment', interview: 'interview' };
export function stageOfStatus(status) { return STAGE_OF_STATUS[status] || null; }

export function findProgressCandidates(ownerId, fields, { source='mail', stage: stageOption=null }={}) {
  const rows=all('SELECT * FROM applications WHERE owner_id = ? AND archived_at IS NULL ORDER BY updated_at DESC',[ownerId]);
  const candidate=(application,reason,confidence)=>({application,reason,confidence});
  if(fields.site_application_id){const exact=rows.filter(a=>a.site_application_id===fields.site_application_id&&(!fields.site_key||a.site_key===fields.site_key));if(exact.length)return exact.map(a=>candidate(a,'site_application_id',1));}
  if(source==='plugin'){
    const exact=rows.filter(a=>(fields.site_key&&fields.site_job_id&&a.site_key===fields.site_key&&a.site_job_id===fields.site_job_id)||(canonicalJobUrl(fields.job_url)&&a.canonical_job_url===canonicalJobUrl(fields.job_url)));
    if(exact.length)return exact.map(a=>candidate(a,'stable_site_identity',1));
  }
  const company=companyIdentity(fields.company_name,fields.from_domain);
  if(!company)return [];
  const same=rows.filter(a=>companyIdentity(a.company_name)===company);
  const similar=same.filter(a=>similarJob(a.job_title,fields.job_title));
  if(similar.length===0 && source==='mail' && fields.job_title){
    // 同公司的新岗位不是“公司歧义”：交给调用方按新岗位新建。
    return [];
  }
  if(similar.length){
    const stage=fields.stage||stageOption||null;
    if(stage){
      const staged=similar.filter(a=>STAGE_OF_STATUS[a.status]===stage);
      if(staged.length)return staged.map(a=>candidate(a,'company_title_stage',0.92));
      // 只有「另一个阶段」的记录时才拆开（已有笔试、来的是面试）。
      // 记录还停在 applied/pending 时属于同一流程的早期，应该继续推进，不是拆分。
      const otherStage=stage==='assessment'?'interview':'assessment';
      if(similar.every(a=>STAGE_OF_STATUS[a.status]===otherStage))return [];
      return similar.map(a=>candidate(a,'company_similar_title',0.9));
    }
    return similar.map(a=>candidate(a,'company_similar_title',0.9));
  }
  const active=same.filter(a=>!TERMINAL.has(a.status));
  if(active.length===1)return [candidate(active[0],'single_active_company',0.85)];
  return same.map(a=>candidate(a,'company_only_ambiguous',0.5));
}

/* 邮件自动同步与人工确认共用的服务端归属规则：
 *   可信申请号 → 岗位链接 → 公司+岗位+批次 → 公司+岗位。
 * 多个合理候选、只有公司、字段冲突都返回 ambiguous，交给人工选择；
 * 没有候选时 target=null，是否允许新建由调用方按证据门槛决定。 */
export function resolveMailApplication(ownerId, fields = {}) {
  const rows = all('SELECT * FROM applications WHERE owner_id = ? AND archived_at IS NULL ORDER BY updated_at DESC', [ownerId]);
  const asCandidate = (application, reason, confidence) => ({ ...application, reason, confidence, application });
  const appId = String(fields.site_application_id || '').trim();
  if (appId) {
    const exact = rows.filter((a) => a.site_application_id === appId && (!fields.site_key || a.site_key === fields.site_key));
    if (exact.length === 1) return { target: exact[0], candidates: exact.map((a) => asCandidate(a, 'site_application_id', 1)), ambiguous: false, reason: 'site_application_id' };
    if (exact.length > 1) return { target: null, candidates: exact.map((a) => asCandidate(a, 'site_application_id', 1)), ambiguous: true, reason: 'site_application_id' };
  }
  const canonical = canonicalJobUrl(fields.job_url);
  if (canonical) {
    const exact = rows.filter((a) => a.canonical_job_url === canonical);
    if (exact.length === 1) return { target: exact[0], candidates: exact.map((a) => asCandidate(a, 'canonical_job_url', 1)), ambiguous: false, reason: 'canonical_job_url' };
    if (exact.length > 1) return { target: null, candidates: exact.map((a) => asCandidate(a, 'canonical_job_url', 1)), ambiguous: true, reason: 'canonical_job_url' };
  }
  const company = companyIdentity(fields.company_name, fields.from_domain);
  if (!company) return { target: null, candidates: [], ambiguous: false, reason: 'none' };
  const sameCompany = rows.filter((a) => companyIdentity(a.company_name) === company);
  if (!fields.job_title) {
    const active = sameCompany.filter((a) => !TERMINAL.has(a.status));
    if (active.length === 1) {
      return {
        target: active[0],
        candidates: [asCandidate(active[0], 'single_active_company', 0.85)],
        ambiguous: false,
        reason: 'single_active_company'
      };
    }
    if (active.length >= 2) {
      return {
        target: null,
        candidates: active.map((a) => asCandidate(a, 'company_only', 0.5)),
        ambiguous: true,
        reason: 'company_only'
      };
    }
    return { target: null, candidates: [], ambiguous: false, reason: 'none' };
  }
  const sameJob = sameCompany.filter((a) => similarJob(a.job_title, fields.job_title));
  if (fields.recruitment_batch) {
    const batch = sameJob.filter((a) => a.recruitment_batch && a.recruitment_batch === fields.recruitment_batch);
    if (batch.length === 1) return { target: batch[0], candidates: batch.map((a) => asCandidate(a, 'company_title_batch', 0.98)), ambiguous: false, reason: 'company_title_batch' };
    if (batch.length > 1) return { target: null, candidates: batch.map((a) => asCandidate(a, 'company_title_batch', 0.98)), ambiguous: true, reason: 'company_title_batch' };
    // 邮件明确写了批次但没有同期记录：不要退回“公司+岗位”覆盖另一个批次，交人工。
    if (sameJob.length) {
      return {
        target: null,
        candidates: sameJob.map((a) => asCandidate(a, 'batch_mismatch', 0.5)),
        ambiguous: true,
        reason: 'batch_mismatch'
      };
    }
  }
  if (sameJob.length === 1) return { target: sameJob[0], candidates: sameJob.map((a) => asCandidate(a, 'company_title', 0.9)), ambiguous: false, reason: 'company_title' };
  if (sameJob.length > 1) return { target: null, candidates: sameJob.map((a) => asCandidate(a, 'company_title', 0.9)), ambiguous: true, reason: 'company_title' };
  // 同公司但没有当前岗位：这是一条新岗位线索，交给上游自动新建；不能把其他岗位误当候选。
  return { target: null, candidates: [], ambiguous: false, reason: 'new_job_same_company' };
}
