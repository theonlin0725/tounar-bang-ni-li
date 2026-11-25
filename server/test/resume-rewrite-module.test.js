import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { buildRewriteBlocks, normalizeResumeBlocks } from '../src/modules/career-ai/rewrite-workbench.js';
import { hasResumeDescriptionChange } from '../../web/assets/js/views/resume-diff.js';

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

  async function waitDraft(id) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const response = await server.request(`/api/v1/resumes/rewrite/drafts/${encodeURIComponent(id)}`, { cookie });
      if (response.status !== 200) throw new Error(response.text);
      if (response.json.data.status === 'failed') throw new Error(response.json.data.error_message || 'rewrite failed');
      if (Number(response.json.data.progress_percent) >= 100 && response.json.data.blocks.length) return response.json.data;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('draft timeout');
  }

  it('PDF 软换行合并为完整句子，不产生半句残块', () => {
    const blocks = normalizeResumeBlocks('项目经历\n· 归因数\n据异动，总结“发\n情”\n· 第二个项目\n负责 SQL', { format: 'pdf' });
    assert.equal(blocks.some((block) => block.original_text.includes('归因数据异动，总结“发情”')), true);
    assert.equal(blocks.some((block) => /\n/.test(block.original_text)), false);
  });

  it('生成 9 步结构化草稿，标注待补事实，默认名称保留原简历与岗位', async () => {
    const response = await server.request('/api/v1/resumes/rewrite/drafts', {
      method: 'POST', cookie, body: { resume_id: resume.id, application_id: app.id, requirements: '突出数据分析' }
    });
    assert.equal(response.status, 201, response.text);
    let draft = response.json.data;
    assert.ok(draft.id);
    draft = await waitDraft(draft.id);
    assert.ok(draft.blocks.length >= 4);
    assert.ok(draft.report.needs_user_fact_count >= 1);
    assert.equal(draft.progress_percent, 100);
    assert.equal(draft.progress_label, '未生成有效改写');
    assert.ok(Array.isArray(draft.jd_analysis.hard_requirements));
    assert.ok(Array.isArray(draft.jd_analysis.core_competencies));
    assert.ok(Array.isArray(draft.jd_analysis.plus_items));
    assert.ok(Array.isArray(draft.jd_analysis.other_requirements));
    assert.match(draft.proposed_name, /^原简历_数据分析师$/);
    assert.ok(draft.jd_analysis.core_keywords.length >= 1);
    assert.ok(draft.jd_analysis.target_persona.length > 0);
    const active = await server.request('/api/v1/career-ai/rewrite-drafts/active', { cookie });
    assert.equal(active.status, 200, active.text);
    assert.ok(active.json.data.some((item) => item.id === draft.id && item.progress_percent === 100));
    const patched = await server.request(`/api/v1/resumes/rewrite/drafts/${draft.id}`, {
      method: 'PATCH', cookie, body: { blocks: draft.blocks.map((block) => block.block_id === 'b1' ? { ...block, rewritten_text: '张三（可编辑）' } : block) }
    });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.data.blocks.find((block) => block.block_id === 'b1').rewritten_text, '张三');
    draft.id = patched.json.data.id;
    // keep the draft for confirm in the same flow
    server.__draft = patched.json.data;
  });

  it('锁定章节和经历标题不会接受模型改动，待核实保留原文', () => {
    const built = buildRewriteBlocks('张三\n教育背景\n本科 计算机科学\n项目经历\n示例项目 03/2026\n· 原有项目描述\n荣誉&技能\nSQL', [
      ...['b1', 'b2', 'b3', 'b5', 'b8'].map((block_id) => ({ block_id, alignment_type: 'supported_optimize', rewritten_text: '不允许的修改' })),
      { block_id: 'b6', alignment_type: 'needs_user_fact', rewritten_text: '编造的指标' }
    ], {});
    assert.deepEqual(built.blocks.map((block) => block.editable), [false, false, false, false, false, true, false, false]);
    assert.ok(built.blocks.every((block) => block.rewritten_text === block.original_text));
    assert.equal(built.needs_user_fact.length, 1);
  });

  it('只改实习和项目的描述，保留原有标题、标签、日期和其他段落', () => {
    const lines = ['张三', '联系方式：example@example.test', '教育背景', '第一所学校   09/2026 - 06/2027-28', '信息管理',
      '第二所学校   09/2022 - 06/2026', '会计学', '总GPA:3.7/4.0', '实习经历', '示例公司 05/2025 - 08/2025',
      '产品实习生 | 上海', '【用户分析】', '用户分析：还原完整实习描述。', '项目经历', 'ScholarReview：AI 学术助手',
      '• 核心功能：整理文献、展示引用。', 'SkinLoop AI   07/2026', '核心功能：根据用户输入生成报告。',
      '荣誉&技能', '证书技能：Python', '语言能力：IELTS'];
    const built = buildRewriteBlocks(lines.join('\n'), lines.map((_, i) => ({
      block_id: `b${i + 1}`, alignment_type: 'supported_optimize', rewritten_text: '项目新表述'
    })), {}, { format: 'docx' });
    assert.deepEqual(built.blocks.map((b) => b.original_text), lines.map((line) => line.replace(/ +/g, ' ')));
    assert.deepEqual(built.blocks.filter((b) => b.editable).map((b) => b.block_id), ['b13', 'b16', 'b18']);
    assert.equal(built.blocks[12].rewritten_text, '用户分析：项目新表述');
    assert.equal(built.blocks[15].rewritten_text, '• 核心功能：项目新表述');
    assert.deepEqual(built.blocks.slice(14, 18).map((b) => b.kind), ['entry', 'bullet', 'entry', 'paragraph']);
    assert.ok(built.blocks.filter((b) => !b.editable).every((b) => b.rewritten_text === b.original_text));
  });

  it('替换和删减都算正文有变化，标点和空白不算', () => {
    assert.equal(hasResumeDescriptionChange('整理文献，展示引用。', '整理文献、\n展示引用'), false);
    assert.equal(hasResumeDescriptionChange('使用 Python 完成分析', '使用 SQL 完成分析'), true);
    assert.equal(hasResumeDescriptionChange('完成日报与月报', '完成日报'), true);
  });

  it('确认保存新版本并下载合法 OOXML Word；原简历不变且跨用户不可下载', async () => {
    const draft = server.__draft;
    const editable = draft.blocks.find((block) => block.editable);
    const address = `/api/v1/resumes/rewrite/drafts/${draft.id}`;
    const saved = await server.request(address, { method: 'PATCH', cookie,
      body: { blocks: [{ block_id: editable.block_id, rewritten_text: '很长的项目描述。'.repeat(600) }] } });
    assert.equal(saved.status, 200, saved.text);
    const overflow = await server.request(address + '/confirm', { method: 'POST', cookie,
      headers: { 'Idempotency-Key': 'rewrite-module-overflow' }, body: {} });
    assert.equal(overflow.status, 422, overflow.text);
    assert.match(overflow.text, /RESUME_EXCEEDS_A4_PAGE/);
    const restored = await server.request(address, { method: 'PATCH', cookie,
      body: { blocks: [{ block_id: editable.block_id, rewritten_text: editable.original_text }] } });
    assert.equal(restored.status, 200, restored.text);
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
