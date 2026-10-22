/* 待确认队列：把「系统拿不准的自动判定」交给用户一句话裁决。
   设计口径（P1 2026-10-22）：
   - 每张卡片第一行必须说清：哪天收到的什么邮件、系统猜的是哪条记录、猜的状态、把握度多少。
   - 三个主按钮任何时候都可点：对（更新台账）/ 不对（自己选记录或新建）/ 忽略。
   - 没有候选记录不再禁用按钮：改为「选一条记录并更新」+ 本人台账搜索。
   - 确认错了 10 秒内可撤销（服务端留 10 分钟安全余量，全程留痕）。
   - 所有面向用户的文案不出现 D05/D12 之类内部编号。 */

import { api, ApiError } from '../api.js';
import { isStale } from '../app.js';
import {
  h, clear, toast, toastAction, confirmDialog, statusChip, fmtDateTime, fmtDate, debounce, idemKey,
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
  suspect_submission: '疑似已提交',
  mail_progress: '招聘邮件'
};

const REASON_LABELS = {
  MAIL_MATCH_UNCONFIRMED: '邮件没对上具体记录',
  MULTIPLE_APPLICATION_CANDIDATES: '有多个候选记录',
  COMPANY_TITLE_ONLY: '只对上公司 + 岗位',
  TERMINAL_REVIEW_REQUIRED: '终态变化需人工确认',
  TERMINAL_LOW_CONFIDENCE: '终态判断把握度不够',
  HAS_APPLIED_UNCONFIRMED: '需要确认是否已正式申请',
  APPLIED_FACT_REMOVAL: '不能自动撤销已投事实',
  STATUS_REGRESSION: '后到的消息在往回退状态',
  UNKNOWN_STATUS: '没看懂这条消息的状态',
  WEAK_SUBMISSION_EVIDENCE: '提交成功证据不足',
  SUSPECT_SUBMISSION: '页面证据显示可能已提交',
  D12_MISSING_APPLIED_AT: '缺少可信投递时间',
  D12_MISSING_FIELDS: '缺少部分必填信息'
};

const PROGRESS_LABELS = {
  applied: '投递成功',
  assessment: '笔试 / 测评邀请',
  interview: '面试邀请',
  offer: 'Offer',
  rejected: '拒信',
  closed: '流程结束',
  pending: '新的线索'
};

const FIELD_LABELS = {
  company_name: '公司', job_title: '岗位', jd_summary: 'JD 摘要', job_url: '岗位链接',
  status_url: '状态链接', status_url_scope: '状态链接类型', status: '状态',
  applied_at: '投递时间', applied_at_precision: '投递时间精度', has_applied: '是否已投',
  location: '城市', recruitment_batch: '招聘批次', channel: '渠道', interview_round: '面次',
  round_label: '面次标签', last_interview_completed_at: '面试完成时间'
};

/* 切到这些状态意味着「已正式申请」，必须带可信投递时间 */
const NEEDS_APPLIED_AT = new Set(['applied', 'assessment', 'interview', 'offer', 'rejected']);
const AUTO_CONFIRM_MIN = 0.8;

function kindLabel(kind) { return KIND_LABELS[kind] || '待确认线索'; }
function reasonLabel(reason) { return REASON_LABELS[reason] || null; }

/* 面向用户的人话错误：不展示 D05/D12/HTTP_xxx 这类内部编号，也不带 request_id 噪声。 */
function humanError(err) {
  if (!(err instanceof ApiError)) return err?.message || '请求失败，请稍后重试';
  const map = {
    D12_NOT_FROZEN: '这条要进台账还缺投递时间；请填一个你确认过的日期，不会用今天代替。',
    VERSION_CONFLICT: '这条刚刚被别处更新过，已经刷新，请再确认一次。',
    UNDO_EXPIRED: '已经超过可撤销时间；请到台账详情里用「纠错」修改，并填写原因。',
    UNDO_NOT_AVAILABLE: '这条待确认不是「确认更新」处理的，不能这样撤回。',
    APPLIED_FACT_REMOVAL: '不能通过待确认撤销「已投」事实；如果确实要改，请到台账详情里走终态纠错。',
    NOT_FOUND: '这条记录或待确认项已经不存在，请刷新后重试。',
    VALIDATION_ERROR: err.message || '提交的内容不完整，请检查后重试。',
    FORBIDDEN: '当前账号没有权限执行这个操作。'
  };
  return map[err.code] || err.message || `请求失败（${err.status}），请稍后重试`;
}

function progressLabel(status) {
  return PROGRESS_LABELS[status] || (status ? STATUS_LABELS[status] || '状态更新' : '进展');
}

function pct(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100);
}

