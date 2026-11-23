/* v1.1.1 简历库「简历改写」工作台：岗位/简历/画像/JD 配置 → 左右对照编辑 → 新版本 + Word。 */
import { api, errorText } from '../api.js';
import { isStale } from '../app.js?v=20261120-1';
import { h, clear, toast, openModal, idemKey, debounce } from '../util.js';
import { openJobPicker } from './job-picker.js';

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
    const textarea = h('textarea', { class: 'tn-input', rows: '3', 'data-test': 'rewrite-requirements', placeholder: '可选：重点突出数据分析、AI 项目或某个业务成果' });
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
      renderDraft();
    } catch (error) {
      toast('改写失败：' + errorText(error), 'err');
    } finally {
      busy = false;
      if (!draft) renderConfig();
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
    const columns = h('div', { class: 'tn-rewrite-columns' });
    const left = h('div', { class: 'tn-rewrite-column original' }, h('h3', { text: '原简历' }));
    const right = h('div', { class: 'tn-rewrite-column rewritten' }, h('h3', { text: 'AI 改写稿（点击编辑）' }));
    for (const block of draft.blocks) {
      left.append(h(block.kind === 'heading' ? 'h4' : 'p', { class: 'tn-rewrite-original-block', text: block.original_text }));
      const editable = h(block.kind === 'heading' ? 'h4' : 'div', {
        class: `tn-rewrite-block ${block.alignment_type}`, contenteditable: 'true', spellcheck: 'false',
        'data-test': 'rewrite-block', 'data-block-id': block.block_id,
        title: [block.reason, block.jd_evidence ? `JD：${block.jd_evidence}` : ''].filter(Boolean).join('\n')
      });
      editable.textContent = block.rewritten_text || block.original_text;
      editable.addEventListener('input', () => { block.rewritten_text = editable.innerText; scheduleSave(); });
      const annotation = h('div', { class: 'tn-rewrite-annotation' },
        h('span', { class: `tn-rewrite-align ${block.alignment_type}`, text: ALIGN_LABEL[block.alignment_type] || block.alignment_type }),
        block.reason ? h('span', { text: block.reason }) : null,
        block.alignment_type === 'needs_user_fact' ? h('span', { class: 'tn-small', text: '请只补充真实事实，不会自动编造' }) : null);
      right.append(h('div', { class: 'tn-rewrite-block-wrap' }, editable, annotation));
    }
    columns.append(left, right);
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
    root.append(tabs(), header, columns, reportBox, footer);
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
          if (active() && draft) { renderDraft(); return; }
        } catch { /* fall back to config */ }
      }
      renderConfig();
    } catch (error) {
      clear(root); root.append(tabs(), h('div', { class: 'tn-inline-msg err', text: '简历改写工作台加载失败：' + errorText(error) }));
    }
  }
  await load();
  return { refresh: load };
}
