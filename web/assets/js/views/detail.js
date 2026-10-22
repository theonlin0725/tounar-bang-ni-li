/* 记录详情抽屉：核心字段、来源与证据、状态时间线、允许动作（确认回看/纠错/归档）。
   allowed_actions 以服务端为准；纠错必须带原因与 expected_version；409/D05/D12 如实解释。 */

import { api, ApiError, errorText } from '../api.js';
import { isStale } from '../app.js';
import {
  h, clear, toast, confirmDialog, statusChip, fmtDateTime, fmtDate, daysText,
  idemKey, extLink, STATUS_LABELS, STATUS_ORDER
} from '../util.js';

const SOURCE_LABELS = { plugin: '插件采集', mail: '招聘邮件', manual: '用户确认' };
const PRECISION_LABELS = { exact: '精确时间', date: '日期级记录', unknown: '时间未知' };

export function openDetail(id, { gen, onChanged } = {}) {
  const layer = document.getElementById('tn-drawer-layer');
  clear(layer);
  layer.hidden = false;

  let current = null;
  let busy = false;
  let inlineForm = null; // 'correct' | 'archive' | null
  let closed = false;

  const headEl = h('div', { class: 'tn-drawer-head' });
  const bodyEl = h('div', { class: 'tn-drawer-body' });
  const footEl = h('div', { class: 'tn-drawer-head', style: { borderBottom: 'none', borderTop: '1px solid var(--line)' } });
  const drawer = h('div', { class: 'tn-drawer', role: 'dialog', 'aria-modal': 'true', 'data-test': 'detail-drawer' },
    headEl, bodyEl, footEl);
  layer.append(h('div', { class: 'tn-drawer-mask', onclick: close }), drawer);
  document.addEventListener('keydown', onKey);
  function onKey(e) { if (e.key === 'Escape') close(); }
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    layer.hidden = true;
    clear(layer);
  }

  async function load() {
    try {
      const res = await api.get(`/api/v1/applications/${encodeURIComponent(id)}`);
      if (isStale(gen) || closed) return;
      current = res.data;
      render();
    } catch (err) {
      if (isStale(gen) || closed) return;
      clear(bodyEl);
      bodyEl.append(h('div', { class: 'tn-banner err' }, h('div', { class: 'tn-banner-body', text: errorText(err) })));
    }
  }

  function render() {
    const app = current;
    clear(headEl);
    headEl.append(
      h('div', {},
        h('h2', { 'data-test': 'detail-company', text: app.company_name || '—' }),
        h('div', { class: 'tn-job-title', text: app.job_title || '—' }),
        h('div', { style: { marginTop: '6px' } }, statusChip(app.status))
      ),
      h('button', { class: 'tn-btn tn-btn-sm tn-drawer-close', type: 'button', text: '关闭', onclick: close })
    );

    clear(bodyEl);
    if (app.archived_at) {
      bodyEl.append(h('div', { class: 'tn-banner info' }, h('div', { class: 'tn-banner-body',
        text: `该记录已于 ${fmtDateTime(app.archived_at)} 归档（原因：${app.archive_reason || '未填写'}）。归档不等于拒绝；归档后「累计投递」可能不变。` })));
    }

    /* 核心字段 */
    const facts = h('div', { class: 'tn-facts' });
    const fact = (label, value, extra) => facts.append(h('div', { class: 'tn-fact' },
      h('div', { class: 'tn-fact-label', text: label }),
      h('div', { class: 'tn-fact-value' }, value ?? '—', extra || null)
    ));
    fact('投递状态', STATUS_LABELS[app.status] || app.status,
      app.round_label || app.interview_round ? h('span', { class: 'tn-round', text: `· ${app.round_label || `${app.interview_round} 面`}` }) : null);
    fact('投递时间', app.applied_at ? h('span', { text: fmtDateTime(app.applied_at) }) : '投递时间待补',
      h('span', { class: 'tn-flag tn-flag-precision', text: PRECISION_LABELS[app.applied_at_precision] || '精度未知' }));
    fact('已投天数（上海口径）', daysText(app.days_since_applied));
    fact('投递渠道', app.channel || '未知');
    fact('招聘批次 / 城市', [app.recruitment_batch, app.location].filter(Boolean).join(' · ') || '—');
    fact('最近有效进展', fmtDateTime(app.last_progress_at));
    fact('官网最近采集', app.last_site_observed_at ? fmtDateTime(app.last_site_observed_at) : '尚无（官网仅在你访问时采集）');
    fact('最近人工确认', app.last_reviewed_at ? fmtDateTime(app.last_reviewed_at) : '尚未确认过');
    if (app.interview_scheduled_at) fact('预约面试时间', fmtDateTime(app.interview_scheduled_at),
      !app.last_interview_completed_at ? h('span', { class: 'tn-flag tn-flag-precision', text: '完成时间待确认' }) : null);
    if (app.last_interview_completed_at) fact('最近面试完成', fmtDateTime(app.last_interview_completed_at),
      h('span', { class: 'tn-round', text: `· 已面试 ${app.days_since_interview ?? '—'} 天` }));
    if (app.deadline_at) fact('截止时间', fmtDate(app.deadline_at) + (app.deadline_precision === 'date' ? '（日期级）' : ''));
    bodyEl.append(section('核心字段', facts));

    /* JD 摘要 */
    bodyEl.append(section('JD 摘要', app.jd_summary
      ? h('div', { class: 'tn-evidence', text: app.jd_summary })
      : h('div', { class: 'tn-link-disabled', text: '摘要待补充（纯文本，不渲染网页 HTML）' })));

    /* 链接 */
    const links = h('div', { class: 'tn-links-row' });
    if (app.job_url) links.append(extLink(app.job_url, '查看岗位'));
    else links.append(h('span', { class: 'tn-link-disabled', text: '岗位链接缺失（可在纠错中补充）' }));
    if (app.primary_status_url) {
      links.append(h('span', {}, extLink(app.primary_status_url, '查看状态'),
        h('span', { class: 'tn-scope-note', text: app.primary_status_url_scope === 'application' ? '（申请状态页，需登录官网）' : '（回退到岗位页）' })));
    } else {
      links.append(h('span', { class: 'tn-link-disabled', text: '无查看状态链接' }));
    }
    bodyEl.append(section('链接', links));

    /* 来源与证据 */
    const methods = (app.source_methods || []).map((m) => SOURCE_LABELS[m] || m);
    const sourcesBox = h('div', {});
    sourcesBox.append(h('div', { class: 'tn-kv' }, h('div', { class: 'tn-kv-item' },
      h('span', { class: 'tn-kv-key', text: '来源方式' }),
      h('span', { text: methods.length ? methods.join(' / ') : '未知' }))));
    if (app.field_sources && app.field_sources.length) {
      const list = h('div', { class: 'tn-kv', style: { marginTop: '6px' } });
      for (const f of app.field_sources) {
        list.append(h('div', { class: 'tn-kv-item' },
          h('span', { class: 'tn-kv-key', text: f.field }),
          h('span', { text: `${SOURCE_LABELS[f.source_method] || f.source_method} · ${fmtDateTime(f.updated_at)}` })));
      }
      sourcesBox.append(h('details', {}, h('summary', { class: 'tn-small tn-muted', text: `字段来源明细（${app.field_sources.length} 项）` }), list));
    }
    bodyEl.append(section('来源与证据（最短证据）', sourcesBox));

    /* 待确认关联 */
    if (app.open_reviews && app.open_reviews.filter((r) => r.status === 'open').length) {
      const open = app.open_reviews.filter((r) => r.status === 'open');
      bodyEl.append(section('相关待确认项', h('div', {},
        h('div', { class: 'tn-warn-text tn-small', text: `该记录有 ${open.length} 个待确认线索（疑似提交 / 字段冲突 / 终态候选）。` }),
        h('div', { class: 'tn-small tn-muted', text: '请到「待确认」入口处理；本抽屉不会自动覆盖正式值。' })
      )));
    }

    /* 时间线 */
    const tl = h('ul', { class: 'tn-timeline', 'data-test': 'detail-history' });
    for (const entry of app.history || []) {
      const from = entry.from_status ? (STATUS_LABELS[entry.from_status] || entry.from_status) : '—';
      const to = entry.to_status ? (STATUS_LABELS[entry.to_status] || entry.to_status) : '—';
      const fields = Object.keys(entry.changed_fields || {});
      tl.append(h('li', {},
        h('div', { class: 'tn-h-time', text: fmtDateTime(entry.changed_at) }),
        h('div', { class: 'tn-h-main', text: entry.from_status === entry.to_status ? `${to}（无状态变化）` : `${from} → ${to}` }),
        h('div', { class: 'tn-h-fields', text: `${SOURCE_LABELS[entry.source_method] || entry.source_method}${entry.reason ? ` · ${entry.reason}` : ''}${fields.length ? ` · 变更字段：${fields.join(', ')}` : ''}` })
      ));
    }
    bodyEl.append(section('状态时间线', app.history && app.history.length ? tl : h('div', { class: 'tn-muted tn-small', text: '暂无历史。' })));

    /* 内联表单容器 */
    const formHost = h('div', {});
    bodyEl.append(formHost);
    if (inlineForm) renderForm(formHost);

    /* 底部动作 */
    clear(footEl);
    const actions = new Set(app.allowed_actions || []);
    const row = h('div', { class: 'tn-action-row', style: { width: '100%' } });
    row.append(h('button', {
      class: 'tn-btn tn-btn-primary', type: 'button', 'data-test': 'detail-review-confirm',
      text: '已确认，状态无变化',
      onclick: async () => {
        const ok = await confirmDialog({
          title: '确认状态无变化？',
          message: `将记录「${app.company_name} · ${app.job_title}」在 ${fmtDateTime(new Date().toISOString())} 的人工确认时间；不会修改投递状态本身。`,
          detail: '只打开官网链接不会自动确认；这里必须由你明确点击。',
          confirmLabel: '已确认，无变化'
        });
        if (!ok) return;
        await act(async () => api.post(`/api/v1/applications/${encodeURIComponent(id)}/reviewed`,
          { expected_version: app.version, context: 'ledger' },
          { idempotencyKey: idemKey('reviewed') }), '已记录确认时间');
      }
    }));
    if (actions.has('correct')) {
      row.append(h('button', { class: 'tn-btn', type: 'button', 'data-test': 'detail-correct', text: '纠错', onclick: () => { inlineForm = inlineForm === 'correct' ? null : 'correct'; renderForm(formHost); } }));
    }
    if (actions.has('archive')) {
      row.append(h('button', {
        class: 'tn-btn', type: 'button', text: inlineForm === 'archive' ? '取消归档操作' : '归档…',
        onclick: () => { inlineForm = inlineForm === 'archive' ? null : 'archive'; renderForm(formHost); }
      }));
    }
    if (actions.has('unarchive')) {
      row.append(h('button', {
        class: 'tn-btn', type: 'button', text: '恢复归档',
        onclick: async () => {
          const ok = await confirmDialog({ title: '恢复归档？', message: '恢复后记录回到「投递明细」，累计投递可能不变。', confirmLabel: '恢复' });
          if (!ok) return;
          await act(async () => api.post(`/api/v1/applications/${encodeURIComponent(id)}/archive`,
            { expected_version: app.version, archive: false }, { idempotencyKey: idemKey('archive') }), '已恢复归档');
        }
      }));
    }
    if (app.status === 'interview' && !app.last_interview_completed_at) {
      row.append(h('button', {
        class: 'tn-btn', type: 'button', 'data-test': 'detail-complete-interview', text: '确认已完成面试…',
        onclick: () => { inlineForm = 'correct'; renderForm(formHost, { quickInterview: true }); }
      }));
    }
    if (actions.has('terminal_locked')) {
      row.append(h('span', { class: 'tn-faint tn-small', style: { alignSelf: 'center' }, text: '终态记录默认锁定；终态纠错规则 D05 未冻结。' }));
    }
    footEl.append(row, h('div', { class: 'tn-faint tn-tiny', style: { width: '100%' }, text: `记录版本 v${app.version} · 台账更新 ≠ 官网实时同步` }));
  }

  function section(title, content) {
    return h('div', { class: 'tn-drawer-section' }, h('h3', { text: title }), content);
  }

  /* 纠错 / 归档内联表单 */
  function renderForm(host, opts = {}) {
    clear(host);
    if (inlineForm === 'correct') return renderCorrectionForm(host, opts);
    if (inlineForm === 'archive') return renderArchiveForm(host);
  }

  function renderArchiveForm(host) {
    const app = current;
    const reasonInput = h('input', { class: 'tn-input', placeholder: '归档原因（必填，≥2 字）', 'data-test': 'archive-reason' });
    const errBox = h('div', {});
    host.append(h('div', { class: 'tn-inline-form', 'data-test': 'archive-form' },
      h('h4', { style: { margin: '0 0 8px' }, text: '归档此记录' }),
      h('p', { class: 'tn-small tn-muted', text: '归档不代表拒绝；服务端仍拒绝旧绑定上传，历史保留。' }),
      reasonInput, errBox,
      h('div', { class: 'tn-action-row', style: { marginTop: '10px' } },
        h('button', {
          class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', text: '确认归档', 'data-test': 'archive-submit',
          onclick: async () => {
            const reason = reasonInput.value.trim();
            if (reason.length < 2) { clear(errBox); errBox.append(h('div', { class: 'tn-inline-msg err', text: '归档原因必填（至少 2 个字）' })); return; }
            await act(async () => api.post(`/api/v1/applications/${encodeURIComponent(id)}/archive`,
              { expected_version: current.version, archive: true, reason },
              { idempotencyKey: idemKey('archive') }), '已归档');
          }
        }),
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '取消', onclick: () => { inlineForm = null; renderForm(host); } })
      )
    ));
  }

  function renderCorrectionForm(host, { quickInterview = false } = {}) {
    const app = current;
    const inputs = {};
    const field = (key, label, node, hint) => h('div', { class: 'tn-field' },
      h('label', { text: label }), node, hint ? h('div', { class: 'tn-hint', text: hint }) : null);

    const statusSel = h('select', { class: 'tn-select' });
    statusSel.append(h('option', { value: '', text: '（不修改）' }));
    for (const s of STATUS_ORDER) statusSel.append(h('option', { value: s, text: STATUS_LABELS[s], disabled: s === 'pending' && app.has_applied }));
    inputs.status = statusSel;
    if (app.status) statusSel.value = '';

    const appliedAt = h('input', { class: 'tn-input', type: 'datetime-local' });
    inputs.applied_at = appliedAt;
    const precisionSel = h('select', { class: 'tn-select' });
    precisionSel.append(h('option', { value: '', text: '（不修改）' }));
    for (const [v, label] of Object.entries(PRECISION_LABELS)) precisionSel.append(h('option', { value: v, text: label }));
    inputs.applied_at_precision = precisionSel;

    const companyInput = h('input', { class: 'tn-input', value: app.company_name || '' });
    inputs.company_name = companyInput;
    const titleInput = h('input', { class: 'tn-input', value: app.job_title || '' });
    inputs.job_title = titleInput;
    const jdInput = h('textarea', { class: 'tn-textarea' });
    jdInput.value = app.jd_summary || '';
    inputs.jd_summary = jdInput;
    const jobUrlInput = h('input', { class: 'tn-input', type: 'url', value: app.job_url || '', placeholder: 'https://…' });
    inputs.job_url = jobUrlInput;
    const statusUrlInput = h('input', { class: 'tn-input', type: 'url', value: app.status_url || '', placeholder: 'https://…' });
    inputs.status_url = statusUrlInput;
    const scopeSel = h('select', { class: 'tn-select' });
    scopeSel.append(h('option', { value: '', text: '（不修改）' }), h('option', { value: 'application', text: '申请状态页' }), h('option', { value: 'job', text: '岗位页' }));
    inputs.status_url_scope = scopeSel;
    const locationInput = h('input', { class: 'tn-input', value: app.location || '' });
    inputs.location = locationInput;
    const batchInput = h('input', { class: 'tn-input', value: app.recruitment_batch || '' });
    inputs.recruitment_batch = batchInput;

    const roundInput = h('input', { class: 'tn-input', type: 'number', min: '1', value: app.interview_round != null ? String(app.interview_round) : '' });
    inputs.interview_round = roundInput;
    const roundLabelInput = h('input', { class: 'tn-input', value: app.round_label || '', placeholder: '如：二面 / HR 面' });
    inputs.round_label = roundLabelInput;
    const completedInput = h('input', { class: 'tn-input', type: 'date' });
    if (quickInterview && !app.last_interview_completed_at) {
      const todayShanghai = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      completedInput.value = todayShanghai;
    }
    inputs.last_interview_completed_at = completedInput;

    const reasonInput = h('textarea', { class: 'tn-textarea', placeholder: '纠错原因（必填，≥2 字）' });
    if (quickInterview) reasonInput.value = '用户确认面试已完成';
    inputs.reason = reasonInput;

    const errBox = h('div', { 'data-test': 'correct-error' });
    const grid = h('div', { class: 'tn-form-grid' },
      field('status', '状态', statusSel, app.has_applied ? '已投事实只能升级；撤销已投事实需 D05 终态纠错评审' : null),
      field('applied_at', '投递时间（精确到分）', appliedAt, '不为今天/收信日编造时间；留空表示不修改'),
      field('applied_at_precision', '投递时间精度', precisionSel),
      field('last_interview_completed_at', '最近面试完成时间（D07）', completedInput, '只有你明确确认才写入；预约已过 ≠ 完成'),
      field('interview_round', '面次（正整数）', roundInput),
      field('round_label', '面次标签', roundLabelInput),
      field('company_name', '公司名', companyInput),
      field('job_title', '岗位名', titleInput),
      field('location', '城市', locationInput),
      field('recruitment_batch', '招聘批次', batchInput),
      field('job_url', '岗位链接', jobUrlInput),
      field('status_url', '状态链接', statusUrlInput),
      field('status_url_scope', '状态链接类型', scopeSel)
    );

    host.append(h('div', { class: 'tn-inline-form', 'data-test': 'correct-form' },
      h('h4', { style: { margin: '0 0 8px' }, text: quickInterview ? '确认已完成面试' : '纠错' }),
      h('p', { class: 'tn-small tn-muted', text: '只提交你实际修改的字段；提交后服务端生成纠错事件与历史记录（不会伪装成自动识别）。' }),
      grid,
      field('jd_summary', 'JD 摘要（纯文本，≤80 字）', jdInput),
      field('reason', '纠错原因', reasonInput),
      errBox,
      h('div', { class: 'tn-action-row', style: { marginTop: '10px' } },
        h('button', {
          class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', 'data-test': 'correct-submit',
          text: '提交纠错',
          onclick: async () => {
            clear(errBox);
            const reason = reasonInput.value.trim();
            if (reason.length < 2) { errBox.append(h('div', { class: 'tn-inline-msg err', text: '纠错原因必填（至少 2 个字）' })); return; }
            const changes = {};
            if (statusSel.value) changes.status = statusSel.value;
            if (appliedAt.value) changes.applied_at = new Date(appliedAt.value).toISOString();
            if (precisionSel.value) changes.applied_at_precision = precisionSel.value;
            if (companyInput.value.trim() !== (app.company_name || '')) changes.company_name = companyInput.value.trim();
            if (titleInput.value.trim() !== (app.job_title || '')) changes.job_title = titleInput.value.trim();
            if (jdInput.value.trim() !== (app.jd_summary || '')) changes.jd_summary = jdInput.value.trim();
            if (jobUrlInput.value.trim() !== (app.job_url || '')) changes.job_url = jobUrlInput.value.trim();
            if (statusUrlInput.value.trim() !== (app.status_url || '')) changes.status_url = statusUrlInput.value.trim();
            if (scopeSel.value) changes.status_url_scope = scopeSel.value;
            if (locationInput.value.trim() !== (app.location || '')) changes.location = locationInput.value.trim();
            if (batchInput.value.trim() !== (app.recruitment_batch || '')) changes.recruitment_batch = batchInput.value.trim();
            if (roundInput.value && Number(roundInput.value) !== app.interview_round) changes.interview_round = Number(roundInput.value);
            if (roundLabelInput.value.trim() !== (app.round_label || '')) changes.round_label = roundLabelInput.value.trim();
            if (completedInput.value) {
              const iso = new Date(`${completedInput.value}T12:00:00+08:00`).toISOString();
              if (iso !== app.last_interview_completed_at) changes.last_interview_completed_at = iso;
            }
            if (!Object.keys(changes).length) { errBox.append(h('div', { class: 'tn-inline-msg err', text: '没有检测到修改的字段' })); return; }
            await act(async () => api.post(`/api/v1/applications/${encodeURIComponent(id)}/corrections`,
              { expected_version: current.version, changes, reason },
              { idempotencyKey: idemKey('correct') }),
            '纠错已提交',
            (err) => {
              if (err instanceof ApiError && err.code === 'D05_NOT_FROZEN') errBox.append(h('div', { class: 'tn-inline-msg err', text: '该记录处于终态：终态纠错 D05 未冻结，不会静默恢复或撤销。' }));
              else if (err instanceof ApiError && err.code === 'D12_NOT_FROZEN') errBox.append(h('div', { class: 'tn-inline-msg err', text: '缺少可信投递时间：D12 未冻结，不会用今天/入库时间代替。' }));
              else if (err instanceof ApiError && err.code === 'APPLIED_FACT_REMOVAL') errBox.append(h('div', { class: 'tn-inline-msg err', text: '不能直接撤销已投事实；如确需，请走终态纠错评审（D05）。' }));
              else if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') errBox.append(h('div', { class: 'tn-inline-msg err', text: '记录已被更新：已重新加载最新版本，请重新决定（不会自动覆盖）。' }));
              else errBox.append(h('div', { class: 'tn-inline-msg err', text: errorText(err) }));
            });
          }
        }),
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '取消', onclick: () => { inlineForm = null; renderForm(host); } })
      )
    ));
  }

  /* 动作包装：忙状态防重复；成功重载详情 + 通知列表 */
  async function act(fn, successText, onError) {
    if (busy) return;
    busy = true;
    try {
      await fn();
      toast(successText, 'ok');
      inlineForm = null;
      await load();
      if (onChanged) onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT' && !onError) {
        toast('记录已被更新，已重新加载最新版本；请重新决定。', 'err');
        await load();
        if (onChanged) onChanged();
      } else if (onError) {
        onError(err);
        if (err instanceof ApiError && (err.code === 'VERSION_CONFLICT' || err.code === 'IDEMPOTENCY_CONFLICT')) { await load(); if (onChanged) onChanged(); }
      } else {
        toast(errorText(err), 'err');
      }
    } finally {
      busy = false;
    }
  }

  load();
}
