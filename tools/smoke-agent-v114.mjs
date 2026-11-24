#!/usr/bin/env node
/* v1.1.4 real-model smoke. Usage:
 *   node --env-file=.env tools/smoke-agent-v114.mjs
 * Uses an isolated temp SQLite; never prints or persists API keys. */
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer } from '../server/test/helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'agent-v114-smoke.md');
const hasModel = Boolean((process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.AGENT_API_KEY)
  && (process.env.AI_API_URL || process.env.OPENROUTER_API_KEY || process.env.AGENT_API_URL));
if (!hasModel) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, '# v1.1.4 real-model smoke\n\n**BLOCKED**：未检测到可用模型凭据。未发送任何模型请求。\n');
  console.log(JSON.stringify({ blocked: true, report: OUT }, null, 2));
  process.exit(0);
}
let server;
const rows = [];
function row(name, ok, detail = '') {
  rows.push({ name, ok, detail: String(detail).slice(0, 400) });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${String(detail).slice(0, 180)}` : ''}`);
}
function parseSse(text) {
  return text.split('\n\n').map((block) => {
    const event = block.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
    const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
    return { event, data: data ? JSON.parse(data) : null };
  }).filter((item) => item.event);
}
async function chat(cookie, sessionId, message) {
  const response = await fetch(`${server.base}/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.base, Cookie: cookie },
    body: JSON.stringify({ message })
  });
  const text = await response.text();
  const events = parseSse(text);
  const error = events.find((item) => item.event === 'error')?.data;
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return events.find((item) => item.event === 'message')?.data;
}
async function confirm(cookie, actionId, key, body = {}) {
  const response = await server.request(`/api/v1/agent/actions/${encodeURIComponent(actionId)}/confirm`, {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key }, body
  });
  if (response.status !== 200) throw new Error(`${response.status}: ${response.text.slice(0, 240)}`);
  return response.json.data;
}
function strip(value) { return String(value || '').replace(/[\s，。；：、,.!?！？（）()【】\[\]]/g, '').toLowerCase(); }
try {
  server = await startTestServer({
    name: 'agent-v114-real-smoke',
    env: {
      AGENT_FAKE_MODE: 'false', AGENT_API_URL: '', OPENROUTER_API_KEY: '', AGENT_FALLBACK_MODEL: '',
      ALLOWED_EMAILS: 'demo@tounar.local,peer@tounar.local',
      AI_API_URL: process.env.AI_API_URL || '', AI_API_KEY: process.env.AI_API_KEY || '',
      AI_MODEL: process.env.AI_MODEL || '', AI_PROVIDER: process.env.AI_PROVIDER || 'openai_compatible',
      AGENT_TIMEOUT_MS: process.env.AGENT_TIMEOUT_MS || '120000'
    }
  });
  const login = await server.login('demo@tounar.local');
  const cookie = login.cookie;
  const resume = (await server.request('/api/v1/resumes/text', {
    method: 'POST', cookie, body: {
      filename: 'v1.1.4 真实模型测试简历',
      text: `张明\n教育背景\n本科 计算机科学\n项目经历\n2025 年在星河科技担任数据产品实习生，使用 Python 和 SQL 完成用户增长分析，留存提升 20%。\n2024 年在云杉数据负责用户访谈与问卷设计，输出研究报告并推动产品迭代。\n技能\nPython、SQL、用户研究、数据分析`
    }
  })).json.data;
  const app = (await server.request('/api/v1/applications/manual', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': 'v114-real-app' }, body: {
      company_name: '字节跳动', job_title: '数据分析师', has_applied: true, status: 'applied',
      applied_at: '2026-11-01T04:00:00Z', applied_at_precision: 'date',
      jd_summary: '负责数据分析和用户增长，要求 Python SQL 与业务分析能力，能够独立完成从问题定义到结论闭环。',
      job_url: 'https://jobs.example.com/v114-real'
    }
  })).json.data;
  const session = (await server.request('/api/v1/agent/sessions', { method: 'POST', cookie, body: { context_application_id: app.id, context_resume_id: resume.id } })).json.data;
  const cases = [
    ['查看本周投递情况并给出结论', '查看本周投递情况并给出结论'],
    ['筛选长期无反馈岗位', '找出超过 14 天没有反馈的岗位'],
    ['读取完整简历证据', '请读取我的完整简历内容，并总结与数据分析岗位相关的三条证据'],
    ['岗位字段写入确认卡', '把当前岗位的城市改为上海'],
    ['建立求职画像写入确认卡', '我的方向是产品经理，地点上海，行业互联网，企业偏好成长型公司，薪资月薪 20k–25k，工作方式混合办公，请帮我保存求职画像']
  ];
  for (const [name, prompt] of cases) {
    try {
      const result = await chat(cookie, session.id, prompt);
      const content = result?.message?.content || '';
      const actions = result?.actions || [];
      row(name, content.length >= 10 && !content.includes('AGENT_INVALID_RESPONSE'), content.slice(0, 140) || 'empty');
      if (actions.length) {
        try {
          const confirmed = await confirm(cookie, actions[0].id, `v114-real-${actions[0].id}`, actions[0].action_type === 'rewrite_resume' ? { set_current: false } : {});
          row(`${name} · 确认流`, true, JSON.stringify(confirmed.result).slice(0, 160));
        } catch (error) { row(`${name} · 确认流`, false, error.message); }
      }
    } catch (error) {
      row(name, false, error.message);
    }
  }
  // Real missing-JD card: the tool should return a structured card, not a dead-end error.
  try {
    const noJd = (await server.request('/api/v1/applications/manual', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': 'v114-real-no-jd' },
      body: { company_name: '缺JD公司', job_title: '待补岗位', has_applied: false, status: 'pending', jd_summary: '待补', job_url: 'https://jobs.example.com/v114-no-jd' }
    })).json.data;
    const noJdSession = (await server.request('/api/v1/agent/sessions', { method: 'POST', cookie, body: { context_application_id: noJd.id } })).json.data;
    const result = await chat(cookie, noJdSession.id, '分析这个岗位的匹配度');
    const cards = result?.message?.meta?.cards || [];
    row('缺 JD 内联补录卡信号', cards.some((card) => card.type === 'missing_jd' && card.application_id === noJd.id), cards.map((card) => card.type).join(',') || 'no cards');
  } catch (error) {
    row('缺 JD 内联补录卡信号', false, error.message);
  }
  // Two real rewrites with quality and Word checks.
  for (let i = 1; i <= 2; i += 1) {
    try {
      const response = await server.request('/api/v1/resumes/rewrite/drafts', {
        method: 'POST', cookie, body: { resume_id: resume.id, application_id: app.id, requirements: `第 ${i} 次 v1.1.4 真实质量测试，突出数据分析与用户增长` }
      });
      if (response.status !== 201) throw new Error(`${response.status}: ${response.text.slice(0, 200)}`);
      let draft = response.json.data;
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const poll = await server.request(`/api/v1/resumes/rewrite/drafts/${encodeURIComponent(draft.id)}`, { cookie });
        draft = poll.json?.data || draft;
        if (draft.status === 'failed') throw new Error(draft.error_message || 'rewrite failed');
        if (Number(draft.progress_percent) >= 100 && Array.isArray(draft.blocks) && draft.blocks.length) break;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      if (Number(draft.progress_percent) < 100 || !draft.blocks?.length) throw new Error('rewrite timeout');
      const business = draft.blocks.filter((block) => block.kind !== 'heading' && String(block.original_text || '').length >= 12);
      const changed = business.filter((block) => block.alignment_type !== 'unchanged' && strip(block.rewritten_text) !== strip(block.original_text)).length;
      const quality = business.length ? changed / business.length : 0;
      const bad = draft.blocks.filter((block) => /^[，。；：、,.!?！？]/.test(String(block.rewritten_text || '').trim()) || /\n$/.test(String(block.rewritten_text || '')));
      row(`简历改写 #${i} 质量/关键词/进度`, quality >= 0.3 && Boolean(draft.jd_analysis?.core_keywords?.length) && Boolean(draft.jd_analysis?.target_persona) && !bad.length,
        `progress=${draft.progress_percent} blocks=${draft.blocks.length} business=${business.length} changed=${changed} quality=${quality.toFixed(2)} keywords=${(draft.jd_analysis?.core_keywords || []).slice(0, 5).join('、')} persona=${draft.jd_analysis?.target_persona || ''} bad=${bad.length}`);
      const confirmedResponse = await server.request(`/api/v1/resumes/rewrite/drafts/${encodeURIComponent(draft.id)}/confirm`, {
        method: 'POST', cookie, headers: { 'Idempotency-Key': `v114-rewrite-${i}` },
        body: { name: `真实模型改写_${i}`, set_current: false }
      });
      if (confirmedResponse.status !== 200) throw new Error(`${confirmedResponse.status}: ${confirmedResponse.text.slice(0, 200)}`);
      const confirmed = confirmedResponse.json.data;
      const docx = await fetch(`${server.base}/api/v1/resumes/${confirmed.resume.id}/export.docx`, { headers: { Cookie: cookie } });
      const bytes = Buffer.from(await docx.arrayBuffer());
      row(`简历改写 #${i} Word`, docx.status === 200 && bytes.subarray(0, 2).toString('latin1') === 'PK', `bytes=${bytes.length}`);
    } catch (error) {
      row(`简历改写 #${i} 质量/关键词/进度`, false, error.message);
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `# v1.1.4 real-model smoke\n\n生成时间：${new Date().toISOString()}\n\n| 项目 | 结果 | 明细 |\n|---|---|---|\n${rows.map((item) => `| ${item.name} | ${item.ok ? '✅' : '❌'} | ${item.detail.replace(/\|/g, '\\|')} |`).join('\n')}\n\n- 使用调用方环境 AI_* 网关；未打印或写入 API Key。\n- 测试库：隔离临时 SQLite。\n`);
  const failed = rows.filter((item) => !item.ok);
  console.log(JSON.stringify({ report: OUT, passed: rows.length - failed.length, total: rows.length, failed }, null, 2));
  if (failed.length) process.exitCode = 1;
} catch (error) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `# v1.1.4 real-model smoke\n\n**FAILED**\n\n${String(error?.message || error).replace(/`/g, '')}\n`);
  console.error(error?.stack || error);
  process.exitCode = 1;
} finally {
  await server?.stop().catch(() => {});
}
