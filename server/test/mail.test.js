import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import {
  classifyRecruitmentMail, extractMailFields, isRecruitmentHeader, publicEvidence, stripHtml
} from '../src/domain/mailParser.js';

describe('QQ 邮箱只读连接生命周期（无真实 IMAP：只验证失败可见、不假装成功）', () => {
  let server;
  let cookie;
  before(async () => {
    server = await startTestServer({ name: 'mail' });
    cookie = (await server.login('demo@tounar.local')).cookie;
  });
  after(async () => { await server.stop(); });

  it('参数校验：非 QQ 域名、短授权码、缺同意版本都拒绝', async () => {
    const badDomain = await server.request('/api/v1/mail-connections', { method: 'POST', cookie, body: { email: 'demo@gmail.com', auth_code: 'abcdefghijklmnop', mode: 'headers_only', consent_version: 'QQ_MAIL_READ_CONSENT_V1' } });
    assert.equal(badDomain.status, 400);
    const shortCode = await server.request('/api/v1/mail-connections', { method: 'POST', cookie, body: { email: 'demo@qq.com', auth_code: 'abc', mode: 'headers_only', consent_version: 'QQ_MAIL_READ_CONSENT_V1' } });
    assert.equal(shortCode.status, 400);
    const noConsent = await server.request('/api/v1/mail-connections', { method: 'POST', cookie, body: { email: 'demo@qq.com', auth_code: 'abcdefghijklmnop', mode: 'headers_only' } });
    assert.equal(noConsent.status, 400);
  });

  it('创建连接（本机无真实 IMAP）：返回 202，失败在状态里可见，响应不泄露授权码', async () => {
    const created = await server.request('/api/v1/mail-connections', {
      method: 'POST', cookie,
      body: { email: 'demo@qq.com', auth_code: 'abcdefghijklmnop', mode: 'headers_only', consent_version: 'QQ_MAIL_READ_CONSENT_V1' }
    });
    assert.equal(created.status, 202);
    const id = created.json.data.id;
    assert.ok(!/abcdefghijklmnop/.test(JSON.stringify(created.json)));
    let status = created.json.data.status;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const detail = await server.request(`/api/v1/mail-connections/${id}`, { cookie });
      status = detail.json.data.status;
      if (status !== 'connecting') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(['reauth_required', 'degraded', 'error', 'failed'].includes(status), `status=${status}`);
    const detail = await server.request(`/api/v1/mail-connections/${id}`, { cookie });
    assert.ok(detail.json.data.last_error_code, '失败必须留下错误码，不能假装已连接');
    assert.notEqual(detail.json.data.status, 'connected');
    const conflict = await server.request('/api/v1/mail-connections', {
      method: 'POST', cookie,
      body: { email: 'demo@qq.com', auth_code: 'abcdefghijklmnop', mode: 'headers_only', consent_version: 'QQ_MAIL_READ_CONSENT_V1' }
    });
    assert.equal(conflict.status, 409);
  });

  it('重新授权 / 断开 / 断开后同步被拒；历史台账不受影响', async () => {
    const list = await server.request('/api/v1/mail-connections', { cookie });
    const id = list.json.data[0].id;
    const reauth = await server.request(`/api/v1/mail-connections/${id}/reauthorize`, {
      method: 'POST', cookie, body: { auth_code: 'ponmlkjihgfedcba', consent_version: 'QQ_MAIL_READ_CONSENT_V1' }
    });
    assert.equal(reauth.status, 202);
    await new Promise((r) => setTimeout(r, 300));
    const disconnected = await server.request(`/api/v1/mail-connections/${id}/disconnect`, { method: 'POST', cookie, body: {} });
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.json.data.status, 'disconnected');
    assert.equal(disconnected.json.data.historical_ledger_retained, true);
    const sync = await server.request(`/api/v1/mail-connections/${id}/sync`, { method: 'POST', cookie, body: {} });
    assert.equal(sync.status, 409);
    assert.equal(sync.json.error.code, 'MAIL_DISCONNECTED');
  });

  it('跨用户隔离：他人邮箱连接不可见', async () => {
    const peer = await server.login('peer@tounar.local');
    const list = await server.request('/api/v1/mail-connections', { cookie });
    const id = list.json.data[0].id;
    const cross = await server.request(`/api/v1/mail-connections/${id}`, { cookie: peer.cookie });
    assert.equal(cross.status, 404);
    const peerList = await server.request('/api/v1/mail-connections', { cookie: peer.cookie });
    assert.equal(peerList.json.data.length, 0);
  });
});

