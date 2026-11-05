/* 待确认：确认按钮先走服务端 LLM+Jev 识别；可靠才直接入账，否则打开最少必要补录。 */
import { api } from '../api.js';
import { isStale } from '../app.js?v=20261102-1';
import { h, clear, toast, fmtDateTime, idemKey, STATUS_LABELS } from '../util.js';

const STATUS_OPTIONS = [
  ['pending', '看过没投'],
  ['applied', '已投递'],
  ['assessment', '笔试/测评'],
  ['interview', '面试'],
  ['offer', '录用'],
  ['rejected', '拒绝'],
  ['closed', '结束']
];
const APPLIED_LIKE = new Set(['applied', 'assessment', 'interview', 'offer', 'rejected']);
const MAX_PREVIEW = 260;
const INVALID_FIELD = /^(?:待补充|未知|不详|未填写|未识别|系统判断|面试|通知|提醒|加分项或注意事项|批次待补充|城市待补充|还没有投递记录|无|—|-)?$/i;

function validField(value) {
  const text = String(value || '').trim();
  return text.length >= 2 && !INVALID_FIELD.test(text)
    && !/系统判断|批次待补充|城市待补充|还没有投递记录|招聘邮件更新候选|加分项或注意事项|基本信息/i.test(text);
}
function humanError(err) {
  if (err?.code === 'REVIEW_FIELDS_REQUIRED') return '公司和岗位都是必填项，请根据原始信息补充或纠正。';
  if (err?.code === 'APPLIED_AT_REQUIRED' || err?.code === 'D12_NOT_FROZEN') return '请填写实际投递日期；不会用确认入账的时间代替。';
  if (err?.code === 'REVIEW_ASSIGN_AMBIGUOUS') return '发现多条已有岗位匹配，请选择要更新的记录。';
  if (err?.code === 'INTAKE_RECOGNITION_FAILED') return '识别/核验失败，未创建台账；可以重试或手动填写。';
  if (err?.code === 'APPLIED_FACT_REMOVAL') return '这条岗位已经投递，不能改成看过没投。';
  if (err?.status === 409) return err?.message || '这条刚被更新过，请刷新后再试。';
  return String(err?.message || '操作失败，请稍后重试');
}
function ymd(iso) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '';
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function dateToIso(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const d = new Date(value + 'T12:00:00+08:00');
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function show(text, kind = 'err') { return h('p', { class: `tn-inline-msg ${kind}`, text }); }

function traceStatus(value) {
  return { not_called: '未调用', running: '进行中', success: '成功', failed: '失败' }[value] || value || '未知';
}
function traceMs(ms) { return Number.isFinite(Number(ms)) ? `${Number(ms)}ms` : '—'; }
function traceText(data) {
  const trace = data?.trace || {};
  const analysis = data?.analysis || {};
  const lines = [];
  if (trace.request_id) lines.push(`请求标识：${trace.request_id}`);
  if (trace.started_at) lines.push(`开始时间：${fmtDateTime(trace.started_at)}`);
  if (trace.duration_ms != null) lines.push(`总耗时：${traceMs(trace.duration_ms)}`);
  lines.push(`LLM 提取：${traceStatus(trace.llm?.status)}${trace.llm?.model ? ` · ${trace.llm.model}` : ''}${trace.llm?.duration_ms != null ? ` · ${traceMs(trace.llm.duration_ms)}` : ''}${trace.llm?.error ? ` · ${trace.llm.error}` : ''}`);
  lines.push(`Jev 判断：${traceStatus(trace.jev?.status)}${trace.jev?.via ? ` · ${trace.jev.via === 'dify' ? '经 Dify' : '直连'}` : ''}${trace.jev?.model ? ` · ${trace.jev.model}` : ''}${trace.jev?.duration_ms != null ? ` · ${traceMs(trace.jev.duration_ms)}` : ''}${trace.jev?.error ? ` · ${trace.jev.error}` : ''}`);
  if (trace.jev?.request_id) lines.push(`Jev 运行标识：${trace.jev.request_id}`);
  if (trace.dify?.used) lines.push(`Dify 调用：${traceStatus(trace.dify.status)}${trace.dify.run_id ? ` · ${trace.dify.run_id}` : ''}${trace.dify.error ? ` · ${trace.dify.error}` : ''}`);
  if (analysis.verification === 'dify_fallback') {
    lines.push('核验路径：经 Dify 调用真实 Jev');
    if (analysis.direct_jev_error) lines.push(`本地直连 Jev：失败（${analysis.direct_jev_error} 地区/网络限制），已自动转 Dify`);
  } else if (analysis.verification === 'direct') {
    lines.push('核验路径：本地直连真实 Jev');
  }
  if (analysis.models) lines.push(`实际模型：LLM ${analysis.models.llm || '—'} / Jev ${analysis.models.jev || '—'}`);
  const ex = analysis.extracted || {};
  if (ex.company_name || ex.job_title || ex.status) lines.push(`提取结果：公司 ${ex.company_name || '—'}；岗位 ${ex.job_title || '—'}；状态 ${ex.status || '—'}`);
  if (data?.fields) lines.push(`预填字段：公司 ${data.fields.company_name || '—'}；岗位 ${data.fields.job_title || '—'}；状态 ${data.fields.status || '—'}`);
  if (Array.isArray(data?.missing) && data.missing.length) lines.push(`仍需补充：${data.missing.join('、')}`);
  if (data?.cause) lines.push(`失败原因：${data.cause}`);
  return lines.join('\n');
}
function traceBox(data) {
  return h('details', { class: 'tn-trace', 'data-test': 'intake-trace' },
    h('summary', { text: '查看识别详情' }),
    h('pre', { class: 'tn-trace-pre', 'data-test': 'intake-trace-text', text: traceText(data) })
  );
}
function openTraceModal(data) {
  const layer = h('div', { class: 'tn-modal-layer', 'data-test': 'trace-modal' });
  const close = h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '关闭', onclick: () => layer.remove() });
  layer.append(h('div', { class: 'tn-modal-mask', onclick: () => layer.remove() }), h('div', { class: 'tn-modal' },
    h('div', { class: 'tn-modal-head' }, h('h2', { text: '本次识别详情' }), h('span', { class: 'tn-grow' }), close),
    h('div', { class: 'tn-modal-body' }, h('pre', { class: 'tn-trace-pre', text: traceText(data) }))
  ));
  document.body.append(layer);
}

