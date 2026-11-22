import { AppError } from '../../util.js';
import { flushCloudPersistence } from '../../cloud/persistence.js';
import { runAgentChat } from './orchestrator.js';
import {
  agentContext, appendMessage, archiveSession, cancelAction, confirmAction, createSession, getSession,
  listMessages, listPendingActions, listSessions, updateContext
} from './store.js';

export function getAgentContext(ownerId, sessionId = null) {
  const session = sessionId ? getSession(ownerId, sessionId) : null;
  return { session, context: agentContext(ownerId, session), now: new Date().toISOString() };
}
export function getAgentSessions(ownerId) { return listSessions(ownerId); }
export function createAgentSession(ownerId, body = {}) {
  return createSession(ownerId, {
    title: body.title, contextResumeId: body.context_resume_id || null,
    contextApplicationId: body.context_application_id || null
  });
}
export function updateAgentContext(ownerId, sessionId, body = {}) {
  return updateContext(ownerId, sessionId, {
    contextResumeId: body.context_resume_id === undefined ? undefined : body.context_resume_id,
    contextApplicationId: body.context_application_id === undefined ? undefined : body.context_application_id
  });
}
export function deleteAgentSession(ownerId, sessionId) { return archiveSession(ownerId, sessionId); }
export function getAgentMessages(ownerId, sessionId) {
  const session = getSession(ownerId, sessionId);
  return { session, messages: listMessages(ownerId, sessionId), pending_actions: listPendingActions(ownerId, sessionId) };
}
export function confirmAgentAction(ownerId, actionId, body = {}) { return confirmAction(ownerId, actionId, body || {}); }
export function cancelAgentAction(ownerId, actionId) { return cancelAction(ownerId, actionId); }

function sseWrite(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
export async function streamAgentChat({ ownerId, sessionId, body, res, req = null }) {
  // Validate before SSE headers so 404/400/ownership failures still use the
  // normal JSON error contract and never masquerade as a 200 stream.
  if (!String(body?.message || '').trim()) throw new AppError(400, 'VALIDATION_ERROR', '请输入问题');
  getSession(ownerId, sessionId);
  req?.setTimeout?.(0);
  res.setTimeout?.(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, 8000);
  heartbeat.unref?.();
  try {
    const result = await runAgentChat({
      ownerId, sessionId, userMessage: body.message,
      onStatus: (text) => sseWrite(res, 'status', { text })
    });
    sseWrite(res, 'message', {
      message: result.message, actions: result.actions,
      references: result.message?.meta?.references || [],
      suggestions: result.message?.meta?.suggestions || [],
      read_only: result.message?.meta?.read_only !== false,
      has_pending_write: result.message?.meta?.has_pending_write === true
    });
    try {
      await flushCloudPersistence();
    } catch {
      sseWrite(res, 'error', { code: 'PERSISTENCE_UNAVAILABLE', message: '本轮结果暂未安全保存，请稍后重试', retryable: true });
      return;
    }
    sseWrite(res, 'done', { mutated_entities: result.mutated_entities || [], data_revision: result.data_revision });
  } catch (error) {
    const safe = error instanceof AppError;
    const message = safe ? error.message : 'AI 助手处理失败，请稍后重试';
    const retryText = [...listMessages(ownerId, sessionId)].reverse().find((item) => item.role === 'user')?.content || '';
    let errorMessage = null;
    try {
      errorMessage = appendMessage({
        ownerId, sessionId, role: 'assistant',
        content: `本轮处理失败：${message}`,
        meta: { is_error: true, retry_text: retryText, retryable: safe ? !!error.retryable : true }
      });
      sseWrite(res, 'message', {
        message: errorMessage, actions: [], references: [], suggestions: [],
        read_only: true, has_pending_write: false, is_error: true
      });
    } catch { /* keep the SSE error below even if the fallback message cannot be stored */ }
    sseWrite(res, 'error', {
      code: safe ? error.code : 'AGENT_FAILED', message,
      retryable: safe ? !!error.retryable : true,
      message_id: errorMessage?.id || null
    });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

export function assertAgentSession(ownerId, sessionId) {
  if (!sessionId) throw new AppError(400, 'VALIDATION_ERROR', '缺少会话 ID');
  return getSession(ownerId, sessionId);
}
