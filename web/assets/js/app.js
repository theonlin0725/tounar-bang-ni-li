import { confirmPluginConnection, openSiteManager, promptPluginConnection } from './views/plugin-access.js';
/* 应用壳：会话代际守卫、路由（/ 与 /r/<token>）、顶栏、视图挂载。
   要求：退出/换号立即作废旧请求（gen 校验），不把 A 用户的数据渲染给 B。 */

import { api, onUnauthorized, errorText } from './api.js';
import { h, clear, toast, confirmDialog } from './util.js';
import { renderLogin } from './views/login.js';
import { renderLedger } from './views/ledger.js?v=20261120-1';
import { renderLanding } from './views/landing.js';
import { renderCareer } from './views/career.js';
import { renderSettingsPage } from './views/settings.js';

export const App = {
  gen: 0,
  user: null,
  view: 'boot',
  loggedIn: false
};

export function isStale(gen) { return gen !== App.gen; }

function route() {
  const match = location.pathname.match(/^\/r\/([^/]+)$/);
  if (match) return { name: 'landing', token: decodeURIComponent(match[1]) };
  const params = new URLSearchParams(location.search);
  return {
    name: 'app', panel: params.get('panel'), applicationId: params.get('app'),
    apps: params.get('apps'), view: params.get('view'), section: params.get('section'), tab: params.get('tab'), autorun: params.get('autorun')
  };
}

function rootEl() { return document.getElementById('tn-root'); }

/* 登录/换号时清空抽屉与弹窗，防止上一账号的数据残留 */
function resetOverlays() {
  for (const id of ['tn-modal-layer', 'tn-drawer-layer']) {
    const layer = document.getElementById(id);
    if (layer) { layer.hidden = true; layer.replaceChildren(); }
  }
}

export function showLogin(message) {
  App.loggedIn = false;
  App.gen += 1;
  App.view = 'login';
  resetOverlays();
  const root = rootEl();
  clear(root);
  renderLogin(root, {
    notice: message || null,
    onSuccess: (data) => {
      if (data?.user) App.user = data.user;
      return enterApp();
    }
  });
}

export async function enterApp(panel = null) {
  const gen = ++App.gen;
  App.loggedIn = true;
  App.view = 'app';
  resetOverlays();
  const root = rootEl();
  clear(root);
  try { const me = await api.get('/api/v1/me'); if (isStale(gen)) return; App.user = me.data.user; } catch (err) { if (isStale(gen)) return; if (err.status === 401) return; root.append(h('p', { text: errorText(err) })); return; }
  const currentRoute = route();
  if (currentRoute.panel === 'career' && (currentRoute.apps || currentRoute.autorun)) {
    const url = new URL(location.href);
    url.searchParams.delete('apps');
    url.searchParams.delete('autorun');
    history.replaceState({}, '', `${url.pathname}${url.search}`);
    currentRoute.apps = null;
    currentRoute.autorun = null;
  }
  const activePanel = panel || currentRoute.panel;
  const shell = buildShell({ panel: activePanel, view: currentRoute.view, section: currentRoute.section, gen });
  root.append(shell);
  const main = shell.querySelector('#tn-main');
  if (['settings', 'mail-admin', 'plugin-connect', 'plugin-sites'].includes(activePanel)) {
    const requestedTab = activePanel === 'mail-admin' ? 'mail-admin'
      : ['plugin-connect', 'plugin-sites'].includes(activePanel) ? 'data' : currentRoute.tab;
    await renderSettingsPage(main, {
      tab: requestedTab || 'reminder',
      isCurrent: () => !isStale(gen),
      onChanged: () => {}
    });
    if (isStale(gen)) return;
    if (activePanel === 'plugin-connect') confirmPluginConnection();
    else if (activePanel === 'plugin-sites') openSiteManager();
    return;
  }
  if (activePanel === 'career') {
    await renderCareer(main, {
      gen, apps: currentRoute.apps, applicationId: currentRoute.applicationId,
      section: currentRoute.section, autorun: currentRoute.autorun
    });
    if (!isStale(gen)) promptPluginConnection({automatic:true});
    return;
  }
  await renderLedger(main, {
    gen, panel: activePanel, applicationId: currentRoute.applicationId, initialView: currentRoute.view
  });
  if (isStale(gen)) return;
  if (activePanel === 'plugin-connect') confirmPluginConnection();
  else if (activePanel === 'plugin-sites') openSiteManager();
  else promptPluginConnection({automatic:true});
}

