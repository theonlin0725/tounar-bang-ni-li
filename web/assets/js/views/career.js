/* 简历与 AI：上传/修正简历、简历画像、岗位对比、未投递岗位推荐。
 * 所有数据来自当前账号 API；前端不拼模型请求、不读取其他用户数据。 */
import { api, errorText } from '../api.js';
import { isStale } from '../app.js?v=20261102-1';
import { h, clear, toast, fmtDateTime } from '../util.js';

const MATCH_LABELS = { high: '相对匹配高', medium: '相对匹配中', low: '相对匹配低', insufficient: '资料不足' };
const MATCH_CLASS = { high: 'ok', medium: 'warn', low: 'muted', insufficient: 'muted' };
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

export async function renderCareer(container, { gen, apps = null } = {}) {
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
  let autoCompared = false;
  const active = () => !isStale(gen) && root.isConnected;

  root.append(h('div', { class: 'tn-career-head' },
    h('div', { class: 'tn-grow' },
      h('h1', { text: '简历与 AI 分析' }),
      h('p', { class: 'tn-muted', text: '上传简历 → 结构化画像 → 选择岗位对比 → 推荐未投递岗位。AI 只做相对匹配判断，不改岗位状态。' })),
    h('a', { class: 'tn-btn tn-btn-sm', href: '/', text: '返回台账' })
  ));
  const aiNotice = h('div', { class: 'tn-ai-notice', 'data-test': 'ai-status' });
  const resumeSection = h('section', { class: 'tn-ai-card', 'data-test': 'resume-section' });
  const compareSection = h('section', { class: 'tn-ai-card', 'data-test': 'compare-section' });
  const recommendSection = h('section', { class: 'tn-ai-card', 'data-test': 'recommend-section' });
  root.append(aiNotice, resumeSection, compareSection, recommendSection);

  function setBusy(value) {
    busy = value;
    for (const b of root.querySelectorAll('button')) b.disabled = value;
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
      renderResume();
      renderCompare();
      renderRecommend();
      if (selectedIds.length >= 2 && resume?.status === 'ready' && !autoCompared) {
        autoCompared = true;
        runCompare();
      }
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