describe('邮件解析纯函数（fixtures 单测，不访问网络）', () => {
  it('stripHtml 去标签、脚本样式与实体', () => {
    const text = stripHtml('<style>p{}</style><script>x()</script><p>你好&nbsp;&amp; 世界</p>');
    assert.equal(text, '你好 & 世界');
  });

  it('招聘邮件头识别：关键词/域名命中，促销邮件被排除', () => {
    assert.equal(isRecruitmentHeader('面试邀请函', 'qq.com', ''), true);
    assert.equal(isRecruitmentHeader('你好', 'jobs.example.com', ''), true);
    assert.equal(isRecruitmentHeader('本周热卖，优惠券', 'shop.example.com', ''), false);
    assert.equal(isRecruitmentHeader('【某某】本周促销优惠券', 'shop.example.com', ''), false);
  });

  it('分类：面试/笔试/Offer/拒绝/关闭与轮次、时间抽取', () => {
    const interview = classifyRecruitmentMail({ subject: '面试邀请：后端实习生（二面）', fromDomain: 'jobs.example.com', bodyText: '', mode: 'headers_only' });
    assert.equal(interview.category, 'interview');
    assert.equal(interview.status, 'interview');
    assert.equal(interview.round_label, '二面');
    assert.ok(interview.confidence >= 0.8);
    const assessment = classifyRecruitmentMail({ subject: '在线测评通知', fromDomain: 'hr.example.com', mode: 'headers_only' });
    assert.equal(assessment.status, 'assessment');
    const offer = classifyRecruitmentMail({ subject: '录用意向书 Offer', fromDomain: 'hr.example.com', mode: 'headers_only' });
    assert.equal(offer.status, 'offer');
    const rejected = classifyRecruitmentMail({ subject: '很遗憾，本次未通过', fromDomain: 'jobs.example.com', mode: 'headers_only' });
    assert.equal(rejected.status, 'rejected');
    assert.ok(rejected.confidence >= 0.9);
    const closed = classifyRecruitmentMail({ subject: '岗位关闭通知', fromDomain: 'jobs.example.com', mode: 'headers_only' });
    assert.equal(closed.status, 'closed');
    const irrelevant = classifyRecruitmentMail({ subject: '发票已开具', fromDomain: 'shop.example.com', mode: 'headers_only' });
    assert.equal(irrelevant.relevant, false);
    const scheduled = classifyRecruitmentMail({ subject: '面试通知 2026-11-03 14:30', fromDomain: 'jobs.example.com', mode: 'headers_only' });
    assert.ok(scheduled.interview_scheduled_at);
  });

  it('字段抽取：正文优先，主题兜底，申请号与域名', () => {
    const fromBody = extractMailFields({
      subject: '面试通知', fromAddress: 'hr@jobs.example.com',
      bodyText: '公司：星河科技\n岗位：后端实习生\n申请编号：APP-7788'
    });
    assert.equal(fromBody.company_name, '星河科技');
    assert.equal(fromBody.job_title, '后端实习生');
    assert.equal(fromBody.site_application_id, 'APP-7788');
    assert.equal(fromBody.from_domain, 'jobs.example.com');
    const fromSubject = extractMailFields({ subject: '【银河网络】前端开发实习生 面试邀请', fromAddress: 'campus@hr.example.com', bodyText: '' });
    assert.equal(fromSubject.company_name, '银河网络');
    assert.ok(fromSubject.job_title.includes('前端开发实习生'), fromSubject.job_title);
  });

  it('证据留存：headers_only 不保留正文，recruitment_body 只留摘要', () => {
    const headersOnly = publicEvidence({ subject: '面试通知', bodyText: '<p>正文内容</p>', mode: 'headers_only' });
    assert.equal(headersOnly.body_retained, false);
    assert.equal(headersOnly.body_excerpt, null);
    const bodyMode = publicEvidence({ subject: '面试通知', bodyText: '<p>正文内容</p>', mode: 'recruitment_body' });
    assert.equal(bodyMode.body_retained, false);
    assert.match(bodyMode.body_excerpt, /正文内容/);
  });
});
