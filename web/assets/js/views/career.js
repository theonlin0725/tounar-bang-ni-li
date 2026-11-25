/* 简历与 AI：上传/修正简历、简历画像、岗位对比、「看过没投」岗位推荐。
 * 所有数据来自当前账号 API；前端不拼模型请求、不读取其他用户数据。 */
import { api, errorText } from '../api.js';
import { isStale } from '../app.js?v=20261124-1';
import { h, clear, toast, fmtDateTime, openModal, idemKey, debounce } from '../util.js';
import { openDetail } from './detail.js?v=20261124-1';
import { renderResumeRewrite } from './resume-rewrite.js?v=20261124-2';
import { openJobPicker } from './job-picker.js?v=20261124-1';

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

export async function renderCareer(container, { gen, applicationId = null, section = null, reportId = null, draftId = null } = {}) {
  const root = h('div', { class: 'tn-career', 'data-test': 'career-view' });
  container.append(root);
  let resume = null;
  let versions = [];
  let resumePreview = null;
  let resumePreviewId = null;
  let resumeEdit = null;
  let resumeNextCursor = null;
  let resumeHasMore = false;
  let resumeLoadingMore = false;
  let resumeUploads = [];
  let resumeRequests = 0;
  let analyzingResumeIds = new Set();
  let status = null;
  let profile = null;
  let busy = false;
  let recommendation = null;
  let recommendResume = null;
  let matchApps = [];
  let matchAppId = applicationId || null;
  let match = null;
  let matchAppQuery = '';
  let matchAppCursors = { applied: null, viewed: null };
  let matchAppHasMore = { applied: false, viewed: false };
  let matchAppLoading = false;
  let matchAppReqSeq = 0;
  let matchHistory = [];
  let historyOpen = false;
  let matchHistoryReqSeq = 0;
  let matchReportReqSeq = 0;
  let matchBusy = false;
  let openDimension = null;
  let interview = null;
  let resumeSuggestionsOpen = false;
  const active = () => !isStale(gen) && root.isConnected;
  const showingResume = section === 'resume';
  const showingRewrite = section === 'rewrite';
  const aiNotice = h('div', { class: 'tn-ai-notice', 'data-test': 'ai-status' });
  const matchSection = h('section', { class: 'tn-ai-card tn-match-card', 'data-test': 'match-section', id: 'tn-match-section', hidden: showingResume || showingRewrite });
  const resumeSection = h('section', { class: 'tn-ai-card', 'data-test': 'resume-section', id: 'tn-resume-section', hidden: !showingResume });
  const recommendSection = h('section', { class: 'tn-ai-card', 'data-test': 'recommend-section', id: 'tn-recommend-section', hidden: showingResume || showingRewrite });
  const rewriteSection = h('section', { class: 'tn-ai-card tn-rewrite-section', 'data-test': 'rewrite-section', id: 'tn-rewrite-section', hidden: !showingRewrite });
  root.append(aiNotice, matchSection, resumeSection, recommendSection, rewriteSection);

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
      const [statusRes, currentRes, listRes, profileRes] = await Promise.all([
        api.get('/api/v1/ai/status'), api.get('/api/v1/resumes/current'), api.get('/api/v1/resumes?limit=20'),
        api.get('/api/v1/profile')
      ]);
      if (!active()) return;
      status = statusRes.data;
      resume = currentRes.data;
      versions = listRes.data || [];
      recommendResume = resume?.status === 'ready' ? resume : (versions.find((item) => item.status === 'ready') || null);
      profile = profileRes.data?.profile || null;
      resumeNextCursor = listRes.page?.next_cursor || null;
      resumeHasMore = !!listRes.page?.has_more;
      renderNotice();
      if (showingRewrite) {
        rewriteSection.hidden = false;
        await renderResumeRewrite(rewriteSection, { gen, applicationId, draftId });
        return;
      }
      await loadMatchApps({ reset: true });
      if (!active()) return;
      renderResume();
      renderRecommend();
      if (matchAppId) {
        await loadMatchHistory();
        if (reportId && active()) await loadMatchReport(reportId, { targetAppId: matchAppId });
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

  function profileStatusLabel() {
    return profile?.status === 'confirmed' ? '已确认画像' : '未建立画像';
  }
  function openProfileEditor() {
    const field = (label, key, value, placeholder = '') => {
      const input = h('input', { class: 'tn-input', value: value || '', placeholder, 'data-test': `profile-${key}` });
      return { key, input, node: h('label', { class: 'tn-profile-field' }, h('span', { text: label }), input) };
    };
    const direction = field('职业发展方向', 'career_direction', profile?.career_direction, '产品经理 / 数据分析 / AI 产品');
    const locations = field('期望地点（用顿号或逗号分隔）', 'preferred_locations', (profile?.preferred_locations || []).join('、'), '上海、深圳');
    const industries = field('行业偏好', 'industry_preferences', (profile?.industry_preferences || []).join('、'), '互联网、金融科技');
    const companies = field('企业偏好', 'company_preferences', (profile?.company_preferences || []).join('、'), '大厂、外企、成长型公司');
    const salary = field('薪资期望', 'salary_expectation', profile?.salary_expectation, '月薪 20k–25k / 年包 30w+');
    const mode = field('工作方式', 'work_mode', profile?.work_mode, '线下面对面 / 混合办公 / 远程');
    const fields = [direction, locations, industries, companies, salary, mode];
    const form = h('div', { class: 'tn-profile-form' }, ...fields.map((item) => item.node));
    const save = h('button', { class: 'tn-btn tn-btn-primary', type: 'button', 'data-test': 'profile-save', text: '保存并确认画像', onclick: async () => {
      save.disabled = true;
      const body = {};
      for (const item of fields) {
        const value = item.input.value.trim();
        if (['preferred_locations', 'industry_preferences', 'company_preferences'].includes(item.key)) body[item.key] = value.split(/[、,，;；\n]/).map((x) => x.trim()).filter(Boolean);
        else body[item.key] = value;
      }
      try {
        const response = await api.put('/api/v1/profile', { ...body, status: 'confirmed' }, { idempotencyKey: idemKey('profile') });
        profile = response.data?.profile || profile;
        handle.close();
        renderMatch();
        toast('求职画像已保存，后续匹配会参考这些偏好', 'ok');
      } catch (error) {
        save.disabled = false;
        toast('画像保存失败：' + errorText(error), 'err');
      }
    } });
    const handle = openModal({
      title: '编辑求职画像', subtitle: '确认后写入匹配分析上下文；不会把模型推测当成偏好',
      testid: 'profile-editor',
      body: h('div', {}, h('p', { class: 'tn-small tn-muted', text: '可以只填目前明确的维度，其余留空。' }), form),
      footer: h('div', { class: 'tn-action-row' }, h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '取消', onclick: () => handle.close() }), save)
    });
  }
  function renderProfileCard() {
    const confirmed = profile?.status === 'confirmed';
    return h('section', { class: 'tn-profile-card', 'data-test': 'career-profile-card' },
      h('div', { class: 'tn-profile-card-main' },
        h('div', { class: 'tn-profile-card-head' }, h('span', { class: 'tn-ai-card-kicker', text: '求职画像' }),
          h('span', { class: `tn-state-pill ${confirmed ? 'state-ok' : 'state-warn'}`, text: profileStatusLabel() })),
        h('strong', { text: confirmed ? (profile.summary_text || '已确认求职偏好') : '还没有确认求职画像' }),
        h('div', { class: 'tn-small tn-muted', text: confirmed ? [profile.career_direction, profile.preferred_locations?.join('/'), profile.salary_expectation, profile.work_mode].filter(Boolean).join(' · ') : '完成画像后，六维匹配会结合地点、薪资、行业、企业类型与工作方式偏好。' })),
      h('div', { class: 'tn-profile-card-actions' },
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'profile-edit', text: confirmed ? '编辑画像' : '手动填写', onclick: openProfileEditor }),
        h('a', { class: 'tn-btn tn-btn-sm tn-btn-ghost', 'data-test': 'profile-ai', href: '/?panel=assistant&onboarding=profile', text: '用 AI 助手梳理' }))
    );
  }
  function renderMatch() {
    clear(matchSection);
    const selected = matchApps.find((item) => item.id === matchAppId);
    const report = match?.report || null;
    matchSection.append(h('div', { class: 'tn-ai-section-head' },
      h('div', {}, h('h2', { text: '单岗位匹配分析' }),
        h('p', { class: 'tn-small tn-muted', style: { margin: '4px 0 0' }, text: '帮你选择合适的岗位' }))
    ));
    matchSection.append(renderProfileCard());
    const pickerButton = h('button', {
      class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', 'data-test': 'match-choose-job',
      text: matchAppId ? '更换岗位' : '选择岗位',
      onclick: () => openJobPicker({
        selectedId: matchAppId || null,
        onSelect: (app) => {
          matchAppId = app?.id || '';
          if (app) mergeMatchApps([app]);
          match = null; interview = null; openDimension = null; matchHistory = []; historyOpen = false;
          ++matchHistoryReqSeq; ++matchReportReqSeq;
          renderMatch();
          if (matchAppId) loadMatchHistory();
        }
      })
    });
    const currentJob = matchApps.find((item) => item.id === matchAppId);
    matchSection.append(h('div', { class: 'tn-match-picker', 'data-test': 'match-job-picker' },
      h('div', { class: 'tn-match-current-job', 'data-test': 'match-current-job' },
        h('strong', { text: currentJob ? `${currentJob.company_name || ''} · ${currentJob.job_title || ''}` : '还没有选择岗位' }),
        h('span', { class: 'tn-small tn-muted', text: currentJob ? [currentJob.location, currentJob.recruitment_batch].filter(Boolean).join(' · ') || '城市/批次待补' : '从投递明细或看过没投中选择' })),
      pickerButton,
      h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'match-run', text: matchBusy ? '分析中…' : '开始匹配分析', disabled: matchBusy || !matchAppId || !resume || resume.status !== 'ready' || currentJob?.jd_status === 'missing', onclick: () => runMatch({ parent: null }) }),
      ...(currentJob?.jd_status === 'missing' ? [h('div', { class: 'tn-inline-msg warn', 'data-test': 'match-missing-jd', text: '该岗位缺 JD，请先回到台账补充 JD，或打开右侧 AI 助手粘贴 JD 后继续分析。' })] : [])
    ));
    matchSection.append(h('div', { class: 'tn-small tn-muted tn-match-current-resume', 'data-test': 'match-current-resume',
      text: resume?.status === 'ready' ? `当前简历：${resume.filename}${resume.updated_at ? ` · ${fmtDateTime(resume.updated_at)}` : ''}` : '当前没有可用于匹配的简历；请先到简历库完成分析。' }));
    if (matchAppLoading) matchSection.append(h('div', { class: 'tn-inline-msg', 'data-test': 'match-app-loading' }, h('span', { class: 'tn-spinner', 'aria-hidden': 'true' }), '正在加载更多台账岗位…'));
    if (matchAppId && selected) {
      matchSection.append(h('div', { class: 'tn-match-jobline' },
        h('strong', { text: [selected.company_name, selected.job_title].filter(Boolean).join(' · ') }),
        selected.location ? h('span', { class: 'tn-small tn-muted', text: selected.location }) : null,
        selected.job_url ? h('a', { class: 'tn-btn tn-btn-sm tn-btn-ghost', href: selected.job_url, target: '_blank', rel: 'noopener noreferrer', text: '原岗位' }) : null,
        matchHistory.length ? h('button', { class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', 'data-test': 'match-history-toggle', 'aria-expanded': historyOpen ? 'true' : 'false', text: historyOpen ? '收起历史报告' : `查看历史报告（${matchHistory.length}）`, onclick: () => { historyOpen = !historyOpen; renderMatch(); } }) : null
      ));
      if (historyOpen && matchHistory.length) {
        matchSection.append(h('div', { class: 'tn-match-history-list', 'data-test': 'match-history-list' },
          ...matchHistory.map((item) => h('button', {
            class: `tn-match-history-item${report?.id === item.id ? ' active' : ''}`, type: 'button', 'data-test': 'match-history-item', 'data-report-id': item.id,
            onclick: () => loadMatchReport(item.id)
          },
          h('span', { class: 'tn-match-history-date', text: fmtDateTime(item.created_at) }),
          h('span', { class: 'tn-match-history-resume', text: `简历：${item.resume_filename || '快照缺失'}` }),
          h('span', { class: `tn-ai-level ${item.status === 'ready' ? (SINGLE_LEVEL_CLASS[item.ability?.conclusion] || 'muted') : 'bad'}`, text: item.status === 'ready' ? (item.ability?.conclusion || '无法判断') : '失败' })))));
      }
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

  const SUMMARY_TOPICS = [
    ['skill', '技能'], ['tool', '工具'], ['experience', '经历'], ['project', '项目']
  ];
  function summaryStatus(item) {
    if (item.status_group) return item.status_group;
    return item.kind === '资料不足' ? '待补证' : (item.kind === '有证据的优势' ? '优势' : '明确差距');
  }
  const TOOL_ITEM_RE = /(SQL|Python|Java|C\+\+|C#|Golang|JavaScript|TypeScript|Excel|Tableau|Power\s?BI|Figma|Photoshop|Git|Linux|Docker|Kubernetes|AWS|Azure|Office|SPSS|MATLAB|软件|工具|平台|框架|编程语言)/i;
  const PROJECT_ITEM_RE = /(项目|作品|案例|交付|上线|落地|系统|dashboard|看板)/i;
  function summaryTopic(item) {
    if (item.topic) return item.topic;
    const key = item.dimension_key || item.key;
    const value = `${item.text || ''} ${item.requirement || ''}`;
    if (PROJECT_ITEM_RE.test(value)) return 'project';
    if (TOOL_ITEM_RE.test(value)) return 'tool';
    if (key === 'skills') return 'skill';
    if (key === 'experience') return 'experience';
    return 'other';
  }
  function summaryItems(result) {
    const merged = new Map();
    for (const item of [...(result.strengths || []), ...(result.gaps || [])]) {
      const text = String(item.text || '').trim();
      if (!text) continue;
      const key = text;
      const existing = merged.get(key);
      if (existing) {
        for (const evidence of item.evidence || []) {
          if (!(existing.evidence || []).some((x) => x.source === evidence.source && x.quote === evidence.quote)) existing.evidence.push(evidence);
        }
        continue;
      }
      merged.set(key, { ...item, evidence: [...(item.evidence || [])], statusGroup: summaryStatus(item) });
    }
    return [...merged.values()];
  }
  function summaryGroup(items, topic) {
    const topicItems = topic === 'other' ? items.filter((item) => summaryTopic(item) === 'other') : items.filter((item) => summaryTopic(item) === topic);
    const counts = ['优势', '明确差距', '待补证'].map((status) => [status, topicItems.filter((item) => item.statusGroup === status).length]).filter(([, count]) => count);
    const label = topic === 'other' ? '其他岗位条件' : SUMMARY_TOPICS.find(([key]) => key === topic)?.[1];
    const details = h('details', { class: 'tn-summary-group', 'data-test': `match-summary-${topic}` });
    details.append(h('summary', {},
      h('strong', { text: label }),
      h('span', { class: 'tn-small tn-muted', text: counts.length ? counts.map(([status, count]) => `${status} ${count}`).join(' · ') : '暂无已核实内容' })));
    const body = h('div', { class: 'tn-summary-group-body' });
    for (const status of ['优势', '明确差距', '待补证']) {
      const rows = topicItems.filter((item) => item.statusGroup === status);
      body.append(h('div', { class: `tn-summary-status ${status === '优势' ? 'ok' : status === '明确差距' ? 'bad' : 'warn'}` },
        h('h5', { text: status }),
        rows.length ? h('ul', { class: 'tn-match-list' }, ...rows.map((item) => h('li', {},
          h('span', { class: 'tn-match-dim-tag', text: item.dimension || DIMENSION_NAMES[item.key] || '匹配' }),
          (item.evidence_scope === 'dimension' || !item.evidence_scope) ? h('span', { class: 'tn-match-dim-tag', text: '维度依据' }) : null,
          h('span', { text: item.text }),
          summaryEvidence(item),
          status !== '优势' ? h('button', { class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', 'data-test': 'match-gap-supplement', onclick: () => openCorrectionModal({ dimension: item.key, original: `【${item.dimension}】${item.text}` }) }, '补充经历') : null
        ))) : h('p', { class: 'tn-small tn-muted', text: '暂无已核实内容' })));
    }
    details.append(body);
    return details;
  }

  function renderMatchReport(report) {
    const result = report.result || {};
    const currentJob = matchApps.find((x) => x.id === matchAppId) || {};
    const job = result.job || currentJob || {};
    const reportVersion = report.report_version || result.report_version || '';
    const changedName = currentJob.job_title && job.job_title && currentJob.job_title !== job.job_title;
    const box = h('div', { class: 'tn-ai-report tn-match-report', 'data-test': 'match-report', 'data-report-id': report.id });
    box.append(h('div', { class: 'tn-match-report-head' },
      h('div', {},
        h('h3', { text: [job.company_name, job.job_title].filter(Boolean).join(' · ') || '岗位匹配报告' }),
        changedName ? h('div', { class: 'tn-small tn-muted', text: `生成时岗位：${job.job_title}；当前台账：${currentJob.job_title}` }) : null,
        h('div', { class: 'tn-small tn-muted', text: `简历：${result.resume?.filename || '当前简历'}${result.resume?.updated_at ? ` · 版本 ${fmtDateTime(result.resume.updated_at)}` : ''} · 分析时间：${fmtDateTime(result.analyzed_at || report.completed_at)}` })),
      job.job_url ? h('a', { class: 'tn-btn tn-btn-sm', href: job.job_url, target: '_blank', rel: 'noopener noreferrer', text: '打开原岗位' }) : null,
      h('details', { class: 'tn-match-report-info' },
        h('summary', { class: 'tn-small tn-muted', text: '报告信息' }),
        h('div', { class: 'tn-small tn-muted', text: `报告 ${report.id} · ${reportVersion || 'match-v1（旧）'} · 生成于 ${fmtDateTime(report.created_at)}` }))
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

    const summaryRows = summaryItems(result);
    const summaryGroups = h('div', { class: 'tn-summary-groups' },
      ...SUMMARY_TOPICS.map(([topic]) => summaryGroup(summaryRows, topic)),
      summaryRows.some((item) => summaryTopic(item) === 'other') ? summaryGroup(summaryRows, 'other') : null
    );
    box.append(h('section', { class: 'tn-match-section-block tn-summary-section' },
      h('h4', { text: '优势与差距' }),
      reportVersion !== 'match-v2' ? h('p', { class: 'tn-small tn-muted', text: '旧报告只有维度级证据，以下分类按原始判断保守展示，分类与证据对应关系待重新分析核实。' }) : null,
      summaryGroups));
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
      h('a', { class: 'tn-btn tn-btn-sm tn-btn-ghost', 'data-test': 'match-ask-assistant', href: `/?panel=assistant&app=${encodeURIComponent(report.result?.job?.application_id || matchAppId)}&resume=${encodeURIComponent(report.result?.resume?.id || resume?.id || '')}`, text: '问 AI 助手' }),
      h('a', { class: 'tn-btn tn-btn-sm tn-btn-ghost', 'data-test': 'match-open-rewrite', href: `/?panel=career&section=rewrite&app=${encodeURIComponent(report.result?.job?.application_id || matchAppId)}`, text: '按 JD 改写简历' }),
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
      const response = await api.get(`/api/v1/ai/match-reports?application_id=${encodeURIComponent(targetAppId)}&limit=12`);
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

  function resumeStatusText(value) {
    return value === 'ready' ? '画像已就绪' : value === 'failed' ? '分析失败' : value === 'analyzing' ? '分析中' : value === 'parsed' ? '已解析，待分析' : '待处理';
  }
  function resumeStatusClass(value) {
    return value === 'ready' ? 'ok' : value === 'failed' ? 'bad' : value === 'analyzing' ? 'warn' : 'muted';
  }
  function mergeVersion(next) {
    if (!next?.id) return;
    const index = versions.findIndex((v) => v.id === next.id);
    if (index >= 0) versions[index] = { ...versions[index], ...next };
    else versions = [next, ...versions];
    if (next.is_current) versions = versions.map((v) => v.id === next.id ? v : { ...v, is_current: false });
  }
  function profileEvidence(node) {
    return node ? h('blockquote', { class: 'tn-ai-evidence', text: `原文：${node}` }) : null;
  }
  function resumeGroup(title, rows, { test, render, preview }) {
    if (!rows?.length) return null;
    const details = h('details', { class: 'tn-resume-profile-group', 'data-test': test });
    details.append(h('summary', {},
      h('strong', { text: title }),
      h('span', { class: 'tn-resume-profile-preview', text: preview }),
      h('span', { class: 'tn-resume-profile-more', text: rows.length > 2 ? `展开 ${rows.length} 条` : '展开' })
    ));
    details.append(h('div', { class: 'tn-resume-profile-items' }, ...rows.map(render)));
    return details;
  }
  function profileNode(profile) {
    if (!profile) return h('div', { class: 'tn-empty tn-resume-profile-empty' },
      h('p', { text: '还没有画像。先上传一份简历并分析，或修正文本后重试。' }),
      h('p', { class: 'tn-small tn-muted', text: '不上传简历也可以先浏览台账；分析失败会保留当前版本和重试入口。' }));
    const box = h('div', { class: 'tn-resume-profile-summary', 'data-test': 'resume-profile' });
    if (!profile.grounded) box.append(h('div', { class: 'tn-inline-msg err', text: '没有找到可逐字核验的简历证据；请修正文本后重新分析，避免使用未核验画像。' }));
    const skills = profile.skills || [];
    const experiences = profile.experiences || [];
    const skillNames = skills.slice(0, 2).map((x) => x.name).filter(Boolean);
    const expNames = experiences.slice(0, 2).map((x) => [x.organization, x.role].filter(Boolean).join(' · ') || x.role || x.organization).filter(Boolean);
    const primary = h('div', { class: 'tn-resume-profile-primary' },
      resumeGroup('主要技能', skills, { test: 'resume-profile-skills', preview: skillNames.join('、') || '暂无已识别技能', render: (x) => h('div', { class: 'tn-ai-item' }, h('strong', { text: x.name }), profileEvidence(x.evidence)) }),
      resumeGroup('经历 / 项目', experiences, { test: 'resume-profile-experience', preview: expNames.join('、') || '暂无已识别经历', render: (x) => h('div', { class: 'tn-ai-item' },
        h('strong', { text: [x.organization, x.role].filter(Boolean).join(' · ') || '经历' }),
        x.period ? h('span', { class: 'tn-small tn-muted', text: x.period }) : null,
        x.highlights?.length ? h('ul', {}, ...x.highlights.map((t) => h('li', { text: t }))) : null,
        profileEvidence(x.evidence)) })
    );
    box.append(primary);
    const more = [];
    if (profile.industries?.length) more.push(resumeGroup('行业经验', profile.industries, { test: 'resume-profile-industries', preview: profile.industries.slice(0, 2).map((x) => x.name).join('、'), render: (x) => h('div', { class: 'tn-ai-item' }, h('strong', { text: x.name }), profileEvidence(x.evidence)) }));
    if (profile.strengths?.length) more.push(resumeGroup('突出优势', profile.strengths, { test: 'resume-profile-strengths', preview: profile.strengths.slice(0, 2).map((x) => x.point).join('；'), render: (x) => h('div', { class: 'tn-ai-item' }, h('p', { text: x.point }), profileEvidence(x.evidence)) }));
    if (profile.constraints?.length) more.push(resumeGroup('关键限制', profile.constraints, { test: 'resume-profile-constraints', preview: profile.constraints.slice(0, 2).map((x) => x.point).join('；'), render: (x) => h('div', { class: 'tn-ai-item' }, h('p', { text: x.point }), profileEvidence(x.evidence)) }));
    if (more.length) box.append(h('details', { class: 'tn-resume-profile-more-wrap', 'data-test': 'resume-profile-more' },
      h('summary', { text: `更多画像（${more.length} 组）` }), h('div', { class: 'tn-resume-profile-more-items' }, ...more)));
    return box;
  }

  function currentVersionActions(v) {
    return h('div', { class: 'tn-action-row' },
      h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'resume-analyze', text: analyzingResumeIds.has(v.id) ? '分析中…' : (v.status === 'failed' ? '重试分析' : '重新分析'), disabled: analyzingResumeIds.has(v.id), onclick: () => analyzeResume(v.id, { force: true }) }),
      h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'resume-edit', text: '修正文本', onclick: () => startResumeEdit(v.id) }),
      h('a', { class: 'tn-btn tn-btn-sm tn-btn-ghost', 'data-test': 'resume-export-docx', href: `/api/v1/resumes/${encodeURIComponent(v.id)}/export.docx`, text: '下载 Word' })
    );
  }
  function versionRow(v) {
    const name = [v.filename].filter(Boolean).join('') || '未命名简历';
    return h('div', { class: 'tn-resume-version-row', 'data-test': 'resume-version-row', 'data-resume-id': v.id },
      h('div', { class: 'tn-resume-version-main' },
        h('strong', { text: name }),
        h('div', { class: 'tn-small tn-muted', text: `${fmtDateTime(v.created_at)} · ${v.text_chars || 0} 字 · ${resumeStatusText(v.status)}` }),
        (v.parent_resume_id || v.target_application_id) ? h('div', { class: 'tn-tiny tn-muted', 'data-test': 'resume-ai-rewrite-source', text: `AI 定向改写版本 · 原版本 ${String(v.parent_resume_id || '').slice(-8)}${v.target_application_id ? ` · 目标岗位 ${String(v.target_application_id).slice(-8)}` : ''}${v.rewrite_summary?.sections?.length ? ` · ${v.rewrite_summary.sections.length} 段对比` : ''}` }) : null,
        h('div', { class: 'tn-tiny tn-faint', text: `版本 ID：${v.id}` })),
      h('div', { class: 'tn-resume-version-actions' },
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'resume-version-view', text: resumePreviewId === v.id ? '返回当前' : '查看', onclick: () => resumePreviewId === v.id ? closeResumePreview() : loadResumePreview(v.id) }),
        h('a', { class: 'tn-btn tn-btn-sm tn-btn-ghost', 'data-test': 'resume-version-export', href: `/api/v1/resumes/${encodeURIComponent(v.id)}/export.docx`, text: 'Word' }),
        v.is_current ? h('span', { class: 'tn-state-pill state-ok', text: '当前版本' }) : h('button', { class: 'tn-btn tn-btn-sm tn-btn-primary', type: 'button', 'data-test': 'resume-version-current', text: '设为当前', onclick: () => setCurrentResume(v.id) })
      ));
  }
  function closeResumePreview() {
    resumePreviewId = null;
    resumePreview = null;
    if (resumeEdit?.id === resumePreview?.id) resumeEdit = null;
    renderResume();
  }
  async function loadResumePreview(id) {
    resumePreviewId = id;
    resumePreview = null;
    renderResume();
    try {
      const result = await api.get(`/api/v1/resumes/${encodeURIComponent(id)}`);
      if (!active() || resumePreviewId !== id) return;
      resumePreview = result.data;
      mergeVersion(result.data);
      renderResume();
    } catch (err) {
      if (active() && resumePreviewId === id) toast('简历预览失败：' + errorMessage(err), 'err');
    }
  }
  async function setCurrentResume(id) {
    try {
      const result = await api.post(`/api/v1/resumes/${encodeURIComponent(id)}/current`, {});
      if (!active()) return;
      resume = result.data;
      versions = versions.map((v) => ({ ...v, is_current: v.id === id }));
      if (resumePreview) resumePreview = { ...resumePreview, is_current: resumePreview.id === id };
      toast('已设为当前简历；新分析会读取这个版本', 'ok');
      renderResume();
      renderMatch();
      renderRecommend();
    } catch (err) { toast('切换当前简历失败：' + errorMessage(err), 'err'); }
  }
  async function loadMoreResumes() {
    if (!resumeHasMore || !resumeNextCursor || resumeLoadingMore) return;
    resumeLoadingMore = true;
    try {
      const response = await api.get(`/api/v1/resumes?limit=20&cursor=${encodeURIComponent(resumeNextCursor)}`);
      if (!active()) return;
      for (const item of response.data || []) mergeVersion(item);
      resumeNextCursor = response.page?.next_cursor || null;
      resumeHasMore = !!response.page?.has_more;
      renderResume();
    } catch (err) { toast('加载更多简历版本失败：' + errorMessage(err), 'err'); }
    finally { resumeLoadingMore = false; }
  }
  async function startResumeEdit(id) {
    try {
      const source = id === resume?.id ? resume
        : id === resumePreview?.id && resumePreview?.text != null ? resumePreview
          : (await api.get(`/api/v1/resumes/${encodeURIComponent(id)}`)).data;
      if (!active()) return;
      resumeEdit = { id, text: String(source.text || '') };
      renderResume();
      requestAnimationFrame(() => resumeSection.querySelector('[data-test="resume-edit-text"]')?.focus());
    } catch (err) { toast('读取完整简历失败：' + errorMessage(err), 'err'); }
  }
  function renderResumeEditor() {
    if (!resumeEdit?.id) return null;
    const textarea = h('textarea', { class: 'tn-textarea tn-resume-edit-area', rows: '10', 'data-test': 'resume-edit-text', value: resumeEdit.text });
    textarea.addEventListener('input', () => { resumeEdit.text = textarea.value; });
    const save = h('button', { class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', 'data-test': 'resume-edit-save', text: '保存完整文本并重新分析', onclick: async () => {
      if (textarea.value.trim().length < 20) { toast('请粘贴完整简历文本', 'err'); return; }
      const editedId = resumeEdit.id;
      try {
        const updated = await api.put(`/api/v1/resumes/${encodeURIComponent(editedId)}/text`, { text: textarea.value });
        if (!active()) return;
        mergeVersion(updated);
        if (resume?.id === editedId) resume = updated;
        if (resumePreview?.id === editedId) resumePreview = updated;
        resumeEdit = null;
        renderResume();
        await analyzeResume(editedId, { force: true });
      } catch (err) { toast('保存简历文本失败：' + errorMessage(err), 'err'); }
    } });
    return h('div', { class: 'tn-resume-editor', 'data-test': 'resume-edit-wrap' },
      h('div', { class: 'tn-small tn-muted', text: `正在修正版本 ${resumeEdit.id} 的完整原文（不是 800 字预览）；保存后只分析这个版本，不会自动切换当前版本。` }),
      textarea, h('div', { class: 'tn-action-row' }, save,
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '取消', onclick: () => { resumeEdit = null; renderResume(); } })));
  }
  function renderPreview() {
    if (!resumePreviewId) return null;
    if (!resumePreview) return h('div', { class: 'tn-resume-preview', 'data-test': 'resume-preview' }, h('div', { class: 'tn-small tn-muted', text: '正在读取所选版本…' }));
    const v = resumePreview;
    return h('div', { class: 'tn-resume-preview', 'data-test': 'resume-preview' },
      h('div', { class: 'tn-resume-preview-head' },
        h('div', {}, h('strong', { text: v.filename }), h('div', { class: 'tn-small tn-muted', text: `预览版本 · ${fmtDateTime(v.created_at)} · ${v.text_chars || 0} 字 · ${resumeStatusText(v.status)}` }), (v.parent_resume_id || v.target_application_id) ? h('div', { class: 'tn-tiny tn-muted', text: `AI 定向改写版本 · 原版本 ${String(v.parent_resume_id || '').slice(-8)}${v.target_application_id ? ` · 目标岗位 ${String(v.target_application_id).slice(-8)}` : ''}` }) : null, h('div', { class: 'tn-tiny tn-faint', text: `版本 ID：${v.id}` })),
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '关闭预览', onclick: closeResumePreview })),
      h('pre', { class: 'tn-resume-preview-text', text: v.text || '这个版本没有可预览文本。' }),
      h('div', { class: 'tn-action-row' },
        v.is_current ? h('span', { class: 'tn-state-pill state-ok', text: '这是当前版本' }) : h('button', { class: 'tn-btn tn-btn-sm tn-btn-primary', type: 'button', 'data-test': 'resume-preview-current', text: '设为当前', onclick: () => setCurrentResume(v.id) }),
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '重新分析这个版本', disabled: analyzingResumeIds.has(v.id), onclick: () => analyzeResume(v.id, { force: true }) }),
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '修正这个版本的文本', onclick: () => startResumeEdit(v.id) })));
  }
  function renderResume() {
    clear(resumeSection);
    resumeSection.append(h('div', { class: 'tn-career-subtabs', 'data-test': 'resume-subtabs' },
      h('a', { href: '/?panel=career&section=resume', class: 'tn-career-subtab active', text: '我的简历' }),
      h('a', { href: '/?panel=career&section=rewrite', class: 'tn-career-subtab', text: '简历改写' })
    ));
    const current = resume;
    const file = h('input', { type: 'file', multiple: true, accept: '.pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain', 'data-test': 'resume-file', hidden: true });
    file.addEventListener('change', () => { const files = [...file.files || []]; file.value = ''; if (files.length) uploadResumeFiles(files); });
    const upload = h('button', { class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', text: '上传新版本', 'data-test': 'resume-upload', onclick: () => file.click() });
    const pasteToggle = h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '粘贴文本', 'data-test': 'resume-paste-toggle', onclick: () => { pasteWrap.hidden = !pasteWrap.hidden; if (!pasteWrap.hidden) paste.focus(); } });
    const paste = h('textarea', { class: 'tn-input', rows: '8', placeholder: '粘贴完整简历文本；保存后会创建一个独立版本并自动分析。', 'data-test': 'resume-paste' });
    const savePaste = h('button', { class: 'tn-btn tn-btn-sm tn-btn-primary', type: 'button', text: '保存文本并分析', 'data-test': 'resume-paste-save', onclick: async () => {
      if (paste.value.trim().length < 20) { toast('请粘贴完整简历文本', 'err'); return; }
      await createResumeFromText(paste.value);
    } });
    const pasteWrap = h('div', { class: 'tn-resume-paste', hidden: true }, paste, h('div', { class: 'tn-action-row' }, savePaste));
    resumeSection.append(...[
      h('div', { class: 'tn-resume-actions' }, upload, pasteToggle, h('span', { class: 'tn-small tn-muted', text: 'PDF / DOCX / TXT / MD，单份不超过 5 MB；可一次选择多份。' }), file),
      pasteWrap,
      renderUploadStatuses()
    ].filter(Boolean));
    if (!current && !versions.length) {
      resumeSection.append(h('div', { class: 'tn-empty' }, h('p', { text: '还没有简历。上传文件或粘贴完整文本后开始分析。' }),
        h('p', { class: 'tn-small tn-muted', text: '当前没有可用简历，匹配分析与推荐会明确提示需要先完成简历分析。' })));
      return;
    }
    if (current) {
      resumeSection.append(h('div', { class: 'tn-resume-current', 'data-test': 'resume-current', 'data-resume-id': current.id },
        h('div', { class: 'tn-resume-current-main' },
          h('div', { class: 'tn-small tn-muted', text: '当前版本' }),
          h('strong', { text: current.filename }),
          h('div', { class: 'tn-small tn-muted', text: `${current.text_chars || 0} 字 · ${fmtDateTime(current.updated_at)} · ${resumeStatusText(current.status)}` }),
          h('div', { class: 'tn-tiny tn-faint', text: `版本 ID：${current.id}` })),
        h('div', { class: 'tn-resume-current-actions' }, currentVersionActions(current))));
      if (current.error_message) resumeSection.append(h('div', { class: 'tn-inline-msg err', text: `${current.error_code || '分析失败'}：${current.error_message}` }));
      resumeSection.append(h('div', { class: 'tn-resume-profile' }, profileNode(current.profile)));
      const editor = renderResumeEditor();
      if (editor) resumeSection.append(editor);
    }
    const preview = renderPreview();
    if (preview) resumeSection.append(preview);
    if (resumeEdit && (!current || resumeEdit.id !== current.id) && !resumePreview) resumeSection.append(renderResumeEditor());
    const others = versions.filter((v) => v.id !== current?.id);
    resumeSection.append(h('div', { class: 'tn-resume-history', 'data-test': 'resume-history' },
      h('h3', { text: '其他版本' }),
      others.length ? h('div', { class: 'tn-resume-version-list' }, ...others.map(versionRow)) : h('p', { class: 'tn-small tn-muted', text: '还没有其他版本。每次上传或粘贴都会保留一个独立版本。' }),
      resumeHasMore ? h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'resume-history-more', text: resumeLoadingMore ? '加载中…' : '加载更多版本', disabled: resumeLoadingMore, onclick: loadMoreResumes }) : null
    ));
  }
  function renderUploadStatuses() {
    if (!resumeUploads.length) return null;
    return h('div', { class: 'tn-resume-uploads', 'data-test': 'resume-upload-statuses' },
      ...resumeUploads.map((item) => h('div', { class: 'tn-resume-upload-row' },
        h('span', { text: item.name }),
        h('span', { class: `tn-state-pill ${item.status === 'done' ? 'state-ok' : item.status === 'failed' ? 'state-err' : 'state-warn'}`, text: item.status === 'done' ? '成功' : item.status === 'failed' ? '失败' : item.status === 'analyzing' ? '分析中' : '上传中' }),
        item.error ? h('span', { class: 'tn-small tn-danger-text', text: item.error }) : null,
        item.status === 'failed' && (item.file || item.text)
          ? h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '重试这份', onclick: () => item.file ? uploadResumeFiles([item.file]) : createResumeFromText(item.text) })
          : null)));
  }
  async function createResumeFromText(text) {
    const item = { name: '粘贴的简历.txt', status: 'uploading', text };
    resumeUploads = [item, ...resumeUploads].slice(0, 20);
    renderResume();
    try {
      const created = await api.post('/api/v1/resumes/text', { text, filename: '粘贴的简历.txt' });
      if (!active()) return;
      item.status = 'done';
      resume = created.data;
      mergeVersion(created.data);
      versions = versions.map((v) => ({ ...v, is_current: v.id === created.data.id }));
      renderResume();
      await analyzeResume(created.data.id, { force: true });
    } catch (err) {
      item.status = 'failed';
      item.error = errorMessage(err);
      renderResume();
      toast('保存粘贴文本失败：' + errorMessage(err), 'err');
    }
  }
  async function uploadResumeFiles(files) {
    for (const file of files) {
      const item = { name: file.name, status: 'uploading', file };
      resumeUploads = [item, ...resumeUploads].slice(0, 20);
      if (file.size > 5 * 1024 * 1024) { item.status = 'failed'; item.error = '超过 5 MB'; renderResume(); continue; }
      renderResume();
      try {
        const dataBase64 = await base64FromFile(file);
        const created = await api.post('/api/v1/resumes', { filename: file.name, mime: file.type, data_base64: dataBase64 });
        if (!active()) return;
        item.status = 'done';
        resume = created.data;
        mergeVersion(created.data);
        versions = versions.map((v) => ({ ...v, is_current: v.id === created.data.id }));
        renderResume();
        await analyzeResume(created.data.id, { force: true });
      } catch (err) {
        item.status = 'failed';
        item.error = errorMessage(err);
        renderResume();
        toast(`「${file.name}」上传/解析失败：${errorMessage(err)}`, 'err');
      }
    }
  }
  async function analyzeResume(id, { force = false } = {}) {
    if (!id || analyzingResumeIds.has(id) || (busy && !force)) return;
    analyzingResumeIds.add(id);
    const setStatus = (status, error) => {
      versions = versions.map((v) => v.id === id ? { ...v, status, ...(error ? { error_message: error } : {}) } : v);
      if (resume?.id === id) resume = { ...resume, status, ...(error ? { error_message: error } : {}) };
      if (resumePreview?.id === id) resumePreview = { ...resumePreview, status, ...(error ? { error_message: error } : {}) };
    };
    setStatus('analyzing');
    renderResume();
    try {
      const result = await api.post(`/api/v1/resumes/${encodeURIComponent(id)}/analyze`, {});
      if (!active()) return;
      mergeVersion(result.data);
      if (resume?.id === id) resume = result.data;
      if (resumePreview?.id === id) resumePreview = result.data;
      toast('简历分析完成', 'ok');
    } catch (err) {
      if (active()) {
        setStatus('failed', errorMessage(err));
        toast('简历分析失败：' + errorMessage(err), 'err');
      }
    } finally {
      analyzingResumeIds.delete(id);
      if (active()) { renderResume(); renderMatch(); renderRecommend(); }
    }
  }

  function openRecommendResumePicker() {
    const ready = versions.filter((item) => item.status === 'ready');
    let choice = recommendResume?.id || ready[0]?.id || '';
    const list = h('div', { class: 'tn-rewrite-resume-list' });
    for (const item of ready) {
      const radio = h('input', { type: 'radio', name: 'recommend-resume', value: item.id, checked: item.id === choice });
      radio.addEventListener('change', () => { choice = item.id; });
      list.append(h('label', { class: 'tn-rewrite-resume-option', 'data-test': 'recommend-resume-option' }, radio,
        h('span', {}, h('strong', { text: item.filename }),
          h('span', { class: 'tn-small tn-muted', text: `${item.parent_resume_id || item.target_application_id ? 'AI 定向改写版本' : '原始上传'} · ${item.text_chars || 0} 字 · ${fmtDateTime(item.updated_at)}` }))));
    }
    const handle = openModal({
      title: '选择简历', subtitle: '推荐只会使用已分析完成的简历版本', testid: 'recommend-resume-picker',
      body: ready.length ? list : h('div', { class: 'tn-empty' }, h('p', { text: '还没有分析完成的简历' })),
      footer: h('div', { class: 'tn-action-row' }, h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '取消', onclick: () => handle.close() }),
        h('button', { class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', 'data-test': 'recommend-resume-confirm', text: '确认选择', disabled: !ready.length,
          onclick: () => { recommendResume = ready.find((item) => item.id === choice) || recommendResume; handle.close(); renderRecommend(); } }))
    });
  }
  function renderRecommend() {
    clear(recommendSection);
    if (!recommendResume && resume?.status === 'ready') recommendResume = resume;
    recommendSection.append(h('div', { class: 'tn-ai-section-head' }, h('div', {}, h('h2', { text: '「看过没投」岗位推荐' }))));
    const chooseResume = h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'recommend-resume-change', text: '选择简历', onclick: openRecommendResumePicker });
    const button = h('button', { class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', text: recommendation?.status === 'running' ? '分析中…' : '推荐「看过没投」岗位', 'data-test': 'recommend-run', disabled: busy || !recommendResume || recommendResume.status !== 'ready', onclick: runRecommend });
    recommendSection.append(h('div', { class: 'tn-action-row' }, chooseResume, button,
      h('span', { class: 'tn-small tn-muted', 'data-test': 'recommend-resume-label', text: recommendResume ? `已选简历：${recommendResume.filename}` : '需要先完成简历分析' })));
    if (recommendation?.error) recommendSection.append(h('div', { class: 'tn-inline-msg err', text: recommendation.error }));
    if (recommendation?.data) recommendSection.append(renderRecommendReport(recommendation.data));
  }

  async function runRecommend() {
    if (busy) return;
    if (!recommendResume || recommendResume.status !== 'ready') { toast('请先选择并完成简历分析', 'err'); return; }
    recommendation = { status: 'running' };
    setBusy(true);
    renderRecommend();
    try {
      const res = await api.post('/api/v1/ai/recommend', { resume_id: recommendResume.id });
      recommendation = { status: 'ready', data: res.data.result, report: res.data.report };
      toast('推荐已生成', 'ok');
    } catch (err) {
      recommendation = { status: 'failed', error: errorMessage(err) };
    } finally {
      setBusy(false);
      renderRecommend();
    }
  }

  function recommendCard(title, rows, tone) {
    const items = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const card = h('section', { class: `tn-recommend-card ${tone}` },
      h('h4', { text: title }));
    if (!items.length) {
      card.append(h('p', { class: 'tn-small tn-muted', text: '暂无已核实内容' }));
      return card;
    }
    const visible = items.slice(0, 2);
    for (const item of visible) card.append(h('p', { text: item }));
    if (items.length > 2) {
      const rest = h('div', { class: 'tn-recommend-rest', hidden: true }, ...items.slice(2).map((item) => h('p', { text: item })));
      card.append(rest, h('button', { class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', 'data-test': 'recommend-more', text: `展开其余 ${items.length - 2} 条`, onclick: () => {
        rest.hidden = !rest.hidden;
        const button = card.querySelector('[data-test=recommend-more]');
        if (button) button.textContent = rest.hidden ? `展开其余 ${items.length - 2} 条` : '收起';
      } }));
    }
    return card;
  }
  function renderRecommendReport(result) {
    const box = h('div', { class: 'tn-ai-report', 'data-test': 'recommend-report' });
    if (result.summary) box.append(h('p', { class: 'tn-ai-summary', text: result.summary }));
    if (!result.recommendations?.length && !result.insufficient?.length) {
      box.append(h('div', { class: 'tn-empty' }, h('p', { text: '当前没有「看过没投」岗位。' }), h('p', { class: 'tn-small tn-muted', text: '插件采集到新岗位或手动补录后会出现在这里。' })));
    }
    for (const item of result.recommendations || []) {
      box.append(h('article', { class: 'tn-recommend-job', 'data-test': 'recommend-job' },
        h('div', { class: 'tn-recommend-job-head' },
          h('div', {}, h('strong', { text: `#${item.rank || '—'} ${[item.company_name, item.job_title].filter(Boolean).join(' · ')}` }),
            item.location ? h('div', { class: 'tn-small tn-muted', text: item.location }) : null),
          tagLevel(item.match_level)),
        h('div', { class: 'tn-recommend-cards' },
          recommendCard('推荐理由', item.reasons, 'neutral'),
          recommendCard('匹配优势', item.strengths, 'ok'),
          recommendCard('主要缺口', item.gaps, 'warn')),
        h('div', { class: 'tn-recommend-next' }, h('span', { class: 'tn-small', text: `下一步：${item.next_step || '先打开岗位确认要求，再决定是否准备投递。'}` })),
        h('div', { class: 'tn-action-row tn-recommend-actions' }, appLink(item.application_id), external(item.job_url))
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
