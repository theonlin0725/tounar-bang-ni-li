#!/usr/bin/env node
/*
 * v1.1.0 OpenRouter smoke test. Isolated temp SQLite; never reads the user DB.
 * Usage:
 *   OPENROUTER_API_KEY=... OPENROUTER_MODEL=google/gemini-2.5-flash \
 *     node tools/smoke-agent-openrouter.mjs
 * If AI_API_* is also configured, the match/interview case can use the same model
 * for career-ai; without it that case is explicitly reported as blocked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer } from '../server/test/helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '.tmp', 'agent-openrouter-smoke.md');
const key = String(process.env.OPENROUTER_API_KEY || '').trim();
if (!key) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, '# Agent OpenRouter smoke\n\n**状态：BLOCKED**\n\n未检测到 `OPENROUTER_API_KEY`，未发送任何模型请求。请由管理员在本地环境变量中提供 key 后重跑。\n');
  console.log(JSON.stringify({ blocked: true, report: OUT, reason: 'OPENROUTER_API_KEY missing' }, null, 2));
  process.exit(0);
}
const rows = [];
let server;
function row(name, ok, detail) { rows.push({ name, ok, detail }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`); }
async function chat(cookie, sessionId, message) {
  const response = await fetch(`${server.base}/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.base, Cookie: cookie },
    body: JSON.stringify({ message })
  });
  const text = await response.text();
  const events = text.split('\n\n').map((block) => {
    const event = block.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
    const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
    return { event, data: data ? JSON.parse(data) : null };
  }).filter((item) => item.event);
  const final = events.find((item) => item.event === 'message')?.data;
  const error = events.find((item) => item.event === 'error')?.data;
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return { final, events };
}
try {
  server = await startTestServer({
    name: 'agent-openrouter-smoke',
    env: {
      AGENT_FAKE_MODE: 'false', OPENROUTER_API_KEY: key,
      OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || process.env.AGENT_MODEL || 'google/gemini-2.5-flash',
      AGENT_MODEL: process.env.AGENT_MODEL || process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
      AGENT_TIMEOUT_MS: process.env.AGENT_TIMEOUT_MS || '90000'
    }
  });
  const login = await server.login('demo@tounar.local');
  const cookie = login.cookie;
  const resume = (await server.request('/api/v1/resumes/text', {
    method: 'POST', cookie, body: { text: '张三\n教育背景：计算机本科\n项目经历：使用 Python 做数据分析，完成用户增长项目，指标提升 20%。\n技能：Python SQL 数据分析', filename: 'OpenRouter 测试简历' }
  })).json.data;
  const analyzed = await server.request(`/api/v1/resumes/${encodeURIComponent(resume.id)}/analyze`, { method: 'POST', cookie, body: {} });
  row('简历结构化分析', analyzed.status === 200 && analyzed.json?.data?.status === 'ready', `${analyzed.status} ${analyzed.json?.error?.code || ''}`);
  const app = (await server.request('/api/v1/applications/manual', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': 'agent-openrouter-app' },
    body: { company_name: '字节跳动', job_title: '数据分析师', has_applied: true, status: 'applied', applied_at: '2026-11-01T04:00:00Z', applied_at_precision: 'date', jd_summary: '负责数据分析和用户增长，要求 Python SQL 与业务分析能力', job_url: 'https://jobs.example.com/openrouter/1' }
  })).json.data;
  const session = (await server.request('/api/v1/agent/sessions', { method: 'POST', cookie, body: { context_application_id: app.id } })).json.data;
  const chat1 = await chat(cookie, session.id, '找出超过 14 天没有反馈的岗位');
  row('查超期未反馈岗位', Boolean(chat1.final?.message) && (chat1.final?.message?.meta?.tools_used || []).includes('filter_applications'), chat1.final?.message?.content?.slice(0, 80));
  try {
    const chat2 = await chat(cookie, session.id, '分析这个岗位的匹配度并生成面试题');
    const tools = chat2.final?.message?.meta?.tools_used || [];
    const hasReport = (chat2.final?.references || []).some((ref) => ref.type === 'report');
    row('单岗位匹配与面试题', tools.includes('analyze_match') && tools.includes('generate_interview_questions') && hasReport, `tools=${tools.join(',') || 'none'}`);
  } catch (error) {
    row('单岗位匹配与面试题', false, `FAILED: ${error.message}`);
  }
  const chat3 = await chat(cookie, session.id, '把状态改为面试');
  const action = chat3.final?.actions?.find((item) => item.action_type === 'update_status');
  if (action) {
    const confirmed = await server.request(`/api/v1/agent/actions/${action.id}/confirm`, { method: 'POST', cookie, headers: { 'Idempotency-Key': 'openrouter-status-confirm' }, body: {} });
    row('批量/单条状态确认流', confirmed.status === 200 && confirmed.json?.data?.result?.ok_count >= 1, String(confirmed.status));
  } else row('批量/单条状态确认流', false, '模型未返回待确认操作');
  const chat4 = await chat(cookie, session.id, '按目标岗位 JD 定向改写简历');
  const rewrite = chat4.final?.actions?.find((item) => item.action_type === 'rewrite_resume');
  if (rewrite) {
    const confirmed = await server.request(`/api/v1/agent/actions/${rewrite.id}/confirm`, { method: 'POST', cookie, headers: { 'Idempotency-Key': 'openrouter-rewrite-confirm' }, body: { set_current: false } });
    row('简历改写并新建版本', confirmed.status === 200 && Boolean(confirmed.json?.data?.result?.resume?.id), String(confirmed.status));
  } else row('简历改写并新建版本', false, '模型未返回待确认操作');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `# Agent OpenRouter smoke\n\n生成时间：${new Date().toISOString()}\n\n| 项目 | 结果 | 明细 |\n|---|---|---|\n${rows.map((row) => `| ${row.name} | ${row.ok ? '✅' : '❌'} | ${String(row.detail || '').replace(/\|/g, '\\|')} |`).join('\n')}\n\n- 测试库：隔离临时 SQLite\n- 未打印或写入 API Key\n`);
  console.log(JSON.stringify({ report: OUT, rows, passed: rows.filter((row) => row.ok).length, total: rows.length }, null, 2));
} catch (error) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `# Agent OpenRouter smoke\n\n**FAILED / BLOCKED**\n\n\`${String(error?.message || error).replace(/`/g, '')}\`\n`);
  console.error(error?.stack || error);
  process.exitCode = 1;
} finally {
  await server?.stop().catch(() => {});
}
