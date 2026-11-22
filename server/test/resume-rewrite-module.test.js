import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { buildRewriteBlocks } from '../src/modules/career-ai/rewrite-workbench.js';

describe('v1.1.1 resume library rewrite workbench', () => {
  let server;
  let cookie;
  let peerCookie;
  let resume;
  let app;
  before(async () => {
    server = await startTestServer({ name: 'resume-rewrite', env: { AGENT_FAKE_MODE: 'true', AGENT_API_URL: '', AGENT_API_KEY: '', AI_API_URL: '', AI_API_KEY: '' } });
    cookie = (await server.login('demo@tounar.local')).cookie;
    peerCookie = (await server.login('peer@tounar.local')).cookie;
    resume = (await server.request('/api/v1/resumes/text', {
      method: 'POST', cookie, body: {
        text: '张三\n教育背景\n本科 计算机科学\n项目经历\n使用 Python 做数据分析，完成用户增长项目，指标提升 20%\n技能\nSQL 数据分析',
        filename: '原简历.pdf'
      }
    })).json.data;
    app = (await server.request('/api/v1/applications/manual', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'rewrite-module-app' }, body: {
        company_name: '字节跳动', job_title: '数据分析师', has_applied: true, status: 'applied',
        applied_at: '2026-11-01T04:00:00Z', applied_at_precision: 'date',
        jd_summary: '负责数据分析和用户增长，要求 Python SQL 与业务分析能力',
        job_url: 'https://jobs.example.com/rewrite-module'
      }
    })).json.data;
  });
  after(async () => { await server.stop(); });

  it('生成 9 步结构化草稿，标注待补事实，默认名称保留原简历与岗位', async () => {
    const response = await server.request('/api/v1/resumes/rewrite/drafts', {
      method: 'POST', cookie, body: { resume_id: resume.id, application_id: app.id, requirements: '突出数据分析' }
    });
    assert.equal(response.status, 201, response.text);
    const draft = response.json.data;
    assert.ok(draft.id);
    assert.ok(draft.blocks.length >= 4);
    assert.ok(draft.report.needs_user_fact_count >= 1);
    assert.match(draft.proposed_name, /^原简历_数据分析师$/);
    const patched = await server.request(`/api/v1/resumes/rewrite/drafts/${draft.id}`, {
      method: 'PATCH', cookie, body: { blocks: draft.blocks.map((block) => block.block_id === 'b1' ? { ...block, rewritten_text: '张三（可编辑）' } : block) }
    });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.data.blocks.find((block) => block.block_id === 'b1').rewritten_text, '张三（可编辑）');
    draft.id = patched.json.data.id;
    // keep the draft for confirm in the same flow
    server.__draft = patched.json.data;
  });

  it('unsupported_blocked 不会把模型新建内容写进最终块；needs_user_fact 保留原文', async () => {
    const built = buildRewriteBlocks('张三\n技能\nSQL', [
      { block_id: 'b1', alignment_type: 'supported_optimize', rewritten_text: '张三（优化）' },
      { block_id: 'b2', alignment_type: 'unsupported_blocked', rewritten_text: '不存在的技能' },
      { block_id: 'b3', alignment_type: 'needs_user_fact', rewritten_text: '编造的指标' }
    ], {});
    assert.equal(built.blocks[0].rewritten_text, '张三（优化）');
    assert.equal(built.blocks[1].rewritten_text, '技能');
    assert.equal(built.blocks[2].rewritten_text, 'SQL');
    assert.deepEqual(built.blocked_blocks, ['b2']);
    assert.equal(built.needs_user_fact.length, 1);
  });

  it('确认保存新版本并下载合法 OOXML Word；原简历不变且跨用户不可下载', async () => {
    const draft = server.__draft;
    const confirm = await server.request(`/api/v1/resumes/rewrite/drafts/${draft.id}/confirm`, {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'rewrite-module-confirm' },
      body: { name: '字节数据分析_新版', set_current: false }
    });
    assert.equal(confirm.status, 200, confirm.text);
    const created = confirm.json.data.resume;
    assert.equal(created.parent_resume_id, resume.id);
    assert.equal(created.target_application_id, app.id);
    assert.equal(created.is_current, false);
    assert.ok(created.export_docx_path);
    const original = (await server.request(`/api/v1/resumes/${resume.id}`, { cookie })).json.data;
    assert.ok(original.text.includes('使用 Python'));
    const download = await fetch(`${server.base}/api/v1/resumes/${created.id}/export.docx`, { headers: { Cookie: cookie } });
    const body = Buffer.from(await download.arrayBuffer());
    assert.equal(download.status, 200);
    assert.equal(body.subarray(0, 2).toString('latin1'), 'PK');
    assert.ok(body.includes(Buffer.from('word/document.xml')));
    const peer = await fetch(`${server.base}/api/v1/resumes/${created.id}/export.docx`, { headers: { Cookie: peerCookie } });
    assert.equal(peer.status, 404);
  });
});
