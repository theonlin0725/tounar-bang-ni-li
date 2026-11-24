/* v1.1.1 简历库「简历改写」工作台：岗位/简历/画像/JD 配置 → 左右对照编辑 → 新版本 + Word。 */
import { api, errorText } from '../api.js';
import { isStale } from '../app.js?v=20261124-1';
import { h, clear, toast, openModal, idemKey, debounce } from '../util.js';
import { openJobPicker } from './job-picker.js?v=20261124-1';

const ALIGN_LABEL = {
  supported_optimize: '已优化', improvable: '可优化', needs_user_fact: '待补事实', unsupported_blocked: '已拦截', unchanged: '未改动'
};

export async function renderResumeRewrite(container, { gen, applicationId = null, draftId = null } = {}) {
  const root = h('div', { class: 'tn-rewrite-workbench', 'data-test': 'resume-rewrite-view' });
  container.append(root);
  const active = () => !isStale(gen) && root.isConnected;
  let resumes = [];
  let selectedResume = null;
  let selectedApp = null;
  let profile = null;
  let requirements = '';
  let draft = null;
  let busy = false;
  let saveTimer = null;
  let pollTimer = null;

  function tabs() {
    return h('div', { class: 'tn-career-subtabs', 'data-test': 'resume-subtabs' },
      h('a', { href: '/?panel=career&section=resume', class: 'tn-career-subtab', text: '我的简历' }),
      h('a', { href: '/?panel=career&section=rewrite', class: 'tn-career-subtab active', text: '简历改写' })
    );
  }
  function renderConfig() {
    clear(root);
    root.append(tabs(), h('div', { class: 'tn-ai-section-head' },
      h('div', {}, h('h2', { text: '简历定向改写' }),
        h('p', { class: 'tn-small tn-muted', text: '选目标岗位和原简历，按 JD 做可核验的逐段改写；确认后生成新版本和 Word。' }))));
    const cards = h('div', { class: 'tn-rewrite-config-grid' });
    const jobCard = h('section', { class: 'tn-rewrite-config-card', 'data-test': 'rewrite-job-card' },
      h('div', { class: 'tn-rewrite-card-label', text: '目标岗位' }),
      selectedApp ? h('strong', { text: `${selectedApp.company_name || ''} · ${selectedApp.job_title || ''}` }) : h('strong', { text: '还没有选择岗位' }),
      h('div', { class: 'tn-small tn-muted', text: selectedApp ? [selectedApp.location, selectedApp.recruitment_batch].filter(Boolean).join(' · ') : '从投递明细或看过没投中选一个岗位' }),
      h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'rewrite-job-change', text: selectedApp ? '更换岗位' : '选择岗位',
        onclick: () => openJobPicker({ selectedId: selectedApp?.id || null, onSelect: async (app) => {
          selectedApp = app ? (await api.get(`/api/v1/applications/${encodeURIComponent(app.id)}`)).data : null;
          renderConfig();
        } }) }));
    const resumeCard = h('section', { class: 'tn-rewrite-config-card', 'data-test': 'rewrite-resume-card' },
      h('div', { class: 'tn-rewrite-card-label', text: '简历版本' }),
      selectedResume ? h('strong', { text: selectedResume.filename }) : h('strong', { text: '还没有选择简历' }),
      h('div', { class: 'tn-small tn-muted', text: selectedResume ? `${selectedResume.text_chars || 0} 字 · ${selectedResume.status || 'parsed'}` : '单个版本将作为新版本保存，原文件不覆盖' }),
      h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'rewrite-resume-change', text: '更换简历', onclick: openResumePicker }));
    const profileCard = h('section', { class: 'tn-rewrite-config-card', 'data-test': 'rewrite-profile-card' },
      h('div', { class: 'tn-rewrite-card-label', text: '求职画像' }),
      h('strong', { text: profile?.status === 'confirmed' ? (profile.summary_text || '已确认画像') : '未建立画像' }),
      h('div', { class: 'tn-small tn-muted', text: profile?.status === 'confirmed' ? '匹配与改写会参考画像中的地点、薪资和方向偏好。' : '建立画像后，改写会更贴合你的真实偏好。' }),
      h('a', { class: 'tn-btn tn-btn-sm tn-btn-ghost', href: '/?panel=assistant&onboarding=profile', 'data-test': 'rewrite-profile-ai', text: profile?.status === 'confirmed' ? '用 AI 助手更新' : '去 AI 助手建立' }));
    const jd = selectedApp ? String(selectedApp.jd_text || selectedApp.jd_summary || '').trim() : '';
    const jdCard = h('section', { class: 'tn-rewrite-config-card', 'data-test': 'rewrite-jd-card' },
      h('div', { class: 'tn-rewrite-card-label', text: 'JD 信息' }),
      h('strong', { text: jd.length >= 20 ? '已加载目标岗位 JD' : '目标岗位缺少完整 JD' }),
      h('div', { class: 'tn-small tn-muted', text: jd ? jd.slice(0, 140).replace(/\n/g, ' ') : '请先在岗位详情补充 JD，避免空跑模型。' }),
      selectedApp ? h('a', { class: 'tn-btn tn-btn-sm tn-btn-ghost', href: `/?app=${encodeURIComponent(selectedApp.id)}`, text: '查看岗位详情' }) : null);
    cards.append(jobCard, resumeCard, profileCard, jdCard);
    const textarea = h('textarea', { class: 'tn-input', rows: '3', 'data-test': 'rewrite-requirements', placeholder: '改写需求：重点突出数据分析、AI 项目或某个业务成果' });
    textarea.value = requirements;
    textarea.addEventListener('input', () => { requirements = textarea.value; });
    const start = h('button', { class: 'tn-btn tn-btn-primary', type: 'button', 'data-test': 'rewrite-start', text: busy ? '正在生成…' : '开始定向改写', disabled: busy || !selectedApp || !selectedResume || jd.length < 20,
      onclick: startRewrite });
    root.append(cards, h('div', { class: 'tn-rewrite-config-actions' }, textarea, start));
  }
  function openResumePicker() {
    let choice = selectedResume?.id || null;
    const list = h('div', { class: 'tn-rewrite-resume-list' });
    for (const resume of resumes) {
      const input = h('input', { type: 'radio', name: 'rewrite-resume', value: resume.id, checked: resume.id === choice });
      input.addEventListener('change', () => { choice = resume.id; });
      list.append(h('label', { class: 'tn-rewrite-resume-option', 'data-test': 'rewrite-resume-option' },
        input, h('span', {}, h('strong', { text: resume.filename }),
          h('span', { class: 'tn-small tn-muted', text: `${resume.text_chars || 0} 字 · ${resume.status || ''} · ${resume.updated_at ? new Date(resume.updated_at).toLocaleString('zh-CN') : ''}` }))));
    }
    const handle = openModal({
      title: '选择简历版本', subtitle: '用于本次优化的简历将作为新版本保存，不覆盖原文件',
      testid: 'rewrite-resume-picker',
      body: list,
      footer: h('div', { class: 'tn-action-row' }, h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '取消', onclick: () => handle.close() }),
        h('button', { class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', 'data-test': 'rewrite-resume-confirm', text: '确认选择', onclick: () => {
          selectedResume = resumes.find((resume) => resume.id === choice) || selectedResume;
          handle.close(); renderConfig();
        } }))
    });
  }
  async function startRewrite() {
    if (busy) return;
    busy = true; renderConfig();
    try {
      const response = await api.post('/api/v1/resumes/rewrite/drafts', {
        resume_id: selectedResume.id, application_id: selectedApp.id, requirements
      }, { timeoutMs: 150000 });
      draft = response.data;
      const url = new URL(location.href); url.searchParams.set('draft', draft.id); history.replaceState({}, '', url);
      renderProgress();
      pollDraft();
    } catch (error) {
      toast('改写失败：' + errorText(error), 'err');
    } finally {
      busy = false;
      if (!draft) renderConfig();
    }
  }
  function renderProgress() {
    clear(root);
    root.append(tabs(), h('div', { class: 'tn-ai-section-head' },
      h('div', {}, h('h2', { text: draft?.status === 'failed' ? '改写未完成' : '正在定向改写' }),
        h('p', { class: 'tn-small tn-muted', text: `${draft?.application?.company_name || selectedApp?.company_name || ''} · ${draft?.application?.job_title || selectedApp?.job_title || ''} · ${draft?.source_resume?.filename || selectedResume?.filename || ''}` }))));
    const percent = Math.max(0, Math.min(100, Number(draft?.progress_percent ?? 15)));
    const failed = draft?.status === 'failed';
    const card = h('section', { class: `tn-rewrite-progress-card${failed ? ' failed' : ''}`, 'data-test': 'rewrite-progress' },
      h('div', { class: 'tn-rewrite-progress-head' },
        h('strong', { text: failed ? '生成失败' : 'AI 正在处理简历' }),
        h('span', { class: 'tn-rewrite-progress-percent', 'data-test': 'rewrite-progress-percent', text: `${percent}%` })),
      h('div', { class: 'tn-rewrite-progress-track' }, h('div', { class: 'tn-rewrite-progress-fill', style: { width: `${percent}%` } })),
      h('div', { class: 'tn-small tn-muted', 'data-test': 'rewrite-progress-label', text: failed ? (draft.error_message || draft.progress_label || '模型暂时不可用') : (draft?.progress_label || '正在读取目标岗位完整 JD 与原简历…') }),
      failed ? h('div', { class: 'tn-action-row' }, h('button', { class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', 'data-test': 'rewrite-retry', text: '重新生成', onclick: () => { draft = null; startRewrite(); } })) : null);
    root.append(card);
  }
  async function pollDraft() {
    if (!draft?.id) return;
    clearTimeout(pollTimer);
    try {
      const response = await api.get(`/api/v1/resumes/rewrite/drafts/${encodeURIComponent(draft.id)}`);
      if (!active()) return;
      draft = response.data;
      if (draft.status === 'failed') { busy = false; renderProgress(); return; }
      if (Number(draft.progress_percent ?? 100) >= 100 && Array.isArray(draft.blocks) && draft.blocks.length) {
        busy = false;
        renderDraft();
        requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
        return;
      }
      renderProgress();
      pollTimer = setTimeout(pollDraft, 800);
    } catch (error) {
      busy = false;
      draft = { ...(draft || {}), status: 'failed', error_message: errorText(error) };
      renderProgress();
    }
  }

  async function persistDraft() {
    if (!draft) return;
    clearTimeout(saveTimer);
    const response = await api.patch(`/api/v1/resumes/rewrite/drafts/${encodeURIComponent(draft.id)}`, { blocks: draft.blocks, proposed_name: draft.proposed_name });
    draft = response.data;
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persistDraft().catch((error) => toast('草稿保存失败：' + errorText(error), 'err'));
    }, 600);
  }
  function renderDraft() {
    clear(root);
    const app = draft.application || selectedApp;
    const source = draft.source_resume || selectedResume;
    const header = h('div', { class: 'tn-rewrite-draft-head' },
      h('div', {}, h('h2', { text: '左右对照审阅' }),
        h('p', { class: 'tn-small tn-muted', text: `${app?.company_name || ''} · ${app?.job_title || ''} · 原简历 ${source?.filename || ''}` })),
      h('div', { class: 'tn-action-row' }, h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '返回配置', onclick: () => { draft = null; renderConfig(); } })));
    const jd = draft.jd_analysis || {};
    const jdOverview = h('div', { class: 'tn-rewrite-jd-overview', 'data-test': 'rewrite-jd-overview' },
      ...[['硬性要求', jd.hard_requirements], ['核心能力', jd.core_competencies], ['加分项', jd.plus_items], ['其他', jd.other_requirements]]
        .map(([label, values]) => h('span', { class: 'tn-rewrite-jd-chip', title: Array.isArray(values) ? values.join('、') : '', text: `${label}${Array.isArray(values) && values.length ? ` ${values.length}` : ''}` })));
    const rows = h('div', { class: 'tn-rewrite-rows' },
      h('div', { class: 'tn-rewrite-row tn-rewrite-row-head' }, h('h3', { text: '原简历' }), h('h3', { text: 'AI 改写稿（点击编辑）' })));
    function diffNodes(original, rewritten) {
      if (!rewritten || rewritten === original) return [document.createTextNode(original)];
      let start = 0;
      while (start < original.length && start < rewritten.length && original[start] === rewritten[start]) start += 1;
      let end = 0;
      while (end < original.length - start && end < rewritten.length - start
        && original[original.length - 1 - end] === rewritten[rewritten.length - 1 - end]) end += 1;
      const prefix = original.slice(0, start);
      const suffix = original.slice(original.length - end);
      const changed = rewritten.slice(start, rewritten.length - end);
      return [
        ...(prefix ? [document.createTextNode(prefix)] : []),
        h('mark', { class: 'tn-rewrite-diff-mark', text: changed }),
        ...(suffix ? [document.createTextNode(suffix)] : [])
      ];
    }
    for (const block of draft.blocks) {
      const heading = block.kind === 'heading';
      const left = h('div', { class: 'tn-rewrite-cell original' },
        h(heading ? 'h4' : 'p', { class: 'tn-rewrite-original-block', text: block.original_text }));
      const editable = h(heading ? 'h4' : 'div', {
        class: `tn-rewrite-block ${block.alignment_type}`, contenteditable: 'true', spellcheck: 'false',
        'data-test': 'rewrite-block', 'data-block-id': block.block_id,
        title: [block.reason, block.jd_evidence ? `JD：${block.jd_evidence}` : ''].filter(Boolean).join('\n')
      });
      if (block.alignment_type === 'unchanged' || block.rewritten_text === block.original_text) editable.textContent = block.original_text;
      else editable.append(...diffNodes(block.original_text, block.rewritten_text || block.original_text));
      const showBadge = !heading && block.alignment_type !== 'unchanged';
      const badge = showBadge ? h('span', {
        class: `tn-rewrite-inline-badge ${block.alignment_type === 'needs_user_fact' ? 'is-needs' : block.alignment_type === 'unsupported_blocked' ? 'is-blocked' : 'is-optimized'}`,
        'data-test': 'rewrite-inline-badge',
        text: ALIGN_LABEL[block.alignment_type] || block.alignment_type
      }) : null;
      editable.addEventListener('focus', () => {
        if (badge) badge.hidden = true;
        if (editable.dataset.plain === '1') return;
        editable.textContent = block.rewritten_text || block.original_text;
        editable.dataset.plain = '1';
      });
      editable.addEventListener('blur', () => { if (badge) badge.hidden = false; });
      editable.addEventListener('input', () => { block.rewritten_text = editable.innerText; editable.dataset.plain = '1'; scheduleSave(); });
      const annotation = h('div', { class: 'tn-rewrite-annotation' },
        block.reason ? h('span', { class: 'tn-rewrite-reason', title: block.reason, text: block.reason }) : null,
        block.jd_evidence ? h('span', { class: 'tn-rewrite-jd-evidence', title: block.jd_evidence, text: `JD：${block.jd_evidence}` }) : null,
        block.alignment_type !== 'unchanged' && block.rewritten_text !== block.original_text ? h('button', { class: 'tn-rewrite-restore', type: 'button', text: '还原原句', onclick: () => { block.rewritten_text = block.original_text; block.alignment_type = 'unchanged'; renderDraft(); } }) : null);
      rows.append(h('div', { class: 'tn-rewrite-row' }, left, h('div', { class: 'tn-rewrite-cell rewritten' },
        h('div', { class: `tn-rewrite-text-line ${block.alignment_type}` }, editable, badge), annotation)));
    }
    const needs = Array.isArray(draft.report?.needs_user_fact) ? draft.report.needs_user_fact : [];
    const missing = draft.blocks.filter((block) => block.alignment_type === 'needs_user_fact').map((block) => ({ block_id: block.block_id, prompt: block.reason }));
    const report = draft.report || {};
    const reportBox = h('details', { class: 'tn-rewrite-report', 'data-test': 'rewrite-report' },
      h('summary', { text: `改写报告 · 已优化 ${report.optimized_count || 0} 段 · 待补 ${report.needs_user_fact_count || 0} 项 · 拦截 ${report.blocked_count || 0} 项` }),
      h('div', { class: 'tn-small tn-muted', text: report.gaps?.length ? `能力差距：${report.gaps.join('；')}` : '暂无额外能力差距。' }),
      (missing.length || needs.length) ? h('div', { class: 'tn-rewrite-needs', 'data-test': 'rewrite-needs-facts' },
        h('strong', { text: '需要你补充的真实事实' }),
        ...missing.map((item) => h('div', { class: 'tn-small tn-muted', text: `${item.block_id}：${item.prompt || '请补充真实指标或职责'}` }))) : null);
    const name = h('input', { class: 'tn-input', 'data-test': 'rewrite-name', value: draft.proposed_name || '' });
    name.addEventListener('input', () => { draft.proposed_name = name.value; scheduleSave(); });
    const setCurrent = h('input', { type: 'checkbox' });
    const confirmButton = h('button', { class: 'tn-btn tn-btn-primary', type: 'button', 'data-test': 'rewrite-confirm', text: '确认并生成 Word', onclick: async () => {
      confirmButton.disabled = true;
      try {
        await persistDraft();
        const response = await api.post(`/api/v1/resumes/rewrite/drafts/${encodeURIComponent(draft.id)}/confirm`, {
          name: name.value.trim() || draft.proposed_name, set_current: setCurrent.checked
        }, { idempotencyKey: idemKey('rewrite-confirm'), timeoutMs: 60000 });
        const created = response.data?.resume;
        toast(setCurrent.checked ? '已保存新版本并设为当前；请到简历库重新分析后用于匹配' : '已保存新简历版本并生成 Word', setCurrent.checked ? 'info' : 'ok');
        const success = h('div', { class: 'tn-rewrite-success', 'data-test': 'rewrite-success' },
          h('strong', { text: created?.filename || '新版本已保存' }),
          h('a', { class: 'tn-btn tn-btn-primary tn-btn-sm', 'data-test': 'rewrite-download', href: `/api/v1/resumes/${encodeURIComponent(created?.id || '')}/export.docx`, text: '下载 Word' }),
          h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '查看简历库', onclick: () => { location.href = '/?panel=career&section=resume'; } }));
        root.prepend(success);
        success.querySelector('a')?.click();
      } catch (error) {
        confirmButton.disabled = false;
        toast('保存失败：' + errorText(error), 'err');
      }
    } });
    const footer = h('div', { class: 'tn-rewrite-footer' },
      h('div', { class: 'tn-rewrite-name' }, h('span', { class: 'tn-small tn-muted', text: '新简历名称' }), name),
      h('label', { class: 'tn-small' }, setCurrent, document.createTextNode(' 保存后设为当前主简历')),
      confirmButton);
    root.append(tabs(), header, jdOverview, rows, reportBox, footer);
  }
  async function load() {
    try {
      const [resumeRes, profileRes] = await Promise.all([
        api.get('/api/v1/resumes?limit=40'), api.get('/api/v1/profile')
      ]);
      if (!active()) return;
      resumes = resumeRes.data || [];
      profile = profileRes.data?.profile || null;
      selectedResume = resumes.find((resume) => resume.is_current) || resumes[0] || null;
      if (applicationId) {
        try { selectedApp = (await api.get(`/api/v1/applications/${encodeURIComponent(applicationId)}`)).data; } catch { selectedApp = null; }
      }
      if (draftId) {
        try {
          draft = (await api.get(`/api/v1/resumes/rewrite/drafts/${encodeURIComponent(draftId)}`)).data;
          if (active() && draft) {
            if (draft.status === 'ready' && Number(draft.progress_percent ?? 100) >= 100 && draft.blocks?.length) renderDraft();
            else { renderProgress(); pollDraft(); }
            return;
          }
        } catch { /* fall back to config */ }
      }
      if (!draftId) {
        try {
          const activeDrafts = (await api.get('/api/v1/career-ai/rewrite-drafts/active')).data || [];
          const running = activeDrafts.find((item) => item.status === 'ready' && Number(item.progress_percent ?? 100) < 100);
          const recentDone = activeDrafts.find((item) => item.status === 'ready' && Number(item.progress_percent ?? 100) >= 100
            && Date.now() - Date.parse(item.updated_at || 0) < 120000);
          const recovered = running || recentDone;
          if (active() && recovered) {
            draft = (await api.get(`/api/v1/resumes/rewrite/drafts/${encodeURIComponent(recovered.id)}`)).data;
            if (draft.status === 'ready' && Number(draft.progress_percent ?? 100) >= 100 && draft.blocks?.length) renderDraft();
            else { renderProgress(); pollDraft(); }
            return;
          }
        } catch { /* active recovery is best effort */ }
      }
      renderConfig();
    } catch (error) {
      clear(root); root.append(tabs(), h('div', { class: 'tn-inline-msg err', text: '简历改写工作台加载失败：' + errorText(error) }));
    }
  }
  await load();
  return { refresh: load };
}