const NAV_ICONS = {
  ledger: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3.5h12v13H4zM7 7h6M7 10h6M7 13h4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  reviews: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4h12v9H9l-4 3v-3H4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M7 8h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  match: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="7" cy="10" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="13" cy="10" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M9.2 10h1.6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  resume: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3.5h7l3 3v10H5zM12 3.5v3h3M7.5 9h5M7.5 12h5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  settings: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="2.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
};
function navIcon(name) {
  const node = h('span', { class: 'tn-nav-icon' });
  node.innerHTML = NAV_ICONS[name] || '';
  return node;
}
function navLink({ href, label, test, active = false, icon = null, count = null, sub = false }) {
  return h('a', {
    class: `tn-nav-item${active ? ' active' : ''}${sub ? ' tn-nav-sub' : ''}`,
    href, ...(test ? { 'data-test': test } : {}),
    ...(active ? { 'aria-current': 'page' } : {})
  }, icon ? navIcon(icon) : h('span', { class: 'tn-nav-icon tn-nav-icon-empty' }),
  h('span', { class: 'tn-nav-label', text: label }),
  count == null ? null : h('span', { class: 'tn-nav-count', 'data-test': test ? `${test}-count` : null, text: String(count) }));
}
function navButton({ label, test, icon = null, onclick, sub = false }) {
  return h('button', {
    class: `tn-nav-item tn-nav-button${sub ? ' tn-nav-sub' : ''}`, type: 'button',
    'data-test': test,
    onclick
  }, icon ? navIcon(icon) : h('span', { class: 'tn-nav-icon tn-nav-icon-empty' }),
  h('span', { class: 'tn-nav-label', text: label }));
}
function navGroup(label) { return h('div', { class: 'tn-nav-group-label', text: label }); }

function navState({ panel, view, section }) {
  if (panel === 'career') return section === 'resume' ? 'resume' : 'match';
  if (panel === 'reviews' || view === 'reviews') return 'reviews';
  if (view === 'viewed') return 'viewed';
  if (view === 'archived') return 'archived';
  if (['settings', 'mail-admin', 'plugin-connect', 'plugin-sites'].includes(panel)) return 'settings';
  return 'applied';
}

