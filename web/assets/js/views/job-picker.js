import { api, errorText } from '../api.js';
import { h, clear, openModal, toast } from '../util.js';

/* v1.1.1 shared two-level job picker: applied / viewed, search + paging. */
export function openJobPicker({ selectedId = null, onSelect = () => {} } = {}) {
  let modal = null;
  let view = null;
  let query = '';
  let cursor = null;
  let loading = false;
  let done = false;
  let listEl = null;
  let countEl = null;
  let searchTimer = null;
  let requestSeq = 0;
  const initial = h('div', { class: 'tn-job-picker', 'data-test': 'job-picker' });
  const title = h('div', { class: 'tn-job-picker-title', text: '选择目标岗位' });
  const counts = { applied: null, viewed: null };
  const body = h('div', { class: 'tn-job-picker-body' });
  initial.append(title, body);
  function close() { modal?.close(); }
  function renderRoot() {
    view = null; clear(body);
    const applied = h('button', { type: 'button', class: 'tn-job-picker-choice', 'data-test': 'job-picker-applied' },
      h('strong', { text: '投递明细' }), h('span', { text: counts.applied == null ? '查看已投递岗位' : `${counts.applied} 条已投递岗位` }));
    const viewed = h('button', { type: 'button', class: 'tn-job-picker-choice', 'data-test': 'job-picker-viewed' },
      h('strong', { text: '看过没投' }), h('span', { text: counts.viewed == null ? '查看浏览过但未投递的岗位' : `${counts.viewed} 条看过没投岗位` }));
    applied.addEventListener('click', () => openList('applied'));
    viewed.addEventListener('click', () => openList('viewed'));
    body.append(
      h('button', { type: 'button', class: 'tn-job-picker-choice tn-job-picker-all', 'data-test': 'job-picker-all',
        onclick: () => { close(); onSelect(null); } }, h('strong', { text: '全部岗位' }), h('span', { text: '不绑定具体岗位' })),
      applied, viewed
    );
  }
  function openList(nextView) {
    view = nextView; query = ''; cursor = null; done = false;
    clear(body);
    const back = h('button', { type: 'button', class: 'tn-btn tn-btn-sm tn-btn-ghost', 'data-test': 'job-picker-back', text: '← 返回' });
    back.addEventListener('click', renderRoot);
    const search = h('input', { class: 'tn-input', type: 'search', placeholder: '搜索公司 / 岗位', 'data-test': 'job-picker-search' });
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { query = search.value.trim(); cursor = null; done = false; load(true); }, 220);
    });
    countEl = h('span', { class: 'tn-small tn-muted', text: '正在加载…' });
    listEl = h('div', { class: 'tn-job-picker-list', 'data-test': 'job-picker-list' });
    listEl.addEventListener('scroll', () => {
      if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 30) load(false);
    });
    const head = h('div', { class: 'tn-job-picker-list-head' }, back, h('strong', { text: nextView === 'applied' ? '投递明细' : '看过没投' }), countEl);
    body.append(head, search, listEl);
    load(true);
  }
  async function load(reset) {
    if (loading || !view || done) return;
    if (!reset && !cursor) return;
    loading = true;
    const seq = ++requestSeq;
    try {
      const params = new URLSearchParams({ view, limit: '20' });
      if (query) params.set('q', query);
      if (!reset && cursor) params.set('cursor', cursor);
      const data = (await api.get(`/api/v1/ledger?${params.toString()}`)).data;
      if (seq !== requestSeq || !listEl) return;
      if (reset) clear(listEl);
      const items = data.items || [];
      if (!items.length && reset) listEl.append(h('div', { class: 'tn-empty' }, h('p', { text: query ? '没有匹配的岗位' : '暂无岗位记录' })));
      for (const app of items) {
        const status = h('span', { class: `tn-job-picker-status status-${app.status || 'closed'}`, text: app.status_label || app.status || '—' });
        const button = h('button', { type: 'button', class: 'tn-job-picker-item', 'data-test': 'job-picker-option', 'data-job-id': app.id, 'data-job-view': view,
          onclick: () => { close(); onSelect(app); } },
        h('div', { class: 'tn-job-picker-item-main' },
          h('strong', { text: `${app.company_name || '未命名公司'} · ${app.job_title || '岗位'}` }),
          h('span', { class: 'tn-small tn-muted', text: [app.location, app.recruitment_batch].filter(Boolean).join(' · ') || '城市/批次待补' })),
        status);
        if (app.id === selectedId) button.classList.add('selected');
        listEl.append(button);
      }
      cursor = data.page?.next_cursor || null;
      done = !data.page?.has_more;
      if (countEl) countEl.textContent = `${data.filtered_total ?? data.items?.length ?? 0} 条`;
      listEl.querySelectorAll('.tn-job-picker-more').forEach((node) => node.remove());
      if (!done) listEl.append(h('button', { type: 'button', class: 'tn-btn tn-btn-sm tn-job-picker-more', 'data-test': 'job-picker-more', text: '加载更多', onclick: () => load(false) }));
    } catch (error) {
      if (seq === requestSeq) toast(`岗位加载失败：${errorText(error)}`, 'err');
    } finally {
      if (seq === requestSeq) loading = false;
    }
  }
  modal = openModal({
    title: '选择岗位', subtitle: '按投递明细或看过没投分类浏览', testid: 'job-picker-modal',
    body: initial,
    footer: h('button', { type: 'button', class: 'tn-btn tn-btn-sm', text: '关闭', onclick: close })
  });
  renderRoot();
  Promise.all([
    api.get('/api/v1/ledger?view=applied&limit=1').then((r) => { counts.applied = r.data?.counts?.total_applied ?? r.data?.stats?.total_applied ?? null; }).catch(() => {}),
    api.get('/api/v1/ledger?view=viewed&limit=1').then((r) => { counts.viewed = r.data?.counts?.viewed ?? r.data?.stats?.viewed ?? null; }).catch(() => {})
  ]).then(() => { if (!view) renderRoot(); });
  return { close };
}
