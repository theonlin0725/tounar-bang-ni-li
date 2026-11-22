import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/* Directly exercise analyze_match + generate_interview_questions against a fake
 * OpenAI-compatible career-ai gateway. This complements the fake-agent E2E. */
describe('v1.1.0 Agent match/interview tools', () => {
  const dir = path.resolve('.tmp/tests/agent-tools-match');
  const resumeText = '张明\n数据产品实习生\n熟悉 SQL、Python 与用户研究。\n2026 年在星河科技担任数据产品实习生，负责指标体系和用户研究，推动留存提升。';
  let fake;
  let ownerId = 'user_agent_match_tools';
  let app;
  let app2;
  let resume;
  let executeTool;

  before(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.env.DATA_DIR = dir;
    process.env.AI_API_URL = 'http://127.0.0.1:1/v1';
    process.env.AI_API_KEY = 'test';
    process.env.AI_MODEL = 'fake';
    process.env.CLOUD_LLM_ENABLED = 'false';
    fake = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body || '{}');
      const system = payload.messages?.[0]?.content || '';
      let answer;
      if (system.includes('简历结构化助手')) {
        answer = {
          summary: '数据产品实习生，具备 SQL、用户研究和跨团队沟通经验。',
          skills: [{ name: 'SQL', evidence: '熟悉 SQL' }, { name: '用户研究', evidence: '用户研究' }],
          experiences: [{ organization: '星河科技', role: '数据产品实习生', period: '2026', highlights: ['指标体系', '用户研究'], evidence: '2026 年在星河科技担任数据产品实习生' }],
          industries: [{ name: '数据产品', evidence: '数据产品实习生' }],
          strengths: [{ point: '跨团队沟通', evidence: '跨团队沟通' }], constraints: []
        };
      } else if (system.includes('岗位比较助手')) {
        const input = JSON.parse(payload.messages?.[1]?.content || '{}');
        answer = { overview: '对比完成', jobs: input.jobs.map((j) => ({ application_id: j.application_id, match_level: 'medium', strengths: ['SQL'], gaps: [], evidence: [{ resume_evidence: '熟悉 SQL', jd_evidence: 'SQL' }], next_step: '补充项目' })), differences: [], ranking: [], limitations: [] };
      } else if (system.includes('单岗位求职匹配分析助手')) {
        answer = {
          ability: { conclusion: '部分匹配', summary: 'SQL 与用户研究有可迁移基础。', basis: '简历有 SQL 和用户研究。' },
          priority: { conclusion: '适合投', summary: '能力可迁移，先补齐项目证据。', basis: '简历有相关实习。' },
          overall_advice: '先确认岗位年限要求并补充项目结果。',
          hard_gates: [],
          dimensions: [
            { key: 'hard_gate', requirement: '见硬性门槛', user_evidence: '见门槛表', conclusion: '匹配', strengths: [], gaps: [], evidence: [], next_step: '无' },
            { key: 'skills', requirement: 'SQL、数据分析、用户研究', user_evidence: '熟悉 SQL 与用户研究', conclusion: '匹配', strengths: ['SQL 和用户研究可迁移'], gaps: [], evidence: [{ source: 'resume', quote: '熟悉 SQL' }, { source: 'jd', quote: 'SQL' }], next_step: '补充 SQL 项目' },
            { key: 'experience', requirement: '数据产品实习', user_evidence: '2026 年在星河科技担任数据产品实习生', conclusion: '部分匹配', strengths: ['有实习经历'], gaps: [], evidence: [{ source: 'resume', quote: '2026 年在星河科技担任数据产品实习生' }], next_step: '补充交付物' },
            { key: 'industry', requirement: '数据产品行业', user_evidence: '数据产品实习', conclusion: '部分匹配', strengths: ['有行业场景'], gaps: [], evidence: [{ source: 'resume', quote: '数据产品实习生' }], next_step: '补充行业理解' },
            { key: 'preference', requirement: '上海线下', user_evidence: '简历未写', conclusion: '无法判断', strengths: [], gaps: ['需确认地点'], evidence: [], next_step: '确认地点' },
            { key: 'achievements', requirement: '量化结果', user_evidence: '推动留存提升', conclusion: '部分匹配', strengths: ['有留存结果'], gaps: [], evidence: [{ source: 'resume', quote: '推动留存提升' }], next_step: '补充指标口径' }
          ],
          limitations: ['简历没有学历信息']
        };
      } else if (system.includes('面试准备助手')) {
        answer = { questions: [
          { question: '你如何用 SQL 和用户研究推动留存提升？', basis: '简历：推动留存提升；JD：SQL 与用户研究', dimension: 'skills' },
          { question: '你如何补充数据产品项目结果？', basis: 'JD：数据分析', dimension: 'experience' }
        ] };
      } else {
        answer = { questions: [] };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
    await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
    process.env.AI_API_URL = `http://127.0.0.1:${fake.address().port}/v1`;
    const db = await import('../src/db.js');
    const util = await import('../src/util.js');
    const career = await import('../src/modules/career-ai/service.js');
    const applications = await import('../src/domain/applications.js');
    const profiles = await import('../src/modules/profile/service.js');
    const tools = await import('../src/modules/agent/tools.js');
    executeTool = tools.executeTool;
    db.run('INSERT INTO users (id, email_normalized, email_display, allowlisted, created_at) VALUES (?, ?, ?, 1, ?)',
      [ownerId, 'agent-tools@tounar.local', 'agent-tools@tounar.local', util.nowIso()]);
    profiles.saveProfile(ownerId, { career_direction: '数据产品', preferred_locations: ['上海'], industry_preferences: ['互联网'] }, { status: 'confirmed' });
    resume = await career.createResumeFromText({ ownerId, text: resumeText, filename: 'Agent 匹配测试简历' });
    resume = await career.analyzeResume(ownerId, resume.id);
    assert.equal(resume.status, 'ready');
    app = applications.manualCreate({ ownerId, idempotencyKey: 'agent-tools-match-app-1', body: {
      company_name: '星河科技', job_title: '数据产品经理', has_applied: true, status: 'applied',
      applied_at: '2026-11-01T04:00:00Z', applied_at_precision: 'date',
      jd_summary: '负责数据产品需求分析、SQL 数据分析与用户研究，要求推动留存提升。',
      job_url: 'https://jobs.example.com/agent-tools/1'
    } });
    app2 = applications.manualCreate({ ownerId, idempotencyKey: 'agent-tools-match-app-2', body: {
      company_name: '云帆科技', job_title: '用户增长分析师', has_applied: true, status: 'applied',
      applied_at: '2026-11-02T04:00:00Z', applied_at_precision: 'date',
      jd_summary: '负责 SQL 数据分析、增长实验与用户研究，要求有数据产品经验。',
      job_url: 'https://jobs.example.com/agent-tools/2'
    } });
  });
  after(async () => { await new Promise((resolve) => fake?.close(resolve)); });

  it('analyze_match 生成六维报告，同简历同岗位再次调用复用 ready 报告', async () => {
    const first = await executeTool({ ownerId, sessionId: 'unit-session', toolName: 'analyze_match', args: { application_id: app.id } });
    assert.ok(first.data.report_id);
    assert.ok(first.data.result);
    assert.equal(Array.isArray(first.data.result.dimensions) ? first.data.result.dimensions.length : 0, 6);
    const db = new (await import('node:sqlite')).DatabaseSync(path.join(dir, 'tounar.sqlite'));
    try {
      const row = db.prepare('SELECT context_json FROM ai_reports WHERE id = ?').get(first.data.report_id);
      assert.equal(JSON.parse(row.context_json).user_profile.career_direction, '数据产品');
    } finally { db.close(); }
    const second = await executeTool({ ownerId, sessionId: 'unit-session', toolName: 'analyze_match', args: { application_id: app.id } });
    assert.equal(second.summary, '已复用该岗位的六维匹配报告');
    assert.equal(second.data.report_id, first.data.report_id);
  });

  it('generate_interview_questions 读取报告并持久化面试题', async () => {
    const result = await executeTool({ ownerId, sessionId: 'unit-session', toolName: 'generate_interview_questions', args: { application_id: app.id } });
    assert.ok(result.data.report_id);
    assert.ok(result.data.questions.questions.length >= 1);
    assert.ok(result.data.questions.questions.every((q) => q.question && q.dimension));
    const db = new DatabaseSync(path.join(dir, 'tounar.sqlite'));
    try {
      const row = db.prepare('SELECT interview_result_json FROM ai_reports WHERE id = ?').get(result.data.report_id);
      assert.ok(row?.interview_result_json, 'interview questions were not persisted');
      const cached = await executeTool({ ownerId, sessionId: 'unit-session', toolName: 'generate_interview_questions', args: { report_id: result.data.report_id } });
      assert.deepEqual(cached.data.questions.questions, result.data.questions.questions);
    } finally { db.close(); }
  });

  it('会话所选简历优先于全局当前简历，报告记录正确 resume_id', async () => {
    const career = await import('../src/modules/career-ai/service.js');
    let second = await career.createResumeFromText({ ownerId, text: `${resumeText}\n补充：版本二`, filename: '第二份简历' });
    second = await career.analyzeResume(ownerId, second.id);
    const result = await executeTool({ ownerId, sessionId: 'unit-session', toolName: 'analyze_match', args: { application_id: app2.id, force: true }, contextResumeId: second.id });
    assert.ok(result.data.report_id);
    assert.equal(result.data.result.resume.id, second.id);
  });

  it('目标岗位无匹配报告时先自动触发 analyze_match 再出题', async () => {
    const result = await executeTool({ ownerId, sessionId: 'unit-session', toolName: 'generate_interview_questions', args: { application_id: app2.id } });
    assert.ok(result.data.report_id);
    assert.ok(result.data.questions.questions.length >= 1);
  });
});