function buildShell({ panel, view, section, gen }) {
  const nav = navState({ panel, view, section });
  const sidebar = h('aside', { class: 'tn-sidebar', id: 'tn-sidebar', 'aria-label': '主导航' });
  const brand = h('a', { class: 'tn-sidebar-brand', href: '/', 'aria-label': 'TOUNAR 帮你理首页' },
    h('span', { class: 'tn-brand-mark', text: 'T' }),
    h('span', { class: 'tn-brand-word' }, h('strong', { text: 'TOUNAR' }), h('span', { text: '帮你理' }))
  );
  const counts = { pending: null, viewed: null, archived: null };
  const pendingBadge = h('span', { class: 'tn-nav-count', 'data-test': 'sidebar-pending-count', hidden: true });
  const viewedBadge = h('span', { class: 'tn-nav-count', 'data-test': 'sidebar-viewed-count', hidden: true });
  const archivedBadge = h('span', { class: 'tn-nav-count', 'data-test': 'sidebar-archived-count', hidden: true });
  function withBadge(href, label, test, badge, icon, active = false) {
    return h('a', {
      class: `tn-nav-item${active ? ' active' : ''}`, href, 'data-test': test,
      ...(active ? { 'aria-current': 'page' } : {}),
      onclick: closeMobileNav
    }, navIcon(icon), h('span', { class: 'tn-nav-label', text: label }), badge);
  }
  const work = h('div', { class: 'tn-nav-section' },
    navGroup('工作台'),
    withBadge('/', '投递台账', 'nav-ledger', null, 'ledger', nav === 'applied'),
    withBadge('/?panel=ledger&view=viewed', '看过没投', 'nav-viewed', viewedBadge, null, nav === 'viewed'),
    withBadge('/?panel=ledger&view=archived', '已归档', 'nav-archived', archivedBadge, null, nav === 'archived')
  );
  // 待确认是一级入口，徽标只使用服务端的 counts.pending_review；失败时不显示假 0。
  const pendingLink = h('a', {
    class: `tn-nav-item${nav === 'reviews' ? ' active' : ''}`, href: '/?panel=reviews', 'data-test': 'nav-reviews',
    ...(nav === 'reviews' ? { 'aria-current': 'page' } : {}), onclick: closeMobileNav
  }, navIcon('reviews'), h('span', { class: 'tn-nav-label', text: '待确认' }), pendingBadge);
  const analysis = h('div', { class: 'tn-nav-section' },
    navGroup('分析'),
    navLink({ href: '/?panel=career&section=match', label: '匹配分析', test: 'nav-match', active: nav === 'match', icon: 'match' }),
    navLink({ href: '/?panel=career&section=resume', label: '简历库', test: 'nav-resume', active: nav === 'resume', icon: 'resume' })
  );
  const tools = h('div', { class: 'tn-nav-section' },
    navGroup('设置'),
    navLink({ href: '/?panel=settings', label: '设置', test: 'nav-settings', active: nav === 'settings', icon: 'settings' })
  );
  const account = h('div', { class: 'tn-account' },
    h('div', { class: 'tn-account-label', text: App.user?.is_admin ? '当前账号 · 管理员' : '当前账号' }),
    h('div', { class: 'tn-account-email', 'data-test': 'header-email', title: App.user?.email || '', text: App.user?.email || '' }),
    h('button', {
      class: 'tn-btn tn-btn-sm tn-btn-block', type: 'button', text: '退出登录', 'data-test': 'logout',
      onclick: async () => {
        const ok = await confirmDialog({
          title: '退出登录？',
          message: '退出后本页会清除台账缓存与在途请求。已绑定的插件设备与历史台账不受影响。',
          detail: '如需停止采集或删除数据，请到「数据与授权」面板操作。',
          confirmLabel: '退出登录'
        });
        if (!ok) return;
        try { await api.post('/api/v1/auth/logout'); } catch { /* 退出失败也回登录页 */ }
        App.user = null;
        showLogin('已退出登录');
      }
    })
  );
  sidebar.append(brand, work, pendingLink, analysis, tools, account);

  const menuButton = h('button', {
    class: 'tn-menu-button', type: 'button', 'data-test': 'sidebar-open',
    'aria-controls': 'tn-sidebar', 'aria-expanded': 'false', 'aria-label': '打开导航菜单',
    onclick: () => toggleMobileNav(true)
  }, h('span', { class: 'tn-menu-lines', 'aria-hidden': 'true' }));
  const titleFor = (view) => view === 'reviews' ? '待确认' : view === 'match' ? '匹配分析' : view === 'resume' ? '简历库'
    : view === 'viewed' ? '看过没投' : view === 'archived' ? '已归档'
      : view === 'settings' ? '设置' : '投递台账';
  const pageTitleEl = h('h1', { class: 'tn-topbar-title', 'data-test': 'page-title', text: titleFor(nav) });
  const topbar = h('header', { class: 'tn-topbar' },
    h('div', { class: 'tn-topbar-left' }, menuButton,
      h('div', {}, h('div', { class: 'tn-topbar-kicker', text: 'TOUNAR · 帮你理' }), pageTitleEl)),
    h('div', { class: 'tn-topbar-note', text: '台账与求职进展' })
  );
  const main = h('div', { class: 'tn-main', id: 'tn-main' });
  const workspace = h('div', { class: 'tn-workspace' }, topbar, main);
  const shell = h('div', { class: 'tn-shell' }, sidebar, h('div', { class: 'tn-nav-scrim', onclick: () => toggleMobileNav(false) }), workspace);
  const mobileQuery = window.matchMedia('(max-width: 900px)');

  function syncMobileFocus() {
    const mobile = mobileQuery.matches;
    const open = shell.classList.contains('nav-open');
    if (!mobile) {
      sidebar.inert = false;
      workspace.inert = false;
      sidebar.removeAttribute('aria-hidden');
      return;
    }
    sidebar.inert = !open;
    workspace.inert = open;
    if (open) sidebar.removeAttribute('aria-hidden');
    else sidebar.setAttribute('aria-hidden', 'true');
  }
  function toggleMobileNav(open) {
    const hadFocus = sidebar === document.activeElement || sidebar.contains(document.activeElement);
    shell.classList.toggle('nav-open', open);
    menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    syncMobileFocus();
    if (open) {
      sidebar.setAttribute('tabindex', '-1');
      sidebar.focus({ preventScroll: true });
    } else if (hadFocus) {
      menuButton.focus({ preventScroll: true });
    }
  }
  function closeMobileNav() {
    if (shell.classList.contains('nav-open')) toggleMobileNav(false);
  }
  function setViewChrome(view) {
    if (!view) return;
    const activeTest = { applied: 'nav-ledger', viewed: 'nav-viewed', archived: 'nav-archived', reviews: 'nav-reviews' }[view];
    for (const test of ['nav-ledger', 'nav-viewed', 'nav-archived', 'nav-reviews']) {
      const node = sidebar.querySelector(`[data-test="${test}"]`);
      if (!node) continue;
      const isActive = test === activeTest;
      node.classList.toggle('active', isActive);
      if (isActive) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    }
    for (const test of ['nav-match', 'nav-resume', 'nav-settings']) {
      const node = sidebar.querySelector(`[data-test="${test}"]`);
      if (!node) continue;
      node.classList.remove('active');
      node.removeAttribute('aria-current');
    }
    pageTitleEl.textContent = titleFor(view);
  }
  const onKey = (e) => {
    if (e.key === 'Escape' && shell.classList.contains('nav-open')) { e.preventDefault(); toggleMobileNav(false); return; }
    if (e.key !== 'Tab' || !mobileQuery.matches || !shell.classList.contains('nav-open')) return;
    const focusables = [...sidebar.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, [tabindex="0"]')]
      .filter((node) => !node.hidden && node.getClientRects().length);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!sidebar.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const onView = (event) => { if (!isStale(gen) && shell.isConnected) setViewChrome(event.detail?.view); };
  document.addEventListener('keydown', onKey);
  window.addEventListener('tounar:view', onView);
  mobileQuery.addEventListener('change', syncMobileFocus);
  syncMobileFocus();
  // 侧栏计数使用与台账相同的服务端口径；加载失败保持未知，绝不显示假 0。
  function applyCounts(next) {
    if (!next) return;
    counts.pending = next.pending_review ?? null;
    counts.viewed = next.viewed ?? null;
    counts.archived = next.archived ?? null;
    for (const [node, value] of [[pendingBadge, counts.pending], [viewedBadge, counts.viewed], [archivedBadge, counts.archived]]) {
      node.hidden = value == null;
      node.textContent = value == null ? '' : String(value);
    }
  }
  const onCounts = (event) => { if (!isStale(gen) && shell.isConnected) applyCounts(event.detail); };
  window.addEventListener('tounar:counts', onCounts);
  api.get('/api/v1/ledger?view=applied&limit=1').then((res) => {
    if (!isStale(gen) && shell.isConnected) applyCounts(res.data?.counts);
  }).catch(() => { /* 保持未知，不显示 0 */ });
  return shell;
}

/* 顶栏在进入台账前挂载（登录页/落地页无顶栏） */

async function boot() {
  const r = route();
  if (r.name === 'landing') {
    App.view = 'landing';
    await renderLanding(rootEl(), r.token);
    return;
  }
  // 主应用：先查会话，未登录不闪现上一用户台账
  try {
    const me = await api.get('/api/v1/me', { silent401: true });
    App.user = me.data.user;
    await enterApp(r.panel);
  } catch (err) {
    if (err.status === 401) {
      showLogin();
    } else {
      // 网络/503：保留会话判断，显示错误登录页（不塞演示数据）
      const root = rootEl();
      clear(root);
      renderLogin(root, {
        notice: `无法连接服务：${errorText(err)}`,
        onSuccess: (data) => {
          if (data?.user) App.user = data.user;
          return enterApp();
        }
      });
    }
  }
}

/* 401 全局处理：只在已登录且仍是当前代际时回落一次 */
onUnauthorized(() => {
  if (App.loggedIn) {
    showLogin('登录状态已失效，请重新登录');
    toast('登录状态已失效，请重新登录', 'err');
  }
});

export function setUser(user) { App.user = user; }

export const appExports = { buildShell, toast };

window.addEventListener('popstate', () => {
  if (App.loggedIn) enterApp();
  else boot();
});

boot();