/* 10月20日 —— 只用于句子里的日期，不替代完整时间 */
function monthDay(iso) {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric'
  }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${Number(get('month'))}月${Number(get('day'))}日`;
}

function targetText(company, title) {
  if (!company && !title) return null;
  return [company || '（公司待补充）', title || '（岗位待补充）'].join(' · ');
}

export async function renderReviews(container, { gen, onChanged } = {}) {
  const root = h('div', { class: 'tn-reviews', 'data-test': 'reviews-view' });
  container.append(root);
  const headEl = h('div', { class: 'tn-toolbar' });
  const listEl = h('div', {});
  const bannerEl = h('div', {});
  root.append(headEl, bannerEl, listEl);

  let items = [];
  let loading = false;
  let error = null;
  let reqSeq = 0;
  let batchBusy = false;

  function buildHead() {
    clear(headEl);
    const eligible = items.filter((r) => r.total_confidence != null && r.total_confidence >= AUTO_CONFIRM_MIN
      && r.suggested_application_id).length;
    headEl.append(
      h('div', {},
        h('div', { style: { fontWeight: '600' }, text: `待确认${items.length ? ` · ${items.length} 条` : ''}` }),
        h('div', { class: 'tn-small tn-muted', text: '这里只放系统拿不准的线索；你确认后才会改台账，改错了 10 秒内可撤销。' })
      ),
      h('div', { class: 'tn-toolbar-right' },
        h('button', {
          class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'review-batch-confirm',
          text: eligible ? `把握度 ≥ 80% 的全部确认（${eligible} 条）` : '没有可批量确认的条目',
          disabled: !eligible || batchBusy,
          title: eligible ? '逐条按系统判断更新台账；失败的会留在列表里' : '需要同时具备：对上具体记录 + 总把握度 ≥ 80%',
          onclick: () => batchConfirm()
        }),
        h('button', {
          class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'reviews-refresh', text: '刷新',
          onclick: () => load()
        })
      )
    );
  }

  async function load() {
    const seq = ++reqSeq;
    loading = true;
    bannerEl.replaceChildren();
    if (!items.length) {
      listEl.replaceChildren(h('div', { class: 'tn-table-card' }, h('div', { class: 'tn-empty' },
        h('p', { class: 'tn-muted', text: '加载中…' }))));
    }
    try {
      const res = await api.get('/api/v1/review-items?status=open&limit=50');
      if (seq !== reqSeq || isStale(gen)) return;
      items = res.data || [];
      error = null;
    } catch (err) {
      if (seq !== reqSeq || isStale(gen)) return;
      error = humanError(err);
    } finally {
      if (seq !== reqSeq || isStale(gen)) return;
      loading = false;
      renderList();
    }
  }

  function renderList() {
    listEl.replaceChildren();
    buildHead();
    if (error) {
      bannerEl.replaceChildren(h('div', { class: 'tn-banner err' },
        h('div', { class: 'tn-banner-body', text: `无法加载待确认项：${error}` })));
    }
    if (loading) return;
    if (!items.length) {
      listEl.append(h('div', { class: 'tn-table-card' }, h('div', { class: 'tn-empty' },
        h('h3', { text: '没有待确认项' }),
        h('p', { text: '系统有把握的已经直接更新台账；这里为空说明没有需要你裁决的线索。' }),
        h('p', { class: 'tn-small tn-faint', text: '如果邮件里的进展没有出现在台账，可到「数据与授权」里点「立即同步邮箱」。' })
      )));
      return;
    }
    for (const review of items) listEl.append(renderCard(review));
  }

  /* ---------- 单张卡片 ---------- */
  function renderCard(review) {
    const card = h('div', { class: 'tn-review-card', 'data-test': 'review-card', 'data-review-id': review.id });
    const suggested = review.suggested_changes || {};
    const suggestedStatus = review.suggested_status || null;
    const suggestedTarget = review.suggested_application || null;
    const candidates = review.candidates || [];
    const receivedAt = review.mail_received_at || null;
    const dateLabel = receivedAt ? monthDay(receivedAt) : null;
    const state = {
      selected: suggestedTarget?.id || (candidates.length === 1 ? candidates[0].application_id : null),
      targetInfo: null,
      editOpen: false,
      busy: false
    };

    /* 第一行：类型 + 时间 */
    const head = h('div', { class: 'tn-review-head' },
      h('span', { class: 'tn-review-kind', text: kindLabel(review.kind) }),
      h('div', { class: 'tn-grow' },
        h('div', { class: 'tn-small tn-muted', text: [
          receivedAt ? `邮件收到于 ${fmtDateTime(receivedAt)}` : `线索创建于 ${fmtDateTime(review.created_at)}`,
          reasonLabel(review.reason_code)
        ].filter(Boolean).join(' · ') })
      )
    );
    card.append(head);

    /* 一句话结论 */
    const subjectTarget = suggestedTarget
      ? targetText(suggestedTarget.company_name, suggestedTarget.job_title)
      : targetText(suggested.company_name, suggested.job_title);
    const conclusion = h('div', { class: 'tn-review-conclusion', 'data-test': 'review-conclusion' });
    if (subjectTarget) {
      conclusion.append(h('div', { class: 'tn-review-title' },
        h('span', { text: dateLabel ? `${dateLabel}收到的这封邮件，系统判断是 ` : '系统判断这条线索是 ' }),
        h('strong', { text: `「${subjectTarget}」` }),
        h('span', { text: suggestedStatus ? `的「${progressLabel(suggestedStatus)}」。` : '的招聘进展。' })
      ));
    } else {
      conclusion.append(h('div', { class: 'tn-review-title' },
        h('span', { text: dateLabel ? `${dateLabel}收到的这封邮件` : '这条线索' }),
        h('span', { text: suggestedStatus ? `看起来是「${progressLabel(suggestedStatus)}」，但系统没猜出对应你台账里的哪条记录。` : '，系统没猜出对应你台账里的哪条记录。' })
      ));
    }
    const total = pct(review.total_confidence);
    const classPct = pct(review.classification_confidence);
    const matchPct = pct(review.match_confidence);
    const explain = [];
    if (classPct != null) explain.push(`分类 ${classPct}%`);
    if (matchPct != null) explain.push(`匹配 ${matchPct}%`);
    if (total != null) {
      conclusion.append(h('div', { class: 'tn-small tn-muted', 'data-test': 'review-confidence',
        text: `系统把握度 ${total}%${explain.length ? `（${explain.join(' × ')}）` : ''}。低于 90% 不会自动改台账，所以请你确认一下。` }));
    } else {
      conclusion.append(h('div', { class: 'tn-small tn-muted', 'data-test': 'review-confidence',
        text: '系统把握度不足：需要你确认它对应哪条记录、是哪种进展。' }));
    }
    card.append(h('div', { class: 'tn-review-section' }, conclusion));

    /* 建议变化 */
    if (suggestedStatus) {
      card.append(h('div', { class: 'tn-review-section' },
        h('div', { class: 'tn-diff' },
          h('span', { class: 'tn-diff-key', text: '建议状态' }),
          h('span', { class: 'tn-diff-new', text: STATUS_LABELS[suggestedStatus] || suggestedStatus })
        )
      ));
    }

    /* 证据折叠区 */
    const ev = review.evidence || {};
    const evRows = [];
    const addEv = (label, value) => {
      if (value == null || value === '') return;
      evRows.push(h('div', {}, h('span', { class: 'tn-muted', text: `${label}：` }), h('span', { text: String(value).slice(0, 300) })));
    };
    addEv('邮件主题', ev.subject_excerpt || review.summary);
    addEv('发件域名', ev.from_domain);
    addEv('正文片段', ev.body_excerpt);
    addEv('收到日期', receivedAt ? fmtDateTime(receivedAt) : null);
    addEv('来源站点', ev.site_key);
    addEv('页面状态文本', ev.status_text);
    addEv('证据强度', ev.evidence_level === 'strong' ? '强' : ev.evidence_level === 'weak' ? '弱' : ev.evidence_level);
    if (evRows.length) {
      card.append(h('details', { class: 'tn-review-section', 'data-test': 'review-evidence' },
        h('summary', { class: 'tn-small tn-muted', style: { cursor: 'pointer' }, text: '证据（点开看邮件主题 / 发件人 / 片段）' }),
        h('div', { class: 'tn-evidence', style: { marginTop: '6px' } }, evRows)
      ));
    }

    /* 候选记录 */
    const candidateBox = h('div', {});
    if (candidates.length) {
      const list = h('ul', { class: 'tn-candidates', 'data-test': 'review-candidates' });
      const rebuild = () => {
        clear(list);
        for (const c of candidates) {
          const selected = state.selected === c.application_id;
          const li = h('li', { class: selected ? 'selected' : '', 'data-test': 'review-candidate' },
            h('input', {
              type: 'radio', name: `cand-${review.id}`, checked: selected,
              'data-app-id': c.application_id,
              onchange: () => { state.selected = c.application_id; state.targetInfo = null; rebuild(); }
            }),
            h('div', {},
              h('div', {}, h('strong', { text: c.company_name || '—' }), ' · ', c.job_title || '—'),
              h('div', { class: 'tn-candidate-meta', text: [
                c.location, c.recruitment_batch,
                STATUS_LABELS[c.status] || c.status,
                c.has_applied ? '已投' : '未投',
                c.match_confidence != null ? `匹配把握 ${Math.round(c.match_confidence * 100)}%` : null
              ].filter(Boolean).join(' · ') })
            )
          );
          li.addEventListener('click', (e) => {
            if (e.target instanceof HTMLInputElement) return;
            state.selected = c.application_id;
            state.targetInfo = null;
            rebuild();
          });
          list.append(li);
        }
      };
      rebuild();
      candidateBox.append(list);
    } else {
      candidateBox.append(h('div', { class: 'tn-small tn-muted', 'data-test': 'review-no-candidates',
        text: '没有自动对上你台账里的记录。可以点「不对，我来改」搜索本人台账，或按这封邮件新建一条。' }));
    }
    card.append(h('div', { class: 'tn-review-section' },
      h('h4', { text: candidates.length ? '候选记录（本人台账）' : '对应记录' }), candidateBox));

    /* 编辑区容器 */
    const editHost = h('div', {});
    card.append(editHost);

    /* 错误提示 */
    const errBox = h('div', { 'data-test': 'review-error' });

    /* 三个主按钮 */
    const confirmLabel = suggestedTarget ? '对，更新台账' : '选一条记录并更新';
    const confirmBtn = h('button', {
      class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', 'data-test': 'review-confirm',
      text: confirmLabel,
      onclick: async () => {
        if (state.busy) return;
        const targetId = suggestedTarget?.id || state.selected;
        if (!targetId) {
          if (!state.editOpen) toggleEdit();
          editHost.querySelector('[data-test=review-target-select]')?.focus();
          toast('这条没有自动对上记录：先在下方选一条本人台账，或按邮件新建一条', 'info');
          return;
        }
        await confirmSuggested(review, targetId, errBox);
      }
    });
    const editBtn = h('button', {
      class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'review-edit', text: '不对，我来改',
      onclick: () => toggleEdit()
    });
    const dismissBtn = h('button', {
      class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', 'data-test': 'review-dismiss', text: '这不是招聘进展，忽略',
      onclick: async () => {
        const ok = await confirmDialog({
          title: '忽略这条线索？',
          message: '忽略后它不再进入待确认队列，也不会创建或修改任何申请记录。',
          detail: '仅当这条确实不是招聘进展（广告、订阅、误识别）时使用；忽略后不可在界面撤销。',
          confirmLabel: '忽略'
        });
        if (!ok) return;
        await dismissReview(review, errBox);
      }
    });
    card.append(h('div', { class: 'tn-review-section' },
      h('div', { class: 'tn-action-row' }, confirmBtn, editBtn, dismissBtn),
      h('div', { class: 'tn-small tn-faint', style: { marginTop: '6px' },
        text: '提交前会重新读取这条线索和记录的最新版本；如果刚被别处改过，会提示你重新确认，不会静默覆盖。' }),
      errBox
    ));

    function toggleEdit() {
      state.editOpen = !state.editOpen;
      editBtn.textContent = state.editOpen ? '收起「我来改」' : '不对，我来改';
      if (state.editOpen) renderEditForm();
      else clear(editHost);
    }

    function renderEditForm() {
      clear(editHost);
      const form = buildEditForm(review, {
        candidates,
        suggested,
        suggestedStatus,
        suggestedTarget,
        receivedAt,
        initialTargetId: state.selected,
        onBusy: (v) => { state.busy = v; confirmBtn.disabled = v; dismissBtn.disabled = v; },
        onResolved: () => refreshAfterChange(),
        onCancel: () => toggleEdit(),
        onTargetChange: (info) => { state.targetInfo = info; if (info) state.selected = info.id; }
      });
      editHost.append(form);
    }

    return card;
  }

  /* ---------- 「不对，我来改」表单 ---------- */
  function buildEditForm(review, opts) {
    const { candidates, suggested, suggestedStatus, suggestedTarget, receivedAt } = opts;
    const known = new Map();
    for (const c of candidates) {
      known.set(c.application_id, {
        id: c.application_id,
        company_name: c.company_name,
        job_title: c.job_title,
        status: c.status,
        has_applied: c.has_applied,
        applied_at: null,
        version: c.application_version,
        match_reason: c.match_reason
      });
    }
    if (suggestedTarget) known.set(suggestedTarget.id, suggestedTarget);

    const targetSel = h('select', { class: 'tn-select', 'data-test': 'review-target-select' });
    function rebuildTargetOptions(extra = null) {
      const current = targetSel.value || opts.initialTargetId || '';
      clear(targetSel);
      targetSel.append(h('option', { value: '', text: '请选择本人台账记录…' }));
      for (const info of known.values()) {
        targetSel.append(h('option', {
          value: info.id,
          text: `${info.company_name || '—'} · ${info.job_title || '—'}${info.status ? `（${STATUS_LABELS[info.status] || info.status}）` : ''}`
        }));
      }
      targetSel.append(h('option', { value: '__search__', text: '搜索更多本人台账记录…' }));
      targetSel.append(h('option', { value: '__create__', text: '台账里没有，按这封邮件新建一条…' }));
      if (extra && ![...known.keys()].includes(extra.id)) {
        known.set(extra.id, extra);
        targetSel.insertBefore(h('option', {
          value: extra.id, text: `${extra.company_name || '—'} · ${extra.job_title || '—'}（已选择）`
        }), targetSel.querySelector('option[value=__search__]'));
      }
      targetSel.value = known.has(current) ? current : (extra?.id || '');
    }
    rebuildTargetOptions();
    targetSel.value = opts.initialTargetId && known.has(opts.initialTargetId) ? opts.initialTargetId : '';

    const searchWrap = h('div', { class: 'tn-field', style: { display: 'none' } });
    const searchInput = h('input', { class: 'tn-input', type: 'search', placeholder: '输入公司 / 岗位 / 城市搜索本人台账', 'data-test': 'review-search' });
    const searchResults = h('select', { class: 'tn-select', 'data-test': 'review-search-results', style: { marginTop: '6px' } });
    searchWrap.append(h('label', { text: '搜索本人台账' }), searchInput, searchResults,
      h('div', { class: 'tn-hint', text: '只搜索你自己的记录；包含「看过没投」和已归档。' }));

    const createWrap = h('div', { style: { display: 'none' } });
    const cCompany = h('input', { class: 'tn-input', value: suggested.company_name || '', 'data-test': 'review-create-company' });
    const cTitle = h('input', { class: 'tn-input', value: suggested.job_title || '', 'data-test': 'review-create-title' });
    const cJd = h('textarea', { class: 'tn-textarea' });
    cJd.value = suggested.jd_summary || '';
    const cUrl = h('input', { class: 'tn-input', type: 'url', value: suggested.job_url || '', placeholder: 'https://…' });
    const cLocation = h('input', { class: 'tn-input', value: suggested.location || '' });
    const cBatch = h('input', { class: 'tn-input', value: suggested.recruitment_batch || '' });
    createWrap.append(h('div', { class: 'tn-form-grid' },
      h('div', { class: 'tn-field' }, h('label', { text: '公司名 *' }), cCompany),
      h('div', { class: 'tn-field' }, h('label', { text: '岗位名 *' }), cTitle),
      h('div', { class: 'tn-field' }, h('label', { text: '城市' }), cLocation),
      h('div', { class: 'tn-field' }, h('label', { text: '招聘批次' }), cBatch),
      h('div', { class: 'tn-field' }, h('label', { text: '岗位链接' }), cUrl)
    ), h('div', { class: 'tn-field', style: { marginTop: '10px' } },
      h('label', { text: 'JD 摘要（纯文本 ≤80 字）' }), cJd));

    const statusSel = h('select', { class: 'tn-select', 'data-test': 'review-status-select' });
    statusSel.append(h('option', { value: '', text: '（只关联记录，不改状态）' }));
    for (const s of STATUS_ORDER) statusSel.append(h('option', { value: s, text: STATUS_LABELS[s] }));
    if (suggestedStatus) statusSel.value = suggestedStatus;

    const appliedField = h('div', { class: 'tn-field', style: { display: 'none' } });
    const appliedInput = h('input', { class: 'tn-input', type: 'datetime-local', 'data-test': 'review-applied-at' });
    const appliedHint = h('div', { class: 'tn-hint', text: '' });

    const errBox = h('div', { 'data-test': 'review-edit-error' });
    const submitBtn = h('button', {
      class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', 'data-test': 'review-edit-submit', text: '保存并更新台账'
    });

    let mode = 'existing';
    let currentInfo = null;

    async function loadTargetInfo(id) {
      currentInfo = known.get(id) || null;
      if (!currentInfo || currentInfo.applied_at === undefined || currentInfo.applied_at === null) {
        try {
          const res = await api.get(`/api/v1/applications/${encodeURIComponent(id)}`);
          currentInfo = { ...res.data, id: res.data.id };
          known.set(id, currentInfo);
        } catch (err) {
          showErr(errBox, `读取记录失败：${humanError(err)}`);
          return;
        }
      }
      opts.onTargetChange(currentInfo);
      const needsTime = NEEDS_APPLIED_AT.has(statusSel.value);
      const missingTime = !currentInfo.applied_at;
      if (needsTime && missingTime) {
        appliedField.style.display = '';
        appliedHint.textContent = receivedAt
          ? '这条记录原来没有投递时间。默认填收信日期，标记为「据邮件推断（≤ 收信日）」；你可以改成实际日期。'
          : '这条记录没有投递时间。请填一个你确认过的日期；不会用今天代替。';
        if (receivedAt && !appliedInput.value) appliedInput.value = toShanghaiInput(new Date(receivedAt));
      } else {
        appliedField.style.display = 'none';
        appliedInput.value = '';
      }
    }

    function syncTimeField() {
      const needsTime = NEEDS_APPLIED_AT.has(statusSel.value);
      const missingTime = !currentInfo?.applied_at;
      if (mode !== 'existing') { appliedField.style.display = 'none'; return; }
      if (needsTime && missingTime) {
        appliedField.style.display = '';
        if (receivedAt && !appliedInput.value) appliedInput.value = toShanghaiInput(new Date(receivedAt));
      } else {
        appliedField.style.display = 'none';
        appliedInput.value = '';
      }
    }

    targetSel.addEventListener('change', async () => {
      const value = targetSel.value;
      searchWrap.style.display = value === '__search__' ? '' : 'none';
      createWrap.style.display = value === '__create__' ? '' : 'none';
      mode = value === '__create__' ? 'create' : 'existing';
      submitBtn.textContent = mode === 'create' ? '创建并处理' : '保存并更新台账';
      if (value === '__search__') { searchInput.focus(); return; }
      if (value === '__create__') { syncTimeField(); return; }
      if (value) await loadTargetInfo(value);
    });

    statusSel.addEventListener('change', syncTimeField);

    const doSearch = debounce(async () => {
      clear(searchResults);
      const q = searchInput.value.trim();
      if (q.length < 1) return;
      try {
        const res = await api.get(`/api/v1/application-search?q=${encodeURIComponent(q)}&limit=20`);
        searchResults.append(h('option', { value: '', text: `找到 ${res.data.length} 条，选择一条…` }));
        for (const row of res.data) {
          searchResults.append(h('option', {
            value: row.id,
            text: `${row.company_name} · ${row.job_title}（${row.status_label}${row.has_applied ? ' · 已投' : ''}）`
          }));
        }
      } catch (err) {
        showErr(errBox, `搜索失败：${humanError(err)}`);
      }
    }, 280);

    searchInput.addEventListener('input', doSearch);
    searchResults.addEventListener('change', async () => {
      const id = searchResults.value;
      if (!id) return;
      const picked = await api.get(`/api/v1/applications/${encodeURIComponent(id)}`).then((r) => r.data).catch(() => null);
      if (!picked) { showErr(errBox, '读取所选记录失败，请重试'); return; }
      rebuildTargetOptions(picked);
      targetSel.value = id;
      searchWrap.style.display = 'none';
      searchInput.value = '';
      mode = 'existing';
      submitBtn.textContent = '保存并更新台账';
      await loadTargetInfo(id);
    });

    submitBtn.addEventListener('click', async () => {
      clear(errBox);
      if (mode === 'create') {
        const company = cCompany.value.trim();
        const title = cTitle.value.trim();
        if (!company || !title) { showErr(errBox, '公司和岗位名必填'); return; }
        const changes = { company_name: company, job_title: title };
        if (cJd.value.trim()) changes.jd_summary = cJd.value.trim();
        if (cUrl.value.trim()) changes.job_url = cUrl.value.trim();
        if (cLocation.value.trim()) changes.location = cLocation.value.trim();
        if (cBatch.value.trim()) changes.recruitment_batch = cBatch.value.trim();
        if (statusSel.value) changes.status = statusSel.value;
        if (NEEDS_APPLIED_AT.has(statusSel.value)) {
          changes.has_applied = true;
          if (appliedInput.value) {
            changes.applied_at = new Date(`${appliedInput.value}:00+08:00`).toISOString();
            changes.applied_at_precision = 'date';
          } else if (receivedAt) {
            changes.applied_at = receivedAt;
            changes.applied_at_precision = 'inferred_before';
          }
        }
        await submit(review, { action: 'create', changes }, { errBox, submitBtn, onResolved: opts.onResolved, toastText: '已按这封邮件新建记录' });
        return;
      }
      const targetId = targetSel.value;
      if (!targetId || targetId.startsWith('__')) { showErr(errBox, '请先选择一条本人台账记录，或选择「新建一条」'); return; }
      const changes = {};
      if (statusSel.value) changes.status = statusSel.value;
      const needsTime = NEEDS_APPLIED_AT.has(statusSel.value);
      const missingTime = currentInfo && !currentInfo.applied_at;
      if (needsTime && missingTime) {
        if (!appliedInput.value && !receivedAt) { showErr(errBox, '这个状态需要投递时间；请填写一个你确认过的日期'); return; }
        changes.applied_at = appliedInput.value
          ? new Date(`${appliedInput.value}:00+08:00`).toISOString()
          : receivedAt;
        changes.applied_at_precision = appliedInput.value ? 'date' : 'inferred_before';
      }
      if (!Object.keys(changes).length) { showErr(errBox, '没有要修改的内容：请选择目标状态，或改用「对，更新台账」直接确认'); return; }
      if (statusSel.value && currentInfo && !currentInfo.has_applied && NEEDS_APPLIED_AT.has(statusSel.value)) {
        changes.has_applied = true;
      }
      await submit(review, { action: 'confirm', applicationId: targetId, changes }, {
        errBox, submitBtn, onResolved: opts.onResolved,
        successText: (app) => `已更新：${app.company_name} · ${app.job_title} → ${STATUS_LABELS[app.status] || app.status}`,
        undo: true
      });
    });

    appliedField.append(h('label', { text: '投递时间（缺失时才需要填）' }), appliedInput, appliedHint);

    const form = h('div', { class: 'tn-inline-form', 'data-test': 'review-edit-form', style: { marginTop: '12px' } },
      h('h4', { style: { margin: '0 0 8px' }, text: '我来改：选择记录 / 状态' }),
      h('div', { class: 'tn-field' }, h('label', { text: '对应哪条记录？' }), targetSel),
      searchWrap,
      h('div', { class: 'tn-field' }, h('label', { text: '目标状态' }), statusSel,
        h('div', { class: 'tn-hint', text: '只改状态；时间字段只在记录真的缺投递时间时出现。' })),
      appliedField,
      createWrap,
      errBox,
      h('div', { class: 'tn-action-row', style: { marginTop: '10px' } },
        submitBtn,
        h('button', {
          class: 'tn-btn tn-btn-sm', type: 'button', text: '取消',
          onclick: () => { clear(errBox); if (opts.onCancel) opts.onCancel(); else opts.onTargetChange(null); }
        })
      )
    );

    if (opts.initialTargetId && known.has(opts.initialTargetId)) {
      loadTargetInfo(opts.initialTargetId);
    } else if (!candidates.length) {
      /* 没有候选时直接把「搜索本人台账」展开，少点一次。 */
      targetSel.value = '__search__';
      searchWrap.style.display = '';
    }
    return form;
  }

  /* ---------- 提交动作 ---------- */
  async function confirmSuggested(review, targetId, errBox) {
    const target = (review.candidates || []).find((c) => c.application_id === targetId)
      || (review.suggested_application?.id === targetId ? review.suggested_application : null);
    const changes = {};
    // 系统建议里只挑「可展示、可解释」的字段；不把内部证据字段写进台账。
    for (const key of ['status', 'applied_at', 'applied_at_precision', 'has_applied', 'interview_scheduled_at', 'round_label', 'interview_round']) {
      if (review.suggested_changes?.[key] != null) changes[key] = review.suggested_changes[key];
    }
    if (!target && !changes.status) {
      showErr(errBox, '这条没有可自动应用的建议，请用「不对，我来改」选择记录和状态');
      return;
    }
    await submit(review, {
      action: 'confirm',
      applicationId: targetId,
      changes
    }, {
      errBox,
      successText: (app) => `已更新：${app.company_name} · ${app.job_title} → ${STATUS_LABELS[app.status] || app.status}`,
      undo: true
    });
  }

  async function dismissReview(review, errBox) {
    clear(errBox);
    try {
      await api.post(`/api/v1/review-items/${encodeURIComponent(review.id)}/resolve`, {
        expected_version: review.version,
        action: 'dismiss',
        reason: '用户判断这不是招聘进展'
      }, { idempotencyKey: idemKey('review-dismiss') });
      toast('已忽略该线索', 'ok');
      await refreshAfterChange();
    } catch (err) {
      handleResolveError(err, errBox, review);
    }
  }

  async function submit(review, body, { errBox, submitBtn, successText, undo, toastText, onResolved }) {
    clear(errBox);
    if (submitBtn) submitBtn.disabled = true;
    try {
      /* 先取最新复核项 + 最新记录版本，避免拿旧版本硬写。 */
      const freshRes = await api.get(`/api/v1/review-items/${encodeURIComponent(review.id)}`);
      const fresh = freshRes.data;
      if (fresh.status !== 'open') {
        toast('这条已经处理过了，已刷新列表', 'ok');
        await refreshAfterChange();
        return;
      }
      const payload = {
        expected_version: fresh.version,
        action: body.action,
        changes: body.changes || {}
      };
      if (body.action === 'create') {
        // create 不需要目标记录版本
      } else {
        const appRes = await api.get(`/api/v1/applications/${encodeURIComponent(body.applicationId)}`);
        payload.application_id = body.applicationId;
        payload.expected_application_version = appRes.data.version;
      }
      const res = await api.post(`/api/v1/review-items/${encodeURIComponent(review.id)}/resolve`, payload,
        { idempotencyKey: idemKey(`review-${body.action}`) });
      const app = res.data.application;
      const text = typeof successText === 'function'
        ? successText(app)
        : (successText || toastText || '已更新台账');
      if (undo && app) {
        toastAction(text, {
          actionLabel: '撤销',
          onAction: async () => {
            try {
              await api.post(`/api/v1/review-items/${encodeURIComponent(review.id)}/undo`, {},
                { idempotencyKey: idemKey('review-undo') });
              toast('已撤回这次确认，记录已恢复', 'ok');
              await refreshAfterChange();
            } catch (err) {
              toast(humanError(err), 'err');
            }
          }
        });
      } else {
        toast(text, 'ok');
      }
      await refreshAfterChange();
    } catch (err) {
      handleResolveError(err, errBox, review);
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  async function batchConfirm() {
    const eligible = items.filter((r) => r.total_confidence != null && r.total_confidence >= AUTO_CONFIRM_MIN
      && r.suggested_application_id);
    if (!eligible.length) { toast('没有把握度 ≥ 80% 且能对上记录的条目', 'info'); return; }
    const ok = await confirmDialog({
      title: `按系统判断确认 ${eligible.length} 条？`,
      message: '会逐条把台账更新成系统判断的状态；每条都会留痕，10 秒内可撤销。',
      detail: '任意一条失败（记录刚被改过、版本冲突等）会留在列表里并标红，不会整体回滚其它条目。',
      confirmLabel: '全部确认'
    });
    if (!ok) return;
    batchBusy = true;
    buildHead();
    let succeeded = 0;
    const failures = [];
    for (const review of eligible) {
      try {
        const appRes = await api.get(`/api/v1/applications/${encodeURIComponent(review.suggested_application_id)}`);
        await api.post(`/api/v1/review-items/${encodeURIComponent(review.id)}/resolve`, {
          expected_version: review.version,
          action: 'confirm',
          application_id: review.suggested_application_id,
          expected_application_version: appRes.data.version,
          changes: review.suggested_changes || {}
        }, { idempotencyKey: idemKey('review-batch') });
        succeeded += 1;
      } catch (err) {
        failures.push({ id: review.id, message: humanError(err) });
      }
    }
    batchBusy = false;
    if (failures.length) {
      toast(`已确认 ${succeeded} 条，${failures.length} 条失败，已留在列表里标红`, 'err');
      for (const f of failures) {
        const card = listEl.querySelector(`[data-review-id="${CSS.escape(f.id)}"]`);
        if (card) card.classList.add('has-error');
      }
    } else {
      toast(`已按系统判断确认 ${succeeded} 条`, 'ok');
    }
    if (succeeded) {
      try { if (onChanged) onChanged(); } catch { /* ignore */ }
    }
    await load();
  }

  function showErr(box, text) {
    const node = h('div', { class: 'tn-inline-msg err', text });
    box.append(node);
  }

  function handleResolveError(err, box, reviewSnapshot) {
    clear(box);
    if (!(err instanceof ApiError)) { showErr(box, humanError(err)); return; }
    if (err.status === 409 && err.code === 'VERSION_CONFLICT' && err.details?.candidates?.length) {
      const message = '服务端发现了新的候选记录，不能强行新增。请从候选中选择，或改用「关联记录」。';
      showErr(box, message);
      toast(message, 'err');
      load();
      return;
    }
    switch (err.code) {
      case 'VERSION_CONFLICT': {
        const message = '这条刚刚被更新过（复核项或候选记录已被更新），已刷新，请再确认一次。';
        showErr(box, message);
        toast(message, 'err');
        if (reviewSnapshot) load();
        break;
      }
      case 'UNDO_EXPIRED':
        showErr(box, '已经超过可撤销时间；请到台账详情里用「纠错」修改，并填写原因。');
        break;
      case 'UNDO_NOT_AVAILABLE':
        showErr(box, '这条待确认不是「确认更新」处理的，不能这样撤回。');
        break;
      case 'APPLIED_FACT_REMOVAL':
        showErr(box, '不能通过待确认撤销「已投」事实；如果确实要改，请到台账详情里走终态纠错。');
        break;
      default:
        showErr(box, `处理失败：${humanError(err)}`);
    }
  }

  async function refreshAfterChange() {
    try { if (onChanged) onChanged(); } catch { /* 列表刷新失败不影响本视图 */ }
    await load();
  }

  buildHead();
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
