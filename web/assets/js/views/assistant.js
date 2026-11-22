/* v1.1.0 AI 求职助手：自然语言查询/分析/受控写入。
 * 工具结果只有服务端审计；这里只展示轻量状态、自然语言结论和待确认卡。 */
import { api, errorText } from '../api.js';
import { h, clear, toast, fmtDateTime, openModal } from '../util.js';

const STATUS_LABEL = {
  applied: '已投递', assessment: '笔试/测评', interview: '面试中',
  offer: '录用', rejected: '拒绝', closed: '已结束', pending: '待投递'
};
const QUICK_CARDS = [
  ['查看本周投递情况', '查看本周投递情况', '按投递时间汇总本周进展'],
  ['找出长期没有反馈的岗位', '找出超过 14 天没有反馈的岗位', '筛选投递后长期没有新进展的记录'],
  ['比较两个岗位的匹配度', '比较两个岗位的匹配度', '选择两个岗位做横向对比'],
  ['优化某个岗位的简历', '帮我按这个岗位的 JD 优化简历', '生成逐段改写建议，确认后新建版本']
];

export async function renderAssistant(container, { gen, applicationId = null, resumeId = null } = {}) {
  const root = h('div', { class: 'tn-assistant', 'data-test': 'assistant-view' });
  container.append(root);
  let context = null;
  let session = null;
  let sessions = [];
  let messages = [];
  let pendingActions = [];
  let sending = false;
  let aborter = null;
  let statusText = '';
  let inputEl = null;
  let composerEl = null;

  const top = h('div', { class: 'tn-assistant-top' });
  const welcome = h('section', { class: 'tn-assistant-welcome' });
  const thread = h('section', { class: 'tn-assistant-thread', 'data-test': 'assistant-thread' });
  const composer = h('div', { class: 'tn-assistant-composer' });
  composerEl = composer;
  root.append(top, welcome, thread, composer);

  function errorMessage(error) {
    if (error?.code === 'AGENT_NOT_CONFIGURED') return 'AI 助手尚未配置模型网关，请联系管理员配置 AGENT_API_KEY / OPENROUTER_API_KEY。';
    return errorText(error);
  }

  function renderTop() {
    clear(top);
    top.append(
      h('div', {},
        h('p', { class: 'tn-assistant-subtitle', text: '统一自然语言入口 · 可查询、可分析、可受控写入' })
      ),
      h('div', { class: 'tn-assistant-top-actions' },
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'assistant-history', text: '历史会话', onclick: openHistory }),
        h('button', { class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', 'data-test': 'assistant-clear', text: '清空对话', onclick: clearConversation })
      )
    );
  }

  function renderWelcome() {
    clear(welcome);
    if (messages.some((m) => m.role === 'user')) { welcome.hidden = true; return; }
    welcome.hidden = false;
    const resumeLabel = context?.resume?.filename || '未选择简历';
    const appLabel = context?.application ? `${context.application.company_name || ''} · ${context.application.job_title || ''}` : '全部岗位';
    welcome.append(
      h('div', { class: 'tn-assistant-greeting', text: '你好，我可以帮助你管理和优化求职过程。' }),
      h('div', { class: 'tn-assistant-context-pills' },
        h('span', { class: 'tn-agent-pill', text: `${context?.stats?.total_applied || 0} 条投递 · ${context?.resumes?.length || 0} 份简历` }),
        h('span', { class: 'tn-agent-pill', text: `当前岗位：${appLabel}` }),
        h('span', { class: 'tn-agent-pill', text: `当前简历：${resumeLabel}` })
      ),
      h('div', { class: 'tn-agent-cards' }, ...QUICK_CARDS.map(([label, prompt, desc]) => h('button', {
        type: 'button', class: 'tn-agent-quick-card', 'data-test': `assistant-quick-${label}`,
        onclick: () => { if (inputEl) { inputEl.value = prompt; send(); } }
      }, h('strong', { text: label }), h('span', { text: desc }))))
    );
  }

  function renderContextBar() {
    const bar = h('div', { class: 'tn-assistant-context-bar', 'data-test': 'assistant-context' });
    const resumeSelect = h('select', { class: 'tn-select tn-select-sm', 'data-test': 'assistant-context-resume' });
    resumeSelect.append(h('option', { value: '', text: '默认（当前简历）' }));
    const resumeOptions = [...(context?.resumes || [])];
    if (context?.resume && !resumeOptions.some((item) => item.id === context.resume.id)) resumeOptions.unshift(context.resume);
    for (const resume of resumeOptions) {
      resumeSelect.append(h('option', { value: resume.id, text: `${resume.filename}${resume.is_current ? '（当前）' : ''}` }));
    }
    resumeSelect.value = context?.resume?.id || '';
    resumeSelect.addEventListener('change', () => patchContext({ context_resume_id: resumeSelect.value || null }));
    const appSelect = h('select', { class: 'tn-select tn-select-sm', 'data-test': 'assistant-context-application' });
    appSelect.append(h('option', { value: '', text: '全部岗位' }));
    const appOptions = [...(context?.recent_applications || [])];
    if (context?.application && !appOptions.some((item) => item.id === context.application.id)) appOptions.unshift(context.application);
    for (const app of appOptions) {
      appSelect.append(h('option', { value: app.id, text: `${app.company_name || '未命名'} · ${app.job_title || '岗位'}` }));
    }
    appSelect.value = context?.application?.id || '';
    appSelect.addEventListener('change', () => patchContext({ context_application_id: appSelect.value || null }));
    bar.append(
      h('span', { class: 'tn-assistant-context-label', text: '当前上下文' }),
      h('label', { class: 'tn-assistant-context-field' }, h('span', { text: '简历' }), resumeSelect),
      h('label', { class: 'tn-assistant-context-field' }, h('span', { text: '岗位' }), appSelect),
      h('span', { class: 'tn-small tn-muted', text: '切换简历或岗位会同步更新本轮上下文' })
    );
    return bar;
  }

  function renderMessage(message) {
    const meta = message.meta || {};
    if (message.role === 'context_boundary') {
      return h('div', { class: 'tn-agent-boundary', 'data-test': 'assistant-boundary', text: message.content });
    }
    const isUser = message.role === 'user';
    const node = h('article', { class: `tn-agent-message ${isUser ? 'user' : 'assistant'}`, 'data-test': isUser ? 'assistant-user-message' : 'assistant-message' });
    if (isUser) {
      node.append(h('div', { class: 'tn-agent-bubble user', text: message.content }));
      return node;
    }
    node.append(
      h('div', { class: 'tn-agent-message-head' },
        h('span', { text: `对话 · 会话 #${String(session?.id || '').slice(-6)} · ${fmtDateTime(message.created_at)}` }),
        h('span', { class: 'tn-agent-permission', text: meta.has_pending_write ? '含待确认写操作' : '本轮仅使用只读工具' })
      ),
      h('div', { class: 'tn-agent-bubble assistant' }, ...String(message.content || '').split('\n').map((line) => h('p', { text: line || ' ' })))
    );
    if (meta.references?.length) {
      node.append(h('div', { class: 'tn-agent-links' }, ...meta.references.map((ref) => h('a', {
        href: ref.type === 'application' ? `/?app=${encodeURIComponent(ref.id)}` : (ref.type === 'report' ? (ref.application_id ? `/?panel=career&section=match&app=${encodeURIComponent(ref.application_id)}&report=${encodeURIComponent(ref.id)}` : '/?panel=career&section=match') : '#'),
        class: 'tn-agent-link', text: ref.label || ref.type
      }))));
    }
    for (const action of meta.actions || []) {
      const actual = pendingActions.find((item) => item.id === action.id);
      node.append(renderActionCard(actual || { id: action.id, ...action }, meta));
    }
    if (meta.suggestions?.length) {
      node.append(h('div', { class: 'tn-agent-suggestions' }, ...meta.suggestions.map((suggestion) => h('button', {
        type: 'button', class: 'tn-agent-suggestion', text: suggestion,
        onclick: () => { if (inputEl) { inputEl.value = suggestion; send(); } }
      }))));
    }
    return node;
  }

  function renderActionCard(action, meta) {
    const summary = action.summary || {};
    const payload = action.payload || {};
    const actual = pendingActions.find((item) => item.id === action.id);
    const status = actual?.status || (action.status === 'pending' || !action.status ? 'processed' : action.status);
    const isRewrite = action.action_type === 'rewrite_resume' || summary.title?.includes('简历');
    const card = h('section', { class: 'tn-agent-action', 'data-test': 'assistant-action-card' },
      h('div', { class: 'tn-agent-action-head' },
        h('strong', { text: summary.title || '待确认写操作' }),
        h('span', { class: 'tn-agent-action-status', text: status === 'pending' ? '待确认' : status === 'processed' ? '已处理' : (status || '') })
      ),
      h('div', { class: 'tn-agent-action-body' }));
    if (isRewrite) {
      card.querySelector('.tn-agent-action-body').append(...[
        h('div', { class: 'tn-small', text: `${summary.application || ''} · ${summary.source_resume || ''}` }),
        h('div', { class: 'tn-small tn-muted', text: `${summary.section_count || payload.sections?.length || 0} 段改写 · ${summary.version_label || payload.version_label || ''}` }),
        h('details', {}, h('summary', { text: '查看逐段改写对比' }), ...(payload.sections || summary.preview || []).map((section) => h('div', { class: 'tn-agent-diff' },
          h('div', { class: 'tn-agent-diff-title', text: section.section_name || '' }),
          h('div', { class: 'tn-agent-diff-old', text: section.original_excerpt || '' }),
          h('div', { class: 'tn-agent-diff-new', text: section.rewritten_excerpt || '' }),
          section.reason ? h('div', { class: 'tn-small tn-muted', text: `改动原因：${section.reason}` }) : null
        ))),
        payload.full_rewritten_text ? h('details', {}, h('summary', { text: '查看完整改写稿' }), h('pre', { class: 'tn-agent-full-rewrite', text: payload.full_rewritten_text })) : null
      ].filter(Boolean));
    } else {
      const items = summary.items || payload.items || [];
      card.querySelector('.tn-agent-action-body').append(...[
        h('div', { class: 'tn-small tn-muted', text: `影响 ${items.length || summary.count || 0} 条记录；逐条检查版本后写入。` }),
        ...items.map((item) => h('div', { class: 'tn-agent-action-row', text: `${item.company_name || ''} · ${item.job_title || ''}：${STATUS_LABEL[item.from_status] || item.from_status || '当前'} → ${STATUS_LABEL[item.status] || item.status || ''}` })),
        summary.risk ? h('div', { class: 'tn-agent-risk', text: summary.risk }) : null
      ].filter(Boolean));
    }
    if (status !== 'pending') {
      card.querySelector('.tn-agent-action-body').append(h('div', { class: 'tn-small tn-muted', text: '该操作已处理。' }));
      return card;
    }
    const actions = h('div', { class: 'tn-agent-action-buttons' });
    let setCurrentBox = null;
    if (isRewrite) {
      const label = h('label', { class: 'tn-small' });
      setCurrentBox = h('input', { type: 'checkbox' });
      label.append(setCurrentBox, document.createTextNode(' 保存后设为当前简历'));
      card.querySelector('.tn-agent-action-body').append(label);
    }
    const cancel = h('button', { type: 'button', class: 'tn-btn tn-btn-sm tn-btn-ghost', text: '取消', onclick: async () => {
      cancel.disabled = true; confirm.disabled = true;
      try { await api.post(`/api/v1/agent/actions/${encodeURIComponent(action.id)}/cancel`, {}, { idempotencyKey: `agent-cancel-${action.id}` }); toast('已取消'); await loadSession(session.id); }
      catch (error) { cancel.disabled = false; confirm.disabled = false; toast(errorMessage(error), 'err'); }
    } });
    const confirm = h('button', { type: 'button', class: 'tn-btn tn-btn-sm tn-btn-primary', text: isRewrite ? '保存为新版本' : '确认执行', onclick: async () => {
      cancel.disabled = true; confirm.disabled = true; confirm.textContent = '正在执行…';
      try {
        const response = await api.post(`/api/v1/agent/actions/${encodeURIComponent(action.id)}/confirm`, { set_current: !!setCurrentBox?.checked }, { idempotencyKey: `agent-action-${action.id}` });
        const result = response.data?.result;
        if (isRewrite) {
          const needsAnalysis = Boolean(setCurrentBox?.checked && result?.resume?.status && result.resume.status !== 'ready');
          toast(needsAnalysis ? '已保存并设为当前；请到简历库重新分析后用于匹配' : '已保存为新简历版本', needsAnalysis ? 'info' : 'ok');
        }
        else if (!result || result.ok_count === 0) toast('未执行任何状态修改：' + (result?.items?.find((item) => !item.ok)?.reason || '请检查记录版本'), 'err');
        else if (result.skipped_count) toast(`已更新 ${result.ok_count} 条，跳过 ${result.skipped_count} 条（版本冲突或不存在）`, 'err');
        else toast('状态已更新', 'ok');
        window.dispatchEvent(new CustomEvent('tounar:data-changed', { detail: { entities: isRewrite ? ['resumes'] : ['applications'], result } }));
        await loadSession(session.id);
      } catch (error) {
        cancel.disabled = false; confirm.disabled = false; confirm.textContent = isRewrite ? '保存为新版本' : '确认执行';
        toast(errorMessage(error), 'err');
      }
    } });
    actions.append(cancel, confirm);
    card.append(actions);
    return card;
  }

  function renderThread({ append = null } = {}) {
    clear(thread);
    if (!messages.length) return;
    thread.append(...messages.filter((m) => m.role !== 'context_boundary' || true).map(renderMessage));
    if (statusText) {
      thread.append(h('div', { class: 'tn-agent-status', 'data-test': 'assistant-status' }, h('span', { class: 'tn-agent-pulse' }), statusText));
    }
    if (append) thread.append(append);
  }

  function renderComposer() {
    clear(composer);
    composer.append(renderContextBar());
    const row = h('div', { class: 'tn-assistant-input-row' });
    inputEl = h('textarea', { class: 'tn-assistant-input', rows: '1', 'data-test': 'assistant-input', placeholder: '输入你的问题，例如「找出超过 14 天没有反馈的岗位」或「帮我按字节这个岗改写简历」' });
    const sendButton = h('button', { class: 'tn-btn tn-btn-primary tn-assistant-send', type: 'button', 'data-test': 'assistant-send', text: '发送' });
    sendButton.addEventListener('click', send);
    inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
    });
    row.append(inputEl, sendButton);
    composer.append(row);
    composerEl = row;
  }

  async function loadContext(id = session?.id) {
    const data = (await api.get(`/api/v1/agent/context${id ? `?session_id=${encodeURIComponent(id)}` : ''}`)).data;
    context = data.context;
    if (data.session) session = data.session;
    renderWelcome();
    renderComposer();
  }

  async function loadSession(id) {
    const data = (await api.get(`/api/v1/agent/sessions/${encodeURIComponent(id)}/messages`)).data;
    session = data.session;
    messages = data.messages || [];
    pendingActions = data.pending_actions || [];
    await loadContext(id);
    renderThread();
    if (inputEl) inputEl.focus();
  }

  async function createAndLoadSession(withApplication = null, withResume = null) {
    const data = (await api.post('/api/v1/agent/sessions', {
      context_application_id: withApplication || undefined,
      context_resume_id: withResume || undefined,
      title: withApplication ? '岗位定向对话' : '求职对话'
    })).data;
    session = data;
    sessions = [data, ...sessions.filter((item) => item.id !== data.id)];
    await loadSession(data.id);
  }

  async function patchContext(body) {
    if (!session) return;
    try {
      await api.patch(`/api/v1/agent/sessions/${encodeURIComponent(session.id)}/context`, body);
    } catch (error) {
      toast(errorMessage(error), 'err');
      return;
    }
    await loadSession(session.id);
  }

  async function send() {
    if (!session || sending || !inputEl) return;
    const text = String(inputEl.value || '').trim();
    if (!text) return;
    inputEl.value = '';
    sending = true;
    statusText = '正在理解你的问题…';
    renderThread();
    const optimistic = { role: 'user', content: text, meta: {} };
    messages.push(optimistic);
    renderThread();
    aborter = new AbortController();
    const sendButton = composer.querySelector('[data-test=assistant-send]');
    if (sendButton) { sendButton.textContent = '停止'; sendButton.onclick = () => { aborter?.abort(); }; }
    try {
      const response = await fetch(`/api/v1/agent/sessions/${encodeURIComponent(session.id)}/chat`, {
        method: 'POST', credentials: 'same-origin', signal: aborter.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text })
      });
      if (!response.ok) {
        let payload = null; try { payload = await response.json(); } catch { /* ignore */ }
        throw Object.assign(new Error(payload?.error?.message || 'AI 助手请求失败'), { code: payload?.error?.code });
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const lines = block.split('\n');
          const event = lines.find((line) => line.startsWith('event: '))?.slice(7) || 'message';
          const dataText = lines.find((line) => line.startsWith('data: '))?.slice(6) || '{}';
          let data = {};
          try { data = JSON.parse(dataText); } catch { /* ignore */ }
          if (event === 'status') {
            statusText = data.text || '';
            renderThread();
          } else if (event === 'message') {
            statusText = '';
            messages = messages.filter((message) => message !== optimistic).concat([optimistic, ...(data.message ? [data.message] : [])]);
            if (Array.isArray(data.actions) && data.actions.length) {
              const incoming = new Map(data.actions.map((item) => [item.id, item]));
              pendingActions = [...pendingActions.filter((item) => !incoming.has(item.id)), ...incoming.values()];
            }
            renderThread();
            renderWelcome();
          } else if (event === 'done') {
            window.dispatchEvent(new CustomEvent('tounar:data-changed', { detail: data }));
          } else if (event === 'error') {
            throw Object.assign(new Error(data.message || 'AI 助手处理失败'), { code: data.code });
          }
        }
      }
      await loadSession(session.id);
      statusText = '';
      renderThread();
    } catch (error) {
      if (error?.name === 'AbortError') toast('已停止生成');
      else toast(errorMessage(error), 'err');
      statusText = '';
      await loadSession(session.id).catch(() => {});
    } finally {
      sending = false;
      if (sendButton) { sendButton.textContent = '发送'; sendButton.onclick = send; }
      aborter = null;
      renderComposer();
      if (inputEl) inputEl.focus();
    }
  }

  async function clearConversation() {
    if (!session) return;
    if (!window.confirm('清空当前对话？历史记录会保留在历史会话中。')) return;
    await createAndLoadSession(session.context_application_id || null, session.context_resume_id || null);
  }

  function openHistory() {
    let modal = null;
    const close = () => modal?.close();
    modal = openModal({
      title: '历史会话', subtitle: '选择一段对话继续', testid: 'assistant-history-modal',
      body: h('div', { class: 'tn-agent-history' }, ...sessions.map((item) => h('button', {
        type: 'button', class: `tn-agent-history-item${item.id === session?.id ? ' active' : ''}`,
        onclick: () => { close(); loadSession(item.id); }
      }, h('strong', { text: item.title }), h('span', { text: `${fmtDateTime(item.updated_at)} · ${item.context_application_id ? '岗位对话' : '求职对话'}` })))),
      footer: h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '关闭', onclick: close })
    });
  }

  // Initial load: sessions -> session/context. A quick-entry application opens a new focused session.
  try {
    renderTop();
    const sessionData = (await api.get('/api/v1/agent/sessions')).data || [];
    sessions = sessionData;
    if (applicationId || resumeId) await createAndLoadSession(applicationId, resumeId);
    else if (sessions.length) await loadSession(sessions[0].id);
    else await createAndLoadSession();
  } catch (error) {
    renderTop();
    welcome.append(h('div', { class: 'tn-banner err' }, h('div', { class: 'tn-banner-body', text: errorMessage(error) })));
  }
}
