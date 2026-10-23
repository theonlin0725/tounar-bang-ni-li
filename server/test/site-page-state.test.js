import test from 'node:test';
import assert from 'node:assert/strict';
import { pageIssue, reportUrl } from '../../tools/site-page-state.mjs';

test('site probe rejects HTTP-200 errors, security redirects and loading shells', () => {
  const base = { url: 'https://jobs.example/job/123', status: 200, title: '职位详情', body: '导航 首页 登录 访问链接出错 版权所有' };
  assert.equal(pageIssue(base), 'unavailable_page');
  assert.equal(pageIssue({ ...base, body: 'BOSS 正在加载中... © copyright BOSS直聘' }), 'loading_page');
  assert.equal(pageIssue({ ...base, url: 'https://jobs.example/web/passport/zp/security.html?seed=fixture-private' }), 'verification_required');
  assert.equal(pageIssue({ ...base, url: 'about:blank', body: '' }), 'invalid_navigation');
  assert.equal(pageIssue({ ...base, body: 'x' }), 'empty_page');
  assert.equal(pageIssue({ ...base, status: 503 }), 'invalid_http_response');
  assert.equal(pageIssue({ ...base, body: '产品经理 岗位职责：负责产品规划和用户研究。立即申请' }), null);
  assert.equal(reportUrl('https://jobs.example/security.html?seed=fixture-private&callbackUrl=%2Fprivate'), 'https://jobs.example/security.html');
});
