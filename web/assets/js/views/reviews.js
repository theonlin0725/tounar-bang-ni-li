/* 待确认队列：证据冲突时才出现的复核项。
   规则：确认/关联前重新 GET 复核详情 + 候选申请最新版本；409 一律重取并请用户重新决定；
   create 预填建议变化；dismiss 二次确认。不做“静默覆盖正式值”。 */

import { api, ApiError, errorText } from '../api.js';
import { isStale } from '../app.js';
import {
  h, clear, toast, confirmDialog, statusChip, fmtDateTime, idemKey,
  STATUS_LABELS, STATUS_ORDER
} from '../util.js';

const KIND_LABELS = {
  application_confirmation: '疑似已投 / 待确证',
  status_conflict: '状态冲突',
  terminal_conflict: '终态冲突',
  terminal_candidate: '终态候选',
  field_missing: '字段缺失',
  suspect_view: '浏览线索',
  ambiguous_match: '匹配待确认',
  suspect_submission: '疑似已提交'
};

const REASON_LABELS = {
  D12_MISSING_FIELDS: '缺少 JD 摘要 / 链接等必要字段（D12 未冻结）',
  D12_MISSING_APPLIED_AT: '缺少可信投递时间（D12 未冻结）',
  HAS_APPLIED_UNCONFIRMED: '需要确证是否已正式申请',
  MULTIPLE_APPLICATION_CANDIDATES: '存在多个候选记录',
  COMPANY_TITLE_ONLY: '仅有公司 + 岗位，需人工判断',
  TERMINAL_REVIEW_REQUIRED: '终态变化需人工确认',
  TERMINAL_LOCKED: '记录已处于终态，自动事件不能覆盖',
  APPLIED_FACT_REMOVAL: '自动事件不能撤销已投事实',
  STATUS_REGRESSION: '后到事件试图回退状态',
  UNKNOWN_STATUS: '无法识别目标状态',
  SUSPECT_SUBMISSION: '页面证据显示可能已提交'
};

const FIELD_LABELS = {
  company_name: '公司', job_title: '岗位', jd_summary: 'JD 摘要', job_url: '岗位链接',
  status_url: '状态链接', status_url_scope: '状态链接类型', status: '状态',
  applied_at: '投递时间', applied_at_precision: '投递时间精度', has_applied: '是否已投',
  location: '城市', recruitment_batch: '招聘批次', channel: '渠道', interview_round: '面次',
  round_label: '面次标签', last_interview_completed_at: '面试完成时间'
};

/* 切到这些状态意味着「已正式申请」，必须带可信投递时间（D12） */
const NEEDS_APPLIED_AT = new Set(['applied', 'assessment', 'interview', 'offer', 'rejected']);

const EVIDENCE_LABELS = {
  source: '来源', site: '来源站点', url: '页面', page_url: '页面', excerpt: '最短证据',
  text: '证据文本', summary: '摘要', observed_at: '观察到', received_at: '收到于',
  occurred_at: '发生于', evidence_level: '证据强度', adapter: '采集器', version: '采集器版本',
  status_text: '页面状态文本', matched_fields: '命中字段'
};

function kindLabel(kind) { return KIND_LABELS[kind] || kind; }
function reasonLabel(reason) { return REASON_LABELS[reason] || reason; }

