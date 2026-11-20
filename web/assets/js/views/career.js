/* 简历与 AI：上传/修正简历、简历画像、岗位对比、未投递岗位推荐。
 * 所有数据来自当前账号 API；前端不拼模型请求、不读取其他用户数据。 */
import { api, errorText } from '../api.js';
import { isStale } from '../app.js?v=20261120-1';
import { h, clear, toast, fmtDateTime, openModal, idemKey, debounce } from '../util.js';
import { openDetail } from './detail.js?v=20261120-1';

const MATCH_LABELS = { high: '相对匹配高', medium: '相对匹配中', low: '相对匹配低', insufficient: '资料不足' };
const MATCH_CLASS = { high: 'ok', medium: 'warn', low: 'muted', insufficient: 'muted' };
const SINGLE_LEVEL_CLASS = { '匹配': 'ok', '部分匹配': 'warn', '不匹配': 'bad', '无法判断': 'muted' };
const PRIORITY_CLASS = { '优先投': 'ok', '适合投': 'warn', '暂缓': 'bad', '待确认': 'muted' };
const GATE_CLASS = { '满足': 'ok', '不满足': 'bad', '信息不足': 'muted', '需要用户确认': 'warn' };
const DIMENSION_NAMES = {
  hard_gate: '硬性门槛', skills: '技能工具', experience: '经历项目',
  industry: '行业业务', preference: '偏好地点', achievements: '成果量化'
};
const CORRECTION_FIELDS = [
  ['skill', '技能'], ['experience', '经历/项目'], ['industry', '行业经验'],
  ['achievement', '成果指标'], ['preference', '偏好/条件'], ['other', '其他']
];
function errorMessage(err) {
  if (err?.code === 'AI_NOT_CONFIGURED') return '服务端尚未配置 AI 模型，暂不能分析。请管理员配置 AI_API_URL/AI_MODEL（或 WorkBuddy 云端凭据）。';
  if (err?.code === 'AI_UNAVAILABLE') return 'AI 服务暂时不可用，可以稍后重试。';
  if (err?.code === 'AI_UNAUTHORIZED') return 'AI 服务鉴权失败，请管理员检查服务端配置。';
  if (err?.code === 'AI_INVALID_RESPONSE') return 'AI 返回内容无法解析，请重试。';
  if (err?.code === 'RESUME_REQUIRED') return '请先上传并分析一份简历。';
  if (err?.code === 'RESUME_NOT_READY') return '当前简历还没有完成分析，请先分析或重试。';
  if (err?.code === 'RESUME_UNSUPPORTED') return '首版支持 PDF、DOCX 和粘贴文本；请转换格式或直接粘贴。';
  if (err?.code === 'RESUME_PDF_UNSUPPORTED') return '当前环境缺少 PDF 解析组件，请粘贴简历文本。';
  if (err?.code === 'RESUME_TEXT_TOO_SHORT') return '提取到的简历文本太少，请检查文件或粘贴完整文本。';
  if (err?.code === 'JD_REQUIRED') return '这个岗位还没有 JD，无法做单岗位匹配；请先打开岗位详情补充 JD。';
  if (err?.code === 'REPORT_NOT_READY') return '报告还没有完成，请先重新运行匹配分析。';
  if (err?.code === 'REPORT_CONTEXT_MISSING') return '这份旧报告缺少当时的岗位或简历快照，请重新运行匹配分析。';
  return errorText ? errorText(err) : String(err?.message || '操作失败');
}
function tagLevel(level) {
  return h('span', { class: `tn-ai-level ${MATCH_CLASS[level] || 'muted'}`, text: MATCH_LABELS[level] || level || '资料不足' });
}
function listBlock(title, rows, render) {
  if (!rows?.length) return null;
  return h('section', { class: 'tn-ai-block' }, h('h4', { text: title }), ...rows.map(render));
}
function evidence(text) {
  return text ? h('blockquote', { class: 'tn-ai-evidence', text: `原文：${text}` }) : null;
}
function base64FromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}
function appLink(id, label = '查看岗位') {
  return h('a', { class: 'tn-btn tn-btn-sm', href: `/?app=${encodeURIComponent(id)}`, text: label });
}
function external(url, label = '打开原岗位') {
  if (!url) return null;
  return h('a', { class: 'tn-btn tn-btn-sm', href: url, target: '_blank', rel: 'noopener noreferrer', text: label });
}

