import { dataRevision, run } from '../../db.js';
import { AppError, newId, safeJsonParse } from '../../util.js';
import { chatAgent } from './llm.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import {
  agentContext, appendMessage, getSession, listMessages, recordToolRun
} from './store.js';

const MAX_STEPS = 6;
const MAX_TOOL_CALLS = 6;
const STATUS_TEXT = {
  search_jobs: '正在搜索投递台账…',
  filter_applications: '正在筛选投递台账…',
  get_job_detail: '正在读取岗位详情…',
  get_resume_detail: '正在读取简历全文…',
  update_job_fields: '正在准备岗位字段修改确认…',
  compare_jobs: '正在对比岗位信息…',
  analyze_match: '正在运行单岗位六维匹配…',
  generate_interview_questions: '正在生成面试题与答题框架…',
  update_status: '正在准备状态修改确认…',
  rewrite_resume: '正在生成逐段改写建议（预计 15–30 秒）…'
};

function systemPrompt(context) {
  return `你是「帮你理 Tounar」的求职助手。只通过工具读取/操作用户自己的数据，并在回答中保持克制、准确、可执行。
当前用户上下文（只包含当前聚焦岗位，不包含其他岗位的完整 JD）：
${JSON.stringify(context)}
规则：
1. 台账查询、岗位详情、对比、匹配、面试题可以使用只读工具；不要编造没有返回的数据。
2. 修改投递状态、修改岗位字段或保存简历改写版本必须先调用对应工具（update_status / update_job_fields / rewrite_resume）生成待确认操作，再告诉用户需要确认；绝不能声称已经直接写入。
3. 回答用自然、简洁的中文，先给结论，再给必要的依据/下一步。涉及岗位/报告/新版本时保留可读名称，工具内部 JSON 不要展示给用户。
4. 如果用户没有指定岗位，优先使用当前上下文岗位；确实无法确定时只问一个澄清问题。
5. 当用户要建立或更新求职画像时，分 3–5 轮收集：职业发展方向+期望地点、行业+企业偏好、薪资+工作方式；用户一次答全可提前收敛。信息足够后必须调用 update_profile 生成确认卡，绝不能声称已保存。
6. 画像只记录用户明确表达的偏好；缺失维度留空，不要推测。当前版本仍没有投递策略分析或自定义提醒天数能力。
7. 单次可并行发起多个只读工具调用（如同时查台账 + 读简历），优先用最少轮次拿到信息后直接作答，不要重复查询。
最多使用 ${MAX_STEPS} 次工具调用。`;
}

function historyForModel(messages) {
  // A context switch deliberately cuts model memory: old岗位 JD/结论 can remain
  // visible in the UI, but must never be reused as evidence in the new context.
  let start = 0;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role === 'context_boundary') start = i + 1;
  }
  return messages.slice(start).filter((message) => message.role !== 'context_boundary').slice(-12).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content
  }));
}

function compactToolPayload(data) {
  if (!data || typeof data !== 'object') return data;
  if (data.action) {
    return { ...data, action: { id: data.action.id, action_type: data.action.action_type, status: data.action.status, summary: data.action.summary } };
  }
  return data;
}

function suggestionsFor({ toolsUsed, actions }) {
  if (actions.length) return ['确认后刷新台账', '我想换一个岗位', '取消这次操作'];
  if (toolsUsed.includes('filter_applications')) return ['按状态再看一次', '找出 14 天没有反馈的岗位', '比较其中两个岗位'];
  if (toolsUsed.includes('get_job_detail')) return ['帮我分析这个岗位的匹配度', '生成面试题', '按这个 JD 优化简历'];
  if (toolsUsed.includes('analyze_match')) return ['生成面试题', '按 JD 改写简历', '比较另一个岗位'];
  return ['查看本周投递情况', '找出长期没有反馈的岗位', '比较两个岗位的匹配度'];
}

