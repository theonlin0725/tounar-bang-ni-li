/* 手动补录（“归档线索”）：漏采岗位的次要入口。D12 未冻结时严格必填，不静默放宽。
   幂等：每次打开弹窗一个 key；内容变化导致冲突时换新 key 并提示重新提交。 */

import { api, ApiError, errorText } from '../api.js';
import { h, clear, toast, openModal, idemKey, STATUS_LABELS, STATUS_ORDER } from '../util.js';

const APPLIED_STATUSES = ['applied', 'assessment', 'interview', 'offer', 'rejected', 'closed'];

export function openManual({ onCreated, onOpenReviews } = {}) {
  let idempotencyKey = idemKey('manual');
  let busy = false;
  const errBox = h('div', { 'data-test': 'manual-error' });

  const company = h('input', { class: 'tn-input', 'data-test': 'manual-company', placeholder: '如：示例科技' });
  const title = h('input', { class: 'tn-input', 'data-test': 'manual-title', placeholder: '如：前端开发工程师' });
  const channel = h('input', { class: 'tn-input', value: '手动', placeholder: '如：官网 / 内推 / 招聘平台' });
  const hasApplied = h('input', { type: 'checkbox', checked: true, 'data-test': 'manual-has-applied' });
  const statusSel = h('select', { class: 'tn-select', 'data-test': 'manual-status' });
  const precisionSel = h('select', { class: 'tn-select' });
  precisionSel.append(h('option', { value: 'date', text: '仅日期（日期级）' }), h('option', { value: 'exact', text: '精确到分' }));
  const dateInput = h('input', { class: 'tn-input', type: 'date', 'data-test': 'manual-applied-date' });
  const datetimeInput = h('input', { class: 'tn-input', type: 'datetime-local', hidden: true });
  const jdInput = h('textarea', { class: 'tn-textarea', placeholder: '纯文本，最多 80 字', maxlength: '80' });
  const jobUrlInput = h('input', { class: 'tn-input', type: 'url', placeholder: 'https://…' });
  const locationInput = h('input', { class: 'tn-input', placeholder: '如：上海' });
  const batchInput = h('input', { class: 'tn-input', placeholder: '如：2027 届秋招' });
  const statusUrlInput = h('input', { class: 'tn-input', type: 'url', placeholder: 'https://…（可选）' });
  const scopeSel = h('select', { class: 'tn-select' });
  scopeSel.append(h('option', { value: '', text: '（未指定）' }), h('option', { value: 'application', text: '申请状态页' }), h('option', { value: 'job', text: '岗位页' }));
  const roundInput = h('input', { class: 'tn-input', type: 'number', min: '1', placeholder: '如 2' });
  const roundLabelInput = h('input', { class: 'tn-input', placeholder: '如：二面 / HR 面' });

  /* 自动填充：优先用插件已经采集到的线索，用户只补投递时间（D12 的手动兜底定位） */
  const fillSel = h('select', { class: 'tn-select', 'data-test': 'manual-autofill' });
  fillSel.append(h('option', { value: '', text: '从插件采集到的线索自动填充…' }));
  let fillItems = [];
  (async () => {
    try {
      const res = await api.get('/api/v1/ledger?view=viewed&limit=30');
      fillItems = res.data?.items || [];
      if (!fillItems.length) {
        fillSel.append(h('option', { value: '', text: '暂无插件线索（插件采集过的岗位会自动出现在这里）' }));
        return;
      }
      for (const it of fillItems) {
        const seen = it.last_viewed_at ? new Date(it.last_viewed_at).toLocaleDateString('zh-CN') : '';
        fillSel.append(h('option', { value: it.id, text: `${it.company_name || '—'} · ${it.job_title || '—'}${seen ? `（${seen} 看过）` : ''}` }));
      }
    } catch {
      fillSel.append(h('option', { value: '', text: '线索列表加载失败，可手动填写' }));
    }
  })();
  fillSel.addEventListener('change', () => {
    const item = fillItems.find((x) => x.id === fillSel.value);
    if (!item) return;
    company.value = item.company_name || '';
    title.value = item.job_title || '';
    if (item.jd_summary) jdInput.value = item.jd_summary;
    if (item.job_url) jobUrlInput.value = item.job_url;
    if (item.location) locationInput.value = item.location;
    if (item.recruitment_batch) batchInput.value = item.recruitment_batch;
    if (item.channel) channel.value = item.channel;
    if (item.status_url) statusUrlInput.value = item.status_url;
    if (item.status_url_scope) scopeSel.value = item.status_url_scope;
    toast('已自动填充，通常只需再补投递时间', 'ok');
  });

  const hintBox = h('div', { class: 'tn-hint' });
  const dateField = h('div', { class: 'tn-field' },
    h('label', { text: '投递时间' }),
    h('div', { class: 'tn-row' }, h('div', { class: 'tn-grow' }, dateInput), precisionSel),
    hintBox
  );

  function syncStatusOptions() {
    const applied = hasApplied.checked;
    const prev = statusSel.value;
    clear(statusSel);
    const options = applied ? APPLIED_STATUSES : ['pending', 'closed'];
    for (const s of options) statusSel.append(h('option', { value: s, text: STATUS_LABELS[s] }));
    statusSel.value = options.includes(prev) ? prev : options[0];
    dateField.querySelector('label').textContent = applied ? '投递时间（已投必填，D12）' : '投递时间（可选）';
    hintBox.textContent = applied
      ? 'D12 未冻结：缺少可信投递时间会被拒绝（422），不会用今天或入库时间替代。'
      : '未确认正式申请时，状态只能是「待投递」或「已结束」。';
  }
  hasApplied.addEventListener('change', syncStatusOptions);
  syncStatusOptions();

  precisionSel.addEventListener('change', () => {
    const exact = precisionSel.value === 'exact';
    dateInput.hidden = exact;
    datetimeInput.hidden = !exact;
  });

  function field(label, node, hint) {
    return h('div', { class: 'tn-field' }, h('label', { text: label }), node,
      hint ? h('div', { class: 'tn-hint', text: hint }) : null);
  }

  const body = h('div', {},
    h('p', { class: 'tn-small tn-muted', style: { marginTop: '0' } },
      '用于补录插件漏采的岗位。D13 未冻结：“归档线索”是本次补录动作，不等于把记录归档；也不代表已投。'),
    h('div', { class: 'tn-field', style: { marginBottom: '4px' } },
      h('label', { text: '自动填充（可选）' }),
      fillSel,
      h('div', { class: 'tn-hint', text: '正常情况插件会自动采集；这里先选一条插件线索自动填好公司/岗位/JD/链接，你只补投递时间。插件没采到时才需要手动填。' })
    ),
    h('div', { class: 'tn-form-grid' },
      field('公司名 *', company),
      field('岗位名 *', title),
      field('投递渠道', channel),
      h('div', { class: 'tn-field' },
        h('label', { text: '是否已正式申请' }),
        h('label', { class: 'tn-check', style: { margin: '0' } }, hasApplied, '已确认提交过申请（计入累计投递）')
      ),
      field('状态', statusSel),
      dateField
    ),
    h('div', { class: 'tn-form-grid', style: { marginTop: '12px' } },
      field('城市（可选）', locationInput),
      field('招聘批次（可选）', batchInput)
    ),
    field('岗位链接（D12 必填）', jobUrlInput, '只接受安全的 http(s) 链接'),
    field('JD 摘要（D12 必填）', jdInput, '只保存纯文本；不会渲染网页 HTML'),
    h('details', { style: { marginTop: '6px' } },
      h('summary', { class: 'tn-small tn-muted', text: '更多字段（可选）' }),
      h('div', { class: 'tn-form-grid', style: { marginTop: '10px' } },
        field('状态链接', statusUrlInput),
        field('状态链接类型', scopeSel),
        field('面次', roundInput),
        field('面次标签', roundLabelInput)
      )
    ),
    errBox
  );

  const submitBtn = h('button', {
    class: 'tn-btn tn-btn-primary', type: 'button', text: '保存到台账', 'data-test': 'manual-submit',
    onclick: () => submit()
  });

  const modal = openModal({
    title: '归档线索（补录漏采岗位）',
    subtitle: '这是次要入口：正常情况下，插件与邮件会自动记录。',
    body,
    footer: [h('button', { class: 'tn-btn', type: 'button', text: '取消', onclick: () => modal.close() }), submitBtn],
    testid: 'manual-modal'
  });

  function showError(message, missing = []) {
    clear(errBox);
    errBox.append(h('div', { class: 'tn-inline-msg err', 'data-test': 'manual-error-msg', text: message }));
    for (const key of missing) {
      const map = { applied_at: dateInput, jd_summary: jdInput, job_url: jobUrlInput };
      const node = map[key];
      if (node) { node.classList.add('err'); node.focus(); break; }
    }
  }

  function clearFieldErrors() {
    for (const node of [company, title, dateInput, datetimeInput, jdInput, jobUrlInput]) node.classList.remove('err');
    clear(errBox);
  }

  async function submit() {
    if (busy) return;
    clearFieldErrors();
    const companyName = company.value.trim();
    const jobTitle = title.value.trim();
    if (!companyName) { company.classList.add('err'); showError('请填写公司名'); company.focus(); return; }
    if (!jobTitle) { title.classList.add('err'); showError('请填写岗位名'); title.focus(); return; }

    const payload = {
      company_name: companyName,
      job_title: jobTitle,
      channel: channel.value.trim() || '手动',
      has_applied: hasApplied.checked,
      status: statusSel.value
    };
    if (hasApplied.checked) {
      if (precisionSel.value === 'exact') {
        if (!datetimeInput.value) { showError('请填写投递时间（精确到分）', ['applied_at']); return; }
        payload.applied_at = new Date(`${datetimeInput.value}:00+08:00`).toISOString();
        payload.applied_at_precision = 'exact';
      } else {
        if (!dateInput.value) { showError('请填写投递日期（D12 未冻结，不能用今天代替）', ['applied_at']); return; }
        payload.applied_date = dateInput.value;
        payload.applied_at_precision = 'date';
      }
    } else if (precisionSel.value === 'exact' && datetimeInput.value) {
      payload.applied_at = new Date(`${datetimeInput.value}:00+08:00`).toISOString();
      payload.applied_at_precision = 'exact';
    } else if (dateInput.value) {
      payload.applied_date = dateInput.value;
      payload.applied_at_precision = 'date';
    }
    if (!jdInput.value.trim()) { jdInput.classList.add('err'); showError('缺少 JD 摘要：D12 未冻结，不会静默放宽必填要求。', ['jd_summary']); jdInput.focus(); return; }
    payload.jd_summary = jdInput.value.trim();
    if (!jobUrlInput.value.trim()) { jobUrlInput.classList.add('err'); showError('缺少岗位链接：D12 未冻结，不会静默放宽必填要求。', ['job_url']); jobUrlInput.focus(); return; }
    payload.job_url = jobUrlInput.value.trim();
    if (locationInput.value.trim()) payload.location = locationInput.value.trim();
    if (batchInput.value.trim()) payload.recruitment_batch = batchInput.value.trim();
    if (statusUrlInput.value.trim()) payload.status_url = statusUrlInput.value.trim();
    if (scopeSel.value) payload.status_url_scope = scopeSel.value;
    if (roundInput.value) payload.interview_round = Number(roundInput.value);
    if (roundLabelInput.value.trim()) payload.round_label = roundLabelInput.value.trim();

    busy = true;
    submitBtn.disabled = true;
    submitBtn.textContent = '保存中…';
    try {
      const res = await api.post('/api/v1/applications/manual', payload, { idempotencyKey });
      const app = res.data;
      toast('已保存到台账', 'ok');
      modal.close();
      if (onCreated) onCreated(app?.id || null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.code === 'D12_NOT_FROZEN') {
        const missing = err.details?.missing || [];
        showError(err.message || '缺少 D12 必填字段，未冻结前不会放宽。', missing);
      } else if (err instanceof ApiError && err.status === 409 && err.details?.candidates?.length) {
        clear(errBox);
        errBox.append(h('div', { class: 'tn-inline-msg err', text: '发现可能重复的记录，不能强行新增。请到「待确认」处理，或从详情核对后再补录。' }));
        const list = h('div', { class: 'tn-small tn-muted', style: { marginTop: '6px' } });
        for (const c of err.details.candidates) list.append(h('div', { text: `候选记录 ${c.application_id}（匹配：${c.reason}）` }));
        errBox.append(list);
        if (onOpenReviews) {
          errBox.append(h('button', {
            class: 'tn-btn tn-btn-sm', type: 'button', text: '去「待确认」处理',
            onclick: () => { modal.close(); onOpenReviews(); }
          }));
        }
      } else if (err instanceof ApiError && err.code === 'IDEMPOTENCY_CONFLICT') {
        idempotencyKey = idemKey('manual');
        showError('表单内容已变化，请再次点击「保存到台账」（已生成新的幂等键，不会重复写入旧内容）。');
      } else {
        showError(errorText(err));
      }
    } finally {
      busy = false;
      submitBtn.disabled = false;
      submitBtn.textContent = '保存到台账';
    }
  }
}
