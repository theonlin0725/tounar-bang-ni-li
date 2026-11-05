/* 应用壳：会话代际守卫、路由（/ 与 /r/<token>）、顶栏、视图挂载。
   要求：退出/换号立即作废旧请求（gen 校验），不把 A 用户的数据渲染给 B。 */

import { api, onUnauthorized, errorText } from './api.js';
import { h, clear, toast, confirmDialog } from './util.js';
import { renderLogin } from './views/login.js';
import { renderLedger, openSettings } from './views/ledger.js?v=20261102-1';
import { renderLanding } from './views/landing.js';
import { renderMailAdmin } from './views/mail-admin.js';
import { renderCareer } from './views/career.js';
import { pluginDownloadLink, openPluginHelp } from './views/plugin-help.js';

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
  return { name: 'app', panel: params.get('panel'), applicationId: params.get('app'), apps: params.get('apps') };
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
  root.append(buildHeader());
  const main = h('div', { class: 'tn-main', id: 'tn-main' });
  root.append(main);
  const currentRoute = route();
  if ((panel || currentRoute.panel) === 'mail-admin') {
    await renderMailAdmin(main, { isCurrent: () => !isStale(gen) });
    return;
  }
  if ((panel || currentRoute.panel) === 'career') {
    await renderCareer(main, { gen, apps: currentRoute.apps });
    return;
  }
  await renderLedger(main, { gen, panel: panel || currentRoute.panel, applicationId: currentRoute.applicationId });
}

function buildHeader() {
  const wrap = h('div', { class: 'tn-header' });
  const inner = h('div', { class: 'tn-header-inner' },
    h('div', { class: 'tn-header-brand', text: 'Tounar · 帮你理' }),
    h('div', { class: 'tn-header-user' },
      h('span', { class: 'tn-header-email', 'data-test': 'header-email', text: App.user?.email || '' }),
      pluginDownloadLink({ label: '下载插件', test: 'download-plugin' }),
      h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '安装指引', 'data-test': 'plugin-help', onclick: openPluginHelp }),
      h('a', { class: 'tn-btn tn-btn-sm', href: '/?panel=career', text: '简历与 AI', 'data-test': 'open-career' }),
      h('button', {
        class: 'tn-btn tn-btn-sm', type: 'button', text: '提醒设置', 'data-test': 'open-settings-reminder',
        onclick: () => openSettings({ tab: 'reminder' })
      }),
      h('button', {
        class: 'tn-btn tn-btn-sm', type: 'button', text: '数据与授权', 'data-test': 'open-settings-data',
        onclick: () => openSettings({ tab: 'data' })
      }),
      App.user?.is_admin ? h('a', { class: 'tn-btn tn-btn-sm', href: '/?panel=mail-admin', text: '邮件测试与模板', 'data-test': 'open-mail-admin' }) : null,
      h('button', {
        class: 'tn-btn tn-btn-sm', type: 'button', text: '退出登录', 'data-test': 'logout',
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
    )
  );
  wrap.append(inner);
  return wrap;
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

export const appExports = { buildHeader, toast };

boot();
