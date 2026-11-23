import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startTestServer } from './helpers.js';

describe('v1.1.0 Agent assistant / tools / controlled writes', () => {
  let server;
  let cookie;
  let session;
  let app;
  let secondApp;
  let resume;
  let originalResumeText;
  before(async () => {
    server = await startTestServer({
      name: 'agent',
      env: {
        AGENT_FAKE_MODE: 'true', AGENT_API_URL: '', AGENT_API_KEY: '',
        AI_API_URL: '', AI_API_KEY: ''
      }
    });
    cookie = (await server.login('demo@tounar.local')).cookie;
    originalResumeText = '张三\n教育背景：本科计算机科学\n项目经历：使用 Python 做数据分析，完成用户增长项目，指标提升 20%。\n技能：Python SQL 数据分析';
    resume = (await server.request('/api/v1/resumes/text', {
      method: 'POST', cookie, body: { text: originalResumeText, filename: '测试简历' }
    })).json.data;
    app = (await server.request('/api/v1/applications/manual', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-test-app-1' },
      body: {
        company_name: '字节跳动', job_title: '数据分析师', has_applied: true, status: 'applied',
        applied_at: '2026-11-01T04:00:00Z', applied_at_precision: 'date',
        jd_summary: '负责数据分析和用户增长，要求 Python SQL 与业务分析能力',
        job_url: 'https://jobs.example.com/agent/1'
      }
    })).json.data;
    secondApp = (await server.request('/api/v1/applications/manual', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-test-app-2' },
      body: {
        company_name: '网易', job_title: '游戏策划', has_applied: true, status: 'assessment',
        applied_at: '2026-11-02T04:00:00Z', applied_at_precision: 'date',
        jd_summary: '负责游戏玩法策划与关卡设计，需要数据分析能力',
        job_url: 'https://jobs.example.com/agent/2'
      }
    })).json.data;
    session = (await server.request('/api/v1/agent/sessions', {
      method: 'POST', cookie, body: { context_application_id: app.id }
    })).json.data;
  });
  after(async () => { await server.stop(); });

  async function chat(message) {
    const response = await fetch(`${server.base}/api/v1/agent/sessions/${encodeURIComponent(session.id)}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.base, Cookie: cookie },
      body: JSON.stringify({ message })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    let final = null;
    for (const block of text.split('\n\n')) {
      const event = block.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
      const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
      if (event === 'message') final = JSON.parse(data);
    }
    assert.ok(final?.message, text);
    return final;
  }
  async function actionFrom(message) {
    const result = await chat(message);
    assert.equal(result.actions.length, 1, JSON.stringify(result));
    return result.actions[0];
  }

  it('画像工具只生成确认单，确认后落盘六维画像并进入会话上下文', async () => {
    const action = await actionFrom('帮我建立求职画像');
    assert.equal(action.action_type, 'update_profile');
    const before = (await server.request('/api/v1/profile', { cookie })).json.data;
    assert.equal(before.profile, null);
    const confirm = await server.request(`/api/v1/agent/actions/${action.id}/confirm`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-profile-confirm' }, body: {}
    });
    assert.equal(confirm.status, 200, confirm.text);
    assert.equal(confirm.json.data.result.profile.status, 'confirmed');
    const saved = (await server.request('/api/v1/profile', { cookie })).json.data.profile;
    assert.equal(saved.career_direction, '产品经理');
    assert.deepEqual(saved.preferred_locations, ['上海']);
    const context = (await server.request(`/api/v1/agent/context?session_id=${session.id}`, { cookie })).json.data.context;
    assert.equal(context.profile.status, 'confirmed');
    assert.equal(context.profile.career_direction, '产品经理');
  });

  it('上下文与会话 API 可用；筛选工具只读且不泄露工具原始 JSON', async () => {
    const context = await server.request('/api/v1/agent/context?session_id=' + session.id, { cookie });
    assert.equal(context.status, 200);
    assert.equal(context.json.data.context.resume.id, resume.id);
    const result = await chat('找出超过 14 天没有反馈的岗位');
    assert.equal(result.read_only, true);
    assert.equal(result.has_pending_write, false);
    assert.match(result.message.content, /岗位记录|没有|筛选/);
    assert.ok(!String(result.message.content).includes('"items"'));
    const messages = await server.request(`/api/v1/agent/sessions/${session.id}/messages`, { cookie });
    assert.equal(messages.json.data.messages.some((m) => m.role === 'assistant'), true);
  });

  it('台账增量筛选支持投递日期范围与超期未反馈，非法日期明确 400', async () => {
    const range = await server.request('/api/v1/ledger?view=applied&status=all&applied_from=2026-11-02&applied_to=2026-11-02&limit=50', { cookie });
    assert.equal(range.status, 200, range.text);
    assert.deepEqual(range.json.data.items.map((item) => item.id), [secondApp.id]);
    assert.equal(range.json.data.filters.applied_from, '2026-11-02');
    const inactive = await server.request('/api/v1/ledger?view=applied&status=all&inactive_days=14&limit=50', { cookie });
    assert.equal(inactive.status, 200, inactive.text);
    assert.ok(inactive.json.data.items.some((item) => item.id === app.id));
    const invalid = await server.request('/api/v1/ledger?view=applied&applied_from=not-a-date', { cookie });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, 'VALIDATION_ERROR');
  });

  it('搜索、详情与对比工具均通过会话编排返回，不把工具原始 JSON 放进正文', async () => {
    const search = await chat('搜索字节');
    assert.match(search.message.content, /找到|岗位/);
    const detail = await chat('查看岗位详情');
    assert.match(detail.message.content, /详情|岗位/);
    await server.request(`/api/v1/agent/sessions/${session.id}/context`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: server.base, Cookie: cookie },
      body: JSON.stringify({ context_application_id: app.id })
    });
    const compare = await chat('比较两个岗位');
    assert.match(compare.message.content, /对比|岗位/);
  });

  it('get_resume_detail 可读取完整简历；update_job_fields 只生成确认单，确认后才改字段', async () => {
    const detail = await chat('查看简历详情');
    assert.ok(detail.message.meta.tools_used.includes('get_resume_detail'));
    const action = await actionFrom('修改岗位信息');
    assert.equal(action.action_type, 'update_job_fields');
    const untouched = (await server.request(`/api/v1/applications/${app.id}`, { cookie })).json.data;
    assert.notEqual(untouched.location, '上海');
    const confirm = await server.request(`/api/v1/agent/actions/${action.id}/confirm`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-job-fields-confirm' }, body: {}
    });
    assert.equal(confirm.status, 200, confirm.text);
    assert.ok(confirm.json.data.result.ok_count >= 1);
    const updated = (await server.request(`/api/v1/applications/${app.id}`, { cookie })).json.data;
    assert.equal(updated.location, '上海');
  });

  it('update_status 未确认不写库；确认时逐条校验版本并写 agent 审计', async () => {
    const before = (await server.request(`/api/v1/applications/${app.id}`, { cookie })).json.data;
    const action = await actionFrom('把状态改为面试');
    assert.equal(action.action_type, 'update_status');
    const untouched = (await server.request(`/api/v1/applications/${app.id}`, { cookie })).json.data;
    assert.equal(untouched.status, before.status);
    const confirm = await server.request(`/api/v1/agent/actions/${action.id}/confirm`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-confirm-status-1' }, body: {}
    });
    assert.equal(confirm.status, 200, confirm.text);
    assert.equal(confirm.json.data.result.ok_count, 1);
    const after = (await server.request(`/api/v1/applications/${app.id}`, { cookie })).json.data;
    assert.equal(after.status, 'interview');
    assert.ok(after.history.some((row) => row.from_status === 'applied' && row.to_status === 'interview'));
  });

  it('过期版本的动作会跳过冲突项而不是覆盖新记录', async () => {
    const action = await actionFrom('把状态改为笔试');
    const current = (await server.request(`/api/v1/applications/${app.id}`, { cookie })).json.data;
    const manual = await server.request(`/api/v1/applications/${app.id}/status`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-manual-conflict' },
      body: { status: 'assessment', expected_version: current.version }
    });
    assert.equal(manual.status, 200, manual.text);
    const confirm = await server.request(`/api/v1/agent/actions/${action.id}/confirm`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-confirm-status-2' }, body: {}
    });
    assert.equal(confirm.status, 200, confirm.text);
    assert.ok(confirm.json.data.result.skipped_count >= 1);
    assert.ok(confirm.json.data.result.items.some((item) => item.reason === 'VERSION_CONFLICT'));
    assert.equal(confirm.json.data.action.status, 'failed');
    const after = (await server.request(`/api/v1/applications/${app.id}`, { cookie })).json.data;
    assert.equal(after.status, 'assessment');
  });

  it('取消动作需要幂等键；过期动作保持 expired 而不是回滚成 pending', async () => {
    const cancelAction = await actionFrom('把状态改为面试');
    const cancel = await server.request(`/api/v1/agent/actions/${cancelAction.id}/cancel`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-cancel-test' }, body: {}
    });
    assert.equal(cancel.status, 200, cancel.text);
    assert.equal(cancel.json.data.status, 'cancelled');
    const confirmCancelled = await server.request(`/api/v1/agent/actions/${cancelAction.id}/confirm`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-confirm-cancelled' }, body: {}
    });
    assert.equal(confirmCancelled.status, 409);

    const expired = await actionFrom('把状态改为面试');
    const db = new DatabaseSync(path.join(server.dir, 'tounar.sqlite'));
    try {
      db.prepare('UPDATE agent_pending_actions SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', expired.id);
    } finally { db.close(); }
    const expiredConfirm = await server.request(`/api/v1/agent/actions/${expired.id}/confirm`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-expired-test' }, body: {}
    });
    assert.equal(expiredConfirm.status, 409);
    assert.equal(expiredConfirm.json.error.code, 'AGENT_ACTION_EXPIRED');
    const check = new DatabaseSync(path.join(server.dir, 'tounar.sqlite'));
    try {
      const row = check.prepare('SELECT status FROM agent_pending_actions WHERE id = ?').get(expired.id);
      assert.equal(row.status, 'expired');
    } finally { check.close(); }
  });

  it('工具原始 JSON 只落在 agent_tool_runs，不进入消息正文；确认写入 agent_confirmed 审计', async () => {
    const db = new DatabaseSync(path.join(server.dir, 'tounar.sqlite'));
    try {
      const toolRuns = db.prepare("SELECT tool_name, message_id, output_summary_json FROM agent_tool_runs WHERE owner_id = (SELECT id FROM users WHERE email_normalized = 'demo@tounar.local') ORDER BY created_at DESC").all();
      assert.ok(toolRuns.length >= 3);
      assert.ok(toolRuns.every((row) => row.message_id));
      assert.ok(toolRuns.some((row) => String(row.output_summary_json).includes('items')));
      const rawInMessages = db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE content LIKE '%\"items\"%'").get();
      assert.equal(Number(rawInMessages.n), 0);
      const audits = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor = 'agent_confirmed' AND action IN ('application.status.agent','resume.rewrite.agent')").get();
      assert.ok(Number(audits.n) >= 1);
    } finally { db.close(); }
  });

  it('其他用户不能读取会话或确认动作', async () => {
    const other = await server.login('peer@tounar.local');
    const message = await server.request(`/api/v1/agent/sessions/${session.id}/messages`, { cookie: other.cookie });
    assert.equal(message.status, 404);
    const action = await actionFrom('把状态改为面试');
    const confirm = await server.request(`/api/v1/agent/actions/${action.id}/confirm`, {
      method: 'POST', cookie: other.cookie, headers: { 'Idempotency-Key': 'agent-other-confirm' }, body: {}
    });
    assert.equal(confirm.status, 404);
  });

  it('rewrite_resume 确认后新建版本，原简历事实和版本行保持不变', async () => {
    const action = await actionFrom('帮我按这个岗位的 JD 优化简历');
    assert.equal(action.action_type, 'rewrite_resume');
    const confirm = await server.request(`/api/v1/agent/actions/${action.id}/confirm`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-confirm-rewrite-1' }, body: { set_current: false }
    });
    assert.equal(confirm.status, 200, confirm.text);
    const created = confirm.json.data.result.resume;
    assert.ok(created.id);
    assert.equal(created.parent_resume_id, resume.id);
    assert.equal(created.target_application_id, app.id);
    assert.equal(created.is_current, false);
    const original = (await server.request(`/api/v1/resumes/${resume.id}`, { cookie })).json.data;
    assert.equal(original.text, originalResumeText);
    const versions = (await server.request('/api/v1/resumes?limit=10', { cookie })).json.data;
    assert.ok(versions.some((item) => item.id === created.id && item.parent_resume_id === resume.id));
    const secondAction = await actionFrom('再按这个岗位优化一版简历');
    const secondConfirm = await server.request(`/api/v1/agent/actions/${secondAction.id}/confirm`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-confirm-rewrite-2' }, body: { set_current: true }
    });
    assert.equal(secondConfirm.status, 200, secondConfirm.text);
    const second = secondConfirm.json.data.result.resume;
    const context = (await server.request(`/api/v1/agent/context?session_id=${session.id}`, { cookie })).json.data.context;
    assert.equal(context.resume.id, second.id);
    assert.equal(context.resume.is_current, true);
    const boundary = (await server.request(`/api/v1/agent/sessions/${session.id}/messages`, { cookie })).json.data.messages;
    assert.ok(boundary.some((message) => message.role === 'context_boundary' && message.content.includes(second.filename)));
  });

  it('切换岗位写入 context_boundary，新上下文不携带旧岗位详情', async () => {
    const patch = await fetch(`${server.base}/api/v1/agent/sessions/${session.id}/context`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: server.base, Cookie: cookie },
      body: JSON.stringify({ context_application_id: secondApp.id })
    });
    assert.equal(patch.status, 200);
    const messages = (await server.request(`/api/v1/agent/sessions/${session.id}/messages`, { cookie })).json.data.messages;
    assert.ok(messages.some((message) => message.role === 'context_boundary' && message.content.includes('网易')));
    const context = (await server.request(`/api/v1/agent/context?session_id=${session.id}`, { cookie })).json.data.context;
    assert.equal(context.application.id, secondApp.id);
    assert.equal(context.application.job_title, '游戏策划');
  });
});
