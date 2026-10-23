import { all } from '../db.js';
import { canonicalJobUrl, TERMINAL } from '../util.js';
const COMPANIES = [
  ['字节跳动',['字节跳动','bytedance','抖音','douyin','今日头条'],['bytedance.com','douyin.com']],
  ['腾讯',['腾讯','tencent'],['tencent.com','qq.com']],
  ['阿里巴巴',['阿里巴巴','阿里','alibaba','淘宝','天猫','阿里云'],['alibaba.com','alibaba-inc.com','aliyun.com']],
  ['美团',['美团','meituan'],['meituan.com']],['京东',['京东','jd','jingdong'],['jd.com']],
  ['小米',['小米','xiaomi'],['xiaomi.com']],['百度',['百度','baidu'],['baidu.com']],
  ['网易',['网易','netease'],['service.netease.com','corp.netease.com','netease.com']]
];
const tidy=s=>String(s||'').toLowerCase().replace(/[\s·•,.，。()（）]/g,'').replace(/(?:股份)?有限公司$|集团$/g,'');
export function companyIdentity(name, domain='') {
  const n=tidy(name), d=String(domain||'').toLowerCase();
  const named=COMPANIES.find(c=>c[1].some(a=>tidy(a)===n));
  // qq.com / 163.com are public mail providers, never company evidence.
  const host=COMPANIES.find(c=>c[2].some(h=>h!=='qq.com'&&(d===h||d.endsWith('.'+h))));
  if(named&&host&&named[0]!==host[0])return null;
  return named?.[0] || (n?n:host?.[0]) || null;
}
export function normalizedJobTitle(value) {
  return String(value||'').toLowerCase().replace(/20\d{2}\s*届?/g,'').replace(/校园招聘|社会招聘|校招|社招|秋招|春招|面试邀请|笔试邀请|测评邀请|面试通知|笔试通知|招聘进展/g,'')
    .replace(/[-—·|（(]\s*(北京|上海|深圳|广州|杭州|成都|武汉|西安|南京|苏州|远程)[)）]?/g,'').replace(/[\s\p{P}\p{S}]/gu,'');
}
export function similarJob(a,b) {
  const x=normalizedJobTitle(a),y=normalizedJobTitle(b);
  if(x.length<2||y.length<2)return false;
  return x===y || (Math.min(x.length,y.length)/Math.max(x.length,y.length)>=0.75 && (x.includes(y)||y.includes(x)));
}
export function findProgressCandidates(ownerId, fields, { source='mail' }={}) {
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
  if(similar.length)return similar.map(a=>candidate(a,'company_similar_title',0.9));
  const active=same.filter(a=>!TERMINAL.has(a.status));
  if(active.length===1)return [candidate(active[0],'single_active_company',0.85)];
  return same.map(a=>candidate(a,'company_only_ambiguous',0.5));
}
