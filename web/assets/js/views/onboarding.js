/* v1.1.4 first-run progressive guide. Per-user localStorage only; never gates
 * normal navigation and never sends credentials. */
import { api } from '../api.js';
import { h, clear } from '../util.js';
import { PLUGIN_VERSION, pluginDownloadLink } from './plugin-help.js?v=20261124-1';

const KEY_PREFIX = 'tounar.onboarding.v114.';
function keyFor(email) { return KEY_PREFIX + String(email || 'anonymous'); }
function readState(email) {
  try {
    const raw = localStorage.getItem(keyFor(email));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writeState(email, state) {
  try { localStorage.setItem(keyFor(email), JSON.stringify(state)); } catch { /* storage unavailable */ }
}
function probeExtension() {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { window.removeEventListener('message', receive); resolve(null); }, 1200);
    function receive(event) {
      if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'tounar-access-response' || event.data.id !== id) return;
      clearTimeout(timer); window.removeEventListener('message', receive);
      resolve(event.data.ok ? event.data.data : null);
    }
    window.addEventListener('message', receive);
    window.postMessage({ channel: 'tounar-access-request', id, action: 'discovery', payload: {} }, location.origin);
  });
}
function pulseDemo() {
  return h('div', { class: 'tn-onboarding-demo', 'aria-hidden': 'true' },
    h('div', { class: 'tn-onboarding-window' }, h('div', { class: 'tn-onboarding-dot' }), h('div', { class: 'tn-onboarding-line' }), h('div', { class: 'tn-onboarding-line short' })),
    h('div', { class: 'tn-onboarding-float' }, h('span', { text: '岗位已收纳' })),
    h('div', { class: 'tn-onboarding-ledger-card' }, h('strong', { text: '字节跳动 · 产品经理' }), h('span', { text: '看过没投' }))
  );
}
function mailDemo() {
  return h('div', { class: 'tn-onboarding-demo mail', 'aria-hidden': 'true' },
    h('div', { class: 'tn-onboarding-envelope', text: '✉' }),
    h('div', { class: 'tn-onboarding-flow', text: '笔试 / 面试 / 拒信 → 台账状态自动更新' }),
    h('div', { class: 'tn-onboarding-status' }, h('span', { text: '已投递' }), h('span', { class: 'is-change', text: '面试中' }))
  );
}
export function mountOnboardingGuide(host, { email } = {}) {
  if (!host) return;
  let state = readState(email);
  if (state?.done) return;
  host.dataset.onboardingActive = '1';
  let disposed = false;
  let poll = null;
  let me = null;
  let jobs = 0;
  let plugin = null;
  const data = { step: state?.step || 1, loading: true, error: null };
  const render = () => {
    if (disposed || !host.isConnected) return;
    clear(host);
    if (data.loading) {
      host.append(h('div', { class: 'tn-onboarding tn-onboarding-loading', 'data-test': 'onboarding-guide' },
        h('span', { class: 'tn-onboarding-pulse' }), '正在准备首次使用引导…'));
      return;
    }
    const card = h('section', { class: 'tn-onboarding', 'data-test': 'onboarding-guide' });
    const head = h('div', { class: 'tn-onboarding-head' },
      h('div', {}, h('strong', { text: '开始使用帮你理' }), h('span', { class: 'tn-small tn-muted', text: '四步完成采集、授权和邮件同步' })),
      h('button', { class: 'tn-btn tn-btn-sm tn-btn-ghost', type: 'button', 'data-test': 'onboarding-skip', text: '稍后再说', onclick: finish }));
    card.append(head);
    const stepBody = (icon, title, desc, actions, extra = null) => h('div', { class: 'tn-onboarding-body' },
      h('div', { class: 'tn-onboarding-icon', text: icon }),
      h('div', { class: 'tn-onboarding-main' }, h('strong', { text: title }), h('p', { class: 'tn-small tn-muted', text: desc }),
        extra, h('div', { class: 'tn-action-row' }, ...actions)));
    if (data.step === 1) {
      card.append(h('div', { class: 'tn-onboarding-body' },
        h('div', { class: 'tn-onboarding-pulse' }), h('div', {}, h('strong', { text: '正在检测浏览器插件…' }),
          h('p', { class: 'tn-small tn-muted', text: '检测到已连接插件后会直接进入下一步。' }))));
    } else if (data.step === 2) {
      card.append(stepBody('1', '装好插件，逛招聘页顺手就能记下岗位',
        '下载解压 → Chrome 扩展管理 → 加载已解压的扩展程序 → 回到本页点击检测。',
        [pluginDownloadLink({ class: 'tn-btn tn-btn-primary tn-btn-sm', label: `下载插件包（v${PLUGIN_VERSION}）`, test: 'onboarding-plugin-download' }),
          h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'onboarding-probe', text: '已完成，重新检测', onclick: refresh })]));
    } else if (data.step === 3) {
      card.append(stepBody('2', '直接浏览，3秒入库',
        '去 Boss / 官网打开任意岗位详情页，插件会自动收纳到「看过没投」。',
        [h('a', { class: 'tn-btn tn-btn-sm', href: 'https://www.zhipin.com/', target: '_blank', rel: 'noopener noreferrer', text: '打开 Boss' }),
          h('a', { class: 'tn-btn tn-btn-sm', href: 'https://jobs.bytedance.com/', target: '_blank', rel: 'noopener noreferrer', text: '打开字节招聘' }),
          h('button', { class: 'tn-btn tn-btn-sm', type: 'button', 'data-test': 'onboarding-refresh', text: '我已试过，刷新看看', onclick: refresh })], pulseDemo()));
    } else if (data.step === 4) {
      card.append(stepBody('3', '自动同步更新你的投递状态',
        '授权邮箱后，笔试、面试、拒信会自动识别并更新台账；你也可以随时关闭。',
        [h('a', { class: 'tn-btn tn-btn-primary tn-btn-sm', href: '/?panel=settings&tab=data#tn-mail-section', 'data-test': 'onboarding-mail', text: '去授权邮箱' }),
          h('button', { class: 'tn-btn tn-btn-sm', type: 'button', text: '稍后同步', onclick: finish })], mailDemo()));
    } else {
      card.append(stepBody('✓', '你的采集、同步和助手已准备就绪',
        '之后可随时在设置里管理插件、邮箱和提醒。',
        [h('button', { class: 'tn-btn tn-btn-primary tn-btn-sm', type: 'button', 'data-test': 'onboarding-done', text: '开始使用', onclick: finish })]));
      card.querySelector('.tn-onboarding-icon')?.classList.add('ok');
    }
    if (data.error) card.append(h('div', { class: 'tn-small tn-error', text: data.error }));
    host.append(card);
  };
  function finish() {
    writeState(email, { done: true, step: null, at: new Date().toISOString() });
    disposed = true; if (poll) clearInterval(poll); delete host.dataset.onboardingActive; clear(host);
  }
  function next(step) {
    data.step = step; data.loading = false; render();
    writeState(email, { done: step === 5, step, at: new Date().toISOString() });
  }
  async function refresh() {
    if (disposed) return;
    data.loading = true; render();
    try {
      const [meRes, applied, viewed] = await Promise.all([
        api.get('/api/v1/me'),
        api.get('/api/v1/ledger?view=applied&limit=1'),
        api.get('/api/v1/ledger?view=viewed&limit=1')
      ]);
      if (disposed) return;
      me = meRes.data;
      jobs = Number(applied.data?.stats?.total_applied || 0) + Number(viewed.data?.counts?.viewed || 0);
      plugin = await probeExtension();
      const paired = Boolean(plugin?.paired) || (me.plugin_devices || []).some((device) => !device.server_revoked_at);
      const mailBound = Boolean(me.mail_connection) && ['connected', 'degraded'].includes(me.mail_connection.status);
      if (!paired) next(2);
      else if (jobs === 0) next(3);
      else if (!mailBound) next(4);
      else next(5);
      if (data.step === 2) {
        if (poll) clearInterval(poll);
        poll = setInterval(async () => {
          if (disposed || !host.isConnected) { clearInterval(poll); return; }
          const detected = await probeExtension();
          if (detected?.paired) { clearInterval(poll); refresh(); }
        }, 2500);
      }
      if (data.step === 3 || data.step === 4) {
        if (poll) clearInterval(poll);
        poll = setInterval(async () => {
          if (disposed || !host.isConnected) { clearInterval(poll); return; }
          try {
            const [a, v, m] = await Promise.all([api.get('/api/v1/ledger?view=applied&limit=1'), api.get('/api/v1/ledger?view=viewed&limit=1'), api.get('/api/v1/me')]);
            const count = Number(a.data?.stats?.total_applied || 0) + Number(v.data?.counts?.viewed || 0);
            if (data.step === 3 && count > 0) { clearInterval(poll); next(4); }
            if (data.step === 4 && ['connected', 'degraded'].includes(m.data?.mail_connection?.status)) { clearInterval(poll); next(5); }
          } catch { /* transient */ }
        }, 2500);
      }
    } catch (error) {
      data.loading = false; data.error = error?.message || '首次引导加载失败'; render();
    }
  }
  refresh();
  return () => { disposed = true; if (poll) clearInterval(poll); };
}
