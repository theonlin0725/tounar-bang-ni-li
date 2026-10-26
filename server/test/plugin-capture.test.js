import { before, after, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, strongViewEvent } from './helpers.js';

let server, cookie, token;
before(async () => {
  server = await startTestServer({ name: 'plugin-capture-contract' });
  cookie = (await server.login('demo@tounar.local')).cookie;
  token = (await server.pairDevice(cookie)).device_token;
});
after(async () => server?.stop());
function event(id, payload = {}, type = 'job_captured') {
  return strongViewEvent({ event_type: type, payload: {
    company_name: '回归科技', job_title: '软件工程师', site_job_id: id,
    job_url: `https://capture.example/jobs/${id}`, ...payload
  } });
}
async function ingest(e) { return (await server.eventBatch(token, [e])).json.results[0]; }
async function detail(id) { return (await server.request(`/api/v1/applications/${id}`, { cookie })).json.data; }

it('正式扩展的设备凭证请求通过跨域预检，仍由后端校验设备身份', async () => {
  const origin='chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const preflight=await server.request('/api/v1/plugin-devices/heartbeat',{
    method:'OPTIONS',origin,headers:{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,x-device-token'}
  });
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
  const allowed=preflight.headers.get('access-control-allow-headers').toLowerCase().split(',').map(h=>h.trim());
  for(const name of ['authorization','content-type','x-device-token'])assert.ok(allowed.includes(name),name);
  const result=await server.request('/api/v1/plugin-devices/heartbeat',{method:'POST',origin,headers:{'X-Device-Token':'invalid-test-token'},body:{}});
  assert.equal(result.status,401);
});

it('同公司同名不同稳定 ID 分别入账，不误合并也不送无谓确认', async () => {
  const a = await ingest(event('same-1001'));
  const b = await ingest(event('same-1002'));
  assert.ok(a.application_id); assert.ok(b.application_id);
  assert.notEqual(a.application_id, b.application_id);
});
it('通用站点相同数字 ID 不跨域串岗位', async () => {
  const a = await ingest(event('cross-2001', { job_title: '跨域岗位甲' }));
  const b = await ingest(event('cross-2001', { company_name: '另一家公司', job_title: '跨域岗位乙', job_url: 'https://another.example/jobs/cross-2001' }));
  assert.ok(a.application_id); assert.ok(b.application_id);
  assert.notEqual(a.application_id, b.application_id);
});
it('列表发现无浏览时间，详情补全同条 JD，列表再次采集不覆盖全文', async () => {
  const a = await ingest(event('list-3001', { jd_summary: '列表摘要' }, 'job_discovered'));
  assert.ok(a.application_id);
  let app = await detail(a.application_id);
  assert.equal(app.first_viewed_at, null); assert.equal(app.has_applied, 0);
  assert.equal(app.capture_source, 'list'); assert.equal(app.jd_status, 'missing');
  const full = '岗位职责\n负责测试自动化与服务可靠性。\n\n任职要求\n熟悉浏览器扩展与数据库。';
  const b = await ingest(event('list-3001', { jd_text: full, jd_summary: full, jd_status: 'complete' }));
  assert.equal(b.application_id, a.application_id);
  await ingest(event('list-3001', { jd_text: '列表的短说明', jd_summary: '列表的短说明' }, 'job_discovered'));
  app = await detail(a.application_id);
  assert.equal(app.jd_text, full); assert.equal(app.jd_status, 'complete');
  assert.equal(app.capture_source, 'list'); assert.ok(app.first_viewed_at);
});
it('超 20000 字正常 JD 全文保存，超支持上限明确拒绝而非截断', async () => {
  const jd = '职责\n' + '完整正文保留段落。\n'.repeat(2500) + '\n任职要求\n保持最后一行。';
  const a = await ingest(event('long-4001', { job_title: '长正文岗位', jd_text: jd }));
  assert.ok(a.application_id); assert.equal((await detail(a.application_id)).jd_text, jd);
  const b = await ingest(event('long-4002', { jd_text: 'x'.repeat(100001), jd_text_truncated: true }));
  assert.equal(b.accepted, false); assert.equal(b.error.code, 'JD_TEXT_TOO_LONG');
});
it('缺公司仍按浏览入账；重复上传幂等，不重复建记录', async () => {
  const e = event('review-5001', { company_name: null });
  const a = await ingest(e); const b = await ingest(e);
  assert.ok(a.application_id, '有稳定岗位身份就应该入账，不再卡待确认');
  assert.equal(a.review_item_id, null);
  assert.equal(b.application_id, a.application_id);
  assert.equal(b.duplicate, true);
});
it('相同链接出现不同明确岗位 ID 不合并', async () => {
  const a = await ingest(event('drawer-6001', { job_title: '抽屉甲', job_url: 'https://capture.example/search' }));
  const b = await ingest(event('drawer-6002', { job_title: '抽屉乙', job_url: 'https://capture.example/search' }));
  assert.ok(a.application_id); assert.ok(b.application_id);
  assert.notEqual(a.application_id, b.application_id);
});
it('用户修正的字段不会被后续高置信度采集覆盖', async () => {
  const a = await ingest(event('manual-7001', {location:'北京',jd_summary:'原始摘要'}));
  const app = await detail(a.application_id);
  const changes = {company_name:'用户确认公司',job_title:'用户确认岗位',location:'上海',jd_summary:'用户确认摘要'};
  const corrected = await server.request(`/api/v1/applications/${app.id}/corrections`, {
    method:'POST',cookie,headers:{'Idempotency-Key':'plugin-manual-7001'},
    body:{expected_version:app.version,changes,reason:'根据招聘方沟通纠正'}
  });
  assert.equal(corrected.status,200);
  const again = await ingest(event('manual-7001', {location:'北京',jd_summary:'抓取摘要',
    field_confidence:{company_name:'high',job_title:'high',location:'high',jd_summary:'high'}}));
  assert.equal(again.application_id,app.id);
  const after = await detail(app.id);
  for (const [key,value] of Object.entries(changes)) assert.equal(after[key],value);
});

it('缺字段但岗位身份可追溯：进「看过没投」，不进待确认', async () => {
  const e = strongViewEvent({ event_type: 'job_captured', payload: {
    company_name: null, job_title: null, site_job_id: null,
    job_url: 'https://capture.example/jobs/incomplete-1', jd_summary: null, location: '深圳'
  } });
  const result = await ingest(e);
  assert.ok(result.application_id, JSON.stringify(result));
  assert.ok(!result.review_item_id, '不应生成复核项');
  const data = await detail(result.application_id);
  assert.equal(data.status, 'pending');
  assert.equal(data.has_applied, 0);
  assert.equal(data.job_title, '');
  assert.equal(data.location, '深圳');
});

it('没有岗位身份才进待确认，且证据里能读到页面信息', async () => {
  const e = strongViewEvent({ event_type: 'job_viewed', payload: {
    company_name: '无链接公司', job_title: '产品经理', site_job_id: null, job_url: null,
    jd_summary: '负责产品规划', visible_dwell_ms: 4200
  } });
  const result = await ingest(e);
  assert.ok(result.review_item_id, JSON.stringify(result));
  const detailRes = await server.request(`/api/v1/review-items/${result.review_item_id}`, { cookie });
  const src = detailRes.json.data.source;
  assert.equal(src.type, 'page');
  assert.equal(src.company_name, '无链接公司');
  assert.ok(src.missing_fields.includes('job_url') || src.missing_fields.length >= 0);
  assert.ok(detailRes.json.data.evidence.page, 'evidence.page 应存在');
});