function valueText(field, value) {
  if (value === null || value === undefined || value === '') return '（空）';
  if (field === 'status') return STATUS_LABELS[value] || value;
  if (field === 'has_applied') return value === true ? '是' : value === false ? '否' : String(value);
  if (field === 'applied_at' || field === 'last_interview_completed_at') return fmtDateTime(value);
  if (field === 'status_url_scope') return value === 'application' ? '申请状态页' : value === 'job' ? '岗位页' : String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export async function renderReviews(container, { gen, onChanged } = {}) {
  const root = h('div', { class: 'tn-reviews', 'data-test': 'reviews-view' });
  container.append(root);
  const headEl = h('div', { class: 'tn-toolbar' },
    h('div', {},
      h('div', { style: { fontWeight: '600' }, text: '待确认' }),
      h('div', { class: 'tn-small tn-muted', text: '只在证据冲突或缺少关键字段时出现；不会自动覆盖你的正式记录。' })
    ),
    h('div', { class: 'tn-toolbar-right' },
      h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '刷新', 'data-test': 'reviews-refresh', onclick: () => load() })
    )
  );
  const listEl = h('div', {});
  const bannerEl = h('div', {});
  root.append(headEl, bannerEl, listEl);

  let items = [];
  let loading = false;
  let error = null;
  let reqSeq = 0;

  async function load() {
    const seq = ++reqSeq;
    loading = true;
    bannerEl.replaceChildren();
    if (!items.length) listEl.replaceChildren(h('div', { class: 'tn-table-card' }, h('div', { class: 'tn-empty' },
      h('p', { class: 'tn-muted', text: '加载中…' }))));
    try {
      const res = await api.get('/api/v1/review-items?status=open&limit=50');
      if (seq !== reqSeq || isStale(gen)) return;
      items = res.data || [];
      error = null;
    } catch (err) {
      if (seq !== reqSeq || isStale(gen)) return;
      error = errorText(err);
    } finally {
      if (seq !== reqSeq || isStale(gen)) return;
      loading = false;
      renderList();
    }
  }

  function renderList() {
    listEl.replaceChildren();
    if (error) {
      bannerEl.replaceChildren(h('div', { class: 'tn-banner err' },
        h('div', { class: 'tn-banner-body', text: `无法加载待确认项：${error}` })));
    }
    if (loading) return;
    if (!items.length) {
      listEl.append(h('div', { class: 'tn-table-card' }, h('div', { class: 'tn-empty' },
        h('h3', { text: '没有待确认项' }),
        h('p', { text: '一切正常：没有证据冲突，也没有因缺字段被挂起的线索。' }),
        h('p', { class: 'tn-small tn-faint', text: '这里只展示尚未处理完的复核项；已处理的历史可在接口中选择全部状态查看。' })
      )));
      return;
    }
    for (const review of items) listEl.append(renderCard(review));
  }

  /* ---------- 单张卡片 ---------- */
  function renderCard(review) {
    const card = h('div', { class: 'tn-review-card', 'data-test': 'review-card', 'data-review-id': review.id });
    const state = { selected: review.candidates?.length === 1 ? review.candidates[0].application_id : null, busy: false, createOpen: false };

    const head = h('div', { class: 'tn-review-head' },
      h('span', { class: 'tn-review-kind', text: kindLabel(review.kind) }),
      h('div', { class: 'tn-grow' },
        h('div', { class: 'tn-review-title', text: review.summary || '（无摘要）' }),
        h('div', { class: 'tn-small tn-muted', text: `${reasonLabel(review.reason_code)} · ${fmtDateTime(review.created_at)} · 复核 v${review.version}` })
      )
    );
    card.append(head);

    /* 最短证据 */
    const evidence = review.evidence && Object.keys(review.evidence).length ? review.evidence : null;
    if (evidence) {
      const box = h('div', { class: 'tn-evidence' });
      let shown = 0;
      for (const [key, value] of Object.entries(evidence)) {
        if (!['string', 'number', 'boolean'].includes(typeof value) && !Array.isArray(value)) continue;
        const label = EVIDENCE_LABELS[key] || key;
        let text = Array.isArray(value) ? value.join('、') : String(value);
        if (text.length > 300) text = `${text.slice(0, 300)}…`;
        box.append(h('div', {}, h('span', { class: 'tn-muted', text: `${label}：` }), h('span', { text })));
        shown += 1;
        if (shown >= 6) break;
      }
      card.append(h('div', { class: 'tn-review-section' }, h('h4', { text: '最短证据' }), box));
    }

    /* 建议变化 */
    const suggested = review.suggested_changes && Object.keys(review.suggested_changes).length ? review.suggested_changes : null;
    if (suggested) {
      const diff = h('div', { class: 'tn-diff' });
      for (const [key, value] of Object.entries(suggested)) {
        diff.append(h('span', { class: 'tn-diff-key', text: FIELD_LABELS[key] || key }),
          h('span', { class: 'tn-diff-new', text: valueText(key, value) }));
      }
      card.append(h('div', { class: 'tn-review-section' }, h('h4', { text: '建议变化（需要你确认后才会写入）' }), diff));
    }

    /* 候选申请 */
    const candidates = review.candidates || [];
    const candidateBox = h('div', {});
    if (!candidates.length) {
      candidateBox.append(h('div', { class: 'tn-small tn-muted', text: '没有匹配到你的既有记录：可用「新建记录」建一条，或忽略该线索。' }));
    } else {
      const list = h('ul', { class: 'tn-candidates', 'data-test': 'review-candidates' });
      const rebuild = () => {
        clear(list);
        for (const c of candidates) {
          const selected = state.selected === c.application_id;
          const li = h('li', { class: selected ? 'selected' : '', 'data-test': 'review-candidate' },
            h('input', {
              type: 'radio', name: `cand-${review.id}`, checked: selected,
              'data-app-id': c.application_id,
              onchange: () => { state.selected = c.application_id; rebuild(); }
            }),
            h('div', {},
              h('div', {}, h('strong', { text: c.company_name || '—' }), ' · ', c.job_title || '—'),
              h('div', { class: 'tn-candidate-meta', text: [
                c.location, c.recruitment_batch,
                STATUS_LABELS[c.status] || c.status,
                c.has_applied ? '已投' : '未投',
                `记录 v${c.application_version}`
              ].filter(Boolean).join(' · ') }),
              c.match_reason ? h('div', { class: 'tn-candidate-meta', text: `匹配原因：${c.match_reason}` }) : null
            )
          );
          li.addEventListener('click', (e) => {
            if (e.target instanceof HTMLInputElement) return;
            state.selected = c.application_id;
            rebuild();
          });
          list.append(li);
        }
      };
      rebuild();
      candidateBox.append(list);
    }
    card.append(h('div', { class: 'tn-review-section' }, h('h4', { text: '候选记录（本人台账）' }), candidateBox));

    /* D12：可选补投递时间 */
    let appliedAtInput = null;
    if (review.kind === 'application_confirmation' || review.reason_code === 'D12_MISSING_APPLIED_AT') {
      appliedAtInput = h('input', { class: 'tn-input', type: 'datetime-local', 'data-test': 'review-applied-at' });
      card.append(h('div', { class: 'tn-review-section' },
        h('div', { class: 'tn-field', style: { marginBottom: '0' } },
          h('label', { text: '投递时间（缺可信时间时必填；D12 不会用今天/收信时间代替）' }),
          appliedAtInput,
          h('div', { class: 'tn-hint', text: '只有你确认的精确时间才会写入；留空则若服务端判定缺时间会返回 422。' })
        )
      ));
    }

    /* 错误提示 */
    const errBox = h('div', { 'data-test': 'review-error' });

    /* 动作 */
    const confirmLabel = review.kind === 'terminal_candidate' ? '确认终态' :
      review.kind === 'application_confirmation' ? '确认已投 / 应用建议' : '确认并应用建议';
    const confirmBtn = h('button', {
      class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', 'data-test': 'review-confirm',
      text: confirmLabel, disabled: candidates.length === 0,
      onclick: () => resolveExisting('confirm', review, state, errBox)
    });
    const linkBtn = h('button', {
      class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'review-link', text: '关联所选记录',
      disabled: candidates.length === 0,
      onclick: () => resolveExisting('link', review, state, errBox)
    });
    const createBtn = h('button', {
      class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'review-create',
      text: state.createOpen ? '收起新建' : '新建记录',
      onclick: () => { state.createOpen = !state.createOpen; renderCreateForm(); createBtn.textContent = state.createOpen ? '收起新建' : '新建记录'; }
    });
    /* 直接切换状态：选一个状态就把这条线索落到对应进度，不用先确认再改 */
    const switchSel = h('select', { class: 'tn-select', 'data-test': 'review-status-select' });
    switchSel.append(h('option', { value: '', text: '选择目标状态…' }));
    for (const s of STATUS_ORDER) switchSel.append(h('option', { value: s, text: STATUS_LABELS[s] }));
    const switchAt = h('input', { class: 'tn-input', type: 'datetime-local', 'data-test': 'review-switch-at' });
    const switchAtWrap = h('div', { class: 'tn-field', style: { display: 'none', marginBottom: '0' } },
      h('label', { text: '投递时间（切到已投及之后的状态必填；不会用今天代替）' }), switchAt);
    const switchBtn = h('button', {
      class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'review-switch-status', text: '切换状态',
      disabled: candidates.length === 0,
      onclick: () => doSwitchStatus()
    });
    switchSel.addEventListener('change', () => {
      switchAtWrap.style.display = NEEDS_APPLIED_AT.has(switchSel.value) ? '' : 'none';
    });
    const switchErrBox = h('div', {});
    card.append(h('div', { class: 'tn-review-section' },
      h('h4', { text: '直接切换状态' }),
      h('div', { class: 'tn-action-row' }, switchSel, switchBtn),
      switchAtWrap,
      switchErrBox,
      h('div', { class: 'tn-small tn-faint', style: { marginTop: '6px' },
        text: '在上面选一条候选记录，再选目标状态即可一步切过去。切到「已投 / 笔试 / 面试 / 已 offer / 已拒绝」需要可信投递时间；切到终态受 D05 约束。' })
    ));

    async function doSwitchStatus() {
      clear(switchErrBox);
      const target = switchSel.value;
      if (!target) { showErr(switchErrBox, '请先选择要切换到的状态'); return; }
      if (!state.selected) { showErr(switchErrBox, '请先在「候选记录」里选一条'); return; }
      if (NEEDS_APPLIED_AT.has(target) && !switchAt.value) {
        switchAtWrap.style.display = '';
        switchAt.focus();
        showErr(switchErrBox, `切到「${STATUS_LABELS[target]}」需要可信投递时间；D12 未冻结，不会用今天代替。`);
        return;
      }
      const changes = { status: target };
      if (switchAt.value) changes.applied_at = new Date(`${switchAt.value}:00+08:00`).toISOString();
      if (reasonForSwitch()) changes.reason = reasonForSwitch();
      await resolveExisting('confirm', review, state, switchErrBox, {
        changes,
        requireAppliedAt: NEEDS_APPLIED_AT.has(target),
        successText: `已切换为「${STATUS_LABELS[target]}」`,
        buttons: [confirmBtn, linkBtn, createBtn, dismissBtn, switchBtn]
      });
    }

    function reasonForSwitch() {
      return `待确认直接切换为 ${STATUS_LABELS[switchSel.value] || switchSel.value}`;
    }

    const dismissBtn = h('button', {
      class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', 'data-test': 'review-dismiss', text: '忽略',
      onclick: async () => {
        const ok = await confirmDialog({
          title: '忽略这条线索？',
          message: '忽略后它不再进入待确认队列，也不会创建或修改任何申请记录。',
          detail: '仅当该线索确属误报时使用；忽略不可在界面撤销。',
          confirmLabel: '忽略'
        });
        if (!ok) return;
        await postResolve(review, { action: 'dismiss', reason: '用户忽略' }, errBox, () => {});
      }
    });
    card.append(h('div', { class: 'tn-review-section' },
      h('div', { class: 'tn-action-row' }, confirmBtn, linkBtn, createBtn, dismissBtn),
      h('div', { class: 'tn-small tn-faint', style: { marginTop: '6px' }, text: '确认/关联前会重新读取复核项与候选记录的最新版本；如已被更新，需要你重新决定。' }),
      errBox
    ));

    const createHost = h('div', {});
    card.append(createHost);

    function renderCreateForm() {
      clear(createHost);
      if (!state.createOpen) return;
      const pre = review.suggested_changes || {};
      const inputs = {};
      const mk = (key, label, type = 'text', placeholder = '') => {
        const input = h('input', { class: 'tn-input', type, placeholder });
        inputs[key] = input;
        return h('div', { class: 'tn-field' }, h('label', { text: label }), input);
      };
      const company = mk('company_name', '公司名 *');
      company.querySelector('input').value = pre.company_name || '';
      const title = mk('job_title', '岗位名 *');
      title.querySelector('input').value = pre.job_title || '';
      const jd = h('textarea', { class: 'tn-textarea' });
      if (pre.jd_summary) jd.value = pre.jd_summary;
      const jobUrl = mk('job_url', '岗位链接', 'url', 'https://…');
      jobUrl.querySelector('input').value = pre.job_url || '';
      const location = mk('location', '城市');
      location.querySelector('input').value = pre.location || '';
      const batch = mk('recruitment_batch', '招聘批次');
      batch.querySelector('input').value = pre.recruitment_batch || '';
      const appliedAt = mk('applied_at', '投递时间（D12：已投必填）', 'datetime-local');
      if (pre.applied_at) {
        const iso = new Date(pre.applied_at);
        if (!Number.isNaN(iso.getTime())) appliedAt.querySelector('input').value = toShanghaiInput(iso);
      }
      const statusSel = h('select', { class: 'tn-select' });
      statusSel.append(h('option', { value: '', text: '（默认按已投事实）' }));
      for (const s of STATUS_ORDER) statusSel.append(h('option', { value: s, text: STATUS_LABELS[s] }));
      if (pre.status) statusSel.value = pre.status;
      const reasonInput = h('textarea', { class: 'tn-textarea' });
      reasonInput.value = '按复核线索新建记录';

      createHost.append(h('div', { class: 'tn-inline-form', 'data-test': 'review-create-form' },
        h('h4', { style: { margin: '0 0 8px' }, text: '新建记录（不会强行新增：若发现候选会提示改为关联）' }),
        h('div', { class: 'tn-form-grid' }, company, title, location, batch, jobUrl, appliedAt,
          h('div', { class: 'tn-field' }, h('label', { text: '状态' }), statusSel),
          h('div', { class: 'tn-field' }, h('label', { text: '纠错/新建原因' }), reasonInput)
        ),
        h('div', { class: 'tn-field', style: { marginTop: '10px' } }, h('label', { text: 'JD 摘要（纯文本≤80字）' }), jd),
        h('div', { class: 'tn-action-row' },
          h('button', {
            class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', 'data-test': 'review-create-submit', text: '创建并处理',
            onclick: async (e) => {
              const btn = e.currentTarget;
              const changes = {};
              const companyName = inputs.company_name.value.trim();
              const jobTitle = inputs.job_title.value.trim();
              if (!companyName || !jobTitle) { showErr(errBox, '公司名和岗位名为必填'); return; }
              changes.company_name = companyName;
              changes.job_title = jobTitle;
              if (jd.value.trim()) changes.jd_summary = jd.value.trim();
              if (inputs.job_url.value.trim()) changes.job_url = inputs.job_url.value.trim();
              if (inputs.location.value.trim()) changes.location = inputs.location.value.trim();
              if (inputs.recruitment_batch.value.trim()) changes.recruitment_batch = inputs.recruitment_batch.value.trim();
              if (inputs.applied_at.value) changes.applied_at = new Date(`${inputs.applied_at.value}:00+08:00`).toISOString();
              if (statusSel.value) changes.status = statusSel.value;
              if (reasonInput.value.trim()) changes.reason = reasonInput.value.trim();
              btn.disabled = true;
              try {
                await api.post(`/api/v1/review-items/${encodeURIComponent(review.id)}/resolve`, {
                  expected_version: review.version,
                  action: 'create',
                  changes
                }, { idempotencyKey: idemKey('review-create') });
                toast('已按复核线索创建记录', 'ok');
                await refreshAfterChange();
              } catch (err) {
                handleResolveError(err, errBox, review);
              } finally {
                btn.disabled = false;
              }
            }
          }),
          h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '取消', onclick: () => { state.createOpen = false; clear(createHost); createBtn.textContent = '新建记录'; } })
        ),
        h('div', { class: 'tn-small tn-faint', style: { marginTop: '6px' }, text: '若服务端发现新的候选记录（409），不会强行新增；请改用「关联所选记录」。' })
      ));
    }

    /* 确认 / 关联：先取最新复核 + 最新申请版本 */
    async function resolveExisting(action, reviewSnapshot, stateSnapshot, errBoxEl, extra = {}) {
      clear(errBoxEl);
      const targetId = stateSnapshot.selected;
      if (!targetId) { showErr(errBoxEl, '请先选择一条候选记录'); return; }
      if (extra.requireAppliedAt && !(extra.changes || {}).applied_at) {
        showErr(errBoxEl, '该目标状态需要可信投递时间；D12 未冻结，不会用今天代替。');
        return;
      }
      const buttons = extra.buttons || [confirmBtn, linkBtn, createBtn, dismissBtn];
      buttons.forEach((b) => { b.disabled = true; });
      try {
        const detailRes = await api.get(`/api/v1/review-items/${encodeURIComponent(review.id)}`);
        const fresh = detailRes.data;
        if (fresh.status !== 'open') {
          toast('该复核项已处理，已刷新列表', 'ok');
          await refreshAfterChange();
          return;
        }
        const appRes = await api.get(`/api/v1/applications/${encodeURIComponent(targetId)}`);
        const freshApp = appRes.data;
        if (!(fresh.candidates || []).some((c) => c.application_id === targetId)) {
          showErr(errBoxEl, '候选列表已变化：所选记录不在最新候选中，请重新选择。');
          items = items.map((it) => it.id === review.id ? { ...it, version: fresh.version, candidates: fresh.candidates, suggested_changes: fresh.suggested_changes, evidence: fresh.evidence } : it);
          renderList();
          return;
        }
        const body = {
          expected_version: fresh.version,
          action,
          application_id: targetId,
          expected_application_version: freshApp.version
        };
        const changes = { ...(extra.changes || {}) };
        if (appliedAtInput && appliedAtInput.value) {
          changes.applied_at = new Date(`${appliedAtInput.value}:00+08:00`).toISOString();
        }
        if (Object.keys(changes).length) body.changes = changes;
        const res = await api.post(`/api/v1/review-items/${encodeURIComponent(review.id)}/resolve`, body,
          { idempotencyKey: idemKey(`review-${action}`) });
        if (res.data?.already_resolved) toast('该复核项已被处理', 'ok');
        else if (extra.successText) toast(extra.successText, 'ok');
        else toast(action === 'confirm' ? '已确认并应用建议' : '已关联到所选记录', 'ok');
        await refreshAfterChange();
      } catch (err) {
        handleResolveError(err, errBoxEl, review);
        buttons.forEach((b) => { b.disabled = false; });
      }
    }

    async function postResolve(reviewSnapshot, body, errBoxEl, done) {
      clear(errBoxEl);
      try {
        await api.post(`/api/v1/review-items/${encodeURIComponent(reviewSnapshot.id)}/resolve`,
          { expected_version: reviewSnapshot.version, ...body },
          { idempotencyKey: idemKey('review-dismiss') });
        toast('已忽略该线索', 'ok');
        await refreshAfterChange();
        if (done) done();
      } catch (err) {
        handleResolveError(err, errBoxEl, reviewSnapshot);
      }
    }

    return card;
  }

  function showErr(box, text) {
    const node = h('div', { class: 'tn-inline-msg err', text });
    box.append(node);
  }

  function handleResolveError(err, box, reviewSnapshot) {
    clear(box);
    if (!(err instanceof ApiError)) { showErr(box, errorText(err)); return; }
    if (err.status === 409 && err.code === 'VERSION_CONFLICT' && err.details?.candidates?.length) {
      const message = '服务端发现新的候选记录，不能强行新增。请从候选中选择并改用「关联所选记录」。';
      showErr(box, message);
      toast(message, 'err');
      const wrap = h('div', { class: 'tn-candidates', style: { marginTop: '6px' } });
      for (const c of err.details.candidates) {
        wrap.append(h('div', { class: 'tn-small', text: `候选：${c.application_id}（${c.reason}）` }));
      }
      box.append(wrap);
      load();
      return;
    }
    switch (err.code) {
      case 'VERSION_CONFLICT': {
        const message = '复核项或候选记录已被更新；已重新加载，请重新决定（不会自动覆盖）。';
        showErr(box, message);
        toast(message, 'err');
        if (reviewSnapshot) load();
        break;
      }
      case 'D12_NOT_FROZEN':
        showErr(box, '缺少可信投递时间：D12 未冻结，不会用今天/收信时间代替。请填写投递时间或改用补录。');
        break;
      case 'D05_NOT_FROZEN':
        showErr(box, '该记录处于终态：终态纠错 D05 未冻结，不能静默恢复或撤销终态。');
        break;
      case 'APPLIED_FACT_REMOVAL':
        showErr(box, '不能通过复核撤销已投事实；如确需，请走终态纠错评审（D05）。');
        break;
      case 'CONFIRMATION_INVALID':
      case 'CONFIRMATION_CONSUMED':
      case 'CONFIRMATION_EXPIRED':
        showErr(box, '确认资格无效或已使用，请重新发起。');
        break;
      default:
        showErr(box, errorText(err));
    }
  }

  async function refreshAfterChange() {
    try { if (onChanged) onChanged(); } catch { /* 列表刷新失败不影响本视图 */ }
    await load();
  }

  load();
}

function toShanghaiInput(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}
