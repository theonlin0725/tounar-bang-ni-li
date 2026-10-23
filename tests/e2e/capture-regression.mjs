import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { sanitizedSnapshot } from '../../tools/site-snapshot.mjs';
import { resolveChromiumExecutable } from './browser.mjs';
const root=path.resolve(import.meta.dirname,'../..');
export async function captureRegression(check){
  const resolved=await resolveChromiumExecutable();const browser=await chromium.launch({executablePath:resolved.path,headless:true});
  try{
    async function pageFor(url,html){const context=await browser.newContext();await context.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:html}));const page=await context.newPage();
      await page.addInitScript(()=>{window.__captured=[];window.chrome={runtime:{sendMessage(m,cb){window.__captured.push(m.event);cb?.({ok:true});}}};});
      page.on('pageerror',e=>console.error('capture script:',e.message));await page.goto(url);await page.addScriptTag({path:root+'/extension/content/adapters.js'});await page.addScriptTag({path:root+'/extension/content/tracker.js'});return {page,context};}
    async function capture(page){await page.waitForFunction(()=>window.__captured.some(e=>e?.event_type==='job_viewed'),null,{timeout:9000}).catch(async e=>{console.error(await page.evaluate(()=>({attrs:document.documentElement.outerHTML.slice(0,600),captured:window.__captured})));throw e;});return page.evaluate(()=>window.__captured.filter(e=>e?.event_type==='job_viewed').at(-1).payload);}
    {
      const {page,context}=await pageFor('https://jobs.bytedance.com/campus/position/7699119731313821957/detail',fs.readFileSync(root+'/tests/fixtures/synthetic-capture/bytedance-historical-dom.html','utf8'));const p=await capture(page);
      check('P4-字节历史DOM结构离线回归（非真实页面验收）',p.job_title==='AI Agent产品经理 - 巨量AI工作台'&&p.company_name==='字节跳动'&&p.location==='上海、北京'&&p.recruitment_batch==='2027 校园招聘'&&p.site_job_id==='7699119731313821957'&&p.jd_summary.startsWith('团队介绍'));
      await context.close();
    }
    {
      const html='<style>h1{font-size:31px}</style><main><h1>开发工程师</h1><button>申请</button><a href="https://example.com/job/123;jsessionid=fixture-path?token=fixture-token#/job/123?auth=fixture-hash">岗位</a><a href="javascript:alert(1)">链接</a><p>fixture-person@example.com</p><form><input value="fixture-private-name"></form></main><script>window.fixturePrivateState="fixture-private-state";</script><script type="application/ld+json">{"@type":"JobPosting","title":"开发工程师","hiringOrganization":{"name":"测试企业"}}</script>';
      const {page,context}=await pageFor('https://example.com/job/123',html);const snapshot=await sanitizedSnapshot(page);
      check('P4-快照去表单/脚本状态/联系方式/令牌并保留岗位结构化数据',!snapshot.includes('fixture-private-name')&&!snapshot.includes('fixture-private-state')&&!snapshot.includes('fixture-person@example.com')&&!snapshot.includes('fixture-token')&&!snapshot.includes('fixture-path')&&!snapshot.includes('fixture-hash')&&snapshot.includes('JobPosting'));
      check('P4-快照保留渲染字号并删除站点CSS与可执行链接',snapshot.includes('font-size:31px')&&!snapshot.includes('<style')&&!snapshot.includes('javascript:'));
      await context.close();
    }
    const realCases=JSON.parse(fs.readFileSync(root+'/tests/fixtures/sites/cases.json','utf8'));
    if(!realCases.length)console.log('未运行真实站点快照回归：0 个有效样本（详见站点证据报告）');
    for(const fixture of realCases){
      const {page,context}=await pageFor(fixture.url,fs.readFileSync(path.join(root,'tests/fixtures/sites',fixture.file),'utf8'));
      const p=await capture(page);
      check('P4-真实快照离线回归 '+fixture.site+' '+fixture.file,Object.entries(fixture.expected).every(([key,value])=>(p[key]||'')===value));
      await context.close();
    }
    const semantic=fs.readFileSync(root+'/tests/fixtures/synthetic-capture/semantic-job.html','utf8');
    {
      const {page,context}=await pageFor('https://unknown.example/job/10001',semantic);const p=await capture(page);
      check('P4-语义标题与JD排除导航，字段带把握度',p.job_title==='产品经理'&&p.company_name==='优质科技'&&p.location==='北京'&&p.jd_summary.startsWith('负责产品规划')&&p.field_confidence.job_title==='medium');
      await context.close();
    }
    {
      const {page,context}=await pageFor('https://unknown.example/job/10002',fs.readFileSync(root+'/tests/fixtures/synthetic-capture/structured-job.html','utf8'));const p=await capture(page);
      check('P4-多来源评分结构化数据优先于启发式标题',p.job_title==='算法工程师'&&p.company_name==='结构化科技'&&p.field_confidence.job_title==='high');await context.close();
    }
    {
      const {page,context}=await pageFor('https://unknown.example/;jsessionid=fixture-session#/job/10007;sessionid=fixture-route?token=private',semantic);const p=await capture(page);
      check('P4-hash路由保留岗位身份并去掉敏感URL参数',p.site_job_id==='10007'&&p.job_url==='https://unknown.example/#/job/10007');await context.close();
    }
    {
      const {page,context}=await pageFor('https://unknown.example/job/10008','<main><div style="font-size:30px">运营经理</div><p>公司名称: 字体科技</p><h4>岗位职责</h4><div>负责用户运营与产品增长，持续优化业务数据。</div><button>立即申请</button></main>');
      const p=await capture(page);check('P4-无标题标签时使用可见大字号岗位候选',p.job_title==='运营经理'&&p.field_confidence.job_title==='medium');await context.close();
    }
    {
      const {page,context}=await pageFor('https://www.zhipin.com/job_detail/10003',semantic.replace('<p>公司名称: 优质科技</p>',''));const p=await capture(page);
      check('P4-聚合站公司缺失留空，不取站点名或域名',!p.company_name&&p.field_confidence.company_name==='low');await context.close();
    }
    {
      const {page,context}=await pageFor('https://unknown.example/job/10004','<title>运营经理</title><meta property="og:site_name" content="神秘公司"><main><p>只有一段很长的导航和页面正文，不是职位描述。</p><button>申请</button></main>');
      await page.waitForTimeout(4500);check('P4-仅低把握meta/标题不发假岗位',await page.evaluate(()=>window.__captured.length)===0);await context.close();
    }
    {
      const {page,context}=await pageFor('https://unknown.example/job/10009','<div class="modal-globalSites"><h1>Welcome to Mi.com</h1></div><main><button>申请职位</button></main>');
      await page.waitForTimeout(4500);check('P4-全局弹窗标题不冒充岗位（真实小米误采回归）',await page.evaluate(()=>window.__captured.length)===0);await context.close();
    }
    {
      const {page,context}=await pageFor('https://unknown.example/job/10010','<main><h1>运营经理</h1><button style="display:none">申请职位</button></main>');
      await page.waitForTimeout(4500);check('P4-隐藏申请按钮不构成岗位信号',await page.evaluate(()=>window.__captured.length)===0);await context.close();
    }
    {
      const {page,context}=await pageFor('https://www.shixiseng.com/intern/inn_fontfixture','<main><div class="new_job_name">运营实习\ue123</div><div class="resume_apply">投个简历</div></main>');
      await page.waitForTimeout(4500);check('P4-字体反爬私用区乱码标题不上报',await page.evaluate(()=>window.__captured.length)===0);await context.close();
    }
    {
      const {page,context}=await pageFor('https://join.qq.com/other-detail/10011','<div class="job-text-wrapper"><span class="job-recruit-title">测试开发工程师</span></div><button>立即申请</button>');
      await page.waitForTimeout(4500);check('P4-已验证规则不向其他域名或路径加分',await page.evaluate(()=>window.__captured.length)===0);await context.close();
    }
    {
      const {page,context}=await pageFor('https://unknown.example/job/10012','<header><h1>公司导航标题</h1></header><main><header><h1>平台开发工程师</h1></header><button>立即申请</button></main>');
      const p=await capture(page);check('P4-main中的职位header可采集，站点全局header排除',p.job_title==='平台开发工程师');await context.close();
    }
    {
      const {page,context}=await pageFor('https://unknown.example/job/10013','<main><h1>质量工程师</h1><input type="text" value="fixture-private-form-value"><input type="button" value="申请职位"></main>');
      const p=await capture(page);check('P4-input申请按钮可识别且不读取文本输入内容',p.job_title==='质量工程师'&&!JSON.stringify(p).includes('fixture-private-form-value'));await context.close();
    }
    {
      const {page,context}=await pageFor('https://unknown.example/job/10005',semantic);await capture(page);
      await page.evaluate(()=>{history.pushState({},'','/job/10006');});
      await page.waitForTimeout(1200);check('P4-SPA路由改变但旧DOM未换，不发混合岗位',await page.evaluate(()=>window.__captured.filter(e=>e?.event_type==='job_viewed').length)===1);
      await page.evaluate(()=>document.querySelector('main h1').textContent='数据工程师');await page.waitForFunction(()=>window.__captured.filter(e=>e?.event_type==='job_viewed').length===2,null,{timeout:9000});
      const p=await page.evaluate(()=>window.__captured.filter(e=>e?.event_type==='job_viewed').at(-1).payload);check('P4-SPA渲染安静后采新岗位',p.job_title==='数据工程师'&&p.site_job_id==='10006');
      await page.evaluate(()=>document.querySelector('main h1').textContent='测试工程师');await page.waitForFunction(()=>window.__captured.filter(e=>e?.event_type==='job_viewed').length===3,null,{timeout:9000});
      check('P4-同URL弹窗/抽屉切岗位重新识别',await page.evaluate(()=>window.__captured.filter(e=>e?.event_type==='job_viewed').at(-1).payload.job_title)==='测试工程师');await context.close();
    }
  }finally{await browser.close();}
}
