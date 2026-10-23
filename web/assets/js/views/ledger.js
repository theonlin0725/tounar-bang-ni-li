/* 单页台账：三统计 + 工具条 + 四入口 + 投递明细表 + 分页。
   口径：三统计来自同响应 stats（全台账，不随筛选变化）；筛选结果另显 filtered_total；
   所有天数按后台 Asia/Shanghai 口径；请求乱序用 reqSeq 丢弃旧响应。 */

import { api, errorText } from '../api.js';
import { App, isStale } from '../app.js';
import {
  h, clear, statusChip, fmtDateTime, daysText, debounce, extLink,
  STATUS_LABELS, STATUS_ORDER, toast, fmtDate
} from '../util.js';
import { openDetail } from './detail.js';
import { renderReviews } from './reviews.js';
import { openManual } from './manual.js';
import { openSettings } from './settings.js';

export { openSettings };

const PAGE_SIZE = 20;

export async function renderLedger(main, { gen, panel = null, applicationId = null } = {}) {
  const state = {
    view: 'applied',
    q: '', status: '', source: '', due: false,
    cursor: null, cursorStack: [],
    items: [], stats: null, counts: null, filtered_total: null,
    page: { has_more: false, next_cursor: null },
    freshness: null, as_of: null, data_revision: null,
    loading: false, error: null, errorStale: false, lastLoadedAt: null
  };
  let reqSeq = 0;
  let mounted = true;
  let checkingUpdates = false;
  let highlighted = new Set();
  let updateMessage = '';

  main.append(
    h('div', { class: 'tn-stats', id: 'tn-stats' }),
    h('div', { id: 'tn-banner' }),
    h('div', { class: 'tn-toolbar', id: 'tn-toolbar' }),
    h('div', { class: 'tn-tabs', id: 'tn-tabs' }),
    h('div', { id: 'tn-content' }),
    h('div', { class: 'tn-freshness', id: 'tn-freshness' })
  );
  const statsEl = main.querySelector('#tn-stats');
  const bannerEl = main.querySelector('#tn-banner');
  const toolbarEl = main.querySelector('#tn-toolbar');
  const tabsEl = main.querySelector('#tn-tabs');
  const contentEl = main.querySelector('#tn-content');
  const freshnessEl = main.querySelector('#tn-freshness');

  /* ---------- 三统计 ---------- */
  function renderStats() {
    clear(statsEl);
    const stats = state.stats;
    const cards = [
      ['total', '累计投递', stats?.total_applied, '全部申请（含归档与终态），不随筛选变化'],
      ['in-progress', '进行中', stats?.in_progress, '已投且处于已投递/笔试/面试'],
      ['interview', '面试中', stats?.in_interview, '进行中的子集']
    ];
    for (const [key, label, value, note] of cards) {
      statsEl.append(h('div', { class: `tn-stat${state.loading && value == null ? ' is-loading' : ''}` },
        h('div', { class: 'tn-stat-num', 'data-test': `stat-${key}`, text: value == null ? '—' : String(value) }),
        h('div', { class: 'tn-stat-label', text: label }),
        h('div', { class: 'tn-stat-note', text: note })
      ));
    }
  }

  /* ---------- 工具条 ---------- */
  const searchInput = h('input', {
    class: 'tn-input tn-search', type: 'search', placeholder: '搜索公司 / 岗位 / 城市 / 批次',
    'data-test': 'toolbar-search'
  });
  const statusSelect = h('select', { class: 'tn-select', 'data-test': 'toolbar-status' });
  statusSelect.append(h('option', { value: '', text: '全部状态' }));
  for (const s of STATUS_ORDER) statusSelect.append(h('option', { value: s, text: STATUS_LABELS[s] }));
  const sourceSelect = h('select', { class: 'tn-select', 'data-test': 'toolbar-source' });
  sourceSelect.append(
    h('option', { value: '', text: '全部来源' }),
    h('option', { value: 'plugin', text: '插件' }),
    h('option', { value: 'mail', text: '招聘邮件' }),
    h('option', { value: 'manual', text: '手动' })
  );
  const dueCheck = h('input', { type: 'checkbox', 'data-test': 'toolbar-due' });
  const dueWrap = h('label', { class: 'tn-toggle', title: '业务到期记录（与 B 邮件基础集合一致，但不等于本次可发信名单）', 'data-test': 'toolbar-due-wrap' },
    dueCheck, '待回看');
  const clearBtn = h('button', { class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', text: '清除筛选', hidden: true, 'data-test': 'toolbar-clear' });

  function buildToolbar() {
    clear(toolbarEl);
    toolbarEl.append(
      searchInput, statusSelect, sourceSelect, dueWrap, clearBtn,
      h('div', { class: 'tn-toolbar-right' },
        h('button', { class: 'tn-btn tn-btn-sm', text: '立即同步邮箱', 'data-test': 'ledger-mail-sync', onclick: async (e) => {
          const button = e.currentTarget; button.disabled = true;
          try {
            const connection = (await api.get('/api/v1/me')).data.mail_connection;
            if (!connection || connection.status === 'disconnected') { toast('请先在数据与授权中连接邮箱'); openSettingsTab('data'); return; }
            await api.post(`/api/v1/mail-connections/${encodeURIComponent(connection.id)}/sync`, {});
            toast('同步请求已受理，完成后刷新台账');
            let attempts = 0;
            const poll = async () => {
              if (isStale(gen) || !main.isConnected) return;
              const result = await api.get(`/api/v1/mail-connections/${encodeURIComponent(connection.id)}`);
              if (['connecting', 'syncing'].includes(result.data.status) && ++attempts < 30) setTimeout(() => poll().catch(() => {}), 1000);
              else { await checkUpdates(); await doLoad({ silent: true }); if (result.data.status !== 'connected') toast('邮箱同步未成功，请在数据与授权中查看原因', 'err'); }
            };
            setTimeout(() => poll().catch(() => toast('无法查询邮箱同步结果，请稍后刷新', 'err')), 500);
          } catch (err) { toast(err.message || '邮箱同步失败', 'err'); }
          finally { button.disabled = false; }
        } }),
        h('button', {
          class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'open-manual',
          title: '补录漏采岗位（与「已归档」记录入口不同）',
          onclick: () => openManual({
            onCreated: (appId) => { resetAndLoad(); if (appId) openDetailFor(appId); },
            onOpenReviews: () => switchView('reviews')
          })
        }, '+ 归档线索'),
        h('span', { class: 'tn-faint tn-tiny', text: '补录漏采岗位' })
      )
    );
  }

  /* ---------- 入口 tab ---------- */
  function buildTabs() {
    clear(tabsEl);
    const counts = state.counts || {};
    const tabs = [
      ['applied', '投递明细', null],
      ['viewed', '看过没投', counts.viewed],
      ['reviews', '待确认', counts.pending_review],
      ['archived', '已归档', counts.archived]
    ];
    for (const [id, label, count] of tabs) {
      const active = state.view === id;
      const btn = h('button', {
        class: `tn-tab${active ? ' active' : ''}`, type: 'button', 'data-test': `tab-${id}`,
        onclick: () => switchView(id)
      }, label, count != null ? h('span', { class: 'tn-tab-count', text: String(count) }) : null);
      tabsEl.append(btn);
    }
  }

  /* ---------- 表格 ---------- */
  function renderTable() {
    clear(contentEl);
    if (state.loading && !state.items.length) {
      contentEl.append(skeletonTable());
      return;
    }
    if (state.error && !state.items.length) {
      contentEl.append(h('div', { class: 'tn-table-card' }, emptyState({
        title: '数据暂不可用',
        body: state.error,
        action: h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '重试', onclick: () => doLoad() })
      })));
      return;
    }
    if (!state.items.length) {
      contentEl.append(h('div', { class: 'tn-table-card' }, emptyForView()));
      return;
    }
    const card = h('div', { class: 'tn-table-card' });
    const scroll = h('div', { class: 'tn-table-scroll' });
    const table = h('table', { class: 'tn-table', 'data-test': 'ledger-table' });
    table.append(h('thead', {}, h('tr', {},
      h('th', { text: '公司' }), h('th', { text: '岗位' }), h('th', { text: 'JD 摘要' }),
      h('th', { text: '投递渠道' }), h('th', { text: '状态' }), h('th', { text: '已投天数' }),
      h('th', { text: '投递链接' }), h('th', { text: '查看状态' }), h('th', { text: '更新时间' })
    )));
    const tbody = h('tbody', {});
    for (const item of state.items) tbody.append(renderRow(item));
    table.append(tbody);
    scroll.append(table);
    card.append(scroll, renderFooter());
    contentEl.append(card);
  }

  function renderRow(item) {
    const tr = h('tr', { class: `tn-row-click${highlighted.has(item.id) ? ' tn-row-updated' : ''}`, 'data-test': 'ledger-row', 'data-app-id': item.id });
    tr.addEventListener('click', () => openDetailFor(item.id));
    const subParts = [item.recruitment_batch, item.location].filter(Boolean);
    const roundText = item.round_label || (item.interview_round ? `${item.interview_round} 面` : null);
    tr.append(
      h('td', {}, h('div', { class: 'tn-company', title: item.company_name, text: item.company_name || '—' })),
      h('td', {}, h('div', { text: item.job_title || '—' }), subParts.length ? h('div', { class: 'tn-job-sub', text: subParts.join(' · ') }) : null),
      h('td', {}, h('div', { class: 'tn-jd clip', title: item.jd_summary || '', text: item.jd_summary || '摘要待补充' })),
      h('td', { text: item.channel || '未知' }),
      h('td', {},
        statusChip(item.status),
        roundText ? h('span', { class: 'tn-round', text: `· ${roundText}` }) : null,
        item.due_for_review && state.view === 'applied' ? h('span', { class: 'tn-flag tn-flag-due', text: '待回看' }) : null
      ),
      h('td', {}, h('span', {
        class: `tn-days${item.due_for_review ? ' tn-days-late' : ''}`,
        text: item.applied_at_precision === 'inferred_before' ? `≤ ${fmtDate(item.applied_at)}（据邮件推断）` : daysText(item.days_since_applied)
      })),
      h('td', {}, linkCell(item.job_url, '查看岗位', '链接缺失')),
      h('td', {}, statusLinkCell(item)),
      h('td', {}, h('div', { text: fmtDateTime(item.updated_at) }),
        h('div', { class: 'tn-scope-note', text: '台账更新时间' }))
    );
    return tr;
  }

  function linkCell(url, label, missing) {
    if (!url) return h('span', { class: 'tn-link-disabled', title: '记录中没有安全链接，可在详情里纠错补充', text: missing });
    const a = extLink(url, label);
    a.addEventListener('click', (e) => e.stopPropagation());
    return a;
  }

  function statusLinkCell(item) {
    const url = item.primary_status_url;
    if (!url) return h('span', { class: 'tn-link-disabled', text: '无可用链接' });
    const label = item.primary_status_url_scope === 'application' ? '申请状态页'
      : item.primary_status_url_scope === 'job' ? '岗位页（回退）' : '查看';
    const note = item.primary_status_url_scope === 'application' ? '需登录官网查看' : '回退到岗位页';
    const a = extLink(url, label);
    a.addEventListener('click', (e) => e.stopPropagation());
    return h('div', {}, a, h('div', { class: 'tn-scope-note', text: note }));
  }

  function renderFooter() {
    const f = h('div', { class: 'tn-table-footer' });
    const total = state.filtered_total ?? state.items.length;
    f.append(
      h('span', { 'data-test': 'filtered-total', text: `筛选结果 ${total} 条` }),
      h('span', { class: 'tn-spacer' }),
      h('button', {
        class: 'tn-btn tn-btn-sm', type: 'button', text: '上一页', disabled: !state.cursorStack.length,
        onclick: () => { if (!state.cursorStack.length) return; state.cursor = state.cursorStack.pop(); doLoad(); }
      }),
      h('span', { class: 'tn-faint', text: `每页 ${PAGE_SIZE} 条` }),
      h('button', {
        class: 'tn-btn tn-btn-sm', type: 'button', text: '下一页', disabled: !state.page.has_more, 'data-test': 'page-next',
        onclick: () => {
          if (!state.page.has_more) return;
          state.cursorStack.push(state.cursor);
          state.cursor = state.page.next_cursor;
          doLoad();
        }
      }),
      h('button', {
        class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', text: '刷新', 'data-test': 'refresh',
        onclick: () => doLoad({ silent: true })
      })
    );
    return f;
  }

  function skeletonTable() {
    const card = h('div', { class: 'tn-table-card' });
    const table = h('table', { class: 'tn-table' });
    const tbody = h('tbody', {});
    for (let i = 0; i < 6; i += 1) {
      tbody.append(h('tr', { class: 'tn-skeleton-row' },
        ...Array.from({ length: 6 }, () => h('td', {}, h('div', { class: 'tn-skeleton', style: { width: `${60 + Math.random() * 120}px` } })))
      ));
    }
    table.append(tbody);
    card.append(table);
    return card;
  }

  function emptyForView() {
    if (state.q || state.status || state.source || state.due) {
      return emptyState({
        title: '没有符合筛选的记录',
        body: '当前筛选条件下没有结果；这并不代表你尚未投递。',
        action: h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '清除筛选', onclick: () => { resetFilters(); doLoad(); } })
      });
    }
    if (state.view === 'viewed') {
      return emptyState({
        title: '还没有「看过没投」的线索',
        body: '插件只在页面可见累计 ≥3 秒后才记为浏览线索；3 秒浏览不会计入投递，也不会出现在「投递明细」。'
      });
    }
    if (state.view === 'archived') {
      return emptyState({
        title: '没有已归档记录',
        body: '归档不等于拒绝；归档后「累计投递」可能不变。你可以在详情里恢复归档。'
      });
    }
    return emptyState({
      title: '还没有投递记录',
      body: '安装浏览器插件后，浏览与投递会被自动记录；也可以授权 QQ 邮箱辅助更新。',
      action: h('div', { class: 'tn-action-row', style: { justifyContent: 'center' } },
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '查看安装与授权', onclick: () => openSettingsTab('data') }),
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '手动补录（次要）', onclick: () => openManual({ onCreated: () => resetAndLoad(), onOpenReviews: () => switchView('reviews') }) })
      )
    });
  }

  function emptyState({ title, body, action }) {
    return h('div', { class: 'tn-empty' }, h('h3', { text: title }), body ? h('p', { text: body }) : null, action || null);
  }

  /* ---------- 数据请求 ---------- */
  async function doLoad({ silent = false } = {}) {
    const seq = ++reqSeq;
    const myGen = gen;
    state.loading = true;
    if (!silent) { renderStats(); }
    /* 复核视图复用 contentEl：这里的空 items 只代表台账数据被清空，不能销毁复核视图。
       refreshChrome 对 reviews 提前返回，一旦清空就没有任何代码会重建它。 */
    if (!state.items.length && state.view !== 'reviews') renderTable();
    const params = new URLSearchParams();
    params.set('view', state.view === 'reviews' ? 'applied' : state.view);
    params.set('limit', String(PAGE_SIZE));
    if (state.cursor) params.set('cursor', state.cursor);
    if (state.q) params.set('q', state.q);
    if (state.status) params.set('status', state.status);
    if (state.source) params.set('source', state.source);
    if (state.due) params.set('due_for_review', 'true');
    try {
      const res = await api.get(`/api/v1/ledger?${params.toString()}`);
      if (seq !== reqSeq || isStale(myGen) || !mounted) return;
      const data = res.data;
      state.items = data.items;
      state.stats = data.stats;
      state.counts = data.counts;
      state.filtered_total = data.filtered_total;
      state.page = data.page;
      state.freshness = data.freshness;
      state.as_of = data.as_of;
      state.data_revision = data.data_revision;
      state.error = null;
      state.lastLoadedAt = new Date();
    } catch (err) {
      if (seq !== reqSeq || isStale(myGen) || !mounted) return;
      state.error = errorText(err);
    } finally {
      if (seq === reqSeq && myGen === App.gen && mounted) {
        state.loading = false;
        refreshChrome();
      }
    }
  }

  function refreshChrome() {
    renderStats();
    buildTabs();
    renderBanner();
    if (state.view === 'reviews') return;
    renderTable();
    renderFreshness();
  }

  function renderBanner() {
    clear(bannerEl);
    if (updateMessage) bannerEl.append(h('div', { class: 'tn-banner info', 'data-test': 'mail-update-banner', text: updateMessage }));
    if (state.error) {
      if (state.items.length && state.view !== 'reviews') {
        const when = state.lastLoadedAt ? `截至 ${fmtDateTime(state.lastLoadedAt.toISOString())} 的数据` : '上一次成功加载的数据';
        bannerEl.append(h('div', { class: 'tn-banner warn', 'data-test': 'stale-banner' },
          h('div', { class: 'tn-banner-body' },
            h('div', { text: `显示${when}；刷新失败：${state.error}` }),
            h('div', { class: 'tn-small', text: '页面不会把失败转成 0，也不会塞入演示数据。' })
          ),
          h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '重试', onclick: () => doLoad() })
        ));
      }
    }
    const f = state.freshness;
    if (f && (f.mail_status === 'reauth_required' || f.mail_status === 'degraded')) {
      bannerEl.append(h('div', { class: 'tn-banner warn', 'data-test': 'mail-banner' },
        h('div', { class: 'tn-banner-body', text: f.mail_status === 'reauth_required'
          ? 'QQ 邮箱授权已失效，台账可能没有新邮件更新；请到「数据与授权」重新授权。'
          : 'QQ 邮箱同步暂受阻；最近成功同步时间见页脚。' }),
        h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '去处理', onclick: () => openSettingsTab('data') })
      ));
    }
  }

  function renderFreshness() {
    clear(freshnessEl);
    const f = state.freshness || {};
    freshnessEl.append(
      h('div', { 'data-test': 'freshness', text: `数据截至 ${fmtDateTime(state.as_of)}（台账修订 r${state.data_revision ?? '—'}）` }),
      h('div', { text: `官网状态仅在你访问时采集 · 邮箱最近成功同步：${f.mail_last_success_at ? fmtDateTime(f.mail_last_success_at) : '无记录'} · 插件最近采集：${f.plugin_last_received_at ? fmtDateTime(f.plugin_last_received_at) : '无记录'}。插件写入到页面显示可能有延迟。` })
    );
  }

  /* ---------- 交互 ---------- */
  function switchView(id) {
    if (state.view === id) return;
    state.view = id;
    state.cursor = null;
    state.cursorStack = [];
    state.items = [];
    state.error = null;
    buildTabs();
    if (id === 'reviews') {
      renderBanner();
      clear(contentEl);
      renderReviews(contentEl, {
        gen,
        onChanged: () => { state.items = []; doLoad({ silent: true }); }
      });
      return;
    }
    doLoad();
  }

  function resetFilters() {
    state.q = ''; state.status = ''; state.source = ''; state.due = false;
    searchInput.value = ''; statusSelect.value = ''; sourceSelect.value = ''; dueCheck.checked = false;
    updateClearBtn();
  }

  function resetAndLoad() {
    state.cursor = null; state.cursorStack = []; state.items = [];
    doLoad();
  }

  function updateClearBtn() {
    const any = !!(state.q || state.status || state.source || state.due);
    clearBtn.hidden = !any;
  }

  function openDetailFor(id) {
    openDetail(id, { gen, onChanged: () => doLoad({ silent: true }) });
  }

  function openSettingsTab(tab) {
    openSettings({ tab, onChanged: () => doLoad({ silent: true }) });
  }

  const debouncedSearch = debounce(() => {
    state.q = searchInput.value.trim();
    state.cursor = null; state.cursorStack = [];
    updateClearBtn();
    doLoad();
  }, 300);

  searchInput.addEventListener('input', debouncedSearch);
  statusSelect.addEventListener('change', () => { state.status = statusSelect.value; state.cursor = null; state.cursorStack = []; updateClearBtn(); doLoad(); });
  sourceSelect.addEventListener('change', () => { state.source = sourceSelect.value; state.cursor = null; state.cursorStack = []; updateClearBtn(); doLoad(); });
  dueCheck.addEventListener('change', () => { state.due = dueCheck.checked; state.cursor = null; state.cursorStack = []; updateClearBtn(); doLoad(); });
  clearBtn.addEventListener('click', () => { resetFilters(); resetAndLoad(); });

  async function checkUpdates() {
    if (checkingUpdates || isStale(gen) || !main.isConnected || document.visibilityState !== 'visible') return;
    checkingUpdates = true;
    try {
      const result = (await api.get('/api/v1/ledger-updates?since=' + encodeURIComponent(state.as_of || new Date().toISOString()))).data;
      if (isStale(gen) || !main.isConnected) return;
      if (String(result.data_revision) !== String(state.data_revision)) {
        highlighted = new Set(result.mail_updates);
        updateMessage = highlighted.size ? `刚刚根据邮件更新了 ${highlighted.size} 条记录` : '';
        await doLoad({ silent: true });
      }
    } catch (err) { if (!isStale(gen)) { state.error = err.message || '检查新进展失败'; renderBanner(); } }
    finally { checkingUpdates = false; }
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible' && mounted) checkUpdates();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  const updatesTimer = setInterval(() => {
    if (isStale(gen) || !main.isConnected) { mounted = false; clearInterval(updatesTimer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); }
    else checkUpdates();
  }, 60000);

  /* ---------- 首次加载 ---------- */
  buildToolbar();
  renderStats();
  buildTabs();
  await doLoad();
  if (panel === 'reviews' && !isStale(gen)) switchView('reviews');
  if (applicationId && !isStale(gen)) openDetailFor(applicationId);
  if (panel === 'settings' && mounted) openSettingsTab('reminder');
}