export async function renderCareer(container, { gen, apps = null, applicationId = null, section = null, autorun = null } = {}) {
  const selectedIds = String(apps || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 6);
  const root = h('div', { class: 'tn-career', 'data-test': 'career-view' });
  container.append(root);
  let resume = null;
  let versions = [];
  let status = null;
  let busy = false;
  let comparison = null;
  let recommendation = null;
  let selectedApps = [];
  let autoCompareStarted = false;
  let matchApps = [];
  let matchAppId = applicationId || null;
  let match = null;
  let matchAppQuery = '';
  let matchAppCursors = { applied: null, viewed: null };
  let matchAppHasMore = { applied: false, viewed: false };
  let matchAppLoading = false;
  let matchAppReqSeq = 0;
  let matchHistory = [];
  let matchHistoryReqSeq = 0;
  let matchReportReqSeq = 0;
  let matchBusy = false;
  let openDimension = null;
  let interview = null;
  let resumeSuggestionsOpen = false;
  const active = () => !isStale(gen) && root.isConnected;
  if (autorun === 'compare') {
    const url = new URL(location.href);
    url.searchParams.delete('autorun');
    history.replaceState({}, '', `${url.pathname}${url.search}`);
  }

  root.append(h('div', { class: 'tn-career-head' },
    h('div', { class: 'tn-grow' },
      h('p', { class: 'tn-muted', text: section === 'resume'
        ? '上传、粘贴或修正简历，查看结构化画像与版本；仍可回到匹配分析针对具体岗位使用。'
        : '单岗位匹配看是否值得投；2–6 岗对比保留相对排序；未投递推荐只使用系统已采集岗位。AI 不改岗位状态。' })),
    h('a', { class: 'tn-btn tn-btn-sm', href: '/', text: '返回台账' })
  ));
  const aiNotice = h('div', { class: 'tn-ai-notice', 'data-test': 'ai-status' });
  const matchSection = h('section', { class: 'tn-ai-card tn-match-card', 'data-test': 'match-section', id: 'tn-match-section', hidden: section === 'resume' });
  const resumeSection = h('section', { class: 'tn-ai-card', 'data-test': 'resume-section', id: 'tn-resume-section', hidden: section === 'match' });
  const compareSection = h('section', { class: 'tn-ai-card', 'data-test': 'compare-section', id: 'tn-compare-section', hidden: section === 'resume' });
  const recommendSection = h('section', { class: 'tn-ai-card', 'data-test': 'recommend-section', id: 'tn-recommend-section', hidden: section === 'resume' });
  root.append(aiNotice, matchSection, resumeSection, compareSection, recommendSection);

  function setBusy(value) {
    busy = value;
    for (const b of root.querySelectorAll('button')) b.disabled = value;
  }

  function mergeMatchApps(items) {
    const map = new Map(matchApps.map((item) => [item.id, item]));
    for (const item of items || []) if (item?.id) map.set(item.id, { ...(map.get(item.id) || {}), ...item });
    matchApps = [...map.values()];
  }

  async function loadMatchApps({ reset = false, more = false } = {}) {
    if (!active()) return;
    if (!reset && !more) return;
    const seq = ++matchAppReqSeq;
    if (reset) {
      matchApps = [];
      matchAppCursors = { applied: null, viewed: null };
      matchAppHasMore = { applied: true, viewed: true };
    } else if (!matchAppHasMore.applied && !matchAppHasMore.viewed) return;
    matchAppLoading = true;
    renderMatch();
    try {
      const views = reset ? ['applied', 'viewed'] : ['applied', 'viewed'];
      const results = await Promise.all(views.map(async (view) => {
        if (!reset && !matchAppHasMore[view]) return null;
        const params = new URLSearchParams({ view, limit: '50' });
        if (matchAppQuery) params.set('q', matchAppQuery);
        if (!reset && matchAppCursors[view]) params.set('cursor', matchAppCursors[view]);
        try {
          const response = await api.get(`/api/v1/ledger?${params.toString()}`);
          return { view, data: response.data };
        } catch { return { view, error: true }; }
      }));
      if (!active() || seq !== matchAppReqSeq) return;
      for (const result of results) {
        if (!result) continue;
        if (result.error) {
          match = { ...(match || {}), historyError: '岗位列表加载失败，请重试' };
          continue;
        }
        mergeMatchApps(result.data.items || []);
        matchAppCursors[result.view] = result.data.page?.next_cursor || null;
        matchAppHasMore[result.view] = !!result.data.page?.has_more;
      }
      if (reset && !matchAppQuery && applicationId && !matchApps.some((item) => item.id === applicationId)) {
        try {
          const detail = (await api.get(`/api/v1/applications/${encodeURIComponent(applicationId)}`)).data;
          if (active() && seq === matchAppReqSeq) matchApps = [detail, ...matchApps];
        } catch { /* 选择失效时保留空选择 */ }
      }
      if (matchAppId && !matchApps.some((item) => item.id === matchAppId)) matchAppId = '';
      if (active() && seq === matchAppReqSeq) renderMatch();
    } finally {
      if (active() && seq === matchAppReqSeq) {
        matchAppLoading = false;
        renderMatch();
      }
    }
  }

  async function load() {
    try {
      const [statusRes, currentRes, listRes] = await Promise.all([
        api.get('/api/v1/ai/status'), api.get('/api/v1/resumes/current'), api.get('/api/v1/resumes')
      ]);
      if (!active()) return;
      status = statusRes.data;
      resume = currentRes.data;
      versions = listRes.data || [];
      const details = await Promise.all(selectedIds.map(async (id) => {
        try { return (await api.get(`/api/v1/applications/${encodeURIComponent(id)}`)).data; } catch { return null; }
      }));
      selectedApps = details.filter(Boolean);
      renderNotice();
      await loadMatchApps({ reset: true });
      if (!active()) return;
      renderResume();
      renderCompare();
      renderRecommend();
      if (matchAppId) loadMatchHistory();
      if (autorun === 'compare' && !autoCompareStarted && selectedIds.length >= 2 && resume?.status === 'ready') {
        autoCompareStarted = true;
        runCompare();
      }
      if (section === 'resume') requestAnimationFrame(() => resumeSection.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    } catch (err) {
      if (active()) { clear(aiNotice); aiNotice.append(h('div', { class: 'tn-inline-msg err', text: '无法加载 AI 状态：' + errorMessage(err) })); }
    }
  }

  function renderNotice() {
    clear(aiNotice);
    if (!status) return;
    if (!status.available) {
      aiNotice.append(h('div', { class: 'tn-inline-msg err', text: 'AI 模型尚未配置：可以上传和修正简历、查看文本，但分析/对比/推荐会明确失败。请管理员配置服务端 AI_API_URL/AI_MODEL（或 WorkBuddy 云端凭据）。' }));
    } else if (status.model_configured === false) {
      aiNotice.append(h('div', { class: 'tn-inline-msg err', text: 'AI 网关已配置，但缺少 AI_MODEL；请管理员补齐后再分析。' }));
    } else {
      aiNotice.append(h('div', { class: 'tn-small tn-muted', text: `模型服务：${status.provider === 'openai_compatible' ? '服务端模型网关' : 'WorkBuddy 云端'} · 支持 PDF / DOCX / 粘贴文本 · 原始文件不落盘` }));
    }
  }

  /* ---------- 单岗位匹配 ---------- */
  function matchLevelBadge(value, cls) {
    const icons = { '匹配': '✓', '部分匹配': '!', '不匹配': '×', '无法判断': '?' };
    return h('span', { class: `tn-ai-level ${cls || 'muted'}` },
      h('span', { class: 'tn-state-icon', 'aria-hidden': 'true', text: icons[value] || '·' }), value || '无法判断');
  }
  function matchSourceLabel(source) {
    return { jd: 'JD 原文', resume: '简历原文', user_confirmed: '用户确认补充' }[source] || '依据';
  }
  function matchEvidenceRows(rows) {
    if (!rows?.length) return h('div', { class: 'tn-small tn-muted', text: '没有可逐字核验的引文；相关肯定结论已降为“无法判断”。' });
    return h('div', { class: 'tn-match-evidence' }, ...rows.map((item) => h('div', { class: 'tn-match-evidence-row' },
      h('span', { class: 'tn-match-source', text: matchSourceLabel(item.source) }),
      h('blockquote', { class: 'tn-ai-evidence', text: `“${item.quote}”` })
    )));
  }
  function matchGapList(rows, emptyText) {
    if (!rows?.length) return h('p', { class: 'tn-small tn-muted', text: emptyText || '暂无。' });
    return h('ul', { class: 'tn-match-list' }, ...rows.map((x) => h('li', { text: x })));
  }
  function matchCoreCard(label, value, cls) {
    return h('article', { class: `tn-match-core-card ${cls || 'muted'}`, 'data-test': `match-${label === '能力匹配度' ? 'ability' : 'priority'}` },
      h('div', { class: 'tn-match-core-label', text: label }),
      h('div', { class: 'tn-match-core-value', text: value })
    );
  }

  function renderMatch() {
    const wasSearchFocused = document.activeElement?.getAttribute('data-test') === 'match-app-search';
    const searchCaret = wasSearchFocused ? document.activeElement.selectionStart : null;
    clear(matchSection);
    const selected = matchApps.find((item) => item.id === matchAppId);
    const report = match?.report || null;
    matchSection.append(h('div', { class: 'tn-ai-section-head' },
      h('div', {}, h('h2', { text: '单岗位匹配分析' }),
        h('p', { class: 'tn-small tn-muted', style: { margin: '4px 0 0' }, text: '针对一个真实岗位和当前简历，分开看“能不能做”和“要不要优先投”；每个结论都能回到 JD 与简历证据。' }))
    ));
    const search = h('input', {
      class: 'tn-input tn-match-search', type: 'search', value: matchAppQuery,
      placeholder: '搜索公司 / 岗位 / 城市 / 批次', 'data-test': 'match-app-search',
      'aria-label': '搜索台账岗位'
    });
    search.addEventListener('input', debounce(() => {
      const nextQuery = search.value.trim();
      if (nextQuery === matchAppQuery) return;
      matchAppQuery = nextQuery;
      if (!matchApps.some((item) => item.id === matchAppId)) matchAppId = '';
      match = null;
      interview = null;
      openDimension = null;
      matchHistory = [];
      ++matchHistoryReqSeq;
      ++matchReportReqSeq;
      renderMatch();
      loadMatchApps({ reset: true });
    }, 300));
    const select = h('select', { class: 'tn-select tn-match-select', 'data-test': 'match-application', disabled: matchBusy || matchAppLoading });
    select.append(h('option', { value: '', text: matchAppLoading ? '正在搜索台账…' : matchApps.length ? '选择一个台账岗位…' : '没有匹配的岗位' }));
    for (const item of matchApps) {
      select.append(h('option', {
        value: item.id,
        text: `${item.company_name || '公司待补'} · ${item.job_title || '岗位待补'}${item.has_applied ? '（已投递）' : ''}`
      }));
    }
    if (matchAppId) select.value = matchAppId;
    select.addEventListener('change', () => {
      matchAppId = select.value;
      match = null;
      interview = null;
      openDimension = null;
      matchHistory = [];
      ++matchHistoryReqSeq;
      ++matchReportReqSeq;
      renderMatch();
      if (matchAppId) loadMatchHistory();
    });
    const run = report ? null : h('button', {
      class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', 'data-test': 'match-run',
      text: matchBusy ? '分析中…' : '开始匹配分析',
      disabled: matchBusy || !matchAppId || !resume || resume.status !== 'ready',
      onclick: () => runMatch({ parent: null })
    });
    const more = (matchAppHasMore.applied || matchAppHasMore.viewed)
      ? h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'match-app-more', text: matchAppLoading ? '加载中…' : '加载更多岗位', disabled: matchAppLoading, onclick: () => loadMatchApps({ more: true }) })
      : null;
    matchSection.append(h('div', { class: 'tn-match-picker' }, search, select, run, more,
      h('span', { class: 'tn-small tn-muted', text: !matchAppId ? '先从本人台账搜索并选择一个岗位；也能从岗位详情带入。' : report ? '报告已生成；重新分析请用报告下方的“下一步行动”。' : resume?.status === 'ready' ? '只读取当前岗位和当前简历，不会修改台账状态。' : '需要当前简历分析完成。' })));
    if (matchAppLoading) matchSection.append(h('div', { class: 'tn-inline-msg', 'data-test': 'match-app-loading' }, h('span', { class: 'tn-spinner', 'aria-hidden': 'true' }), '正在加载更多台账岗位…'));
    if (wasSearchFocused) requestAnimationFrame(() => {
      const next = matchSection.querySelector('[data-test="match-app-search"]');
      if (!next) return;
      next.focus({ preventScroll: true });
      const caret = Math.min(searchCaret ?? next.value.length, next.value.length);
      next.setSelectionRange(caret, caret);
    });
    if (matchAppId && selected) {
      matchSection.append(h('div', { class: 'tn-match-jobline' },
        h('strong', { text: [selected.company_name, selected.job_title].filter(Boolean).join(' · ') }),
        selected.location ? h('span', { class: 'tn-small tn-muted', text: selected.location }) : null,
        selected.job_url ? h('a', { class: 'tn-btn tn-btn-sm tn-btn-ghost', href: selected.job_url, target: '_blank', rel: 'noopener noreferrer', text: '原岗位' }) : null
      ));
    }
    if (matchHistory.length) {
      const historySelect = h('select', { class: 'tn-select tn-select-sm', 'data-test': 'match-history' });
      historySelect.append(h('option', { value: '', text: '查看历史报告…' }));
      for (const item of matchHistory) {
        historySelect.append(h('option', { value: item.id, text: `${fmtDateTime(item.created_at)} · ${item.ability?.conclusion || item.status}` }));
      }
      if (report && matchHistory.some((x) => x.id === report.id)) historySelect.value = report.id;
      else historySelect.value = '';
      historySelect.addEventListener('change', () => { if (historySelect.value) loadMatchReport(historySelect.value); });
      matchSection.append(h('div', { class: 'tn-match-history' }, historySelect,
        h('span', { class: 'tn-small tn-muted', text: '历史报告保留生成时的证据与结论；新补充不会改写旧报告。' })));
    }
    if (match?.historyError) matchSection.append(h('div', { class: 'tn-inline-msg err', text: `历史报告读取失败：${match.historyError}` }));
    if (match?.status === 'running') {
      matchSection.append(h('div', { class: 'tn-inline-msg', 'data-test': 'match-running' },
        h('span', { class: 'tn-spinner', 'aria-hidden': 'true' }), '正在读取岗位与简历证据，生成匹配报告…'));
    }
    if (match?.error && (!report || report.status === 'ready')) {
      matchSection.append(h('div', { class: 'tn-inline-msg err', 'data-test': 'match-error' }, match.error,
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '查看岗位详情', onclick: () => openDetail(matchAppId, { gen, onChanged: () => loadMatchAppsOnly() }) }),
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '重试', 'data-test': 'match-retry', onclick: () => runMatch({ parent: report?.id || null }) })));
    }
    if (report?.status === 'ready') matchSection.append(renderMatchReport(report));
    else if (report) matchSection.append(renderMatchStatus(report));
    if (!matchAppId) {
      matchSection.append(h('div', { class: 'tn-empty' }, h('p', { text: '选择一个本人台账岗位，开始单岗位匹配。' }),
        h('p', { class: 'tn-small tn-muted', text: '也可以从岗位详情点「匹配分析」带入当前岗位。' })));
    }
  }

  function renderMatchStatus(report) {
    return h('div', { class: 'tn-banner err tn-match-report-status', 'data-test': 'match-report-unavailable' },
      h('div', { class: 'tn-banner-body' },
        h('div', { text: `报告未完成：${report.error_message || report.error_code || '模型或证据校验失败'}` }),
        h('div', { class: 'tn-small', text: '历史报告不会显示为已完成；请重新运行匹配分析生成新报告。' })),
      h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '重新运行', 'data-test': 'match-rerun-failed', onclick: () => runMatch({ parent: null }) })
    );
  }

  function setDimensionOpen(key) {
    for (const card of matchSection.querySelectorAll('.tn-match-dim')) {
      const active = card.getAttribute('data-dimension') === key;
      card.classList.toggle('expanded', active);
      const summary = card.querySelector('.tn-match-dim-summary');
      const detail = card.querySelector('.tn-match-dim-detail');
      if (summary) summary.setAttribute('aria-expanded', active ? 'true' : 'false');
      if (detail) detail.hidden = !active;
    }
  }
  function focusDimension(key) {
    openDimension = key;
    setDimensionOpen(key);
    const card = matchSection.querySelector(`[data-dimension="${key}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.remove('tn-evidence-flash');
    void card.offsetWidth;
    card.classList.add('tn-evidence-flash');
    card.querySelectorAll('.tn-match-evidence-detail, .tn-match-quote-detail').forEach((node) => { node.open = true; });
    card.querySelector('.tn-match-dim-summary')?.focus({ preventScroll: true });
  }
  function toggleDimension(key) {
    openDimension = openDimension === key ? null : key;
    setDimensionOpen(openDimension);
  }

  function summaryEvidence(item, label = '查看依据') {
    if (!item?.dimension_key && !item?.key) return null;
    const sources = new Set((item.evidence || []).map((e) => e.source));
    const confirmed = sources.has('user_confirmed');
    return h('span', { class: 'tn-summary-evidence' },
      h('button', { class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', 'data-test': 'summary-evidence', onclick: () => focusDimension(item.dimension_key || item.key) }, label),
      confirmed ? h('span', { class: 'tn-match-dim-tag', text: '含用户确认补充' }) : null);
  }

  function renderMatchReport(report) {
    const result = report.result || {};
    const job = result.job || matchApps.find((x) => x.id === matchAppId) || {};
    const reportVersion = report.report_version || result.report_version || '';
    const box = h('div', { class: 'tn-ai-report tn-match-report', 'data-test': 'match-report', 'data-report-id': report.id });
    box.append(h('div', { class: 'tn-match-report-head' },
      h('div', {},
        h('h3', { text: [job.company_name, job.job_title].filter(Boolean).join(' · ') || '岗位匹配报告' }),
        h('div', { class: 'tn-small tn-muted', text: `简历：${result.resume?.filename || '当前简历'}${result.resume?.updated_at ? ` · 版本 ${fmtDateTime(result.resume.updated_at)}` : ''} · 分析时间：${fmtDateTime(result.analyzed_at || report.completed_at)} · 报告 ${report.id}` })),
      job.job_url ? h('a', { class: 'tn-btn tn-btn-sm', href: job.job_url, target: '_blank', rel: 'noopener noreferrer', text: '打开原岗位' }) : null,
      h('span', { class: 'tn-match-version', text: reportVersion || 'match-v1（旧）' })
    ));
    if (reportVersion !== 'match-v2') {
      box.append(h('div', { class: 'tn-banner warn', 'data-test': 'match-legacy-report' },
        h('div', { class: 'tn-banner-body', text: '这份报告生成于证据核验修复前，仍按原文保留，但不代表已按新版门槛与引文规则重新核验；建议重新运行匹配分析。' })));
    }
    box.append(h('div', { class: 'tn-match-core' },
      matchCoreCard('能力匹配度', result.ability?.conclusion || '无法判断', SINGLE_LEVEL_CLASS[result.ability?.conclusion]),
      matchCoreCard('投递优先级', result.priority?.conclusion || '待确认', PRIORITY_CLASS[result.priority?.conclusion])
    ));
    if (result.overall_advice) box.append(h('div', { class: 'tn-match-advice', 'data-test': 'match-advice' }, h('strong', { text: '总体建议：' }), result.overall_advice));
    const blocking = (result.hard_gates || []).filter((g) => g.result === '不满足');
    if (blocking.length) {
      box.append(h('div', { class: 'tn-banner err', 'data-test': 'match-blocking' },
        h('div', { class: 'tn-banner-body' },
          h('div', { text: `硬性门槛阻断：${blocking[0].requirement}${blocking.length > 1 ? ` 等 ${blocking.length} 项` : ''}。普通能力优势不能抵消硬门槛。` })),
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'match-view-gates', text: '查看门槛', onclick: () => focusDimension('hard_gate') })));
    }

    const dimensions = result.dimensions || [];
    box.append(h('section', { class: 'tn-match-section-block tn-match-accordion' },
      h('h4', { text: '六维匹配分析' }),
      h('div', { class: 'tn-match-dim-grid' }, ...dimensions.map((d) => renderDimensionCard(d, report)))
    ));

    const strengths = result.strengths || [];
    const gaps = result.gaps || [];
    box.append(h('section', { class: 'tn-match-section-block' },
      h('h4', { text: '优势与缺口总结' }),
      h('div', { class: 'tn-match-summary-grid' },
        h('div', {}, h('h5', { text: '有证据的优势' }),
          strengths.length ? h('ul', { class: 'tn-match-list' }, ...strengths.map((s) => h('li', {},
            h('span', { class: 'tn-match-dim-tag', text: s.dimension || DIMENSION_NAMES[s.key] || '匹配' }), s.text,
            summaryEvidence(s)))) : h('p', { class: 'tn-small tn-muted', text: '暂未找到可逐字核验的优势。' })),
        h('div', {}, h('h5', { text: '明确差距' }),
          gaps.filter((g) => g.kind !== '资料不足').length
            ? h('ul', { class: 'tn-match-list' }, ...gaps.filter((g) => g.kind !== '资料不足').map((g) => h('li', {},
              h('span', { class: 'tn-match-dim-tag', text: g.dimension }), g.text,
              summaryEvidence(g),
              h('button', { class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', 'data-test': 'match-gap-supplement', onclick: () => openCorrectionModal({ dimension: g.key, original: `【${g.dimension}】${g.text}` }) }, '补充这段经历'))))
            : h('p', { class: 'tn-small tn-muted', text: '没有发现明确的能力差距；资料不足项单独列出。' }),
          h('h5', { class: 'tn-match-subhead', text: '资料不足 / 暂未发现案例' }),
          gaps.filter((g) => g.kind === '资料不足').length
            ? h('ul', { class: 'tn-match-list' }, ...gaps.filter((g) => g.kind === '资料不足').map((g) => h('li', {},
              h('span', { class: 'tn-match-dim-tag', text: g.dimension }), `${g.text}（查过：${result.resume?.filename || '当前简历'}；岗位要求：${g.requirement || '见上方维度'}）`,
              summaryEvidence(g),
              h('button', { class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', 'data-test': 'match-gap-supplement', onclick: () => openCorrectionModal({ dimension: g.key, original: `【${g.dimension}】${g.text}` }) }, '补充证据'))))
            : h('p', { class: 'tn-small tn-muted', text: '没有资料不足项。' })
        )
      )
    ));

    box.append(renderMatchActions(report));
    if (report.corrections?.length) {
      box.append(h('section', { class: 'tn-match-section-block', 'data-test': 'match-corrections' },
        h('h4', { text: '已保存的用户确认补充' }),
        ...report.corrections.map((c) => h('div', { class: 'tn-match-correction-item' },
          h('span', { class: 'tn-match-dim-tag', text: DIMENSION_NAMES[c.dimension] || c.dimension }),
          h('span', { text: c.user_text }),
          h('span', { class: 'tn-small tn-muted', text: `${c.scope === 'all' ? '适用于全部匹配' : '仅适用于此岗位'} · ${fmtDateTime(c.created_at)}` })
        ))
      ));
    }
    if (result.limitations?.length) {
      box.append(h('details', { class: 'tn-match-limitations' }, h('summary', { text: '判断限制与资料说明' }),
        h('ul', {}, ...result.limitations.map((x) => h('li', { text: x })))));
    }
    return box;
  }

  function dimensionCorrectionButton(d) {
    return h('div', { class: 'tn-match-dim-actions' },
      h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'match-correct',
        onclick: () => openCorrectionModal({ dimension: d.key, original: `【${d.name}】${d.conclusion}${d.gaps?.length ? `；缺口：${d.gaps.join('；')}` : ''}` }) }, '补充或纠错'));
  }

  function gateResultBadge(value) {
    const icons = { '满足': '✓', '不满足': '×', '信息不足': '?', '需要用户确认': '!' };
    return h('span', { class: `tn-gate-result ${GATE_CLASS[value] || 'muted'}` },
      h('span', { class: 'tn-state-icon', 'aria-hidden': 'true', text: icons[value] || '·' }), value || '信息不足');
  }

  function renderGateDetail(report) {
    const gates = report.result?.hard_gates || [];
    const box = h('div', { class: 'tn-match-gate-detail' });
    if (!gates.length) {
      box.append(h('p', { class: 'tn-small tn-muted', text: 'JD 未列明工作许可、最低年限、指定城市线下办公等硬性门槛；不把普通偏好当成门槛。' }));
      return box;
    }
    const table = h('table', { class: 'tn-gate-table', 'data-test': 'match-gates' },
      h('thead', {}, h('tr', {}, h('th', { text: '岗位要求' }), h('th', { text: '你的对应信息' }), h('th', { text: '结果' }), h('th', { text: '判断依据' }))),
      h('tbody', {}, ...gates.map((gate) => h('tr', {},
        h('td', {}, h('div', { text: gate.requirement }),
          gate.jd_evidence ? h('details', { class: 'tn-match-quote-detail' }, h('summary', { text: '查看 JD 原文' }), h('blockquote', { text: gate.jd_evidence })) : null),
        h('td', {}, h('div', { text: gate.user_info || '—' }),
          gate.resume_evidence ? h('details', { class: 'tn-match-quote-detail' }, h('summary', { text: '查看简历/用户确认原文' }), h('blockquote', { text: gate.resume_evidence })) : null),
        h('td', {}, gateResultBadge(gate.result)),
        h('td', { class: 'tn-small' }, h('p', { text: gate.basis || '—' }))
      )))
    );
    box.append(h('div', { class: 'tn-gate-table-wrap' }, table));
    box.append(h('div', { class: 'tn-match-field' }, h('div', { class: 'tn-match-field-label', text: '下一步建议' }), h('p', { text: report.result?.dimensions?.find((d) => d.key === 'hard_gate')?.next_step || '先与招聘方确认门槛是否可豁免。' })));
    box.append(dimensionCorrectionButton(report.result?.dimensions?.find((d) => d.key === 'hard_gate') || { key: 'hard_gate', name: '硬性门槛', conclusion: '', gaps: [] }));
    return box;
  }

  function renderDimensionDetail(d) {
    const box = h('div', { class: 'tn-match-dim-detail-inner' });
    box.append(h('div', { class: 'tn-match-requirement-table' },
      h('div', { class: 'tn-match-requirement-row tn-match-requirement-head' },
        h('span', { text: '岗位要求' }), h('span', { text: '你的证据' }), h('span', { text: '判断' })),
      h('div', { class: 'tn-match-requirement-row' },
        h('div', { class: 'tn-match-requirement-cell' }, h('span', { class: 'tn-mobile-label', text: '岗位要求' }), h('p', { text: d.requirement || 'JD 未提供足够信息。' })),
        h('div', { class: 'tn-match-requirement-cell' }, h('span', { class: 'tn-mobile-label', text: '你的证据' }), h('p', { text: d.user_evidence || '资料不足。' })),
        h('div', { class: 'tn-match-requirement-cell tn-match-judgement' }, h('span', { class: 'tn-mobile-label', text: '判断' }), matchLevelBadge(d.conclusion, SINGLE_LEVEL_CLASS[d.conclusion])))
    ));
    if (d.strengths?.length) box.append(h('div', { class: 'tn-match-field' }, h('div', { class: 'tn-match-field-label', text: '已具备' }), matchGapList(d.strengths)));
    if (d.gaps?.length) box.append(h('div', { class: 'tn-match-field' }, h('div', { class: 'tn-match-field-label', text: '待补证 / 明确缺口' }), matchGapList(d.gaps)));
    box.append(h('details', { class: 'tn-match-evidence-detail' },
      h('summary', { text: '查看原文与来源' }),
      matchEvidenceRows(d.evidence)));
    box.append(h('div', { class: 'tn-match-field' }, h('div', { class: 'tn-match-field-label', text: '下一步' }), h('p', { text: d.next_step || '—' })));
    box.append(dimensionCorrectionButton(d));
    return box;
  }

  function renderDimensionCard(d, report) {
    const detailId = `tn-match-dim-detail-${d.key}`;
    const open = openDimension === d.key;
    const summary = h('button', {
      class: 'tn-match-dim-summary', type: 'button', 'aria-expanded': open ? 'true' : 'false',
      'aria-controls': detailId, 'data-test': `match-dim-toggle-${d.key}`,
      onclick: () => toggleDimension(d.key)
    }, h('span', { class: 'tn-match-dim-head' },
      h('span', { class: 'tn-match-dim-name', text: d.name || DIMENSION_NAMES[d.key] || d.key }),
      matchLevelBadge(d.conclusion, SINGLE_LEVEL_CLASS[d.conclusion]),
      h('span', { class: 'tn-match-dim-chevron', 'aria-hidden': 'true', text: open ? '⌃' : '⌄' })));
    const detail = h('div', { class: 'tn-match-dim-detail', id: detailId, 'data-test': `match-dimension-detail-${d.key}`, hidden: !open },
      d.key === 'hard_gate' ? renderGateDetail(report) : renderDimensionDetail(d));
    return h('article', {
      class: `tn-match-dim${open ? ' expanded' : ''}`, 'data-dimension': d.key,
      'data-test': `match-dimension-${d.key}`
    }, summary, detail);
  }

  function renderMatchActions(report) {
    const wrap = h('section', { class: 'tn-match-section-block tn-match-actions-wrap' }, h('h4', { text: '下一步行动' }));
    const actions = h('div', { class: 'tn-action-row tn-match-actions' },
      h('button', { class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', 'data-test': 'match-resume-opt', text: resumeSuggestionsOpen ? '收起简历修改建议' : '优化当前岗位简历', onclick: () => { resumeSuggestionsOpen = !resumeSuggestionsOpen; renderMatch(); } }),
      h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'match-supplement', text: '补充缺失技能或经历', onclick: () => {
        const gap = report.result?.gaps?.[0];
        openCorrectionModal({ dimension: gap?.key || 'skills', original: gap ? `【${gap.dimension}】${gap.text}` : '补充与这个岗位相关、但当前简历没有体现的技能或经历。' });
      } }),
      h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'match-interview', text: interview?.status === 'running' ? '生成中…' : '生成面试问题', disabled: interview?.status === 'running', onclick: runInterviewQuestions }),
      h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'match-detail', text: '查看岗位详情', onclick: () => openDetail(report.result?.job?.application_id || matchAppId, { gen, onChanged: () => loadMatchAppsOnly() }) }),
      h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'match-rerun-action', text: '重新运行匹配分析', disabled: matchBusy, onclick: () => runMatch({ parent: report.id }) })
    );
    wrap.append(actions);
    if (resumeSuggestionsOpen) wrap.append(renderResumeSuggestions(report));
    if (interview?.status === 'ready') {
      wrap.append(h('div', { class: 'tn-match-interview', 'data-test': 'match-interview-questions' },
        h('h5', { text: '面试问题' }),
        interview.questions.length ? h('ol', {}, ...interview.questions.map((q) => h('li', {},
          h('p', { text: q.question }), h('div', { class: 'tn-small tn-muted', text: `依据：${q.basis || DIMENSION_NAMES[q.dimension] || '岗位要求'}` })))) : h('p', { class: 'tn-small tn-muted', text: '模型没有返回可用问题，请重试。' })
      ));
    }
    if (interview?.status === 'failed') {
      wrap.append(h('div', { class: 'tn-inline-msg err', 'data-test': 'match-interview-error' }, interview.error,
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '重试', onclick: runInterviewQuestions })));
    }
    return wrap;
  }

  function renderResumeSuggestions(report) {
    const result = report.result || {};
    const dimensions = (result.dimensions || []).filter((d) => d.gaps?.length);
    const panel = h('div', { class: 'tn-match-action-panel', 'data-test': 'match-resume-suggestions-wrap' },
      h('h5', { text: '当前岗位简历修改建议' }),
      h('p', { class: 'tn-small tn-muted', text: `目标岗位：${[result.job?.company_name, result.job?.job_title].filter(Boolean).join(' · ') || '当前岗位'}。以下每条都关联原简历引文和 JD 要求；只是建议，不会自动改写原简历，是否采纳由你决定。` })
    );
    if (!dimensions.length) {
      panel.append(h('div', { class: 'tn-empty', style: { padding: '20px 10px' } }, h('p', { text: '当前报告没有需要补充的明确缺口。' })));
      return panel;
    }
    for (const d of dimensions.slice(0, 8)) {
      const userEvidence = (d.evidence || []).filter((e) => e.source === 'resume' || e.source === 'user_confirmed');
      const original = userEvidence.map((e) => e.quote).join('；') || d.user_evidence || '原简历没有可核验的对应段落';
      const suggestion = [d.next_step || '补充与该岗位要求直接相关的经历、工具使用和交付结果。',
        d.gaps?.length ? `针对缺口：${d.gaps.join('；')}` : ''].filter(Boolean).join(' ');
      const textarea = h('textarea', { class: 'tn-textarea', rows: '3', 'data-test': 'match-resume-suggestion', value: suggestion });
      const copy = h('button', {
        class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'match-resume-copy',
        text: '复制这条建议',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(textarea.value);
            toast('建议已复制；原简历未被修改', 'ok');
          } catch {
            textarea.focus(); textarea.select(); toast('无法访问剪贴板，请手动复制选中的文字', 'err');
          }
        }
      });
      panel.append(h('article', { class: 'tn-resume-suggestion', 'data-test': 'match-resume-suggestion-card' },
        h('div', { class: 'tn-match-dim-head' }, h('h5', { text: d.name }), h('span', { class: 'tn-small tn-muted', text: '可编辑，不会自动保存' })),
        h('div', { class: 'tn-match-field' }, h('div', { class: 'tn-match-field-label', text: '原简历段落' }), h('blockquote', { class: 'tn-ai-evidence', text: original })),
        h('div', { class: 'tn-match-field' }, h('div', { class: 'tn-match-field-label', text: '对应 JD 要求' }), h('p', { text: d.requirement || '—' })),
        h('div', { class: 'tn-match-field' }, h('div', { class: 'tn-match-field-label', text: '建议文本' }), textarea, h('div', { class: 'tn-action-row', style: { marginTop: '6px' } }, copy))
      ));
    }
    panel.append(h('div', { class: 'tn-small tn-muted', text: '确认要改简历时，请到「简历库」修正文本并重新分析；本页不会写入简历。' }));
    return panel;
  }

  function openCorrectionModal({ dimension, original }) {
    const report = match?.report;
    if (!report) return;
    const dim = DIMENSION_NAMES[dimension] || dimension;
    const body = h('div', { class: 'tn-match-correction-form' });
    const originalBox = h('div', { class: 'tn-match-original' }, h('div', { class: 'tn-match-field-label', text: '原判断' }), h('p', { text: original || `【${dim}】资料不足` }));
    const text = h('textarea', { class: 'tn-textarea', rows: '5', placeholder: '例如：我使用 Tableau 完成过一个商业分析 Dashboard…', 'data-test': 'match-correction-text' });
    const field = h('select', { class: 'tn-select', 'data-test': 'match-correction-field' });
    for (const [v, label] of CORRECTION_FIELDS) field.append(h('option', { value: v, text: label }));
    field.value = dimension === 'preference' ? 'preference' : dimension === 'skills' ? 'skill' : dimension === 'achievements' ? 'achievement' : dimension === 'experience' ? 'experience' : dimension === 'industry' ? 'industry' : 'other';
    const scope = h('select', { class: 'tn-select', 'data-test': 'match-correction-scope' });
    scope.append(h('option', { value: 'application', text: '仅适用于这个岗位' }), h('option', { value: 'all', text: '适用于我以后的所有匹配分析' }));
    const preview = h('div', { class: 'tn-match-correction-preview', 'data-test': 'match-correction-preview' });
    const err = h('div', { class: 'tn-inline-msg err', 'data-test': 'match-correction-error', hidden: true });
    function updatePreview() {
      const f = CORRECTION_FIELDS.find(([v]) => v === field.value)?.[1] || '其他';
      clear(preview);
      preview.append(h('div', { class: 'tn-small tn-muted', text: '确认后只会保存为“用户确认补充”，不会改写简历原文或画像，也不会推断熟练程度、量化收益或其他项目。' }),
        h('div', { class: 'tn-small', text: `将写入：用户确认补充 · 画像字段：${f} · 适用范围：${scope.value === 'all' ? '全部匹配分析' : '仅这个岗位'}` }));
    }
    field.addEventListener('change', updatePreview);
    scope.addEventListener('change', updatePreview);
    updatePreview();
    body.append(originalBox,
      h('div', { class: 'tn-field' }, h('label', { text: '我的补充（必填）' }), text,
        h('div', { class: 'tn-hint', text: '只写你实际做过的这段技能/经历/偏好，不要写没有证据的结论。' })),
      h('div', { class: 'tn-form-grid' },
        h('div', { class: 'tn-field' }, h('label', { text: '画像字段' }), field),
        h('div', { class: 'tn-field' }, h('label', { text: '适用范围' }), scope)),
      preview, err);
    let handle;
    const save = h('button', { class: 'tn-btn tn-btn-primary', type: 'button', text: '确认保存补充', 'data-test': 'match-correction-save', onclick: async () => {
      const value = text.value.trim();
      if (value.length < 5) { err.hidden = false; err.textContent = '请至少写 5 个字，说明你实际做过什么'; text.focus(); return; }
      save.disabled = true; err.hidden = true;
      try {
        const response = await api.post(`/api/v1/ai/reports/${encodeURIComponent(report.id)}/corrections`, {
          dimension, original_judgment: original || '', user_text: value,
          proposed_field: field.value, scope: scope.value
        }, { idempotencyKey: idemKey('match-correction') });
        if (!active()) return;
        const correction = response.data?.correction;
        if (correction) {
          const list = report.corrections || [];
          if (!list.some((x) => x.id === correction.id)) list.push(correction);
          report.corrections = list;
        }
        handle?.close();
        toast('已保存为用户确认补充；可以重新分析引用这段证据', 'ok');
        renderMatch();
      } catch (error) {
        err.hidden = false;
        err.textContent = errorMessage(error);
      } finally { save.disabled = false; }
    } });
    handle = openModal({
      title: '补充或纠正匹配判断',
      subtitle: `维度：${dim} · 确认后才写入`,
      testid: 'match-correction-modal',
      body,
      footer: [h('button', { class: 'tn-btn', type: 'button', text: '取消', 'data-test': 'match-correction-cancel', onclick: () => handle?.close() }), save]
    });
  }

  async function runMatch({ parent = null } = {}) {
    if (matchBusy) return;
    if (!matchAppId) { toast('请先选择一个台账岗位', 'err'); return; }
    if (!resume || resume.status !== 'ready') { toast('请先完成当前简历分析', 'err'); return; }
    const targetAppId = matchAppId;
    const previous = match?.report || null;
    matchBusy = true;
    match = { status: 'running', report: previous };
    renderMatch();
    try {
      const response = await api.post('/api/v1/ai/match', {
        application_id: targetAppId,
        ...(parent ? { parent_report_id: parent } : {})
      });
      if (!active() || matchAppId !== targetAppId) return;
      match = { status: 'ready', report: response.data };
      interview = null;
      openDimension = null;
      toast(parent ? '新的匹配报告已生成，旧报告仍可查看' : '匹配报告已生成', 'ok');
      await loadMatchHistory({ keep: true });
    } catch (error) {
      if (!active() || matchAppId !== targetAppId) return;
      match = { status: 'failed', error: errorMessage(error), report: previous };
    } finally {
      matchBusy = false;
      if (active()) renderMatch();
    }
  }

  async function runInterviewQuestions() {
    if (interview?.status === 'running') return;
    const report = match?.report;
    if (!report) return;
    const targetReportId = report.id;
    interview = { status: 'running', questions: [] };
    renderMatch();
    try {
      const response = await api.post(`/api/v1/ai/reports/${encodeURIComponent(targetReportId)}/interview-questions`, {});
      if (!active() || match?.report?.id !== targetReportId) return;
      interview = { status: 'ready', questions: response.data?.questions || [] };
    } catch (error) {
      if (!active() || match?.report?.id !== targetReportId) return;
      interview = { status: 'failed', error: errorMessage(error), questions: [] };
    } finally { if (active()) renderMatch(); }
  }

  async function loadMatchHistory({ keep = false } = {}) {
    if (!matchAppId) return;
    const targetAppId = matchAppId;
    const seq = ++matchHistoryReqSeq;
    try {
      const response = await api.get(`/api/v1/ai/match-reports?application_id=${encodeURIComponent(targetAppId)}`);
      if (!active() || matchAppId !== targetAppId || seq !== matchHistoryReqSeq) return;
      matchHistory = response.data || [];
      if (!keep && !match?.report && matchHistory[0]?.status === 'ready') {
        await loadMatchReport(matchHistory[0].id, { targetAppId });
        return;
      }
      if (active() && seq === matchHistoryReqSeq) renderMatch();
    } catch (error) {
      if (active() && matchAppId === targetAppId && seq === matchHistoryReqSeq) {
        match = { ...(match || {}), historyError: errorMessage(error) };
        renderMatch();
      }
    }
  }

  async function loadMatchReport(reportId, { targetAppId = matchAppId } = {}) {
    const seq = ++matchReportReqSeq;
    try {
      const response = await api.get(`/api/v1/ai/reports/${encodeURIComponent(reportId)}`);
      if (!active() || matchAppId !== targetAppId || seq !== matchReportReqSeq) return;
      if (!response.data?.application_ids?.includes(targetAppId)) return;
      match = { status: response.data.status === 'ready' ? 'ready' : 'failed', report: response.data,
        error: response.data.status === 'ready' ? '' : (response.data.error_message || '报告未完成') };
      interview = null;
      openDimension = null;
      renderMatch();
    } catch (error) {
      if (active() && seq === matchReportReqSeq) {
        match = { status: 'failed', error: errorMessage(error), report: match?.report || null };
        renderMatch();
      }
    }
  }

  async function loadMatchAppsOnly() {
    if (!matchAppId) return;
    try {
      const detail = (await api.get(`/api/v1/applications/${encodeURIComponent(matchAppId)}`)).data;
      if (!active()) return;
      const idx = matchApps.findIndex((x) => x.id === detail.id);
      if (idx >= 0) matchApps[idx] = { ...matchApps[idx], ...detail };
      renderMatch();
    } catch { /* 抽屉关闭后下次加载再同步 */ }
  }

  function profileNode(profile) {
    if (!profile) return h('p', { class: 'tn-muted', text: '尚未生成画像。' });
    const box = h('div', { 'data-test': 'resume-profile' });
    box.append(h('p', { class: 'tn-ai-summary', text: profile.summary || '—' }));
    if (!profile.grounded) box.append(h('div', { class: 'tn-inline-msg err', text: '没有找到可逐字核验的简历证据；请修正文本后重新分析，避免使用未核验画像。' }));
    box.append(
      listBlock('主要技能', profile.skills, (x) => h('div', { class: 'tn-ai-item' }, h('strong', { text: x.name }), evidence(x.evidence))) || '',
      listBlock('工作 / 项目经历', profile.experiences, (x) => h('div', { class: 'tn-ai-item' },
        h('strong', { text: [x.organization, x.role].filter(Boolean).join(' · ') || '经历' }),
        x.period ? h('span', { class: 'tn-small tn-muted', text: x.period }) : null,
        x.highlights?.length ? h('ul', {}, ...x.highlights.map((t) => h('li', { text: t }))) : null,
        evidence(x.evidence))) || '',
      listBlock('行业经验', profile.industries, (x) => h('div', { class: 'tn-ai-item' }, h('strong', { text: x.name }), evidence(x.evidence))) || '',
      listBlock('突出优势', profile.strengths, (x) => h('div', { class: 'tn-ai-item' }, h('p', { text: x.point }), evidence(x.evidence))) || '',
      listBlock('关键限制', profile.constraints, (x) => h('div', { class: 'tn-ai-item' }, h('p', { text: x.point }), evidence(x.evidence))) || ''
    );
    return box;
  }

  function renderResume() {
    clear(resumeSection);
    resumeSection.append(h('div', { class: 'tn-ai-section-head' }, h('h2', { text: '1. 简历' }), resume ? h('span', { class: 'tn-small tn-muted', text: resume.is_current ? '当前版本' : '旧版本' }) : null));
    const file = h('input', { type: 'file', accept: '.pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain', 'data-test': 'resume-file' });
    const upload = h('button', { class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', text: '上传并分析', 'data-test': 'resume-upload', onclick: async () => {
      const f = file.files?.[0];
      if (!f) { toast('请选择 PDF、DOCX 或文本文件', 'err'); return; }
      if (f.size > 5 * 1024 * 1024) { toast('文件不能超过 5 MB', 'err'); return; }
      setBusy(true);
      try {
        const base64 = await base64FromFile(f);
        const created = await api.post('/api/v1/resumes', { filename: f.name, mime: f.type, data_base64: base64 });
        resume = created.data;
        versions = [resume, ...versions];
        renderResume();
        await analyzeResume(resume.id, { force: true });
      } catch (err) {
        toast('简历上传/解析失败：' + errorMessage(err), 'err');
      } finally { setBusy(false); }
    } });
    const paste = h('textarea', { class: 'tn-input', rows: '6', placeholder: '或直接粘贴简历文本（不保存文件二进制）', 'data-test': 'resume-paste' });
    const savePaste = h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '保存粘贴文本并分析', 'data-test': 'resume-paste-save', onclick: async () => {
      if (paste.value.trim().length < 20) { toast('请粘贴完整简历文本', 'err'); return; }
      setBusy(true);
      try {
        const created = await api.post('/api/v1/resumes/text', { text: paste.value, filename: '粘贴的简历.txt' });
        resume = created.data;
        versions = [resume, ...versions];
        renderResume();
        await analyzeResume(resume.id, { force: true });
      } catch (err) { toast('保存失败：' + errorMessage(err), 'err'); }
      finally { setBusy(false); }
    } });
    resumeSection.append(h('div', { class: 'tn-ai-upload' }, file, upload), h('div', { class: 'tn-ai-paste' }, paste, savePaste));
    if (!resume) {
      resumeSection.append(h('div', { class: 'tn-empty' }, h('p', { text: '还没有简历。上传 PDF/DOCX 或粘贴文本后开始分析。' })));
      return;
    }
    const head = h('div', { class: 'tn-ai-resume-head' },
      h('div', {}, h('strong', { text: resume.filename }), h('div', { class: 'tn-small tn-muted', text: `${resume.text_chars} 字 · ${fmtDateTime(resume.updated_at)} · ${resume.status === 'ready' ? '画像已就绪' : resume.status === 'failed' ? '分析失败' : resume.status === 'analyzing' ? '分析中' : '已解析，待分析'}` })),
      h('div', { class: 'tn-action-row' },
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: resume.status === 'failed' ? '重试分析' : '重新分析', 'data-test': 'resume-analyze', onclick: () => analyzeResume(resume.id) }),
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '修正文本', 'data-test': 'resume-edit', onclick: () => { editWrap.hidden = !editWrap.hidden; } })
      ));
    const editArea = h('textarea', { class: 'tn-input', rows: '8', value: resume.text || '', 'data-test': 'resume-edit-text' });
    const saveEdit = h('button', { class: 'tn-btn tn-btn-sm tn-btn-primary', type: 'button', text: '保存文本并重新分析', onclick: async () => {
      setBusy(true);
      try {
        const updated = await api.put(`/api/v1/resumes/${resume.id}/text`, { text: editArea.value });
        resume = updated.data;
        renderResume();
        await analyzeResume(resume.id, { force: true });
      } catch (err) { toast('修正失败：' + errorMessage(err), 'err'); }
      finally { setBusy(false); }
    } });
    const editWrap = h('div', { class: 'tn-ai-edit', 'data-test': 'resume-edit-wrap', hidden: true }, editArea, saveEdit);
    resumeSection.append(head, editWrap);
    if (resume.error_message) resumeSection.append(h('div', { class: 'tn-inline-msg err', text: `${resume.error_code || '分析失败'}：${resume.error_message}` }));
    resumeSection.append(h('div', { class: 'tn-ai-profile' }, profileNode(resume.profile)));
    if (versions.length > 1) {
      const history = h('details', { class: 'tn-ai-history' }, h('summary', { text: `历史简历版本（${versions.length}）` }));
      for (const v of versions) history.append(h('div', { class: 'tn-small tn-muted', text: `${v.is_current ? '当前 · ' : '旧版本 · '}${v.filename} · ${fmtDateTime(v.created_at)} · ${v.status === 'ready' ? '已分析' : v.status}` }));
      resumeSection.append(history);
    }
  }

  async function analyzeResume(id, { force = false } = {}) {
    if (!id || (busy && !force)) return;
    setBusy(true);
    resume = { ...(resume || {}), id, status: 'analyzing' };
    renderResume();
    try {
      const result = await api.post(`/api/v1/resumes/${id}/analyze`, {});
      resume = result.data;
      versions = versions.map((v) => v.id === resume.id ? resume : v);
      toast('简历分析完成', 'ok');
    } catch (err) {
      resume = { ...(resume || {}), status: 'failed', error_message: errorMessage(err), error_code: err?.code || 'AI_FAILED' };
      toast('简历分析失败：' + errorMessage(err), 'err');
    } finally {
      setBusy(false);
      renderResume();
      renderMatch();
      renderCompare();
      renderRecommend();
    }
  }

  function compareSelectionNode() {
    if (!selectedIds.length) return h('div', { class: 'tn-empty' }, h('p', { text: '还没有选择岗位。' }), h('p', { class: 'tn-small tn-muted', text: '回到台账，在「投递明细」或「看过没投」勾选 2–6 个岗位，再点「对比选中」。' }), h('a', { class: 'tn-btn tn-btn-sm', href: '/', text: '去台账选择' }));
    const chips = h('div', { class: 'tn-ai-chips' });
    for (const id of selectedIds) {
      const app = selectedApps.find((x) => x.id === id);
      chips.append(h('span', { class: 'tn-ai-chip', text: app ? `${app.company_name || ''} · ${app.job_title || ''}${app.has_applied ? '（已投递）' : ''}` : id }));
    }
    return chips;
  }

  function renderCompare() {
    clear(compareSection);
    compareSection.append(h('div', { class: 'tn-ai-section-head' }, h('h2', { text: '2. 岗位对比' }),
      h('span', { class: 'tn-small tn-muted', text: selectedIds.length ? `已选 ${selectedIds.length} 个岗位` : '从台账勾选后进入' })));
    compareSection.append(compareSelectionNode());
    const button = h('button', { class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', text: comparison?.status === 'running' ? '分析中…' : '开始对比', 'data-test': 'compare-run', disabled: busy || selectedIds.length < 2 || !resume || resume.status !== 'ready', onclick: runCompare });
    compareSection.append(h('div', { class: 'tn-action-row' }, button,
      h('span', { class: 'tn-small tn-muted', text: resume?.status === 'ready' ? '基于当前简历画像与所选岗位 JD' : '需要当前简历分析完成' })));
    if (comparison?.error) compareSection.append(h('div', { class: 'tn-inline-msg err', text: comparison.error }));
    if (comparison?.data) compareSection.append(renderCompareReport(comparison.data));
  }

  async function runCompare() {
    if (busy || selectedIds.length < 2) return;
    if (!resume || resume.status !== 'ready') { toast('请先完成当前简历分析', 'err'); return; }
    comparison = { status: 'running' };
    setBusy(true);
    renderCompare();
    try {
      const res = await api.post('/api/v1/ai/compare', { application_ids: selectedIds });
      comparison = { status: 'ready', data: res.data.result, report: res.data };
      toast('对比报告已生成', 'ok');
    } catch (err) {
      comparison = { status: 'failed', error: errorMessage(err) };
    } finally {
      setBusy(false);
      renderCompare();
    }
  }

  function renderCompareReport(result) {
    const box = h('div', { class: 'tn-ai-report', 'data-test': 'compare-report' });
    box.append(h('p', { class: 'tn-ai-summary', text: result.overview || '—' }));
    for (const job of result.jobs || []) {
      box.append(h('article', { class: 'tn-ai-job' },
        h('div', { class: 'tn-ai-job-head' }, h('strong', { text: [job.company_name, job.job_title].filter(Boolean).join(' · ') || job.application_id }),
          job.has_applied ? h('span', { class: 'tn-ai-level ok', text: '已投递' }) : h('span', { class: 'tn-ai-level muted', text: '未投递' }),
          tagLevel(job.match_level)),
        job.information_sufficient === false ? h('p', { class: 'tn-inline-msg err', text: 'JD 信息不足，匹配判断只能作为线索，不能视为确定结论。' }) : null,
        listBlock('匹配优势', job.strengths, (x) => h('li', { text: x })),
        listBlock('主要缺口', job.gaps, (x) => h('li', { text: x })),
        listBlock('依据', job.evidence, (x) => h('div', { class: 'tn-ai-item' }, h('div', { class: 'tn-small tn-muted', text: '简历' }), evidence(x.resume_evidence), h('div', { class: 'tn-small tn-muted', text: 'JD' }), evidence(x.jd_evidence))),
        job.next_step ? h('p', { class: 'tn-small', text: '下一步：' + job.next_step }) : null,
        h('div', { class: 'tn-action-row' }, appLink(job.application_id), external(job.job_url))
      ));
    }
    if (result.differences?.length) box.append(h('section', { class: 'tn-ai-block' }, h('h4', { text: '主要差异' }), h('ul', {}, ...result.differences.map((x) => h('li', { text: x })))));
    if (result.ranking?.length) {
      const names = new Map([...(result.selected_jobs || []), ...selectedApps].map((x) => [x.application_id || x.id, [x.company_name, x.job_title].filter(Boolean).join(' · ')]));
      box.append(h('section', { class: 'tn-ai-block' }, h('h4', { text: '相对优先级' }),
        ...result.ranking.map((x) => h('p', { class: 'tn-small', text: `#${x.rank || '—'} ${names.get(x.application_id) || x.application_id}：${x.reason || ''}` }))));
    }
    if (result.limitations?.length) box.append(h('section', { class: 'tn-ai-block' }, h('h4', { text: '判断限制' }), h('ul', {}, ...result.limitations.map((x) => h('li', { text: x })))));
    return box;
  }

  function renderRecommend() {
    clear(recommendSection);
    recommendSection.append(h('div', { class: 'tn-ai-section-head' }, h('h2', { text: '3. 未投递岗位推荐' }),
      h('span', { class: 'tn-small tn-muted', text: '只使用系统已采集、尚未投递的岗位；不访问外部招聘网站' })));
    const button = h('button', { class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', text: recommendation?.status === 'running' ? '分析中…' : '推荐未投递岗位', 'data-test': 'recommend-run', disabled: busy || !resume || resume.status !== 'ready', onclick: runRecommend });
    recommendSection.append(h('div', { class: 'tn-action-row' }, button, h('span', { class: 'tn-small tn-muted', text: resume?.status === 'ready' ? '会读取当前账号全部未投递岗位，而不只是当前页' : '需要当前简历分析完成' })));
    if (recommendation?.error) recommendSection.append(h('div', { class: 'tn-inline-msg err', text: recommendation.error }));
    if (recommendation?.data) recommendSection.append(renderRecommendReport(recommendation.data));
  }

  async function runRecommend() {
    if (busy) return;
    if (!resume || resume.status !== 'ready') { toast('请先完成当前简历分析', 'err'); return; }
    recommendation = { status: 'running' };
    setBusy(true);
    renderRecommend();
    try {
      const res = await api.post('/api/v1/ai/recommend', {});
      recommendation = { status: 'ready', data: res.data.result, report: res.data.report };
      toast('推荐已生成', 'ok');
    } catch (err) {
      recommendation = { status: 'failed', error: errorMessage(err) };
    } finally {
      setBusy(false);
      renderRecommend();
    }
  }

  function renderRecommendReport(result) {
    const box = h('div', { class: 'tn-ai-report', 'data-test': 'recommend-report' });
    if (result.summary) box.append(h('p', { class: 'tn-ai-summary', text: result.summary }));
    if (!result.recommendations?.length && !result.insufficient?.length) {
      box.append(h('div', { class: 'tn-empty' }, h('p', { text: '当前没有未投递岗位。' }), h('p', { class: 'tn-small tn-muted', text: '插件采集到新岗位或手动补录后会出现在这里。' })));
    }
    for (const item of result.recommendations || []) {
      box.append(h('article', { class: 'tn-ai-job' },
        h('div', { class: 'tn-ai-job-head' }, h('strong', { text: `#${item.rank || '—'} ${[item.company_name, item.job_title].filter(Boolean).join(' · ')}` }), tagLevel(item.match_level)),
        item.location ? h('div', { class: 'tn-small tn-muted', text: item.location }) : null,
        listBlock('推荐理由', item.reasons, (x) => h('li', { text: x })),
        listBlock('匹配优势', item.strengths, (x) => h('li', { text: x })),
        listBlock('主要缺口', item.gaps, (x) => h('li', { text: x })),
        item.next_step ? h('p', { class: 'tn-small', text: '下一步：' + item.next_step }) : null,
        h('div', { class: 'tn-action-row' }, appLink(item.application_id), external(item.job_url))
      ));
    }
    if (result.insufficient?.length) {
      box.append(h('section', { class: 'tn-ai-block', 'data-test': 'recommend-insufficient' }, h('h4', { text: '未纳入确定推荐（信息不足或未进入本次排序）' }),
        ...result.insufficient.map((item) => h('div', { class: 'tn-ai-item' }, h('strong', { text: [item.company_name, item.job_title].filter(Boolean).join(' · ') }), h('div', { class: 'tn-small tn-muted', text: item.reason || 'JD 不足' }), h('div', { class: 'tn-action-row' }, appLink(item.application_id), external(item.job_url))))));
    }
    if (result.limitations?.length) box.append(h('section', { class: 'tn-ai-block' }, h('h4', { text: '判断限制' }), h('ul', {}, ...result.limitations.map((x) => h('li', { text: x })))));
    return box;
  }

  await load();
}
