import http from 'node:http';

// Hand-authored fixture truth; never populated by the extractor under test.
export const JOBS = {
  1001: { company_name:'回归科技', job_title:'软件工程师', location:'北京、上海', recruitment_batch:'', jd_text:'岗位职责\n负责浏览器插件开发。\n保障数据完整性。\n\n任职要求\n熟悉 JavaScript 和数据库。' },
  1002: { company_name:'回归科技', job_title:'软件工程师', location:'杭州', recruitment_batch:'', jd_text:'岗位职责\n负责业务系统开发。\n维护自动化测试。\n\n任职要求\n熟悉服务端开发和 SQL。' },
  1003: { company_name:'长文科技', job_title:'长文验证工程师', location:'深圳', recruitment_batch:'', jd_text:'岗位职责\n'+'负责完整正文传输与校验。\n'.repeat(2300)+'\n任职要求\n这段结尾必须完整保存。' },
  1004: { company_name:'', job_title:'公司缺失的岗位', location:'上海', recruitment_batch:'', jd_text:'岗位职责\n负责运营支持和用户沟通。\n\n任职要求\n有耐心和沟通能力。' },
  1005: { company_name:'语义科技', job_title:'没有投递按钮但有完整职责的岗位', location:'广州', recruitment_batch:'', jd_text:'岗位职责\n负责多区块正文识别。\n\n任职要求\n熟悉自动化测试与数据处理。' },
  2001: { company_name:'切换科技', job_title:'同名工程师', location:'北京', recruitment_batch:'', jd_text:'岗位职责\n维护 A 服务的可靠性。\n\n任职要求\n熟悉 A 服务的部署。' },
  2002: { company_name:'切换科技', job_title:'同名工程师', location:'上海', recruitment_batch:'', jd_text:'岗位职责\n维护 B 服务的可靠性。\n\n任职要求\n熟悉 B 服务的部署。' },
  3001: { company_name:'抽屉科技', job_title:'侧栏工程师甲', location:'北京', recruitment_batch:'', jd_text:'岗位职责\n设计和维护业务组件。\n\n任职要求\n熟悉组件化开发与测试。' },
  3002: { company_name:'抽屉科技', job_title:'侧栏工程师乙', location:'上海', recruitment_batch:'', jd_text:'岗位职责\n设计和维护数据组件。\n\n任职要求\n熟悉数据处理与测试。' }
};
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function body(id, { changed = false, semantic = false } = {}) {
  const j = JOBS[id];
  const jd = semantic ? '<section>'+j.jd_text.split('\n\n').map(s => { const [h,...rest]=s.split('\n');return `<h2>${esc(h)}</h2><p>${esc(rest.join('\n'))}</p>`; }).join('')+'</section>' : `<div class="${changed?'new-description':'job-description'}">${esc(j.jd_text)}</div>`;
  return `<main data-job-id="${id}"><h1>${esc(j.job_title)}</h1><p class="company-name">${esc(j.company_name)}</p><p>公司名称: ${esc(j.company_name)}</p><p>工作地点: ${esc(j.location)}</p><p>岗位编号: ${id}</p>${jd}${semantic?'':'<button>申请职位</button>'}</main>`;
}
function ld(id, base) { const j=JOBS[id];return `<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',title:j.job_title,hiringOrganization:{name:j.company_name},identifier:{value:String(id)},url:base+'/jobs/'+id,jobLocation:j.location.split('、').map(v=>({address:{addressLocality:v}})),description:j.jd_text})}</script>`; }
function html(content) { return `<!doctype html><html lang="zh"><meta charset="utf-8"><style>body{font:18px system-ui;margin:32px}main{max-width:900px}.job-description,.new-description{white-space:pre-wrap}button{padding:12px}li{margin:20px}</style><body>${content}</body></html>`; }
export async function startCaptureFixtures(port) {
  let base, changedLayout = false;
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,base), id=url.pathname.match(/^\/jobs\/(\d+)/)?.[1];
    let content='';
    if(id && JOBS[id]) {
      content=body(id,{semantic:id==='1005',changed:changedLayout})+(id==='1005'?'':ld(id,base));
      if(id==='2001') content+=`<button id="switch-job">切换同名岗位</button><script>document.querySelector('#switch-job').onclick=()=>{history.pushState({},'', '/jobs/2002');setTimeout(()=>{document.querySelector('main').outerHTML=${JSON.stringify(body(2002))};document.querySelector('script[type="application/ld+json"]').textContent=${JSON.stringify(ld(2002,base).replace(/^<script[^>]*>|<\/script>$/g,''))};},1300);};</script>`;
    } else if(url.pathname==='/jobs') {
      content='<h1>在招职位</h1><ul>'+[1001,1002,1005].map(i=>`<li class="job-card"><h2 class="job-title"><a href="/jobs/${i}">${JOBS[i].job_title}</a></h2><span class="company-name">${JOBS[i].company_name}</span><span class="job-location">${JOBS[i].location}</span><p>列表没有完整 JD</p></li>`).join('')+'</ul>';
    } else if(url.pathname==='/drawer') {
      content=`<h1>职位列表</h1><button id="open-a">打开岗位甲</button><button id="open-b">打开岗位乙</button><div id="drawer"></div><script>for(const [key,markup] of ${JSON.stringify([['a',body(3001,{semantic:true})],['b',body(3002,{semantic:true})]])})document.querySelector('#open-'+key).onclick=()=>document.querySelector('#drawer').innerHTML='<div role="dialog" class="job-detail">'+markup+'</div>';</script>`;
    } else if(url.pathname==='/expired') content='<main><h1>职位已过期或不存在</h1></main>'+ld(1001,base);
    else if(url.pathname==='/login') content='<main><h1>登录招聘平台</h1><input placeholder="手机号"><button>登录</button></main>';
    else content='<main><h1>欢迎访问企业首页</h1><p>了解我们的故事</p></main>';
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html(content));
  });
  await new Promise(r=>server.listen(port,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
  return {base,setLayout:changed=>{changedLayout=changed;},close:()=>new Promise(r=>server.close(r))};
}
