import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
const key = prefix => prefix + '_' + crypto.randomUUID();

let server, cookie, peer, state;
const call = (path, body, method = 'POST') => server.request('/api/v1/admin/mail'+path, { method, cookie, body });
describe('管理员邮件模板和业务自测入口', () => {
  before(async () => {
    server = await startTestServer({ name: 'mail-admin', env: { ALLOWED_EMAILS: 'demo@tounar.local,peer@tounar.local', ADMIN_EMAILS: 'demo@tounar.local', TEST_MAIL_RECIPIENTS: 'demo@tounar.local', ENABLE_MAIL_BUSINESS_TEST: 'true' } });
    cookie = (await server.login('demo@tounar.local')).cookie;
    peer = (await server.login('peer@tounar.local')).cookie;
  });
  after(async () => { if (server) await server.stop(); });
  it('所有管理接口要求管理员；非管理员无法读写或发送', async () => {
    for (const [path, method] of [['', 'GET'], ['/records', 'GET'], ['/templates/otp/versions/1', 'GET'], ['/preview', 'POST'], ['/send', 'POST'], ['/templates/otp', 'PUT'], ['/templates/otp/restore', 'POST']]) {
      const result = await server.request('/api/v1/admin/mail'+path, { cookie: peer, method, ...(method === 'GET' ? {} : { body: {} }) });
      assert.equal(result.status, 403, path);
    }
    state = (await call('', undefined, 'GET')).json.data;
    assert.equal(state.templates.length, 5);
    assert.equal((await server.request('/api/v1/me', { cookie })).json.data.user.is_admin, true);
    assert.equal((await server.request('/api/v1/me', { cookie: peer })).json.data.user.is_admin, false);
  });
  it('模板和示例可渲染，脚本/链接/未知变量及核心字段删除会被阻止', async () => {
    for (const t of state.templates) {
      const result = await call('/preview', { mode: 'template', template_id: t.id, variables: t.sample });
      assert.equal(result.status, 200, JSON.stringify(result.json));
      assert.ok(result.json.data.subject.includes('自测'));
      const html = await server.request(result.json.data.preview_url, { cookie });
      assert.equal(html.status, 200);
      assert.ok(html.headers.get('content-security-policy').includes("default-src 'none'"));
      assert.equal((await server.request(result.json.data.preview_url, { cookie: peer })).status, 403);
    }
    const otp = state.templates.find(t => t.id === 'otp');
    for (const change of [{ html: '<script>alert(1)</script>{{code}}{{ttl_minutes}}' }, { subject: '{{unknown}}' }, { html: '<a href="javascript:alert(1)">{{code}}{{ttl_minutes}}</a>' }, { text: '已删除验证码' }]) {
      const result = await call('/templates/otp', { template: { ...otp, ...change }, expected_version: otp.version }, 'PUT');
      assert.equal(result.status, 422, JSON.stringify(change));
      assert.ok(result.json.error.details.issues.length);
    }
    const missing = await call('/preview', { mode: 'template', template_id: 'otp', variables: { ttl_minutes: '10' } });
    assert.equal(missing.status, 422);
    const raw = state.templates.find(t => t.id === 'reminder');
    assert.equal((await call('/preview', { mode: 'template', template_id: 'reminder', variables: { ...raw.sample, body_html: '<img src=x onerror=alert(1)>' } })).status, 422);
  });
  it('保存版本、立即用于发送、约束生效、并发保护和恢复历史版本', async () => {
    const otp = state.templates.find(t => t.id === 'otp');
    const changed = { ...otp, subject: otp.subject+' 文案B', rules: { ...otp.rules, fixed: ['文案B'], forbidden: ['违禁词'], variable_max: { code: 6 } } };
    const saved = await call('/templates/otp', { template: changed, expected_version: 1 }, 'PUT');
    assert.equal(saved.status, 200, JSON.stringify(saved.json)); assert.equal(saved.json.data.version, 2);
    assert.equal((await call('/templates/otp', { template: changed, expected_version: 1 }, 'PUT')).status, 409);
    assert.equal((await call('/preview', { mode: 'template', template_id: 'otp', variables: { code: '1234567', ttl_minutes: '10' } })).status, 422);
    assert.equal((await call('/preview', { mode: 'template', template_id: 'otp', variables: { code: '违禁词', ttl_minutes: '10' } })).status, 422);
    const sent = await call('/send', { mode: 'template', template_id: 'otp', variables: otp.sample, to: 'demo@tounar.local', expected_versions: { otp: 2 }, request_key: 'template_test_001' });
    assert.equal(sent.json.data.status, 'outbox_written', JSON.stringify(sent.json));
    const mail = server.latestOutbox('template_test');
    assert.ok(mail.subject.includes('文案B')); assert.equal(mail.metadata.template_versions.otp, 2);
    const repeated = await call('/send', { mode: 'template', template_id: 'otp', variables: otp.sample, to: 'demo@tounar.local', expected_versions: { otp: 2 }, request_key: 'template_test_001' });
    assert.equal(repeated.json.data.reused, true);
    const conflict = await call('/send', { mode: 'template', template_id: 'otp', variables: { ...otp.sample, code: '654321' }, to: 'demo@tounar.local', expected_versions: { otp: 2 }, request_key: 'template_test_001' });
    assert.equal(conflict.status, 409);
    const restored = await call('/templates/otp/restore', { version: 1, expected_version: 2 });
    assert.equal(restored.json.data.version, 3); assert.equal(restored.json.data.subject, otp.subject);
  });
  it('可选变量缺失策略、固定文案、禁止词、长度及转义均在渲染前后校验', async () => {
    const item = state.templates.find(t => t.id === 'progress_item');
    const doc = { ...item, text: item.text+'\n城市：{{location}}', html: item.html+'<p>城市：{{location}}</p>' };
    const vars = { ...item.sample }; delete vars.location;
    const preview = (draft, variables = vars) => call('/preview', { mode: 'template', template_id: 'progress_item', variables, draft });
    assert.equal((await preview(doc)).status, 422);
    const empty = await preview({ ...doc, rules: { ...doc.rules, missing: 'empty' } });
    assert.equal(empty.status, 200); assert.ok(empty.json.data.text.includes('城市：'));
    const fallback = await preview({ ...doc, rules: { ...doc.rules, missing: 'fallback', fallback: '待补充' } });
    assert.ok(fallback.json.data.text.includes('城市：待补充'));
    assert.equal((await preview({ ...doc, rules: { ...doc.rules, missing: 'empty', fixed: ['固定文案尚未加入'] } })).status, 422);
    assert.equal((await preview({ ...doc, rules: { ...doc.rules, missing: 'empty', max_text: 5 } })).status, 422);
    const escaped = await preview(doc, { ...item.sample, company: '<script>纯文本</script>' });
    assert.equal(escaped.status, 200); assert.ok(escaped.json.data.html.includes('&lt;script&gt;'));
    const encoded = { ...doc, html: doc.html+'<p>保&#x8bc1;录用</p>', rules: { ...doc.rules, forbidden: ['保证录用'] } };
    assert.equal((await preview(encoded, item.sample)).status, 422);
  });
  it('业务通路读取真实提交记录、使用修改后的卡片和摘要版本、可重复测试且不消费正式通知', async () => {
    const app = await server.request('/api/v1/applications/manual', { method: 'POST', cookie, headers: { 'Idempotency-Key': key('mail-admin-create') }, body: { company_name: '自测科技', job_title: '产品经理', has_applied: true, status: 'applied', applied_date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }), jd_summary: '负责用户研究，仅用于自测', job_url: 'https://example.com/jobs/self-test-admin', location: '上海' } });
    assert.equal(app.status, 201, JSON.stringify(app.json));
    const appId = app.json.data.id;
    const item = state.templates.find(t => t.id === 'progress_item');
    const updated = { ...item, text: item.text+'\n城市：{{location}}；JD：{{jd_summary}}', html: item.html+'<p>城市：{{location}}；JD：{{jd_summary}}</p>' };
    assert.equal((await call('/templates/progress_item', { template: updated, expected_version: 1 }, 'PUT')).status, 200);
    for (let i=0; i<2; i++) {
      const p = await call('/preview', { mode: 'business', application_id: appId });
      assert.equal(p.status, 200, JSON.stringify(p.json));
      assert.ok(p.json.data.text.includes('负责用户研究'));
      const sent = await call('/send', { mode: 'business', application_id: appId, to: 'demo@tounar.local', expected_versions: p.json.data.template_versions, data_revision: p.json.data.data_revision, request_key: 'business_test_00'+i });
      assert.equal(sent.json.data.status, 'outbox_written', JSON.stringify(sent.json));
      const mail = server.latestOutbox('reminder');
      assert.ok(mail.subject.startsWith('【自测·业务通路】'));
      assert.ok(mail.text.includes('城市：上海')); assert.equal(mail.metadata.template_versions.progress_item, 2);
    }
    const normal = await server.request('/api/v1/notification-preferences/preview', { cookie });
    assert.ok(normal.json.data.a.some(x => x.application_id === appId));
    const records = (await call('/records', undefined, 'GET')).json.data;
    assert.ok(records.runs.some(x => x.mode === 'business' && x.status === 'outbox_written'));
    assert.ok(records.deliveries.some(x => x.template_versions.progress_item === 2));
    assert.ok(!JSON.stringify(records).includes('dev_code'));
    const stolen = await server.request('/api/v1/admin/mail/preview', { method: 'POST', cookie: peer, body: { mode: 'business', application_id: appId } });
    assert.equal(stolen.status, 403);
  });
  it('收件人限制、版本失效、缺少预览和任意业务记录被拒绝', async () => {
    assert.equal((await call('/send', { mode: 'template', to: 'stranger@example.com' })).status, 403);
    assert.equal((await call('/send', { mode: 'template', to: 'demo@tounar.local', request_key: 'no_preview_001' })).status, 409);
    assert.equal((await call('/send', { mode: 'template', template_id: 'otp', variables: { code: '123456', ttl_minutes: '10' }, to: 'demo@tounar.local', expected_versions: { otp: 1 }, request_key: 'stale_test_001' })).status, 409);
    assert.equal((await call('/preview', { mode: 'business', application_id: 'missing' })).status, 422);
  });
});