export async function renderReviews(container, { gen, onChanged } = {}) {
  clear(container);
  const root = h('div', { class: 'tn-reviews', 'data-test': 'reviews-view' });
  container.append(root);
  const notices = h('div', {});
  const list = h('div', {});
  const total = h('span', { class: 'tn-muted tn-small', 'data-test': 'review-total' });
  const refresh = h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '刷新', 'data-test': 'reviews-refresh', onclick: () => load() });
  root.append(h('div', { class: 'tn-toolbar' }, h('strong', { text: '待确认' }), total, h('span', { class: 'tn-grow' }), refresh), notices, list);
  let items = [];
  let seq = 0;
  const active = () => !isStale(gen) && root.isConnected;

  async function load() {
    const request = ++seq;
    try {
      const collected = [];
      let cursor = null;
      do {
        const page = await api.get('/api/v1/review-items?status=open&limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        if (!active() || request !== seq) return;
        collected.push(...(page.data || []));
        cursor = page.page?.next_cursor || null;
      } while (cursor);
      items = collected;
      total.textContent = `${items.length} 条`;
      render();
    } catch (err) {
      if (active()) toast('无法加载待确认：' + humanError(err), 'err');
    }
  }
  function notify() { if (active() && onChanged) onChanged(); }
  function render() {
    clear(list);
    if (!items.length) {
      list.append(h('div', { class: 'tn-empty', 'data-test': 'reviews-empty' },
        h('p', { text: '没有待确认项' }),
        h('p', { class: 'tn-small tn-muted', text: '插件采集和邮件同步的新线索会出现在这里。' })));
      return;
    }
    for (const item of items) list.append(card(item));
  }
  function undoNotice(review, result) {
    if (!active()) return;
    const resolution = result?.review?.resolution || null;
    if (!resolution?.undo_until) return;
    const banner = h('div', { class: 'tn-banner info' });
    const button = h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '撤销（10 秒内）', 'data-test': 'review-undo', onclick: async () => {
      button.disabled = true;
      try {
        await api.post(`/api/v1/review-items/${review.id}/undo`, { expected_version: result.review.version }, { idempotencyKey: idemKey('review-undo') });
        banner.remove(); toast('已撤销，待确认项已恢复', 'ok'); notify(); await load();
      } catch (err) { button.disabled = false; toast(humanError(err), 'err'); if (err?.status === 409) await load(); }
    } });
    const traceButton = result?.trace
      ? h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '查看识别详情', 'data-test': 'review-trace', onclick: () => openTraceModal(result) })
      : null;
    banner.append(h('span', { text: '已入账。' }), button, traceButton);
    notices.prepend(banner);
    setTimeout(() => banner.remove(), Math.max(0, Date.parse(resolution.undo_until) - Date.now()));
  }
  function showTraceBanner(result) {
    if (!active() || !result?.trace) return;
    const banner = h('div', { class: 'tn-banner info', 'data-test': 'review-saved-banner' },
      h('span', { text: '已入账。' }),
      h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '查看识别详情', 'data-test': 'review-saved-trace', onclick: () => openTraceModal(result) })
    );
    notices.prepend(banner);
  }
  function titleNode(d, isMail) {
    const text = d.title || (isMail ? '招聘邮件' : '网页线索');
    if (!d.link) return h('h3', { class: 'tn-review-title', 'data-test': 'review-title', text });
    return h('h3', { class: 'tn-review-title', 'data-test': 'review-title' },
      h('a', { href: d.link, target: '_blank', rel: 'noopener noreferrer', 'data-test': 'review-title-link', text }));
  }

  function card(r) {
    const d = r.display || {};
    const isMail = d.source === 'mail';
    const el = h('div', { class: 'tn-review-card', 'data-test': 'review-card', 'data-review-id': r.id, 'data-source': d.source || 'unknown' });
    const meta = [];
    if (d.site_name) meta.push(d.site_name);
    if (d.company) meta.push(d.company);
    if (d.location) meta.push(d.location);
    if (d.recruitment_batch) meta.push(d.recruitment_batch);
    if (d.salary) meta.push(d.salary);
    el.append(h('div', { class: 'tn-review-source-row' },
      h('span', { class: `tn-source-pill ${isMail ? 'source-mail' : 'source-plugin'}`, 'data-test': 'review-source', text: d.source_label || (isMail ? '邮件' : '插件') }),
      meta.length ? h('span', { class: 'tn-small tn-muted', text: meta.join(' · ') }) : null,
      h('span', { class: 'tn-grow' }),
      d.time ? h('span', { class: 'tn-small tn-faint', text: `${d.time_label || '时间'} ${fmtDateTime(d.time)}` }) : null
    ));
    el.append(titleNode(d, isMail));
    const subtitle = [d.company, d.job_title && d.job_title !== d.title ? d.job_title : null].filter(Boolean).join(' · ');
    if (subtitle) el.append(h('p', { class: 'tn-small tn-muted', 'data-test': 'review-subtitle', text: subtitle }));
    const preview = String(d.preview || '').trim();
    if (preview) el.append(h('p', { class: 'tn-review-preview', 'data-test': 'review-preview', text: preview.slice(0, MAX_PREVIEW) }));
    else el.append(h('p', { class: 'tn-small tn-muted', 'data-test': 'review-no-body', text: isMail && d.read_mode === 'headers_only' ? '该邮箱连接只读取邮件头，未保存正文。' : '这条线索没有保存到正文，可打开原网页核对。' }));

    const errBox = h('div', { 'data-test': 'review-error' });
    const confirm = h('button', { class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', text: '确认入账', 'data-test': 'review-confirm' });
    const dismiss = h('button', { class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', text: '忽略', 'data-test': 'review-dismiss' });
    const actions = h('div', { class: 'tn-review-actions' }, confirm, dismiss);
    el.append(actions, errBox);

    async function runIntake() {
      if (!active() || confirm.disabled) return;
      errBox.replaceChildren();
      confirm.disabled = true; dismiss.disabled = true; confirm.textContent = '识别中…';
      try {
        const res = await api.post(`/api/v1/review-items/${r.id}/intake`, { expected_version: r.version }, { idempotencyKey: idemKey('review-intake'), timeoutMs: 60000 });
        const data = res.data || {};
        if (data.state === 'applied') {
          const app = data.application;
          toast(app ? `已入账：${[app.company_name, app.job_title].filter(Boolean).join(' · ')}` : '已入账', 'ok');
          undoNotice(r, data); notify(); await load();
        } else if (data.state === 'needs_input') {
          openIntakeModal(data);
        } else if (data.state === 'failed') {
          errBox.append(show(data.message || '识别/核验失败，未创建台账；可以重试或手动填写。'));
          errBox.append(traceBox(data));
          showRetryManual(data);
        } else {
          errBox.append(show('识别完成但没有可入账结果，请重试或手动填写。'));
          showRetryManual(data);
        }
      } catch (err) {
        if (err?.status === 409) {
          toast(humanError(err), 'err'); await load();
        } else {
          errBox.append(show(humanError(err)));
          showRetryManual();
        }
      } finally {
        if (el.isConnected) { confirm.disabled = false; dismiss.disabled = false; confirm.textContent = '确认入账'; }
      }
    }
    function showRetryManual(failed = null) {
      const retry = h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '重试识别', 'data-test': 'review-retry', onclick: () => runIntake() });
      const manual = h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '手动填写', 'data-test': 'review-manual', onclick: () => openIntakeModal({
        review: { id: r.id, version: r.version },
        fields: failed?.fields || { company_name: validField(d.company) ? d.company : '', job_title: validField(d.job_title) ? d.job_title : '', status: '', applied_at_hint: d.applied_at_hint, applied_at_precision_hint: d.applied_at_precision_hint },
        missing: failed?.missing || ['company_name', 'job_title', 'status'],
        candidates: failed?.candidates || (d.matched_application ? [{ application_id: d.matched_application.id, application_version: d.matched_application.version, company_name: d.matched_application.company_name, job_title: d.matched_application.job_title, status: d.matched_application.status }] : []),
        source: failed?.source || { title: d.title, subject: d.subject, body: d.full_text || d.preview, link: d.link },
        analysis: failed?.analysis || null
      }) });
      errBox.append(h('div', { class: 'tn-action-row' }, retry, manual));
    }
    confirm.addEventListener('click', runIntake);
    async function dismissReview() {
      if (!active()) return;
      dismiss.disabled = true;
      try {
        await api.post(`/api/v1/review-items/${r.id}/resolve`, { action: 'dismiss', expected_version: r.version }, { idempotencyKey: idemKey('review-dismiss') });
        toast('已忽略', 'ok'); notify(); await load();
      } catch (err) { dismiss.disabled = false; errBox.append(show(humanError(err))); }
    }
    dismiss.addEventListener('click', dismissReview);
    return el;
  }

  function openIntakeModal(data) {
    const fields = data.fields || {};
    const source = data.source || {};
    const analysis = data.analysis || null;
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    let idem = idemKey('review-save');
    const layer = h('div', { class: 'tn-modal-layer', 'data-test': 'intake-modal' });
    const mask = h('div', { class: 'tn-modal-mask' });
    const company = h('input', { class: 'tn-input', 'data-test': 'intake-company', value: fields.company_name || '', placeholder: '必填，如：招商银行' });
    const title = h('input', { class: 'tn-input', 'data-test': 'intake-title', value: fields.job_title || '', placeholder: '必填，如：数据产品实习生' });
    const status = h('select', { class: 'tn-select', 'data-test': 'intake-status' });
    status.append(h('option', { value: '', text: '请选择状态（必选）' }));
    for (const [value, label] of STATUS_OPTIONS) status.append(h('option', { value, text: label }));
    status.value = fields.status || '';
    const date = h('input', { class: 'tn-input', type: 'date', 'data-test': 'intake-applied-at', value: fields.applied_at_hint ? ymd(fields.applied_at_hint) : '' });
    const dateWrap = h('div', { 'data-test': 'intake-date-wrap', hidden: !APPLIED_LIKE.has(status.value) }, h('label', {}, '实际投递日期', date));
    const candidate = h('select', { class: 'tn-select', 'data-test': 'intake-candidate' });
    if (candidates.length) {
      candidate.append(h('option', { value: '', text: '不关联已有记录，创建新记录' }));
      for (const c of candidates) candidate.append(h('option', { value: c.application_id, text: `${[c.company_name, c.job_title].filter(Boolean).join(' · ') || c.application_id} ${c.has_applied ? '（已投递）' : ''}` }));
      const chosen = data.target?.id || (candidates.length === 1 && data.analysis?.candidate_confidence >= 0.6 ? candidates[0].application_id : '');
      candidate.value = chosen || '';
    }
    const err = h('div', { 'data-test': 'intake-error' });
    const companyErr = h('div', { class: 'tn-field-error', 'data-test': 'intake-company-error' });
    const titleErr = h('div', { class: 'tn-field-error', 'data-test': 'intake-title-error' });
    const statusErr = h('div', { class: 'tn-field-error', 'data-test': 'intake-status-error' });
    const dateErr = h('div', { class: 'tn-field-error', 'data-test': 'intake-date-error' });
    const save = h('button', { class: 'tn-btn tn-btn-primary', type: 'button', text: '保存并入账', 'data-test': 'intake-save' });
    const cancel = h('button', { class: 'tn-btn', type: 'button', text: '取消', 'data-test': 'intake-cancel' });
    const sourceBody = source.body ? h('p', { class: 'tn-review-preview', text: String(source.body).slice(0, 1200) }) : h('p', { class: 'tn-small tn-muted', text: '原始正文未保存；请以标题/邮件头为准，不足时请手动填写。' });
    const sourceBox = h('details', { class: 'tn-modal-source', 'data-test': 'intake-source' },
      h('summary', { text: '原始标题/正文摘要' }),
      h('div', { class: 'tn-small tn-muted', text: source.title || source.subject || '—' }),
      sourceBody,
      source.link ? h('a', { class: 'tn-btn tn-btn-sm', href: source.link, target: '_blank', rel: 'noopener noreferrer', text: '打开原始页面' }) : null
    );
    const hint = analysis?.status_suggestion
      ? h('p', { class: 'tn-small tn-muted', text: `模型建议状态：${STATUS_LABELS[analysis.status_suggestion] || analysis.status_suggestion}${analysis.status_probabilities ? '' : '（需你确认）'}` })
      : null;
    const modal = h('div', { class: 'tn-modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'tn-modal-head' }, h('div', { class: 'tn-grow' }, h('h2', { text: '补全后入账' }), h('div', { class: 'tn-modal-sub', text: '公司与岗位必填；只补充缺失或纠正错误，已识别内容可编辑。' }))),
      h('div', { class: 'tn-modal-body' },
        h('div', { class: 'tn-form-grid' },
          h('label', {}, h('span', { text: '公司 *' }), company, companyErr),
          h('label', {}, h('span', { text: '岗位 *' }), title, titleErr),
          h('label', {}, h('span', { text: '投递状态 *' }), status, hint, statusErr),
          h('label', {}, dateWrap, dateErr),
          candidates.length ? h('label', {}, '关联已有台账', candidate) : null
        ),
        sourceBox, data.trace ? traceBox(data) : null, err),
      h('div', { class: 'tn-modal-foot' }, cancel, save)
    );
    layer.append(mask, modal);
    document.body.append(layer);
    status.addEventListener('change', () => { dateWrap.hidden = !APPLIED_LIKE.has(status.value); if (!dateWrap.hidden && !date.value && fields.applied_at_hint) date.value = ymd(fields.applied_at_hint); });
    function close() { layer.remove(); }
    cancel.addEventListener('click', close);
    save.addEventListener('click', async () => {
      err.replaceChildren(); companyErr.textContent = ''; titleErr.textContent = ''; statusErr.textContent = ''; dateErr.textContent = '';
      if (!validField(company.value)) { companyErr.textContent = '请填写有效公司名，不能使用“待补充/未知/面试”等占位词'; company.focus(); return; }
      if (!validField(title.value)) { titleErr.textContent = '请填写有效岗位名，不能使用“待补充/未知/面试”等占位词'; title.focus(); return; }
      if (!status.value) { statusErr.textContent = '请选择投递状态'; status.focus(); return; }
      if (APPLIED_LIKE.has(status.value) && !date.value && !fields.applied_at_hint) { dateErr.textContent = '请填写实际投递日期；不会用确认时间代替'; date.focus(); return; }
      const chosen = candidate.value ? candidates.find((c) => c.application_id === candidate.value) : null;
      const appliedAt = date.value ? dateToIso(date.value) : (fields.applied_at_hint || null);
      const payload = {
        status: status.value,
        expected_version: data.review?.version,
        changes: {
          company_name: company.value.trim(),
          job_title: title.value.trim(),
          ...(chosen ? {} : {})
        },
        ...(chosen ? { application_id: chosen.application_id, expected_application_version: chosen.application_version } : {}),
        ...(appliedAt ? { applied_at: appliedAt, applied_at_precision: fields.applied_at_precision_hint || 'date' } : {})
      };
      save.disabled = true; cancel.disabled = true; save.textContent = '保存中…';
      try {
        const res = await api.post(`/api/v1/review-items/${data.review.id}/assign`, payload, { idempotencyKey: idem, timeoutMs: 30000 });
        const result = res.data || {};
        close();
        toast('已入账', 'ok');
        showTraceBanner({ ...result, trace: data.trace, analysis: data.analysis, fields: data.fields, missing: data.missing, source: data.source });
        undoNotice({ id: data.review.id }, result);
        notify();
        await load();
      } catch (e) {
        err.replaceChildren(show(humanError(e)));
        const miss = e?.details?.missing || [];
        if (miss.includes('company_name')) company.focus();
        else if (miss.includes('job_title')) title.focus();
        else if (miss.includes('status')) status.focus();
        if (e?.status === 409) idem = idemKey('review-save');
        save.disabled = false; cancel.disabled = false; save.textContent = '保存并入账';
      }
    });
  }

  await load();
}