function fakeAgentTurn({ messages, context }) {
  const toolMessages = messages.filter((message) => message.role === 'tool');
  if (toolMessages.length) {
    let data = null;
    try { data = JSON.parse(toolMessages.at(-1).content || '{}'); } catch { data = {}; }
    if (data.action) return { content: '已生成待确认操作，请在下方卡片中确认后执行。', toolCalls: [], model: 'agent-fake', usage: null };
    return {
      content: data.summary || `已读取到 ${Array.isArray(data.items) ? data.items.length : 0} 条相关记录。你希望我继续分析或比较哪些岗位？`,
      toolCalls: [], model: 'agent-fake', usage: null
    };
  }
  const user = String([...messages].reverse().find((message) => message.role === 'user')?.content || '');
  const contextApp = context?.application?.id || null;
  let name = 'filter_applications';
  let args = {};
  if (/简历详情|读取简历/.test(user)) { name = 'get_resume_detail'; args = {}; }
  else if (/修改岗位|改岗位|更新岗位|补充 JD|补 JD/.test(user)) { name = 'update_job_fields'; args = contextApp ? { application_id: contextApp, changes: { location: '上海' }, reason: '用户要求更新岗位信息' } : {}; }
  else if (/画像/.test(user)) { name = 'update_profile'; args = { career_direction: '产品经理', preferred_locations: ['上海'], industry_preferences: ['互联网'], company_preferences: ['成长型公司'], salary_expectation: '月薪 20k–25k', work_mode: '混合办公' }; }
  else if (/比较/.test(user)) { name = 'compare_jobs'; args = { application_ids: (context?.recent_applications || []).slice(0, 2).map((app) => app.id) }; }
  else if (/搜索|查找.*岗位|找.*公司/.test(user)) { name = 'search_jobs'; args = { query: user.replace(/搜索|查找/g, '').trim() || '字节' }; }
  else if (/面试题/.test(user)) { name = 'generate_interview_questions'; args = { application_id: contextApp }; }
  else if (/匹配/.test(user)) { name = 'analyze_match'; args = { application_id: contextApp }; }
  else if (/改写|优化.*简历|简历.*优化/.test(user)) { name = 'rewrite_resume'; args = { application_id: contextApp }; }
  else if (/改.*状态|状态改|批量修改/.test(user)) { const picked = contextApp || context?.recent_applications?.[0]?.id; name = 'update_status'; args = { items: picked ? [{ application_id: picked, status: 'interview' }] : [] }; }
  else if (/没有反馈|未反馈|14 天/.test(user)) args = { inactive_days: 14 };
  else if (/本周/.test(user)) { const d = new Date(); d.setDate(d.getDate() - 7); args = { applied_from: d.toISOString().slice(0, 10), applied_to: new Date().toISOString().slice(0, 10) }; }
  else if (/详情|JD/.test(user)) { name = 'get_job_detail'; args = { application_id: contextApp }; }
  const call = { id: `call_fake_${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  return { content: '', toolCalls: [call], model: 'agent-fake', usage: null };
}

export async function runAgentChat({ ownerId, sessionId, userMessage, onStatus = () => {} }) {
  const session = getSession(ownerId, sessionId);
  const cleanMessage = String(userMessage || '').trim();
  if (!cleanMessage) throw new AppError(400, 'VALIDATION_ERROR', '请输入问题');
  if (cleanMessage.length > 4000) throw new AppError(422, 'VALIDATION_ERROR', '问题不能超过 4000 字');
  const userRow = appendMessage({ ownerId, sessionId, role: 'user', content: cleanMessage, meta: { read_only: true } });
  const context = agentContext(ownerId, session);
  const stored = listMessages(ownerId, sessionId);
  const transcript = historyForModel(stored);
  const messages = [{ role: 'system', content: systemPrompt(context) }, ...transcript];

  const toolRuns = [];
  const toolRunIds = [];
  const refs = [];
  const actions = [];
  const cards = [];
  let finalContent = '';
  let modelUsed = null;
  let steps = 0;
  let toolCallsUsed = 0;
  onStatus('正在理解你的问题…');
  while (steps < MAX_STEPS && toolCallsUsed < MAX_TOOL_CALLS) {
    steps += 1;
    const response = process.env.AGENT_FAKE_MODE === 'true'
      ? fakeAgentTurn({ messages, context })
      : await chatAgent({ messages, tools: TOOL_DEFINITIONS, toolChoice: 'auto', temperature: 0.2 });
    modelUsed = response.model || modelUsed;
    if (!response.toolCalls.length) {
      finalContent = response.content || '';
      break;
    }
    messages.push({ role: 'assistant', content: response.content || '', tool_calls: response.toolCalls });
    for (const call of response.toolCalls) {
      const toolName = call?.function?.name;
      if (toolCallsUsed >= MAX_TOOL_CALLS) {
        messages.push({ role: 'tool', tool_call_id: call.id, name: toolName || 'unknown', content: JSON.stringify({ error: 'AGENT_STEP_LIMIT', message: '本轮工具调用次数已达上限' }) });
        continue;
      }
      toolCallsUsed += 1;
      if (!toolName) {
        messages.push({ role: 'tool', tool_call_id: call.id, name: 'unknown', content: JSON.stringify({ error: 'AGENT_TOOL_UNKNOWN', message: '模型返回了缺少名称的工具调用' }) });
        continue;
      }
      onStatus(toolName === 'rewrite_resume' ? '正在读取岗位 JD 与原简历…' : (STATUS_TEXT[toolName] || '正在读取求职数据…'));
      if (toolName === 'rewrite_resume') setTimeout(() => onStatus(STATUS_TEXT.rewrite_resume), 500);
      const args = safeJsonParse(call?.function?.arguments || '{}', {}) || {};
      const started = Date.now();
      try {
        const result = await executeTool({ ownerId, sessionId, toolName, args, contextApplicationId: session.context_application_id, contextResumeId: session.context_resume_id });
        const latency = Date.now() - started;
        const auditData = compactToolPayload(result.data || { summary: result.summary });
        const toolRunId = recordToolRun({ ownerId, sessionId, toolName, input: args, output: auditData, status: 'ok', latencyMs: latency, usage: response.usage });
        toolRunIds.push(toolRunId);
        toolRuns.push({ name: toolName, summary: result.summary, latency_ms: latency });
        refs.push(...(result.refs || []));
        if (result.data?.action) actions.push(result.data.action);
        if (Array.isArray(result.data?.cards)) cards.push(...result.data.cards.map((card) => ({ ...card, resume_prompt: cleanMessage })));
        messages.push({ role: 'tool', tool_call_id: call.id, name: toolName, content: JSON.stringify({ ...auditData, summary: result.summary }) });
      } catch (error) {
        const latency = Date.now() - started;
        const toolRunId = recordToolRun({ ownerId, sessionId, toolName, input: args, output: { error: error?.code || 'TOOL_FAILED', message: String(error?.message || error).slice(0, 300) }, status: 'error', latencyMs: latency, usage: response.usage });
        toolRunIds.push(toolRunId);
        toolRuns.push({ name: toolName, error: error?.code || 'TOOL_FAILED', latency_ms: latency });
        messages.push({ role: 'tool', tool_call_id: call.id, name: toolName, content: JSON.stringify({ error: error?.code || 'TOOL_FAILED', message: String(error?.message || '操作失败').slice(0, 300) }) });
      }
    }
  }
  if (!finalContent) {
    // Never end a tool-heavy turn with a canned "please narrow it down" reply.
    // Close the tool loop and ask the model to summarize the data it already has.
    try {
      onStatus('正在整理已读取的信息并生成结论…');
      if (process.env.AGENT_FAKE_MODE === 'true') {
        finalContent = '已根据本轮读取的台账/简历信息整理结论；请查看上方数据摘要，或告诉我希望优先关注的岗位。';
      } else {
        const closing = await chatAgent({
          messages: [...messages, { role: 'system', content: '已达到本轮工具调用上限。请立刻只基于以上已读取到的工具数据，直接向用户输出清晰、结构化的中文结论与下一步建议；不要再调用工具，不要要求用户缩小范围，除非确实缺少关键信息。' }],
          tools: [], toolChoice: 'none', temperature: 0.2, maxTokens: 3600
        });
        finalContent = String(closing.content || '').trim();
      }
    } catch (error) {
      finalContent = '';
    }
    if (!finalContent) finalContent = '本轮已读取到部分信息，但模型没有返回可读结论。请重试本轮，或换一种问法；我不会伪造未读取到的数据。';
  }
  const actionSummaries = actions.map((action) => ({ id: action.id, action_type: action.action_type, summary: action.summary }));
  const meta = {
    read_only: actionSummaries.length === 0,
    has_pending_write: actionSummaries.length > 0,
    references: [...new Map(refs.map((ref) => [`${ref.type}:${ref.id}`, ref])).values()],
    suggestions: suggestionsFor({ toolsUsed: toolRuns.map((run) => run.name), actions: actionSummaries }),
    actions: actionSummaries,
    cards: [...new Map(cards.map((card) => [`${card.type}:${card.application_id}`, card])).values()],
    tools_used: toolRuns.map((run) => run.name)
  };
  const assistant = appendMessage({ ownerId, sessionId, role: 'assistant', content: finalContent, meta });
  for (const action of actionSummaries) {
    run('UPDATE agent_pending_actions SET message_id=? WHERE id=? AND owner_id=? AND message_id IS NULL', [assistant.id, action.id, ownerId]);
  }
  for (const runId of toolRunIds) {
    run('UPDATE agent_tool_runs SET message_id=? WHERE id=? AND owner_id=? AND message_id IS NULL', [assistant.id, runId, ownerId]);
  }
  return {
    message: assistant,
    action: actions[0] || null,
    actions,
    mutated_entities: [],
    data_revision: dataRevision(),
    model: modelUsed,
    tool_runs: toolRuns,
    user_message_id: userRow.id,
    // Keep a tiny diagnostic only in server audit; raw tool output never enters content.
    _debug: process.env.AGENT_DEBUG === 'true' ? { steps } : undefined
  };
}
